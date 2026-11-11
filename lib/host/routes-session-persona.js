/**
 * dsh-supermemory「会话级人设」域的路由 handler：GET + PUT `session-persona`
 * （契约 §V9.0 ~ §V9.4）。
 *
 * 一个会话可以单独指定人设；没指定就跟随全局 `currentPersona`。本文件只负责
 * 面板那一侧的读写视图：GET 现算「这个会话此刻实际生效的人设 + 来源 + 可选列表」，
 * PUT 绑定 / 清除绑定，成功后回带**与 GET 完全同构**的 data，前端一处刷新逻辑通吃。
 *
 * 依赖边界：**实例**走注入，**纯函数**走 import。
 *   - 会话绑定的读写走 `deps.sessionPersonas`（V9.2 的实例：get / set / clear）。
 *     实例必须由装配层持有（生命周期、ready 时序、dispose），所以只经 deps 访问；
 *     测试用 mock 即可覆盖，不依赖 core 模块的进度。
 *   - `checkSessionId` 是纯函数，**直接 import core 的权威实现**（契约 V8.12
 *     「单一来源纪律」：同一份判定只许有一处实现）。路由层需要在本层先校验，
 *     是因为 `deps.sessionPersonas` 缺失时非法输入仍要 400，不能因为存储不在就
 *     把 400 变成 503——但「怎么算合法」不因此就该抄第二份。
 *   - 人设列表与全局人设走 `access.personaApi()`（list / current），一律经
 *     `access.safeCall` 包裹——它们读的是 store，抛错不能把面板打成 500。
 *
 * 总开关（契约 §V9.4 末条）：**不做 `pluginEnabled()` 拦截**。与 personas 三件套同口径，
 * 关掉插件后用户仍要能改绑，拦了等于把人设入口锁死。
 *
 * @module dsh-supermemory/host/routes-session-persona
 */

import { checkSessionId } from '../core/session-personas.js'
import { guard, queryOf, readJsonBody, sendError, sendOk } from './http.js'
import { normalizePersona } from './params.js'

/** 全局人设缺失时的兜底 slug（与 `resolveScope` 的缺省人设一致）。 */
const DEFAULT_PERSONA_SLUG = 'default'

/**
 * 会话人设写操作（set / clear）的错误码 → HTTP 状态与对外错误码。
 *
 * `NOT_FOUND` 统一改写成 `PERSONA_NOT_FOUND`：契约 §V9.4 对「人设不存在」只给了
 * 这一个对外错误码，前端不该同时认识两套叫法。
 *
 * @param {string} code - store 返回的错误码。
 * @returns {{status:number, code:string}} 映射结果；未知码一律 500。
 */
function sessionPersonaWriteError(code) {
  if (code === 'BAD_INPUT') return { status: 400, code }
  if (code === 'NOT_FOUND') return { status: 404, code: 'PERSONA_NOT_FOUND' }
  return { status: 500, code }
}

/**
 * 装配「会话级人设」域的路由 handler。
 *
 * @param {object} options - 依赖集合。
 * @param {object} options.deps - 装配层依赖；本域只读 `sessionPersonas` 与 `logger`。
 * @param {object} options.access - createAccess 的结果（personaApi / safeCall）。
 * @returns {{handleSessionPersona: (req:object, res:object)=>Promise<void>}} 一组 handler。
 */
