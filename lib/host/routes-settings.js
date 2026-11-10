/**
 * dsh-supermemory「面板设置」域的路由 handler：GET models + PUT settings + personas 三件套。
 *
 * 从 lib/host/routes.js 的 installRoutes 闭包里原样搬出，函数体一字未改。
 * 这三个接口共同服务面板的「设置 / 人设」区：可用模型与当前整理模型、v3 总开关
 * 的写入、人设的列出 / 新建 / 切换，触达 deps 与 store 都只经 access 层。
 *
 * 工厂参数即原来的闭包变量：deps 直接传，readDigestSettings / writeDigestSettings /
 * personasData / personaApi / safeCall / pluginEnabled 取自 access 层。
 *
 * @module dsh-supermemory/host/routes-settings
 */

import { guard, readJsonBody, sendError, sendOk } from './http.js'
import { normalizeDigestSettings } from './params.js'

/** 人设名称最大长度（契约 §V2.4）。 */
const PERSONA_NAME_MAX = 60

/**
 * 装配「面板设置」域的路由 handler。
 * @param {object} options - 依赖集合。
 * @param {object} options.deps - 装配层依赖。
 * @param {object} options.access - createAccess 的结果。
 * @returns {{handleModels: Function, handleSettings: Function, handlePersonas: Function}} 一组 handler。
 */
export function createSettingsHandlers({ deps, access }) {
  const { readDigestSettings, writeDigestSettings, personasData, personaApi, safeCall, pluginEnabled } = access

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

  /** PUT settings：保存整理模型（空串表示跟随当前会话）与 v3 总开关。 */
  async function handleSettings(req, res) {
    if (!guard(req, res)) return
    if (req.method !== 'PUT') {
      sendError(res, 405, 'method not allowed', 'METHOD_NOT_ALLOWED')
      return
    }
    const body = await readJsonBody(req, res)
    if (body === undefined) return
    const patch = {}
    // v3：总开关只接受真正的布尔，字符串 / 数字一律 400，避免「以为关了其实没关」。
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') {
        sendError(res, 400, 'enabled must be a boolean', 'BAD_INPUT')
        return
      }
      patch.enabled = body.enabled
    }
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
      sendError(res, 400, 'enabled, digestProvider or digestModel is required', 'BAD_INPUT')
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
    // 模型两键沿用写入结果做回显；enabled 反过来——写完重新按运行时判定取一次。
    // 存储层没真正落地这一位时，界面必须显示真实状态，不能以为关了其实还在注入。
    const digestSettings = normalizeDigestSettings({ ...stored, ...patch }, pluginEnabled())
    // 顶层再回带一次 enabled：客户端据此确认写入真的生效，不做「界面说关了其实没关」。
    sendOk(res, { enabled: digestSettings.enabled, digestSettings })
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

  return { handleModels, handleSettings, handlePersonas }
}
