/**
 * 记忆整编（consolidate）：输出校验、旧条目对账、整编时机（纯函数）。
 *
 * 与 `digest.js` 的追加模式相对：追加只写「本轮新增了什么」，整编给出的是 project 记忆的
 * **目标态**——一批带 `from` 的新条目加上一批 `drop`，由 `applyConsolidation` 拿旧条目的
 * id 逐条对账。整编的全部风险都收在这一步：模型引用了不存在的 id（`ghosts`）、多条新条目
 * 抢同一个 id（`duplicates`）、漏写旧条目（原样保留）、发疯把二十条压成一句话（三道栅栏
 * 拦下，调用方不写盘）。契约 §V4.0.2。
 *
 * 对账只认 id 不认文本：id 由 `document.js` 的 `deriveEntryId` 从内容派生，同一份文本反复
 * 解析得到同一批 id，喂给模型的 `[<id>] 正文` 与落盘时的定位因此总能对上。
 *
 * 容错提取（围栏、平衡括号扫描）的唯一真源在 `digest.js`——那里是模型输出的第一道入口，
 * 本模块复用它的遍历（`pickJsonObject`）而不是复制一份，两个模式的容错行为不会各自漂移。
 * 依赖因此是单向的：consolidate → digest → document。
 *
 * 硬约束：不 import 任何 `@deepseek-ai/*` 宿主包，不碰磁盘与网络。
 *
 * @module dsh-supermemory/core/consolidate
 */

import { byteLength, parseEntries, rebuildDocument } from './document.js'
import { pickJsonObject } from './digest.js'

/** 整编产物的默认来源标记，与追加模式保持一致。 */
const CONSOLIDATE_SOURCE = 'digest'

/** 产物字节缩水下限：低于原文的 15% 判为退化（契约 §V4.0.2）。 */
const DEFAULT_MIN_KEEP_RATIO = 0.15

/** 纯删除比例上限：drop 超过旧条目的一半且没有任何合并，判为异常（契约 §V4.0.2）。 */
const DEFAULT_MAX_DROP_RATIO = 0.5

/** 相似度指纹取折叠后的前多少个字符。 */
const SIMILARITY_PREFIX = 40

/** 折叠后不足这么多字符就不做相似度比对：太短的正文前缀必然互撞，报出来全是噪音。 */
const SIMILARITY_MIN = 8

/**
 * 把任意输入规整成字符串。
 * @param value - 任意值。
 * @returns 字符串（null/undefined → ''）。
 */
function asText(value) {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  return String(value)
}

/**
 * 从任意文本里提取第一个合法 JSON 对象（整编侧的容错出口，契约 §V4.0.2）。
 *
 * 候选顺序与追加模式完全同源：整段 → ```围栏``` 内容 → 首 `{` 到末 `}` → 逐个平衡括号切片；
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

// —— 输出校验：把模型给的 entries / drop 规整成可对账的形状 ——

/**
 * 规整整编输出的 `entries` / `drop` 两个数组。
 *
 * 宽容进、严格出：模型偷懒写成字符串项时按「纯新增条目」收（多一条不丢信息），
 * 但 `drop` 缺 `reason` 一律丢弃该项——没有理由的删除不执行，宁可留一条过时记忆。
 * id 类字段（`from` 的每一项、`drop[].id`）**只接受字符串**：id 是标识符，把 `42`
 * 转成 `'42'` 只会凭空造出一个引向虚无的引用；文本类字段（`text`、`reason`）则容忍
 * 非字符串，转成字符串照样能用。`from` 里的 id 转小写去重：id 是十六进制，模型写成
 * 大写不该被当成幽灵。
 *
 * @param object - 已解析的整编输出对象。
 * @returns { entries: Array<{ text: string, from: string[] }>, drop: Array<{ id: string, reason: string }> }。
 */
function sanitizeConsolidation(object) {
  const entries = []
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
    entries.push({ text, from })
  }

  const drop = []
  for (const item of Array.isArray(object?.drop) ? object.drop : []) {
    const id = typeof item?.id === 'string' ? item.id.trim().toLowerCase() : ''
    const reason = asText(item?.reason).trim()
    if (id === '' || reason === '') continue
    if (!drop.some((kept) => kept.id === id)) drop.push({ id, reason })
  }

  return { entries, drop }
}

