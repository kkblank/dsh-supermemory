/**
 * 热度统计（usage.json）的**纯函数**：解析、序列化、累加、读取。无 IO、无宿主依赖。
 *
 * 落盘形态（契约 §V8.10）：
 *
 * ```json
 * { "topics": { "注入机制": { "hits": 12, "last": "2026-11-10T…" } },
 *   "entries": { "a3f2c": { "hits": 3, "last": "…" } } }
 * ```
 *
 * 为什么主键是 `topic` 而不是条目 id：条目 id 由 `sha1(time + body)` 派生
 * （见 core/document.js），整编改写正文后 id 就变，靠它记热度必然丢历史；
 * topic 是整理器维护的稳定名字，才是跨整编的锚点。条目 id 只作辅助。
 *
 * 三条不变量：
 *   - **读不炸**：文本损坏、缺字段、类型不对，一律当空统计继续（调用方只 warn）。
 *     热度是优化项，它坏了不能连带把注入与检索一起拖坏。
 *   - **写不越界**：本模块只算不调 IO，落盘与时机由 host/usage.js 决定。
 *   - **只影响排序**：热度不改盘上 `tier`；真正的分层变更只在整编时发生。
 *
 * @module dsh-supermemory/core/usage
 */

import { normalizeTopic } from './document.js'

/** usage.json 的顶层分区键。 */
export const USAGE_GROUPS = ['topics', 'entries']

/** 单个计数项的最长保留键数，防止损坏文件把统计撑成无界对象。 */
const MAX_KEYS_PER_GROUP = 2000

/** 命中数的上限（钳制，避免脏数据里的 1e308 参与打分）。 */
const MAX_HITS = 1_000_000

/** 一个空的统计对象。 */
export function emptyUsage() {
  return { topics: {}, entries: {} }
}

/**
 * 收一个计数项：非法形态返回 null（调用方丢弃该项）。
 *
 * `hits` 必须是有限非负整数并钳到 MAX_HITS；`last` 只在能被 `Date.parse`
 * 解析时保留 ISO 形态，否则留空串——留一个脏时间戳会让 recency 排序整体跑偏。
 *
 * @param {unknown} raw - 原始项。
 * @returns {{ hits: number, last: string } | null} 合法项或 null。
 */
function readStat(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const rawHits = Number(raw.hits)
  if (!Number.isFinite(rawHits) || rawHits < 0) return null
  const hits = Math.min(MAX_HITS, Math.floor(rawHits))
  const parsed = Date.parse(raw.last)
  return { hits, last: Number.isFinite(parsed) ? new Date(parsed).toISOString() : '' }
}

/**
 * 解析 usage.json 文本。
 *
 * 任何异常形态都退回空统计，**绝不抛**：非字符串、非 JSON、顶层不是对象、
 * 分区不是对象、键名不是字符串、值不是合法计数项——逐项丢弃即可。
 *
 * @param {unknown} text - 文件文本。
 * @returns {{ topics: object, entries: object }} 规整后的统计（可能为空）。
 */
export function parseUsage(text) {
  const usage = emptyUsage()
  if (typeof text !== 'string' || text.trim() === '') return usage
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return usage
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return usage
  for (const group of USAGE_GROUPS) {
    const source = parsed[group]
    if (source === null || typeof source !== 'object' || Array.isArray(source)) continue
    let kept = 0
    for (const [key, raw] of Object.entries(source)) {
      if (kept >= MAX_KEYS_PER_GROUP) break
      const name = readKey(group, key)
      if (name === '') continue
      const stat = readStat(raw)
      if (stat === null) continue
      usage[group][name] = stat
      kept += 1
    }
  }
  return usage
}

/**
 * 收一个统计键：`topics` 走 `normalizeTopic`（与条目头同一套归一，避免
 * 「注入机制」与「注入机制 」记成两笔），`entries` 收 5–15 位十六进制 id。
 *
 * @param {'topics' | 'entries'} group - 分区。
 * @param {unknown} key - 原始键。
 * @returns {string} 归一后的键；非法返回空串。
 */
export function readKey(group, key) {
  if (typeof key !== 'string') return ''
  if (group === 'topics') return normalizeTopic(key)
  const id = key.trim()
  return /^[0-9a-f]{5,15}$/u.test(id) ? id : ''
}

/**
 * 序列化成落盘文本（稳定键序，便于 diff 与人工查看）。
 *
 * @param {object} [usage] - 统计对象。
 * @returns {string} JSON 文本，以 `\n` 结尾。
 */
export function serializeUsage(usage) {
  const out = {}
  for (const group of USAGE_GROUPS) {
    const source = usage?.[group]
    const flat = {}
    if (source !== null && typeof source === 'object') {
      for (const key of Object.keys(source).sort()) {
        const stat = readStat(source[key])
        if (stat === null) continue
        flat[key] = stat
      }
    }
    out[group] = flat
  }
  return `${JSON.stringify(out, null, 2)}\n`
}

