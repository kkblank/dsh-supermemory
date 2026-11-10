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
  // v2：人设根目录（函数名保留 v1 兼容名，返回的是 $DSH_HOME/supermemory/personas）。
  const personasRoot = resolvePresetsRoot(resolved, dshHome)
  const logger = ctx.logger ?? { warn: () => {}, info: () => {} }

  const store = createStore({ dshHome, personasRoot, config: resolved, logger })

  // v2：全新安装时自动建一个默认人设，否则面板里的人设下拉会是空的。
  // 失败只告警：没有人设时 resolveScope 仍会回退 'default'，记忆照常工作。
  void (async () => {
    try {
      await store.ready
      const existing = await store.listPersonas()
      if (Array.isArray(existing) && existing.length > 0) return
      const created = await store.createPersona('Default')
      if (created?.ok === true) {
        await store.setCurrentPersona(created.persona.slug)
      } else {
        logger.warn?.('supermemory: default persona init failed: %o', created)
      }
    } catch (error) {
      logger.warn?.('supermemory: default persona init failed: %o', error)
    }
  })()

  /** 最近一次 pre-step 解析出的活动上下文，供 HTTP bootstrap 使用。 */
  let activeContext = null

  /**
   * 解析一个 agent 的记忆作用域。
   *
   * v2：人格/画像/全局记忆按「当前人设」隔离（全局单一，面板切换），
   * 不再按 agent preset 隔离；项目记忆仍按项目根隔离。
   *
   * @param agent - 宿主 Agent。
   * @returns { persona, presetId, presetSlug, projectRoot, projectName, reason } 或 undefined。
   */
  async function resolveScope(agent) {
    const session = agent?.session
    if (session === undefined) return undefined

    let persona = 'default'
    try {
      const current = store.currentPersona()
      if (current !== null && typeof current?.slug === 'string' && current.slug !== '') {
        persona = current.slug
      }
    } catch (error) {
      logger.warn?.('supermemory: currentPersona failed: %o', error)
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
      persona,
      presetId: persona, // 兼容字段：v1 的调用方仍读 presetId
      presetSlug: presetSlug(persona),
      projectRoot: root,
      projectName,
      reason,
    }
  }

  /**
   * 列出当前已配置的可用模型（供整理器选择）。
   *
   * 数据源是两个宿主任意可选服务：`llm.listProviders()` 给出路由，
   * `llm.listModels(provider)` 从各 adapter 的配置目录取模型（无需网络）。
   * 单个 provider 抛错（如缺凭据）只跳过它，不影响其它 provider。
   *
   * @returns {Promise<Array<{ provider:string, id:string, name:string, label:string }>>}
   */
  async function listModels() {
    const llm = optional(ctx, 'llm')
    if (llm === undefined || typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function') {
      return []
    }
    let providers
    try {
      providers = llm.listProviders()
    } catch (error) {
      logger.warn?.('supermemory: listProviders failed: %o', error)
      return []
    }
    const models = []
    for (const provider of Array.isArray(providers) ? providers : []) {
      const providerId = typeof provider?.id === 'string' ? provider.id : ''
      if (providerId === '') continue
      const providerName = typeof provider?.name === 'string' && provider.name !== '' ? provider.name : providerId
      let listed
      try {
        listed = await llm.listModels(providerId)
      } catch (error) {
        logger.warn?.('supermemory: listModels(%s) failed: %o', providerId, error)
        continue
      }
      for (const model of Array.isArray(listed) ? listed : []) {
        const id = typeof model?.id === 'string' ? model.id : ''
        if (id === '') continue
        const name = typeof model?.name === 'string' && model.name !== '' ? model.name : id
        models.push({ provider: providerId, id, name, label: `${providerName} / ${name}` })
      }
    }
    return models
  }

  /**
   * 列出当前工作区里已注册的项目（项目记忆自动跟随，不再手动添加）。
   *
   * @returns {Promise<Array<{ path:string, name:string, id?:string }>>}
   */
  async function listWorkspaceProjects() {
    const registry = optional(ctx, 'workspaceRegistry')
    if (registry === undefined || typeof registry.list !== 'function') {
      // 退化：至少返回当前活动项目，避免面板空白。
      if (activeContext !== null && typeof activeContext.projectRoot === 'string') {
        return [{ path: activeContext.projectRoot, name: activeContext.projectName ?? '' }]
      }
      return []
    }
    let workspaces
    try {
      workspaces = registry.list()
    } catch (error) {
      logger.warn?.('supermemory: workspaceRegistry.list failed: %o', error)
      return []
    }
    const projects = []
    for (const workspace of Array.isArray(workspaces) ? workspaces : []) {
      const path = typeof workspace?.path === 'string' ? workspace.path : ''
      if (path === '') continue
      const name = typeof workspace?.title === 'string' && workspace.title !== '' ? workspace.title : projectDisplayName(path)
      projects.push({ path, name, id: workspace?.id })
    }
    return projects
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
    // v2 人设根；`presetsRoot` 保留为 v1 兼容字段。
    personasRoot,
    presetsRoot: personasRoot,
    getConfig: () => resolveConfig(config),
    resolveScope,
    async loadScope(agent) {
      const scope = await resolveScope(agent)
      if (scope !== undefined) {
        activeContext = {
          persona: scope.persona,
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
    /** 可用模型列表（整理器模型选择器的数据源）。 */
    listModels,
    /** 当前工作区已注册的项目（项目记忆自动同步）。 */
    listProjects: listWorkspaceProjects,
    /** 人设 API 直通 store（routes 用）。 */
    personas: {
      list: () => store.listPersonas(),
      current: () => store.currentPersona(),
      create: (name) => store.createPersona(name),
      select: (slug) => store.setCurrentPersona(slug),
    },
    /** 插件设置（整理模型）直通 store。 */
    settings: {
      read: () => store.readSettings(),
      write: (patch) => store.writeSettings(patch),
    },
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
