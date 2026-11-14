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
 * 热度衰减的默认半衰期（天）：一条记忆的「有效热度」每过这么久折半。
 *
 * 30 天的依据：本项目项目记忆的整理阈值是 20 条 / 12 KB，一条约定通常在一个月内
 * 会被再次触及若干次；再长就分不出「最近在用」和「半年前用过」。
 */
export const DEFAULT_HALF_LIFE_DAYS = 30

/** 一天的毫秒数。 */
const DAY_MS = 86_400_000

/**
 * 一条统计项的「有效热度」：命中数按最后一次使用距今的时间指数衰减。
 *
 * `score = log(1 + hits) × 0.5 ^ (ageDays / halfLifeDays)`
 *
 * **为什么必须先衰减，而不是直接用 hits**：`hits` 是只增不减的累加值，"三年前被搜过
 * 20 次" 和 "昨天被搜过 20 次" 在它眼里完全一样。冷热分层的意义在于时效，而 hits
 * 本身不含时间信息，`last` 才有。
 *
 * **为什么用 log(1+hits) 而不是 hits**：命中次数长尾极重，一条热门主题可能上百次、
 * 其余个位数。线性会让头名永远霸榜，取对数后「20 次 vs 200 次」只差 1.4 倍，
 * 排序仍由时效主导。
 *
 * **为什么衰减分不落盘**：落盘就要在每次读时刷新 → 文件每轮都变 → 又变成「每轮写盘」。
 * 派生计算成本可忽略，且永远基于同一条基准事实（`last`），不累积机器时间漂移误差。
 *
 * @param {{ hits?: unknown, last?: unknown }|null|undefined} stat - 一条统计项。
 * @param {number} [now] - 当前时间戳（毫秒）；缺省取 `Date.now()`，测试可注入。
 * @param {number} [halfLifeDays] - 半衰期天数；非正数按 `DEFAULT_HALF_LIFE_DAYS`。
 * @returns {number} 有效热度；统计项非法或 `hits` 为 0 时返回 0（沿用「读不炸」不变量）。
 */
export function decayScore(stat, now, halfLifeDays) {
  const parsed = readStat(stat)
  if (parsed === null || parsed.hits <= 0) return 0
  const halfLife = Number.isFinite(halfLifeDays) && halfLifeDays > 0 ? halfLifeDays : DEFAULT_HALF_LIFE_DAYS
  const at = Number.isFinite(now) ? now : Date.now()
  const lastMs = Date.parse(parsed.last)
  // 没有可解析的 last：无法判断时效，按「刚刚用过」处理而不是按「远古」——
  // 漏记一次时间戳不该让一条记忆被判成冷的。
  if (!Number.isFinite(lastMs)) return Math.log(1 + parsed.hits)
  // 时钟回拨（last 在未来）按 0 天算，不产生 > 1 的放大系数。
  const ageDays = Math.max(0, (at - lastMs) / DAY_MS)
  return Math.log(1 + parsed.hits) * 0.5 ** (ageDays / halfLife)
}

/**
 * 距最后一次使用的天数。
 *
 * @param {{ last?: unknown }|null|undefined} stat - 一条统计项。
 * @param {number} [now] - 当前时间戳（毫秒）。
 * @returns {number} 天数；`last` 不可解析时返回 `Infinity`（等价于「很久没用了」）。
 */
