/**
 * 动态预取的判据与状态读写（契约 §V8.9 / §V8.15 裁决 3、4）。
 *
 * 全部是不碰磁盘、不碰宿主的纯函数（只读 `session` 的日志快照与调用方喂进来的
 * 条目数组），单独成模块的理由：预取是 v8 里唯一「每轮都可能改写快照内容」的机制，
 * 它的判据必须能脱离宿主单独测——冷却失效一次，代价是每轮重写快照、prompt cache
 * 全废，而这在真机上表现为「记忆好像每轮都在抖」，极难定位。
 *
 * 三条来自实测的硬规定（不要放宽）：
 *   1. **轮数只数 `source.kind === 'user'`**。宿主每轮还会额外写 `runtime-context`
 *      / `time-context` / `tool-jobs` / `skill-catalog`，它们同样是 `user/message`。
 *      真实日志里真用户发言 1–3 条的会话，这些注入类事件有 3–10 条——用「不是本插件
 *      的 user/message」当轮数，一轮之内就凑满 `projectRecallMinRounds`，冷却形同
 *      不存在（§V8.15 裁决 4）。
 *   2. **候选判据带上溢出集**：`tier !== 'core' || overflow.has(id)`。core 段超预算时
 *      溢出条目会临时折进目录，它们 `tier` 仍是 `core` 却不在正文里，只按 tier 排除
 *      就永远回不到正文（§V8.15 裁决 3）。
 *   3. **预取正文必须转义后才交给渲染层**。条目来自磁盘，正文里一个 `</supermemory>`
 *      就能提前闭合整个包裹，让后续内容脱离受控上下文。
 *
 * @module dsh-supermemory/host/inject-recall
 */

import { escapeFrame } from '../core/render.js'
import { entryLocator } from './tools-search.js'

/** 无历史预取记录时的占位轮数，任何真实轮数都比它大 → 首轮允许换血。 */
export const NO_ROUND = -1

/**
 * 真实轮数：会话日志里 `user/message` 且 `source.kind === 'user'` 的条数。
 *
 * 判据收紧的理由见模块头第 1 条。读不到日志返回 0（当第一轮处理）。
 *
 * @param {object} session - 宿主 Session。
 * @returns {number} 轮数。
 */
export function countUserTurns(session) {
  let turns = 0
  try {
    if (typeof session?.snapshotEvents !== 'function') return 0
    for (const event of session.snapshotEvents()) {
      if (event?.type === 'user/message' && event?.data?.source?.kind === 'user') turns += 1
    }
  } catch {
    return 0
  }
  return turns
}

/**
 * 取本轮的用户输入。
 *
 * 从日志**尾部向前**找第一条 `source.kind === 'user'` 的 `user/message`，但**遇到
 * `assistant/message` 就停**——那是轮与轮之间的硬边界，跨过去就是上一轮的发言，
 * 拿它再检索一遍只会得到同一个集合，白花一次检索的钱。
 *
 * 为什么不能用「只看最后一条」：宿主每轮会往 `user/message` 里追加 `time-context`、
 * `runtime-context`、`skill-catalog` 这类自己产生的注入事件，它们和真实发言**同一个
 * 事件类型**。只要时序稍有变化，最后一条就不是用户发言，判据会静默返回 null、
 * 预取整轮不启动，而日志里没有任何痕迹。所以判据必须是「跳过非用户来源，遇到轮边界才停」。
 *
 * 回溯深度有上限，防止畸形日志把这条路径拖成 O(n)：真实一轮内宿主注入事件通常
 * 不超过 10 条，取 32 已经宽松。
 *
 * @param {object} session - 宿主 Session。
 * @returns {string | null} 用户输入文本；读不到、或本轮还没有用户发言时返回 null。
 */
