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
 * @module dsh-supermemory/host/routes
 */

import { isAbsolute, normalize, sep } from 'node:path'

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
  models: `${ROUTE_PREFIX}/models`,
  settings: `${ROUTE_PREFIX}/settings`,
  personas: `${ROUTE_PREFIX}/personas`,
})

/** 请求体上限 1 MiB。 */
const MAX_BODY_BYTES = 1024 * 1024

/** 合法的记忆类别。 */
const SCOPES = new Set(['soul', 'user', 'global', 'project'])

/** 人设名称最大长度（契约 §V2.4）。 */
const PERSONA_NAME_MAX = 60

/** 默认允许自动整理写入的 scope（v2 只写 project）。 */
const DEFAULT_WRITABLE_SCOPES = Object.freeze(['project'])

/** v2 硬限制：自动整理永不写这些 scope（§V2.3）。 */
const HARD_WRITABLE_SCOPES = new Set(['project'])

/**
 * 解析允许自动整理写入的 scope 列表（与 lib/host/digest.js 保持同一规则）。
 * @param {object} config - ResolvedConfig。
 * @returns {string[]} scope 列表。
 */
function resolveWritableScopes(config) {
  const declared = Array.isArray(config?.digestWritableScopes)
    ? config.digestWritableScopes
    : DEFAULT_WRITABLE_SCOPES
  const allowed = declared.filter((kind) => typeof kind === 'string' && HARD_WRITABLE_SCOPES.has(kind))
  return allowed.length > 0 ? allowed : [...DEFAULT_WRITABLE_SCOPES]
}

/**
 * 把 document-relative 路径补成宿主可匹配的绝对 pathname。
 * @param {string} path - document-relative 路径。
 * @returns {string} 以 '/' 开头的路径。
 */
function absolutePath(path) {
  return path.startsWith('/') ? path : `/${path}`
}

/**
 * 读取请求头（小写键，兼容 Node 的 headers 对象）。
 * @param {object} req - IncomingMessage 或 mock。
 * @param {string} name - 头名。
 * @returns {string|undefined} 头值。
 */
function header(req, name) {
  const headers = req?.headers
  if (headers === undefined || headers === null) return undefined
  const value = headers[name]
  if (Array.isArray(value)) return value.length === 0 ? undefined : String(value[0])
  if (value === undefined || value === null) return undefined
  return String(value)
}

/**
 * 判断一个 hostname 是否是 loopback（127/8、::1、localhost、IPv4-mapped 回环）。
 * @param {string} hostname - 不带端口与方括号的 host。
 * @returns {boolean} 是否 loopback。
 */
function isLoopbackHostname(hostname) {
  if (typeof hostname !== 'string' || hostname === '') return false
  const name = hostname.toLowerCase()
  if (name === 'localhost') return true
  if (name === '::1') return true
  if (name === '::ffff:7f00:1') return true
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/u.exec(name)
  if (mapped !== null) return isLoopbackHostname(mapped[1])
  const parts = name.split('.')
  if (parts.length !== 4 || parts[0] !== '127') return false
  return parts.every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255)
}

/**
 * 判断 socket 远端地址是否是 loopback。
 * @param {string|undefined} address - `req.socket.remoteAddress`。
 * @returns {boolean} 是否 loopback。
 */
function isLoopbackAddress(address) {
  if (typeof address !== 'string' || address === '') return false
  const value = address.toLowerCase()
  if (value === '::1' || value === '::ffff:7f00:1') return true
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/u.exec(value)
  if (mapped !== null) return isLoopbackHostname(mapped[1])
  return isLoopbackHostname(value)
}

/**
 * 解析 Host / Origin 的 authority。
 * @param {string} value - 头值。
 * @param {string} [scheme] - 默认协议。
 * @returns {{host:string, hostname:string, protocol:string}|undefined} 解析结果。
 */
