/**
 * dsh-supermemory 路由的数据访问层（deps / store 的安全包装）。
 *
 * 从 lib/host/routes.js 的 installRoutes 闭包里原样搬出，函数体一字未改。
 * 这一组函数的共同职责是「安全地读装配层或存储层：拿不到就返回兜底值并打一条
 * warn，绝不把异常抛给宿主」。它们被 bootstrap / doc / digest / settings /
 * personas 各域共用，所以独立成一层，而不是塞进某一个 handler 文件里。
 *
 * 边界：只认 deps / logger / store 三个依赖，不碰 req / res，因此不产生任何
 * HTTP 语义。工厂只在 installRoutes 里调用一次，作用域与原闭包完全等价。
 *
 * @module dsh-supermemory/host/access
 */

import { normalizeDigestSettings, normalizePersona } from './params.js'

/**
 * 装配路由共用的数据访问函数。
 * @param {object} options - 依赖集合。
 * @param {object} options.deps - 装配层依赖。
 * @param {object} options.logger - 日志器。
 * @param {object} options.store - 存储层。
 * @returns {object} 一组安全访问函数。
 */
export function createAccess({ deps, logger, store }) {
  /** 安全读配置。 */
  function readConfig() {
    try {
      const value = deps?.getConfig?.()
      return value !== null && typeof value === 'object' ? value : {}
    } catch {
      return {}
    }
  }

  /**
   * 插件总开关（v3 软开关，存 settings.json 的 `enabled`）。
   *
   * 铁律：只有 `deps.isEnabled()` 明确返回 false 才算关闭。装配层没提供该函数、
   * 或它自己抛错，都按「开启」处理——宁可多注入一次，也不能让面板变成砖。
   * @returns {boolean} 插件是否生效。
   */
  function pluginEnabled() {
    try {
      return deps?.isEnabled?.() !== false
    } catch (error) {
      logger.warn?.('supermemory: isEnabled failed: %o', error)
      return true
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

  /** 读插件设置（整理模型 + 总开关）：优先装配层直通，回退 store；缺失/出错返回默认。 */
  async function readDigestSettings() {
    const enabled = pluginEnabled()
    const direct = deps?.settings
    const reader =
      typeof direct?.read === 'function'
        ? () => direct.read()
        : typeof store?.readSettings === 'function'
          ? () => store.readSettings()
          : undefined
    if (reader === undefined) return normalizeDigestSettings({}, enabled)
    return normalizeDigestSettings(await safeCall(reader, {}), enabled)
  }

  /**
   * 写插件设置。
   * @param {object} patch - 含 digestProvider / digestModel / enabled 中的一项或多项。
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

  return { readConfig, pluginEnabled, safeCall, personaApi, readDigestSettings, writeDigestSettings, personasData }
}
