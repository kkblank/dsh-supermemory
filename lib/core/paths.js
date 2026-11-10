/**
 * 纯路径工具：人设 slug、项目根解析、安全 join。
 *
 * 本模块不 import 任何宿主包，只依赖 `node:path` / `node:fs`。
 *
 * v2：记忆隔离单位从 agent preset 改为「人设（persona）」；
 * `personaSlug` 是新的正式名，`presetSlug` 作为别名保留（见契约 §V2.1）。
 *
 * @module dsh-supermemory/core/paths
 */

import { stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

/** safeJoin 抛出的错误，`code` 为 `PATH_TRAVERSAL` 或 `BAD_INPUT`。 */
export class SafeJoinError extends Error {
  /**
   * @param {string} message - 错误描述。
   * @param {'PATH_TRAVERSAL' | 'BAD_INPUT'} [code] - 错误码。
   */
  constructor(message, code = 'BAD_INPUT') {
    super(message)
    this.name = 'SafeJoinError'
    this.code = code
  }
}

/** 允许出现在人设目录名里的字符：Unicode 字母、数字、`._-`。 */
const SLUG_ALLOWED = /[\p{L}\p{N}._-]/u
/** slug 最大字符数（避免超长目录名撞文件系统上限）。 */
const SLUG_MAX = 48

/**
 * 人设名 → 安全目录名（契约 §V2.1）。
 *
 * 保留 Unicode 字母与数字（含中文），其余字符折叠成单个 `-`；
 * 去掉首尾 `-`，超长截断到 48 字符。空串 / 全部非法 / `.` / `..` 回退 `'default'`。
 *
 * 之所以保留 Unicode：用户用人设名（如「工作助手」）直接建目录，
 * 若把中文全部替换成 `-`，所有中文人设都会挤到 `default`，人设功能就失效了。
 *
 * @param {unknown} name - 人设名或人设 slug。
 * @returns {string} 安全目录名。
 */
export function personaSlug(name) {
  if (typeof name !== 'string') return 'default'
  if (!SLUG_ALLOWED.test(name)) return 'default'
  const slug = name
    .trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, SLUG_MAX)
    .replace(/^-+|-+$/gu, '')
  if (slug === '' || slug === '.' || slug === '..') return 'default'
  return slug
}

/**
 * `personaSlug` 的别名（v1 名字，保留以平滑迁移）。
 *
 * @type {(presetId: unknown) => string}
 */
export const presetSlug = personaSlug

/**
 * 项目根名（用于注入标题展示）。
 *
 * @param {unknown} root - 项目根绝对路径。
 * @returns {string} root 的 basename；非法输入返回空串。
 */
export function projectDisplayName(root) {
  if (typeof root !== 'string' || root === '') return ''
  const name = basename(root)
  return name === sep ? '' : name
}

/** 默认探针：判断 `dir/.git` 是否存在（任何异常都视为不存在）。 */
async function defaultProbe(dir) {
  try {
    await stat(join(dir, '.git'))
    return true
  } catch {
    return false
  }
}

/**
 * 从 cwd 向上找含 `.git` 的目录。
 *
 * 任何 IO/权限异常都回退到 `{ root: cwd, reason: 'error' }`，绝不抛错。
 *
 * @param {string} cwd - 起始绝对路径。
 * @param {(dir: string) => boolean | Promise<boolean>} [probe] - 自定义探针。
 * @returns {Promise<{ root: string, reason: 'marker' | 'fallback' | 'error' }>} 解析结果。
 */
export async function resolveProjectRoot(cwd, probe = defaultProbe) {
  if (typeof cwd !== 'string' || cwd.trim() === '') {
    return { root: resolve(cwd ?? process.cwd()), reason: 'error' }
  }

  const start = resolve(cwd)
  const test = typeof probe === 'function' ? probe : defaultProbe

  try {
    let dir = start
    for (;;) {
      if (await test(dir)) return { root: dir, reason: 'marker' }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    return { root: start, reason: 'fallback' }
  } catch {
    return { root: start, reason: 'error' }
  }
}

/**
 * 把 relPath 安全拼到 root 下。
 *
 * 拒绝：root 非绝对路径、relPath 非字符串/为空、绝对路径、含 `..` 段、
 * 含空段（尾随分隔符除外）、解析后越界。
 *
 * @param {string} root - 绝对根目录。
 * @param {string} relPath - 相对路径。
 * @returns {string} 绝对路径。
 * @throws {SafeJoinError} `BAD_INPUT` 或 `PATH_TRAVERSAL`。
 */
export function safeJoin(root, relPath) {
  if (typeof root !== 'string' || root === '' || !isAbsolute(root)) {
    throw new SafeJoinError('root must be an absolute path', 'BAD_INPUT')
  }
  if (typeof relPath !== 'string') {
    throw new SafeJoinError('relPath must be a string', 'BAD_INPUT')
  }
  if (relPath.trim() === '') {
    throw new SafeJoinError('relPath must not be empty', 'BAD_INPUT')
  }
  if (isAbsolute(relPath) || /^[A-Za-z]:[\\/]/.test(relPath)) {
    throw new SafeJoinError('relPath must be relative', 'PATH_TRAVERSAL')
  }

  // 反斜杠在 Windows 上是分隔符；统一按分隔符切分做校验。
  const segments = relPath.split(/[\\/]/)
  const trailing = segments.length > 0 && segments[segments.length - 1] === ''
  if (trailing) segments.pop()

  for (const segment of segments) {
    if (segment === '') throw new SafeJoinError('relPath contains an empty segment', 'BAD_INPUT')
    if (segment === '..') throw new SafeJoinError('relPath must not contain ".."', 'PATH_TRAVERSAL')
    if (segment === '.') throw new SafeJoinError('relPath must not contain "."', 'BAD_INPUT')
  }

  const resolvedRoot = resolve(root)
  const target = resolve(resolvedRoot, ...segments)
  // 统一前缀：根目录自身以分隔符结尾时（如 '/'）不能再追加 sep，否则前缀变成 '//'。
  const prefix = resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep
  if (target !== resolvedRoot && !target.startsWith(prefix)) {
    throw new SafeJoinError('relPath escapes root', 'PATH_TRAVERSAL')
  }
  return target
}
