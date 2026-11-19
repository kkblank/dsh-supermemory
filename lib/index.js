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
import { createSessionPersonas, SESSION_MAP_FILE } from './core/session-personas.js'
import { presetSlug, projectDisplayName, resolveProjectRoot } from './core/paths.js'
import { entryRows, usageSummary } from './core/usage.js'
import { parseEntries } from './core/document.js'
import { getSharedUsageStore } from './host/usage.js'
import { installInjection } from './host/inject.js'
import { installTools } from './host/tools.js'
import { installExpertTool } from './host/tools-expert.js'
import { createDelegationLog } from './host/delegations.js'
import { installCommands } from './host/commands.js'
import { createDigestRunner } from './host/digest.js'
import { installRoutes } from './host/routes.js'

export { Config }

/** 插件名，必须与包名一致。 */
export const name = 'supermemory'

/**
 * `webServer` 是**硬依赖**，必须显式声明，不能靠 `ctx.get` 现场捞。
 *
 * `ctx.get(name)` 的契约是「只返回 provider fiber 当前 active 的实现，否则返回
 * undefined」（见 cordis `Context.get`）。所以捞得到捞不到取决于 bundle 顺序：
 * 一旦本插件被排到 webServer 之前激活，捞回来就是 undefined，于是 8 条 HTTP 路由
 * **一条都不注册**且永不重试——面板全部 404，而插件 fiber 仍显示 active，看起来
 * 就像"插件没加载"。实际踩过：安装时 loader 把 `@linxin666/dsh-web-all` 挪到
 * bundles 末尾，本插件被排到 webServer 之前，症状即整面板 404。
 * 声明进 inject 后时序由框架兜住（官方 `dsh-client-hmr` 同样把 webServer 写在
 * inject 里）。
 *
 * 代价：没有 webServer 的 profile 里本插件不再激活。其余宿主服务（llm / tools /
 * session / workspaceRegistry 等）仍旧全部走 `ctx.get` 可选获取，缺失时降级。
 */
export const inject = ['webServer']

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
 * 委派记录文件名（契约 §V13.1）。
 *
 * 与 `personas/`、`session-personas.json` 平级，落在 `$DSH_HOME/supermemory/` 下：
 * 它记录的是「谁把什么交给了谁」，跨人设存在，不属于任何单一人设目录。
 */
export const DELEGATIONS_FILE = 'delegations.jsonl'

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
 * 记忆注入档位的**纯判定**（契约 §V13.2）。
 *
 * 抽成模块级纯函数而不是闭包内联，是为了让判定表能被单独测到——这段条件
 * 同时决定人格 section 与记忆快照两条链路，判错的代价是「人格在、记忆没了」
 * 或反过来，两者都很难从现象反推原因。
 *
 * 判据顺序（先短路，后面的条件不再求值）：
 *   1. 配置文件 `enabled: false`（硬开关）→ `none`
 *   2. settings.json 软开关关闭 → `none`
 *   3. 非子智能体 → `full`
 *   4. 子智能体 + 会话绑定了人设（专家）→ `injectIntoExpertSubagents`（默认 true）
 *   5. 子智能体 + 无绑定（普通子代理）→ `injectIntoSubagents`（默认 false）
 *
 * **键缺失时的兜底方向必须与 `config.js` 的默认值一致**：两个键的默认值不同
 * （普通子代理 false、专家 true），所以不能统一用 `!== false` 或 `=== true` 一种写法，
 * 否则 `config` 缺键时会得出与真实配置相反的结论。正常链路里 `resolveConfig`
 * 总会填上显式布尔，这里的兜底只服务于直接调用纯函数的场合。
 *
 * @param {{config?: object, pluginEnabled?: boolean, subagent?: boolean, boundPersona?: string}} input
 *   `config` 是 resolveConfig 的结果；`pluginEnabled` 是软开关（缺失视为开启）；
 *   `subagent` 是否子智能体；`boundPersona` 该会话绑定的人设 slug（无绑定为 undefined/空串）。
 * @returns {'full' | 'none'} 注入档位。
 */
