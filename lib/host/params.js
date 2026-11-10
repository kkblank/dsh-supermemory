/**
 * dsh-supermemory 入参校验与响应值归一化。
 *
 * 从 lib/host/routes.js 拆出：所有「客户端传来的东西能不能用」的规则集中在这里，
 * 全部是纯函数，不碰 req / res / store / deps。安全要点是 scope / persona /
 * projectRoot 三类参数——文件路径只能经 store 的 ref 校验得出，
 * 绝不接受任意路径（契约 §5.5）。
 *
 * resolveWritableScopes 与 lib/host/digest.js 保持同一规则；
 * normalizeDigestSettings 的 enabled 一律取调用方传入的运行时权威判定，
 * 保证「界面显示的状态 == 后台真正的行为」。
 *
 * @module dsh-supermemory/host/params
 */

import { isAbsolute, normalize, sep } from 'node:path'

/** 合法的记忆类别。 */
const SCOPES = new Set(['soul', 'user', 'global', 'project'])

/** 默认允许自动整理写入的 scope（v2 只写 project）。 */
const DEFAULT_WRITABLE_SCOPES = Object.freeze(['project'])

/** v2 硬限制：自动整理永不写这些 scope（§V2.3）。 */
const HARD_WRITABLE_SCOPES = new Set(['project'])

/**
 * 解析允许自动整理写入的 scope 列表（与 lib/host/digest.js 保持同一规则）。
 * @param {object} config - ResolvedConfig。
 * @returns {string[]} scope 列表。
 */
export function resolveWritableScopes(config) {
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
export function absolutePath(path) {
  return path.startsWith('/') ? path : `/${path}`
}

/**
 * 校验 persona slug：非空字符串，不含路径分隔符、NUL 或 `.`/`..`。
 * @param {unknown} value - 原始值。
 * @returns {{ok:true, value:string}|{ok:false, error:string}} 结果。
 */
export function checkPersona(value) {
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
export function checkProjectRoot(projectRoot) {
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
export function buildRef(scope, persona, projectRoot) {
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
export function extractTitle(text) {
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
export function normalizePersona(value) {
  if (value === null || typeof value !== 'object') return null
  if (typeof value.slug !== 'string' || value.slug === '') return null
  return { slug: value.slug, name: typeof value.name === 'string' ? value.name : value.slug }
}

/**
 * 归一化插件设置（v3：除整理模型外还带 `enabled` 总开关）。
 *
 * `enabled` 一律取调用方传入的**运行时权威判定**（`deps.isEnabled()`，缺失按开启），
 * 不采用存储层返回值：注入 / 工具 / 命令层判定的就是它，面板跟着它走才能保证
 * 「界面显示的状态 == 后台真正的行为」。存储层的 `enabled` 由装配层自己读盘，
 * 两条路径同源，不需要在这里再猜一次。
 *
 * @param {unknown} value - store / 装配层返回值。
 * @param {boolean} [enabled] - 运行时权威开关（`pluginEnabled()` 的结果）。
 * @returns {{enabled:boolean, digestProvider:string, digestModel:string}} 设置。
 */
export function normalizeDigestSettings(value, enabled = true) {
  return {
    enabled: enabled !== false,
    digestProvider: typeof value?.digestProvider === 'string' ? value.digestProvider : '',
    digestModel: typeof value?.digestModel === 'string' ? value.digestModel : '',
  }
}
