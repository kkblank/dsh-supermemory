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
 * 输出形状的规整（含 v8 的三键与 tier / topic 归一）在 `consolidate-plan.js`。
 * 依赖因此是单向的：consolidate → consolidate-plan / digest → document。
 *
 * v8（契约 V8.8）在整编输出上加了第三键 `topics`，并给每条新条目加了可选的 `tier` /
 * `topic`。三键只带来两件事：**新条目可以带着分层落盘**，以及**两类新的对账线索**
 * （非法 tier 进 `suspects`、没人用的主题名进 `orphanTopics`）。七条对账规则与三道栅栏
 * 一字未改，尤其规则 5「没写不等于删除」在这里继续成立：**模型没写 tier / topic 的条目，
 * 连分层带正文一并原样不动**，缺省态与升级前逐字节相同。
 *
 * 硬约束：不 import 任何 `@deepseek-ai/*` 宿主包，不碰磁盘与网络。
 *
 * @module dsh-supermemory/core/consolidate
 */

import { byteLength, parseEntries, rebuildDocument } from './document.js'
import { parseConsolidateOutput, sanitizePlan, similarityKey } from './consolidate-plan.js'

// 容错提取与输出规整整段住在 consolidate-plan.js（单文件 ≤400 行的规范约束，行为零变化）；
// 这里原样 re-export，`test/consolidate-core.test.js` 与 `host/digest.js` 的导入路径保持不变。
export { extractJsonObject, parseConsolidateOutput } from './consolidate-plan.js'

/** 整编产物的默认来源标记，与追加模式保持一致。 */
const CONSOLIDATE_SOURCE = 'digest'

/** 产物字节缩水下限：低于原文的 15% 判为退化（契约 §V4.0.2）。 */
const DEFAULT_MIN_KEEP_RATIO = 0.15

/** 纯删除比例上限：drop 超过旧条目的一半且没有任何合并，判为异常（契约 §V4.0.2）。 */
const DEFAULT_MAX_DROP_RATIO = 0.5

/**
 * `suspects` 的两种病因（契约 V8.8：非法 tier 与漏写 from 都只报线索，都不参与栅栏）。
 * 导出给运行报告按 kind 分流——`host/digest.js` 写进 runs.jsonl 时要分开计数。
 */
export const SUSPECT_MISSING_FROM = 'missing-from'
export const SUSPECT_INVALID_TIER = 'invalid-tier'

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

// —— 对账与三道栅栏（契约 §V4.0.2 的七条规则 + V8.8 的三键落点）——

/**
 * 从被吸收的旧条目里继承一个分层字段（`tier` / `topic`）的第一个**显式**值。
 *
 * 两道门槛，缺一不可：
 *
 * - 只继承**原文里显式写了这一段**的旧条目。`parseEntries` 给每条都挂了缺省值
 *   （`tier` 缺省 `core`），并用 `explicitTier === false` 标出那是派生的——派生值不继承，
 *   与「派生 id 不落盘」完全同构（契约 V8.2）。否则一次整编就能把全篇的缺省 core 变成
 *   显式 core，凭空造出一整篇 diff 噪音。
 * - 合并多条时取它吸收的**第一条**（按文档顺序），与规则 6 的插入位置同一条目——
 *   不会出现「插在 A 的位置、抄了 C 的分层」。
 *
 * @param {Array<{ entry: object }>} refs - 这条新条目吸收的旧条目档案。
 * @param {string} key - 字段名（`tier` / `topic`）。
 * @param {string} explicitKey - 对应的显式标记字段名（`explicitTier` / `explicitTopic`）。
 * @returns {string|undefined} 继承到的值；一个都没有则 undefined（表示这个字段不挂）。
 */
