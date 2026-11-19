/**
 * dsh-supermemory —— 宿主注入（系统提示人格 section + 记忆快照消息）。
 *
 * 设计要点（见 docs/CONTRACT.md §5.1）：
 *   - `systemPrompt.section` 的 `text(assembly)` 入参在**运行时带 `agent`**，
 *     子智能体门控就靠它（类型声明里 `AssembleContext` 只写了 `scope`/`signal`，
 *     信息滞后，别据此断定拿不到 agent）。v10 起人格正文**按传入的 agent 现算**
 *     （见 resolvePersonaOf）：绝不能再读模块级缓存，否则会慢一轮并跨会话串台。
 *   - 快照消息**首次**落库走宿主的 `decision.messages` 通道（见下方 V7.2 注释），
 *     后续更新才用 `surfaceOp: replace`。两条写入口同用必然重复，所以首次绝不
 *     自己 `session.append`。
 *   - v8（契约 §V8.1.1）：人格与画像**只**经 `systemPrompt.section` 出口，pre-step
 *     不再读 soul / user。二者此前同时存在于 section 与快照里，每轮白烧约 5 KB。
 *     于是快照只剩 `global` / `project` 两段，`source.sections` 与
 *     `source.byteSections` 同步成两键。
 *   - 任何异常都必须 catch + `logger.warn` + `return decision`，绝不破坏 step。
 *   - 插件总开关 `deps.isEnabled` 关闭时：人格 section 返回空串，pre-step 不再更新快照，
 *     会话里已有的旧快照原样保留（不替换、不清理）。
 *   - 上下文压缩会用一条 checkpoint 替换掉整段 surface 区间，本插件快照可能被整段
 *     吞掉。因此每轮 pre-step 都按日志里的压缩事件做「重同步」判定：快照已不在
 *     surface 上、或最近一次压缩晚于快照时，**即使 digest 相同也重写**（由
 *     `compactionRecall` 控制，默认开启）。补偿只重写既有快照，正文与 digest
 *     逐字节不变，不往记忆里掺压缩提示。
 *
 * 不 import 任何 `@deepseek-ai/*` 宿主包：全部能力经 `ctx.get()` 可选获取。
 *
 * @module dsh-supermemory/host/inject
 */

import { randomUUID } from 'node:crypto'

import { buildExpertDirectory } from '../core/experts.js'
import { buildPersonaSection, buildSnapshot, escapeFrame } from '../core/render.js'
// 分层渲染按 400 行上限拆在两个模块里（A 的接线说明），公开面仍算 render 那一族。
import { buildProjectSection } from '../core/render-tiered.js'
import { buildTieredSnapshot } from '../core/snapshot-tiered.js'
import { queryTerms } from '../core/search.js'
import { createProjectDocReader, searchProjectEntries } from './tools-search.js'
import {
  MAX_LOOKBACK,
  collectEntries,
  decideRecallSwap,
  overflowIdSet,
  pickRecallItems,
  readRecallState,
  sameIdSet,
  usageKeysFromItems,
  userQueryFromPayload,
} from './inject-recall.js'
import { getSharedUsageStore } from './usage.js'

/** 快照消息固定的首行提示，模型据此知道这不是用户发言。 */
export const SNAPSHOT_NOTICE = '本消息由 dsh-supermemory 插件自动维护的记忆快照，不是用户发言。'
/** 记忆全部清空后占位快照的正文。 */
export const EMPTY_SNAPSHOT_TEXT = '（当前没有已保存的记忆内容。）'

/** 占位快照的固定 digest，保证清空后不会每轮重复 replace。 */
export const EMPTY_DIGEST = 'empty'

/** 占位快照的 `byteSections`：v8 起快照只有 `global` / `project` 两段（契约 §V8.1.1）。 */
export const EMPTY_BYTE_SECTIONS = Object.freeze({ global: 0, project: 0 })

/** 本插件消息的 source.kind，用于在会话日志里识别自己。 */
export const SOURCE_KIND = 'dsh-supermemory'

/**
 * 快照的分区，固定顺序。
 *
 * v8 起 soul / user 不在此列：它们的唯一出口是 `systemPrompt.section`
 * （契约 §V8.1.1）。面板按 `source.sections` 渲染的分支只有这两个键。
 */
const SNAPSHOT_SCOPES = ['global', 'project']

/**
 * 去掉 HTML 注释（含跨行注释）。
 * @param {string} text - 原始文档文本。
 * @returns {string} 去掉注释后的文本。
 */
function stripComments(text) {
  return text.replace(/<!--[\s\S]*?-->/gu, '')
}

/**
 * 把一份记忆文档收敛成「正文」：
 * 去掉一级标题、模板里的 `## 条目` 小节标题与 HTML 注释。
 *
 * 这样传给渲染层的永远是可注入的正文，空文档（只有模板骨架）会得到空串，
 * 从而让 `buildSnapshot` 把它当作「该段为空」省略掉。
 *
 * @param {unknown} text - `store.readDoc` 返回的 content。
 * @returns {string} 正文（已 trim）；无正文返回空串。
 */
export function docBody(text) {
  if (typeof text !== 'string' || text === '') return ''
  const lines = stripComments(text).split('\n')
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
 * 构造 `source.sections`：只放非空段，供宿主/UI 展示快照由哪些段组成。
 *
 * 每段文本与模型实际看到的一致：走 `escapeFrame` 转义闭合标签，
 * 避免 `source.sections` 里出现能被误解析为包裹结束的原文。
 *
 * **数据来源必须是渲染层裁剪之后的正文**（契约 §V15.1）：
 *   - 首选 `snapshot.rendered`（`buildTieredSnapshot` 返回的 `{ global, project }`，
 *     是降级链跑完后真正进入 `snapshot.text` 的那两段）；
 *   - 取不到时退回 `bodies`（原始 `docBody` 产物）。**这是兼容退路，不是首选**：
 *     服务老渲染层实现、`tieredInjection: false` 的 v7 回滚路径（那里 `buildSnapshot`
 *     根本没有 `rendered`），以及手工构造 snapshot 的测试替身。
 *     退回 `bodies` 会让存档大于实际注入（预算紧张时最明显），但**不能因此报错**——
 *     一个观测字段的精度不该让整轮注入失败。
 *
 * 转义放在这里统一做：`rendered` 与 `bodies` 两条路径都要转义一次，写在两处必然漂移。
 *
 * @param {Record<string, string>} bodies - 快照各段的原始正文（`global` / `project`）。
 * @param {{ global?: string, project?: string }} [rendered] - 裁剪后实际注入的正文。
 * @returns {Array<{ name: string, text: string }>}
 */
function buildSectionList(bodies, rendered) {
  const list = []
  for (const name of SNAPSHOT_SCOPES) {
    const exact = rendered?.[name]
    const text = typeof exact === 'string' ? exact : bodies?.[name]
    if (typeof text === 'string' && text !== '') {
      list.push({ name, text: escapeFrame(text) })
    }
  }
  return list
}

/**
 * 把渲染层给出的各段字节收口成快照的字节表。
 *
 * 两件事：
 *   - `soul` / `user` 一律剔除。`buildSnapshot` 出于「旧签名旧行为不变」的契约
 *     （§V8.4）仍返回含这两个键的四键表，而 pre-step 根本不读它们了（§V8.1.1），
 *     留着两个 0 键会让面板多出两段不存在的空段。
 *   - 其余数字键原样透传。分层路径的 `core` / `index` / `recall` 字节要靠它带到面板
 *     （§V8.11），写死成两键就把可观测一起砍掉了。
 *
 * @param {object} [sections] - 渲染层返回的各段字节数。
 * @returns {Record<string, number>} 收口后的字节表。
 */
function pickSnapshotBytes(sections) {
  const out = {}
  for (const name of SNAPSHOT_SCOPES) {
    const value = sections?.[name]
    out[name] = Number.isFinite(value) ? value : 0
  }
  for (const [name, value] of Object.entries(sections ?? {})) {
    if (name === 'soul' || name === 'user') continue
    if (Number.isFinite(value)) out[name] = value
  }
  return out
}

/**
 * 构造「记忆已清空」的占位快照消息。
 *
 * 用户清空全部记忆后不能继续注入旧快照（模型会看到已删除的内容），
 * 但 `user/message` 的 content 为空数组会让 `deriveEventMessage` 返回 null，
 * 在 surface 上留下空洞。因此用一条固定 digest 的极短占位替换旧快照：
 * surface 恒为 1 条，digest 固定为 `'empty'` 保证不会每轮重复 replace。
 *
 * @returns {object} 可直接交给 `session.append('user/message', ...)` 的消息。
 */
export function buildEmptySnapshotMessage() {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: `${SNAPSHOT_NOTICE}\n\n${EMPTY_SNAPSHOT_TEXT}` }],
    source: {
      kind: SOURCE_KIND,
      form: 'snapshot',
      digest: EMPTY_DIGEST,
      truncated: false,
      sections: [],
      byteSections: { ...EMPTY_BYTE_SECTIONS },
    },
  }
}