export function latestUserQuery(session) {
  /** 一轮内允许回溯的最大事件数（含宿主注入事件）。 */
  const MAX_LOOKBACK = 32
  const events = []
  try {
    if (typeof session?.snapshotEvents !== 'function') return null
    for (const event of session.snapshotEvents()) events.push(event)
  } catch {
    return null
  }
  for (let index = events.length - 1, seen = 0; index >= 0 && seen < MAX_LOOKBACK; index -= 1, seen += 1) {
    const event = events[index]
    // 轮边界：助手已经回过话，说明再往前就是上一轮的输入。
    if (event?.type === 'assistant/message') return null
    if (event?.type !== 'user/message') continue
    if (event?.data?.source?.kind !== 'user') continue
    const content = Array.isArray(event.data?.content) ? event.data.content : []
    const text = content
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n')
      .trim()
    return text === '' ? null : text
  }
  return null
}

/**
 * 读上一条快照里的预取状态。
 *
 * `source.recall = { ids, round }` 是快照自己带的（契约要求「不新增外部状态」），
 * 所以下一轮直接从日志读回，不需要任何插件侧的缓存。字段缺失、类型不对、ids 里混进
 * 非字符串——一律退回「没有预取记录」，让升级前的旧快照自然走首轮换血。
 *
 * @param {object} event - 上一条快照事件（可能为 undefined）。
 * @returns {{ ids: string[], round: number }} 上轮的命中集合与换血轮数。
 */
export function readRecallState(event) {
  const raw = event?.data?.source?.recall
  const ids = Array.isArray(raw?.ids) ? raw.ids.filter((id) => typeof id === 'string' && id !== '') : []
  const round = Number.isFinite(raw?.round) ? Math.floor(raw.round) : NO_ROUND
  return { ids, round }
}

/**
 * 取「上一轮的预取状态」，surface 那条被压缩吞掉时退到日志。
 *
 * 常规路径读 surface 上那条快照。但**压缩会把被摘要吞掉的节点从 surface 上摘走**，
 * 那时 `lastSnapshotEvent` 找不到我们那条、本轮按「首次注入」重建；如果预取状态也只
 * 从 surface 那条读，它就跟着快照一起没了——本轮通常没有新输入，检索拿不到候选，
 * 重建出来的快照就少了整段「本轮相关记忆」，而契约 §V8.9 要求它随快照一起重写。
 * 预取状态是插件的历史，不是 surface 的可见性，所以 surface 那条不在时退到
 * append-only 日志里最近一条本插件的快照事件。
 *
 * @param {object} session - 宿主会话。
 * @param {object|undefined} surfaceEvent - surface 上那条快照事件（可能已被压缩吞掉）。
 * @param {string} sourceKind - 本插件快照的 `source.kind`。
 * @returns {{ ids: string[], round: number }} 上一轮的命中集合与换血轮数。
 */
export function previousRecallState(session, surfaceEvent, sourceKind) {
  if (surfaceEvent !== undefined && surfaceEvent !== null) return readRecallState(surfaceEvent)
  let last
  try {
    for (const event of session?.snapshotEvents?.() ?? []) {
      if (event?.type === 'user/message' && event?.data?.source?.kind === sourceKind) last = event
    }
  } catch {
    // 日志读失败按「没有历史」处理：宁可本轮不预取，也不能让 pre-step 抛出去。
    return { ids: [], round: NO_ROUND }
  }
  return readRecallState(last)
}

/**
 * 两个 id 集合是否完全一致（顺序无关）。
 *
 * 「完全一致 → 不重写」是压住 prompt cache 抖动的第一道闸：同一轮输入检索出同一批
 * 条目时，快照一个字都不该动。
 *
 * @param {string[]} a - 集合 A。
 * @param {string[]} b - 集合 B。
 * @returns {boolean} 是否一致。
 */
export function sameIdSet(a, b) {
  const left = new Set(Array.isArray(a) ? a : [])
  const right = new Set(Array.isArray(b) ? b : [])
  if (left.size !== right.size) return false
  for (const item of left) {
    if (!right.has(item)) return false
  }
  return true
}