export function ageDays(stat, now) {
  // **不能走 readStat**：它把 `hits` 当必填字段（缺了或非法就整项判废），而「距上次使用
  // 多少天」只依赖 `last`。一条统计项若只有 `last` 没有 `hits`，readStat 会返回 null，
  // 这里就会把「3 天前用过」误报成「很久没用」——正是这个函数最不该犯的错。
  if (stat === null || typeof stat !== 'object') return Infinity
  const lastMs = Date.parse(stat.last)
  if (!Number.isFinite(lastMs)) return Infinity
  const at = Number.isFinite(now) ? now : Date.now()
  return Math.max(0, (at - lastMs) / DAY_MS)
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
 * v12 起每行追加 `score`（衰减后有效热度）与 `ageDays`（距今天数）。**不传 `opts`
 * 时行为与升级前逐字节一致**（`score` 退化为 `log(1+hits)`、`ageDays` 为 `null`），
 * 保证本期之前的调用方一行不改也能跑（契约 §V8.0 不变量三「缺省 = 旧行为」）。
 *
 * @param {object} [usage] - 统计对象。
 * @param {{ now?: number, halfLifeDays?: number }} [opts] - 衰减参数；缺省时不衰减。
 * @returns {{ topics: number, entries: number, hits: number,
 *   hottest: Array<{ name: string, hits: number, last: string, score: number, ageDays: number|null }>,
 *   topicRows: Array<{ name: string, hits: number, last: string, score: number, ageDays: number|null }> }}
 *   `hottest` 按有效热度降序、最多 10 项；`topicRows` 同序但**不限量**。
 */
export function usageSummary(usage, opts) {
  const decayed = opts !== null && typeof opts === 'object'
  const now = decayed && Number.isFinite(opts.now) ? opts.now : Date.now()
  const halfLife = decayed ? opts.halfLifeDays : undefined
  const rows = []
  let hits = 0
  for (const [name, raw] of Object.entries(usage?.topics ?? {})) {
    const stat = readStat(raw)
    if (stat === null) continue
    hits += stat.hits
    rows.push({
      name,
      hits: stat.hits,
      last: stat.last,
      score: decayed ? decayScore(stat, now, halfLife) : Math.log(1 + stat.hits),
      ageDays: decayed ? ageDays(stat, now) : null,
    })
  }
  // 有衰减参数时按有效热度排序，否则沿用旧的按 hits 降序（保持升级前行为）。
  const compare = decayed
    ? (a, b) => b.score - a.score || b.hits - a.hits || (a.name < b.name ? -1 : 1)
    : (a, b) => b.hits - a.hits || (a.name < b.name ? -1 : 1)
  rows.sort(compare)
  return {
    topics: rows.length,
    entries: Object.keys(usage?.entries ?? {}).length,
    hits,
    hottest: rows.slice(0, 10),
    topicRows: rows,
  }
}

/**
 * 条目级热度行（面板与工具用）。
 *
 * 现状只有 `topics` 有汇总视图，`entries` 是一张裸表；面板因此只能看到"注入机制这个
 * 主题很热"，看不到"具体是哪一条被反复用到"。本函数把这张表摊成可展示的行。
 *
 * 只对 `hits > 0` 的项出行（零命中不是「热度低」，是「没被记过热度」，列出来只会污染表格）；
 * `limit` 截断（默认 30），按有效热度降序。
 *
 * **孤儿过滤（v12.1）**：传了 `lookup` 时，映射不到正文的 id 一律不返回。
 * 为什么必须过滤：条目 id 由 `sha1(time + body)` 派生，整编改写正文就换代，而旧 id 的热度
 * 留在 `usage.json` 里**永远不会被清**。本项目实测 18 条热度里 14 条是这种孤儿——
 * 它们既无法显示成可读文字，也不会被任何排序用到，只会把表格撑满、让「主题 0 个」
 * 和「热度 18 条」看起来自相矛盾。
 *
 * @param {object} [usage] - 统计对象。
 * @param {{ now?: number, halfLifeDays?: number, limit?: number,
 *   lookup?: (id: string) => ({ body?: string, topic?: string } | null),
 *   previewChars?: number }} [opts] - 衰减、截断与正文回填参数。
 * @returns {Array<{ id: string, hits: number, last: string, score: number, ageDays: number,
 *   preview?: string, full?: string, topic?: string }>} 条目热度行。
 *   传了 `lookup` 时额外带 `preview`（正文首行截断）与 `topic`，且孤儿行被剔除。
 */
export function entryRows(usage, opts) {
  const now = Number.isFinite(opts?.now) ? opts.now : Date.now()
  const halfLife = opts?.halfLifeDays
  const limit = Number.isFinite(opts?.limit) && opts.limit > 0 ? Math.floor(opts.limit) : 30
  const lookup = typeof opts?.lookup === 'function' ? opts.lookup : null
  const previewChars = Number.isFinite(opts?.previewChars) && opts.previewChars > 0 ? Math.floor(opts.previewChars) : 40
  const rows = []
  for (const [id, raw] of Object.entries(usage?.entries ?? {})) {
    const key = readKey('entries', id)
    if (key === '') continue
    const stat = readStat(raw)
    if (stat === null || stat.hits <= 0) continue
    const row = { id: key, hits: stat.hits, last: stat.last, score: decayScore(stat, now, halfLife), ageDays: ageDays(stat, now) }
    if (lookup !== null) {
      const entry = lookup(key)
      // 映射不到 = 孤儿（整编换代后的旧 id），不展示。
      // 约定：lookup 返回 null 表示「这条 id 在盘上不存在」；返回对象（哪怕正文为空）
      // 表示「存在，只是一个字都没写」。把两者混成 falsy 判断会把空条目误删。
      if (entry === null || entry === undefined) continue
      const body = typeof entry.body === 'string' ? entry.body : ''
      const trimmed = body.trim()
      row.preview = trimmed === '' ? '' : trimmed.split('\n')[0].slice(0, previewChars)
      // full 供前端悬停显示完整正文。**必须截断**：单条正文可能几 KB，一整页 30 行
      // 会把响应撑到几百 KB，而悬停提示本来就只用于「快速确认是哪条」。
      if (trimmed !== '') row.full = trimmed.length > 400 ? `${trimmed.slice(0, 400)}…` : trimmed
      if (typeof entry.topic === 'string') row.topic = entry.topic
    }
    rows.push(row)
  }
  rows.sort((a, b) => b.score - a.score || b.hits - a.hits || (a.id < b.id ? -1 : 1))
  return rows.slice(0, limit)
}