export function createSessionPersonaHandlers({ deps, access }) {
  const { personaApi, safeCall } = access
  const logger = deps?.logger

  /**
   * 取会话人设存储实例；缺失或形态不对都返回 undefined。
   * @returns {object|undefined} 实例。
   */
  function sessionPersonaStore() {
    const store = deps?.sessionPersonas
    return store !== null && typeof store === 'object' ? store : undefined
  }

  /**
   * 同步读某会话的绑定 slug（V9.2 的 `get` 是同步的）。
   *
   * `get` 在 ready 未完成时返回 undefined，等价于「跟随全局」——这正是我们要的降级；
   * 它若抛错也按未绑定处理，绝不让一次读内存失败把 GET 打成 500。
   *
   * @param {string} sessionId - 已校验的会话 ID。
   * @returns {string|undefined} 绑定的人设 slug。
   */
  function boundSlugOf(sessionId) {
    const store = sessionPersonaStore()
    if (typeof store?.get !== 'function') return undefined
    try {
      const value = store.get(sessionId)
      return typeof value === 'string' && value !== '' ? value : undefined
    } catch (error) {
      logger?.warn?.('supermemory: session persona get failed: %o', error)
      return undefined
    }
  }

  /**
   * 现算 GET / PUT 共用的 data 结构（契约 §V9.4）。
   *
   * 三处口径：
   *   1. 人设列表 / 全局人设都经 `safeCall` 读；读不到就 `[]` / 兜底 slug，照样给得出
   *      `persona`——面板上「这个人设叫什么」不能因为注册表读失败就整个消失。
   *   2. 绑定的人设若已经不在列表里（被删的僵尸绑定），按未绑定回退全局：这才是
   *      装配层 `resolveScope` 当轮真正注入的人设，面板显示的必须是它，否则胶囊名与
   *      实际人格会对不上。**列表为空/读不到时不判僵尸**——那说明「不知道」，此时按
   *      契约「按 slug 兜底 name」照实显示绑定，不清空、不回退。
   *   3. 僵尸绑定只做只读回退，**不在这里清盘**：清理是装配层 `resolveScope` 的职责
   *      （V9.3 的 fire-and-forget），GET 不应产生写副作用。
   *
   * @param {string} sessionId - 已校验的会话 ID。
   * @param {string|null} [boundHint] - 调用方已知的绑定结果：`undefined` = 现读内存态；
   *   `null` = 刚清除成功；字符串 = 刚写入成功。用于让 PUT 的回带不依赖「store 的
   *   内存态在 Promise resolve 时已经反射」这一时序假设——写盘成功即绑定成功，
   *   回带给前端的状态必须是新的，不能因为它慢一拍就显示成「跟随全局」。
   * @returns {Promise<{sessionId:string, persona:{slug:string,name:string}, source:'session'|'global', globalPersona:{slug:string,name:string}, personas:Array<{slug:string,name:string}>}>} data。
   */
  async function sessionPersonaData(sessionId, boundHint) {
    const api = personaApi()
    const listed = await safeCall(() => api.list(), [])
    const personas = (Array.isArray(listed) ? listed : [])
      .map((persona) => normalizePersona(persona))
      .filter((persona) => persona !== null)

    const current = await safeCall(() => api.current(), null)
    const globalPersona = normalizePersona(current) ?? {
      slug: DEFAULT_PERSONA_SLUG,
      name: DEFAULT_PERSONA_SLUG,
    }

    let persona = globalPersona
    let source = 'global'
    const justWritten = typeof boundHint === 'string'
    const bound = justWritten ? boundHint : boundHint === undefined ? boundSlugOf(sessionId) : undefined
    if (bound !== undefined) {
      const found = personas.find((item) => item.slug === bound)
      if (found !== undefined) {
        persona = found
        source = 'session'
      } else if (personas.length === 0 || justWritten) {
        // 列表缺失/为空时「不知道」存活与否，按契约用绑定 slug 兜底显示名；
        // justWritten 时更是刚写入成功的结果——写盘成功即绑定成功，回带给前端的状态
        // 必须是新的，不能因为注册表读到一半变化就显示成「跟随全局」。
        persona = { slug: bound, name: bound }
        source = 'session'
      }
      // 列表非空且找不到、又不是刚写入 → 僵尸绑定，保持 source='global' 与全局 persona。
    }

    return { sessionId, persona, source, globalPersona, personas }
  }

  /**
   * GET / HEAD：读本会话生效人设 + 来源 + 全局人设 + 可选列表。
   * @param {object} req - 请求。
   * @param {object} res - 响应。
   * @returns {Promise<void>} 无。
   */
  async function handleGet(req, res) {
    const checked = checkSessionId(queryOf(req).get('sessionId'))
    if (checked.ok !== true) {
      sendError(res, 400, checked.error, 'BAD_INPUT')
      return
    }
    sendOk(res, await sessionPersonaData(checked.value))
  }

  /**
   * PUT：绑定人设，或（slug 为空串时）清除绑定恢复跟随全局。
   * @param {object} req - 请求。
   * @param {object} res - 响应。
   * @returns {Promise<void>} 无。
   */
  async function handlePut(req, res) {
    const body = await readJsonBody(req, res)
    if (body === undefined) return
    const checked = checkSessionId(body.sessionId)
    if (checked.ok !== true) {
      sendError(res, 400, checked.error, 'BAD_INPUT')
      return
    }
    const sessionId = checked.value
    if (typeof body.slug !== 'string') {
      // 只有「空串」才是清除语义；缺失/非字符串属于客户端 bug，明确 400，
      // 免得把一次字段名写错悄悄当成「切回全局」。
      sendError(res, 400, 'slug must be a string', 'BAD_INPUT')
      return
    }
    const slug = body.slug.trim()

    const store = sessionPersonaStore()
    if (slug === '') {
      if (typeof store?.clear !== 'function') {
        sendError(res, 503, 'session persona store unavailable', 'SESSION_PERSONA_UNAVAILABLE')
        return
      }
      const cleared = await safeCall(() => store.clear(sessionId), undefined)
      if (cleared === undefined || cleared === null) {
        sendError(res, 500, 'session persona clear failed', 'SESSION_PERSONA_WRITE_FAILED')
        return
      }
      if (cleared.ok !== true) {
        const mapped = sessionPersonaWriteError(
          typeof cleared.code === 'string' ? cleared.code : 'SESSION_PERSONA_WRITE_FAILED',
        )
        sendError(res, mapped.status, String(cleared.message ?? mapped.code), mapped.code)
        return
      }
      // 幂等：removed 为 false（本来就没绑）同样是成功，回带清除后的完整 data。
      sendOk(res, await sessionPersonaData(sessionId, null))
      return
    }

    if (typeof store?.set !== 'function') {
      sendError(res, 503, 'session persona store unavailable', 'SESSION_PERSONA_UNAVAILABLE')
      return
    }

    // 存在性预检：会话映射本身不持有注册表（V9.2 只依赖 fs/path），必须由路由拿
    // 人设列表来判 404。列表读失败时**不做判断、交给 set**——宁可先落一条可能悬空的
    // 绑定（下一轮 resolveScope 会回退全局并清僵尸），也不要因为一次读失败就把合法
    // 请求打成 404。
    const api = personaApi()
    const listed = await safeCall(() => api.list(), undefined)
    if (Array.isArray(listed) && !listed.some((persona) => persona?.slug === slug)) {
      sendError(res, 404, `persona not found: ${slug}`, 'PERSONA_NOT_FOUND')
      return
    }

    const written = await safeCall(() => store.set(sessionId, slug), undefined)
    if (written === undefined || written === null) {
      sendError(res, 500, 'session persona write failed', 'SESSION_PERSONA_WRITE_FAILED')
      return
    }
    if (written.ok !== true) {
      const mapped = sessionPersonaWriteError(
        typeof written.code === 'string' ? written.code : 'SESSION_PERSONA_WRITE_FAILED',
      )
      sendError(res, mapped.status, String(written.message ?? mapped.code), mapped.code)
      return
    }
    // 回带用 store 实际落库的 slug（`set` 会经 `personaSlug` 归一，例如空格折叠成 `-`）。
    // 拿不到结果里的 sessions 时才退回请求里的 slug；两者都**不**回读 get，
    // 免得依赖「内存态已反射」这一时序假设。
    // 用 hasOwnProperty 取值而不是直接下标：sessionId 白名单允许 `__proto__` / `constructor`
    // 这类名字，直接下标会取到原型上的东西。
    const stored = written?.sessions
    const storedSlug =
      stored !== null &&
      typeof stored === 'object' &&
      Object.prototype.hasOwnProperty.call(stored, sessionId) &&
      typeof stored[sessionId] === 'string' &&
      stored[sessionId] !== ''
        ? stored[sessionId]
        : slug
    sendOk(res, await sessionPersonaData(sessionId, storedSlug))
  }

  /**
   * 路由主体：信任栅栏 → method 分派。
   * @param {object} req - 请求。
   * @param {object} res - 响应。
   * @returns {Promise<void>} 无。
   */
  async function route(req, res) {
    if (!guard(req, res)) return
    if (req.method === 'GET' || req.method === 'HEAD') {
      await handleGet(req, res)
      return
    }
    if (req.method === 'PUT') {
      await handlePut(req, res)
      return
    }
    sendError(res, 405, 'method not allowed', 'METHOD_NOT_ALLOWED')
  }

  /**
   * 对外 handler：任何未预期异常都转 500 JSON，绝不把异常抛给宿主。
   *
   * 单测会直接调用本函数（没有 routes.js 的 wrap 兜底），所以这层兜底不能省；
   * 与 `installRoutes` 里的 wrap 同口径。
   *
   * @param {object} req - 请求。
   * @param {object} res - 响应。
   * @returns {Promise<void>} 无。
   */
  async function handleSessionPersona(req, res) {
    try {
      await route(req, res)
    } catch (error) {
      logger?.warn?.('supermemory: session-persona route failed: %o', error)
      try {
        sendError(res, 500, error instanceof Error ? error.message : 'internal error', 'INTERNAL')
      } catch {
        /* 响应已关闭 */
      }
    }
  }

  return { handleSessionPersona }
}