/**
 * 决定本轮的预取状态（变化阈值 + 冷却）。
 *
 * - 本轮候选为**空**且上轮有内容 → 保持上轮，**不清空**（见下方「为什么」）。
 * - 命中集合与上轮**完全一致** → 不换血（快照里预取小节一个字都不动）。
 * - 集合变了但距上次换血 `< minRounds` 轮 → 沿用上一轮的集合，本轮不换。
 * - 其余情况（首轮、上轮没记录、间隔够了）→ 采纳本轮命中，并把轮数记成新值。
 *
 * **为什么本轮无候选时不许清空**：预取是「按本轮发言从冷层临时捞几条」。可发言有长有短，
 * 短句（「好」「继续」）常常检索不出任何冷层候选。若这时就把上轮结果清空，下一轮又命中，
 * 于是「本轮相关记忆」整段在有→无→有之间翻转。真实会话里实测到 4/5 次重写都是这个翻转，
 * 而它对模型的伤害比缓存更重：**同一批记忆在上下文里时有时无**，模型无法判断该不该依赖它。
 *
 * 保持上轮的语义是「还没到换血时机，就先沿用上一批」。冷却窗口（默认 3 轮）本来就是
 * 「这批内容先稳定几轮」，无候选不该成为提前换血的捷径。
 *
 * `minRounds` 为 0 时每轮都可换；为负数按 0 处理。
 *
 * @param {object} input - 输入。
 * @param {string[]} [input.current] - 本轮候选 id。
 * @param {{ ids: string[], round: number }} [input.prev] - 上轮状态。
 * @param {number} input.round - 本轮轮数。
 * @param {number} [input.minRounds] - 换血最小间隔轮数。
 * @returns {{ swap: boolean, ids: string[], round: number, dropped: string[], held?: boolean }}
 *   `swap` 是否换血；`dropped` 是本轮命中但被冷却挡掉的 id（记日志用）；
 *   `held` 为真表示「本轮无候选，沿用了上轮结果」（供可观测性区分于「一致没变」）。
 */
export function decideRecallSwap(input = {}) {
  const current = Array.isArray(input.current) ? input.current : []
  const prevIds = Array.isArray(input.prev?.ids) ? input.prev.ids : []
  const prevRound = Number.isFinite(input.prev?.round) ? Math.floor(input.prev.round) : NO_ROUND
  const round = Number.isFinite(input.round) ? Math.floor(input.round) : 0
  const minRounds = Number.isFinite(input.minRounds) ? Math.max(0, Math.floor(input.minRounds)) : 0

  // 本轮一个候选都没有、但上轮有内容：沿用上轮，不把已注入的记忆清掉。
  if (current.length === 0 && prevIds.length > 0) {
    return { swap: false, ids: prevIds, round: prevRound, dropped: [], held: true }
  }
  if (sameIdSet(current, prevIds)) {
    // 一致：沿用旧状态的轮数，避免「没换血也把 round 推进」把下次冷却拉长。
    return { swap: false, ids: prevIds, round: prevRound, dropped: [] }
  }
  const waited = prevRound === NO_ROUND ? Infinity : round - prevRound
  if (prevRound !== NO_ROUND && waited < minRounds) {
    return { swap: false, ids: prevIds, round: prevRound, dropped: current.filter((id) => !prevIds.includes(id)) }
  }
  return { swap: true, ids: current, round, dropped: [] }
}

/**
 * 从 `buildProjectSection` 的 `overflow` 里取出溢出条目 id 集合。
 *
 * 契约只写了「溢出条目进 overflow」，没定元素形态，所以条目对象与裸 id 字符串都认。
 * 认不出来的一律忽略——它只影响「哪些 core 条目算额外候选」，判不出来时少预取几条，
 * 不会预取错。
 *
 * @param {unknown} overflow - 渲染层返回的 overflow 字段。
 * @returns {Set<string>} 溢出条目 id 集合。
 */
