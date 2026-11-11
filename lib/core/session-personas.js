/**
 * 会话级人设映射：哪个会话单独指定了哪个人设（契约 §V9.1 + §V9.2）。
 *
 * 只记录**被单独指定过**的会话：`{ "version": 1, "sessions": { "session-0192...": "灰灰" } }`。
 * 键缺席 = 跟随全局 `currentPersona`，绝不写「等于全局当前值」的固化条目；值经 `personaSlug()` 归一。
 *
 * 三条不变式（契约 §V9.2 铁律）：1. `get()` 必须同步——`systemPrompt.section` 的 `text`
 * 回调同步执行、不能 await，故构造时异步加载一次，`ready` 前返回 `undefined`（= 跟随全局）；
 * 2. 任何 IO 异常一律转成返回值里的 `code`（`UNWRITABLE` / `BAD_INPUT`），绝不抛到宿主；
 * 3. 写盘「同目录临时文件 + rename」，同路径写串行，成功才更新内存态、失败内存态不变。
 * 依赖面：只 import `node:fs/promises` / `node:path` 与 `./paths.js` 的 `personaSlug`。
 * @module dsh-supermemory/core/session-personas
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import { personaSlug } from './paths.js'

/** 映射文件版本号；非法/缺失一律按空表读取（不猜、不迁移、不抛错）。 */
export const SESSION_PERSONAS_VERSION = 1
/** 映射文件名（落在 `<dshHome>/supermemory/` 下，与 `personas.json` 平级）。 */
export const SESSION_MAP_FILE = 'session-personas.json'
/** sessionId 最大长度（字符）。 */
export const SESSION_ID_MAX = 200

/** sessionId 白名单：字母、数字、`.`、`_`、`:`、`-`。 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]+$/

/** 把异常转成可读消息（与 store.js 的 `describe` 同口径）。 */
function describe(error) {
  if (error === null || error === undefined) return 'unknown error'
  return error?.message !== undefined ? String(error.message) : String(error)
}

/** 解析 JSON 文本（失败返回 undefined，不抛）。 */
const parseJson = (text) => {
  try { return JSON.parse(text) } catch { return undefined }
}

/** BAD_INPUT 返回值。 */
const badInput = (message) => ({ ok: false, code: 'BAD_INPUT', message })

/** 空表（每次新建，避免调用方拿到共享引用）。 */
const emptyState = () => ({ version: SESSION_PERSONAS_VERSION, sessions: {} })

/**
 * 往 sessions 写一个条目。用 `defineProperty` 而非赋值：白名单含下划线，
 * `__proto__` 也能通过校验，直接赋值会改原型并**静默丢掉**该绑定。
 *
 * @param {Record<string, string>} sessions - 目标对象（原地写）。
 * @param {string} sessionId - 已校验的会话 id。
 * @param {string} slug - 归一后的人设 slug。
 */
function defineSession(sessions, sessionId, slug) {
  Object.defineProperty(sessions, sessionId, { value: slug, enumerable: true, writable: true, configurable: true })
}

/** 复制 sessions（值全是字符串，深一层即可）。 */
function copySessions(source) {
  const sessions = {}
  if (source === null || typeof source !== 'object') return sessions
  for (const [key, value] of Object.entries(source)) defineSession(sessions, key, value)
  return sessions
}

/**
 * 校验 sessionId：非空、≤200、白名单 `[A-Za-z0-9._:-]`、不含 NUL。
 * 刻意**不 trim**：前后带空格说明调用方传错了，悄悄修好只会掩盖 bug。
 * @param {unknown} value - 待校验的会话 id。
 * @returns {{ ok: true, value: string } | { ok: false, error: string }} 结果。
 */
export function checkSessionId(value) {
  if (typeof value !== 'string') return { ok: false, error: 'sessionId must be a string' }
  if (value === '') return { ok: false, error: 'sessionId must not be empty' }
  if (value.includes('\u0000')) return { ok: false, error: 'sessionId must not contain NUL' }
  if (value.length > SESSION_ID_MAX) {
    return { ok: false, error: `sessionId must be at most ${SESSION_ID_MAX} characters` }
  }
  if (!SESSION_ID_PATTERN.test(value)) {
    return { ok: false, error: 'sessionId may only contain letters, digits, ".", "_", ":" and "-"' }
  }
  return { ok: true, value }
}

/**
 * 外层形状判定（只判 `version` 与 `sessions` 的类型），供加载路径区分
 * 「结构非法要告警」与「条目坏值静默丢弃」。@param {unknown} value - 解析后的 JSON。
 * @returns {boolean} 是否是 `{ version:1, sessions:<对象> }`。
 */