function parseAuthority(value, scheme = 'http:') {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const text = value.trim()
  try {
    // Origin 是完整 URL（带 scheme://），Host 是裸 authority；两种都接受。
    const url = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(text) ? new URL(text) : new URL(`${scheme}//${text}`)
    if (url.hostname === '' || url.host === '') return undefined
    return { host: url.host, hostname: url.hostname.replace(/^\[|\]$/gu, ''), protocol: url.protocol }
  } catch {
    return undefined
  }
}

/**
 * 信任栅栏：非 loopback 或带浏览器代理标记或跨源，一律拒绝。
 *
 * 导出以便测试直接断言信任矩阵（契约 §10 要求）；纯函数，无副作用。
 * @param {object} req - IncomingMessage 或 mock。
 * @returns {boolean} 是否可信。
 */
export function isTrustedRequest(req) {
  if (req === undefined || req === null) return false

  // 1) socket 必须是回环。
  if (!isLoopbackAddress(req.socket?.remoteAddress)) return false

  // 2) 任何反向代理标记都视为不可信（本地同源请求不会带）。
  if (header(req, 'cf-connecting-ip') !== undefined) return false
  if (header(req, 'x-forwarded-for') !== undefined) return false
  if (header(req, 'x-real-ip') !== undefined) return false
  if (header(req, 'forwarded') !== undefined) return false

  // 3) Host 必须是回环 authority（防 DNS rebinding）。
  const hostHeader = header(req, 'host')
  const host = parseAuthority(hostHeader)
  if (host === undefined || !isLoopbackHostname(host.hostname)) return false

  // 4) Fetch Metadata 明确跨站 → 拒绝。
  const site = header(req, 'sec-fetch-site')
  if (typeof site === 'string' && site.toLowerCase() === 'cross-site') return false

  // 5) Origin 缺失可接受（同源读请求不带）；带则必须与 Host 同源。
  const origin = header(req, 'origin')
  if (origin !== undefined) {
    const parsed = parseAuthority(origin)
    if (parsed === undefined || parsed.host !== host.host) return false
  }
  return true
}

/**
 * 写一个 JSON 响应。
 * @param {object} res - ServerResponse 或 mock。
 * @param {number} status - HTTP 状态码。
 * @param {object} payload - JSON 体。
 * @returns {void}
 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  try {
    if (typeof res.writeHead === 'function') res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    else res.statusCode = status
  } catch {
    /* mock 可能只实现 end */
  }
  try {
    res.end?.(body)
  } catch {
    /* 连接已断开，忽略 */
  }
}

/** 统一失败响应。 */
function sendError(res, status, error, code) {
  const payload = { ok: false, error }
  if (code !== undefined) payload.code = code
  sendJson(res, status, payload)
}

/** 统一成功响应。 */
function sendOk(res, data) {
  sendJson(res, 200, { ok: true, data })
}

/**
 * 信任栅栏包装：不合规立即 403 并返回 false。
 * @param {object} req - 请求。
 * @param {object} res - 响应。
 * @returns {boolean} 是否继续处理。
 */
function guard(req, res) {
  if (isTrustedRequest(req)) return true
  sendError(res, 403, 'forbidden')
  return false
}

/**
 * 读请求体（上限 1 MiB）。
 * @param {object} req - 请求。
 * @returns {Promise<{ok:true, text:string}|{ok:false, code:'TOO_LARGE'|'READ_FAILED', error:string}>} 结果。
 */
async function readBody(req) {
  const declared = Number(header(req, 'content-length'))
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { ok: false, code: 'TOO_LARGE', error: 'request body too large' }
  }
  const chunks = []
  let total = 0
  try {
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      total += buffer.length
      if (total > MAX_BODY_BYTES) return { ok: false, code: 'TOO_LARGE', error: 'request body too large' }
      chunks.push(buffer)
    }
  } catch (error) {
    return { ok: false, code: 'READ_FAILED', error: error instanceof Error ? error.message : String(error) }
  }
  return { ok: true, text: Buffer.concat(chunks).toString('utf8') }
}

/**
 * 读 JSON 请求体。
 * @param {object} req - 请求。
 * @param {object} res - 响应。
 * @returns {Promise<object|undefined>} 解析后的对象；已直接响应错误时返回 undefined。
 */
