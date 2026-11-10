/**
 * 存储层的**纯函数与常量**：不碰磁盘、不碰进程内缓存、不读 createStore 闭包里的任何状态。
 * （契约 §4 + §V2.2 + §V3.3）
 *
 * 为什么这么分：
 *   `store.js` 的主体是 `createStore` 这个巨型闭包工厂，里面的函数共享
 *   cache / writeQueues / 写队列 / personasState / settingsState / logger / now，
 *   是一个必须整体理解的状态机（原子写、mtime 冲突检测、STALE 重试都在里面）。
 *   而本文件的东西只吃入参和模块级常量，搬出来是零行为变化，
 *   顺带让「哪些逻辑是无状态的、可以直接推理」这件事一目了然。
 *
 * 新增成员必须同时满足下面三条，否则请留在 `store.js`，不要为了行数硬搬：
 *   1. 不使用 node:fs / node:crypto 等任何 IO；
 *   2. 不读写 createStore 的闭包状态（cache、writeQueues、personasState、
 *      settingsState、migrationResult、logger、now、personasRoot 等）；
 *   3. 只依赖入参与本文件里的常量、或 node:path 这类无副作用的模块级依赖。
 *   一旦某个 normalize 需要 warn / config / state，它就不属于这里。
 *
 * 依赖方向单向：`store.js` → 本文件。本文件**永不** import `store.js`，避免循环依赖。
 *
 * @module dsh-supermemory/core/store-normalize
 */

import { basename, isAbsolute, join } from 'node:path'

export const REGISTRY_VERSION = 1 // personas.json / settings.json 的版本号
/** 插件设置的默认值（enabled 是插件总开关，缺省开启）。 */
export const DEFAULT_SETTINGS = Object.freeze({ enabled: true, digestProvider: '', digestModel: '' })
/** 插件设置允许的键（值类型以 DEFAULT_SETTINGS 同名键为准）。 */
export const SETTINGS_KEYS = Object.freeze(['enabled', 'digestProvider', 'digestModel'])

/** ref 校验失败（内部错误类型，不属于 Store 对外 API）。 */
export class StoreRefError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'StoreRefError'
    this.code = code
  }
}

/** 把异常转成可读消息。 */
export function describe(error) {
  return error === null || error === undefined ? 'unknown error' : error?.message !== undefined ? String(error.message) : String(error)
}

/** BAD_INPUT 返回值。 */
export const badInput = (message) => ({ ok: false, code: 'BAD_INPUT', message })

