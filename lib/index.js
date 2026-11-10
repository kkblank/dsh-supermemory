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
 * 是否「默认人设」的 slug，**大小写不敏感**（契约 §V6.0）。
 *
 * 与 `lib/core/store.js` 的 `isDefaultSlug`、`lib/client.js` 的同名判定**逐字一致**（§V6.3）：
 * 三者不能漂移——store 与 client 天生无法共享代码（client 是宿主单文件加载），这里也不
 * 为一份判定去扩 store 的导出面，宁可留第三份逐字实现并用注释钉住。
 * 历史环境的存量数据是大写 `Default`，退回逐字比小写就等于让默认人设可删（v5 的真实误删）。
 *
 * @param {unknown} slug - 人设 slug。
 * @returns {boolean} 是否默认人设。
 */
function isDefaultPersonaSlug(slug) {
  return typeof slug === 'string' && slug.toLowerCase() === 'default'
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
 * 保证注册表里存在默认人设（契约 §V6.2）。
 *
 * v6 的两处关键变化：
 *   1. 条件从「列表为空」改成「列表里没有默认人设」——legacy 迁移后列表非空却没有默认
 *      人设时也要补建，否则 current 会永远指向一个不存在的 slug（§V5.8 第 2 条）。
 *   2. slug 取小写 `default`，与 `personaKey` / `personaSlug` / `resolveScope` /
 *      `resolveTargets` 的兜底键同名，`personas/default/` 与 `personas/Default/` 两个
 *      目录的裂口从此消失（§V6.0）；显示名再用 renamePersona 设回 `Default`，面板上
 *      那一行看起来完全没变。
 *
 * **补建绝不接管 current**：只有 current 为空、或指向一个注册表里不存在的 slug（悬空）时
 * 才设成默认人设。存量用户此刻正用 `工作` 这类人设干活，后台把 current 换掉等于人格被劫持，
 * 而且没有任何提示。
 *
 * 全程不抛：任何失败只告警（铁律：宿主服务异常必须静默降级）。抽成导出函数而不是
 * fire-and-forget 的 IIFE，是为了让测试能 await 它——apply 里的调用形态不变。
 *
 * @param {object} store - createStore 实例。
 * @param {{ warn?: Function, info?: Function }} [logger] - 日志器，可缺失。
 * @returns {Promise<{ created: boolean, tookOverCurrent: boolean, slug: string, reason: string }>}
 *   结果摘要。`reason` 区分两种「没建」：`'has-default'`（判定命中，本来就有默认人设）与
 *   `'create-failed'` / `'error'`（想建但没成）——两者从磁盘状态看一模一样，只靠返回值区分。
 *   建成功时 `reason` 为空串。
 */
export async function ensureDefaultPersona(store, logger) {
  const warn = (message, detail) => {
    try { logger?.warn?.('supermemory: %s: %o', message, detail) } catch { /* 日志失败不影响业务 */ }
  }
  const outcome = { created: false, tookOverCurrent: false, slug: '', reason: '' }
  try {
    await store.ready
    const existing = await store.listPersonas()
    const personas = Array.isArray(existing) ? existing : []
    if (personas.some((item) => isDefaultPersonaSlug(item?.slug))) {
      outcome.reason = 'has-default'
      return outcome
    }
    const current = store.currentPersona()
    // current 是否还指着一个人设：null = 没有 current；有条目 = 用户正在用它，不许动。
    const tookOver = current === null || !personas.some((item) => item?.slug === current.slug)
    const created = await store.createPersona('default')
    if (created?.ok !== true) {
      outcome.reason = 'create-failed'
      warn('default persona init failed', created)
      return outcome
    }
    outcome.created = true
    outcome.slug = created.persona.slug
    // 显示名是次要的：失败只告警，不回滚——slug 已经对了。
    const renamed = await store.renamePersona(outcome.slug, 'Default')
    if (renamed?.ok !== true) warn('default persona rename failed', renamed)
    if (tookOver) {
      const switched = await store.setCurrentPersona(outcome.slug)
      if (switched?.ok !== true) warn('default persona set-current failed', switched)
      else outcome.tookOverCurrent = true
    }
  } catch (error) {
    outcome.reason = 'error'
    warn('default persona init failed', error)
  }
  return outcome
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
  // v6：判定与建法见 ensureDefaultPersona（§V6.2）；这里保持 fire-and-forget 的调用形态不变，
  // 函数本身抽到模块顶层导出，是为了让测试能 await 而不是轮询 + 静置固定窗口。
  void ensureDefaultPersona(store, logger)

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
      // v5（契约 §V5.3）：rename 只改显示名，slug 与磁盘目录不变；remove 连同该人设目录一并删除。
      rename: (slug, name) => store.renamePersona(slug, name),
      remove: (slug) => store.deletePersona(slug),
    },
    /** 插件总开关（settings.json 的 enabled）；任何读取异常都回退 true，绝不因读盘失败把插件关掉。 */
    isEnabled: () => {
      try {
        return store.readSettings().enabled !== false
      } catch {
        return true
      }
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
