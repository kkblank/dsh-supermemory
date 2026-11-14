/**
 * project 段的分层渲染（契约 §V8.4 的渲染算法 + §V8.1.2 的取舍口径）。
 *
 * 本文件只管两件事：**哪些条目进 core 正文**（排序 + 预算取舍），以及把正文与
 * `tier-index.js` 生成的主题目录拼成 project 段。把它与 global、本轮预取收进一个总预算、
 * 以及快照指纹，在 `snapshot-tiered.js`。纯函数、无 IO、无宿主依赖。
 *
 * 三条贯穿全局的不变量在这里落地（§V8.0）：
 *
 * 1. **渲染期裁剪，存储期只表意图**：core 超预算时把最不该常驻的条目临时折进目录，
 *    绝不回写文件——一次预算抖动不该改写记忆文件。
 * 2. **段级独立降级**：project 装不下只降 project，`global` 正文永远逐字在场。
 * 3. **缺省 = 旧行为**：全是 core、没有目录、没有溢出时 project 正文原样透传，与 v7 的
 *    `buildSnapshot` 逐字节一致；`buildSnapshot` 本身一行未改，它是 `tieredInjection: false`
 *    的回滚通道。
 *
 * @module dsh-supermemory/core/render-tiered
 */

import { byteLength, parseEntries, renderEntry } from './document.js'
import { buildIndex } from './tier-index.js'
import { parseTopicIndex } from './topics.js'
import { asText, entryTime, normalizeBudget } from './render-common.js'
import { decayScore } from './usage.js'

/** 冷层提示行：有东西不在正文里时必须出现（契约 §V8.4 算法第 5 步）。快照层组装兜底时也要用。 */
export const COLD_HINT = '冷层条目用 memory 工具按需检索（action=search, scope=project）。'

/** core 排序权重：有效热度与新鲜度。没有 usage 统计时两者都不参与（退回时间倒序）。 */
const WEIGHT_HITS = 1
const WEIGHT_RECENCY = 0.5

/** 收缩时目录预算的占比：project 可用预算里至少留三成给目录，但不超过调用方给的目录预算。 */
export const INDEX_BUDGET_RATIO = 0.35

/**
 * 把文档收敛成可注入正文：剥 HTML 注释、剥一级标题、剥模板里的 `## 条目` 标题。
 *
 * ⚠️ 这段与 `lib/host/inject.js` 的 `docBody` 同语义，是**刻意的重复**而非疏忽：渲染层不能
 * 反向 import host 层，而「全 core 无目录时 project 正文逐字节等于 v7 输出」这条不变量要求
 * 两边剥得一模一样。改这里必须同步改 `docBody`。
 *
 * @param {unknown} text - 文档原始文本。
 * @returns {string} 已 trim 的正文。
 */
function bodyOf(text) {
  const lines = asText(text).replace(/<!--[\s\S]*?-->/gu, '').split('\n')
  const kept = []
  let droppedTitle = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (!droppedTitle && trimmed.startsWith('# ')) {
      droppedTitle = true
      continue
    }
    if (/^##\s*条目\s*$/u.test(trimmed)) continue
    kept.push(line)
  }
  return kept.join('\n').trim()
}

/**
 * 时间倒序比较器（新的在前；不可解析的时间一律沉底，由 `entryTime` 记为 -Infinity）。
 * @param {{ time?: unknown }} a - 条目。
 * @param {{ time?: unknown }} b - 条目。
 * @returns {number} 比较结果。
 */
function byTimeDesc(a, b) {
  return entryTime(b) - entryTime(a)
}

/**
 * 把 `usage.json` 的 `{ topics, entries }` 两张表读成**衰减后**的有效热度表。
 *
 * 文件缺失 / 损坏 / 缺字段一律当空统计（契约 §V8.10：只 warn 不抛，热度缺失退回时间倒序）。
 *
 * v12：值从「裸命中数」改成「衰减后有效热度」。理由见 `core/usage.js` 的 `decayScore`：
 * 裸命中数分不出「昨天用过 20 次」和「三年前用过 20 次」，而冷热排序的全部意义就在时效。
 * 没有 `last` 的旧统计项由 `decayScore` 退回 `log(1+hits)`，不会因为缺时间戳就判成冷的。
 *
 * @param {unknown} usage - 热度统计对象。
 * @param {number} now - 当前时间戳（毫秒），由调用方注入以便测试。
 * @returns {{ topics: Map<string, number>, entries: Map<string, number> } | null} 统计；无可用数据返回 null。
 */
