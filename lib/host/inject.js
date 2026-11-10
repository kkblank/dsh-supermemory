/**
 * dsh-supermemory —— 宿主注入（系统提示人格 section + 记忆快照消息）。
 *
 * 设计要点（见 docs/CONTRACT.md §5.1）：
 *   - `systemPrompt.section` 的 `text` 回调拿不到 agent，只能同步读取
 *     `installInjection` 内部维护的「当前活动 scope」缓存。
 *   - 快照消息由本模块**自己** `session.append` 落库，绝不往
 *     `decision.messages` 里塞：宿主会对 `decision.messages` 里每条消息再
 *     `append` 一次，两条写入口必然造成重复。
 *   - 任何异常都必须 catch + `logger.warn` + `return decision`，绝不破坏 step。
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
export function lastSnapshotEvent(session) {
  if (session === undefined || session === null) return undefined
  if (typeof session.snapshotEvents !== 'function') return undefined
  const surface = session.surface?.nodes
  const inSurface = (seq) => {
    if (surface === undefined || surface === null) return true
    if (typeof surface.has === 'function') return surface.has(seq)
    if (Array.isArray(surface)) return surface.includes(seq)
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
        text: () => {
          try {
            const config = deps.getConfig?.()
            if (config?.enabled === false) return ''
            if (activeScope === null) return ''
            const presetId = activeScope.presetId
            const soul = readBodySync({ kind: 'soul', presetId })
            const user = readBodySync({ kind: 'user', presetId })
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
        if (config.injectIntoSubagents === false && deps.isSubagent?.(agent) === true) return decision

        const scope = await deps.loadScope?.(agent)
        adoptScope(scope)
        if (activeScope === null) return decision

        const session = agent?.session
        if (session === undefined || session === null) return decision

        const presetId = activeScope.presetId
        const projectRoot = activeScope.projectRoot
        const [soul, user, global, project] = await Promise.all([
          readBody({ kind: 'soul', presetId }),
          readBody({ kind: 'user', presetId }),
          readBody({ kind: 'global', presetId }),
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

        const old = lastSnapshotEvent(session)

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

        // 内容未变：不重复写入。
        if (old !== undefined && old.data?.source?.digest === snapshot.digest) return decision

        const message = buildSnapshotMessage(snapshot, buildSectionList(bodies))
        if (old === undefined) {
          session.append('user/message', message, { surfaceOp: 'append' })
        } else {
          replaceSnapshot(message)
        }
      } catch (error) {
        deps.logger?.warn?.('supermemory: snapshot injection failed: %o', error)
      }
      return decision
    })
  })

  return dispose
}
