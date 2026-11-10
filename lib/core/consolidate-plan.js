/**
 * 整编「计划」层：模型输出 → 可对账的形状。
 *
 * 从 `consolidate.js` 拆出（单文件 ≤400 行的规范约束），搬的是容错提取 + 格式校验 +
 * 三键归一化，不改任何对账语义：对账、栅栏、落盘文本仍在 `consolidate.js`。
 * `consolidate.js` 原样 re-export 本文件的 `extractJsonObject` / `parseConsolidateOutput`，
 * 调用方的导入路径不变。依赖单向 `consolidate → consolidate-plan → digest → document`。
 *
 * v8（契约 V8.8）在整编输出里加了第三键 `topics`，并给每条 entry 加了可选的 `tier` / `topic`。
 * 这一层的总方针与 v4 完全一致——**宽容进、严格出**，以及最重要的一条：
 * **模型没写的字段一律不挂上去**（不写成 `tier: undefined`）。理由是下游用
 * `assert.deepEqual` 逐字段比对条目形状（`test/consolidate-core.test.js` 与
 * `test/paths-document.test.js` 用的都是 `node:assert/strict`，多一个值为 undefined 的
 * 键同样会红），而且「没写」与「写了 core」在 `renderEntry` 那里的落盘结果不同：
 * 前者不落 `tier:` 段，后者落 core 是缺省态也不落盘，但显式 `cold` 会落盘。
 *
 * 硬约束：不 import 任何 `@deepseek-ai/*` 宿主包，不碰磁盘与网络。
 *
 * @module dsh-supermemory/core/consolidate-plan
 */

import { pickJsonObject } from './digest.js'
import { normalizeTier as formatTier, normalizeTopic as formatTopic } from './entry-format.js'

/** 主题摘要的截断长度：模型写一整段时不至于把主题表撑成第二篇记忆。 */
const TOPIC_SUMMARY_MAX = 200

/** 单个主题最多保留多少个别名，以及每个别名的最大长度。 */
const ALIAS_MAX = 12
const ALIAS_TEXT_MAX = 40

/**
 * 主题表最多收多少条。
 *
 * 契约 V8.3 把主题表写进 project 文档的 preamble，也就是**盘上体积**：渲染层有
 * `projectIndexMaxBytes` 管住注入量，但盘上没有对应的闸门。模型一发疯报出三百个主题，
 * 光围栏就能把输入预算吃干净，下一轮整编直接 INPUT_OVERFLOW。这里给一个宽到正常项目
 * 一辈子碰不到的硬上限，超出部分丢弃——主题归并本来就是整编器的职责，砍尾巴不伤正文。
 */
const TOPIC_LIST_MAX = 50

/** 相似度指纹取折叠后的前多少个字符。 */
const SIMILARITY_PREFIX = 40

/** 折叠后不足这么多字符就不做相似度比对：太短的正文前缀必然互撞，报出来全是噪音。 */
const SIMILARITY_MIN = 8

/**
 * 把任意输入规整成字符串。
 * @param value - 任意值。
 * @returns 字符串（null/undefined → ''）。
 */
export function asText(value) {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  return String(value)
}

/**
 * 归一条目上的 `tier`（契约 V8.2 / V8.8）。
 *
 * 只认 `core` / `cold`（大小写不敏感、两侧空白去掉）。**其它一切值都算「非法值」而不是「没写」**：
 * 没写是 `undefined` / `null` / 空串，模型写了 `tier: "warm"` 是它想改但改错了——
 * 两者都按「不动这条的 tier」处理，但后者要进 `suspects` 让运行报告看得见。
 *
 * @param {unknown} value - 模型给的 tier 字段。
 * @returns {{ tier?: 'core'|'cold', invalid: boolean }} 归一结果；`invalid` 为真表示写了但不合法。
 */
export function normalizeTier(value) {
  if (value === undefined || value === null) return { invalid: false }
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  // 空串是「没写」，数字 / 布尔 / 对象是「写了别的东西」：前者静默，后者留线索。
  if (text === '') return typeof value === 'string' ? { invalid: false } : { invalid: true }
  // 合法集合只有一份，住在 `entry-format.js`。它把非法值回落成 core（脏值当没写），
  // 所以用「归一结果是否原样等于输入」判这一条到底被不被认账。本地再维护一份
  // `core`/`cold` 的集合，就是两边走神后盘上那个谁也读不懂的 tier 段。
  return formatTier(text) === text ? { tier: text, invalid: false } : { invalid: true }
}