function readUsage(usage, now) {
  if (usage === null || typeof usage !== 'object') return null
  const pick = (table) => {
    const map = new Map()
    if (table === null || typeof table !== 'object') return map
    for (const [key, value] of Object.entries(table)) {
      const score = decayScore(value, now)
      if (score > 0) map.set(key, score)
    }
    return map
  }
  const topics = pick(usage.topics)
  const entries = pick(usage.entries)
  if (topics.size === 0 && entries.size === 0) return null
  return { topics, entries }
}

/**
 * core 组排序：`score = w1 * 有效热度 + w2 * recency`（契约 §V8.4 算法第 2 步）。
 *
 * 命中数以 **topic 为主键**、条目 id 为辅（条目 id 会随整编改写正文而变，topic 才是稳定锚点）。
 * 没有统计文件时整组退回时间倒序——**没有 usage.json 也必须能跑**。
 *
 * 两个热度取**较大者**而不是相加：同一批命中会同时记在 topic 与 entry 两个键上，
 * 相加等于把同一次检索算两遍，热门条目会被无理由放大。
 *
 * @param {Array<object>} list - core 条目。
 * @param {unknown} usage - 热度统计。
 * @param {number} [now] - 当前时间戳（毫秒）；缺省取 `Date.now()`。
 * @returns {Array<object>} 排好序的条目（新数组）。
 */
function rankCoreEntries(list, usage, now) {
  const byTime = list.slice().sort(byTimeDesc)
  const stats = readUsage(usage, Number.isFinite(now) ? now : Date.now())
  if (stats === null) return byTime

  const times = byTime.map(entryTime).filter((t) => Number.isFinite(t))
  const newest = times.length === 0 ? 0 : Math.max(...times)
  const oldest = times.length === 0 ? 0 : Math.min(...times)
  const recencyOf = (entry) => {
    const t = entryTime(entry)
    if (!Number.isFinite(t)) return 0
    return newest > oldest ? (t - oldest) / (newest - oldest) : 1
  }
  const scoreOf = (entry) => {
    const heat = Math.max(
      stats.topics.get(asText(entry.topic)) ?? 0,
      stats.entries.get(asText(entry.id)) ?? 0,
    )
    return WEIGHT_HITS * heat + WEIGHT_RECENCY * recencyOf(entry)
  }
  // 先按时间倒序排过一遍，score 相同的条目就自然保持「新的在前」。
  return byTime.slice().sort((a, b) => scoreOf(b) - scoreOf(a))
}

/**
 * core 段按预算累加：一旦放不下就停在这里，剩下的进 `overflow` 由目录层逐条列出（**不写文件**）。
 * @param {Array<object>} ranked - 已排序的 core 条目。
 * @param {number} limit - 字节上限（Infinity 表示不限）。
 * @returns {{ kept: Array<object>, overflow: Array<object> }} 取舍结果。
 */
function fitCoreEntries(ranked, limit) {
  const kept = []
  let used = 0
  let index = 0
  for (; index < ranked.length; index += 1) {
    const size = byteLength(renderEntry(ranked[index])) + (kept.length === 0 ? 0 : 2)
    if (used + size > limit) break
    kept.push(ranked[index])
    used += size
  }
  return { kept, overflow: ranked.slice(index) }
}

/**
 * project 段正文的组装顺序：core 正文 → 主题目录 → 冷层提示行。
 * 「只有 cold 没有 core」时不出空标题，直接目录 + 提示行（契约 §V8.14）。
 *
 * @param {{ coreText: string, indexBlock: string, hasHidden: boolean }} parts - 各部分。
 * @returns {string} project 段正文（不含段标题与包裹）。
 */
function composeProjectBody(parts) {
  const blocks = [parts.coreText, parts.indexBlock].filter((part) => asText(part) !== '')
  if (parts.hasHidden) blocks.push(COLD_HINT)
  return blocks.join('\n\n')
}

