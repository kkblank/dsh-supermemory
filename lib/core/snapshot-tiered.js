/**
 * 分层注入快照（契约 §V8.4 / §V8.1.2 / §V8.9 的组装侧）。
 *
 * `render-tiered.js` 负责「project 段该长成什么样」，本文件负责「global + project 段 +
 * 本轮预取怎么收进一个预算里」，以及快照指纹怎么算。纯函数、无 IO、无宿主依赖。
 *
 * 降级纪律（不变量二）：project 段装不下只降 project；`global` 正文永远逐字在场。
 * 宁可整段超出预算，也不做会破坏 `<supermemory>` 包裹或吞掉 global 的字节截断。
 *
 * @module dsh-supermemory/core/snapshot-tiered
 */

import { createHash } from 'node:crypto'

import { byteLength, renderEntry } from './document.js'
import { COLD_HINT, INDEX_BUDGET_RATIO, renderProjectParts } from './render-tiered.js'
import { asText, escapeFrame, normalizeBudget, wrapFrame } from './render-common.js'

/** 快照里的固定段标题。global 的措辞与 v7 逐字一致，降级不许顺带改文案。 */
const GLOBAL_HEADING = '## 全局长期记忆 (global)'
const RECALL_HEADING = '## 本轮相关记忆'
const RECALL_NOTE = '按本轮输入检索，可能不完整。'

/**
 * 预取项没带 id 时临时派生一个，只用于 digest（不落盘、不参与整编对账）。
 * @param {string} time - 条目时间。
 * @param {string} body - 条目正文。
 * @returns {string} 短哈希。
 */
function deriveRecallId(time, body) {
  return createHash('sha1').update(`${time}\n${body}`, 'utf8').digest('hex').slice(0, 5)
}

/**
 * 归一化一条预取命中：接受条目对象或纯文本，渲染成条目形态。
 * 没写 source 的命中统一标成 `recall`，让模型看得出这段是本轮临时捞上来的。
 *
 * @param {unknown} item - 预取命中项。
 * @returns {{ id: string, block: string } | null} 渲染结果；无正文返回 null。
 */
function normalizeRecallItem(item) {
  const plain = typeof item === 'string'
  const body = plain ? item.trim() : asText(item?.body).trim()
  if (body === '') return null
  const time = plain ? '' : asText(item?.time)
  const source = plain || asText(item?.source) === '' ? 'recall' : asText(item?.source)
  const topic = plain ? '' : asText(item?.topic)
  const id = plain ? '' : asText(item?.id)
  return { id: id === '' ? deriveRecallId(time, body) : id, block: renderEntry({ time, source, body, topic }) }
}

/**
 * 预取入参的形状闸门（契约 §V8.15 第 16 条）。
 *
 * 渲染层要的是**条目数组** `Array<{ id, topic, tier, body, score }>`。传成
 * `{ ids, items }` 这类对象过去会被 `Array.isArray ? : []` 静默判空——预取小节永不出现、
 * 也不报任何错，是「功能不坏、不报错、永不生效」那一类最难查的事故，所以这里必须吭声。
 *
 * 只有「压根没传这个参数」（`undefined`）才算合法的「本轮无预取」；显式传 `null` 是误用。
 *
 * @param {unknown} recall - 预取入参。
 * @returns {string} 要 warn 的文案；形状正确时返回空串。
 */
function recallShapeProblem(recall) {
  if (Array.isArray(recall) || recall === undefined) return ''
  const got = recall === null ? 'null' : typeof recall
  return `supermemory: 预取入参必须是条目数组，收到 ${got}，本轮「本轮相关记忆」小节整段忽略`
    + '（正确形状 Array<{ id, topic, tier, body, score }>）'
}

/**
 * 渲染「本轮相关记忆」小节（契约 §V8.9 / §V8.15 第 16 条）。
 *
 * - 无命中 → 返回空串，**不发空标题**。
 * - `knownIds` 里的条目已经在 core 正文里，重复出现纯属浪费（工具层本该剔掉，这里再兜一道）。
 * - 入参不是数组 → 整段忽略并 `logger.warn` 一次（一次调用最多一条，不刷屏）。
 *
 * @param {unknown} recall - 预取命中条目数组。
 * @param {unknown} maxBytes - 该小节的字节预算。
 * @param {Set<string>} knownIds - 已在正文中出现的条目 id。
 * @param {{ warn?: Function }} [logger] - 日志器，缺省时忽略告警（返回值里 `ignored` 仍可查）。
 * @returns {{ text: string, ids: string[], count: number, ignored: boolean }} 小节文本、命中 id、条数与是否因形状错误被忽略。
 */