/**
 * 归一条目上的 `topic`（契约 V8.2：1–24 码点，原样保留含中文与空格）。
 *
 * 规则**直接复用 `entry-format.js` 的 `normalizeTopic`**，不在这里抄第二遍：条目头靠
 * ` · ` 分段，所以「值里含 ` · `」在解析端是硬拒收的。整编这边若把它收下来，落盘时会被
 * 渲染端静默丢弃，于是条目上根本没有那个主题名，而我已经按「有条目在用」算过——
 * `orphanTopics` 就此少报一条，主题表里挂着一个永远没人用的名字。
 * 超长、空、含段分隔符都视同没写，**不记 suspect**——契约 V8.14 只要求非法 `tier` 进 suspects，
 * topic 的格式不合落不回原样也伤不到任何既有事实，记出来只会淹没有效线索。
 *
 * @param {unknown} value - 模型给的 topic 字段。
 * @returns {string|undefined} 合法主题名；否则 undefined（表示没写）。
 */
export function normalizeTopic(value) {
  const text = formatTopic(value)
  return text === '' ? undefined : text
}

/**
 * 规整主题表（契约 V8.8 的第三键 `topics`）。
 *
 * 逐条丢非法项而不是整表作废：模型常常 8 个主题里有一个名字写超长，其余的摘要与别名照样有用。
 * 重名只留第一条（同 `drop` 同一 id 只留第一条的处理）；条数超过 `TOPIC_LIST_MAX` 直接收工。
 *
 * @param {unknown} raw - 模型给的 topics 字段。
 * @returns {Array<{ name: string, summary: string, aliases: string[] }>} 规整后的主题表。
 */
export function sanitizeTopics(raw) {
  const topics = []
  const seen = new Set()
  for (const item of Array.isArray(raw) ? raw : []) {
    if (topics.length >= TOPIC_LIST_MAX) break
    // 主题名与条目上的 topic 共用 `entry-format.js` 那一个判据（含 ` · ` 一律不认）：
    // 表里收了名、条目上却永远落不出这个名字，orphanTopics 就会少报一条永久孤立的目录项。
    const name = formatTopic(item?.name)
    if (name === '' || seen.has(name)) continue
    seen.add(name)

    // 摘要只收字符串：主题表的 summary 会原样写进盘上目录，把 `42` 转成 `'42'` 是在往
    // 目录里塞一条谁也看不懂的条目。别名反过来要宽容——模型常把一串别名塞成一个逗号分隔
    // 的字符串，这与 `topics.js` 读盘上的写法（`aliases: a, b`）同形，拆开就是。
    let summary = typeof item?.summary === 'string' ? item.summary.trim() : ''
    if (Array.from(summary).length > TOPIC_SUMMARY_MAX) summary = [...summary].slice(0, TOPIC_SUMMARY_MAX).join('')

    const rawAliases = Array.isArray(item?.aliases)
      ? item.aliases
      : typeof item?.aliases === 'string' ? item.aliases.split(',')
      : []
    const aliases = []
    for (const alias of rawAliases) {
      if (typeof alias !== 'string') continue
      const text = alias.trim()
      if (text === '' || Array.from(text).length > ALIAS_TEXT_MAX || aliases.includes(text)) continue
      aliases.push(text)
      if (aliases.length >= ALIAS_MAX) break
    }

    topics.push({ name, summary, aliases })
  }
  return topics
}

/**
 * 规整整编输出的三个数组：`entries` / `drop` / `topics`。
 *
 * 宽容进、严格出：模型偷懒写成字符串项时按「纯新增条目」收（多一条不丢信息），
 * 但 `drop` 缺 `reason` 一律丢弃该项——没有理由的删除不执行，宁可留一条过时记忆。
 * id 类字段（`from` 的每一项、`drop[].id`）**只接受字符串**：id 是标识符，把 `42`
 * 转成 `'42'` 只会凭空造出一个引向虚无的引用；文本类字段（`text`、`reason`）则容忍
 * 非字符串，转成字符串照样能用。`from` 里的 id 转小写去重：id 是十六进制，模型写成
 * 大写不该被当成幽灵。
 *
 * @param object - 已解析的整编输出对象。
 * @returns {{ entries: Array<object>, drop: Array<{ id: string, reason: string }>,
 *   topics: Array<object>, invalidTiers: Array<{ index: number, text: string, topic: string|undefined }> }}
 *   `invalidTiers` 每项带 `index`（该条目在 `entries` 里的下标），只登记「写了但值不合法」的
 *   tier 线索——此时该条条目**不带** tier 字段。
 */