/**
 * 渲染 project 段的内核：分组 → 排序 → core 取舍 → 交给目录层 → 组装。
 * `buildProjectSection` 是它的公开外壳；`snapshot-tiered.js` 降级时直接复用它做逐次重算
 * （除 `buildProjectSection` 与两个常量外，本文件的导出不算对外 API）。
 *
 * @param {{ text?: unknown, usage?: unknown, coreMaxBytes?: unknown, indexMaxBytes?: unknown,
 *   maxTopics?: unknown, listOverflow?: unknown }} input - 渲染输入。`listOverflow: false` 让
 *   目录里的挤出组退化成计数行（极端预算下的最后一档）。
 * @returns {object} 含 body / coreText / indexBlock / topics / overflowRows / kept / overflow /
 *   coldCount / hiddenCount。
 */
export function renderProjectParts(input = {}) {
  const text = asText(input.text)
  const coreLimit = normalizeBudget(input.coreMaxBytes)

  const table = new Map()
  for (const topic of parseTopicIndex(text)) {
    if (!table.has(topic.name)) table.set(topic.name, topic)
  }

  const coreAll = []
  const coldAll = []
  for (const entry of parseEntries(text)) (entry.tier === 'cold' ? coldAll : coreAll).push(entry)

  const { kept, overflow } = fitCoreEntries(rankCoreEntries(coreAll, input.usage, input.now), coreLimit)
  const hiddenCount = coldAll.length + overflow.length

  // 缺省 = 旧行为：没有任何东西被折进目录时，正文原样透传，与 v7 逐字节一致。
  const coreText = hiddenCount === 0 ? bodyOf(text) : kept.map((entry) => renderEntry(entry)).join('\n\n')
  const index = buildIndex({
    overflow,
    cold: coldAll,
    table,
    indexMaxBytes: input.indexMaxBytes,
    maxTopics: input.maxTopics,
    listOverflow: input.listOverflow,
  })

  return {
    coreText,
    indexBlock: index.text,
    topics: index.topics,
    overflowRows: index.overflowRows,
    body: composeProjectBody({ coreText, indexBlock: index.text, hasHidden: hiddenCount > 0 }),
    kept,
    overflow,
    coldCount: coldAll.length,
    hiddenCount,
  }
}

/**
 * 分层渲染 project 记忆段（契约 §V8.4）。
 *
 * 入参 `text` 必须是**原始文档文本**：`inject.js` 的 `docBody` 会把 HTML 注释剥掉，
 * 主题围栏正是注释——拿 `docBody` 之后的正文永远解析不出主题表（§V8.3 的坑）。
 *
 * @param {{ text?: unknown, projectName?: unknown, usage?: unknown,
 *   coreMaxBytes?: unknown, indexMaxBytes?: unknown }} input - 渲染输入。
 * @returns {{ text: string, coreCount: number, coldCount: number,
 *   topics: Array<{ name: string, count: number, summary: string, aliases: string[], inTable: boolean }>,
 *   overflow: string[], bytes: { total: number, core: number, index: number } }} 分段结果。
 *
 * **`bytes` 的唯一口径（契约 §V8.15 第 18 条，下游不许再写「数字或对象」的兼容读取）**：
 *
 * - `core`：core 条目正文部分的字节数；
 * - `index`：主题目录段（含 `### 主题目录` 标题行与挤出组）；无目录时 0；
 * - `total`：整个 project 段正文，= `core` + 目录 + 冷层提示行 + 段间空行，
 *   **不含**段标题 `## …` 与 `<supermemory>` 包裹。因此恒有 `total >= core + index`，
 *   差值是空行与提示行，不是丢了字节。
 */
export function buildProjectSection(input = {}) {
  const parts = renderProjectParts(input)
  return {
    text: parts.body,
    coreCount: parts.kept.length,
    coldCount: parts.coldCount,
    topics: parts.topics,
    overflow: parts.overflow.map((entry) => asText(entry.id)),
    bytes: {
      total: byteLength(parts.body),
      core: byteLength(parts.coreText),
      index: byteLength(parts.indexBlock),
    },
  }
}
