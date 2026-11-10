/**
 * 记忆存储层：文档读写、原子写、进程内缓存、mtime 冲突检测、写队列、
 * projects.json 与 runs.jsonl。（契约 §4）
 *
 * 不变式：IO 错误一律转成返回值里的 code（绝不抛）；写盘用同目录临时文件 + rename；
 * 同一路径写操作串行；readDoc 每次 stat 比对 mtime，外部编辑器改动可见。
 *
 * @module dsh-supermemory/core/store
 */

import { randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'

import { appendEntries as appendDocumentEntries, byteLength, emptyDocument } from './document.js'
import { presetSlug, projectDisplayName, resolveProjectRoot, safeJoin } from './paths.js'

const CACHE_LIMIT = 128 // 进程内缓存的路径上限
const RUNS_LIMIT = 200 // runs.jsonl 保留条数（超出裁掉最旧）
/** 四个记忆文件的一级标题。 */
const TITLES = Object.freeze({ soul: '人格 (soul)', user: '用户画像 (user)', global: '全局长期记忆', project: '项目记忆' })

/** ref 校验失败（内部使用，不导出）。 */
class StoreRefError extends Error {
  constructor(message, code) { super(message); this.name = 'StoreRefError'; this.code = code }
}

/** 把异常转成可读消息。 */
function describe(error) {
  return error === null || error === undefined ? 'unknown error' : error?.message !== undefined ? String(error.message) : String(error)
}

/** BAD_INPUT 返回值。 */
const badInput = (message) => ({ ok: false, code: 'BAD_INPUT', message })

/**
 * 创建存储实例。
 * @param {{ dshHome: string, presetsRoot: string, config: object,
 *   logger?: { warn?: Function, info?: Function }, now?: () => number }} options - 存储选项。
 * @returns {object} Store 实例。
 */
export function createStore(options = {}) {
  const dshHome = typeof options.dshHome === 'string' && options.dshHome !== '' ? options.dshHome : process.cwd()
  const presetsRoot =
    typeof options.presetsRoot === 'string' && options.presetsRoot !== '' ? options.presetsRoot : join(dshHome, 'supermemory', 'presets')
  const settings = options.config !== null && typeof options.config === 'object' ? options.config : {}
  const logger = options.logger ?? {}
  const now = typeof options.now === 'function' ? options.now : Date.now
  const pick = (value, fallback) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback)
  const projectDirName = pick(settings.projectDirName, '.dsh/memory')
  const projectFileName = pick(settings.projectFileName, 'project-memory.md')

  const stateDir = join(dshHome, 'supermemory')
  const projectsPath = join(stateDir, 'projects.json')
  const runsPath = join(stateDir, 'runs.jsonl')
  const cache = new Map() // path → { content, mtimeMs, bytes }
  const writeQueues = new Map() // path → 该路径最后一次写操作的 settled Promise

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

  /** 从 ref 计算文件路径与标题（纯计算，不读盘）。 */
  function resolveRef(ref) {
    if (ref === null || typeof ref !== 'object') throw new StoreRefError('ref must be an object', 'BAD_INPUT')
    const kind = ref.kind
    if (kind === 'soul' || kind === 'user' || kind === 'global') {
      try {
        return { path: safeJoin(presetsRoot, `${presetSlug(ref.presetId)}/${kind}.md`), title: TITLES[kind] }
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

  /** writeDoc / appendEntries 共用骨架：校验 → 排队 → 重读 → mtime 检查 → 写。 */
  function writeThrough(ref, writeOptions, validate, build) {
    let target
    try { target = resolveRef(ref) } catch (error) { return Promise.resolve(badInput(describe(error))) }
    const invalid = validate()
    if (invalid !== undefined) return Promise.resolve(badInput(invalid))
    const expected = writeOptions?.expectedMtimeMs
    if (expected !== undefined && (typeof expected !== 'number' || !Number.isFinite(expected))) {
      return Promise.resolve(badInput('expectedMtimeMs must be a finite number'))
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
    try { return JSON.parse(raw) } catch (error) {
      warn(`invalid JSON in ${filePath}: ${describe(error)}`)
      return undefined
    }
  }

  /** 解析 JSONL 中的对象记录；坏行告警后跳过。 */
  function parseRunLines(raw) {
    if (raw === undefined) return []
    const records = []
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      try {
        const parsed = JSON.parse(trimmed)
        if (parsed !== null && typeof parsed === 'object') records.push(parsed)
      } catch {
        warn('skipped corrupt runs.jsonl line')
      }
    }
    return records
  }

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
    await waitForWrites(projectsPath)
    const projects = normalizeProjects(await readJsonRaw(projectsPath))
    return projects.sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)))
  }

  /** 记录一个项目路径（向上解析 .git）。 */
  async function addProjectPath(inputPath) {
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

  /** 扫描 presetsRoot 下的预设目录。 */
  async function listPresets() {
    let names
    try {
      names = await readdir(presetsRoot, { withFileTypes: true })
    } catch (error) {
      if (error?.code !== 'ENOENT') warn(`listPresets failed: ${describe(error)}`)
      return []
    }
    const presets = []
    for (const entry of names) {
      if (!entry.isDirectory()) continue
      const dir = join(presetsRoot, entry.name)
      const meta = await readJsonRaw(join(dir, 'preset.json'))
      const id = typeof meta?.id === 'string' && meta.id !== '' ? meta.id : entry.name
      let updatedAt = typeof meta?.updatedAt === 'string' ? meta.updatedAt : ''
      if (updatedAt === '') {
        try { updatedAt = new Date((await stat(dir)).mtimeMs).toISOString() } catch { updatedAt = '' }
      }
      presets.push({ slug: entry.name, id, updatedAt, dir })
    }
    return presets.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  /** 确保预设目录与 preset.json 存在（幂等）。 */
  async function ensurePreset(presetId) {
    const slug = presetSlug(presetId)
    const id = typeof presetId === 'string' && presetId !== '' ? presetId : slug
    const dir = join(presetsRoot, slug)
    try {
      await mkdir(dir, { recursive: true })
      const metaPath = join(dir, 'preset.json')
      if ((await readJsonRaw(metaPath)) === undefined) {
        const at = new Date(now()).toISOString()
        const meta = { version: 1, id, slug, createdAt: at, updatedAt: at }
        const result = await writeAtomic(metaPath, `${JSON.stringify(meta, null, 2)}\n`)
        if (!result.ok) warn(`ensurePreset failed: ${result.message}`)
      }
    } catch (error) { warn(`ensurePreset failed: ${describe(error)}`) }
    return { slug, id, dir }
  }

  /** 读最近 limit 条整理报告（坏行跳过并告警）。 */
  async function readRuns(limit = 20) {
    let count = typeof limit === 'number' && Number.isFinite(limit) ? Math.trunc(limit) : 20
    if (count <= 0) return []
    if (count > RUNS_LIMIT) count = RUNS_LIMIT
    await waitForWrites(runsPath)
    return parseRunLines(await readText(runsPath, 'runs.jsonl')).slice(-count)
  }

  /** 追加一条整理报告，超过 200 条裁剪旧记录。 */
  async function appendRun(record) {
    await enqueue(runsPath, async () => {
      const previous = parseRunLines(await readText(runsPath, 'runs.jsonl'))
      const at = typeof record?.at === 'string' && record.at !== '' ? record.at : new Date(now()).toISOString()
      previous.push({ ...(record !== null && typeof record === 'object' ? record : {}), at })
      const kept = previous.length > RUNS_LIMIT ? previous.slice(-RUNS_LIMIT) : previous
      const result = await writeAtomic(runsPath, `${kept.map((item) => JSON.stringify(item)).join('\n')}\n`)
      if (!result.ok) warn(`appendRun failed: ${result.message}`)
    }).catch((error) => warn(`appendRun failed: ${describe(error)}`))
  }

  /** 纯计算文档路径（ref 非法时抛 StoreRefError）。 */
  function docPath(ref) { return resolveRef(ref).path }

  /** 查询文件状态（不抛错）。 */
  async function stats(ref) {
    try {
      const info = await stat(resolveRef(ref).path)
      return { exists: true, bytes: info.size, mtimeMs: info.mtimeMs }
    } catch { return { exists: false, bytes: 0, mtimeMs: 0 } }
  }

  /** 等待在途写完成并清空缓存。 */
  async function dispose() {
    try { await Promise.allSettled([...writeQueues.values()]) } finally { cache.clear(); writeQueues.clear() }
  }

  return {
    readDoc, readDocSync, writeDoc, appendEntries,
    touchProject, listProjects, addProjectPath,
    listPresets, ensurePreset, readRuns, appendRun,
    docPath, stats, dispose,
  }
}
