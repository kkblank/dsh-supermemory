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
export function checkProjectRoot(projectRoot) {  if (typeof projectRoot !== 'string' || projectRoot === '') {
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
 * 判断一个已通过 checkProjectRoot 的项目根是否命中已注册项目清单。
 *
 * 安全模型升级（routes.js 修复 10）：此前只拒绝 `..`，接受任意绝对路径——
 * 攻击者拿到面板的信任上下文就能读写任意目录下的记忆文件。现在 doc / digest 的
 * projectRoot 必须**命中 deps.listProjects()（workspaceRegistry）已注册的项目根**
 * 才放行。判定用逐字相等，另做一次 normalize 兜底（注册表里的 root 是规范化形态）。
 *
 * @param {string} projectRoot - 已通过 checkProjectRoot 的规范化绝对路径。
 * @param {Array<{path?:string, root?:string}>|undefined} projects - deps.listProjects() 的结果。
 * @returns {boolean} 是否命中已注册项目。
 */
export function projectRootRegistered(projectRoot, projects) {
  if (typeof projectRoot !== 'string' || projectRoot === '' || !Array.isArray(projects)) return false
  const target = normalize(projectRoot)
  return projects.some((item) => {
    const candidate = typeof item?.root === 'string' && item.root !== '' ? item.root : item?.path
    if (typeof candidate !== 'string' || candidate === '') return false
    return candidate === projectRoot || normalize(candidate) === target
  })
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
 * 归一化**全部插件设置**（v3 起含 `enabled` 总开关；v19 起含召回筛选器三项）。
 *
 * 函数名沿用 `normalizeDigestSettings`：改名会牵动 routes-settings / access 与一批测试，
 * 而它的职责一直是「把 store 的设置返回值规整成面板可用的形状」，只是这份设置从「整理模型」
 * 扩到了「插件全部设置」，所以名字保留、语义在注释里说清。
 *
 * `enabled` 一律取调用方传入的**运行时权威判定**（`deps.isEnabled()`，缺失按开启），
 * 不采用存储层返回值：注入 / 工具 / 命令层判定的就是它，面板跟着它走才能保证
 * 「界面显示的状态 == 后台真正的行为」。存储层的 `enabled` 由装配层自己读盘，
 * 两条路径同源，不需要在这里再猜一次。
 *
 * v19：`recallFilterEnabled` 是召回筛选器开关，缺省开启（缺键 / 非布尔以外的形态一律按开启，
 * 与 `enabled` 同一口径——只有明确的 `false` 才算关闭）；两个路由键缺省为空串。
 *
 * @param {unknown} value - store / 装配层返回值。
 * @param {boolean} [enabled] - 运行时权威开关（`pluginEnabled()` 的结果）。
 * @returns {{enabled:boolean, digestProvider:string, digestModel:string,
 *   recallFilterEnabled:boolean, recallFilterProvider:string, recallFilterModel:string}} 设置。
 */
export function normalizeDigestSettings(value, enabled = true) {
  return {
    enabled: enabled !== false,
    digestProvider: typeof value?.digestProvider === 'string' ? value.digestProvider : '',
    digestModel: typeof value?.digestModel === 'string' ? value.digestModel : '',
    // v19：召回筛选器配置。开关走布尔，路由两键走字符串。
    recallFilterEnabled: value?.recallFilterEnabled !== false,
    recallFilterProvider: typeof value?.recallFilterProvider === 'string' ? value.recallFilterProvider : '',
    recallFilterModel: typeof value?.recallFilterModel === 'string' ? value.recallFilterModel : '',
  }
}