export function sanitizePlan(object) {
  const entries = []
  const invalidTiers = []
  const rawEntries = Array.isArray(object?.entries) ? object.entries : []
  for (const item of rawEntries) {
    const text = asText(typeof item === 'string' ? item : item?.text).trim()
    if (text === '') continue
    const from = []
    for (const ref of Array.isArray(item?.from) ? item.from : []) {
      if (typeof ref !== 'string') continue
      const id = ref.trim().toLowerCase()
      if (id !== '' && !from.includes(id)) from.push(id)
    }
    const entry = { text, from }
    const tier = normalizeTier(typeof item === 'string' ? undefined : item?.tier)
    if (tier.tier !== undefined) entry.tier = tier.tier
    const topic = normalizeTopic(typeof item === 'string' ? undefined : item?.topic)
    if (topic !== undefined) entry.topic = topic
    if (tier.invalid === true) invalidTiers.push({ index: entries.length, text, topic })
    entries.push(entry)
  }

  const drop = []
  for (const item of Array.isArray(object?.drop) ? object.drop : []) {
    const id = typeof item?.id === 'string' ? item.id.trim().toLowerCase() : ''
    const reason = asText(item?.reason).trim()
    if (id === '' || reason === '') continue
    if (!drop.some((kept) => kept.id === id)) drop.push({ id, reason })
  }

  return { entries, drop, topics: sanitizeTopics(object?.topics), invalidTiers }
}

/**
 * 从任意文本里提取第一个合法 JSON 对象（整编侧的容错出口，契约 §V4.0.2）。
 *
 * 候选顺序与追加模式完全同源：整段 → 围栏内容 → 首 `{` 到末 `}` → 逐个平衡括号切片；
 * 数组、标量、解析失败一律不算。遍历本体在 `digest.js` 的 `pickJsonObject` 里只有一份，
 * 这里只是把「是否见过非对象」那部分信息丢掉——整编不需要它，它只有一条错误文案。
 *
 * @param {unknown} text - 模型原始输出；也容忍已解析好的对象。
 * @returns {object | null} 解析出的普通对象；提不出返回 null。
 */
export function extractJsonObject(text) {
  if (text !== null && typeof text === 'object') {
    return Array.isArray(text) ? null : text
  }
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  if (trimmed === '') return null
  return pickJsonObject(trimmed).object
}

/**
 * 解析整编模式的模型输出（契约 §V4.0.2 的两键 + v8 契约 V8.8 的第三键）：
 *
 * ```json
 * {"entries":[{"text":"…","from":["a3f2c"],"tier":"cold","topic":"注入机制"}],
 *  "drop":[{"id":"b8e01","reason":"…"}],
 *  "topics":[{"name":"注入机制","summary":"…","aliases":["snapshot","快照"]}]}
 * ```
 *
 * 只做格式校验，不校验 id 是否存在于旧文档、主题名有没有条目在用——那两件事都要拿到旧文本
 * 才能判，归 `applyConsolidation`（分别产出 `ghosts` 与 `orphanTopics`）。
 * 模型漏写 `topics` 与漏写 `tier` 一样，一律按「这一轮不碰主题表 / 不碰分层」处理。
 *
 * @param {unknown} raw - 模型原始输出（字符串，或已解析的对象）。
 * @returns {{ ok: true, entries: Array<object>, drop: Array<object>, topics: Array<object>,
 *   invalidTiers: Array<{ index: number, text: string, topic: string|undefined }> }
 *   | { ok: false, error: string }}。
 *   `invalidTiers` 必须随返回值一起透出：非法 tier 在规整那一刻就被丢掉了，这里不带出来，
 *   下游拿着已经干净的 entries 就再也还原不出「模型到底写错了什么」。
 */
export function parseConsolidateOutput(raw) {
  if (typeof raw === 'string' && raw.trim() === '') return { ok: false, error: '整编输出为空' }
  const object = extractJsonObject(raw)
  if (object === null) return { ok: false, error: '整编输出中没有合法 JSON 对象' }
  const plan = sanitizePlan(object)
  return {
    ok: true,
    entries: plan.entries,
    drop: plan.drop,
    topics: plan.topics,
    invalidTiers: plan.invalidTiers,
  }
}

/**
 * 相似度指纹：折叠空白、去掉标点与符号后取前若干字符。
 * 短于 `SIMILARITY_MIN` 字符的正文返回空串，不参与比对——太短的文本前缀必然互撞，
 * 报出来的全是噪音。
 *
 * @param {unknown} text - 条目正文。
 * @returns {string} 指纹（可能为空串）。
 */
export function similarityKey(text) {
  const folded = asText(text).toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')
  return folded.length < SIMILARITY_MIN ? '' : folded.slice(0, SIMILARITY_PREFIX)
}