/**
 * 解析整编模式的模型输出：`{"entries":[{"text":"…","from":["a3f2c"]}],"drop":[{"id":"b8e01","reason":"…"}]}`。
 *
 * 只做格式校验，不校验 id 是否存在于旧文档——那要拿到旧文本才能判，归 `applyConsolidation`。
 *
 * @param {unknown} raw - 模型原始输出（字符串，或已解析的对象）。
 * @returns {{ ok: true, entries: Array<object>, drop: Array<object> } | { ok: false, error: string }}。
 */
export function parseConsolidateOutput(raw) {
  if (typeof raw === 'string' && raw.trim() === '') return { ok: false, error: '整编输出为空' }
  const object = extractJsonObject(raw)
  if (object === null) return { ok: false, error: '整编输出中没有合法 JSON 对象' }
  return { ok: true, ...sanitizeConsolidation(object) }
}

/**
 * 取一个非负有限数，非法（NaN / Infinity / 负数 / 非数字类型）时退回默认值。
 * @param value - 任意值；接受数字与数字字符串。
 * @param fallback - 默认值。
 * @returns 数值。
 */
function toCount(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return value >= 0 ? value : fallback
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed) && parsed >= 0) return parsed
  }
  return fallback
}

/**
 * 解析时间字段成毫秒时间戳；非法时间串（含 `lastConsolidateAt` 被写坏的情况）返回 null。
 * @param value - ISO 字符串、数字时间戳，或其它。
 * @returns {number | null}。
 */