/**
 * 比对两轮的五维短指纹，回答「这次重写到底是哪个维度变了」（契约 §V12.2）。
 *
 * 为什么需要它：`digest` 只能回答「变了」，而快照重写会让它之后约一半的上下文
 * 前缀缓存失效。没有归因时，唯一能做的就是猜是「整理改写了正文」还是「预算在边缘
 * 抖动」——两者对应的修法完全相反。实测数据里 14 轮重写 13 次而整理只有 6 次，
 * 这个落差正是靠这套归因才能定位。
 *
 * `needsResync` 是独立的一维：它不改变内容（正文与 digest 逐字节不变），只因为
 * 快照被压缩吞掉了才重写。混进五维比较里会让归因报出「什么都没变」，读的人以为
 * 抓到了 bug。
 *
 * @param {{ parts?: object, digest?: string }|undefined} prevSnapshot - 上一条快照的元数据。
 * @param {{ parts?: object, digest?: string }|undefined} nextSnapshot - 本轮快照的元数据。
 * @param {boolean} [needsResync] - 本轮是否因压缩吞掉快照而强制重同步。
 * @returns {{ reason: string, changed: string[] }} 归因结果。
 *   `reason` 取值：`first`（首次写入）、`resync`（压缩补偿）、`content`（内容维度变化）、
 *   `unknown`（无五维数据可比，升级前的旧快照会落到这里）。
 */
export function attributeRewrite(prevSnapshot, nextSnapshot, needsResync = false) {
  if (prevSnapshot === undefined || prevSnapshot === null) return { reason: 'first', changed: [] }
  if (needsResync === true) return { reason: 'resync', changed: [] }
  const before = prevSnapshot.parts
  const after = nextSnapshot?.parts
  if (before === null || typeof before !== 'object' || after === null || typeof after !== 'object') {
    return { reason: 'unknown', changed: [] }
  }
  const changed = []
  for (const key of ['global', 'project', 'projectName', 'truncated', 'recall']) {
    if (!sameDimensionValue(before[key], after[key])) changed.push(key)
  }
  return { reason: changed.length === 0 ? 'unknown' : 'content', changed }
}

/**
 * 逐维比较两轮快照的同名指纹值。
 *
 * 为什么不直接 `!==`：`recall` 维度来自日志里上一条快照的 `parts`，两条路径产出它的
 * 形状必须一致（见 buildSnapshotMessage），但历史数据里可能出现老版本落盘的
 * `recall: { ids, round }` **对象**（V8.9 最初的形态，每轮都是新对象，引用比较恒不等，
 * 会让「两轮都有预取就恒报 recall 变化」）。这里对 `recall` 维度按值比较——字符串短
 * 指纹直接比，老形态对象按 ids 集合语义（sameIdSet，顺序无关）比。其余四维都是
 * 字符串，直比。
 *
 * @param {unknown} before - 上一轮该维度的值。
 * @param {unknown} after - 本轮该维度的值。
 * @returns {boolean} 视为「没有变化」时返回 true。
 */
function sameDimensionValue(before, after) {
  if (before === after) return true
  // 只有 recall 维度可能以对象形态出现在历史数据里；两个对象之间按集合比较。
  if (before !== null && after !== null && typeof before === 'object' && typeof after === 'object') {
    return sameIdSet(before.ids, after.ids)
  }
  return false
}

/**
 * 是否应当**延后**这次快照重写（契约 §V12.4）。
 *
 * 只有「预取集合变、正文一个字没变」时延后。实测 6 个真实会话 18 次 replace 里 5 次
 * 属于这一类，而快照正文是这条链路上最长最稳定的部分——为换 2 KB 预取小节重写整块，
 * 会让快照之后约一半上下文的缓存全部失效。
 *
 * 前提是**旧快照已经有预取内容**：旧内容仍在生效（预取本身有轮冷却，语义就是「这批先
 * 稳定几轮」）。旧快照没有预取而本轮有时必须写，否则预取永远出不来。
 *
 * 抽成纯函数是为了能直接测——这段判定原本埋在 pre-step 闭包里，只能靠读真实日志反推。
 *
 * @param {{ reason?: string, changed?: string[] }} rewrite - `attributeRewrite` 的结果。
 * @param {{ recall?: unknown }|undefined} prevSource - 上一条快照的 `source`。
 * @returns {boolean} 是否延后。
 */
export function shouldDeferRewrite(rewrite, prevSource) {
  if (rewrite === undefined || rewrite === null) return false
  if (rewrite.reason !== 'content') return false
  if (!Array.isArray(rewrite.changed) || rewrite.changed.length !== 1) return false
  if (rewrite.changed[0] !== 'recall') return false
  return prevSource !== undefined && prevSource !== null && prevSource.recall !== undefined
}

/**
 * 构造快照 user 消息（手写普通对象，不 import 宿主 createUserMessage）。
 *
 * `recall` 是 v8 动态预取的自我描述（契约 §V8.9）：`{ ids, round }`。它挂在快照
 * 自己的 `source` 上，为的是「变化阈值 + 冷却」不需要任何外部状态——下一轮直接从
 * 日志里上一条快照读出上轮的命中集合与轮数。缺省时不落这个键，升级前的旧快照同样
 * 按「没有预取」处理。
 *
 * `rewrite` 是 v12 的重写归因（契约 §V12.2）：`{ reason, changed }`。它只观测不决策，
 * 落盘是为了让「为什么这条快照又被重写了」能在事后从会话日志里读出来。
 *
 * @param {{ text: string, digest: string, truncated: boolean, sections?: object, parts?: object }} snapshot
 * @param {Array<{ name: string, text: string }>} sections - 非空段列表。
 * @param {{ ids: string[], round: number }} [recall] - 本轮预取命中与轮数。
 * @param {{ reason: string, changed: string[] }} [rewrite] - 重写归因。
 * @returns {object} 可直接交给 `session.append('user/message', ...)` 的消息。
 */
export function buildSnapshotMessage(snapshot, sections, recall, rewrite) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: `${SNAPSHOT_NOTICE}\n\n${snapshot.text}` }],
    source: {
      kind: SOURCE_KIND,
      form: 'snapshot',
      digest: snapshot.digest,
      truncated: snapshot.truncated === true,
      sections,
      byteSections: snapshot.sections ?? {},
      // parts 是五维短指纹，供下一轮做归因比对；旧快照没有它时归因落到 unknown。
      ...(snapshot.parts === undefined || snapshot.parts === null ? {} : { parts: snapshot.parts }),
      ...(recall === undefined || recall === null ? {} : { recall }),
      ...(rewrite === undefined || rewrite === null ? {} : { rewrite }),
    },
  }
}

/**
 * 宿主的 system prompt 是否已经落到会话日志里。
 *
 * v4 日志有条硬不变量（`dsh-session-format-v3-to-v4` 的 `foldSurface`）：**surface
 * 的第一条记录必须是 `system/message`**，它被登记为「受保护头部」，其后的 replace
 * 永远不许遮蔽它。而宿主写 system/message 的时机在 step **内部**，本模块挂在
 * `agent/pre-step`，天然更早——两边实测相差约 5 毫秒，谁先落地取决于异步快慢。
 * 快照一旦抢跑，protected head 就永久建不起来，该会话此后**每次加载都报**
 * `system/message requires a protected first surface head`，无法自愈：40 个真实
 * 会话中招 16 个，纯竞态，不是必现。
 *
 * 判据必须看 append-only 的 `snapshotEvents()`，不能看 `surface.nodes`：压缩会把
 * 整段区间从 surface 上抹掉，用它会在压缩之后把注入永久卡死。system/message 写过
 * 就是写过，门控放行过一次就该一直放行。
 *
 * @param {object} session - 宿主 Session。
 * @returns {boolean} 写过 system/message 为 true；读不到日志一律 false——少注入
 *   一轮下个 step 会自动补上，写坏会话不可逆，所以这里必须偏保守。
 */
export function hasSystemHead(session) {
  try {
    if (session === undefined || session === null) return false
    if (typeof session.snapshotEvents !== 'function') return false
    for (const event of session.snapshotEvents()) {
      if (event?.type === 'system/message') return true
    }
  } catch {
    /* 读日志失败按「头部未就绪」处理 */
  }
  return false
}