export function buildRecallSection(recall, maxBytes, knownIds = new Set(), logger = undefined) {
  const limit = normalizeBudget(maxBytes)
  const problem = recallShapeProblem(recall)
  if (problem !== '') logger?.warn?.(problem)
  const list = Array.isArray(recall) ? recall : []
  const seen = new Set()
  const blocks = []
  const ids = []
  let used = byteLength(`${RECALL_HEADING}\n\n${RECALL_NOTE}`)

  for (const item of list) {
    const normalized = normalizeRecallItem(item)
    if (normalized === null || knownIds.has(normalized.id) || seen.has(normalized.id)) continue
    const size = byteLength(normalized.block) + 2
    if (used + size > limit) break
    used += size
    seen.add(normalized.id)
    blocks.push(normalized.block)
    ids.push(normalized.id)
  }
  const ignored = problem !== ''
  if (blocks.length === 0) return { text: '', ids: [], count: 0, ignored }
  return {
    text: `${RECALL_HEADING}\n\n${RECALL_NOTE}\n\n${blocks.join('\n\n')}`,
    ids,
    count: blocks.length,
    ignored,
  }
}

/**
 * 分层快照指纹：对**原始 global 正文 + project 原文 + projectName + truncated + 预取命中 id 集合**
 * 取哈希（契约 §V8.4）。
 *
 * 预取 id 集合必须进 digest：否则预取换了条目而快照不重写，本轮检索就白做。
 * 反过来，热度统计（usage）不进 digest——否则统计文件每动一次快照就重写一次。
 *
 * @param {{ global: string, project: string, projectName: string, truncated: boolean, recallIds: string[] }} raw - 指纹输入。
 * @returns {string} 40 位十六进制。
 */
function tieredFingerprint(raw) {
  const payload = JSON.stringify({
    global: raw.global,
    project: raw.project,
    projectName: raw.projectName,
    truncated: raw.truncated,
    recall: raw.recallIds.slice().sort(),
  })
  return createHash('sha1').update(payload, 'utf8').digest('hex')
}

/**
 * 构建分层注入快照（契约 §V8.4），并按 §V8.1.2 的顺序做**段级独立降级**：
 *
 * 1. 全量；
 * 2. 装不下 → project 段收缩（core 正文 + 目录），`global` 仍逐字全量；
 * 3. 仍装不下 → 砍目录条数；
 * 4. 预算小到连一行目录都放不下 → project 段只剩固定提示行。
 *
 * @param {{ global?: unknown, projectText?: unknown, projectName?: unknown, usage?: unknown,
 *   recall?: Array<{ id?: string, topic?: string, tier?: string, body: string, score?: number }>,
 *   injectMaxBytes?: unknown, coreMaxBytes?: unknown, indexMaxBytes?: unknown,
 *   recallMaxBytes?: unknown, logger?: { warn?: Function } }} input - 渲染输入。
 *   `recall` 必须是条目数组（§V8.15 第 16 条）：传成对象或 null 会整段忽略**并 warn 一次**。
 * @returns {{ text: string, digest: string, truncated: boolean,
 *   sections: { global: number, project: number }, stats: object }} 快照。
 *   global / project / 预取全空时 `text` 为 ''。
 */