/** 解析 JSON 文本（失败返回 undefined，不抛）。 */
export function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** 从 options 里取人设根目录（personasRoot 优先，presetsRoot 为废弃别名）。 */
export function pickRoot(options) {
  for (const key of ['personasRoot', 'presetsRoot']) {
    const value = options?.[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return ''
}

/** 从 options 里取旧 presets 目录（默认 `$DSH_HOME/supermemory/presets`）。 */
export function pickLegacyRoot(options, stateDir) {
  const explicit = options?.legacyPresetsRoot
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim()
  return join(stateDir, 'presets')
}

/** ref 的隔离键：persona 优先，presetId 作为过渡兼容，缺省 default。 */
export function personaKey(ref) {
  if (typeof ref.persona === 'string' && ref.persona.trim() !== '') return ref.persona
  if (typeof ref.presetId === 'string' && ref.presetId.trim() !== '') return ref.presetId
  return 'default'
}

/** 规范化 personas.json 内容；文件结构非法返回 null。 */
export function normalizeRegistry(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const personas = []
  const seen = new Set()
  for (const item of Array.isArray(raw.personas) ? raw.personas : []) {
    if (item === null || typeof item !== 'object') continue
    const slug = typeof item.slug === 'string' ? item.slug.trim() : ''
    if (slug === '' || seen.has(slug)) continue
    seen.add(slug)
    const name = typeof item.name === 'string' && item.name.trim() !== '' ? item.name.trim() : slug
    const createdAt = typeof item.createdAt === 'string' ? item.createdAt : ''
    personas.push({ slug, name, createdAt })
  }
  const current = typeof raw.current === 'string' ? raw.current.trim() : ''
  return { version: REGISTRY_VERSION, current, personas }
}

/** 规范化 settings.json 内容：按键的默认值类型分派（布尔/字符串），其它类型视为非法并回退默认。 */
export function normalizeSettings(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const result = { ...DEFAULT_SETTINGS }
  for (const key of SETTINGS_KEYS) {
    if (typeof source[key] === typeof DEFAULT_SETTINGS[key]) result[key] = source[key]
  }
  return result
}

/** 按 createdAt 升序（空串在前）。 */
export function sortPersonas(personas) {
  return [...personas].sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')))
}

// —————————————————————————— 落盘前快照（契约 §V4.0.5） ——————————————————————————
// 命名、识别与裁剪是纯字符串计算（不吃时钟、不碰磁盘），放在这里可以直接推理；
// 取时间、建目录、写文件、排队这些带状态的部分留在 store.js 的 writeDocSnapshot。

/** 快照子目录名（与文档同目录的 `history/`）。 */
export const SNAPSHOT_DIR = 'history'

/** 快照文件名格式：`<原文件名去扩展>-<yyyyMMdd'T'HHmmss'Z'>-<4hex>.md`。 */
const SNAPSHOT_NAME = /^(.+)-(\d{8}T\d{6}Z)-([0-9a-f]{4})\.md$/

/**
 * 把毫秒时间戳格式化成快照文件名里的紧凑 UTC 时间。
 * 定长 15 字符，所以文件名的字典序就是时间序。
 *
 * @param {unknown} timestampMs - 毫秒时间戳（由调用方注入的时钟提供）。
 * @returns {string} 形如 `20261110T072233Z`；时间戳非法返回空串。
 */
export function snapshotStamp(timestampMs) {
  if (typeof timestampMs !== 'number' || !Number.isFinite(timestampMs)) return ''
  let iso
  try {
    iso = new Date(timestampMs).toISOString()
  } catch {
    return '' // new Date(超出范围).toISOString() 抛 RangeError，这里一并吞掉
  }
  return iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

/**
 * 拼快照文件名。随机后缀由调用方生成并传入，本函数只取前 4 位十六进制。
 *
 * @param {string} docFileName - 文档文件名（只取文件名部分与扩展名，不吃目录）。
 * @param {unknown} timestampMs - 毫秒时间戳。
 * @param {unknown} randHex - 随机十六进制串。
 * @returns {string} 快照文件名；时间戳非法时返回空串（调用方据此报错，不落盘）。
 */
export function snapshotFileName(docFileName, timestampMs, randHex) {
  const stamp = snapshotStamp(timestampMs)
  if (stamp === '') return ''
  const stem = String(docFileName ?? '')
    .replace(/^.*[/\\]/, '')
    .replace(/\.md$/i, '')
  return `${stem === '' ? 'memory' : stem}-${stamp}-${String(randHex ?? '').slice(0, 4)}.md`
}

/**
 * 裁剪快照文件名：保留最近 `keep` 份，多余的是 `removed`。
 *
 * - 排序用**码点字典序**（不用 localeCompare：它按 locale 给连字符等标点降权，
 *   会破坏「定长时间戳 ⇒ 字典序即时间序」这个前提）。
 * - 不符合快照命名的文件**既不进 keep 也不进 removed**——快照目录可能被人放过别的东西，
 *   裁剪只删自己生成的文件。
 * - `keep` 非法回退 3；小于 1 钳到 1，避免出现「刚写完就把刚写的快照删掉」。
 *
 * @param {unknown} names - 目录里的文件名列表。
 * @param {unknown} [keep] - 保留份数。
 * @returns {{ keep: string[], removed: string[] }} 两份都是升序（旧 → 新）。
 */
export function pruneSnapshotNames(names, keep = 3) {
  const wanted = typeof keep === 'number' && Number.isFinite(keep) ? Math.trunc(keep) : 3
  const limit = wanted < 1 ? 1 : wanted
  const sorted = (Array.isArray(names) ? names : [])
    .filter((name) => typeof name === 'string' && SNAPSHOT_NAME.test(name))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const excess = sorted.length - limit
  if (excess <= 0) return { keep: sorted, removed: [] }
  return { keep: sorted.slice(excess), removed: sorted.slice(0, excess) }
}

/** 规范化 projects.json：过滤坏项、按 root 去重。 */
export function normalizeProjects(raw) {
  const byRoot = new Map()
  for (const item of Array.isArray(raw?.projects) ? raw.projects : []) {
    if (item === null || typeof item !== 'object') continue
    const root = typeof item.root === 'string' ? item.root : typeof item.path === 'string' ? item.path : ''
    if (root === '' || !isAbsolute(root)) continue
    const name = typeof item.name === 'string' && item.name !== '' ? item.name : basename(root)
    const lastSeenAt = typeof item.lastSeenAt === 'string' ? item.lastSeenAt : ''
    byRoot.set(root, { path: root, root, name, lastSeenAt })
  }
  return [...byRoot.values()]
}
