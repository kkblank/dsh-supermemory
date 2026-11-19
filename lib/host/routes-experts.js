/**
 * dsh-supermemory「专家人格」域的路由 handler：GET + PUT `experts`。
 *
 * 面板的「专家人格」区只需要两个动作：**改主管**（谁是主管人格）与**改专长**
 * （某个人格擅长什么）。两者共用同一条路由，因为它们的响应体必须是同一个形状：
 * 前端拿一次响应就能整块刷新，不必发第二次 GET（与 `session-persona` 同一条纪律）。
 *
 * 依赖边界：**实例走注入，纯函数走 import**。
 *   - `deps.experts`（list / supervisor / setSupervisor / setExpertise）与
 *     `deps.delegations`（recent）由装配层提供：它们持有 store 的内存态与写队列，
 *     生命周期与 ready 时序都在装配层，路由层只调用。
 *   - 本文件不 import 任何 `@deepseek-ai/*` 宿主包，只用 `node:*` 与仓库内模块。
 *
 * 降级纪律（与 access 层同一条）：**缺 deps 不等于 500**。
 *   - `deps.experts` 完全缺失：GET 返回空数据（200），PUT 才 503 `EXPERTS_UNAVAILABLE`
 *     ——读永远给得出，写才需要真的能写。
 *   - `deps.delegations` 缺失或 `recent()` 抛错：`recent` 一律 `[]`，并**只 warn 一次**
 *     （缺依赖是装配事故，不是每请求刷一行的日志噪音）。
 *
 * 总开关（与人设三件套同口径）：**不做 `pluginEnabled()` 拦截**。关掉插件后用户仍要能
 * 改主管与专长，拦了等于把专家体系锁死。
 *
 * @module dsh-supermemory/host/routes-experts
 */

import { guard, readJsonBody, sendError, sendOk } from './http.js'

/** `GET` 回带的最近委派记录条数（契约：最近 50 条）。 */
const RECENT_LIMIT = 50

/**
 * 把一个值收敛成字符串（对象则取 name / slug，数字则转字符串）。
 * 委派记录来自磁盘 JSONL，字段类型不保证；面板只认字符串。
 * @param {unknown} value - 原始值。
 * @returns {string} 文本；拿不到时为空串。
 */