function inheritedField(refs, key, explicitKey) {
  for (const ref of refs) {
    const value = ref?.entry?.[key]
    if (typeof value !== 'string' || value === '') continue
    if (ref.entry[explicitKey] === false) continue
    return value
  }
  return undefined
}

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
 * v8 的三键同样走「没写就不动」这条线（契约 V8.8）：新条目的 `tier` / `topic` 只在模型
 * 写了、或能从被吸收的旧条目继承到**显式**值时才挂上去，两者都没有就不挂字段，交回
 * `renderEntry` 的缺省态（core / 未分类，不落盘）。模型写了非法 tier（`warm` 之类）按
 * 没写处理，并留下一条 `suspects` 线索（`kind: 'invalid-tier'`）；主题表里没有任何条目
 * 使用的名字进 `orphanTopics`。两者都只是线索，都不参与栅栏——分层是渲染期的事，
 * 不值得为它放弃一整轮整编。
 *
 * 落盘文本一律出自 `rebuildDocument`，preamble 由它逐字保留。保留的旧条目带着
 * 解析期的派生 id 也无妨：`renderEntry` 只写显式 id，派生 id 不落盘。
 *
 * @param {unknown} oldText - project 文档原文。
 * @param {{ entries?: unknown, drop?: unknown, topics?: unknown } | null} parsed -
 *   `parseConsolidateOutput` 的结果形状。
 * @param {{ time?: string, source?: string, minKeepRatio?: number, maxDropRatio?: number }} [options] -
 *   `time` 是新条目的时间戳（缺省当前时间）；两个比例是栅栏阈值，缺省 0.15 / 0.5。
 * @returns {{ ok: true, text: string, entries: Array<object>,
 *   counts: { added: number, merged: number, dropped: number, kept: number },
 *   absorbedIds: string[], droppedDetail: Array<{ id: string, reason: string }>, ghosts: string[],
 *   duplicates: string[],
 *   suspects: Array<{ kind: string, id: string, time: string, newBody: string, oldBody: string }>,
 *   topics: Array<{ name: string, summary: string, aliases: string[] }>, orphanTopics: string[],
 *   tiers: { core: number, cold: number } }
 *   | { ok: false, reason: 'SHRINK_GUARD' | 'DROP_GUARD' | 'EMPTY', bytesBefore: number, bytesAfter: number }
 *   命中栅栏时调用方**不要写盘**。`entries` 是目标态条目（含不可枚举的 id 与 tier / topic），
 *   给调用方做统计用，不必再解析一遍 `text`。
 */
export function applyConsolidation(oldText, parsed, options = {}) {
  const oldEntries = parseEntries(oldText)
  const bytesBefore = byteLength(oldText)
  const plan = sanitizePlan(parsed ?? {})
  // 非法 tier 的线索优先取 parsed 带出来的那份。`parsed` 允许是模型原始对象（v4 就有的宽容），
  // 也允许是 `parseConsolidateOutput` 的产物——而后者的 entries 里非法 tier 早已被丢掉，
  // 在这里再规整一遍只会得到一份空的 invalidTiers，把模型写错分层的痕迹彻底抹掉。
  const invalidTiers = Array.isArray(parsed?.invalidTiers) ? parsed.invalidTiers : plan.invalidTiers

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
    plans.push({ body: item.text, refs, tier: item.tier, topic: item.topic })
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

  /**
   * 造一条要落盘的新条目。分层字段两级取值：模型写了 → 用它的；没写 → 继承被吸收的
   * 旧条目里第一个写了的显式值；两处都没有 → **不挂这个字段**，落回缺省态。
   * 「模型没写 tier / topic」与「模型没写 from」是同一个安全语义：不动就是正确答案。
   */
  const newEntry = (item) => {
    const entry = { time, source, body: item.body }
    const tier = item.tier ?? inheritedField(item.refs, 'tier', 'explicitTier')
    if (tier !== undefined) entry.tier = tier
    const topic = item.topic ?? inheritedField(item.refs, 'topic', 'explicitTopic')
    if (topic !== undefined) entry.topic = topic
    return entry
  }

  const next = []
  const absorbedIds = []
  // 缺省即 core（契约 V8.0 不变量三「缺省 = 旧行为」）：只有显式 cold 才算冷层。
  const tiers = { core: 0, cold: 0 }
  let kept = 0
  const countTier = (entry) => {
    tiers[entry?.tier === 'cold' ? 'cold' : 'core'] += 1
    return entry
  }
  for (const record of records) {
    for (const item of insertAt.get(record.index) ?? []) {
      next.push(countTier(newEntry(item)))
    }
    if (record.absorbed) {
      absorbedIds.push(record.entry.id)
      continue
    }
    if (record.dropped) continue
    // 规则 5：原条目对象原样进结果——时间戳、来源、正文、显式 id、显式 tier / topic 一概不动。
    next.push(countTier(record.entry))
    kept += 1
  }
  for (const item of appended) next.push(countTier(newEntry(item)))

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
        kind: SUSPECT_MISSING_FROM,
        id: records[i].entry.id,
        time: records[i].entry.time,
        newBody: item.body,
        oldBody: records[i].entry.body,
      })
      break
    }
  }

  // 非法 tier 的线索（契约 V8.8）：模型想调分层但写了个不存在的值。它已经按「没写」处理，
  // 这一行只是让运行报告看得见——静默吞掉是最糟的结局，用户会以为分层真的生效了。
  for (const bad of invalidTiers) {
    suspects.push({
      kind: SUSPECT_INVALID_TIER,
      id: '',
      time: '',
      newBody: bad.text,
      oldBody: '',
    })
  }

  // 没人用的主题名（契约 V8.8 的对账）：主题表提供摘要与别名，目录以**条目上实际写的
  // topic** 为准（V8.3 的一致性栅栏），所以表里挂着没人用的名字就是一条会长期误导人的
  // 目录项。同样只是线索，不参与栅栏——下一轮整编还会再报，直到它被归并或删掉。
  const usedTopics = new Set()
  for (const entry of next) {
    if (typeof entry?.topic === 'string' && entry.topic !== '') usedTopics.add(entry.topic)
  }
  const orphanTopics = plan.topics.filter((topic) => !usedTopics.has(topic.name)).map((topic) => topic.name)

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

  return {
    ok: true,
    text,
    entries: next,
    counts,
    absorbedIds,
    droppedDetail,
    ghosts,
    duplicates,
    suspects,
    topics: plan.topics,
    orphanTopics,
    tiers,
  }
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