async function readJsonBody(req, res) {
  const body = await readBody(req)
  if (body.ok !== true) {
    if (body.code === 'TOO_LARGE') sendError(res, 413, 'request body too large', 'TOO_LARGE')
    else sendError(res, 400, body.error, 'BAD_REQUEST')
    return undefined
  }
  if (body.text.trim() === '') return {}
  let parsed
  try {
    parsed = JSON.parse(body.text)
  } catch {
    sendError(res, 400, 'invalid JSON body', 'BAD_JSON')
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    sendError(res, 400, 'body must be a JSON object', 'BAD_INPUT')
    return undefined
  }
  return parsed
}

/**
 * 解析查询字符串（基于 req.url）。
 * @param {object} req - 请求。
 * @returns {URLSearchParams} 查询参数。
 */
function queryOf(req) {
  const raw = typeof req?.url === 'string' ? req.url : '/'
  try {
    return new URL(raw, 'http://localhost').searchParams
  } catch {
    return new URLSearchParams()
  }
}

/**
 * 取一个参数：优先新名，回退旧名（v2 的 `persona` 兼容 v1 的 `presetId`）。
 * @param {URLSearchParams|object} source - 查询串或普通对象。
 * @param {string} primary - 新字段名。
 * @param {string} legacy - 旧字段名。
 * @returns {string|undefined} 非空字符串值。
 */
function paramOf(source, primary, legacy) {
  const read = (name) => {
    const value = typeof source?.get === 'function' ? source.get(name) : source?.[name]
    return typeof value === 'string' && value.trim() !== '' ? value : undefined
  }
  return read(primary) ?? read(legacy)
}

/**
 * 校验 persona slug：非空字符串，不含路径分隔符、NUL 或 `.`/`..`。
 * @param {unknown} value - 原始值。
 * @returns {{ok:true, value:string}|{ok:false, error:string}} 结果。
 */
function checkPersona(value) {
  if (typeof value !== 'string') return { ok: false, error: 'persona is required' }
  const persona = value.trim()
  if (persona === '') return { ok: false, error: 'persona is required' }
  if (persona === '.' || persona === '..') return { ok: false, error: 'invalid persona' }
  if (persona.includes('/') || persona.includes('\\') || persona.includes('\u0000')) {
    return { ok: false, error: 'invalid persona' }
  }
  return { ok: true, value: persona }
}

/**
 * 校验 projectRoot：必须是规范化的绝对路径，且不含 `..` 段。
 * @param {unknown} projectRoot - 原始值。
 * @returns {{ok:true, value:string}|{ok:false, error:string}} 结果。
 */
function checkProjectRoot(projectRoot) {
  if (typeof projectRoot !== 'string' || projectRoot === '') {
    return { ok: false, error: 'projectRoot is required' }
  }
  if (projectRoot.includes('\u0000') || projectRoot.split(/[\\/]+/u).includes('..')) {
    return { ok: false, error: 'invalid projectRoot' }
  }
  if (!isAbsolute(projectRoot)) return { ok: false, error: 'projectRoot must be absolute' }
  const resolved = normalize(projectRoot)
  if (resolved.length > 1 && resolved.endsWith(sep)) return { ok: false, error: 'invalid projectRoot' }
  return { ok: true, value: resolved }
}

/**
 * 把查询/请求体参数转成 store ref；任何非法参数返回 400 的原因。
 *
 * v2：soul/user/global 用 `persona` 作为隔离键；同时带 `presetId` 以兼容尚未迁移的
 * store 实现（§V2.2 规定两者都给时 persona 优先，两者同值所以结果一致）。
 *
 * @param {unknown} scope - 记忆类别。
 * @param {unknown} persona - 人设 slug。
 * @param {unknown} projectRoot - 项目根。
 * @returns {{ok:true, ref:object}|{ok:false, error:string}} 结果。
 */
