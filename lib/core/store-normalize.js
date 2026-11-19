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

/** 专长描述的最大字符数（按**码点**计，不是 UTF-16 码元，避免把 emoji 劈成两半）。 */
export const MAX_EXPERTISE = 500

/**
 * 「重复主管被降级了几条」这个诊断信息的键。
 *
 * 为什么用**不可枚举**属性挂载：`normalizeRegistry` 是纯函数模块（本文件模块头三条铁律），
 * 契约 §0.2 要求需要 `warn` 的判断留在 `store.js`，所以这里只能把「发现了几个主管」这个
 * 事实带出去，由 `store.js` 决定要不要告警。而注册表对象随后会被 `JSON.stringify` 写进
 * personas.json，也会被调用方拿去做 `assert.deepEqual` —— 一个可枚举的新字段会同时污染
 * 落盘内容和既有断言。不可枚举属性两边都看不见，是侵入性最小的载体。
 *
 * @type {symbol}
 */
const DROPPED_SUPERVISORS = Symbol('droppedSupervisors')

/**
 * 读 `normalizeRegistry` 带出的「重复主管被降级」条数。
 *
 * 传入的不是本模块 `normalizeRegistry` 的返回值时返回 0（不抛）。
 *
 * @param {unknown} registry - `normalizeRegistry` 的结果。
 * @returns {number} 被降级的条数；0 表示没有重复主管（或没有这个信息）。
 */
export function droppedSupervisors(registry) {
  const count = registry?.[DROPPED_SUPERVISORS]
  return typeof count === 'number' && count > 0 ? count : 0
}

/**
 * 清洗专长文本：非字符串一律空串；换行（含 CRLF / 连续空行）折叠成单个空格；
 * 去首尾空白；按码点截断到 `MAX_EXPERTISE`。
 *
 * 折叠用**一个连续的 `[\r\n]+`** 而不是 `/\r\n|[\r\n]+/`：后者的 `\r\n` 分支会先吃掉
 * CRLF，紧跟着的 `\n`（空行）再单独折一次，一个空行就变成两个空格。用字符类连续匹配，
 * 任意长度的换行序列都只换一个空格。
 *
 * 只折叠换行、不动行内的连续空格：专长是给人读的一句话，用户偶尔用多个空格对齐
 * 不是错误，但换行会把面板与提示词里的单行字段撑成多行，必须压平。
 *
 * @param {unknown} value - 原始专长文本。
 * @returns {string} 清洗后的单行专长（空串表示「没有专长」）。
 */
export function normalizeExpertise(value) {
  if (typeof value !== 'string') return ''
  const folded = value.replace(/[\r\n]+/g, ' ').trim()
  return [...folded].slice(0, MAX_EXPERTISE).join('')
}

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

/**
 * 规范化 personas.json 内容；文件结构非法返回 null。
 *
 * 除原有 `slug` / `name` / `createdAt` 外，v13 起保留两个可选字段（契约 §V13）：
 * - `supervisor: true` —— 是否主管。**全表最多一个**：按 personas 数组顺序只认第一个，
 *   其余静默降级为「不是主管」（不写 `supervisor: false`，保持旧文件字节不变）。
 * - `expertise` —— 专长描述，经 `normalizeExpertise` 清洗；空串不写进条目。
 *
 * 为什么两个字段都「只在有值时才写」：personas.json 是用户数据也是既有测试的断言对象
 * （大量 `assert.deepEqual(registry.personas, [{ slug, name, createdAt }])`），
 * 给每条都补 `supervisor:false` / `expertise:''` 会让老用户的文件无端膨胀、也会把
 * 无关断言打红。缺省即 false / 空串，读侧行为完全等价。
 *
 * 多个主管这件事**不在这里 warn**（本文件是纯函数模块，契约 §0.2 要求需要日志的判断留在
 * `store.js`）。降级条数用不可枚举 symbol 挂在返回值上，由 `droppedSupervisors()` 读出，
 * `store.js` 据此告警一次——不可枚举是为了不污染落盘内容与 deepEqual 断言。
 *
 * @param {unknown} raw - personas.json 解析出的原始值。
 * @returns {object|null} 规范化后的注册表；结构非法返回 null。
 */
export function normalizeRegistry(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const personas = []
  const seen = new Set()
  let droppedSupervisorsCount = 0
  let supervisorTaken = false
  for (const item of Array.isArray(raw.personas) ? raw.personas : []) {
    if (item === null || typeof item !== 'object') continue
    const slug = typeof item.slug === 'string' ? item.slug.trim() : ''
    if (slug === '' || seen.has(slug)) continue
    seen.add(slug)
    const name = typeof item.name === 'string' && item.name.trim() !== '' ? item.name.trim() : slug
    const createdAt = typeof item.createdAt === 'string' ? item.createdAt : ''
    const entry = { slug, name, createdAt }
    // supervisor 只认真正的布尔 true：字符串 'true' / 1 / 其它真值一律不算，避免手编文件
    // 里一个拼错的写法把主管身份悄悄挪到别人头上。
    if (item.supervisor === true) {
      if (supervisorTaken) droppedSupervisorsCount += 1
      else {
        entry.supervisor = true
        supervisorTaken = true
      }
    }
    const expertise = normalizeExpertise(item.expertise)
    if (expertise !== '') entry.expertise = expertise
    personas.push(entry)
  }
  const current = typeof raw.current === 'string' ? raw.current.trim() : ''
  const registry = { version: REGISTRY_VERSION, current, personas }
  if (droppedSupervisorsCount > 0) {
    Object.defineProperty(registry, DROPPED_SUPERVISORS, { value: droppedSupervisorsCount, enumerable: false })
  }
  return registry
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