/**
 * 累加一批命中，返回**新**统计对象（不就地改，便于调用方拿旧值兜底）。
 *
 * @param {object} [usage] - 现有统计。
 * @param {{ topics?: string[], entries?: string[] }} [hits] - 本轮命中的主题名与条目 id。
 * @param {string} [at] - ISO 时间戳；缺省取当前时间。
 * @returns {object} 新的统计对象。
 */
export function bumpUsage(usage, hits, at) {
  const stamp = (() => {
    const parsed = Date.parse(at)
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString()
  })()
  const next = emptyUsage()
  for (const group of USAGE_GROUPS) {
    const source = usage?.[group]
    if (source !== null && typeof source === 'object') {
      for (const [key, raw] of Object.entries(source)) {
        const name = readKey(group, key)
        const stat = readStat(raw)
        if (name !== '' && stat !== null) next[group][name] = { ...stat }
      }
    }
  }
  for (const group of USAGE_GROUPS) {
    const list = Array.isArray(hits?.[group]) ? hits[group] : []
    // 同一批里重复的键只算一次命中：一次检索把同主题的两条条目都拉起来，说明的是
    // 「这次查询需要这个主题」，记两笔只会把 hits 吹大、让热度排序失真。
    const seen = new Set()
    for (const raw of list) {
      const name = readKey(group, raw)
      if (name === '' || seen.has(name)) continue
      seen.add(name)
      const prev = next[group][name]
      const hitsBefore = Number.isFinite(prev?.hits) ? prev.hits : 0
      next[group][name] = { hits: Math.min(MAX_HITS, hitsBefore + 1), last: stamp }
    }
  }
  return next
}

/**
 * 取某主题的命中数；缺失即 0（热度缺失时排序退回时间倒序，契约 §V8.10）。
 *
 * @param {object} [usage] - 统计对象。
 * @param {unknown} name - 主题名。
 * @returns {number} 命中数。
 */
export function topicHits(usage, name) {
  const key = readKey('topics', name)
  if (key === '') return 0
  const hits = Number(usage?.topics?.[key]?.hits)
  return Number.isFinite(hits) && hits > 0 ? hits : 0
}

/**
 * 取某条目 id 的命中数。
 *
 * @param {object} [usage] - 统计对象。
 * @param {unknown} id - 条目 id。
 * @returns {number} 命中数。
 */
export function entryHits(usage, id) {
  const key = readKey('entries', id)
  if (key === '') return 0
  const hits = Number(usage?.entries?.[key]?.hits)
  return Number.isFinite(hits) && hits > 0 ? hits : 0
}

/**
 * 条目的有效热度：条目 id 与它所属 topic 取较大者。
 *
 * 为什么取较大而不是相加：整编重写正文会让条目 id 换代，旧热度全留在 topic 上；
 * 相加会把「同一批命中」在两个键上重复计一次。
 *
 * @param {object} [usage] - 统计对象。
 * @param {{ id?: unknown, topic?: unknown }} [entry] - 条目（`topic` 需显式传，见 document.js 的下游注意）。
 * @returns {number} 命中数。
 */
export function entryHeat(usage, entry) {
  return Math.max(entryHits(usage, entry?.id), topicHits(usage, entry?.topic))
}

/**
 * 统计摘要（供工具 `list`、面板与整理器输入用）。
 *
 * **两个视图各归其位，别拿一个迁就另一个**：
 *   - `hottest` 是面板的热点视图，只要前 10（D 在消费，多的行数是噪音）。
 *   - `topicRows` 是**全量**，给整理器判降级用。它不能截断：盘上第 11 个主题在整编
 *     输入里"没有数字"，模型就有实锤机会把「还有热度、只是没进前 10」的主题判成冷门
 *     ——而降级是不可逆的，降下去之后那条记忆只在冷层检索里出现，用户几乎发现不了。
 *     体积有闸：主题数被 `TOPIC_LIST_MAX = 50` 卡住，50 行热度约 1.5 KB。
 *
 * @param {object} [usage] - 统计对象。
 * @returns {{ topics: number, entries: number, hits: number, hottest: Array<{ name: string, hits: number, last: string }>, topicRows: Array<{ name: string, hits: number, last: string }> }}
 *   `hottest` 按命中数降序、最多 10 项；`topicRows` 同序但**不限量**。
 */
export function usageSummary(usage) {
  const rows = []
  let hits = 0
  for (const [name, raw] of Object.entries(usage?.topics ?? {})) {
    const stat = readStat(raw)
    if (stat === null) continue
    hits += stat.hits
    rows.push({ name, hits: stat.hits, last: stat.last })
  }
  rows.sort((a, b) => b.hits - a.hits || (a.name < b.name ? -1 : 1))
  return {
    topics: rows.length,
    entries: Object.keys(usage?.entries ?? {}).length,
    hits,
    hottest: rows.slice(0, 10),
    topicRows: rows,
  }
}
