/**
 * dsh-supermemory HTTP 路由与信任栅栏。
 *
 * 路由前缀在源码层写作 **document-relative** 的 `api/dsh-supermemory`（不带前导 `/`），
 * 浏览器侧 `fetch('api/dsh-supermemory/...')` 直接使用该形态；注册到宿主
 * `webServer` 时补前导 `/`，因为宿主按 `new URL(req.url).pathname` 精确匹配，
 * pathname 恒以一个斜杠开头（见 dsh-host-webserver `match()`）。
 *
 * 安全模型（契约 §5.5）：
 *   - 只接受 loopback socket；任何代理标记 / `sec-fetch-site: cross-site` / 异源 Origin 直接拒绝。
 *   - Host 头必须是 loopback authority（防 DNS rebinding）。
 *   - 所有路径参数只经 store 的 ref 校验，绝不接受任意路径。
 *   - 请求体上限 1 MiB，超限 413。
 *
 * v2（契约 §V2.4）：
 *   - `bootstrap` 结构变更：personas / currentPersona / projects / active / config /
 *     digestSettings / presetsRoot / dshHome。
 *   - 新增 `models`（GET）、`settings`（PUT）、`personas`（GET/POST/PUT）。
 *   - doc / digest 的隔离键从 `presetId` 改为 `persona`（旧参数名仍兼容）。
 *   - 项目列表来自 `deps.listProjects()`（工作区自动同步），不再接受客户端传项目路径。
 *
 * v3（插件总开关，契约 §V3）：
 *   - `deps.isEnabled`（`() => boolean`，由装配层提供）是软开关的唯一判定入口。
 *   - **判定一律写成 `deps?.isEnabled?.() === false` 才拦截**：装配层没提供、或调用抛错，
 *     都视为「开启」。这样既容错，也不破坏既有 mock deps 的测试。
 *   - 关闭时只有 `POST digest` 被拦（409 `PLUGIN_DISABLED`）；bootstrap / doc / personas /
 *     settings / runs / models **一律不拦**——面板必须永远进得去，否则关掉就再也打不开。
 *
 * v8（分层记忆，契约 V8.11 的服务端部分）：
 *   - `GET doc` 在 scope=project 时多返回一个 `tiering`，**只含盘上事实**（core / cold 条数、
 *     主题数、盘上字节），从文件现算，任何情况下都给得出。
 *     注入侧的估算值已按主人要求整体撤除（契约 V8.16 第 1 条）：现场重算没有 usage 与总预算，
 *     与真实那一轮注入对不上，报出去会被当成结论用。
 *   - `bootstrap.config` 增加 `tieredInjection` / `projectCoreMaxBytes` / `projectIndexMaxBytes`。
 *
 * 文件拆分（单文件 ≤400 行的规范约束，行为零变化）：
 *   - `trust.js`    信任栅栏纯函数；`isTrustedRequest` 由本文件 re-export，保持测试的原导入路径。
 *   - `http.js`     请求体读取与统一 JSON 响应写出。
 *   - `params.js`   scope / persona / projectRoot 校验与响应值归一化。
 *   - `access.js`   deps / store 的安全访问层（原 installRoutes 闭包内的辅助函数）。
 *   - `routes-digest.js`   POST digest + GET runs。
 *   - `routes-settings.js` GET models + PUT settings + personas 三件套。
 *   - 本文件保留：路由表与装配 / dispose，以及 bootstrap、doc 两个核心接口。
 * @module dsh-supermemory/host/routes
 */

import { byteLength, parseEntries } from '../core/document.js'
import { parseTopicIndex } from '../core/topics.js'
import { createAccess } from './access.js'
import { guard, paramOf, queryOf, readJsonBody, sendError, sendJson, sendOk } from './http.js'
import { absolutePath, buildRef, extractTitle, resolveWritableScopes } from './params.js'
import { createDigestHandlers } from './routes-digest.js'
import { createSessionPersonaHandlers } from './routes-session-persona.js'
import { createSettingsHandlers } from './routes-settings.js'

// 测试与外部调用方沿用原路径：信任栅栏已搬到 trust.js，这里保持导出面不变。
export { isTrustedRequest } from './trust.js'

/** document-relative 前缀（不带前导斜杠）。 */
const ROUTE_PREFIX = 'api/dsh-supermemory'