function scalarText(value) {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/**
 * 取「人设名」：字符串直用；对象优先 name，其次 slug。
 * @param {unknown} value - 原始值。
 * @returns {string} 显示名；拿不到时为空串。
 */
function nameOf(value) {
  if (typeof value === 'string') return value
  if (value === null || typeof value !== 'object') return ''
  if (typeof value.name === 'string' && value.name !== '') return value.name
  if (typeof value.slug === 'string' && value.slug !== '') return value.slug
  return ''
}

/**
 * 归一化一条委派记录。
 *
 * **只回带已知字段**：记录来自磁盘，多出来的键既没有契约也没有面板消费方，
 * 原样透传只会把内部字段泄进 UI。字段类型一律收敛，前端不必再判一遍。
 * @param {unknown} row - 原始记录。
 * @returns {object|null} 归一化记录；不是对象时返回 null（由调用方过滤）。
 */
function normalizeDelegation(row) {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return null
  const duration = typeof row.durationMs === 'number' && Number.isFinite(row.durationMs) ? row.durationMs : null
  return {
    at: scalarText(row.at),
    supervisor: nameOf(row.supervisor),
    persona: nameOf(row.persona),
    sessionId: scalarText(row.sessionId),
    label: scalarText(row.label),
    // 只有明确的 true 才算成功：缺失 / 字符串 / 数字都按失败显示，
    // 因为「不知道成没成」被读成「成功」比读成「失败」更危险。
    ok: row.ok === true,
    stopReason: scalarText(row.stopReason),
    durationMs: duration,
    taskPreview: scalarText(row.taskPreview),
    resultPreview: scalarText(row.resultPreview),
  }
}

/**
 * 归一化一个人设条目。
 * @param {unknown} entry - `store.listPersonas()` 的一项。
 * @returns {{slug:string, name:string, expertise:string, flagged:boolean}|null} 归一化条目；slug 无效时为 null。
 */
function normalizePersonaEntry(entry) {
  if (entry === null || typeof entry !== 'object') return null
  const slug = typeof entry.slug === 'string' ? entry.slug.trim() : ''
  if (slug === '') return null
  return {
    slug,
    name: typeof entry.name === 'string' && entry.name !== '' ? entry.name : slug,
    expertise: typeof entry.expertise === 'string' ? entry.expertise : '',
    // `listPersonas()` 自带一个 supervisor 布尔；它只在权威 `supervisorSync()`
    // 拿不到主管 slug 时作为兜底（降级路径），正常路径以 slug 相等为准。
    flagged: entry.supervisor === true,
  }
}

/**
 * 归一化主管对象。
 * @param {unknown} value - `store.supervisorSync()` 的返回值。
 * @returns {{slug:string, name:string}|null} 归一化主管；没有主管时 null。
 */
function normalizeSupervisor(value) {
  if (value === null || typeof value !== 'object') return null
  const slug = typeof value.slug === 'string' ? value.slug.trim() : ''
  if (slug === '') return null
  return { slug, name: typeof value.name === 'string' && value.name !== '' ? value.name : slug }
}

/**
 * 写操作（setSupervisor / setExpertise）的错误码 → HTTP 状态与对外错误码。
 *
 * `NOT_FOUND` 统一改写成 `PERSONA_NOT_FOUND`：与 `session-persona` 同一套对外叫法，
 * 前端不该同时认识两套名字。
 * @param {string} code - store 返回的错误码。
 * @returns {{status:number, code:string}} 映射结果；未知码一律 500。
 */
function expertWriteError(code) {
  if (code === 'BAD_INPUT') return { status: 400, code }
  if (code === 'NOT_FOUND') return { status: 404, code: 'PERSONA_NOT_FOUND' }
  return { status: 500, code }
}

/**
 * 装配「专家人格」域的路由 handler。
 *
 * @param {object} options - 依赖集合。
 * @param {object} options.deps - 装配层依赖；本域读 `experts` / `delegations` / `logger`。
 * @param {object} [options.access] - createAccess 的结果（只用 `safeCall`）。
 * @returns {{handleExperts: (req:object, res:object)=>Promise<void>}} 一组 handler。
 */
export function createExpertHandlers({ deps, access }) {
  const logger = deps?.logger
  const safeCall =
    typeof access?.safeCall === 'function'
      ? access.safeCall
      : async (fn, fallback) => {
          try {
            return await fn()
          } catch (error) {
            logger?.warn?.('supermemory: experts store call failed: %o', error)
            return fallback
          }
        }

  /** 两个「缺依赖」告警各只打一次：每请求刷一行只会把日志淹掉。 */
  let warnedExperts = false
  let warnedDelegations = false

  /** 取专家 API 实例；缺失或形态不对都返回 undefined。 */
  function expertApi() {
    const api = deps?.experts
    return api !== null && typeof api === 'object' ? api : undefined
  }

  /** 取委派记录 API 实例；缺失或形态不对都返回 undefined。 */
  function delegationApi() {
    const api = deps?.delegations
    return api !== null && typeof api === 'object' ? api : undefined
  }

  /**
   * 缺 `deps.experts` 时告警一次。
   * @returns {void}
   */
  function warnExpertsOnce() {
    if (warnedExperts) return
    warnedExperts = true
    logger?.warn?.('supermemory: deps.experts 缺失，专家人格面板将显示为空（GET 仍 200，PUT 返回 503）')
  }

  /**
   * 缺 `deps.delegations` 时告警一次。
   * @returns {void}
   */
  function warnDelegationsOnce() {
    if (warnedDelegations) return
    warnedDelegations = true
    logger?.warn?.('supermemory: deps.delegations 缺失，最近委派列表将显示为空')
  }

  /**
   * 同步读人设列表。
   *
   * 读失败返回 `[]` 而不是抛错：面板上少几行，比整块 500 好。
   * @returns {Array<object>} 原始条目数组（未归一化）。
   */
  function readPersonas() {
    const api = expertApi()
    if (typeof api?.list !== 'function') {
      warnExpertsOnce()
      return []
    }
    try {
      const listed = api.list()
      return Array.isArray(listed) ? listed : []
    } catch (error) {
      logger?.warn?.('supermemory: experts list failed: %o', error)
      return []
    }
  }

  /**
   * 同步读当前主管。
   * @returns {{slug:string, name:string}|null} 主管；没有主管或读不到时 null。
   */
  function readSupervisor() {
    const api = expertApi()
    if (typeof api?.supervisor !== 'function') {
      warnExpertsOnce()
      return null
    }
    try {
      return normalizeSupervisor(api.supervisor())
    } catch (error) {
      logger?.warn?.('supermemory: experts supervisor failed: %o', error)
      return null
    }
  }

  /**
   * 读最近委派记录（最新在前）。
   *
   * `recent()` 是异步的，且可能抛错；两条降级路径都收敛成 `[]`。
   * @returns {Promise<Array<object>>} 归一化后的记录。
   */
  async function recentDelegations() {
    const api = delegationApi()
    if (typeof api?.recent !== 'function') {
      warnDelegationsOnce()
      return []
    }
    const rows = await safeCall(() => api.recent(RECENT_LIMIT), [])
    if (!Array.isArray(rows)) return []
    return rows
      .slice(0, RECENT_LIMIT)
      .map(normalizeDelegation)
      .filter((row) => row !== null)
  }

  /**
   * 现算 GET / PUT 共用的 data 结构。
   *
   * 排序：**主管第一，其余保持 `listPersonas()` 的原序**。store 的列表本身按
   * `createdAt` 升序给出，路由层不再排一次——两处各排一次，规则一漂移就分叉。
   *
   * `overrides` 让 PUT 的回带不依赖「store 内存态在 Promise resolve 时已经反射」
   * 这一时序假设（与 `session-persona` 的 boundHint 同一动机）：写盘成功即生效，
   * 回带给前端的状态必须是新的。
   *
   * @param {{supervisor?: object|null, expertise?: {slug:string, expertise:string}}} [overrides] - 刚写入的值。
   * @returns {Promise<{supervisor:object|null, personas:Array<object>, recent:Array<object>}>} data。
   */
  async function expertsData(overrides = {}) {
    const supervisor = overrides.supervisor !== undefined ? overrides.supervisor : readSupervisor()
    const supervisorSlug = typeof supervisor?.slug === 'string' ? supervisor.slug : ''
    const personas = []
    for (const entry of readPersonas()) {
      const persona = normalizePersonaEntry(entry)
      if (persona === null) continue
      // 主管身份的唯一权威是 supervisor().slug；supervisor() 拿不到 slug 时
      // （降级路径）才退回条目自带的布尔，让面板至少还能显示徽标。
      const isSupervisor = supervisorSlug !== '' ? persona.slug === supervisorSlug : persona.flagged
      personas.push({
        slug: persona.slug,
        name: persona.name,
        // 两个字段同值：`supervisor` 是契约里的数据字段，`isSupervisor` 是给前端的
        // 显式判定位。同时给是为了前端不必再拿 slug 和 supervisor 比一次。
        supervisor: isSupervisor,
        isSupervisor,
        expertise: persona.expertise,
      })
    }
    if (overrides.expertise !== undefined) {
      const target = personas.find((persona) => persona.slug === overrides.expertise.slug)
      if (target !== undefined) target.expertise = overrides.expertise.expertise
    }
    // 稳定排序（ES2019 起 sort 稳定）：主管提到第一，其余保持 listPersonas 的 createdAt 升序。
    personas.sort((left, right) => Number(right.isSupervisor) - Number(left.isSupervisor))
    return { supervisor, personas, recent: await recentDelegations() }
  }

  /**
   * GET / HEAD：主管 + 专家列表 + 最近委派。
   * @param {object} req - 请求。
   * @param {object} res - 响应。
   * @returns {Promise<void>} 无。
   */
  async function handleGet(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendError(res, 405, 'method not allowed', 'METHOD_NOT_ALLOWED')
      return
    }
    // 读永远给得出：缺 deps.experts 也只是空列表 + 一条 warn，不是 500。
    sendOk(res, await expertsData())
  }

  /**
   * 执行一次写操作并把结果收敛成「成功值 / 错误响应」。
   *
   * @param {object} res - 响应。
   * @param {Function} write - 返回 Promise 的写操作。
   * @param {string} fallbackCode - 写操作返回 undefined（存储层不可用）时的错误码。
   * @returns {Promise<{ok:true, value:object}|{ok:false}>} 结果；已直接写响应时为 `{ok:false}`。
   */
  async function runWrite(res, write, fallbackCode) {
    const result = await safeCall(write, undefined)
    if (result === undefined || result === null) {
      sendError(res, 500, 'expert store write failed', fallbackCode)
      return { ok: false }
    }
    if (result.ok !== true) {
      const code = typeof result.code === 'string' ? result.code : fallbackCode
      const mapped = expertWriteError(code)
      sendError(res, mapped.status, String(result.message ?? mapped.code), mapped.code)
      return { ok: false }
    }
    return { ok: true, value: result }
  }

  /**
   * PUT：改主管 / 改专长（两者可同时给，依次执行，任一失败即返回错误）。
   * @param {object} req - 请求。
   * @param {object} res - 响应。
   * @returns {Promise<void>} 无。
   */
  async function handlePut(req, res) {
    const body = await readJsonBody(req, res)
    if (body === undefined) return

    const api = expertApi()
    if (api === undefined) {
      warnExpertsOnce()
      sendError(res, 503, 'expert api unavailable', 'EXPERTS_UNAVAILABLE')
      return
    }

    const hasSupervisor = body.supervisor !== undefined
    const hasExpertise = body.slug !== undefined || body.expertise !== undefined
    if (!hasSupervisor && !hasExpertise) {
      sendError(res, 400, 'supervisor or slug + expertise is required', 'BAD_INPUT')
      return
    }

    let nextSupervisor
    let nextExpertise

    if (hasSupervisor) {
      if (typeof body.supervisor !== 'string' || body.supervisor.trim() === '') {
        sendError(res, 400, 'supervisor must be a non-empty string', 'BAD_INPUT')
        return
      }
      if (typeof api.setSupervisor !== 'function') {
        sendError(res, 503, 'expert api unavailable', 'EXPERTS_UNAVAILABLE')
        return
      }
      const slug = body.supervisor.trim()
      const written = await runWrite(res, () => api.setSupervisor(slug), 'EXPERT_SUPERVISOR_FAILED')
      if (written.ok !== true) return
      // 优先用 store 实际落库的主管（可能带归一化后的显示名）；拿不到就按 slug 兜底。
      nextSupervisor = normalizeSupervisor(written.value.supervisor) ?? { slug, name: slug }
    }

    if (hasExpertise) {
      const slug = typeof body.slug === 'string' ? body.slug.trim() : ''
      if (slug === '') {
        sendError(res, 400, 'slug is required', 'BAD_INPUT')
        return
      }
      if (typeof body.expertise !== 'string') {
        sendError(res, 400, 'expertise must be a string', 'BAD_INPUT')
        return
      }
      if (typeof api.setExpertise !== 'function') {
        sendError(res, 503, 'expert api unavailable', 'EXPERTS_UNAVAILABLE')
        return
      }
      const written = await runWrite(res, () => api.setExpertise(slug, body.expertise), 'EXPERT_EXPERTISE_FAILED')
      if (written.ok !== true) return
      const stored = written.value.expertise
      nextExpertise = {
        slug,
        expertise: typeof stored === 'string' ? stored : body.expertise,
      }
    }

    // 响应体与 GET 完全同构：前端一处刷新逻辑通吃。
    sendOk(
      res,
      await expertsData({
        ...(nextSupervisor === undefined ? {} : { supervisor: nextSupervisor }),
        ...(nextExpertise === undefined ? {} : { expertise: nextExpertise }),
      }),
    )
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
  async function handleExperts(req, res) {
    try {
      await route(req, res)
    } catch (error) {
      logger?.warn?.('supermemory: experts route failed: %o', error)
      try {
        sendError(res, 500, error instanceof Error ? error.message : 'internal error', 'INTERNAL')
      } catch {
        /* 响应已关闭 */
      }
    }
  }

  return { handleExperts }
}