function toMillis(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

/**
 * 相似度指纹：折叠空白、去掉标点与符号后取前若干字符。
 * 短于 `SIMILARITY_MIN` 字符的正文返回空串，不参与比对——太短的文本前缀必然互撞，
 * 报出来的全是噪音。
 *
 * @param {unknown} text - 条目正文。
 * @returns {string} 指纹（可能为空串）。
 */
function similarityKey(text) {
  const folded = asText(text).toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')
  return folded.length < SIMILARITY_MIN ? '' : folded.slice(0, SIMILARITY_PREFIX)
}

// —— 对账与三道栅栏（契约 §V4.0.2 的七条规则）——

/**
 * 整编对账：把模型的整编结果落到旧文档上，算出目标态文本（纯函数，不碰磁盘）。
 *
 * 七条规则里最要紧的是第 5 条：**既没被吸收也没被 drop 的旧条目原样保留**。
 * 模型漏写、写错 id、只处理了一半，后果都只是「这次没整干净」，绝不会丢记忆——
 * 这是整编敢于自动跑的前提，也是本函数最难测的地方，测试里按用例逐条钉住。
 *
 * 两处契约没写死、由本实现定下来的行为（Lead 已确认按此写进契约）：
 *
 * - **同一个 id 被多条新条目的 `from` 抢**：第一个吸收者生效，后续引用忽略并把该 id
 *   记进 `duplicates`（不混进 `ghosts`，两者病因不同：一个是模型编造，一个是模型重复）。
 *   一条旧条目绝不会被两条新条目各自替代。
 * - **模型改写了某条却没写 `from`**：旧条目按规则 5 保留，于是新旧并存、内容重复。
 *   这是**可以接受**的退化（重复但不丢，下一轮整编还能收），所以不设栅栏，
 *   只在 `suspects` 里留下线索：正文指纹与某条被保留旧条目相同的条目对，供运行报告提示。
 *
 * 落盘文本一律出自 `rebuildDocument`，preamble 由它逐字保留。保留的旧条目带着
 * 解析期的派生 id 也无妨：`renderEntry` 只写显式 id，派生 id 不落盘。
 *
 * @param {unknown} oldText - project 文档原文。
 * @param {{ entries?: unknown, drop?: unknown } | null} parsed - `parseConsolidateOutput` 的结果形状。
 * @param {{ time?: string, source?: string, minKeepRatio?: number, maxDropRatio?: number }} [options] -
 *   `time` 是新条目的时间戳（缺省当前时间）；两个比例是栅栏阈值，缺省 0.15 / 0.5。
 * @returns {{ ok: true, text: string, counts: { added: number, merged: number, dropped: number, kept: number },
 *   absorbedIds: string[], droppedDetail: Array<{ id: string, reason: string }>, ghosts: string[],
 *   duplicates: string[],
 *   suspects: Array<{ id: string, time: string, newBody: string, oldBody: string }> }
 *   | { ok: false, reason: 'SHRINK_GUARD' | 'DROP_GUARD' | 'EMPTY', bytesBefore: number, bytesAfter: number }
 *   命中栅栏时调用方**不要写盘**。
 */
export function applyConsolidation(oldText, parsed, options = {}) {
  const oldEntries = parseEntries(oldText)
  const bytesBefore = byteLength(oldText)
  const plan = sanitizeConsolidation(parsed ?? {})

  const time =
    typeof options?.time === 'string' && options.time.trim() !== ''
      ? options.time
      : new Date().toISOString()
  const source =
    typeof options?.source === 'string' && options.source.trim() !== ''
      ? options.source
      : CONSOLIDATE_SOURCE

  // id → 旧条目档案。重复 id 理论上不存在（parseEntries 保证唯一），这里只留第一份。
  const records = oldEntries.map((entry, index) => ({ entry, index, absorbed: false, dropped: false }))
  const index = new Map()
  for (const record of records) {
    if (!index.has(record.entry.id)) index.set(record.entry.id, record)
  }

  const ghosts = []
  const duplicates = []
  const seenGhost = new Set()
  const seenDuplicate = new Set()
  const pushOnce = (list, seen, value) => {
    if (seen.has(value)) return
    seen.add(value)
    list.push(value)
  }

  // 规则 2 / 3：先认领 from 引用的旧条目。引用不到的分两种病因分开记：
  // 文档里查无此 id 是幽灵，被别人先抢走是重复引用——都忽略，都不影响其余对账。
  const plans = []
  for (const item of plan.entries) {
    const refs = []
    for (const id of item.from) {
      const record = index.get(id)
      if (record === undefined) {
        pushOnce(ghosts, seenGhost, id)
        continue
      }
      if (record.absorbed) {
        pushOnce(duplicates, seenDuplicate, id)
        continue
      }
      record.absorbed = true
      refs.push(record)
    }
    plans.push({ body: item.text, refs })
  }

  // 规则 4：drop 命中已被吸收的条目时忽略——它已经换了形态，不该再记一次删除，
  // 也不算异常（模型常常先合并再顺手补一条 drop）。
  const droppedDetail = []
  for (const item of plan.drop) {
    const record = index.get(item.id)
    if (record === undefined) {
      pushOnce(ghosts, seenGhost, item.id)
      continue
    }
    if (record.absorbed || record.dropped) continue
    record.dropped = true
    droppedDetail.push({ id: item.id, reason: item.reason })
  }

  // 规则 6：新条目插在它吸收的第一条旧条目原位；无家可归的（from 为空或全是幽灵）排队追加到末尾。
  const insertAt = new Map()
  const appended = []
  for (const item of plans) {
    if (item.refs.length === 0) {
      appended.push(item)
      continue
    }
    const first = item.refs.reduce((min, ref) => (ref.index < min ? ref.index : min), item.refs[0].index)
    if (!insertAt.has(first)) insertAt.set(first, [])
    insertAt.get(first).push(item)
  }

  const next = []
  const absorbedIds = []
  let kept = 0
  for (const record of records) {
    for (const item of insertAt.get(record.index) ?? []) {
      next.push({ time, source, body: item.body })
    }
    if (record.absorbed) {
      absorbedIds.push(record.entry.id)
      continue
    }
    if (record.dropped) continue
    // 规则 5：原条目对象原样进结果——时间戳、来源、正文、显式 id 一概不动。
    next.push(record.entry)
    kept += 1
  }
  for (const item of appended) next.push({ time, source, body: item.body })

  // 漏写 from 的线索：新条目正文与某条「被保留下来的旧条目」长得一样 → 多半是模型
  // 改写了它却忘了引用。提示性字段，不参与栅栏判定，也可能误报（前缀巧合）。
  const suspects = []
  const suspectTaken = new Set()
  const keptKeys = records.map((record) =>
    record.absorbed || record.dropped ? '' : similarityKey(record.entry.body),
  )
  for (const item of plans) {
    const key = similarityKey(item.body)
    if (key === '') continue
    for (let i = 0; i < records.length; i += 1) {
      if (keptKeys[i] !== key || suspectTaken.has(i)) continue
      suspectTaken.add(i)
      suspects.push({
        id: records[i].entry.id,
        time: records[i].entry.time,
        newBody: item.body,
        oldBody: records[i].entry.body,
      })
      break
    }
  }

  const counts = { added: plans.length, merged: absorbedIds.length, dropped: droppedDetail.length, kept }
  const text = rebuildDocument(oldText, next)
  const bytesAfter = byteLength(text)
  const minKeepRatio = toCount(options?.minKeepRatio, DEFAULT_MIN_KEEP_RATIO)
  const maxDropRatio = toCount(options?.maxDropRatio, DEFAULT_MAX_DROP_RATIO)

  // 规则 7 三道栅栏，从严到宽依次判。整编的正常缩水是期望行为，所以只兜极端退化。
  if (next.length === 0 && oldEntries.length > 0) {
    return { ok: false, reason: 'EMPTY', bytesBefore, bytesAfter }
  }
  if (bytesAfter < bytesBefore * minKeepRatio) {
    return { ok: false, reason: 'SHRINK_GUARD', bytesBefore, bytesAfter }
  }
  if (counts.dropped > oldEntries.length * maxDropRatio && counts.merged === 0) {
    return { ok: false, reason: 'DROP_GUARD', bytesBefore, bytesAfter }
  }

  return { ok: true, text, counts, absorbedIds, droppedDetail, ghosts, duplicates, suspects }
}

// —— 整编时机（纯函数，条目数与上次整编时间由调用方喂进来）——

/** `shouldConsolidate` 的条目数默认阈值（契约 §V4.0.4）。 */
const DEFAULT_CONSOLIDATE_MIN_ENTRIES = 20

/** `shouldConsolidate` 的体积默认阈值（字节，契约 §V4.0.4）。 */
const DEFAULT_CONSOLIDATE_MIN_BYTES = 12288

/**
 * 这一轮该不该整编（纯函数，不读盘：条目数、字节数、上次整编时间都由调用方喂进来）。
 *
 * 判定顺序是「开关 → 规模 → 冷却」：规模没到就不谈冷却，`reason` 也据此只报第一个
 * 不满足的条件，方便 RunRecord 里一眼看出本轮为什么走追加。
 *
 * @param {{ enabled?: unknown, entryCount?: unknown, bytes?: unknown, minEntries?: unknown,
 *   minBytes?: unknown, lastConsolidateAt?: unknown, cooldownMs?: unknown, now?: unknown }} [input] -
 *   阈值缺省取契约默认（20 条 / 12288 字节）；`now` 缺省用当前时间；
 *   `lastConsolidateAt` 缺失或不是合法时间串都按「没有整编过」处理。
 * @returns {{ consolidate: boolean, reason: string }} reason 取
 *   `disabled` / `below-threshold` / `cooldown` / `entry-count` / `bytes`。
 */
export function shouldConsolidate(input = {}) {
  if (input?.enabled !== true) return { consolidate: false, reason: 'disabled' }

  const entryCount = toCount(input?.entryCount, 0)
  const bytes = toCount(input?.bytes, 0)
  const minEntries = toCount(input?.minEntries, DEFAULT_CONSOLIDATE_MIN_ENTRIES)
  const minBytes = toCount(input?.minBytes, DEFAULT_CONSOLIDATE_MIN_BYTES)
  const threshold = entryCount >= minEntries ? 'entry-count' : bytes >= minBytes ? 'bytes' : ''
  if (threshold === '') return { consolidate: false, reason: 'below-threshold' }

  const cooldownMs = toCount(input?.cooldownMs, 0)
  const lastAt = toMillis(input?.lastConsolidateAt)
  if (cooldownMs > 0 && lastAt !== null) {
    const nowMs = toMillis(input?.now) ?? Date.now()
    if (nowMs - lastAt < cooldownMs) return { consolidate: false, reason: 'cooldown' }
  }

  return { consolidate: true, reason: threshold }
}
