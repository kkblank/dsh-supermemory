/**
 * 记忆存储层：文档读写、原子写、进程内缓存、mtime 冲突检测、写队列、
 * 人设注册表、插件设置、旧 presets 目录迁移、projects.json 与 runs.jsonl。
 * （契约 §4 + §V2.1 / §V2.2）
 *
 * v2 变更：
 *   - 记忆隔离单位从 agent preset 改为「人设（persona）」；
 *     soul/user/global 落到 `<personasRoot>/<slug>/{soul,user,global-memory}.md`。
 *   - 新增 personas.json / settings.json 与 `ready: Promise<void>`：
 *     构造时立即启动迁移，所有异步方法内部先 `await ready`，调用方无需关心迁移。
 *   - ref 支持 `{ kind:'soul'|'user'|'global', persona }`；只有 `presetId` 时当作 persona（过渡兼容）。
 *
 * 不变式：IO 错误一律转成返回值里的 code（绝不抛）；写盘用同目录临时文件 + rename；
 * 同一路径写操作串行；readDoc 每次 stat 比对 mtime，外部编辑器改动可见。
 *
 * @module dsh-supermemory/core/store
 */

import { readFileSync } from 'node:fs'
import { cp, mkdir, readFile, readdir, rename, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { basename, dirname, isAbsolute, join } from 'node:path'

import { appendEntries as appendDocumentEntries, byteLength, emptyDocument } from './document.js'
import { personaSlug, projectDisplayName, resolveProjectRoot, safeJoin } from './paths.js'

const CACHE_LIMIT = 128 // 进程内缓存的路径上限
const RUNS_LIMIT = 200 // runs.jsonl 保留条数（超出裁掉最旧）
const REGISTRY_VERSION = 1 // personas.json / settings.json 的版本号
const MAX_PERSONA_NAME = 60 // createPersona 的名字最大字符数
/** 四个记忆文件的一级标题。 */
const TITLES = Object.freeze({ soul: '人格 (soul)', user: '用户画像 (user)', global: '全局长期记忆', project: '项目记忆' })
/** soul/user/global 三个文件在人设目录下的固定文件名（global 是 global-memory.md）。 */
const DOC_FILES = Object.freeze({ soul: 'soul.md', user: 'user.md', global: 'global-memory.md' })
/** 插件设置的默认值。 */
const DEFAULT_SETTINGS = Object.freeze({ digestProvider: '', digestModel: '' })
/** 插件设置允许的键。 */
const SETTINGS_KEYS = Object.freeze(['digestProvider', 'digestModel'])
/** 项目记忆里允许出现的 kind。 */
const PERSONA_KINDS = Object.freeze(['soul', 'user', 'global'])

/** ref 校验失败（内部使用，不导出）。 */
class StoreRefError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'StoreRefError'
    this.code = code
  }
}

/** 把异常转成可读消息。 */
function describe(error) {
  return error === null || error === undefined ? 'unknown error' : error?.message !== undefined ? String(error.message) : String(error)
}

/** BAD_INPUT 返回值。 */
const badInput = (message) => ({ ok: false, code: 'BAD_INPUT', message })

/** 解析 JSON 文本（失败返回 undefined，不抛）。 */
function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * 创建存储实例。
 *
 * @param {{
 *   dshHome: string,
 *   personasRoot?: string,      // v2 人设目录（绝对路径）
 *   presetsRoot?: string,       // v1 字段名，作为 personasRoot 的废弃别名
 *   legacyPresetsRoot?: string, // 旧 presets 目录（默认 $DSH_HOME/supermemory/presets）
 *   config: object,
 *   logger?: { warn?: Function, info?: Function },
 *   now?: () => number,
 * }} options - 存储选项。
 * @returns {object} Store 实例（含 `ready: Promise<void>`）。
 */