function buildRef(scope, persona, projectRoot) {
  if (typeof scope !== 'string' || !SCOPES.has(scope)) {
    return { ok: false, error: 'scope must be one of soul, user, global, project' }
  }
  if (scope === 'project') {
    const checked = checkProjectRoot(projectRoot)
    if (checked.ok !== true) return { ok: false, error: checked.error }
    return { ok: true, ref: { kind: 'project', projectRoot: checked.value } }
  }
  const checked = checkPersona(persona)
  if (checked.ok !== true) return { ok: false, error: checked.error }
  return { ok: true, ref: { kind: scope, persona: checked.value, presetId: checked.value } }
}

/**
 * 从 markdown 文本取一级标题。
 * @param {string} text - 文件内容。
 * @returns {string|undefined} 标题。
 */
function extractTitle(text) {
  if (typeof text !== 'string') return undefined
  for (const line of text.split('\n')) {
    const match = /^#\s+(.+?)\s*$/u.exec(line)
    if (match !== null) return match[1]
  }
  return undefined
}

/**
 * 归一化人设记录。
 * @param {unknown} value - store 返回值。
 * @returns {{slug:string, name:string}|null} 人设或 null。
 */
function normalizePersona(value) {
  if (value === null || typeof value !== 'object') return null
  if (typeof value.slug !== 'string' || value.slug === '') return null
  return { slug: value.slug, name: typeof value.name === 'string' ? value.name : value.slug }
}

/**
 * 归一化整理模型设置。
 * @param {unknown} value - store 返回值。
 * @returns {{digestProvider:string, digestModel:string}} 设置。
 */
function normalizeDigestSettings(value) {
  return {
    digestProvider: typeof value?.digestProvider === 'string' ? value.digestProvider : '',
    digestModel: typeof value?.digestModel === 'string' ? value.digestModel : '',
  }
}

/**
 * 安装全部 HTTP 路由。
 * @param {object} ctx - cordis Context。
 * @param {object} deps - 装配层依赖。
 * @returns {() => void} dispose。
 */
