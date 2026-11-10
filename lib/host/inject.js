/**
 * dsh-supermemory —— 宿主注入（系统提示人格 section + 记忆快照消息）。
 *
 * 设计要点（见 docs/CONTRACT.md §5.1）：
 *   - `systemPrompt.section` 的 `text(assembly)` 入参在**运行时带 `agent`**，
 *     子智能体门控就靠它（类型声明里 `AssembleContext` 只写了 `scope`/`signal`，
 *     信息滞后，别据此断定拿不到 agent）。但回调里做不了异步读，人格正文仍
 *     同步读「当前活动 scope」缓存（由 `agent/created` 与 pre-step 维护）。
 *   - 快照消息由本模块**自己** `session.append` 落库，绝不往
 *     `decision.messages` 里塞：宿主会对 `decision.messages` 里每条消息再
 *     `append` 一次，两条写入口必然造成重复。
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

import { buildPersonaSection, buildSnapshot, escapeFrame } from '../core/render.js'

/** 快照消息固定的首行提示，模型据此知道这不是用户发言。 */
export const SNAPSHOT_NOTICE = '本消息由 dsh-supermemory 插件自动维护的记忆快照，不是用户发言。'

/** 记忆全部清空后占位快照的正文。 */
export const EMPTY_SNAPSHOT_TEXT = '（当前没有已保存的记忆内容。）'

/** 占位快照的固定 digest，保证清空后不会每轮重复 replace。 */
export const EMPTY_DIGEST = 'empty'

/** 本插件消息的 source.kind，用于在会话日志里识别自己。 */
export const SOURCE_KIND = 'dsh-supermemory'

/** 四个记忆分区的固定顺序。 */
const SCOPES = ['soul', 'user', 'global', 'project']

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
 * @param {Record<string, string>} bodies - 四个 scope 的正文。
 * @returns {Array<{ name: string, text: string }>}
 */
function buildSectionList(bodies) {
  const list = []
  for (const name of SCOPES) {
    const text = bodies[name]
    if (typeof text === 'string' && text !== '') {
      list.push({ name, text: escapeFrame(text) })
    }
  }
  return list
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
      byteSections: { soul: 0, user: 0, global: 0, project: 0 },
    },
  }
}

/**
 * 构造快照 user 消息（手写普通对象，不 import 宿主 createUserMessage）。
 * @param {{ text: string, digest: string, truncated: boolean, sections?: object }} snapshot
 * @param {Array<{ name: string, text: string }>} sections - 非空段列表。
 * @returns {object} 可直接交给 `session.append('user/message', ...)` 的消息。
 */
export function buildSnapshotMessage(snapshot, sections) {
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
  /** 最近一次解析出的活动 scope；供 section 的同步 text() 使用。 */
  let activeScope = null

  const dispose = () => {
    activeScope = null
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

  /** 异步读一份文档正文；任何异常都降级为空串。 */
  const readBody = async (ref) => {
    try {
      return docBody((await deps.store?.readDoc?.(ref))?.content)
    } catch (error) {
      deps.logger?.warn?.('supermemory: readDoc failed: %o', error)
      return ''
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
             * 所有 agent 一视同仁。判定与 pre-step 用同一套条件，避免两处漂移。
             */
            if (
              config?.injectIntoSubagents === false &&
              deps.isSubagent?.(assembly?.agent) === true
            ) {
              return ''
            }
            if (activeScope === null) return ''
            const persona = activeScope.persona ?? activeScope.presetId
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

  /** 把解析到的 scope 记进活动缓存。 */
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

  // —— 创建时预热活动 scope（首个 pre-step 之前 section 也能读到人格） ——
  remember('agent/created listener', () => {
    if (typeof ctx.on !== 'function') return undefined
    return ctx.on('agent/created', (payload) => {
      const agent = payload?.agent
      Promise.resolve()
        .then(() => deps.loadScope?.(agent))
        .then(adoptScope)
        .catch((error) => deps.logger?.warn?.('supermemory: warm scope failed: %o', error))
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
        if (config.injectIntoSubagents === false && deps.isSubagent?.(agent) === true) return decision

        const scope = await deps.loadScope?.(agent)
        adoptScope(scope)
        if (activeScope === null) return decision

        const session = agent?.session
        if (session === undefined || session === null) return decision

        const persona = activeScope.persona ?? activeScope.presetId
        const projectRoot = activeScope.projectRoot
        const [soul, user, global, project] = await Promise.all([
          readBody({ kind: 'soul', persona }),
          readBody({ kind: 'user', persona }),
          readBody({ kind: 'global', persona }),
          readBody({ kind: 'project', projectRoot }),
        ])
        const bodies = { soul, user, global, project }

        const maxBytes = Number.isFinite(config.injectMaxBytes) ? config.injectMaxBytes : 24000
        const snapshot = buildSnapshot({
          ...bodies,
          projectName: activeScope.projectName,
          maxBytes,
        })
        if (snapshot === undefined || snapshot === null) return decision

        // 压缩补偿：先识别会话历史上的压缩。开关缺失一律视为「开启」（门控铁律）。
        const recallEnabled = config.compactionRecall !== false
        const compaction = recallEnabled
          ? compactionState(session)
          : { seq: -1, shadowed: new Set() }
        const old = lastSnapshotEvent(session, compaction.shadowed)

        /**
         * 是否需要强制重同步：本插件快照已不在 surface 上（被压缩整段吞掉），
         * 或最近一次压缩晚于我们的快照。命中时**即使 digest 相同也要重写**，
         * 否则模型在压缩之后就再也看不到完整记忆。
         *
         * 收敛性：重写产生的新事件 seq 必然大于压缩 seq，下一轮该判定自动变
         * false，不会反复 replace（无新压缩则只写一次）。
         */
        const needsResync =
          recallEnabled && (old === undefined ? compaction.seq >= 0 : compaction.seq > old.seq)

        /**
         * 用 `replace` 写入一条新快照。
         *
         * 宿主对 replace 有一条硬校验（dsh-session/lib/types/surface.js）：
         * `sourceEventSeqs` 必须非空、只引用更早的事件、且覆盖全部被遮蔽的
         * surface 节点，否则 append 直接抛错。这里遮蔽的只有一个节点，所以
         * 精确传 `[old.seq]`。
         *
         * @param {object} message - 新的快照消息。
         */
        const replaceSnapshot = (message) => {
          // 兜底而非主判据：正常走不到这里（首次快照由宿主落在 system/message 之后，
          // 受保护头部必然已建立）。真走到就说明历史形态已超出假设，这一轮宁可不更新，
          // 也绝不去碰 surface 的第一个位置。
          if (!hasSystemHead(session)) {
            deps.logger?.warn?.('supermemory: 历史里没有 system/message，本轮跳过快照替换')
            return
          }
          session.append('user/message', message, {
            surfaceOp: { op: 'replace', startSeq: old.seq, endSeq: old.seq },
            sourceEventSeqs: [old.seq],
          })
        }

        // 四段全空：用固定 digest 的占位替换旧快照，让模型看到「记忆已清空」
        // 而不是继续看到已删除的旧内容；surface 恒为 1 条。
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

        const message = buildSnapshotMessage(snapshot, buildSectionList(bodies))
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
          return { ...decision, messages: [...carried, message] }
        }
        // 走到这里说明历史里已有我们的快照，而它是由宿主落在 system/message 之后的，
        // 受保护头部必然已建立，replace 不会再触碰它。
        replaceSnapshot(message)
        return decision
      } catch (error) {
        deps.logger?.warn?.('supermemory: snapshot injection failed: %o', error)
      }
      return decision
    })
  })

  return dispose
}