export function resolveInjectionTier(input = {}) {
  const config = input.config ?? {}
  if (config.enabled === false) return 'none'
  if (input.pluginEnabled === false) return 'none'
  if (input.subagent !== true) return 'full'
  const bound = input.boundPersona
  if (typeof bound === 'string' && bound !== '') {
    return config.injectIntoExpertSubagents === false ? 'none' : 'full'
  }
  return config.injectIntoSubagents === true ? 'full' : 'none'
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

  /**
   * 会话级人设映射（契约 §V9.2）。
   *
   * 放在 `$DSH_HOME/supermemory/` 下，与 `personas/` 平级而不是塞进 persona 目录：
   * 这条映射描述的是「哪个会话用哪个人设」，跨人设存在，不属于任何单一人设。
   *
   * 构造即开始异步加载；加载完成前 `get()` 返回 undefined，等于「跟随全局」，
   * 是最安全的降级——宁可让人格多走一次全局，也不能因为读盘慢而卡住系统提示装配。
   */
  const sessionPersonas = createSessionPersonas({
    filePath: join(dshHome, 'supermemory', SESSION_MAP_FILE),
    logger,
  })

  /**
   * 委派记录（契约 §V13）：`$DSH_HOME/supermemory/delegations.jsonl`。
   *
   * 与 session-personas.json 平级：它记录的是「谁把什么交给了谁」，
   * 跨人设存在，不属于任何单一人设目录。
   */
  const delegationLog = createDelegationLog({
    filePath: join(dshHome, 'supermemory', DELEGATIONS_FILE),
    logger,
    keep: resolveConfig(config).delegateLogKeep,
  })

  // v2：全新安装时自动建一个默认人设，否则面板里的人设下拉会是空的。
  // v6：判定与建法见 ensureDefaultPersona（§V6.2）；这里保持 fire-and-forget 的调用形态不变，
  // 函数本身抽到模块顶层导出，是为了让测试能 await 而不是轮询 + 静置固定窗口。
  void ensureDefaultPersona(store, logger)

  /** 最近一次 pre-step 解析出的活动上下文，供 HTTP bootstrap 使用。 */
  let activeContext = null

  /**
   * **同步**解析某个 agent 当前生效的人设（契约 §V9.3 / §V10.1）。
   *
   * 为什么必须是同步、且必须按 agent 现算：
   *   `systemPrompt.section` 的 `text(assembly)` 回调是**同步执行**的，不能 await；
   *   而宿主的调用顺序是「先 assemble（section 在这里跑），后 agent/pre-step」，
   *   所以任何「在 pre-step 里缓存下来供 section 读」的方案都必然慢一轮。
   *   更糟的是缓存是模块级单变量，多会话交替时会互相覆盖——实测出现过整场对话
   *   注入了别的会话人格的情况。唯一正确做法是每次按当前 agent 现算。
   *
   * 全程只调用同步 API（currentPersona / listPersonas / sessionPersonas.get），
   * 所以可以在 section 回调里直接跑。任何异常都降级成「跟随全局」，绝不抛。
   *
   * @param agent - 宿主 Agent（section 回调里是 `assembly.agent`）。
   * @returns {{ persona: string, personaSource: 'session'|'global' }} 人设与来源。
   */
  function resolvePersonaSync(agent) {
    let persona = 'default'
    try {
      const current = store.currentPersona()
      if (current !== null && typeof current?.slug === 'string' && current.slug !== '') {
        persona = current.slug
      }
    } catch (error) {
      logger.warn?.('supermemory: currentPersona failed: %o', error)
    }

    let personaSource = 'global'
    try {
      const sessionId = typeof agent?.session?.id === 'string' ? agent.session.id : ''
      const bound = sessionId === '' ? undefined : sessionPersonas.get(sessionId)
      if (typeof bound === 'string' && bound !== '') {
        // 绑定的人设可能已经被删了。直接用会让 readDoc 全部落空——人格与全局记忆
        // 一起变成空串，模型看到的是「这个人设是哑的」，而不是「本该跟随全局」。
        // listPersonas 是同步的，可以在这里验证。
        const listed = store.listPersonas()
        const alive = (Array.isArray(listed) ? listed : []).some((item) => item?.slug === bound)
        if (alive) {
          persona = bound
          personaSource = 'session'
        } else {
          // 僵尸绑定：本轮回退全局并异步清掉，免得以后每轮都白查一次注册表。
          logger.warn?.('supermemory: 会话 %s 绑定的人设 %s 已不存在，回退全局', sessionId, bound)
          void sessionPersonas.removePersona(bound)
        }
      }
    } catch (error) {
      logger.warn?.('supermemory: session persona lookup failed: %o', error)
    }

    return { persona, personaSource }
  }

  /**
   * 该 agent 的记忆注入档位（契约 §V13.2）。
   *
   * **单一判定入口**：人格 section 与 pre-step 快照都只调这个函数，绝不各自再写一份
   * 条件。本项目在 v10 就吃过「两处判据漂移」的亏——人格 section 漏判子智能体，
   * 于是门控只在一半生效，表现是「记忆被拦住了，人格却没被拦住」。
   *
   * 三档：
   *   - `'full'`：人格（soul/user）与记忆快照（global/project）都注入。
   *   - `'none'`：都不注入。
   *   （历史设计里还留过 `'persona-only'`，当前没有调用方，故不引入。）
   *
   * 判据（按顺序）：
   *   1. 插件软开关关闭 → `'none'`（与改造前一致）。
   *   2. 非子智能体 → `'full'`。
   *   3. 子智能体 + 该会话**显式绑定了人设** = 专家子会话：由 `injectIntoExpertSubagents`
   *      决定。专家是被主管请来干专业活的，没有专长相关的记忆就等于白请，故默认 true。
   *   4. 子智能体 + 无绑定 = 普通子代理：由 `injectIntoSubagents` 决定，默认 false。
   *
   * 为什么用「有绑定」而不是「看父会话」来认专家：委派工具在起子 agent **之前**就写好了
   * 绑定（§V13.3 时序铁律），所以子 agent 一出生 `get()` 就能读到；而父会话链在冷恢复后
   * 未必还在，绑定才是耐久事实。
   *
   * @param agent - 宿主 Agent。
   * @returns {'full' | 'none'} 注入档位。任何异常都返回 `'full'`（宁可多注入）。
   */
  function memoryInjection(agent) {
    let resolvedConfig = {}
    try {
      resolvedConfig = resolveConfig(config) ?? {}
    } catch {
      resolvedConfig = {}
    }

    let bound = undefined
    try {
      const sessionId = typeof agent?.session?.id === 'string' ? agent.session.id : ''
      bound = sessionId === '' ? undefined : sessionPersonas.get(sessionId)
    } catch {
      bound = undefined
    }

    return resolveInjectionTier({
      config: resolvedConfig,
      pluginEnabled: depsIsEnabled(),
      subagent: isSubagentAgent(agent) === true,
      boundPersona: bound,
    })
  }

  /** 插件软开关的本地判定（与 deps.isEnabled 同口径，缺失视为开启）。 */
  function depsIsEnabled() {
    try {
      return store.readSettings().enabled !== false
    } catch {
      return true
    }
  }

  /**
   * 该 agent 当前生效人设是否为主管（契约 §V13.4）。
   *
   * 同步：委派工具的 `when` 门控与专家目录 section 都在同步上下文里调用它。
   * 判定口径与注入层一致——用 `resolvePersonaSync` 现算，绝不读缓存。
   *
   * @param agent - 宿主 Agent。
   * @returns {boolean} 是否主管。
   */
  function isSupervisorAgent(agent) {
    try {
      const supervisor = store.supervisorSync?.()
      const supervisorSlug = typeof supervisor?.slug === 'string' ? supervisor.slug : ''
      if (supervisorSlug === '') return false
      const resolved = resolvePersonaSync(agent)
      return resolved?.persona === supervisorSlug
    } catch (error) {
      logger.warn?.('supermemory: isSupervisorAgent failed: %o', error)
      return false
    }
  }

  /**
   * 解析一个 agent 的记忆作用域。
   *
   * v2：人格/画像/全局记忆按「当前人设」隔离（全局单一，面板切换），
   * 不再按 agent preset 隔离；项目记忆仍按项目根隔离。
   *
   * v9（契约 §V9.3）：人设取值改为「会话绑定优先，未绑定跟随全局」。
   * 分支会话不继承（普通 fork 的 header 不写 parentSession，无法可靠上溯），
   * 子智能体维持 `injectIntoSubagents` 的既有门控。
   *
   * @param agent - 宿主 Agent。
   * @returns { persona, personaSource, presetId, presetSlug, projectRoot, projectName, reason } 或 undefined。
   */
  async function resolveScope(agent) {
    const session = agent?.session
    if (session === undefined) return undefined

    const { persona, personaSource } = resolvePersonaSync(agent)

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
      // v9：本会话生效人设的来源。面板靠它区分「这个会话被单独指定了」与「跟随全局」。
      personaSource,
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
  /**
   * 读某项目的全部条目并按 id 建索引（面板热度回填与孤儿过滤用）。
   *
   * **只读项目记忆主文件**：热度是按条目 id 记的，而 id 只存在于 `project-memory.md` 里；
   * 同目录的 pitfalls.md 之类自建文件条目没有进过检索记账，读进来只是白花 IO。
   *
   * 任何异常都退回空 Map：热度是优化项，读不到正文时宁可整张表不显示，
   * 也不能让面板因为这个 500。
   *
   * @param {string} projectRoot - 项目根。
   * @returns {Promise<Map<string, { body: string, topic: string }>>} id → 条目。
   */
  async function projectEntriesById(projectRoot) {
    const out = new Map()
    try {
      const doc = await store.readDoc({ kind: 'project', projectRoot })
      const text = typeof doc?.content === 'string' ? doc.content : ''
      for (const entry of parseEntries(text)) {
        if (typeof entry?.id !== 'string' || entry.id === '') continue
        out.set(entry.id, {
          body: typeof entry.body === 'string' ? entry.body : '',
          topic: typeof entry.topic === 'string' ? entry.topic : '',
        })
      }
    } catch (error) {
      logger?.warn?.('supermemory: project entry lookup failed: %o', error)
    }
    return out
  }

  const deps = {
    store,
    logger,
    dshHome,
    // v2 人设根；`presetsRoot` 保留为 v1 兼容字段。
    personasRoot,
    presetsRoot: personasRoot,
    getConfig: () => resolveConfig(config),
    resolveScope,
    /**
     * 同步人设解析（契约 §V10.1）：供 `systemPrompt.section` 的同步 text 回调使用。
     *
     * 这是 v10 修复「会话人设串台」的核心接口：section 不能再读模块级缓存，
     * 必须按传入的 agent 现场算。
     */
    resolvePersonaSync,
    async loadScope(agent) {
      const scope = await resolveScope(agent)
      if (scope !== undefined) {
        activeContext = {
          persona: scope.persona,
          personaSource: scope.personaSource,
          presetId: scope.presetId,
          projectRoot: scope.projectRoot,
          projectName: scope.projectName,
        }
      }
      return scope
    },
    readActiveContext,
    isSubagent: isSubagentAgent,
    /**
     * 记忆注入档位（契约 §V13.2）：注入层的人格 section 与 pre-step 快照共用这一个判定，
     * 绝不在两处各写一份条件。
     */
    memoryInjection,
    /** 该 agent 当前生效人设是否为主管（契约 §V13.4）；委派工具门控与专家目录用。 */
    isSupervisorAgent,
    /**
     * 专家目录的同步数据面（契约 §V13.4）。
     *
     * 必须同步：`systemPrompt.section` 的 `text` 回调不能 await。数据源是 store 的
     * 同步 API（`listPersonas` / `supervisorSync`），两者都只读构造期已加载的内存态。
     */
    experts: {
      list: () => {
        try {
          const listed = store.listPersonas()
          return (Array.isArray(listed) ? listed : []).map((item) => ({
            slug: item?.slug,
            name: item?.name,
            expertise: item?.expertise ?? '',
            supervisor: item?.supervisor === true,
          }))
        } catch (error) {
          logger.warn?.('supermemory: experts.list failed: %o', error)
          return []
        }
      },
      supervisor: () => {
        try {
          const value = store.supervisorSync?.()
          return value === null || value === undefined ? null : { slug: value.slug, name: value.name }
        } catch (error) {
          logger.warn?.('supermemory: experts.supervisor failed: %o', error)
          return null
        }
      },
      setSupervisor: (slug) => store.setSupervisor?.(slug),
      setExpertise: (slug, text) => store.setExpertise?.(slug, text),
    },
    /** 委派记录（契约 §V13.5）：面板的「最近委派」数据源。 */
    delegations: {
      recent: (limit) => delegationLog.recent(limit),
    },
    currentRoute: (agent) => currentRoute(ctx, agent),
    /** 可用模型列表（整理器模型选择器的数据源）。 */
    listModels,
    /**
     * 整理器的主题热度来源（契约 §V8.8）：整编输入据此提示「谁该升 core、谁该降 cold」。
     * 形状 `({ projectRoot }) => Array<{ name, hits }>`，digest 侧缺失或异常都按无热度照跑。
     *
     * 必须用 `load()` 而不是 `peek()`：`peek` 只看内存态，而整编很可能在插件刚启动、
     * 或由 `/memory-digest` 手动触发时跑——那时该项目的分片还没被 search/预取加载过，
     * `peek` 返回空统计，晋升降级回路就静默失效（没有任何报错）。`load()` 走队列读盘，
     * 加载过一次即复用，代价只是一次文件读。
     *
     * options 与 inject.js / tools.js 侧保持一致：三者共用 `getSharedUsageStore` 的同一单例，
     * 各自持有一份内存态会互相覆盖同一个 usage.json。
     */
    topicUsage: async ({ projectRoot } = {}) => {
      const usageStore = getSharedUsageStore({ docPathRef: store.docPath, logger })
      // 取全量 topicRows，不取 hottest：hottest 截前 10 是给面板的热点视图，
      // 而整编拿它当降级依据会误杀「有热度但没进前 10」的主题，且降级不可逆。
      //
      // v12：传 now 让每行带上 `ageDays`（距今天数）。只给命中数，模型分不出
      // 「昨天被搜过 12 次」和「去年被搜过 12 次」，而分层的全部意义就在时效。
      const loaded = await usageStore.load(projectRoot)
      return usageSummary(loaded, { now: Date.now() }).topicRows
    },
    /**
     * 条目级热度行（面板「主题热度」表的第二数据源，v12）。
     *
     * 为什么要单独一个入口：`usage.json` 的 `topics` 分区**只有在整理器建过主题表之后**
     * 才会有内容，而 `entries` 分区从第一次检索命中就在记。只读 `topicRows` 会让面板在
     * 「项目还没建主题表」时永远空白——本项目实测就是这个情形（18 条条目热度、0 个主题）。
     *
     * 与 `topicUsage` 一样共用 `getSharedUsageStore` 单例，保证两条链路读同一份内存态。
     *
     * @param {{ projectRoot?: string }} [options] - 项目根。
     * @returns {Promise<Array<{ id: string, hits: number, last: string, score: number, ageDays: number }>>} 条目热度行。
     */
    entryUsage: async ({ projectRoot } = {}) => {
      const usageStore = getSharedUsageStore({ docPathRef: store.docPath, logger })
      const loaded = await usageStore.load(projectRoot)
      // 回填正文并按 id 过滤孤儿：整编改写正文会让条目 id 换代，旧 id 的热度永远留在
      // usage.json 里。不回填的话面板只能显示一串看不懂的十六进制编号，而且数量会对不上
      // 「主题 N 个」——本项目实测 18 条热度里 14 条是这种孤儿。
      const byId = await projectEntriesById(projectRoot)
      return entryRows(loaded, { now: Date.now(), limit: 30, lookup: (id) => byId.get(id) ?? null })
    },
    /** 当前工作区已注册的项目（项目记忆自动同步）。 */
    listProjects: listWorkspaceProjects,
    /**
     * 会话级人设映射（契约 §V9.2）。
     *
     * 装配层直通给 routes / client 用。`remove` 包装里顺手清理僵尸绑定：
     * 人设被删除后，任何还指着它的会话绑定都必须失效，否则下次进那个会话
     * 会先按已删 slug 读一遍空文档，再回退全局——多一轮空注入，且日志噪音。
     * 清理失败只告警：绑定残留会在 resolveScope 那里被再次识别并回退。
     */
    sessionPersonas: {
      get: (sessionId) => sessionPersonas.get(sessionId),
      set: (sessionId, slug) => sessionPersonas.set(sessionId, slug),
      clear: (sessionId) => sessionPersonas.clear(sessionId),
      removePersona: (slug) => sessionPersonas.removePersona(slug),
    },
    /** 人设 API 直通 store（routes 用）。 */
    personas: {
      list: () => store.listPersonas(),
      current: () => store.currentPersona(),
      create: (name) => store.createPersona(name),
      select: (slug) => store.setCurrentPersona(slug),
      // v5（契约 §V5.3）：rename 只改显示名，slug 与磁盘目录不变；remove 连同该人设目录一并删除。
      rename: (slug, name) => store.renamePersona(slug, name),
      remove: async (slug) => {
        const removed = await store.deletePersona(slug)
        // 只在删除真的成功后再清绑定：失败时那个 slug 仍然有效，清了等于白白丢掉用户的选择。
        if (removed?.ok === true) {
          try {
            const cleared = await sessionPersonas.removePersona(slug)
            if (cleared?.ok === true && cleared.cleared > 0) {
              logger.info?.('supermemory: 已清理 %d 个指向已删人设 %s 的会话绑定', cleared.cleared, slug)
            }
          } catch (error) {
            logger.warn?.('supermemory: 清理会话人设绑定失败: %o', error)
          }
        }
        return removed
      },
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

  /**
   * 启动时报告「专家能否开分身」这一部署前提（契约 §V13.12）。
   *
   * 只写日志、不改行为：这是**观测**，不是门控。检测不到（服务缺失）时静默——
   * 那种情况说明宿主形态不同，警告只会变成噪声。
   *
   * @param {object} context - cordis Context。
   * @param {object} log - logger。
   */
  function reportSpawnCapability(context, log) {
    try {
      const tools = context?.get?.('tools')
      if (tools === undefined || tools === null || typeof tools.get !== 'function') return
      // 不带 scope 查的是全局视图：足以判断「这个部署到底有没有装 subagent 工具」。
      const present = tools.get('subagent') !== undefined
      if (present === true) return
      log?.warn?.(
        'supermemory: `subagent` tool is not enabled — experts cannot spawn their own subagents. ' +
          'Enable `tool-subagent` and set `maxDepth` >= 2 to restore this capability.',
      )
    } catch (error) {
      log?.warn?.('supermemory: spawn capability probe failed: %o', error)
    }
  }

  install('injection', () => installInjection(ctx, deps))
  install('tools', () => installTools(ctx, deps))
  // 委派工具（契约 §V13.6）：服务缺失时它自己返回空 dispose，不阻断其它能力。
  install('expert-tool', () => installExpertTool(ctx, deps))
  // 部署体检（契约 §V13.12）：专家开分身依赖宿主启用 `tool-subagent`，缺了不报错、
  // 只是静默不可用。启动时留一条日志，让排查有据可查（面板提示见 §V13.12 的注入侧）。
  reportSpawnCapability(ctx, logger)
  install('commands', () => installCommands(ctx, deps))
  install('digest', () => digestRunner?.install())
  install('routes', () => installRoutes(ctx, deps))

  ctx.effect(() => () => {
    activeContext = null
    void sessionPersonas.dispose()
    void delegationLog.dispose()
    void store.dispose()
  })
}
