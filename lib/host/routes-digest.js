/**
 * dsh-supermemory「记忆整理」域的路由 handler：POST digest + GET runs。
 *
 * 从 lib/host/routes.js 的 installRoutes 闭包里原样搬出，函数体一字未改。
 * 拆这一刀的理由：这两个接口是全部路由里唯一需要 `ctx.get('agents')` 与
 * `deps.runDigest` 的（要拿到真实会话去驱动整理器），依赖面与「读写记忆文档」
 * 「面板设置」两条线不重叠，天然自成一域。
 *
 * 工厂参数即原来的闭包变量：ctx / deps / store 直接传，pluginEnabled / safeCall
 * 取自 access 层。v3 总开关的拦截仍只写在 handleDigest 内（契约 §V3.2）。
 *
 * @module dsh-supermemory/host/routes-digest
 */

import { checkSessionId } from '../core/session-personas.js'
import { guard, paramOf, queryOf, readJsonBody, sendError, sendOk } from './http.js'
import { checkPersona, checkProjectRoot } from './params.js'

/**
 * 装配「记忆整理」域的路由 handler。
 * @param {object} options - 依赖集合。
 * @param {object} options.ctx - cordis Context。
 * @param {object} options.deps - 装配层依赖。
 * @param {object} options.store - 存储层。
 * @param {object} options.access - createAccess 的结果。
 * @param {(projectRoot:string) => Promise<{ok:true}|{ok:false, error:string, code:string}>}
 *   [options.checkRegisteredProjectRoot] - routes.js 的项目根白名单校验（降级不拦铁律在
 *   该函数内部实现：listProjects 缺失/抛错时放宽为原行为）。缺失时本域跳过该校验
 *   （与旧版行为一致，兼容直接调用本工厂的老测试）。
 * @returns {{handleDigest: Function, handleRuns: Function}} 一组 handler。
 */
export function createDigestHandlers({ ctx, deps, store, access, checkRegisteredProjectRoot }) {
  const { pluginEnabled, safeCall } = access

  /** POST digest。 */
  async function handleDigest(req, res) {
    if (!guard(req, res)) return
    if (req.method !== 'POST') {
      sendError(res, 405, 'method not allowed', 'METHOD_NOT_ALLOWED')
      return
    }
    // v3：关闭态下唯一被拦的接口。放在读 body 之前，连解析都省掉。
    if (!pluginEnabled()) {
      sendError(res, 409, 'dsh-supermemory is disabled. Enable it in Settings → Memory.', 'PLUGIN_DISABLED')
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
    // 修复 10：带 projectRoot 的手动整理必须命中已注册项目（白名单校验在 routes.js
    // 内部实现，含「宿主服务缺失时放宽为原行为」的降级铁律）。
    if (rootChecked.value !== undefined && typeof checkRegisteredProjectRoot === 'function') {
      const registered = await checkRegisteredProjectRoot(rootChecked.value)
      if (registered.ok !== true) {
        sendError(res, 400, registered.error, registered.code)
        return
      }
    }
    let agent
    // sessionId 白名单校验（与 routes-session-persona 的 checkSessionId 同一权威实现，
    // 契约 V8.12 单一来源纪律）：此前只判非空字符串，`__proto__` 这类键能穿透到
    // 会话注册表查找。非法 id 一律 400。
    const sessionChecked = checkSessionId(body.sessionId)
    const sessionId = sessionChecked.ok === true ? sessionChecked.value : undefined
    if (body.sessionId !== undefined && sessionChecked.ok !== true) {
      sendError(res, 400, sessionChecked.error, 'BAD_INPUT')
      return
    }
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

  return { handleDigest, handleRuns }
}