/**
 * 从会话日志里汇总压缩状态。
 *
 * 宿主压缩的确切形态（`dsh-compaction-basic`）：一次成功压缩连写三条事件——
 *   1. `compaction/start`（非 surface 事件）
 *   2. `compaction/summary`（非 surface 事件，携带 `shadowedRange` / `shadowedSeqs`）
 *   3. 一条 `user/message` checkpoint（`source.kind === 'compact-checkpoint'`），
 *      用 `surfaceOp: replace` 把 `[start, end]` 整段 surface 区间替换掉
 * 所以被吞掉的节点**从 `surface.nodes` 里彻底消失**，但事件仍留在 append-only
 * 日志中——判「存活」必须看 surface，判「发生过压缩」必须看日志，缺一不可。
 * `compaction/prune`（tool-result-pruner）同样携带 `shadowedSeqs`，只作用于
 * `tool/result`，一并计入遮蔽集无害且更保守。
 *
 * @param {object} session - 宿主 Session。
 * @returns {{ seq: number, shadowed: Set<number> }} `seq` 是最后一条
 *   `compaction/summary` 的事件 seq（从未压缩过为 -1）；`shadowed` 是历史上
 *   所有压缩/裁剪事件遮蔽过的 seq 并集。任何异常都降级为空状态。
 */
export function compactionState(session) {
  const state = { seq: -1, shadowed: new Set() }
  try {
    if (session === undefined || session === null) return state
    if (typeof session.snapshotEvents !== 'function') return state
    for (const event of session.snapshotEvents()) {
      const type = typeof event?.type === 'string' ? event.type : ''
      if (!type.startsWith('compaction/')) continue
      const seqs = event.data?.shadowedSeqs
      if (Array.isArray(seqs)) {
        for (const seq of seqs) {
          if (Number.isSafeInteger(seq) && seq >= 0) state.shadowed.add(seq)
        }
      }
      // 只有 summary 代表一次真正完成的压缩，用作「压缩是否晚于快照」的基准。
      if (type === 'compaction/summary' && Number.isSafeInteger(event.seq)) state.seq = event.seq
    }
  } catch {
    /* 日志读取失败按「没有压缩过」处理，退回原有行为 */
  }
  return state
}

/**
 * 在会话日志里找「当前 surface 上」最后一条本插件快照事件。
 *
 * 注意：`snapshotEvents()` 返回的是 append-only 日志，被 `replace` 掉的旧事件
 * 仍在日志里。因此优先按 `session.surface.nodes`（当前 surface 的 seq 集合）
 * 过滤；拿不到 surface 时退回日志顺序（replace 一定在旧事件之后追加，
 * 所以取最后一条同样正确）。
 *
 * @param {object} session - 宿主 Session。
 * @returns {{ seq: number, data: object } | undefined} 最后一条（含 seq）。
 */
export function lastSnapshotEvent(session, shadowed) {
  if (session === undefined || session === null) return undefined
  if (typeof session.snapshotEvents !== 'function') return undefined
  const surface = session.surface?.nodes
  const canCheckSurface =
    surface !== undefined &&
    surface !== null &&
    (typeof surface.has === 'function' || Array.isArray(surface))
  const inSurface = (seq) => {
    if (canCheckSurface) {
      if (typeof surface.has === 'function') return surface.has(seq)
      return surface.includes(seq)
    }
    // surface 不可用：改用压缩遮蔽集排除，绝不把已被摘要吞掉的旧事件当作存活。
    // 不收紧的话，被压缩吞掉的快照会被当作仍存在，其 digest 又与本轮一致，
    // 于是命中「内容未变不重复写入」，造成记忆**永久**失忆。
    if (shadowed instanceof Set && shadowed.size > 0) return !shadowed.has(seq)
    return true
  }
  let found
  for (const event of session.snapshotEvents()) {
    if (event?.type !== 'user/message') continue
    if (event.data?.source?.kind !== SOURCE_KIND) continue
    if (!inSurface(event.seq)) continue
    found = event
  }
  return found
}

/**
 * **一次**遍历会话日志，收齐 pre-step 需要的全部日志侧信息（§V8.9 / §V8.15 裁决 4 的
 * 判据全部保留，只是不再各自扫一遍）。
 *
 * 优化动机：pre-step 每轮要问日志 5 个问题——压缩状态、上一条快照（带 surface 过滤）、
 * 真实轮数、本轮用户输入、上一轮预取状态。各自独立实现时是 5 次全量遍历 + 一次尾部
 * 回溯；会话越长这轮开销越大，而 5 个判据看的都是同一份 append-only 日志。这里按
 * 「最后一瞥」收口：一个循环里同时维护 5 个状态。
 *
 * 判据与独立版**完全一致**（逐条对着原实现核对过）：
 *   - 轮数只数 `user/message` 且 `source.kind === 'user'`；
 *   - 本轮用户输入按 `latestUserQuery` 的同款规则：尾部回溯上限 `MAX_LOOKBACK`、
 *     跳过宿主注入事件、遇到 `assistant/message`（轮边界）才停——正向扫描时等价实现是
 *     「记住最后一条真实发言，一旦之后出现 assistant/message 就作废」。
 *     **这是降级来源**：pre-step 时刻本轮 user/message 还没落盘，正常路径的输入来自
 *     `payload.messages`（见 `userQueryFromPayload`）；
 *   - 上一条快照按 surface / shadowed 过滤，退路逻辑与 `lastSnapshotEvent` 相同；
 *   - 上一轮预取状态不按 surface 过滤（退到 append-only 日志，`previousRecallState` 的
 *     语义）；
 *   - 压缩状态照 `compactionState`：`compaction/summary` 的 seq 与所有 `compaction/*`
 *     的 shadowedSeqs 并集。
 *
 * 任何异常都返回全空状态，调用方按「无历史」处理——绝不抛。
 *
 * @param {object} session - 宿主 Session。
 * @param {boolean} [collectCompaction] - 是否收压缩状态（`compactionRecall` 关闭时免算）。
 * @returns {{
 *   compaction: { seq: number, shadowed: Set<number> },
 *   snapshotEvent: { seq: number, data: object } | undefined,
 *   loggedSnapshotEvent: { seq: number, data: object } | undefined,
 *   userTurns: number,
 *   userQuery: string | null,
 * }}
 */
export function scanSessionLog(session, collectCompaction = true) {
  const result = {
    compaction: { seq: -1, shadowed: new Set() },
    snapshotEvent: undefined,
    loggedSnapshotEvent: undefined,
    userTurns: 0,
    userQuery: null,
  }
  try {
    if (session === undefined || session === null) return result
    if (typeof session.snapshotEvents !== 'function') return result
    const surface = session.surface?.nodes
    const canCheckSurface =
      surface !== undefined &&
      surface !== null &&
      (typeof surface.has === 'function' || Array.isArray(surface))
    const shadowed = result.compaction.shadowed
    const inSurface = (seq) => {
      if (canCheckSurface) {
        return typeof surface.has === 'function' ? surface.has(seq) : surface.includes(seq)
      }
      if (collectCompaction && shadowed.size > 0) return !shadowed.has(seq)
      return true
    }
    let events = session.snapshotEvents()
    events = Array.isArray(events) ? events : [...events]
    if (collectCompaction) {
      // 压缩状态必须**先**收齐：被摘要吞掉的快照 seq 一定早于压缩事件本身，若边扫边收，
      // 主循环走到那条快照时遮蔽集还不完整，会把已消失的快照误判成存活——独立版
      // compactionState 是先算完整集合再喂给 lastSnapshotEvent 的，这里保持同一时序。
      for (const event of events) {
        const type = typeof event?.type === 'string' ? event.type : ''
        if (!type.startsWith('compaction/')) continue
        const seqs = event.data?.shadowedSeqs
        if (Array.isArray(seqs)) {
          for (const seq of seqs) {
            if (Number.isSafeInteger(seq) && seq >= 0) result.compaction.shadowed.add(seq)
          }
        }
        if (type === 'compaction/summary' && Number.isSafeInteger(event.seq)) {
          result.compaction.seq = event.seq
        }
      }
    }
    // 本轮用户输入要按日志**尾部**回溯：正向扫描时等价于「记最后一条真实发言，
    // 但它之后一旦出现 assistant/message（轮边界）就作废」。这个变量就是那条发言。
    let lastUserMessage = null
    let sawAssistantAfterUser = false
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index]
      const type = typeof event?.type === 'string' ? event.type : ''
      const source = event?.data?.source
      const kind = typeof source?.kind === 'string' ? source.kind : ''

      if (type === 'user/message') {
        if (kind === SOURCE_KIND) {
          // 预取状态退到 append-only 日志（不按 surface 过滤）；surface 那条单独记。
          result.loggedSnapshotEvent = event
          if (inSurface(event.seq)) result.snapshotEvent = event
          continue
        }
        if (kind === 'user') {
          result.userTurns += 1
          const content = Array.isArray(event.data?.content) ? event.data.content : []
          const text = content
            .filter((part) => part?.type === 'text' && typeof part.text === 'string')
            .map((part) => part.text)
            .join('\n')
            .trim()
          lastUserMessage = text === '' ? null : { text, index }
          sawAssistantAfterUser = false
        }
        continue
      }

      if (type === 'assistant/message' && lastUserMessage !== null) {
        // 轮边界：最后一条真实发言之后助手已经回过话——那句话属于上一轮。
        sawAssistantAfterUser = true
      }
    }
    if (lastUserMessage !== null && !sawAssistantAfterUser) {
      // 回溯深度上限：真实发言离日志尾部太远（中间塞了大量宿主注入事件）就放弃，
      // 与 latestUserQuery 的 MAX_LOOKBACK 同口径，防畸形日志退化成全量扫描。
      if (events.length - 1 - lastUserMessage.index < MAX_LOOKBACK) {
        result.userQuery = lastUserMessage.text
      }
    }
  } catch {
    return result
  }
  return result
}

