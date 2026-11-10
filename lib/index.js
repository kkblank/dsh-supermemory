/**
 * dsh-supermemory — 插件入口（Host 侧）。
 *
 * 设计约束（见 docs/CONTRACT.md §0）：
 *   - 本工作区无法解析任何 `@deepseek-ai/dsh-*` / `@deepseek-ai/cordis` 包，
 *     因此所有宿主能力都通过 `ctx.get(name)` 可选获取，缺失时静默降级。
 *   - 唯一允许的裸包依赖是 `@deepseek-ai/schemastery`，只在 lib/host/config.js 中使用。
 *
 * 职责边界：
 *   本文件只做「装配」：读配置、建 store、提供跨模块的 deps、按顺序安装各能力。
 *   具体实现分别在 lib/host/*.js 与 lib/core/*.js。
 *
 * @module dsh-supermemory
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

import { Config, resolveConfig, resolvePresetsRoot } from './host/config.js'
import { createStore } from './core/store.js'
import { presetSlug, projectDisplayName, resolveProjectRoot } from './core/paths.js'
import { installInjection } from './host/inject.js'
import { installTools } from './host/tools.js'
import { installCommands } from './host/commands.js'
import { createDigestRunner } from './host/digest.js'
import { installRoutes } from './host/routes.js'

export { Config }

/** 插件名，必须与包名一致。 */
export const name = 'supermemory'

/**
 * 不声明硬依赖：宿主服务全部可选，缺失时对应能力静默降级。
 * 这样插件在无 llm / 无 webServer / 无 tools 的 profile 里也能加载。
 */
export const inject = []

/** 解析 DSH 家目录，与其它插件同规则。 */
function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv
  return join(homedir(), '.dsh')
}

/** 安全地取一个可选服务（缺失或抛错都返回 undefined）。 */
function optional(ctx, serviceName) {
  try {
    return ctx.get(serviceName)
  } catch {
    return undefined
  }
}

/**
 * 判断一个 agent 是否是子智能体。
 * @param agent - 宿主 Agent。
 * @returns 子智能体返回 true。
 */
export function isSubagentAgent(agent) {
  const header = agent?.session?.header
  if (header === undefined) return false
  return header.parentSession !== undefined || header.origin === 'subagent'
}

/**
 * 读一个 agent 当前的 provider/model 路由。
 * @param ctx - 插件上下文。
 * @param agent - 宿主 Agent。
 * @returns { provider, model } 或 undefined。
 */
export function currentRoute(ctx, agent) {
  // 1) agent 创建选项（最直接，且不需要额外服务）。
  try {
    const options = agent?.options
    if (typeof options?.provider === 'string' && typeof options?.model === 'string') {
      return { provider: options.provider, model: options.model }
    }
  } catch {
    /* ignore */
  }
  // 2) 会话投影里最近一次使用的路由。
  try {
    const projections = optional(ctx, 'sessionProjections')
    const snapshot = projections?.snapshot?.(agent?.session, ['modelSelection'])
    const selection = snapshot?.modelSelection
    const used = selection?.lastUsed ?? selection?.next
    if (typeof used?.provider === 'string' && typeof used?.model === 'string') {
      return { provider: used.provider, model: used.model }
    }
  } catch {
    /* 投影服务可能不存在，继续回退 */
  }
  // 3) 全局默认模型。
  try {
    const selection = optional(ctx, 'agentDefaultModel')?.currentSelection?.()
    if (typeof selection?.provider === 'string' && typeof selection?.model === 'string') {
      return { provider: selection.provider, model: selection.model }
    }
  } catch {
    /* ignore */
  }
  return undefined
}

/**
 * 插件入口。
 * @param ctx - Cordis 插件上下文。
 * @param config - cordis.patch.yml 里的 config。
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  if (!resolved.enabled) return

  const dshHome = resolveDshHome()
  const presetsRoot = resolvePresetsRoot(resolved, dshHome)
  const logger = ctx.logger ?? { warn: () => {}, info: () => {} }

  const store = createStore({ dshHome, presetsRoot, config: resolved, logger })

  /** 最近一次 pre-step 解析出的活动上下文，供 HTTP bootstrap 使用。 */
  let activeContext = null

  /**
   * 解析一个 agent 的记忆作用域。
   * preset 隔离人格/画像/全局记忆；项目根隔离项目记忆。
   * @param agent - 宿主 Agent。
   * @returns { presetId, presetSlug, projectRoot, projectName, reason } 或 undefined。
   */
  async function resolveScope(agent) {
    const session = agent?.session
    if (session === undefined) return undefined

    let presetId = 'default'
    try {
      const presets = optional(ctx, 'agentPresets')
      const recorded = presets?.presetForSession?.(session)
      if (typeof recorded === 'string' && recorded !== '') presetId = recorded
    } catch {
      /* 预设服务缺失时归入 default */
    }

    let cwd
    try {
      cwd = optional(ctx, 'workingDirectory')?.get?.(session)
    } catch {
      cwd = undefined
    }
    if (typeof cwd !== 'string' || cwd === '') cwd = session.header?.cwd ?? process.cwd()

    const { root, reason } = await resolveProjectRoot(cwd)
    const projectName = projectDisplayName(root)

    try {
      await store.touchProject(root, projectName)
    } catch (error) {
      logger.warn?.('supermemory: touchProject failed: %o', error)
    }

    return {
      presetId,
      presetSlug: presetSlug(presetId),
      projectRoot: root,
      projectName,
      reason,
    }
  }

  /** 供 HTTP bootstrap 读取的当前活动 scope。 */
  function readActiveContext() {
    return activeContext
  }

  /** injection 与其它模块共享的 deps。 */
  const deps = {
    store,
    logger,
    dshHome,
    presetsRoot,
    getConfig: () => resolveConfig(config),
    resolveScope,
    async loadScope(agent) {
      const scope = await resolveScope(agent)
      if (scope !== undefined) {
        activeContext = {
          presetId: scope.presetId,
          projectRoot: scope.projectRoot,
          projectName: scope.projectName,
        }
      }
      return scope
    },
    readActiveContext,
    isSubagent: isSubagentAgent,
    currentRoute: (agent) => currentRoute(ctx, agent),
  }

  // 整理执行器需要 tools / commands / routes 共用。
  let digestRunner
  try {
    digestRunner = createDigestRunner(ctx, deps)
  } catch (error) {
    logger.warn?.('supermemory: digest runner unavailable: %o', error)
    digestRunner = undefined
  }
  deps.runDigest = (request) =>
    digestRunner === undefined
      ? Promise.resolve({ at: new Date().toISOString(), ok: false, error: 'digest runner unavailable' })
      : digestRunner.runDigest(request)

  /** 安装一个能力，失败只告警不阻断其它能力。 */
  const install = (label, factory) => {
    let dispose
    try {
      dispose = factory()
    } catch (error) {
      logger.warn?.('supermemory: %s install failed: %o', label, error)
      return
    }
    if (typeof dispose !== 'function') return
    ctx.effect(() => () => {
      try {
        dispose()
      } catch (error) {
        logger.warn?.('supermemory: %s dispose failed: %o', label, error)
      }
    })
  }

  install('injection', () => installInjection(ctx, deps))
  install('tools', () => installTools(ctx, deps))
  install('commands', () => installCommands(ctx, deps))
  install('digest', () => digestRunner?.install())
  install('routes', () => installRoutes(ctx, deps))

  ctx.effect(() => () => {
    activeContext = null
    void store.dispose()
  })
}