export function createStore(options = {}) {
  const dshHome = typeof options.dshHome === 'string' && options.dshHome !== '' ? options.dshHome : process.cwd()
  const stateDir = join(dshHome, 'supermemory')
  const configuredRoot = pickRoot(options)
  const personasRoot = configuredRoot !== '' ? configuredRoot : join(stateDir, 'personas')
  const legacyRoot = pickLegacyRoot(options, stateDir)
  const settings = options.config !== null && typeof options.config === 'object' ? options.config : {}
  const logger = options.logger ?? {}
  const now = typeof options.now === 'function' ? options.now : Date.now
  const pick = (value, fallback) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback)
  const projectDirName = pick(settings.projectDirName, '.dsh/memory')
  const projectFileName = pick(settings.projectFileName, 'project-memory.md')

  const personasPath = join(stateDir, 'personas.json')
  const settingsPath = join(stateDir, 'settings.json')
  const projectsPath = join(stateDir, 'projects.json')
  const runsPath = join(stateDir, 'runs.jsonl')
  const cache = new Map() // path → { content, mtimeMs, bytes }
  const writeQueues = new Map() // path → 该路径最后一次写操作的 settled Promise

  /** 磁盘上的人设注册表；null 表示尚未加载/文件不存在。 */
  let personasState = null
  /** 磁盘上的插件设置；null 表示尚未加载/文件不存在。 */
  let settingsState = null
  /** 迁移结果缓存（保证 migrateLegacyPresets 幂等且可重复读）。 */
  let migrationResult = null
  /** 迁移 + 注册表加载完成信号；永不 reject。 */
  let ready = null

  /** 告警（logger 可能缺失或实现不完整）。 */
  function warn(message) {
    try { logger.warn?.('supermemory: %s', message) } catch { /* 日志失败不影响业务 */ }
  }

  /** 空模板的文档状态。 */
  function emptyState(title) {
    const content = emptyDocument(title)
    return { content, mtimeMs: 0, bytes: byteLength(content) }
  }

  /** 写入缓存并维持 LRU 上限。 */
  function remember(filePath, record) {
    cache.set(filePath, record)
    if (cache.size <= CACHE_LIMIT) return
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }

  /** 等待某路径上已排队的写操作结束（任务自己吞掉错误）。 */
  async function waitForWrites(filePath) {
    try { await writeQueues.get(filePath) } catch { /* ignore */ }
  }

  /** 把写任务排到该路径的串行队列尾部。 */
  function enqueue(filePath, task) {
    const previous = writeQueues.get(filePath) ?? Promise.resolve()
    const run = previous.then(task, task)
    const settled = run.then(() => undefined, () => undefined)
    writeQueues.set(filePath, settled)
    void settled.then(() => writeQueues.get(filePath) === settled && writeQueues.delete(filePath))
    return run
  }

  /** 读文本文件；缺失或读失败返回 undefined（不抛）。 */
  async function readText(filePath, label = filePath) {
    try { return await readFile(filePath, 'utf8') } catch (error) {
      if (error?.code !== 'ENOENT') warn(`read ${label} failed: ${describe(error)}`)
      return undefined
    }
  }

  /** 读 JSON 文件（损坏或不存在返回 undefined，不抛）。 */
  async function readJsonRaw(filePath) {
    const raw = await readText(filePath)
    if (raw === undefined || raw.trim() === '') return undefined
    const parsed = parseJson(raw)
    if (parsed === undefined) warn(`invalid JSON in ${filePath}`)
    return parsed
  }

  /** 同步读 JSON 文件（构造期用，便于 readSettings/currentPersona 立即可用）。 */
  function readJsonSync(filePath) {
    try { return parseJson(readFileSync(filePath, 'utf8')) } catch { return undefined }
  }

  /** 路径是否存在（不抛）。 */
  async function pathExists(filePath) {
    try { await stat(filePath); return true } catch { return false }
  }

  /** 路径是否是目录（不抛）。 */
  async function isDirectory(filePath) {
    try { return (await stat(filePath)).isDirectory() } catch { return false }
  }

  // —————————————————————————— 文档路径与读写 ——————————————————————————

  /** ref 的隔离键：persona 优先，presetId 作为过渡兼容，缺省 default。 */
  function personaKey(ref) {
    if (typeof ref.persona === 'string' && ref.persona.trim() !== '') return ref.persona
    if (typeof ref.presetId === 'string' && ref.presetId.trim() !== '') return ref.presetId
    return 'default'
  }

  /** 从 ref 计算文件路径与标题（纯计算，不读盘）。 */
  function resolveRef(ref) {
    if (ref === null || typeof ref !== 'object') throw new StoreRefError('ref must be an object', 'BAD_INPUT')
    const kind = ref.kind
    if (PERSONA_KINDS.includes(kind)) {
      try {
        return { path: safeJoin(personasRoot, `${personaSlug(personaKey(ref))}/${DOC_FILES[kind]}`), title: TITLES[kind] }
      } catch (error) {
        throw new StoreRefError(describe(error), 'BAD_INPUT')
      }
    }
    if (kind !== 'project') throw new StoreRefError(`unsupported ref.kind: ${String(kind)}`, 'BAD_INPUT')
    if (typeof ref.projectRoot !== 'string' || !isAbsolute(ref.projectRoot)) {
      throw new StoreRefError('projectRoot must be an absolute path', 'BAD_INPUT')
    }
    const relative = projectDirName === '.' ? projectFileName : `${projectDirName}/${projectFileName}`
    try {
      return { path: safeJoin(ref.projectRoot, relative), title: TITLES.project }
    } catch (error) {
      throw new StoreRefError(describe(error), error?.code === 'PATH_TRAVERSAL' ? 'PATH_TRAVERSAL' : 'BAD_INPUT')
    }
  }

  /** 读盘：不存在返回空模板（不落盘），mtime 未变命中缓存，读失败回退缓存。 */
  async function readInner(filePath, title) {
    let info
    try { info = await stat(filePath) } catch (error) {
      const cached = cache.get(filePath)
      if (error?.code === 'ENOENT') cache.delete(filePath)
      else {
        warn(`stat failed for ${filePath}: ${describe(error)}`)
        if (cached !== undefined) return { ...cached, path: filePath }
      }
      const empty = emptyState(title)
      remember(filePath, empty)
      return { ...empty, path: filePath }
    }
    const cached = cache.get(filePath)
    if (cached !== undefined && cached.mtimeMs === info.mtimeMs) return { ...cached, path: filePath }
    try {
      const content = await readFile(filePath, 'utf8')
      const record = { content, mtimeMs: info.mtimeMs, bytes: byteLength(content) }
      remember(filePath, record)
      return { ...record, path: filePath }
    } catch (error) {
      warn(`read failed for ${filePath}: ${describe(error)}`)
      const fallback = cached ?? emptyState(title)
      remember(filePath, fallback)
      return { ...fallback, path: filePath }
    }
  }

  /** 原子写：同目录临时文件 + rename，随后刷新缓存。 */
  async function writeAtomic(filePath, content) {
    const directory = dirname(filePath)
    const temporary = join(directory, `.${basename(filePath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
    try {
      await mkdir(directory, { recursive: true })
      await writeFile(temporary, content, 'utf8')
      await rename(temporary, filePath)
    } catch (error) {
      try { await unlink(temporary) } catch { /* 临时文件可能未创建 */ }
      return { ok: false, code: 'UNWRITABLE', message: describe(error) }
    }
    try {
      const mtimeMs = (await stat(filePath)).mtimeMs
      const bytes = byteLength(content)
      remember(filePath, { content, mtimeMs, bytes })
      return { ok: true, mtimeMs, bytes }
    } catch (error) {
      cache.delete(filePath)
      return { ok: false, code: 'UNWRITABLE', message: `written but stat failed: ${describe(error)}` }
    }
  }

  /** 写 JSON 文件（原子、格式化、尾部换行）。 */
  async function writeJsonAtomic(filePath, value) {
    return writeAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`)
  }

  /** writeDoc / appendEntries 共用骨架：校验 → 排队 → 重读 → mtime 检查 → 写。 */
  async function writeThrough(ref, writeOptions, validate, build) {
    await ready
    let target
    try { target = resolveRef(ref) } catch (error) { return badInput(describe(error)) }
    const invalid = validate()
    if (invalid !== undefined) return badInput(invalid)
    const expected = writeOptions?.expectedMtimeMs
    if (expected !== undefined && (typeof expected !== 'number' || !Number.isFinite(expected))) {
      return badInput('expectedMtimeMs must be a finite number')
    }
    return enqueue(target.path, async () => {
      const current = await readInner(target.path, target.title)
      if (expected !== undefined && expected !== current.mtimeMs) {
        return { ok: false, code: 'STALE', mtimeMs: current.mtimeMs, bytes: current.bytes }
      }
      const next = await build(current)
      if (next === undefined) return { ok: true, mtimeMs: current.mtimeMs, bytes: current.bytes }
      return writeAtomic(target.path, next)
    }).catch((error) => {
      warn(`write failed for ${target.path}: ${describe(error)}`)
      return { ok: false, code: 'UNWRITABLE', message: describe(error) }
    })
  }

  /** 读文档；不存在返回空模板且不落盘。ref 非法时返回通用空模板（path 为空串）。 */
  async function readDoc(ref) {
    await ready
    let target
    try { target = resolveRef(ref) } catch (error) {
      warn(`readDoc rejected ref: ${describe(error)}`)
      return { ...emptyState('长期记忆'), path: '' }
    }
    await waitForWrites(target.path)
    return readInner(target.path, target.title)
  }

  /** 同步读：只读进程内缓存，绝不抛错；未缓存返回空模板。 */
  function readDocSync(ref) {
    let target
    try { target = resolveRef(ref) } catch { return { ...emptyState('长期记忆'), path: '' } }
    return { ...(cache.get(target.path) ?? emptyState(target.title)), path: target.path }
  }

  /** 写文档（原子、串行、带 mtime 冲突检测）。 */
  function writeDoc(ref, content, writeOptions = {}) {
    return writeThrough(ref, writeOptions, () => (typeof content === 'string' ? undefined : 'content must be a string'), async () => content)
  }

  /** 追加条目（内部先重读拿最新 mtime，再原子写回）。 */
  function appendEntries(ref, entries, appendOptions = {}) {
    const validate = () => (Array.isArray(entries) ? undefined : 'entries must be an array')
    return writeThrough(ref, appendOptions, validate, async (current) => appendDocumentEntries(current.content, entries))
  }

  // —————————————————————————— 人设注册表（v2） ——————————————————————————

  /** 规范化 personas.json 内容；文件结构非法返回 null。 */
  function normalizeRegistry(raw) {
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

  /** 规范化 settings.json 内容。 */
  function normalizeSettings(raw) {
    const source = raw !== null && typeof raw === 'object' ? raw : {}
    const result = { ...DEFAULT_SETTINGS }
    for (const key of SETTINGS_KEYS) {
      if (typeof source[key] === 'string') result[key] = source[key]
    }
    return result
  }

  /** 按 createdAt 升序（空串在前）。 */
  function sortPersonas(personas) {
    return [...personas].sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')))
  }

  /** 读磁盘注册表（不存在或非法返回 null）。 */
  async function loadRegistry() {
    const raw = await readJsonRaw(personasPath)
    return raw === undefined ? null : normalizeRegistry(raw)
  }

  /** 读磁盘设置（缺失/非法一律回退默认值）。 */
  async function loadSettings() {
    const raw = await readJsonRaw(settingsPath)
    return raw === undefined ? { ...DEFAULT_SETTINGS } : normalizeSettings(raw)
  }

  /** 读单个目录的元数据（persona.json 优先，兼容 v1 preset.json）。 */
  async function readPersonaMeta(dir) {
    return (await readJsonRaw(join(dir, 'persona.json'))) ?? (await readJsonRaw(join(dir, 'preset.json')))
  }

  /** 扫描 personasRoot 下的人设目录。 */
  async function scanPersonaDirs() {
    let entries
    try {
      entries = await readdir(personasRoot, { withFileTypes: true })
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') warn(`scan personas failed: ${describe(error)}`)
      return []
    }
    const found = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = join(personasRoot, entry.name)
      const meta = await readPersonaMeta(dir)
      const name = typeof meta?.name === 'string' && meta.name.trim() !== '' ? meta.name.trim() : entry.name
      let createdAt = typeof meta?.createdAt === 'string' ? meta.createdAt : ''
      if (createdAt === '') {
        try { createdAt = new Date((await stat(dir)).mtimeMs).toISOString() } catch { createdAt = '' }
      }
      found.push({ slug: entry.name, name, createdAt })
    }
    return sortPersonas(found)
  }

  /**
   * 校正注册表：合并磁盘目录、补齐 current、必要时写回 personas.json。
   *
   * @param {{ defaultCurrent?: string, forceCreate?: boolean }} [options] - 校正选项。
   * @returns {Promise<object>} 规范化后的注册表。
   */
  async function reconcileRegistry(options = {}) {
    const loaded = await loadRegistry()
    const registry = loaded ?? { version: REGISTRY_VERSION, current: '', personas: [] }
    let changed = false
    const dirs = await scanPersonaDirs()
    for (const dir of dirs) {
      if (registry.personas.some((item) => item.slug === dir.slug)) continue
      registry.personas.push({ slug: dir.slug, name: dir.name, createdAt: dir.createdAt })
      changed = true
    }
    if (registry.current === '') {
      if (registry.personas.length > 0) {
        const preferred = options.defaultCurrent
        const exists = typeof preferred === 'string' && registry.personas.some((item) => item.slug === preferred)
        registry.current = exists ? preferred : sortPersonas(registry.personas)[0].slug
        changed = true
      } else if (options.forceCreate === true) {
        // 迁移触发但没有任何可迁移的人设：仍按契约落一个 current 为 'default' 的注册表。
        registry.current = 'default'
        changed = true
      }
    }
    if (changed || options.forceCreate === true) {
      const written = await writeJsonAtomic(personasPath, registry)
      if (!written.ok) warn(`write personas.json failed: ${written.message}`)
    }
    return registry
  }

  /** 把注册表写入磁盘（调用方负责串行）。 */
  async function persistRegistry(registry) {
    const written = await writeJsonAtomic(personasPath, registry)
    if (!written.ok) warn(`write personas.json failed: ${written.message}`)
    return written.ok
  }

  /** 把目录移动到目标位置（跨设备时退化为复制 + 删除）。 */
  async function moveDir(from, to) {
    try {
      await rename(from, to)
    } catch (error) {
      if (error?.code !== 'EXDEV') throw error
      await cp(from, to, { recursive: true })
      await rm(from, { recursive: true, force: true })
    }
  }

  /**
   * 把旧 `presets/` 目录里的子目录搬到 `personas/` 并登记（幂等，失败只告警）。
   *
   * @returns {Promise<{ migrated: string[], triggered: boolean }>} 迁移结果。
   */
  async function runMigration() {
    if (migrationResult !== null) return migrationResult
    const migrated = []
    let triggered = false
    try {
      if (legacyRoot !== personasRoot && (await isDirectory(legacyRoot))) {
        triggered = true
        let entries = []
        try { entries = await readdir(legacyRoot, { withFileTypes: true }) } catch (error) {
          warn(`read legacy presets failed: ${describe(error)}`)
        }
        const names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
        for (const name of names) {
          const from = join(legacyRoot, name)
          const to = join(personasRoot, name)
          if (await pathExists(to)) continue
          try {
            await mkdir(personasRoot, { recursive: true })
            await moveDir(from, to)
            migrated.push(name)
          } catch (error) {
            warn(`migrate ${from} failed: ${describe(error)}`)
          }
        }
        // 旧目录搬空后删除，避免残留；非空（有杂物）时保留并告警。
        try {
          await rmdir(legacyRoot)
        } catch (error) {
          if (error?.code !== 'ENOENT') warn(`legacy presets dir not removed: ${describe(error)}`)
        }
      }
    } catch (error) {
      warn(`migration failed: ${describe(error)}`)
    }
    migrationResult = { migrated, triggered }
    return migrationResult
  }

  /**
   * 把旧 presets 目录迁移到 personas 目录（幂等）。
   *
   * @returns {Promise<{ migrated: string[] }>} 已迁移的 slug 列表。
   */
  async function migrateLegacyPresets() {
    await ready
    const result = await runMigration()
    return { migrated: [...result.migrated] }
  }

  /** 列出人设（按 createdAt 升序）。 */
  function listPersonas() {
    const items = (personasState?.personas ?? []).map((item) => ({
      slug: item.slug,
      name: item.name,
      createdAt: item.createdAt,
      dir: join(personasRoot, item.slug),
    }))
    return sortPersonas(items)
  }

  /** 当前人设（读 personas.json.current）；没有则 null。 */
  function currentPersona() {
    const slug = typeof personasState?.current === 'string' ? personasState.current : ''
    if (slug === '') return null
    const found = personasState.personas.find((item) => item.slug === slug)
    return found === undefined ? { slug, name: slug } : { slug: found.slug, name: found.name }
  }

  /** 人设目录（纯计算，不读盘）。 */
  function personaDir(slug) {
    return join(personasRoot, personaSlug(slug))
  }

  /** 若注册表里没有该 slug，则新增一条记录（调用方负责落盘）。 */
  function ensureEntry(registry, slug, name) {
    const existing = registry.personas.find((item) => item.slug === slug)
    if (existing !== undefined) {
      if (typeof name === 'string' && name !== '' && existing.name === existing.slug) existing.name = name
      return existing
    }
    const entry = { slug, name: typeof name === 'string' && name !== '' ? name : slug, createdAt: new Date(now()).toISOString() }
    registry.personas.push(entry)
    return entry
  }

  /**
   * 切换当前人设。
   *
   * @param {string} slug - 人设 slug。
   * @returns {Promise<{ ok:true, persona:object } | { ok:false, code:string, message:string }>} 结果。
   */
  async function setCurrentPersona(slug) {
    await ready
    if (typeof slug !== 'string' || slug.trim() === '') return badInput('slug must be a non-empty string')
    const key = personaSlug(slug.trim())
    return enqueue(personasPath, async () => {
      const registry = personasState ?? { version: REGISTRY_VERSION, current: '', personas: [] }
      let entry = registry.personas.find((item) => item.slug === key)
      if (entry === undefined) {
        const dir = join(personasRoot, key)
        const exists = await isDirectory(dir)
        // 允许切到 'default'（默认人设目录可以还不存在），其它未知 slug 报 NOT_FOUND。
        if (!exists && key !== 'default') return { ok: false, code: 'NOT_FOUND', message: `persona not found: ${key}` }
        const meta = exists ? await readPersonaMeta(dir) : undefined
        const fallbackName = typeof meta?.name === 'string' && meta.name.trim() !== '' ? meta.name.trim() : key
        entry = { slug: key, name: fallbackName, createdAt: typeof meta?.createdAt === 'string' ? meta.createdAt : new Date(now()).toISOString() }
        registry.personas.push(entry)
      }
      registry.current = entry.slug
      const written = await persistRegistry(registry)
      if (!written) return { ok: false, code: 'UNWRITABLE', message: 'failed to write personas.json' }
      personasState = registry
      return { ok: true, persona: { slug: entry.slug, name: entry.name, createdAt: entry.createdAt, dir: join(personasRoot, entry.slug) } }
    }).catch((error) => ({ ok: false, code: 'UNWRITABLE', message: describe(error) }))
  }

  /**
   * 新建人设：name 去空白、截 60 字符；slug 冲突追加 -2 / -3。
   *
   * @param {string} name - 人设名。
   * @returns {Promise<{ ok:true, persona:object } | { ok:false, code:string, message:string }>} 结果。
   */
  async function createPersona(name) {
    await ready
    if (typeof name !== 'string' || name.trim() === '') return badInput('name must be a non-empty string')
    const display = [...name.trim()].slice(0, MAX_PERSONA_NAME).join('')
    const base = personaSlug(display)
    return enqueue(personasPath, async () => {
      const registry = personasState ?? { version: REGISTRY_VERSION, current: '', personas: [] }
      let slug = base
      let suffix = 2
      for (;;) {
        const registered = registry.personas.some((item) => item.slug === slug)
        if (!registered && !(await pathExists(join(personasRoot, slug)))) break
        slug = `${base}-${suffix}`
        suffix += 1
      }
      const createdAt = new Date(now()).toISOString()
      try {
        await mkdir(join(personasRoot, slug), { recursive: true })
      } catch (error) {
        return { ok: false, code: 'UNWRITABLE', message: describe(error) }
      }
      const entry = { slug, name: display, createdAt }
      registry.personas.push(entry)
      const written = await persistRegistry(registry)
      if (!written) return { ok: false, code: 'UNWRITABLE', message: 'failed to write personas.json' }
      personasState = registry
      return { ok: true, persona: { slug, name: display, createdAt, dir: join(personasRoot, slug) } }
    }).catch((error) => ({ ok: false, code: 'UNWRITABLE', message: describe(error) }))
  }

  /** 旧 API 兼容：扫描人设目录（v1 名字）。 */
  async function listPresets() {
    await ready
    return listPersonas().map((item) => ({ slug: item.slug, id: item.slug, updatedAt: item.createdAt, dir: item.dir }))
  }

  /** 旧 API 兼容：确保人设目录存在并登记（v1 名字）。 */
  async function ensurePreset(presetId) {
    await ready
    const slug = personaSlug(presetId)
    const id = typeof presetId === 'string' && presetId !== '' ? presetId : slug
    const dir = join(personasRoot, slug)
    try {
      await mkdir(dir, { recursive: true })
    } catch (error) {
      warn(`ensurePreset mkdir failed: ${describe(error)}`)
    }
    await enqueue(personasPath, async () => {
      const registry = personasState ?? { version: REGISTRY_VERSION, current: '', personas: [] }
      ensureEntry(registry, slug, id)
      if (await persistRegistry(registry)) personasState = registry
    }).catch((error) => warn(`ensurePreset failed: ${describe(error)}`))
    return { slug, id, dir }
  }

  // —————————————————————————— 插件设置（v2） ——————————————————————————

  /** 读插件设置（默认 `{ digestProvider:'', digestModel:'' }`）。 */
  function readSettings() {
    return { ...(settingsState ?? DEFAULT_SETTINGS) }
  }

  /**
   * 写插件设置：只接受 digestProvider / digestModel 两个字符串，其它键忽略。
   *
   * @param {object} patch - 增量设置。
   * @returns {Promise<{ ok:true, settings:object } | { ok:false, code:string, message:string }>} 结果。
   */
  async function writeSettings(patch) {
    await ready
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return badInput('settings patch must be an object')
    const next = { ...(settingsState ?? DEFAULT_SETTINGS) }
    for (const key of SETTINGS_KEYS) {
      if (typeof patch[key] === 'string') next[key] = patch[key].trim()
    }
    const file = { version: REGISTRY_VERSION, digestProvider: next.digestProvider, digestModel: next.digestModel }
    const written = await enqueue(settingsPath, async () => writeJsonAtomic(settingsPath, file)).catch((error) => {
      warn(`write settings failed: ${describe(error)}`)
      return { ok: false, code: 'UNWRITABLE', message: describe(error) }
    })
    if (!written.ok) return { ok: false, code: 'UNWRITABLE', message: written.message ?? 'failed to write settings.json' }
    settingsState = next
    return { ok: true, settings: { ...next } }
  }

  // —————————————————————————— 项目 / 整理报告 ——————————————————————————

  /** 规范化 projects.json：过滤坏项、按 root 去重。 */
  function normalizeProjects(raw) {
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

  /** 更新项目记录（去重、刷新 lastSeenAt），绝不抛错。 */
  async function touchProject(root, displayName) {
    await ready
    if (typeof root !== 'string' || !isAbsolute(root)) return
    const name = typeof displayName === 'string' && displayName !== '' ? displayName : projectDisplayName(root)
    await enqueue(projectsPath, async () => {
      const projects = normalizeProjects(await readJsonRaw(projectsPath))
      const at = new Date(now()).toISOString()
      const existing = projects.find((item) => item.root === root)
      if (existing !== undefined) Object.assign(existing, { name, lastSeenAt: at })
      else projects.push({ path: root, root, name, lastSeenAt: at })
      const result = await writeAtomic(projectsPath, `${JSON.stringify({ version: 1, projects }, null, 2)}\n`)
      if (!result.ok) warn(`touchProject failed: ${result.message}`)
    }).catch((error) => warn(`touchProject failed: ${describe(error)}`))
  }

  /** 列出已记录的项目（最近使用在前）。 */
  async function listProjects() {
    await ready
    await waitForWrites(projectsPath)
    const projects = normalizeProjects(await readJsonRaw(projectsPath))
    return projects.sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)))
  }

  /** 记录一个项目路径（向上解析 .git）。 */
  async function addProjectPath(inputPath) {
    await ready
    if (typeof inputPath !== 'string' || !isAbsolute(inputPath)) return { ok: false, error: 'path must be an absolute string' }
    try {
      const { root } = await resolveProjectRoot(inputPath)
      const name = projectDisplayName(root)
      await touchProject(root, name)
      return { ok: true, root, name }
    } catch (error) {
      warn(`addProjectPath failed: ${describe(error)}`)
      return { ok: false, error: describe(error) }
    }
  }

  /** 解析 JSONL 中的对象记录；坏行告警后跳过。 */
  function parseRunLines(raw) {
    if (raw === undefined) return []
    const records = []
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      const parsed = parseJson(trimmed)
      if (parsed !== null && parsed !== undefined && typeof parsed === 'object') records.push(parsed)
      else warn('skipped corrupt runs.jsonl line')
    }
    return records
  }

  /** 读最近 limit 条整理报告（坏行跳过并告警）。 */
  async function readRuns(limit = 20) {
    await ready
    let count = typeof limit === 'number' && Number.isFinite(limit) ? Math.trunc(limit) : 20
    if (count <= 0) return []
    if (count > RUNS_LIMIT) count = RUNS_LIMIT
    await waitForWrites(runsPath)
    return parseRunLines(await readText(runsPath, 'runs.jsonl')).slice(-count)
  }

  /** 追加一条整理报告，超过 200 条裁剪旧记录。 */
  async function appendRun(record) {
    await ready
    await enqueue(runsPath, async () => {
      const previous = parseRunLines(await readText(runsPath, 'runs.jsonl'))
      const at = typeof record?.at === 'string' && record.at !== '' ? record.at : new Date(now()).toISOString()
      previous.push({ ...(record !== null && typeof record === 'object' ? record : {}), at })
      const kept = previous.length > RUNS_LIMIT ? previous.slice(-RUNS_LIMIT) : previous
      const result = await writeAtomic(runsPath, `${kept.map((item) => JSON.stringify(item)).join('\n')}\n`)
      if (!result.ok) warn(`appendRun failed: ${result.message}`)
    }).catch((error) => warn(`appendRun failed: ${describe(error)}`))
  }

  // —————————————————————————— 辅助 ——————————————————————————

  /** 纯计算文档路径（ref 非法时抛 StoreRefError）。 */
  function docPath(ref) {
    return resolveRef(ref).path
  }

  /** 查询文件状态（不抛错）。 */
  async function stats(ref) {
    await ready
    try {
      const info = await stat(resolveRef(ref).path)
      return { exists: true, bytes: info.size, mtimeMs: info.mtimeMs }
    } catch { return { exists: false, bytes: 0, mtimeMs: 0 } }
  }

  /** 等待在途写完成并清空缓存。 */
  async function dispose() {
    try { await ready } catch { /* ready 永不 reject，这里只是防御 */ }
    try { await Promise.allSettled([...writeQueues.values()]) } finally { cache.clear(); writeQueues.clear() }
  }

  // —————————————————————————— 构造期：同步读状态 + 启动迁移 ——————————————————————————

  // 同步加载已有注册表/设置，让 currentPersona()/readSettings() 在 ready 之前也有正确值。
  personasState = normalizeRegistry(readJsonSync(personasPath))
  const initialSettings = readJsonSync(settingsPath)
  settingsState = initialSettings !== undefined ? normalizeSettings(initialSettings) : null

  // 构造时立即启动迁移；所有异步方法内部 await ready，调用方无需关心。
  ready = (async () => {
    let migration = { migrated: [], triggered: false }
    try {
      migration = await runMigration()
    } catch (error) {
      warn(`migration failed: ${describe(error)}`)
    }
    try {
      personasState = await reconcileRegistry({
        defaultCurrent: migration.migrated.length > 0 ? migration.migrated[0] : '',
        forceCreate: migration.triggered === true,
      })
    } catch (error) {
      warn(`load personas failed: ${describe(error)}`)
    }
    try {
      settingsState = await loadSettings()
    } catch (error) {
      warn(`load settings failed: ${describe(error)}`)
    }
  })().catch((error) => warn(`store ready failed: ${describe(error)}`))

  return {
    ready,
    // 文档
    readDoc, readDocSync, writeDoc, appendEntries,
    // 人设（v2）
    listPersonas, currentPersona, setCurrentPersona, createPersona, personaDir, migrateLegacyPresets,
    // 设置（v2）
    readSettings, writeSettings,
    // 旧 API（v1 兼容）
    listPresets, ensurePreset,
    // 项目 / 报告 / 辅助
    touchProject, listProjects, addProjectPath, readRuns, appendRun, docPath, stats, dispose,
  }
}

/** 从 options 里取人设根目录（personasRoot 优先，presetsRoot 为废弃别名）。 */
function pickRoot(options) {
  for (const key of ['personasRoot', 'presetsRoot']) {
    const value = options?.[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return ''
}

/** 从 options 里取旧 presets 目录（默认 `$DSH_HOME/supermemory/presets`）。 */
function pickLegacyRoot(options, stateDir) {
  const explicit = options?.legacyPresetsRoot
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim()
  return join(stateDir, 'presets')
}