export function buildTieredSnapshot(input = {}) {
  const projectName = asText(input.projectName).trim()
  const escapedName = escapeFrame(projectName)
  const projectHeading = `## ${escapedName === '' ? '项目记忆 (project)' : `项目记忆 (project: ${escapedName})`}`
  const globalBody = asText(input.global).trim()
  const projectText = asText(input.projectText)
  const limit = normalizeBudget(input.injectMaxBytes)

  const globalBlock = globalBody === '' ? '' : `${GLOBAL_HEADING}\n\n${escapeFrame(globalBody)}`
  let parts = renderProjectParts({
    text: projectText,
    usage: input.usage,
    coreMaxBytes: input.coreMaxBytes,
    indexMaxBytes: input.indexMaxBytes,
  })

  // core 正文里已在场的条目不再预取（工具层负责剔除，这里兜底防重复）。
  const knownIds = new Set(parts.kept.map((entry) => asText(entry.id)))
  const recall = buildRecallSection(input.recall, input.recallMaxBytes, knownIds, input.logger)
  const recallBlock = recall.text === '' ? '' : escapeFrame(recall.text)

  /**
   * 组装完整快照：global → project → 预取，逐段转义后统一包裹。
   * @param {string} projectBody - 已渲染的 project 段正文。
   * @returns {string} 包裹后的快照文本。
   */
  const compose = (projectBody) => {
    const blocks = []
    if (globalBlock !== '') blocks.push(globalBlock)
    if (projectBody !== '') blocks.push(`${projectHeading}\n\n${escapeFrame(projectBody)}`)
    if (recallBlock !== '') blocks.push(recallBlock)
    // 三段全空就不该发出一个空包裹：下游靠 `text === ''` 判定「本轮不注入 / 换清空占位」。
    if (blocks.length === 0) return ''
    return wrapFrame(blocks.join('\n\n'))
  }

  let truncated = false
  let text = compose(parts.body)

  if (byteLength(text) > limit) {
    truncated = true
    // 第 2 步：量出「除 project 外」的固定开销（空包裹 + 已在场的段 + project 自己的标题），
    // 剩下的预算在 core 与目录之间重新分配。
    const withoutProject = compose('') === '' ? byteLength(wrapFrame('')) : byteLength(compose(''))
    const separator = globalBlock === '' && recallBlock === '' ? 0 : 2
    const projectBudget = Math.max(0, limit - withoutProject - separator - byteLength(projectHeading) - 2)
    const indexReserve = Math.min(
      normalizeBudget(input.indexMaxBytes),
      Math.max(byteLength(COLD_HINT), Math.floor(projectBudget * INDEX_BUDGET_RATIO)),
    )
    const coreBudget = Math.max(0, projectBudget - indexReserve)
    const shrink = (tighten) =>
      renderProjectParts({ text: projectText, usage: input.usage, coreMaxBytes: coreBudget, indexMaxBytes: indexReserve, ...tighten })

    parts = shrink({})
    text = compose(parts.body)

    // 第 3 步：目录本身挤不下 → 从尾部一条条砍冷层主题行。挤出组优先保留（§V8.15：
    // 被挤出的 core 是「本该常驻却被挤掉」的信息，冷层本来就是归档，先牺牲后者）。
    for (let left = parts.topics.length - 1; byteLength(text) > limit && left >= 0; left -= 1) {
      parts = shrink({ maxTopics: left })
      text = compose(parts.body)
    }
    // 第 4 步：还超 → 挤出组退化成一行计数（逐条摘要是最贵的一段目录）。
    if (byteLength(text) > limit && parts.overflowRows.length > 0) {
      parts = shrink({ maxTopics: 0, listOverflow: false })
      text = compose(parts.body)
    }
    // 第 5 步：塞不下任何目录 → project 段只剩固定提示行。再放不下就宁可整段超出：
    // 「global 逐字在场」与「包裹必须合法」都不许给预算让位，所以这里**绝不**做会切断
    // `</supermemory>` 的字节截断（不变量二）。
    if (byteLength(text) > limit && parts.hiddenCount > 0) {
      parts = { ...parts, body: COLD_HINT }
      text = compose(parts.body)
    }
  }

  const projectBlock = parts.body === '' ? '' : `${projectHeading}\n\n${escapeFrame(parts.body)}`
  const sections = { global: byteLength(globalBlock), project: byteLength(projectBlock) }
  const stats = {
    coreCount: parts.kept.length,
    coldCount: parts.coldCount,
    topicCount: parts.topics.length,
    overflowCount: parts.overflow.length,
    overflowShown: parts.overflowRows.length,
    recallCount: recall.count,
    recallIgnored: recall.ignored,
    truncated,
    bytes: {
      global: sections.global,
      project: sections.project,
      recall: byteLength(recall.text),
      core: byteLength(parts.coreText),
      index: byteLength(parts.indexBlock),
    },
  }

  // 三段全空：不注入任何内容，digest 仍按「未降级」口径算，保证空记忆时 digest 稳定。
  if (text === '') {
    return {
      text: '',
      digest: tieredFingerprint({ global: globalBody, project: projectText, projectName, truncated: false, recallIds: recall.ids }),
      truncated: false,
      sections: { global: 0, project: 0 },
      stats,
    }
  }
  return {
    text,
    digest: tieredFingerprint({ global: globalBody, project: projectText, projectName, truncated, recallIds: recall.ids }),
    truncated,
    sections,
    stats,
  }
}