export function overflowIdSet(overflow) {
  const ids = new Set()
  for (const item of Array.isArray(overflow) ? overflow : []) {
    const id = typeof item === 'string' ? item : typeof item?.id === 'string' ? item.id : ''
    if (id !== '') ids.add(id)
  }
  return ids
}

/**
 * 把几篇文档的全部条目摊平成一个数组（沿用上一轮预取时按 id 回填正文用）。
 *
 * @param {Array<{ name?: string, text?: string }>} docs - 文档源。
 * @returns {Array<{ id: string, tier: string, topic: string, body: string, time: string, file: string }>} 条目。
 */
export function collectEntries(docs) {
  const out = []
  for (const doc of Array.isArray(docs) ? docs : []) {
    const text = typeof doc?.text === 'string' ? doc.text : ''
    if (text === '') continue
    for (const entry of entryLocator(text).entries) {
      out.push({ ...entry, file: typeof doc.name === 'string' ? doc.name : '' })
    }
  }
  return out
}

/**
 * 按 ids 的顺序取条目正文，拼成渲染层的预取数组。
 *
 * 字段名必须对齐渲染层的 `normalizeRecallItem`：它读的是 **`body`**（不是 `text`），
 * 传错名的后果不是报错而是**静默丢弃每一条**——小节永远不出现，测试之外没人看得见。
 * `source` 故意留空：渲染层会填成 `recall`，比沿用条目原来的 `source` 诚实。
 *
 * **每一条都过 `escapeFrame`**（模块头第 3 条）：这些文本来自磁盘上的记忆文件，
 * 主人手改一个字就能塞进 `</supermemory>`，必须当外部输入处理。渲染层也会转一遍，
 * 但那个转义是幂等的（只把 `</name` 换成 `<\name`），所以两侧都做而不互相打架。
 * 找不到 id 对应的条目就跳过——条目可能刚被整编掉，宁可少一条也不能拼出半条。
 *
 * @param {Array<{ id?: string, topic?: string, body?: string, text?: string, time?: string }>} entries - 候选池。
 * @param {string[]} ids - 要注入的条目 id（顺序即注入顺序）。
 * @returns {Array<{ id: string, topic: string, tier: string, body: string, time: string, score: number }>} 预取数组。
 */
export function pickRecallItems(entries, ids) {
  const byId = new Map()
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (typeof entry?.id === 'string' && entry.id !== '' && !byId.has(entry.id)) byId.set(entry.id, entry)
  }
  const items = []
  for (const id of Array.isArray(ids) ? ids : []) {
    const entry = byId.get(id)
    if (entry === undefined) continue
    const raw = typeof entry.body === 'string' && entry.body !== ''
      ? entry.body
      : (typeof entry.text === 'string' ? entry.text : '')
    const body = escapeFrame(raw === '' ? (typeof entry.topic === 'string' ? entry.topic : '') : raw)
    if (body === '') continue
    items.push({
      id,
      topic: typeof entry.topic === 'string' ? entry.topic : '',
      tier: typeof entry.tier === 'string' ? entry.tier : 'core',
      body,
      time: typeof entry.time === 'string' ? entry.time : '',
      score: Number.isFinite(entry.score) ? entry.score : 0,
    })
  }
  return items
}

/**
 * 从注入的条目里取热度记录点（契约 §V8.10：topic 是主键，条目 id 只作辅助）。
 *
 * @param {Array<{ topic?: string, id?: string }>} items - 本轮真正进上下文的条目。
 * @returns {{ topics: string[], entries: string[] }} 待累加的键。
 */
export function usageKeysFromItems(items) {
  const topics = []
  const entries = []
  for (const item of Array.isArray(items) ? items : []) {
    if (typeof item?.topic === 'string' && item.topic !== '' && !topics.includes(item.topic)) topics.push(item.topic)
    if (typeof item?.id === 'string' && item.id !== '') entries.push(item.id)
  }
  return { topics, entries }
}