function isMapShape(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  if (value.version !== SESSION_PERSONAS_VERSION) return false
  const sessions = value.sessions
  return sessions !== null && typeof sessions === 'object' && !Array.isArray(sessions)
}

/**
 * 把任意读到的 JSON 收敛成 `{ version:1, sessions:{} }`。非对象 / `version` 不是 1 /
 * `sessions` 不是对象 → 空表；条目级只保留「键合法、值是非空字符串」的项，
 * 值经 `personaSlug()` 归一，其余静默丢弃。
 * @param {unknown} value - 解析后的 JSON。
 * @returns {{ version: 1, sessions: Record<string, string> }} 归一后的新对象。
 */
export function normalizeSessionMap(value) {
  if (!isMapShape(value)) return emptyState()
  const sessions = {}
  for (const [sessionId, slug] of Object.entries(value.sessions)) {
    if (!checkSessionId(sessionId).ok) continue
    if (typeof slug !== 'string' || slug.trim() === '') continue
    defineSession(sessions, sessionId, personaSlug(slug))
  }
  return { version: SESSION_PERSONAS_VERSION, sessions }
}

/**
 * 纯函数：返回新 map，把 `sessionId` 绑到 `slug`。不改入参；id 非法时返回归一后的
 * 原内容（不抛），给直接调用纯函数的场景兜底。
 * @param {unknown} map - 现映射。
 * @param {unknown} sessionId - 会话 id。
 * @param {unknown} slug - 人设 slug / 显示名，经 `personaSlug()` 归一。
 * @returns {{ version: 1, sessions: Record<string, string> }} 新映射。
 */
export function setPersonaInMap(map, sessionId, slug) {
  const base = normalizeSessionMap(map)
  const id = checkSessionId(sessionId)
  if (!id.ok) return base
  const sessions = copySessions(base.sessions)
  defineSession(sessions, id.value, personaSlug(slug))
  return { version: SESSION_PERSONAS_VERSION, sessions }
}

/**
 * 纯函数：返回新 map，删掉 `sessions[sessionId]`。不改入参；未绑定时返回内容等价的新对象。
 * @param {unknown} map - 现映射。
 * @param {unknown} sessionId - 会话 id。
 * @returns {{ version: 1, sessions: Record<string, string> }} 新映射。
 */
export function clearPersonaInMap(map, sessionId) {
  const base = normalizeSessionMap(map)
  const id = checkSessionId(sessionId)
  if (!id.ok) return base
  const sessions = {}
  for (const [key, value] of Object.entries(base.sessions)) {
    if (key === id.value) continue
    defineSession(sessions, key, value)
  }
  return { version: SESSION_PERSONAS_VERSION, sessions }
}

/**
 * 纯函数：清掉所有值等于 `slug` 的条目。不改入参。比较前先归一入参 slug
 * （存储里的值本就是归一形态），于是传显示名也能命中。
 * @param {unknown} map - 现映射。
 * @param {unknown} slug - 人设 slug / 显示名。
 * @returns {{ map: { version: 1, sessions: Record<string, string> }, cleared: number }}
 *   `cleared` 是真正删掉的条目数（0 表示无需落盘）。
 */
export function removePersonaFromMap(map, slug) {
  const base = normalizeSessionMap(map)
  if (typeof slug !== 'string' || slug.trim() === '') return { map: base, cleared: 0 }
  const target = personaSlug(slug)
  const sessions = {}
  let cleared = 0
  for (const [key, value] of Object.entries(base.sessions)) {
    if (value === target) {
      cleared += 1
      continue
    }
    defineSession(sessions, key, value)
  }
  return { map: { version: SESSION_PERSONAS_VERSION, sessions }, cleared }
}

/**
 * 纯函数：解析某会话生效的人设。未绑定（或 id 非法）返回 `fallback` + `'global'`。
 * `fallback` 来自全局注册表，可能是 `'Default'` 这类历史变体，故**不做**归一。
 * @param {unknown} map - 现映射。
 * @param {unknown} sessionId - 会话 id。
 * @param {unknown} fallback - 未绑定时使用的全局人设 slug。
 * @returns {{ slug: string, source: 'session' | 'global' }} 解析结果。
 */
export function resolvePersonaForSession(map, sessionId, fallback) {
  const base = normalizeSessionMap(map)
  const id = checkSessionId(sessionId)
  if (id.ok && Object.hasOwn(base.sessions, id.value)) {
    return { slug: base.sessions[id.value], source: 'session' }
  }
  const slug = typeof fallback === 'string' && fallback.trim() !== '' ? fallback : 'default'
  return { slug, source: 'global' }
}