/** 各接口的 document-relative 路径。 */
const ROUTES = Object.freeze({
  bootstrap: `${ROUTE_PREFIX}/bootstrap`,
  doc: `${ROUTE_PREFIX}/doc`,
  digest: `${ROUTE_PREFIX}/digest`,
  runs: `${ROUTE_PREFIX}/runs`,
  models: `${ROUTE_PREFIX}/models`,
  settings: `${ROUTE_PREFIX}/settings`,
  personas: `${ROUTE_PREFIX}/personas`,
  // v9（契约 §V9.4）：会话级人设绑定。GET 读本会话生效人设，PUT 绑定 / 解除绑定。
  sessionPersona: `${ROUTE_PREFIX}/session-persona`,
})

/**
 * 安装全部 HTTP 路由。
 * @param {object} ctx - cordis Context。
 * @param {object} deps - 装配层依赖。
 * @returns {() => void} dispose。
 */
export function installRoutes(ctx, deps) {
  const logger = deps?.logger ?? ctx?.logger ?? { warn() {}, info() {} }

  // `webServer` 已写进入口的 inject，正常路径下它就在 ctx 上；`ctx.get` 只作为
  // 直接调用本函数（单测、或宿主注入方式变动）时的兜底。
  let webServer = ctx?.webServer
  if (webServer === undefined || webServer === null) {
    try {
      webServer = ctx?.get?.('webServer')
    } catch {
      webServer = undefined
    }
  }

  // 降级只意味着"不抛错"，不意味着"不吭声"：这里曾经过于安静，导致路由整批没注册
  // 而宿主日志一片干净，排查只能从 HTTP 404 反推。缺 webServer 要留下明确一行。
  if (webServer === undefined || webServer === null) {
    logger.warn?.('supermemory: webServer 不可用，面板的 8 条 HTTP 路由未注册（记忆注入不受影响）')
    return () => {}
  }

  const store = deps?.store

  const access = createAccess({ deps, logger, store })
  const { readConfig, pluginEnabled, safeCall, readDigestSettings, personasData } = access

  const { handleDigest, handleRuns } = createDigestHandlers({ ctx, deps, store, access })
  const { handleModels, handleSettings, handlePersonas } = createSettingsHandlers({ deps, access })
  const { handleSessionPersona } = createSessionPersonaHandlers({ deps, access })

  /** GET bootstrap（v2 新结构）。 */
  async function handleBootstrap(req, res) {
    if (!guard(req, res)) return
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendError(res, 405, 'method not allowed', 'METHOD_NOT_ALLOWED')
      return
    }
    const config = readConfig()
    const { personas, current } = await personasData()
    const projects = await safeCall(() => deps?.listProjects?.(), [])
    let active = null
    try {
      // 契约 §V2.4 写作 deps.activeContext()，装配层实际提供 readActiveContext()；两者都兼容。
      const reader = deps?.readActiveContext ?? deps?.activeContext
      active = typeof reader === 'function' ? reader() : null
    } catch {
      active = null
    }
    sendOk(res, {
      // v3：面板靠它决定「关闭态」提示与按钮禁用；任何情况下都不因关闭而拒绝本次请求。
      enabled: pluginEnabled(),
      personas,
      currentPersona: current,
      projects: (Array.isArray(projects) ? projects : []).map((project) => ({
        path: project?.path ?? project?.root,
        name: project?.name,
      })),
      active:
        active === null || active === undefined
          ? null
          : {
              persona: active.persona ?? active.presetId,
              projectRoot: active.projectRoot,
              projectName: active.projectName,
            },
      config: {
        systemPromptMaxBytes: config.systemPromptMaxBytes,
        injectMaxBytes: config.injectMaxBytes,
        autoDigest: config.autoDigest,
        digestEveryTurns: config.digestEveryTurns,
        digestPressureRatio: config.digestPressureRatio,
        digestWritableScopes: resolveWritableScopes(config),
        projectDirName: config.projectDirName,
        projectFileName: config.projectFileName,
        // v8（契约 V8.11）：面板要知道分层注入开没开、两段预算各是多少。配置项缺失时
        // JSON 里干脆没有这个键，面板按「后端不认这个开关」降级，而不是当成 false。
        tieredInjection: config.tieredInjection,
        projectCoreMaxBytes: config.projectCoreMaxBytes,
        projectIndexMaxBytes: config.projectIndexMaxBytes,
      },
      digestSettings: await readDigestSettings(),
      presetsRoot: deps?.personasRoot ?? deps?.presetsRoot,
      dshHome: deps?.dshHome,
    })
  }

  /**
   * GET /doc 的分层概览（契约 V8.11）。
   *
   * 面板要显示「常驻几条 / 冷层几条 / 几个主题 / 盘上多大」。这些数字**一律由服务端现算**：
   * 条目头的段序规则（契约 V8.2）只住在 `entry-format.js` 一处，让面板自己数文本等于把解析器
   * 抄第二份，改格式时必然漂移。
   *
   * **只报盘上事实**（core / cold / topics / orphanTopics / docBytes）：它们只靠 `parseEntries` +
   * `parseTopicIndex` 从磁盘上的文件数出来，任何时候都给得出，包括分层注入关闭的时候。
   *
   * 曾经的「注入口径」（裁后条数、三段字节、被挤下去的 id）已按主人要求整体撤除：那是一份
   * **现场重算的估算**，重算时既没带 usage（排序退化成纯时间倒序）也没带 injectMaxBytes
   * （少了总预算降级），与那一轮真实注入可能对不上——而面板上对不上的数字会被当成结论用。
   * 真实注入了多少，唯一可信的途径是看那一轮的注入文本本身。
   *
   * @param {string} content - 文档内容。
   * @returns {object} 概览对象；任何一步失败都只是少给几个字段，不抛。
   */
  function tierOverview(content) {
    const overview = { core: 0, cold: 0, topics: 0, docBytes: byteLength(content) }
    try {
      const entries = parseEntries(content)
      const cold = entries.filter((entry) => entry?.tier === 'cold').length
      overview.core = entries.length - cold
      overview.cold = cold
      const table = parseTopicIndex(content)
      overview.topics = table.length
      // 孤儿主题＝主题表里没有任何条目在用的名字（契约 V8.8 的 orphanTopics 同义）。
      // **盘上现算，不去 runs.jsonl 捞上一轮整编的报告**：`tiering` 里其余字段都是此刻的盘上
      // 事实，混进一份旧报告会让两者看起来像同一个时刻，用户手改过文档就得到错误结论；
      // 而且现算不需要解 JSONL、也不依赖整编跑过没有。
      // 主题表不存在时**省略这个字段，绝不报空数组**：空数组会被读成「整编查过，没有孤儿」，
      // 而真实情况是「根本没有主题表，谁也没查过」——与「拿不到就省略不报 0」同一条纪律。
      if (table.length > 0) {
        const used = new Set()
        for (const entry of entries) {
          if (typeof entry?.topic === 'string' && entry.topic !== '') used.add(entry.topic)
        }
        overview.orphanTopics = table.map((topic) => topic.name).filter((name) => !used.has(name))
      }
    } catch (error) {
      logger.warn?.('supermemory: tier overview failed: %o', error)
    }
    return overview
  }

  /** GET doc。 */
  async function handleReadDoc(req, res) {
    if (!guard(req, res)) return
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendError(res, 405, 'method not allowed', 'METHOD_NOT_ALLOWED')
      return
    }
    const query = queryOf(req)
    const built = buildRef(query.get('scope'), paramOf(query, 'persona', 'presetId'), query.get('projectRoot'))
    if (built.ok !== true) {
      sendError(res, 400, built.error, 'BAD_INPUT')
      return
    }
    let path
    try {
      path = store?.docPath?.(built.ref)
    } catch (error) {
      sendError(res, 400, error instanceof Error ? error.message : 'invalid ref', 'PATH_TRAVERSAL')
      return
    }
    if (typeof path !== 'string' || path === '') {
      sendError(res, 400, 'invalid ref', 'BAD_INPUT')
      return
    }
    const doc = await safeCall(() => store?.readDoc?.(built.ref), undefined)
    if (doc === undefined || doc === null) {
      sendError(res, 500, 'read failed', 'READ_FAILED')
      return
    }
    const content = String(doc.content ?? '')
    sendOk(res, {
      content,
      mtimeMs: Number(doc.mtimeMs ?? 0),
      bytes: Number(doc.bytes ?? Buffer.byteLength(content, 'utf8')),
      path: String(doc.path ?? path),
      title: extractTitle(content),
      // v8（契约 V8.11）：分层概览只有项目记忆有，其余 scope 干脆不带这个键，而不是带个空对象
      // 让面板去猜「是真的没有分层，还是后端没升上来」。
      ...(built.ref?.kind === 'project'
        ? { tiering: tierOverview(content) }
        : {}),
    })
  }

  /** PUT doc。 */
  async function handleWriteDoc(req, res) {
    if (!guard(req, res)) return
    if (req.method !== 'PUT') {
      sendError(res, 405, 'method not allowed', 'METHOD_NOT_ALLOWED')
      return
    }
    const body = await readJsonBody(req, res)
    if (body === undefined) return
    const built = buildRef(body.scope, paramOf(body, 'persona', 'presetId'), body.projectRoot)
    if (built.ok !== true) {
      sendError(res, 400, built.error, 'BAD_INPUT')
      return
    }
    if (typeof body.content !== 'string') {
      sendError(res, 400, 'content must be a string', 'BAD_INPUT')
      return
    }
    try {
      store?.docPath?.(built.ref)
    } catch (error) {
      sendError(res, 400, error instanceof Error ? error.message : 'invalid ref', 'PATH_TRAVERSAL')
      return
    }
    const expectedRaw = body.expectedMtimeMs
    if (expectedRaw !== undefined && (typeof expectedRaw !== 'number' || !Number.isFinite(expectedRaw))) {
      sendError(res, 400, 'expectedMtimeMs must be a finite number', 'BAD_INPUT')
      return
    }
    const expectedMtimeMs = expectedRaw
    const result = await safeCall(
      () => store?.writeDoc?.(built.ref, body.content, { expectedMtimeMs }),
      undefined,
    )
    if (result === undefined || result === null) {
      sendError(res, 500, 'write failed', 'WRITE_FAILED')
      return
    }
    if (result.ok === true) {
      sendOk(res, { mtimeMs: Number(result.mtimeMs ?? 0), bytes: Number(result.bytes ?? 0) })
      return
    }
    const code = typeof result.code === 'string' ? result.code : 'WRITE_FAILED'
    if (code === 'STALE') {
      sendJson(res, 409, { ok: false, error: 'file changed externally', code: 'STALE', mtimeMs: result.mtimeMs, bytes: result.bytes })
      return
    }
    sendError(res, 400, String(result.message ?? code), code)
  }

  /**
   * 包一层：任何未预期异常都转 500，绝不把异常抛给宿主。
   * @param {(req:object,res:object)=>Promise<void>} handler - 业务处理。
   * @returns {(req:object,res:object)=>Promise<void>} 包装后的处理。
   */
  const wrap = (handler) => async (req, res) => {
    try {
      await handler(req, res)
    } catch (error) {
      logger.warn?.('supermemory: route failed: %o', error)
      try {
        sendError(res, 500, error instanceof Error ? error.message : 'internal error', 'INTERNAL')
      } catch {
        /* 响应已关闭 */
      }
    }
  }

  const docHandler = wrap(async (req, res) => {
    if (req.method === 'PUT') await handleWriteDoc(req, res)
    else await handleReadDoc(req, res)
  })

  const registrations = [
    { path: ROUTES.bootstrap, handler: wrap(handleBootstrap) },
    { path: ROUTES.doc, handler: docHandler },
    { path: ROUTES.digest, handler: wrap(handleDigest) },
    { path: ROUTES.runs, handler: wrap(handleRuns) },
    { path: ROUTES.models, handler: wrap(handleModels) },
    { path: ROUTES.settings, handler: wrap(handleSettings) },
    { path: ROUTES.personas, handler: wrap(handlePersonas) },
    // v9（契约 §V9.4）：会话级人设。与人设三件套同口径，不受软开关拦截。
    { path: ROUTES.sessionPersona, handler: wrap(handleSessionPersona) },
  ]

  const disposers = []
  for (const registration of registrations) {
    try {
      const dispose = webServer.register({
        kind: 'exact',
        path: absolutePath(registration.path),
        handler: registration.handler,
      })
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch (error) {
      logger.warn?.('supermemory: route register failed for %s: %o', registration.path, error)
    }
  }

  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch (error) {
        logger.warn?.('supermemory: route dispose failed: %o', error)
      }
    }
  }
}