export function installRoutes(ctx, deps) {
  const webServer = (() => {
    try {
      return ctx?.get?.('webServer')
    } catch {
      return undefined
    }
  })()
  if (webServer === undefined || webServer === null) return () => {}

  const logger = deps?.logger ?? { warn() {}, info() {} }
  const store = deps?.store

  /** 安全读配置。 */
  function readConfig() {
    try {
      const value = deps?.getConfig?.()
      return value !== null && typeof value === 'object' ? value : {}
    } catch {
      return {}
    }
  }

  /** 安全调用 store 的异步方法。 */
  async function safeCall(fn, fallback) {
    try {
      return await fn()
    } catch (error) {
      logger.warn?.('supermemory: routes store call failed: %o', error)
      return fallback
    }
  }

  /** 人设 API：优先装配层直通，回退 store（§V2.2）。 */
  function personaApi() {
    const direct = deps?.personas
    const wrap = (name, fallback) =>
      typeof direct?.[name] === 'function' ? (...args) => direct[name](...args) : fallback
    return {
      list: wrap('list', () => store?.listPersonas?.() ?? []),
      current: wrap('current', () => store?.currentPersona?.() ?? null),
      create: wrap('create', (name) => store?.createPersona?.(name)),
      select: wrap('select', (slug) => store?.setCurrentPersona?.(slug)),
    }
  }

  /** 读整理模型设置：优先装配层直通，回退 store；缺失/出错返回空串。 */
  async function readDigestSettings() {
    const direct = deps?.settings
    const reader =
      typeof direct?.read === 'function'
        ? () => direct.read()
        : typeof store?.readSettings === 'function'
          ? () => store.readSettings()
          : undefined
    if (reader === undefined) return normalizeDigestSettings({})
    return normalizeDigestSettings(await safeCall(reader, {}))
  }

  /**
   * 写整理模型设置。
   * @param {object} patch - 只含 digestProvider / digestModel。
   * @returns {Promise<object|undefined>} store 结果；不可用时 undefined。
   */
  async function writeDigestSettings(patch) {
    const direct = deps?.settings
    const writer =
      typeof direct?.write === 'function'
        ? (value) => direct.write(value)
        : typeof store?.writeSettings === 'function'
          ? (value) => store.writeSettings(value)
          : undefined
    if (writer === undefined) return undefined
    return safeCall(() => writer(patch), undefined)
  }

  /** 读人设列表 + current（`personas` 系列路由的统一响应体）。 */
  async function personasData() {
    const api = personaApi()
    const listed = await safeCall(() => api.list(), [])
    const current = await safeCall(() => api.current(), null)
    return {
      personas: (Array.isArray(listed) ? listed : []).map((persona) => ({
        slug: persona?.slug,
        name: persona?.name,
        createdAt: persona?.createdAt,
      })),
      current: normalizePersona(current),
    }
  }

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
      },
      digestSettings: await readDigestSettings(),
      presetsRoot: deps?.personasRoot ?? deps?.presetsRoot,
      dshHome: deps?.dshHome,
    })
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

  /** POST digest。 */
  async function handleDigest(req, res) {
    if (!guard(req, res)) return
    if (req.method !== 'POST') {
      sendError(res, 405, 'method not allowed', 'METHOD_NOT_ALLOWED')
      return
    }
    const body = await readJsonBody(req, res)
    if (body === undefined) return
    const personaChecked = checkPersona(paramOf(body, 'persona', 'presetId') ?? 'default')
    const rootChecked = body.projectRoot === undefined ? { ok: true, value: undefined } : checkProjectRoot(body.projectRoot)
    if (personaChecked.ok !== true || rootChecked.ok !== true) {
      sendError(res, 400, personaChecked.ok === true ? rootChecked.error : personaChecked.error, 'BAD_INPUT')
      return
    }
    let agent
    const sessionId = typeof body.sessionId === 'string' && body.sessionId !== '' ? body.sessionId : undefined
    if (sessionId !== undefined) {
      try {
        agent = ctx?.get?.('agents')?.get?.(sessionId)
      } catch {
        agent = undefined
      }
    }
    let record
    try {
      record = await deps.runDigest({
        agent,
        trigger: 'manual',
        persona: personaChecked.value,
        presetId: personaChecked.value, // v1 兼容字段
        projectRoot: rootChecked.value,
        sessionId,
      })
    } catch (error) {
      sendError(res, 500, error instanceof Error ? error.message : 'digest failed', 'DIGEST_FAILED')
      return
    }
    sendOk(res, {
      at: record?.at,
      ok: record?.ok === true,
      error: record?.error,
      skipped: record?.skipped === true,
      counts: record?.counts,
    })
  }

  /** GET runs。 */
  async function handleRuns(req, res) {
    if (!guard(req, res)) return
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendError(res, 405, 'method not allowed', 'METHOD_NOT_ALLOWED')
      return
    }
    const limitParam = Number(queryOf(req).get('limit'))
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(Math.trunc(limitParam), 200) : 20
    const runs = await safeCall(() => store?.readRuns?.(limit) ?? [], [])
    sendOk(res, { runs: Array.isArray(runs) ? runs : [] })
  }

  /** GET models：可用模型列表 + 当前整理模型。 */
  async function handleModels(req, res) {
    if (!guard(req, res)) return
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendError(res, 405, 'method not allowed', 'METHOD_NOT_ALLOWED')
      return
    }
    const listed = await safeCall(() => deps?.listModels?.(), [])
    const models = (Array.isArray(listed) ? listed : [])
      .filter((model) => typeof model?.provider === 'string' && typeof model?.id === 'string')
      .map((model) => ({
        provider: model.provider,
        id: model.id,
        name: typeof model.name === 'string' && model.name !== '' ? model.name : model.id,
        label:
          typeof model.label === 'string' && model.label !== ''
            ? model.label
            : `${model.provider} / ${model.id}`,
      }))
    const settings = await readDigestSettings()
    const current =
      settings.digestProvider !== '' && settings.digestModel !== ''
        ? { provider: settings.digestProvider, model: settings.digestModel }
        : null
    sendOk(res, { models, current })
  }

  /** PUT settings：保存整理模型（空串表示跟随当前会话）。 */
  async function handleSettings(req, res) {
    if (!guard(req, res)) return
    if (req.method !== 'PUT') {
      sendError(res, 405, 'method not allowed', 'METHOD_NOT_ALLOWED')
      return
    }
    const body = await readJsonBody(req, res)
    if (body === undefined) return
    const patch = {}
    if (body.digestProvider !== undefined) {
      if (typeof body.digestProvider !== 'string') {
        sendError(res, 400, 'digestProvider must be a string', 'BAD_INPUT')
        return
      }
      patch.digestProvider = body.digestProvider.trim()
    }
    if (body.digestModel !== undefined) {
      if (typeof body.digestModel !== 'string') {
        sendError(res, 400, 'digestModel must be a string', 'BAD_INPUT')
        return
      }
      patch.digestModel = body.digestModel.trim()
    }
    if (Object.keys(patch).length === 0) {
      sendError(res, 400, 'digestProvider or digestModel is required', 'BAD_INPUT')
      return
    }
    const result = await writeDigestSettings(patch)
    if (result === undefined || result === null) {
      sendError(res, 500, 'settings store unavailable', 'SETTINGS_UNAVAILABLE')
      return
    }
    if (result.ok !== true) {
      const code = typeof result.code === 'string' ? result.code : 'SETTINGS_WRITE_FAILED'
      sendError(res, code === 'BAD_INPUT' ? 400 : 500, String(result.message ?? code), code)
      return
    }
    const stored =
      result.settings !== undefined && result.settings !== null
        ? result.settings
        : await readDigestSettings()
    sendOk(res, { digestSettings: normalizeDigestSettings({ ...stored, ...patch }) })
  }

  /** GET / POST / PUT personas。 */
  async function handlePersonas(req, res) {
    if (!guard(req, res)) return
    if (req.method === 'GET' || req.method === 'HEAD') {
      sendOk(res, await personasData())
      return
    }
    const body = await readJsonBody(req, res)
    if (body === undefined) return
    const api = personaApi()

    if (req.method === 'POST') {
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      if (name === '') {
        sendError(res, 400, 'name is required', 'BAD_INPUT')
        return
      }
      if (Array.from(name).length > PERSONA_NAME_MAX) {
        sendError(res, 400, `name must be at most ${PERSONA_NAME_MAX} characters`, 'BAD_INPUT')
        return
      }
      const created = await safeCall(() => api.create(name), undefined)
      if (created === undefined || created === null || created.ok !== true) {
        const code = typeof created?.code === 'string' ? created.code : 'PERSONA_CREATE_FAILED'
        const status = code === 'BAD_INPUT' ? 400 : code === 'PERSONA_EXISTS' ? 409 : 500
        sendError(res, status, String(created?.message ?? code), code)
        return
      }
      const slug = typeof created.persona?.slug === 'string' ? created.persona.slug : ''
      if (slug === '') {
        sendError(res, 500, 'persona created without slug', 'PERSONA_CREATE_FAILED')
        return
      }
      // 契约 §V2.4：创建成功后自动切换为 current。
      const selected = await safeCall(() => api.select(slug), undefined)
      if (selected === undefined || selected === null || selected.ok !== true) {
        sendError(res, 500, String(selected?.message ?? 'persona created but switch failed'), 'PERSONA_SWITCH_FAILED')
        return
      }
      sendOk(res, await personasData())
      return
    }

    if (req.method === 'PUT') {
      const slug = typeof body.slug === 'string' ? body.slug.trim() : ''
      if (slug === '') {
        sendError(res, 400, 'slug is required', 'BAD_INPUT')
        return
      }
      const selected = await safeCall(() => api.select(slug), undefined)
      if (selected === undefined || selected === null || selected.ok !== true) {
        const code = typeof selected?.code === 'string' ? selected.code : 'PERSONA_SWITCH_FAILED'
        sendError(res, code === 'NOT_FOUND' ? 404 : 400, String(selected?.message ?? code), code)
        return
      }
      sendOk(res, await personasData())
      return
    }

    sendError(res, 405, 'method not allowed', 'METHOD_NOT_ALLOWED')
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