/**
 * 创建会话人设映射实例。
 * @param {{ filePath: string, logger?: { warn?: Function, info?: Function }, now?: () => number }} options
 *   `filePath` 是 session-personas.json 的绝对路径；`now` 是契约签名的一部分，暂不消费。
 * @returns {{
 *   ready: Promise<void>,
 *   get(sessionId: string): string | undefined,
 *   getWithSource(sessionId: string): { slug: string, source: 'session' } | undefined,
 *   snapshot(): { version: 1, sessions: Record<string, string> },
 *   set(sessionId: string, slug: string): Promise<{ ok: true, sessions: object } | { ok: false, code: string, message: string }>,
 *   clear(sessionId: string): Promise<{ ok: true, removed: boolean } | { ok: false, code: string, message: string }>,
 *   removePersona(slug: string): Promise<{ ok: true, cleared: number } | { ok: false, code: string, message: string }>,
 *   dispose(): Promise<void>,
 * }} 实例。
 */
export function createSessionPersonas(options = {}) {
  const filePath = typeof options.filePath === 'string' && options.filePath !== '' ? options.filePath : ''
  const logger = options.logger ?? {}

  /** 内存态；null 表示 ready 尚未完成（此时 `get` 一律 undefined）。 */
  let state = null
  /** filePath → 该路径最后一次写操作的 settled Promise（同路径写串行）。 */
  const writeQueues = new Map()
  /** 临时文件名的进程内自增序号，保证同进程内不撞名。 */
  let tempSequence = 0

  /** 告警（logger 可能缺失或实现不完整）。 */
  function warn(message) {
    try { logger.warn?.('supermemory: %s', message) } catch { /* 日志失败不影响业务 */ }
  }

  /** 原子写：同目录临时文件 + rename；失败返回 `{ ok:false, code:'UNWRITABLE' }`，绝不抛。 */
  async function writeAtomic(target, content) {
    const directory = dirname(target)
    tempSequence += 1
    // 不用 node:crypto 的 randomBytes：契约把依赖面钉死在 fs/promises + path。
    // pid + 时间戳 + 进程内自增序号已足够区分同一目录下的并发写者。
    const temporary = join(directory, `.${basename(target)}.${process.pid}.${Date.now().toString(36)}.${tempSequence}.tmp`)
    try {
      await mkdir(directory, { recursive: true })
      await writeFile(temporary, content, 'utf8')
      await rename(temporary, target)
      return { ok: true }
    } catch (error) {
      try { await unlink(temporary) } catch { /* 临时文件可能尚未创建 */ }
      return { ok: false, code: 'UNWRITABLE', message: describe(error) }
    }
  }

  /** 写 JSON 文件（原子、2 空格缩进、尾部换行）。 */
  async function writeJsonAtomic(target, value) {
    return writeAtomic(target, `${JSON.stringify(value, null, 2)}\n`)
  }

  /** 把写任务排到该路径串行队列的尾部（照 store.js 的 enqueue）。 */
  function enqueue(task) {
    const previous = writeQueues.get(filePath) ?? Promise.resolve()
    const run = previous.then(task, task)
    const settled = run.then(() => undefined, () => undefined)
    writeQueues.set(filePath, settled)
    void settled.then(() => { if (writeQueues.get(filePath) === settled) writeQueues.delete(filePath) })
    return run
  }

  /** 构造期读一次盘；任何异常都收敛成空表（不抛、不重试）。 */
  async function loadFromDisk() {
    if (filePath === '') return emptyState()
    let raw
    try {
      raw = await readFile(filePath, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') warn(`read ${filePath} failed: ${describe(error)}`) // ENOENT = 全新安装，不告警
      return emptyState()
    }
    if (raw.trim() === '') return emptyState()
    const parsed = parseJson(raw)
    if (parsed === undefined) {
      warn(`invalid JSON in ${filePath}, treated as an empty session map`)
      return emptyState()
    }
    if (!isMapShape(parsed)) warn(`invalid session map in ${filePath}, treated as an empty session map`)
    return normalizeSessionMap(parsed)
  }

  /** 构造即异步加载；`ready` 永不 reject（异常已在内部吞掉）。 */
  const ready = (async () => {
    try { state = await loadFromDisk() } catch (error) {
      warn(`load ${filePath} failed: ${describe(error)}`)
      state = emptyState()
    }
  })()

  /**
   * 同步读某会话绑定的人设（铁律 1）；未绑定 / 未就绪 / id 非法 → undefined。
   * @param {string} sessionId - 会话 id。
   * @returns {string | undefined} 绑定的 slug。
   */
  function get(sessionId) {
    if (state === null) return undefined
    const id = checkSessionId(sessionId)
    if (!id.ok || !Object.hasOwn(state.sessions, id.value)) return undefined
    const slug = state.sessions[id.value]
    return typeof slug === 'string' && slug !== '' ? slug : undefined
  }

  /**
   * 同步读绑定，带来源（source 恒为 `'session'`）。无绑定 → undefined。
   * @param {string} sessionId - 会话 id。
   * @returns {{ slug: string, source: 'session' } | undefined} 绑定信息。
   */
  function getWithSource(sessionId) {
    const slug = get(sessionId)
    return slug === undefined ? undefined : { slug, source: 'session' }
  }

  /**
   * 内存态深拷贝（调用方改它影响不到内存态）；未就绪时为空表。
   * @returns {{ version: 1, sessions: Record<string, string> }} 快照。
   */
  function snapshot() {
    return { version: SESSION_PERSONAS_VERSION, sessions: copySessions(state?.sessions) }
  }

  /**
   * 绑定会话人设。先落盘、再更新内存态；失败内存态不变。
   * @param {string} sessionId - 会话 id。
   * @param {string} slug - 人设 slug / 显示名（经 `personaSlug()` 归一）。
   * @returns {Promise<{ ok: true, sessions: object } | { ok: false, code: string, message: string }>}
   */
  async function set(sessionId, slug) {
    const id = checkSessionId(sessionId)
    if (!id.ok) return badInput(id.error)
    if (typeof slug !== 'string' || slug.trim() === '') return badInput('slug must be a non-empty string')
    await ready
    if (filePath === '') return badInput('filePath is required')
    return enqueue(async () => {
      // 必须**在队列任务内部**基于最新内存态计算 next，否则两个并发 set 会各自拿旧快照写盘，
      // 后写的把先写的整条覆盖掉。
      const next = setPersonaInMap(state ?? emptyState(), id.value, slug)
      const written = await writeJsonAtomic(filePath, next)
      if (!written.ok) return { ok: false, code: 'UNWRITABLE', message: written.message }
      state = next
      return { ok: true, sessions: copySessions(next.sessions) }
    }).catch((error) => {
      warn(`write ${filePath} failed: ${describe(error)}`)
      return { ok: false, code: 'UNWRITABLE', message: describe(error) }
    })
  }

  /**
   * 清除会话绑定（幂等：未绑定时也返回 ok，且不白写一次盘）。`removed` 表示是否真删掉一条。
   * @param {string} sessionId - 会话 id。
   * @returns {Promise<{ ok: true, removed: boolean } | { ok: false, code: string, message: string }>}
   */
  async function clear(sessionId) {
    const id = checkSessionId(sessionId)
    if (!id.ok) return badInput(id.error)
    await ready
    if (filePath === '') return badInput('filePath is required')
    return enqueue(async () => {
      const current = state ?? emptyState()
      if (!Object.hasOwn(current.sessions, id.value)) return { ok: true, removed: false }
      const next = clearPersonaInMap(current, id.value)
      const written = await writeJsonAtomic(filePath, next)
      if (!written.ok) return { ok: false, code: 'UNWRITABLE', message: written.message }
      state = next
      return { ok: true, removed: true }
    }).catch((error) => {
      warn(`write ${filePath} failed: ${describe(error)}`)
      return { ok: false, code: 'UNWRITABLE', message: describe(error) }
    })
  }

  /**
   * 清掉所有指向 `slug` 的会话绑定（人设被删后的僵尸清理，契约 §V9.3）。
   * @param {string} slug - 被删人设的 slug / 显示名。
   * @returns {Promise<{ ok: true, cleared: number } | { ok: false, code: string, message: string }>}
   *   `cleared` 是清掉的条目数；0 时不动磁盘。
   */
  async function removePersona(slug) {
    if (typeof slug !== 'string' || slug.trim() === '') return badInput('slug must be a non-empty string')
    await ready
    if (filePath === '') return badInput('filePath is required')
    return enqueue(async () => {
      const { map, cleared } = removePersonaFromMap(state ?? emptyState(), slug)
      if (cleared === 0) return { ok: true, cleared: 0 }
      const written = await writeJsonAtomic(filePath, map)
      if (!written.ok) return { ok: false, code: 'UNWRITABLE', message: written.message }
      state = map
      return { ok: true, cleared }
    }).catch((error) => {
      warn(`write ${filePath} failed: ${describe(error)}`)
      return { ok: false, code: 'UNWRITABLE', message: describe(error) }
    })
  }

  /** 等待在途写完成（宿主卸载时调用），不抛错。 */
  async function dispose() {
    try { await ready } catch { /* ready 永不 reject，这里只是防御 */ }
    try {
      await Promise.allSettled([...writeQueues.values()])
    } finally {
      writeQueues.clear()
    }
  }

  return { ready, get, getWithSource, snapshot, set, clear, removePersona, dispose }
}