/**
 * 安装人格 section 与记忆快照注入。
 *
 * @param {object} ctx - cordis Context。
 * @param {object} deps - 由 lib/index.js 注入。
 * @param {object} deps.store - 存储层（readDoc / readDocSync）。
 * @param {() => object} deps.getConfig - 每次都取最新 ResolvedConfig。
 * @param {(agent: object) => Promise<object|undefined>} deps.loadScope - 解析并记录活动 scope。
 * @param {(agent: object) => boolean} deps.isSubagent - 是否子智能体。
 * @param {() => boolean} [deps.isEnabled] - 插件总开关；返回 false 时注入停止，缺失视为「开启」。
 * @param {{ warn: Function, info?: Function }} deps.logger - 宿主日志。
 * @returns {() => void} dispose。
 */
export function installInjection(ctx, deps) {
  const disposers = []
  /**
   * 最近一次解析出的活动 scope。
   *
   * **v10 起不再作为人格来源**：人格一律由 `resolvePersonaOf(assembly.agent)` 现算。
   * 这里只剩两个用途：快照侧的既有判定、以及 bootstrap 展示的活动上下文。
   */
  let activeScope = null

  /**
   * 热度存储（契约 §V8.10）。默认取进程内共享实例：`memory search` 命中（tools.js）
   * 与预取命中（本模块）是两个记录点，各持一份内存统计会互相覆盖同一个 usage.json。
   */
  const usage = deps.usage ?? getSharedUsageStore({ docPathRef: deps.store?.docPath, logger: deps.logger })

  /** 项目记忆全部 md 的读取器，与 memory search 同一实现（两条链路看到的文件必须一致）。 */
  const readProjectDocsOf = createProjectDocReader({ store: deps.store, logger: deps.logger })

  const dispose = () => {
    activeScope = null
    // 关停时把攒在内存里的热度落一次盘（§V8.15 裁决 5 的两个触发点之一）。
    // dispose 必须保持同步且不抛，所以这里 fire-and-forget，落盘失败也只由 usage 自己 warn。
    try {
      void Promise.resolve(usage?.dispose?.()).catch(() => {})
    } catch {
      /* 热度是优化项，不能拖累卸载 */
    }
    for (const disposer of disposers.splice(0)) {
      try {
        disposer()
      } catch {
        /* 卸载期的清理失败不影响其它 */
      }
    }
  }

  /** 记录一个 disposer；注册失败只告警。 */
  const remember = (label, factory) => {
    try {
      const disposer = factory()
      if (typeof disposer === 'function') disposers.push(disposer)
    } catch (error) {
      deps.logger?.warn?.('supermemory: %s registration failed: %o', label, error)
    }
  }

  /** 同步读一份文档正文；任何异常都降级为空串。 */
  const readBodySync = (ref) => {
    try {
      return docBody(deps.store?.readDocSync?.(ref)?.content)
    } catch (error) {
      deps.logger?.warn?.('supermemory: readDocSync failed: %o', error)
      return ''
    }
  }

  /**
   * 本次 assembly 的记忆注入档位（契约 §V13.2）：`'full'` 或 `'none'`。
   *
   * 人格 section 与 pre-step 快照**共用这一个判定**，绝不在两处各写一份条件——
   * 两处漂移过的后果是「人格注入了但快照没注入」这类半截状态，而且两边各修一次
   * 才能对齐。优先用装配层的 `deps.memoryInjection`（它知道主管/专家/普通子代理
   * 三种身份的完整判据，见 lib/index.js）。
   *
   * **必须保留的降级**：老测试与老装配层没有 `deps.memoryInjection`，此时退回 v3 起
   * 的既有判据（`injectIntoSubagents === false` 且是子代理 → 不注入）。删掉这条降级
   * 会让所有既有注入用例一起变红，而且真机上「装配层某次改动漏了这个键」会从
   * 「子代理少注入」直接变成「子代理全量注入」——方向反了，代价是 token。
   *
   * 任何异常都返回 `'full'`：宁可多注入一次，也不能因为判据自己炸了让主会话失忆。
   *
   * @param agent - 本次 assembly 的宿主 Agent。
   * @returns {'full'|'none'} 注入档位。
   */
  const memoryInjectionOf = (agent) => {
    try {
      if (typeof deps.memoryInjection === 'function') {
        const value = deps.memoryInjection(agent)
        if (value === 'none' || value === 'full') return value
      }
    } catch (error) {
      deps.logger?.warn?.('supermemory: memoryInjection failed, falling back to legacy gate: %o', error)
    }
    try {
      const config = deps.getConfig?.()
      if (config?.injectIntoSubagents === false && deps.isSubagent?.(agent) === true) return 'none'
    } catch (error) {
      deps.logger?.warn?.('supermemory: legacy injection gate failed: %o', error)
      return 'full'
    }
    return 'full'
  }

  /**
   * 按 agent 同步解析当前生效人设（v10，契约 §V10.1）。
   *
   * 优先用装配层注入的 `deps.resolvePersonaSync`（它知道会话绑定与全局 current 的
   * 优先级）；deps 缺失时退回一个只认全局的最小实现，保证「至少不是空人格」。
   * 任何异常都返回 undefined，由调用方渲染空 section——绝不让异常冒到宿主。
   *
   * @param agent - 本次 assembly 的宿主 Agent。
   * @returns {{ persona: string, personaSource: string }|undefined} 解析结果。
   */
  const resolvePersonaOf = (agent) => {
    try {
      if (typeof deps.resolvePersonaSync === 'function') {
        const resolved = deps.resolvePersonaSync(agent)
        if (resolved !== undefined && resolved !== null && typeof resolved.persona === 'string' && resolved.persona !== '') {
          return resolved
        }
      }
      // 降级：装配层没给同步解析器时，至少读全局 current（同步 API）。
      const current = deps.store?.currentPersona?.()
      const slug = typeof current?.slug === 'string' && current.slug !== '' ? current.slug : 'default'
      return { persona: slug, personaSource: 'global' }
    } catch (error) {
      deps.logger?.warn?.('supermemory: resolvePersonaSync failed: %o', error)
      return undefined
    }
  }

  /**
   * 异步读一份文档的**原始文本**（未过 `docBody`）。
   *
   * 分层渲染需要原文（主题围栏在 preamble 里，`docBody` 会连 HTML 注释一起剥掉），
   * 所以这里返回原文，由调用方按需 `docBody`。任何异常都降级为空串。
   */
  const readDocRaw = async (ref) => {
    try {
      const value = (await deps.store?.readDoc?.(ref))?.content
      return typeof value === 'string' ? value : ''
    } catch (error) {
      deps.logger?.warn?.('supermemory: readDoc failed: %o', error)
      return ''
    }
  }

  /** 退回 v7 渲染只 warn 一次（§V8.15 裁决 2：降级不吭声是最贵的一类事故）。 */
  let warnedFallback = false

  /** 分层渲染函数；不可用时返回 null，调用方逐字退回 v7。 */
  function tieredRenderer() {
    const candidate = deps.render?.buildTieredSnapshot ?? buildTieredSnapshot
    if (typeof candidate === 'function') return candidate
    if (!warnedFallback) {
      warnedFallback = true
      deps.logger?.warn?.(
        'supermemory: tieredInjection 已开启，但分层渲染不可用 —— 退回 v7 渲染路径，'
        + '快照不含主题目录与本轮预取',
      )
    }
    return null
  }

  /** `buildProjectSection`，只为拿它的 `overflow`（§V8.15 裁决 3 的候选判据要用）。 */
  function projectSectionBuilder() {
    const candidate = deps.render?.buildProjectSection ?? buildProjectSection
    return typeof candidate === 'function' ? candidate : null
  }

  /**
   * 组装本轮快照：v7 平铺路径与 v8 分层路径（含动态预取）都从这里出口。
   *
   * 两条路径的产物都是 `buildSnapshot` 那一族形状（`{ text, digest, truncated, sections }`），
   * 所以下游的「digest 不变不写 / 压缩补偿 / 占位快照」一行都不用分叉。
   *
   * 预取的三条闸（§V8.9）：读不到本轮用户输入 → 整段跳过；命中集合与上轮一致 → 不动；
   * 集合变了但冷却没到 → 沿用上轮那批条目（**内容照常回填**，否则重写快照时预取小节
   * 会凭空消失，表现为记忆每轮掉一截）。
   *
   * @param {object} input - 输入。
   * @param {object} input.config - 已解析配置。
   * @param {{ global: string, project: string }} input.bodies - 两段正文（已过 `docBody`）。
   * @param {string} input.projectRaw - 项目主记忆原文（分层渲染要自己解析主题围栏）。
   * @param {string} input.projectRoot - 项目根。
   * @param {object} [input.old] - 上一条快照事件。
   * @param {object} [input.log] - `scanSessionLog` 收齐的日志侧信息（一次遍历的产物）；
   *   缺省时按「无历史」处理。预取的冷却判定与热度回填都从这里取上轮状态，不再自己扫日志。
   * @param {object} input.session - 宿主 Session。
   * @param {number} input.maxBytes - 快照总预算。
   * @param {number} input.round - 本轮真实轮数。
   * @param {string|null} [input.userQuery] - **本轮用户输入**，由调用方从
   *   `agent/pre-step` 的 `payload.messages` 提取（A1 修复）。这是预取的**主来源**：
   *   pre-step 时刻本轮 `user/message` 还没落盘，日志里只有上一轮的，靠日志取必然拿错。
   *   为 `null` 时退回 `log.userQuery`（旧宿主 / 测试夹具不传 `messages` 时的降级路径）。
   * @returns {Promise<{ snapshot: object, recall: { ids: string[], round: number } | undefined,
   *   items: Array<object>, usageKeys: { topics: string[], entries: string[] } }>}
   *   快照、要写进 `source.recall` 的状态、本轮预取条目（无预取时 items 为空数组），
   *   以及**若本轮确实写入快照**时应该累加的热度键（契约 §V15.2）。
   *   `usageKeys` 只在这里算、不在在这里记：是否记账由调用方在确认写入之后判定。
   */
  async function composeSnapshot(input) {
    // v10：projectName 由调用方从本次解析出的 scope 传入，不再读模块级 activeScope。
    // 共享状态会在多会话交替时串台——这是同一个根因在快照侧的残留。
    const { config, bodies, projectRaw, projectRoot, projectName, maxBytes, round, log } = input
    const buildTiered = config.tieredInjection === false ? null : tieredRenderer()
    if (buildTiered === null) {
      // v7 路径：`tieredInjection: false` 的回滚通道与渲染层未就位共用出口（逐字不变）。
      return { snapshot: buildSnapshot({ ...bodies, projectName, maxBytes }), recall: undefined, items: [], usageKeys: { topics: [], entries: [] } }
    }

    const docs = await readProjectDocsOf(projectRoot)
    const entries = collectEntries(docs)
    const usageStats = await usage.load(projectRoot)
    const buildSection = projectSectionBuilder()
    let overflow = new Set()
    if (buildSection !== null) {
      try {
        overflow = overflowIdSet(
          buildSection({
            text: projectRaw,
            projectName,
            usage: usageStats,
            coreMaxBytes: config.projectCoreMaxBytes,
            indexMaxBytes: config.projectIndexMaxBytes,
          })?.overflow,
        )
      } catch (error) {
        deps.logger?.warn?.('supermemory: buildProjectSection failed, prefetch keeps the tier filter only: %o', error)
      }
    }

    // 上轮预取状态：来自 scanSessionLog 的一次遍历产物（surface 那条缺席时它已退到
    // append-only 日志，与 previousRecallState 同语义）。
    const prev = readRecallState(log?.loggedSnapshotEvent)
    /**
     * 本轮用户输入的取值优先级（A1，契约 §V8.9）：
     *   1. `input.userQuery` —— 来自 `agent/pre-step` 的 `payload.messages`，
     *      这是**唯一能看到本轮发言的时刻**（宿主在 step() 里才落盘 user/message）；
     *   2. `log.userQuery` —— 退回日志判据，服务旧宿主与不传 messages 的测试夹具。
     * 两条都拿不到才算「本轮没有输入」，此时 recallSkipReason 记 `no-query`。
     */
    const query = typeof input.userQuery === 'string' && input.userQuery !== ''
      ? input.userQuery
      : (typeof log?.userQuery === 'string' ? log.userQuery : null)
    const topK = Number.isFinite(config.projectRecallTopK) && config.projectRecallTopK > 0
      ? Math.floor(config.projectRecallTopK)
      : 5
    const candidates = query === null || entries.length === 0
      ? []
      : searchProjectEntries(docs, { terms: queryTerms(query), limit: topK })
    // 候选判据（§V8.15 裁决 3）：非 core 才可预取，但被预算临时折进目录的 core 条目
    // 要放行——它们 `tier` 仍是 core 却不在正文里，只按 tier 排除就永远回不到上下文。
    const currentIds = candidates
      .filter((entry) => entry.tier !== 'core' || overflow.has(entry.id))
      .map((entry) => entry.id)
    const decided = decideRecallSwap({
      current: currentIds,
      prev,
      round,
      minRounds: config.projectRecallMinRounds,
    })
    // 候选在前：它们带检索分数；沿用上一轮时由全量条目兜底回填正文。
    const items = pickRecallItems(candidates.length === 0 ? entries : [...candidates, ...entries], decided.ids)
    const recallState = decided.ids.length === 0 || items.length === 0
      ? undefined
      : { ids: decided.ids, round: decided.round }
    /**
     * 预取为什么没内容（契约 §V12.3）。
     *
     * 存在的理由：预取的候选判据是「非 core，或被预算挤出正文的 core」。预算充足且
     * 分层健康时**永远没有候选**，于是这个能力长期静默空转——真实会话 13 条快照里
     * `source.recall` 全部缺席，而没有任何地方说得出原因。这不是坏，是「不骗人」：
     * 每种空结果都要能自证是哪一种。
     */
    const recallSkipReason = recallState !== undefined
      ? undefined
      : query === null
        ? 'no-query'
        : entries.length === 0
          ? 'no-entries'
          : candidates.length === 0
            ? 'no-match'
            : currentIds.length === 0
              ? 'no-candidates'
              : items.length === 0
                ? 'empty'
                : 'cooling'
    /**
     * 本轮**候选**的待记账键（契约 §V15.2）。
     *
     * ⚠️ 这里只算键、**不记账**。真正的记账动作在 pre-step 里、确认「本轮确实要写快照」
     * 之后才执行——因为「这轮到底有没有把内容注进上下文」这件事，在 composeSnapshot
     * 内部无法判定：下面还有 digest 未变 → 不写、`shouldDeferRewrite` → 延后写两道闸。
     * 早先在这里直接 `usage.record` 导致实测缺陷：冷却期内候选被挡回、快照一个字没重写，
     * 热度却照样 +1（同文件下一条注释当时自我矛盾地写着「集合没变就不该再记一笔」）。
     *
     * 判据交给调用方（`sameIdSet` 比较新旧 id 集合 + 是否真的写了快照），本函数只负责
     * 「本轮进了上下文的条目是哪些」。
     */
    const recallUsageKeys = items.length > 0 ? usageKeysFromItems(items) : { topics: [], entries: [] }

    try {
      const snapshot = buildTiered({
        global: bodies.global,
        projectText: projectRaw,
        projectName,
        usage: usageStats,
        /**
         * 渲染层收的是**条目数组**（`buildRecallSection` 里 `Array.isArray(recall) ? recall : []`），
         * 传成 `{ids, items}` 对象会被静默判空——小节永远不出现，且没有任何报错。
         * 契约 §V8.15 裁决 1 写的是对象形态，此处以落地实现为准，分歧已报 Lead。
         * 条数由检索侧的 top-K 收口（§V8.9），总字节裁剪整个交给渲染层。
         */
        recall: items,
        // 渲染层那道「recall 不是数组就 warn」的闸门要把话说到日志里去（V8.15 第 19 条）：
        // 只往 stats 里塞一个 recallIgnored 计数，形状误用就变成只有查面板才能发现的哑闸。
        logger: deps.logger,
        injectMaxBytes: maxBytes,
        coreMaxBytes: config.projectCoreMaxBytes,
        indexMaxBytes: config.projectIndexMaxBytes,
        recallMaxBytes: config.projectRecallMaxBytes,
      })
      if (snapshot !== undefined && snapshot !== null && typeof snapshot.text === 'string') {
        // 空结果原因挂到 stats 上，与 snapshot 一起流到面板与工具（契约 §V12.3）。
        // 只加一个键，不改 stats 既有形状；undefined 时不落键，避免无谓的字段噪音。
        if (recallSkipReason !== undefined && snapshot.stats !== null && typeof snapshot.stats === 'object') {
          snapshot.stats.recallSkipReason = recallSkipReason
        }
        return { snapshot, recall: recallState, items, usageKeys: recallUsageKeys }
      }
      deps.logger?.warn?.('supermemory: buildTieredSnapshot 返回非预期形态，退回 v7 渲染路径')
    } catch (error) {
      deps.logger?.warn?.('supermemory: buildTieredSnapshot threw, falling back to v7: %o', error)
    }
    return { snapshot: buildSnapshot({ ...bodies, projectName, maxBytes }), recall: undefined, items: [], usageKeys: { topics: [], entries: [] } }
  }

  /**
   * 检测 `subagent` 工具对某个 scope 是否可见（契约 §V13.12）。
   *
   * 为什么需要它：专家能不能开分身取决于**宿主部署**（`tool-subagent` 是否启用），
   * 而提示词原本是写死的静态文本。禁用时那段提示就变成假话——模型照着去调
   * `subagent` 然后失败。本插件踩过这个坑：能力静默失效，无人察觉。
   * 所以「声明能力存在」的那句话必须由实测结果生成。
   *
   * @param {unknown} scope - 当前渲染的系统提示 scope（宿主 `text(context)` 里给）。
   * @returns {boolean|undefined} 可见 true / 不可见 false / **无法检测** undefined。
   *   undefined 时调用方不输出这句话——宁可少说，也不给可能错的信息。
   */
  const detectSpawnTool = (scope) => {
    try {
      const tools = ctx.get('tools')
      if (tools === undefined || tools === null || typeof tools.get !== 'function') return undefined
      // scope 缺失时不查：不带 scope 查的是「全局视图」，会忽略按 agent 的可见性覆盖，
      // 结论可能与我们关心的那个会话不一致。
      if (scope === undefined || scope === null) return undefined
      return tools.get('subagent', scope) !== undefined
    } catch (error) {
      deps.logger?.warn?.('supermemory: detectSpawnTool failed: %o', error)
      return undefined
    }
  }

  // —— A) 系统提示人格 section ——
  const prompt = (() => {
    try {
      return ctx.get('systemPrompt')
    } catch {
      return undefined
    }
  })()

  if (prompt !== undefined && prompt !== null) {
    remember('systemPrompt.section', () =>
      prompt.section({
        name: 'supermemory:persona',
        order: 100,
        interpolate: false,
        text: (assembly) => {
          try {
            const config = deps.getConfig?.()
            if (config?.enabled === false) return ''
            // 插件总开关关闭：人格不注入。判定缺失一律视为「开启」。
            if (deps.isEnabled?.() === false) return ''
            /**
             * 子智能体门控。`text` 的入参就是本次 assembly 的上下文，运行时带
             * `agent` —— 早先写成 `text: () => {...}` 把这个入口整个丢掉了，
             * 于是子智能体门控只存在于 pre-step（记忆快照），人格 section 对
             * 所有 agent 一视同仁。
             *
             * v13（契约 §V13.2）起改走统一判定 `memoryInjectionOf`：主管/专家/
             * 普通子代理三种身份的差别（专家子会话要拿完整记忆，普通子代理不要）
             * 只由装配层那一处回答。这里**不再**自己拼条件，避免两处漂移。
             */
            if (memoryInjectionOf(assembly?.agent) === 'none') return ''
            /**
             * 人设必须按**本次 assembly 的 agent** 现算，绝不读模块级缓存（v10）。
             *
             * 曾经这里读的是 `activeScope`——一个由 pre-step 维护的模块级单变量。
             * 两个致命缺陷：
             *   1. 宿主的顺序是「先 assemble（本回调），后 agent/pre-step」，所以
             *      section 读到的永远是**上一轮**的值，新会话第一次发言必错；
             *   2. 单变量被所有会话共享，多会话交替时后处理的会话会覆盖前一个，
             *      实测出现过整场对话注入别的人格。
             * `resolvePersonaSync` 只调同步 API（currentPersona / listPersonas /
             * sessionPersonas.get），所以在这里可以直接跑。
             */
            const resolved = resolvePersonaOf(assembly?.agent)
            if (resolved === undefined) return ''
            const persona = resolved.persona
            const soul = readBodySync({ kind: 'soul', persona })
            const user = readBodySync({ kind: 'user', persona })
            if (soul === '' && user === '') return ''
            const maxBytes = Number.isFinite(config?.systemPromptMaxBytes)
              ? config.systemPromptMaxBytes
              : 12000
            const text = buildPersonaSection({ soul, user, maxBytes })
            return typeof text === 'string' ? text : ''
          } catch (error) {
            deps.logger?.warn?.('supermemory: persona section failed: %o', error)
            return ''
          }
        },
      }),
    )
  }

  /**
   * 本次 assembly 的当前人设是否为主管（契约 §V13.4）。
   *
   * 不用装配层的 `deps.isSupervisorAgent` 而自己比 slug，理由有两条：
   *   1. 注入层已经握有 `resolvePersonaOf`（人格 section 用的同一个解析器），
   *      直接复用它才能保证「目录判定的人设」与「实际注入的人格」**同源**——
   *      多走一层 `deps.isSupervisorAgent` 就多一个可能与人格 section 漂移的判据；
   *   2. `isSupervisorAgent` 是可选依赖，老 mock 没有它。自己比 slug 只依赖
   *      `deps.experts.supervisor()`（目录本来就需要它），降级面更小。
   *
   * @param agent - 本次 assembly 的宿主 Agent。
   * @returns {boolean} 是否主管。
   */
  const isSupervisorOf = (agent) => {
    try {
      const supervisorSlug = deps.experts?.supervisor?.()?.slug
      if (typeof supervisorSlug !== 'string' || supervisorSlug === '') return false
      const resolved = resolvePersonaOf(agent)
      return resolved !== undefined && resolved.persona === supervisorSlug
    } catch (error) {
      deps.logger?.warn?.('supermemory: supervisor check failed: %o', error)
      return false
    }
  }

  // —— A2) 专家人格目录 section（契约 §V13.4）——
  //
  // 只给**主管**看：专家子会话是被调用的那一方，它不需要知道还能再派谁；普通会话
  // 连 `delegate_expert` 工具都没有，列出名册只会让模型以为可以委派。
  //
  // 注册条件带 `deps.experts` 存在性：没有专家数据面时这个 section 恒为空串，
  // 注册它只会多一次每轮空调用（宿主每轮都要遍历 section 列表），而且会让
  // 「section 数量」这类既有断言无谓地变动。装配层一定有它（lib/index.js 里写死），
  // 所以这条闸只影响 mock/老装配层。
  if (prompt !== undefined && prompt !== null && deps.experts !== undefined && deps.experts !== null) {
    remember('systemPrompt.section.experts', () =>
      prompt.section({
        name: 'supermemory:experts',
        // 排在人格（100）之后：先立住「我是谁」，再给「我能派谁」。
        order: 110,
        interpolate: false,
        text: (assembly) => {
          try {
            if (deps.isEnabled?.() === false) return ''
            const config = deps.getConfig?.()
            if (config?.enabled === false) return ''
            // 委派总开关关闭：工具与目录一起消失（契约 §V13.1）。
            if (config?.delegateEnabled === false) return ''
            // 专家子会话/普通子代理都不需要这份名册。
            if (memoryInjectionOf(assembly?.agent) === 'none') return ''
            // 专家自己（子代理）不看目录——它没有委派权。
            if (deps.isSubagent?.(assembly?.agent) === true) return ''
            if (!isSupervisorOf(assembly?.agent)) return ''
            const experts = deps.experts?.list?.()
            if (!Array.isArray(experts) || experts.length === 0) return ''
            /**
             * 数据必须来自**同步** API。装配层把 `store.listPersonas()` /
             * `store.supervisorSync()` 包成同步的 `deps.experts`（两者都只读
             * 构造期已加载的内存态），所以这里不需要 await，也不能 await。
             */
            const supervisorSlug = deps.experts?.supervisor?.()?.slug
            const maxBytes = Number.isFinite(config?.expertDirectoryMaxBytes)
              ? config.expertDirectoryMaxBytes
              : 2048
            const directory = buildExpertDirectory({
              experts,
              supervisorSlug,
              maxBytes,
              canSpawn: detectSpawnTool(assembly?.scope),
            })
            return typeof directory?.text === 'string' ? directory.text : ''
          } catch (error) {
            deps.logger?.warn?.('supermemory: expert directory section failed: %o', error)
            return ''
          }
        },
      }),
    )
  }

  /**
   * 预热某个人设的 soul / user 到 store 的进程内缓存（v10，契约 §V10.2）。
   *
   * 为什么需要：`systemPrompt.section` 的 text 回调只能同步读，而
   * `store.readDocSync` **只读进程内缓存、不读盘**——进程刚启动时缓存是空的，
   * 它会返回空模板，于是人格整段丢失（实测：首次同步读得到 57 字节的模板，
   * 真实内容要等异步 readDoc 之后才进缓存）。
   *
   * 所以必须在 section 被调用之前，用异步 readDoc 把这两份文档读进缓存。
   * 调用点是 `agent/created`：宿主建 agent 早于第一次 assemble，够早；
   * 人设切换时由 pre-step 补一次（见下方 adoptScope 调用处）。
   *
   * 只预热、不读返回值，失败只 warn：预热是优化，预热失败最坏也只是退回
   * 「这一轮人格为空」，不该影响会话。
   *
   * @param persona - 人设 slug。
   * @returns {Promise<void>} 无。
   */
  const warmPersonaCache = async (persona) => {
    if (typeof persona !== 'string' || persona === '') return
    try {
      await Promise.all([
        deps.store?.readDoc?.({ kind: 'soul', persona }),
        deps.store?.readDoc?.({ kind: 'user', persona }),
      ])
    } catch (error) {
      deps.logger?.warn?.('supermemory: 预热人设缓存失败 (%s): %o', persona, error)
    }
  }

  /** 把解析到的 scope 记进活动缓存（仅快照侧与 bootstrap 使用；人格已改为现算）。 */
  const adoptScope = (scope) => {
    if (scope === undefined || scope === null) return
    activeScope = {
      persona:
        typeof scope.persona === 'string' && scope.persona !== ''
          ? scope.persona
          : typeof scope.presetId === 'string' && scope.presetId !== ''
            ? scope.presetId
            : 'default',
      presetId: typeof scope.presetId === 'string' && scope.presetId !== '' ? scope.presetId : 'default',
      projectRoot: scope.projectRoot,
      projectName: scope.projectName,
    }
  }

  // —— 创建时预热（首个 assemble 之前必须让 soul/user 进缓存） ——
  remember('agent/created listener', () => {
    if (typeof ctx.on !== 'function') return undefined
    /**
     * 必须 **return 这个 Promise**，让宿主 await 到预热完成。
     *
     * `dsh-agent` 的 `announce()` 是 `await this.ctx.serial(..., "agent/created", ...)`，
     * 也就是说宿主会等监听器返回的 Promise 落地后才继续。早先这里写成
     * `Promise.resolve().then(...)` 且不 return，等于 fire-and-forget——宿主立刻
     * 往下走，第一次 assemble 可能在预热完成前就跑，人格仍然为空。
     * 这是「冷启动人格丢失」的最后一道口子。
     */
    return ctx.on('agent/created', async (payload) => {
      const agent = payload?.agent
      try {
        // 先解析出这个 agent 到底用哪个人设（会话绑定优先），再按它预热。
        // 顺序不能反：按全局 current 预热会在「已绑定其它人设」的会话上白热一份。
        const resolved = resolvePersonaOf(agent)
        await warmPersonaCache(resolved?.persona)
        adoptScope(await deps.loadScope?.(agent))
      } catch (error) {
        deps.logger?.warn?.('supermemory: warm scope failed: %o', error)
      }
    })
  })

  // —— B) 记忆快照注入 ——
  remember('agent/pre-step listener', () => {
    if (typeof ctx.on !== 'function') return undefined
    return ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      if (decision?.kind === 'reject') return decision
      try {
        const agent = payload?.agent
        const signal = payload?.signal
        if (signal?.aborted === true) return decision

        const config = deps.getConfig?.() ?? {}
        if (config.enabled === false) return decision
        // 插件总开关关闭：不写任何快照。会话里已有的旧快照**原样保留**
        // ——不替换、不清理、不写占位，只是不再更新。
        if (deps.isEnabled?.() === false) return decision
        // v13（契约 §V13.2）：与人格 section 同一判定。专家子会话要完整记忆，
        // 普通子代理默认不注入——判据只在 memoryInjectionOf 一处。
        if (memoryInjectionOf(agent) === 'none') return decision

        const scope = await deps.loadScope?.(agent)
        adoptScope(scope)
        if (activeScope === null) return decision

        const session = agent?.session
        if (session === undefined || session === null) return decision

        // v10：一律用本次 loadScope 解析出的局部 scope，不读模块级 activeScope。
        const persona = scope?.persona ?? scope?.presetId ?? 'default'
        const projectRoot = scope?.projectRoot

        // v10（契约 §V10.2）：本会话用的人设若还没进 store 缓存，补预热一次。
        //
        // 为什么在这里：section 已经跑过了（宿主顺序是 assemble → pre-step），
        // 所以这里预热的效果是**下一轮**生效。但下一轮本来就在同一进程里、
        // 缓存通常已热，真正必须预热的是「进程刚启动后的第一次 assemble」——
        // 那条路径由 agent/created 覆盖。这里兜住的是「agent 创建时解析失败、
        // 或人设中途被切换」的场合，属于第二道防线。
        //
        // 只在缓存未命中时读盘：命中时 readDoc 只做一次 stat，成本可忽略。
        await warmPersonaCache(persona)
        // v8（契约 §V8.1.1）：pre-step 只读 global / project。soul 与 user 的唯一
        // 出口是 systemPrompt.section，在这里再读一遍就是每轮白烧约 5 KB。
        // 读的是**原始文档文本**：分层渲染要自己解析 preamble 里的主题围栏，
        // 而 `docBody` 会把 HTML 注释整段剥掉（契约 §V8.3 点明的坑）。
        const [globalRaw, projectRaw] = await Promise.all([
          readDocRaw({ kind: 'global', persona }),
          readDocRaw({ kind: 'project', projectRoot }),
        ])
        const bodies = { global: docBody(globalRaw), project: docBody(projectRaw) }

        // 压缩补偿与「上一条快照」先算出来：预取的冷却判定要从上一条快照的
        // `source.recall` 读上轮的命中集合，所以它必须早于快照组装。
        // 开关缺失一律视为「开启」（门控铁律）。
        //
        // **两个「recall」不是一回事，别混**：这里的 `recallEnabled` 读的是既有配置键
        // `compactionRecall`（压缩之后要不要把记忆重新召回），与契约 §V8.9 的「本轮预取
        // （project recall）」毫无关系——后者由 `tieredInjection` 与 `projectRecall*`
        // 那组键控制。误读成同一个开关，会得出「关掉预取就没有压缩补偿」的错误结论。
        const recallEnabled = config.compactionRecall !== false
        /**
         * 本轮用户输入（A1，契约 §V8.9）：**必须先看 payload.messages**。
         *
         * 宿主的时序是 `preStep()` → 派发本事件（payload 里带 `messages: claimed`）
         * → `step()` 里才 `session.append('user/message', ...)` 落盘。所以此刻日志里
         * **没有本轮发言**，只靠日志取到的要么是 null（首轮），要么是**上一轮**的输入
         * ——用旧 query 去检索，捞回来的是上一个话题的冷层条目。
         *
         * 实测：71 条真实快照，pre-step 精确时刻 71/71 拿不到本轮输入。这条链路在
         * 修复前是 100% 空转的（`## 本轮相关记忆` 从未真正出现过）。
         *
         * 取不到时退回日志判据：旧宿主、以及不传 messages 的测试夹具仍能工作。
         */
        const payloadQuery = userQueryFromPayload(payload?.messages)
        // **一次**遍历收齐其余日志侧信息（压缩状态 / 上一条快照 / 真实轮数 / 上轮预取
        // 状态）。`userQuery` 字段仍然保留并作为降级来源，判据原样未动。
        const log = scanSessionLog(session, recallEnabled)
        const compaction = log.compaction
        const old = log.snapshotEvent

        const maxBytes = Number.isFinite(config.injectMaxBytes) ? config.injectMaxBytes : 24000
        // 真实轮数在 scanSessionLog 里与其它判据一起收齐（判据：只数 `source.kind === 'user'`，
        // §V8.15 裁决 4）。
        const round = log.userTurns
        const built = await composeSnapshot({
          config, bodies, projectRaw, projectRoot, old, maxBytes, round, log,
          // payload 优先、日志兜底（见上方 payloadQuery 的注释）。
          userQuery: payloadQuery,
          // v10：项目名跟着本次解析出的 scope 走，不再从模块级 activeScope 取。
          projectName: scope?.projectName,
        })
        const snapshot = built?.snapshot
        if (snapshot === undefined || snapshot === null) return decision

        /**
         * 是否需要强制重同步：只认「本插件快照**已不在 surface 上**」，也就是被压缩
         * 整段吞掉了。命中时**即使 digest 相同也要重写**，否则模型在压缩之后就再也
         * 看不到完整记忆。
         *
         * v11（契约 §V11.0.2）：这里**不再**用「最近一次压缩晚于快照」当判据。压缩完全
         * 可能压的是别处、我们的快照好好留在 surface 上，那时正文与 digest 都没变，
         * 却会白写一条 replace 事件，纯粹是历史抖动。`lastSnapshotEvent` 已经按
         * `surface.nodes`（退路是 `shadowed` 遮蔽集）过滤过，它返回 undefined 就等价于
         * 「快照确实不在 surface 上了」，这一条判据既充分又必要。
         *
         * 收敛性：重写产生的新事件必然回到 surface，下一轮 old 有值，判定自动变 false。
         */
        const needsResync = recallEnabled && old === undefined && compaction.seq >= 0

        /**
         * 用 `replace` 写入一条新快照。
         *
         * 宿主对 replace 有一条硬校验（dsh-session/lib/types/surface.js）：
         * `sourceEventSeqs` 必须非空、只引用更早的事件、且覆盖全部被遮蔽的
         * surface 节点，否则 append 直接抛错。这里遮蔽的只有一个节点，所以
         * 精确传 `[old.seq]`。
         *
         * @param {object} message - 新的快照消息。
         * @returns {boolean} 是否**真的写入了**（跳过时为 false，热度记账据此判定）。
         */
        const replaceSnapshot = (message) => {
          // 兜底而非主判据：正常走不到这里（首次快照由宿主落在 system/message 之后，
          // 受保护头部必然已建立）。真走到就说明历史形态已超出假设，这一轮宁可不更新，
          // 也绝不去碰 surface 的第一个位置。
          if (!hasSystemHead(session)) {
            deps.logger?.warn?.('supermemory: 历史里没有 system/message，本轮跳过快照替换')
            return false
          }
          session.append('user/message', message, {
            surfaceOp: { op: 'replace', startSeq: old.seq, endSeq: old.seq },
            sourceEventSeqs: [old.seq],
          })
          return true
        }

        /**
         * 热度记账（契约 §V15.2）——**唯一**记账点，必须晚于「本轮是否真的写快照」的判定。
         *
         * 语义（Lead 裁决，按此实现，勿放宽）：
         *   只在「本轮**实际写入了快照**」且「本轮注入的 id 集合**与上轮不同**」时记一笔。
         *
         * 为什么必须两个条件同时成立：热度统计的是「这条记忆被真正拿来用了一次」。
         *   - 快照没写 → 模型看到的正文与上轮完全相同 → 没有任何新的使用 → 不记。
         *     这正是旧实现的缺陷：冷却期内候选被挡回（`dropped` 非空）、`shouldDeferRewrite`
         *     又延后了重写，热度却照样 +1，把「同一批记忆连续在场 3 轮」记成 3 次使用。
         *   - id 集合没变 → 即使写了快照（比如 `needsResync` 因压缩补偿重写、或别的段
         *     变了导致整块重写），预取小节注入的仍是同一批条目 → 不记，否则同一批内容
         *     会因「快照被重写」而被反复计数。
         *
         * `decideRecallSwap` 四种结局在新口径下的落点（判据只看上面两条，不看结局）：
         *   - `swap`（真换血）：ids 变了且会写快照（digest 含 recall id 集合）→ **记**；
         *   - `held`（本轮无候选、沿用上轮）：ids 与上轮相同 → 通常**不记**；
         *     例外：上轮 recall 因预算被裁掉/旧快照没有 recall 而本轮重新回填成功，
         *     此时集合确实从「空」变成「有」，且快照确实被重写 → **记**（唯一判据自然覆盖）；
         *   - cooling（候选变了被冷却挡回）：ids 沿用上轮，与上轮相同 → **不记**
         *     （旧的 `dropped.length > 0` 判据正是在这里错的）；
         *   - 一致（候选与上轮完全相同）：ids 未变 → **不记**。
         *
         * @param {boolean} wrote - 本轮是否真的写入了快照。
         */
        const recordRecallHeat = async (wrote) => {
          if (wrote !== true) return
          const keys = built?.usageKeys
          if (keys === undefined || keys === null) return
          const hasKeys = (Array.isArray(keys.topics) && keys.topics.length > 0)
            || (Array.isArray(keys.entries) && keys.entries.length > 0)
          if (!hasKeys) return
          const nextIds = built?.recall?.ids
          const prevIds = old?.data?.source?.recall?.ids
          // 集合语义比较（顺序无关），复用注入层已有的 sameIdSet，不另立口径。
          if (sameIdSet(nextIds, prevIds)) return
          await usage.record(projectRoot, { topics: keys.topics, entries: keys.entries })
        }

        // global / project 两段全空：用固定 digest 的占位替换旧快照，让模型看到
        // 「记忆已清空」而不是继续看到已删除的旧内容；surface 恒为 1 条。
        // 人格与画像有内容时**不**算空——它们的出口是 systemPrompt.section，
        // 从来不在快照里（契约 §V8.1.1）。
        if (snapshot.text === '') {
          if (old === undefined) return decision
          if (old.data?.source?.digest === EMPTY_DIGEST) return decision
          replaceSnapshot(buildEmptySnapshotMessage())
          return decision
        }

        // 内容未变：不重复写入；但压缩补偿判定命中时例外（快照已被摘要盖掉）。
        if (
          old !== undefined &&
          old.data?.source?.digest === snapshot.digest &&
          !needsResync
        ) {
          return decision
        }

        // byteSections 收口（契约 §V8.1.1）：渲染层出于「旧签名旧行为不变」仍会带上
        // soul/user 两个 0 键，这里剔掉；分层路径的 core/index/recall 字节照常透传。
        // 重写归因（契约 §V12.2）：上一条快照的元数据来自 `old.data.source`，五维短指纹
        // 存在 `parts` 里；旧快照没有 `parts` 时归因落到 `unknown`，不猜。
        const rewrite = attributeRewrite(old?.data?.source, snapshot, needsResync)

        // 只有预取集合变、正文一个字没变时延后整块重写（契约 §V12.4，判定见 shouldDeferRewrite）。
        if (shouldDeferRewrite(rewrite, old?.data?.source)) {
          deps.logger?.info?.('supermemory: snapshot rewrite deferred reason=recall-only（正文未变，沿用上轮预取）')
          return decision
        }

        if (rewrite.changed.length > 0 || rewrite.reason === 'resync') {
          deps.logger?.info?.(
            'supermemory: snapshot rewrite reason=%s changed=[%s]',
            rewrite.reason,
            rewrite.changed.join(','),
          )
        }
        const message = buildSnapshotMessage(
          { ...snapshot, sections: pickSnapshotBytes(snapshot.sections) },
          // `rendered` 是裁剪后的真值；v7 回滚路径与老渲染层没有它，由 buildSectionList 降级。
          buildSectionList(bodies, snapshot.rendered),
          built.recall,
          rewrite,
        )
        if (old === undefined) {
          /**
           * 首次注入**不自己 append**，把消息放进 pre-step 的返回值交给宿主落盘。
           *
           * `dsh-agent-loop` 在 append 完 `system/message` 之后、构造请求之前，会把
           * `decision.messages` 里非 runtime-context 的消息逐条
           * `session.append('user/message', message, { surfaceOp: 'append' })`。时序由
           * 宿主保证，且本轮就可见。
           *
           * 自己 append 则必然抢跑：pre-step 在 loop 里是 685 行，`step/start` 757 行，
           * `system/message` 854 行——我们隔着两道工序，实测早约 5 毫秒。抢跑一次，
           * 该会话此后每次加载都报 `system/message requires a protected first surface
           * head`，无法自愈（一次真实环境里 40 个会话中招 16 个）。
           */
          const carried = Array.isArray(decision?.messages) ? decision.messages : []
          // 首次注入：消息交给宿主落盘，宿主保证它会落到 surface 上，所以「写入」成立。
          await recordRecallHeat(true)
          return { ...decision, messages: [...carried, message] }
        }
        // 走到这里说明历史里已有我们的快照，而它是由宿主落在 system/message 之后的，
        // 受保护头部必然已建立，replace 不会再触碰它。
        await recordRecallHeat(replaceSnapshot(message))
        return decision
      } catch (error) {
        deps.logger?.warn?.('supermemory: snapshot injection failed: %o', error)
      }
      return decision
    })
  })

  return dispose
}
