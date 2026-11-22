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
 * v5 变更：人设注册表新增 `renamePersona`（只改显示名，slug 与目录不动）与
 * `deletePersona`（摘条目 + 迁移 current + `rm -rf` 目录 + 清进程内缓存），契约 §V5.2。
 *
 * v8 变更：新增 `listProjectDocs({ projectRoot })`（契约 V8.6）——冷层检索要把项目记忆
 * 目录下的**全部** md 纳入（`pitfalls.md` 今天查不到），清单只列本目录的 `*.md` 普通文件，
 * `history/` 快照整个排除。
 *
 * v13 变更（契约 §V13）：人设注册表新增两个可选字段 `supervisor`（全表最多一个）与
 * `expertise`（单行、≤500 码点），配套 API：
 *   - `supervisorSync()` —— **同步**返回主管（系统提示的 section 回调不能 await）；
 *   - `setSupervisor(slug)` / `setExpertise(slug, text)` —— 原子写 personas.json；
 *   - `deletePersona` 删掉主管时按 `pickSuccessorCurrent` 的同一套优先级补选新主管。
 * 字段的归一 / 清洗在 `store-normalize.js`（纯函数），「多个主管」的告警留在本文件。
 *
 * 不变式：IO 错误一律转成返回值里的 code（绝不抛）；写盘用同目录临时文件 + rename；
 * 同一路径写操作串行；readDoc 每次 stat 比对 mtime，外部编辑器改动可见。
 *
 * 与 `store-normalize.js` 的分工：不依赖闭包状态的纯函数与常量（describe / parseJson /
 * pickRoot / personaKey / normalizeRegistry / normalizeSettings / normalizeProjects /
 * normalizeExpertise / droppedSupervisors / sortPersonas / StoreRefError / REGISTRY_VERSION /
 * DEFAULT_SETTINGS / SETTINGS_KEYS / MAX_EXPERTISE /
 * snapshotFileName / pruneSnapshotNames / SNAPSHOT_DIR）已原样搬到那里。本文件留下的
 * 每一个函数都要读写盘或读写 cache / writeQueues /
 * personasState / settingsState / logger / now，属于 createStore 状态机的一部分，
 * 不外拆——强行拆开要把这些状态当参数传来传去，得不偿失（详见 store-normalize.js 模块头）。
 *
 * @module dsh-supermemory/core/store
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { cp, mkdir, open, readFile, readdir, rename, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { basename, dirname, isAbsolute, join } from 'node:path'

import { appendEntries as appendDocumentEntries, byteLength, emptyDocument } from './document.js'
import { personaSlug, projectDisplayName, resolveProjectRoot, safeJoin } from './paths.js'
import {
  DEFAULT_SETTINGS, REGISTRY_VERSION, SETTINGS_KEYS, SNAPSHOT_DIR, StoreRefError, badInput, describe,
  droppedSupervisors, normalizeExpertise, normalizeProjects, normalizeRegistry, normalizeSettings,
  parseJson, personaKey, pickLegacyRoot, pickRoot, pruneSnapshotNames, snapshotFileName, snapshotStamp, sortPersonas,
} from './store-normalize.js'

const CACHE_LIMIT = 128 // 进程内缓存的路径上限
const RUNS_LIMIT = 200 // runs.jsonl 保留条数（超出裁掉最旧）
const MAX_PERSONA_NAME = 60 // createPersona 的名字最大字符数
/**
 * 默认人设两步改名的临时目录前缀（§V6.1）。
 *
 * `scanPersonaDirs()` 只豁免这一个前缀，**豁免范围永远不许扩大成「跳过所有点号开头的目录」**：
 * `personaSlug('../../etc')` 产出的是 `..-..-etc`，它合法、以点开头，真实环境里就有这样的人设，
 * 一并跳过会让它在面板上凭空消失。
 */
const MIGRATING_PREFIX = '.default-migrating-'
/** 四个记忆文件的一级标题。 */
const TITLES = Object.freeze({ soul: '人格 (soul)', user: '用户画像 (user)', global: '全局长期记忆', project: '项目记忆' })
/** soul/user/global 三个文件在人设目录下的固定文件名（global 是 global-memory.md）。 */
const DOC_FILES = Object.freeze({ soul: 'soul.md', user: 'user.md', global: 'global-memory.md' })
/** 项目记忆里允许出现的 kind。 */
const PERSONA_KINDS = Object.freeze(['soul', 'user', 'global'])

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
  /**
   * **仅供测试的注入点，不是业务参数**——宿主永远不要传，看到它出现在配置文件里就是写错了。
   *
   * 归一化改名后要做一次磁盘复查（见 foldDefaultPersonaDir）。真实实现读 `readdir` 的结果，
   * 而 Linux CI 造不出「rename 声称成功、目录名却仍是大写」这种大小写不敏感卷上的形态，
   * 于是把复查所依据的目录名列表交给这里覆写，测试得以演练那条兜底分支。
   * 签名：`(names: string[]) => boolean | Promise<boolean>`，返回假值即视为「没改到位」。
   *
   * **只有 `test/store.test.js` 的归一化复查那两条可以传它。** 装配层测试（`test/index-init.test.js`
   * 与一切走 `apply` / `ensureDefaultPersona` 的用例）**刻意不传**：那里守的是真实装配下默认人设
   * 到底建没建对，从这儿注入假象测的就不是生产行为。两侧不许互相借道——想让装配层用例好过而
   * 翻这个选项，等于把被测对象换成自己捏的。
   */
  const foldProbe = typeof options.foldProbe === 'function' ? options.foldProbe : null
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
  /** 「多个主管」这条告警是否已发过（一个 store 实例只发一次，构造期与 ready 各读一次盘）。 */
  let supervisorWarned = false
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

  /** 提示（logger 可能缺失或实现不完整）；用于「改动过磁盘布局、事后值得回看」的正常事件。 */
  function info(message) {
    try { logger.info?.('supermemory: %s', message) } catch { /* 日志失败不影响业务 */ }
  }

  /**
   * 若 `normalizeRegistry` 报告了「多个主管」，告警一次（契约 §V13）。
   *
   * 为什么在这里而不是 normalize 里：`store-normalize.js` 是纯函数模块，不许 warn（契约 §0.2）。
   * 为什么只告警一次：构造期同步读一次盘、`ready` 里 `reconcileRegistry` 又读一次，
   * 同一份文件会命中两回，重复告警只是噪音。**降级本身照旧执行**（只认第一个），
   * 告警只是让主人知道手编的 personas.json 里有冲突需要收拾。
   *
   * @param {object} registry - 刚由 normalizeRegistry 得到的注册表。
   */
  function warnDroppedSupervisors(registry) {
    const dropped = droppedSupervisors(registry)
    if (dropped === 0 || supervisorWarned) return
    supervisorWarned = true
    warn(`multiple supervisors in personas.json, only the first is kept, ${dropped} ignored`)
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

  /**
   * 丢掉缓存里属于某个目录的所有条目（契约 §V5.2「删除人设」第 5 步）。
   *
   * `readInner` 只在 `stat` 抛 `ENOENT` 时丢缓存，而 `readDocSync` 干脆不 stat——
   * 删完人设不清缓存，注入与面板都会读到已删内容的残影。
   *
   * @param {string} dir - 人设目录绝对路径。
   */
  function forgetCachedUnder(dir) {
    const prefix = `${dir}/`
    for (const key of [...cache.keys()]) {
      if (key.startsWith(prefix)) cache.delete(key)
    }
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

  /**
   * 「同一路径的损坏只告警一次」的登记表。
   *
   * 同步与异步两条读盘路径共用它：构造期 `loadRegistrySync` 读一次、`ready` 里的
   * `loadRegistry` 又读一次，同一份损坏文件会命中两回——重复告警只是噪音。
   */
  const brokenJsonWarned = new Set()

  /**
   * 对「文件在、内容不是合法 JSON」告警一次（同一路径只报一条）。
   *
   * @param {string} filePath - 出问题的文件路径。
   */
  function warnBrokenJsonOnce(filePath) {
    if (brokenJsonWarned.has(filePath)) return
    brokenJsonWarned.add(filePath)
    warn(`invalid JSON in ${filePath}`)
  }

  /** 读 JSON 文件（损坏或不存在返回 undefined，不抛）。 */
  async function readJsonRaw(filePath) {
    const raw = await readText(filePath)
    if (raw === undefined || raw.trim() === '') return undefined
    const parsed = parseJson(raw)
    if (parsed === undefined) warnBrokenJsonOnce(filePath)
    return parsed
  }

  /**
   * 同步读文本并解析 JSON，把「文件读不到」与「内容损坏」区分开。
   *
   * 为什么需要区分：读不到（ENOENT）是**正常态**（首次安装、设置还没写过），必须静默；
   * 而「文件在、内容不是合法 JSON」是**事故**——历史实现把两者都 `catch { return undefined }`，
   * 于是 `personas.json` 被手编坏之后：构造期安静地当空表，用户看到「人设全没了」，
   * 日志里零线索；接着任何一次写人设操作都会用「空表 + 新条目」把原文件覆盖掉，
   * 自定义的人设名永久丢失。这里必须让损坏这一种情况吭声（与异步版 `readJsonRaw` 对齐）。
   *
   * @param {string} filePath - 文件绝对路径。
   * @returns {{ value: any, text: string|undefined, broken: boolean }}
   *   `value` 解析结果（失败为 undefined）；`text` 原始文本（读不到为 undefined）；
   *   `broken` 表示「文件存在且非空，但解析失败」，调用方据此决定是否备份。
   */
  function readJsonSyncDetailed(filePath) {
    let text
    try {
      text = readFileSync(filePath, 'utf8')
    } catch {
      // 读不到（ENOENT / 权限等）：保持静默，与既有行为一致。
      return { value: undefined, text: undefined, broken: false }
    }
    if (text.trim() === '') return { value: undefined, text, broken: false }
    const value = parseJson(text)
    const broken = value === undefined
    if (broken) warnBrokenJsonOnce(filePath)
    return { value, text, broken }
  }

  /** 同步读 JSON 文件（构造期用，便于 readSettings/currentPersona 立即可用）。 */
  function readJsonSync(filePath) {
    return readJsonSyncDetailed(filePath).value
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
      // rename 前对临时文件 fsync：保证「rename 可见时内容也已经在盘上」，
      // 掉电窗口里不会出现目录项指向空文件或半截内容的形态。
      try {
        const fh = await open(temporary, 'r')
        try { await fh.sync() } finally { await fh.close() }
      } catch (error) {
        warn(`fsync temp file failed for ${filePath}: ${describe(error)}`)
      }
      await rename(temporary, filePath)
      // rename 后对目录 fsync 尽力而为：让目录项本身也落盘。个别平台 / 文件系统
      // 不支持目录 fsync（EACCES / EINVAL 等），失败只告警，不影响写入结果。
      try {
        const dirHandle = await open(directory, 'r')
        try { await dirHandle.sync() } finally { await dirHandle.close() }
      } catch (error) {
        warn(`fsync directory failed for ${directory}: ${describe(error)}`)
      }
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

  /** 列目录里的文件名；读不到返回空数组（不抛，只告警）。 */
  async function listFileNames(dir) {
    try {
      return await readdir(dir)
    } catch (error) {
      warn(`list ${dir} failed: ${describe(error)}`)
      return []
    }
  }

  /**
   * 整编落盘前给「将被替换掉的原文」留一份快照（契约 §V4.0.5）。
   *
   * 位置 `<文档所在目录>/history/<原文件名去扩展>-<yyyyMMdd'T'HHmmss'Z'>-<4hex>.md`，
   * 内容逐字节等于入参（不做换行归一、不 trim——快照的价值就在于能原样还原）；
   * 写完按文件名时间序保留最近 `keep` 份，多余的删掉。
   *
   * 排在 `docPath(ref)` 那把写锁上，与 writeDoc / appendEntries 同一条队列：
   * 整编流程「先快照再 writeDoc」时两者天然前后相邻，不会被并发的 append 插到中间。
   * 只提供留底，**不提供回滚 API**——恢复方式是人工从 history/ 拷回。
   *
   * @param {object} ref - 文档 ref。
   * @param {string} content - 本次整编要替换掉的原文。
   * @param {number} [keep=3] - 保留份数（非法回退 3，小于 1 钳到 1）。
   * @returns {Promise<{ok:true, path: string, removed: string[]}|{ok:false, error: string}>}
   *   `removed` 是本次真正删掉的快照绝对路径（删失败的不在其中）。
   */
  async function writeDocSnapshot(ref, content, keep = 3) {
    await ready
    let target
    try { target = resolveRef(ref) } catch (error) { return { ok: false, error: describe(error) } }
    if (typeof content !== 'string') return { ok: false, error: 'content must be a string' }
    const stampAt = now()
    const name = snapshotFileName(basename(target.path), stampAt, randomBytes(2).toString('hex'))
    if (name === '') return { ok: false, error: `invalid clock for snapshot: ${String(stampAt)}` }
    return enqueue(target.path, async () => {
      const directory = join(dirname(target.path), SNAPSHOT_DIR)
      const filePath = join(directory, name)
      const written = await writeAtomic(filePath, content)
      if (!written.ok) return { ok: false, error: written.message ?? 'failed to write snapshot' }
      cache.delete(filePath) // 快照不是文档，不占文档缓存的位置
      const { removed } = pruneSnapshotNames(await listFileNames(directory), keep)
      const deleted = []
      for (const doomed of removed) {
        const doomedPath = join(directory, doomed)
        try {
          await unlink(doomedPath)
          deleted.push(doomedPath)
        } catch (error) {
          warn(`prune snapshot failed for ${doomedPath}: ${describe(error)}`)
        }
      }
      return { ok: true, path: filePath, removed: deleted }
    }).catch((error) => {
      warn(`snapshot failed for ${target.path}: ${describe(error)}`)
      return { ok: false, error: describe(error) }
    })
  }

  // —————————————————————————— 人设注册表（v2） ——————————————————————————

  /**
   * 是否「默认人设」的 slug —— 本文件共用的口径，**必须大小写不敏感**。
   *
   * 为什么不能逐字比小写 `'default'`：`personaSlug()` 原样保留 Unicode 字母的大小写，
   * 历史环境的目录与条目就是大写 D 的 `'Default'`（v6 之前 `lib/index.js` 用
   * `createPersona('Default')` 建它）。归一化（§V6.1）发生在 ready，而**归一之前存量数据
   * 是真实存在的大写 `Default`**；判断退回逐字比小写，等于在归一完成前、以及任何归一被
   * 跳过或失败的环境里，默认人设重新变成可删除——正是 v5 那次真实误删的成因（契约 §V6.0）。
   * 判断比目录宽松没有代价：归一后目录只有小写一个，判断覆盖所有大小写写法。
   *
   * @param {string} slug - 人设 slug。
   * @returns {boolean} 是否默认人设（受保护、不可删除）。
   */
  function isDefaultSlug(slug) {
    return typeof slug === 'string' && slug.toLowerCase() === 'default'
  }

  /**
   * slug 是否含路径风险字符（路径分隔符 / NUL / `.` `..` 段）。
   *
   * 为什么在 store.js 而不是 store-normalize.js：normalizeRegistry 是纯函数模块，
   * 本文件要为「丢弃畸形条目」发一条 warn（有状态的日志），按分工这类函数留在
   * createStore 闭包里（模块头的分工纪律：需要 warn 的就不属于 normalize）。
   *
   * @param {string} slug - 待检的 slug（已 trim）。
   * @returns {boolean} 是否不安全。
   */
  function unsafeSlug(slug) {
    return slug === '.' || slug === '..' || slug.includes('/') || slug.includes('\\') || slug.includes('\u0000')
  }

  /**
   * `personas.json` 已备份过的指纹（「原始损坏文本」的 sha1）。
   *
   * 为什么按**内容指纹**而不是「目录里有没有 `.corrupt-*`」：构造期与 `ready` 各读一次
   * 磁盘，按「文件是否存在」判会漏掉「上次备份的是另一份损坏内容」的情形；而按指纹判
   * 既能保证同一份损坏内容只备份一次（不刷副本），又能在文件被**改成另一份**损坏内容时
   * 再备份一次——那确实是另一次事故，值得留证。
   *
   * 跨进程不去重（不落盘这个集合）：多开一个宿主进程多留一份备份，代价是一份几 KB 的
   * 文本，远小于「备份丢了」的代价。
   *
   * @type {Set<string>}
   */
  const backedUpRegistryFingerprints = new Set()

  /**
   * 把损坏的注册表原文件另存一份再做后续处理（契约 §V5 的「先备份再继续可用」策略）。
   *
   * 命名 `<原文件名>.corrupt-<UTC 时间戳>-<4 位 hex>`，时间戳与 `history/` 快照同口径
   * （`store-normalize.js` 的 `snapshotStamp`：`20261110T072233Z`），一眼能对上时间。
   *
   * **必须带随机后缀**：时间戳只到秒，而「同一秒里注册表被改坏两次」在自动化场景下真的
   * 会发生（实测过：`{ BAD ONE` 立刻换成 `{ BAD TWO`，同一个秒级戳会撞名，`writeFileSync`
   * 静默覆盖前一份，第一份证据就没了）。后缀取 4 位 hex，与 `snapshotFileName` 同口径。
   *
   * **失败只 warn、绝不阻断**：备份是保命措施，不能因为备份失败就让插件起不来——
   * 那会把「注册表损坏」升级成「整个记忆功能不可用」。
   *
   * @param {string} text - 原始（损坏的）文本内容。
   * @returns {string} 备份文件路径；跳过或失败时返回空串。
   */
  function backupBrokenRegistry(text) {
    if (typeof text !== 'string' || text.trim() === '') return ''
    const fingerprint = createHash('sha1').update(text, 'utf8').digest('hex')
    if (backedUpRegistryFingerprints.has(fingerprint)) return ''
    const stamp = snapshotStamp(now())
    if (stamp === '') {
      warn('cannot back up corrupted personas.json: invalid clock')
      return ''
    }
    // 加随机后缀：`writeFileSync` 默认覆盖，同秒内两份不同损坏内容会互相顶掉。
    const target = `${personasPath}.corrupt-${stamp}-${randomBytes(2).toString('hex')}`
    try {
      // 同步写：本函数在构造期调用，调用方没有 await 的机会。
      writeFileSync(target, text, 'utf8')
      backedUpRegistryFingerprints.add(fingerprint)
      warn(`corrupted personas.json backed up to ${target}`)
      return target
    } catch (error) {
      warn(`failed to back up corrupted personas.json: ${describe(error)}`)
      return ''
    }
  }

  /** 读磁盘注册表（不存在或非法返回 null；畸形 slug 条目丢弃并 warn）。 */
  async function loadRegistry() {
    const raw = await readJsonRaw(personasPath)
    return raw === undefined ? null : finalizeRegistry(normalizeRegistry(raw))
  }

  /**
   * 同步读磁盘注册表（构造期用；归一 / 复查 / 重复主管告警与 `loadRegistry` 完全同口径）。
   *
   * 与 `loadRegistry` 的**唯一差别**：文件在但 JSON 损坏时，先把原文备份成
   * `personas.json.corrupt-<UTC 时间戳>` 再退回空表。之后任何写人设操作都会覆盖原文件
   * ——这是既定策略（面板保持可用），备份是这条策略下唯一的挽回手段。
   */
  function loadRegistrySync() {
    const detail = readJsonSyncDetailed(personasPath)
    if (detail.broken) backupBrokenRegistry(detail.text)
    return detail.value === undefined ? null : finalizeRegistry(normalizeRegistry(detail.value))
  }

  /**
   * 归一之后的统一收尾：重复主管告警 + 安全复查。
   *
   * **告警必须排在 `sanitizeRegistry` 之前**：`sanitizeRegistry` 丢弃条目时会 `{ ...registry }`
   * 展开，把不可枚举的「降级条数」一并丢掉（符号属性不参与展开）。先判后清，告警反映的是
   * 磁盘文件里的真实冲突，而不是复查之后剩下的样子。
   *
   * 顺序反过来会有一个更难察觉的坑：被丢弃的畸形条目若正是「第一个主管」，剩余条目里那些
   * 原本被降级的 `supervisor:true` 已经在归一阶段删掉了字段，复查后再归一也找不回来——
   * 与其假装能补救，不如老实承认「这个文件的第一个主管条目是废的，本表暂无主管」，
   * 让 `supervisorSync()` 走它自己的 default 兜底。
   *
   * @param {object|null} normalized - `normalizeRegistry` 的结果。
   * @returns {object|null} 可进内存态的注册表。
   */
  function finalizeRegistry(normalized) {
    if (normalized === null) return null
    warnDroppedSupervisors(normalized)
    return sanitizeRegistry(normalized)
  }

  /** 读磁盘设置（缺失/非法一律回退默认值）。 */
  async function loadSettings() {
    const raw = await readJsonRaw(settingsPath)
    return raw === undefined ? { ...DEFAULT_SETTINGS } : normalizeSettings(raw)
  }

  /**
   * 对归一化后的注册表做安全复查：丢弃含路径风险形态的 slug 条目。
   *
   * 手编 personas.json 可以塞进 `../../etc` 这类 slug——`normalizeRegistry` 只 trim
   * 不验形态（§V5.2 的「逐字匹配」防的是归一化误命中，不是路径穿越），而
   * deletePersona 查表命中后会拿 slug 直接 join 进目录路径 `rm -rf`，越界删目录。
   * 因此在加载边界（reconcileRegistry 与 listPersonas 都经过这里）把畸形条目
   * 丢弃并 warn。这里**只丢条目，不改 current**：current 指向被丢条目时视同悬空，
   * 既有「current 悬空回退 default」的链路会接手。
   *
   * @param {object} registry - normalizeRegistry 的结果。
   * @returns {object} 过滤后的注册表（新对象；无畸形条目时是同一引用）。
   */
  function sanitizeRegistry(registry) {
    if (registry === null || registry === undefined) return registry
    const personas = Array.isArray(registry.personas) ? registry.personas : []
    if (personas.every((item) => !unsafeSlug(item?.slug ?? ''))) return registry
    const kept = personas.filter((item) => {
      if (!unsafeSlug(item?.slug ?? '')) return true
      warn(`dropped unsafe persona slug from registry: ${item.slug}`)
      return false
    })
    return { ...registry, personas: kept }
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
      // 只豁免两步改名的临时目录（归一失败时可能留在原地）。**不许扩大成「跳过所有点号开头的
      // 目录」**：personaSlug('../../etc') 产出 `..-..-etc`，合法且以点开头，一并跳过会让一个
      // 真实人设从面板上凭空消失——那比留一个临时目录严重得多。
      if (entry.name.startsWith(MIGRATING_PREFIX)) continue
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
   * 两步改目录名：`from` → `.default-migrating-<随机>` → `to`（契约 §V6.1 第 4 步）。
   *
   * 为什么要绕一趟临时名：macOS APFS 默认大小写不敏感，`rename('Default','default')`
   * 在这种卷上可能被判定为同名而无效、或直接报错。主人偶尔用 macOS，这不是纸上担心。
   *
   * 失败处理：第一步失败 ⇒ 什么都没发生，直接放弃；第二步失败 ⇒ 把临时名改回原名
   * （**绝不 `rm`**，宁可留着大小写裂口）。回滚是必要的：`.default-migrating-*` 虽然已被
   * `scanPersonaDirs()` 精准豁免、不会变成幽灵条目，但它会永远堆在人设根目录里，
   * 并且下一次归一尝试会把它误认成散落的临时名。
   *
   * @param {string} from - 源目录绝对路径。
   * @param {string} to - 目标目录绝对路径。
   * @returns {Promise<boolean>} 是否改名成功。
   */
  async function renameDirTwoSteps(from, to) {
    const temporary = join(personasRoot, `${MIGRATING_PREFIX}${randomBytes(4).toString('hex')}`)
    try {
      await moveDir(from, temporary)
    } catch (error) {
      warn(`rename default persona dir (first hop) failed: ${describe(error)}`)
      return false
    }
    try {
      await moveDir(temporary, to)
      return true
    } catch (error) {
      warn(`rename default persona dir (second hop) failed: ${describe(error)}`)
      try {
        await moveDir(temporary, from) // 退回原位，绝不 rm
      } catch (rollbackError) {
        warn(`rollback of ${temporary} failed, dir left as-is: ${describe(rollbackError)}`)
      }
      return false
    }
  }

  /** 列 personasRoot 下的**全部**条目名（含文件：复查时要能看见占位的怪东西）。 */
  async function listPersonaEntryNames() {
    try {
      return await readdir(personasRoot)
    } catch {
      return []
    }
  }

  /**
   * 归一放弃时把**本次**留下的临时目录改回原变体名，让磁盘回到起点（绝不 `rm`）。
   * 只认 MIGRATING_PREFIX 这一个前缀，别的目录一概不碰。
   */
  async function sweepStrayMigratingDir(variant) {
    const names = await listPersonaEntryNames()
    const stray = names.find((name) => name.startsWith(MIGRATING_PREFIX))
    if (stray === undefined) return // 磁盘本来就停在原状，无需恢复
    try {
      await moveDir(join(personasRoot, stray), join(personasRoot, variant))
    } catch (error) {
      warn(`restore ${stray} to ${variant} failed, dir left as-is: ${describe(error)}`)
    }
  }

  /**
   * 复查改名是否**真的**落到了小写目录名上。
   *
   * 大小写不敏感的卷上 `rename` 可能被判定为同名而**静默无效**——它不抛错，于是我们会把
   * 注册表条目改成 `default`，而磁盘上仍是 `Default`；下次扫盘又把 `Default` 当成新人设登记，
   * 面板下拉里凭空多出一条重复。所以宁可放弃归一，也绝不留「条目与目录不一致」。
   *
   * @param {string} variant - 被归一的旧 slug，仅用于告警文案。
   * @returns {Promise<boolean>} 磁盘上是否确实存在**恰好**叫 `default` 的条目。
   */
  async function verifyDefaultDirLanded(variant) {
    const names = await listPersonaEntryNames()
    // 精确匹配：Array.prototype.includes 走 ===，大写变体不算数。
    const landed = foldProbe === null ? names.includes('default') : await foldProbe(names)
    if (landed) return true
    warn(`default persona dir still not named 'default' after rename from ${variant}, giving up`)
    await sweepStrayMigratingDir(variant)
    return false
  }

  /**
   * 把默认人设的目录与注册表条目归一为小写 `default`（契约 §V6.1）。
   *
   * **必须在 `scanPersonaDirs()` 之后、把目录合并进注册表之前**调用：归一若排在合并之后，
   * 会先按大写字母塞进一个条目、再把目录改名，注册表里留下重复条目。
   *
   * 顺序是「先磁盘、复查通过后才动注册表」，所以任何一步放弃都不需要回滚注册表——
   * 条目从头到尾没被改过。
   *
   * @param {Array<{slug:string, name:string, createdAt:string}>} dirs - 扫描到的人设目录。
   * @param {{ current: string, personas: Array<object> }} registry - 已加载的注册表（原地同步）。
   * @returns {Promise<{ dirs: Array<object>, changed: boolean, foldedFrom: string }>}
   *   `dirs` 是归一后的目录列表（供后续合并），`changed` 表示注册表是否需要同步落盘，
   *   `foldedFrom` 是被归一掉的旧 slug（未归一时为空串，供调用方映射 defaultCurrent）。
   */
  async function foldDefaultPersonaDir(dirs, registry) {
    const untouched = { dirs, changed: false, foldedFrom: '' }
    const variants = dirs.filter((dir) => isDefaultSlug(dir.slug) && dir.slug !== 'default')
    if (variants.length === 0) return untouched // 没有大小写变体：什么都不动
    const lowercase = dirs.some((dir) => dir.slug === 'default')
    // 冲突一律放弃（§V6.1 第 3 步）：两个目录都可能有真实内容，自动合并等于赌哪个该留。
    // 判据同时看目录与注册表条目——只要任何一处已经存在小写 default，把变体条目改名过去
    // 就会造出重复 slug，同样是二义，交人工处理。
    const lowerInRegistry = registry.personas.some((item) => item.slug === 'default')
    if (lowercase || lowerInRegistry || variants.length > 1) {
      const found = [
        ...dirs.filter((dir) => isDefaultSlug(dir.slug)).map((dir) => dir.slug),
        ...(lowerInRegistry ? ['default(注册表条目)'] : []),
      ]
      warn(`default persona slug conflict, left untouched: ${found.join(', ')}`)
      return untouched
    }
    const variant = variants[0].slug
    if (!(await renameDirTwoSteps(join(personasRoot, variant), join(personasRoot, 'default')))) {
      return untouched // warn 已在 renameDirTwoSteps 里发过，裂口原样留着
    }
    // rename 不抛错不等于改到了：先复查磁盘真实目录名，通过之后才允许动注册表（§V6.1 兜底）。
    if (!(await verifyDefaultDirLanded(variant))) return untouched
    // 目录已改名：目录列表与条目跟着改，但 name / createdAt 原样保留 ⇒ 面板显示名不变。
    const foldedDirs = dirs.map((dir) => (dir.slug === variant ? { ...dir, slug: 'default' } : dir))
    let changed = false
    for (const item of registry.personas) {
      if (item.slug !== variant) continue
      item.slug = 'default'
      changed = true
    }
    if (registry.current === variant) {
      registry.current = 'default'
      changed = true
    }
    info(`default persona dir normalized: ${variant} -> default`)
    return { dirs: foldedDirs, changed, foldedFrom: variant }
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
    // 归一化默认人设的大小写排在合并条目之前（契约 §V6.1）。
    const folded = await foldDefaultPersonaDir(await scanPersonaDirs(), registry)
    let changed = folded.changed
    const dirs = folded.dirs
    for (const dir of dirs) {
      if (registry.personas.some((item) => item.slug === dir.slug)) continue
      registry.personas.push({ slug: dir.slug, name: dir.name, createdAt: dir.createdAt })
      changed = true
    }
    if (registry.current === '') {
      if (registry.personas.length > 0) {
        // 迁移首选若正是刚被归一的变体，映射到小写，否则 preferred 会 miss、current 漂到别处。
        const preferred = typeof options.defaultCurrent === 'string' && options.defaultCurrent === folded.foldedFrom
          ? 'default'
          : options.defaultCurrent
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

  /**
   * 列出人设（按 createdAt 升序）。
   *
   * v13 起每项还带 `supervisor: boolean` 与 `expertise: string` 两个字段（契约 §V13）。
   * **这两个字段是不可枚举的自身属性**，理由是既要「新增字段」又要「老调用方不受影响」：
   * `assert.deepEqual(listed[0], { slug, name, createdAt, dir })` 这类既有断言（以及
   * `JSON.stringify`）只看可枚举属性，加可枚举字段会把一批与本次改动无关的旧用例打红；
   * 而读侧 `item.supervisor` / `item.expertise` 与普通字段完全等价，下游 routes / tools
   * 都只读属性、不展开对象。
   *
   * 代价（已知）：`{ ...item }` 展开会丢掉这两个字段，直接 `JSON.stringify(listPersonas())`
   * 也带不出来。要序列化的调用方请显式取值（access.personasData / routes-experts 已是这种写法）。
   *
   * @returns {Array<{ slug:string, name:string, createdAt:string, dir:string,
   *   supervisor:boolean, expertise:string }>} 人设列表（只读快照，改它不影响注册表）。
   */
  function listPersonas() {
    const items = (personasState?.personas ?? []).map((item) => {
      const record = {
        slug: item.slug,
        name: item.name,
        createdAt: item.createdAt,
        dir: join(personasRoot, item.slug),
      }
      // 缺省即 false / 空串：老 personas.json 没有这两个字段时读出来的行为与「显式写了」
      // 完全一致，不需要迁移写盘。
      Object.defineProperties(record, {
        supervisor: { value: item.supervisor === true, enumerable: false, configurable: true },
        expertise: {
          value: typeof item.expertise === 'string' ? item.expertise : '',
          enumerable: false,
          configurable: true,
        },
      })
      return record
    })
    return sortPersonas(items)
  }

  /**
   * 当前主管（契约 §V13）。**同步**——系统提示的 section 回调是同步执行的，不能 await。
   *
   * 三级取值：
   *   1. 注册表里被标记 `supervisor: true` 的那一条（`normalizeRegistry` 已保证全表最多一个）；
   *   2. 没有标记时兜底 `slug` 为 default 的条目（大小写不敏感，口径同 `isDefaultSlug`）；
   *   3. 再没有则 null（调用方据此判定「还没有主管」，不要自己编一个）。
   *
   * 只读 `personasState`（构造期已同步加载，`ready` 之前也有正确值），不读盘、不抛。
   *
   * @returns {{ slug: string, name: string } | null} 主管；没有则 null。
   */
  function supervisorSync() {
    const personas = personasState?.personas ?? []
    const marked = personas.find((item) => item.supervisor === true)
    if (marked !== undefined) return { slug: marked.slug, name: marked.name }
    const fallback = personas.find((item) => isDefaultSlug(item.slug))
    if (fallback !== undefined) return { slug: fallback.slug, name: fallback.name }
    return null
  }

  /**
   * 把注册表的 current 换成 `{ slug, name }`。
   * 空串 → null；有条目用条目名，只有 current 悬空时按 slug 兜底显示。
   */
  function currentFromRegistry(registry) {
    const slug = typeof registry?.current === 'string' ? registry.current : ''
    if (slug === '') return null
    const found = registry.personas.find((item) => item.slug === slug)
    return found === undefined ? { slug, name: slug } : { slug: found.slug, name: found.name }
  }

  /** 当前人设（读 personas.json.current）；没有则 null。 */
  function currentPersona() {
    return currentFromRegistry(personasState)
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
   * 指定主管（契约 §V13）：目标条目 `supervisor: true`，其余全部清掉，原子写 personas.json。
   *
   * 两条实现上的选择：
   * - **逐字匹配 slug，不做 `personaSlug()` 归一化**，口径同 `renamePersona` / `deletePersona`。
   *   调用方（面板路由）传的本来就是 `listPersonas()` 里的 slug；归一化只会制造
   *   「传一个别的名字，悄悄指到了另一条」的意外。
   * - **先建新注册表再落盘，成功后才换内存态**（不像 renamePersona 那样原地改再回滚）：
   *   一次要动全表，原地改的回滚面太大，新对象法让「写盘失败」这条路径天然无脏值。
   *
   * 其余条目上的 `supervisor` 字段是**删掉**而不是写 `false`：老文件字节不变，
   * 读侧缺省即 false，行为等价（见 `normalizeRegistry` 注释）。
   *
   * @param {string} slug - 人设 slug，与注册表**逐字**匹配（不做 `personaSlug()` 归一化，
   *   也不 trim；面板路由传进来的本来就是注册表里的原值）。
   * @returns {Promise<{ ok:true, supervisor:{ slug:string, name:string } }
   *   | { ok:false, code:string, message:string }>} 结果；`NOT_FOUND` 表示没有该人设。
   */
  async function setSupervisor(slug) {
    await ready
    if (typeof slug !== 'string' || slug.trim() === '') return badInput('slug must be a non-empty string')
    const key = slug
    return enqueue(personasPath, async () => {
      const registry = personasState ?? { version: REGISTRY_VERSION, current: '', personas: [] }
      const target = registry.personas.find((item) => item.slug === key)
      if (target === undefined) return { ok: false, code: 'NOT_FOUND', message: `persona not found: ${key}` }
      const next = {
        version: REGISTRY_VERSION,
        current: registry.current,
        personas: registry.personas.map((item) => {
          const copy = { ...item }
          if (item.slug === key) copy.supervisor = true
          else delete copy.supervisor
          return copy
        }),
      }
      if (!(await persistRegistry(next))) {
        return { ok: false, code: 'UNWRITABLE', message: 'failed to write personas.json' }
      }
      personasState = next
      return { ok: true, supervisor: { slug: target.slug, name: target.name } }
    }).catch((error) => ({ ok: false, code: 'UNWRITABLE', message: describe(error) }))
  }

  /**
   * 写单条专长（契约 §V13）：清洗规则与 `normalizeExpertise` 一致（折叠换行、去首尾空白、
   * 按码点截到 500），原子写盘、走同一路径的串行队列。
   *
   * 清洗后是空串时**删掉该字段**而不是写 `expertise: ""`：读侧两者等价，删字段让
   * 「没有专长」的老文件保持字节不变。返回值里仍是清洗后的空串，调用方无需区分。
   *
   * @param {string} slug - 人设 slug，与注册表**逐字**匹配（口径同 `setSupervisor`）。
   * @param {string} text - 专长文本；非字符串一律 `BAD_INPUT`。
   * @returns {Promise<{ ok:true, expertise:string } | { ok:false, code:string, message:string }>}
   *   结果；`NOT_FOUND` 表示没有该人设，`BAD_INPUT` 表示 slug / text 类型不对。
   */
  async function setExpertise(slug, text) {
    await ready
    if (typeof slug !== 'string' || slug.trim() === '') return badInput('slug must be a non-empty string')
    if (typeof text !== 'string') return badInput('expertise must be a string')
    const key = slug
    const expertise = normalizeExpertise(text)
    return enqueue(personasPath, async () => {
      const registry = personasState ?? { version: REGISTRY_VERSION, current: '', personas: [] }
      if (!registry.personas.some((item) => item.slug === key)) {
        return { ok: false, code: 'NOT_FOUND', message: `persona not found: ${key}` }
      }
      const next = {
        version: REGISTRY_VERSION,
        current: registry.current,
        personas: registry.personas.map((item) => {
          if (item.slug !== key) return item
          const copy = { ...item }
          if (expertise === '') delete copy.expertise
          else copy.expertise = expertise
          return copy
        }),
      }
      if (!(await persistRegistry(next))) {
        return { ok: false, code: 'UNWRITABLE', message: 'failed to write personas.json' }
      }
      personasState = next
      return { ok: true, expertise }
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

  /**
   * 被删的正是 current 时，谁来接班（契约 §V5.2）：
   * 默认人设（不论大小写，见 `isDefaultSlug`；若在剩余列表里）→ 剩余里 createdAt 最早的一个 →
   * `''`（注入回退 default 空模板）。
   *
   * v13 起**主管接班复用同一个函数**（契约 §V13：删除主管时按同一套优先级选新主管）：
   * 两处要的优先级恰好一样，各写一份迟早漂移。返回值是 slug，空表时是空串。
   */
  function pickSuccessorCurrent(remaining) {
    const fallback = remaining.find((item) => isDefaultSlug(item.slug))
    if (fallback !== undefined) return fallback.slug
    const oldest = sortPersonas(remaining)[0]
    return oldest === undefined ? '' : oldest.slug
  }

  /**
   * 重命名人设：只改注册表里的显示名，slug 与磁盘目录一概不动（契约 §V5.2）。
   *
   * 不写 `persona.json`——`reconcileRegistry` 只在注册表缺该 slug 时才用目录元数据重建
   * name，注册表有条目时那个文件里的 name 不参与显示，多写一个文件只会多一个失败面。
   *
   * @param {string} slug - 人设 slug，与注册表**逐字**匹配（不做 `personaSlug()` 归一化）。
   * @param {string} name - 新显示名；去空白后按码点截断到 60。
   * @returns {Promise<{ ok:true, persona:object } | { ok:false, code:string, message:string }>} 结果。
   */
  async function renamePersona(slug, name) {
    await ready
    if (typeof slug !== 'string' || slug === '') return badInput('slug must be a non-empty string')
    if (typeof name !== 'string' || name.trim() === '') return badInput('name must be a non-empty string')
    const display = [...name.trim()].slice(0, MAX_PERSONA_NAME).join('')
    return enqueue(personasPath, async () => {
      const registry = personasState ?? { version: REGISTRY_VERSION, current: '', personas: [] }
      const entry = registry.personas.find((item) => item.slug === slug)
      if (entry === undefined) return { ok: false, code: 'NOT_FOUND', message: `persona not found: ${slug}` }
      const previous = entry.name
      entry.name = display
      if (!(await persistRegistry(registry))) {
        entry.name = previous // 写盘失败：内存里不留脏值
        return { ok: false, code: 'UNWRITABLE', message: 'failed to write personas.json' }
      }
      personasState = registry
      // dir 仍是原目录：调用方据此知道「目录没动」。
      return {
        ok: true,
        persona: { slug: entry.slug, name: entry.name, createdAt: entry.createdAt, dir: join(personasRoot, entry.slug) },
      }
    }).catch((error) => ({ ok: false, code: 'UNWRITABLE', message: describe(error) }))
  }

  /**
   * 删除人设：摘注册表条目 + `rm -rf` 其目录 + 清进程内缓存（契约 §V5.2 + §V5.0）。
   *
   * 顺序上的铁律是**宁可残留目录，绝不留幽灵条目**：注册表先落盘、再删目录；
   * 注册表写失败时磁盘尚未被动过（状态完全自洽），删目录失败则把条目按原位置插回
   * 并重写一次注册表。`runs.jsonl` 与项目记忆按 §V5.2 的清单刻意不动。
   *
   * 安全加固：§V5.2 的「逐字匹配、不做 personaSlug 归一化」只防归一化误命中，不防
   * 手编 personas.json 塞进含路径分隔符或 `..` 段的畸形 slug——查表命中后本函数会拿
   * slug 直接 join 进目录路径，这类条目能越出 personasRoot 删目录。防线在源头：
   * loadRegistry / 构造期加载都过 sanitizeRegistry，畸形条目根本进不了注册表，
   * 逐字查表自然 miss，越界无从发生。前提「先查表再拼路径、不做归一化」不变。
   *
   * v13 起删除主管时还要补选新主管（契约 §V13）：优先级与 current 接班**完全同一套**
   * （`pickSuccessorCurrent`：default → 剩余里 createdAt 最早），并写回 `supervisor: true`；
   * 没有剩余人设时主管留空——不写标记，读侧 `supervisorSync()` 自然返回 null。
   * 判定用的是**删除前内存态里被标记的那条**，不是 `supervisorSync()` 的兜底值：
   * 兜底（无标记时取 default）不属于「用户显式指定过主管」，删掉它不该凭空给别人戴帽子。
   *
   * @param {string} slug - 人设 slug，与注册表**逐字**匹配。绝不走 `personaSlug()` 归一化：
   *   归一化会把 `../../etc` 变成 `..-..-etc`，反而可能命中磁盘上真实存在的同名目录。
   * @returns {Promise<{ ok:true, deleted:{ slug:string, name:string }, current:object|null }
   *   | { ok:false, code:string, message:string }>} 结果；`current` 是删除后的当前人设。
   */
  async function deletePersona(slug) {
    if (typeof slug !== 'string' || slug === '') return badInput('slug must be a non-empty string')
    // 路径安全不靠入口拦，而靠源头：sanitizeRegistry 在加载边界已把含路径分隔符 /
    // `..` 段的畸形条目丢弃并 warn，所以畸形 slug 在下面的逐字查表里必然 miss →
    // NOT_FOUND，越界 rm 无从发生。这里不做归一化（§V5.2 铁律），也不改错误码——
    // 「找不到」与「不给删」在查表 miss 时语义本就一致。
    // 删除下限（§V5.0）：默认人设是 resolveScope 与 personaKey 的兜底键，永久禁删。
    // 判定走 isDefaultSlug（大小写不敏感）——真实环境里它是 'Default'，逐字比小写等于没保护。
    // 这条判断不吃任何磁盘状态，所以排在 await ready 之前——禁删不该被迁移流程牵制。
    if (isDefaultSlug(slug)) return { ok: false, code: 'PERSONA_PROTECTED', message: 'the default persona cannot be deleted' }
    await ready
    return enqueue(personasPath, async () => {
      const registry = personasState ?? { version: REGISTRY_VERSION, current: '', personas: [] }
      const index = registry.personas.findIndex((item) => item.slug === slug)
      if (index < 0) return { ok: false, code: 'NOT_FOUND', message: `persona not found: ${slug}` }
      const entry = registry.personas[index]
      const dir = join(personasRoot, slug)
      // before = 删除前的内存态，也等于删除前的磁盘态；回滚一律以它为准，原对象全程不被改写，
      // 于是「写注册表失败」这条路径上 personasState 天然没动过，无需任何补救。
      const before = { version: REGISTRY_VERSION, current: registry.current, personas: registry.personas.map((item) => ({ ...item })) }
      const remaining = before.personas.filter((_, i) => i !== index)
      const successor = before.current === slug ? pickSuccessorCurrent(remaining) : before.current
      // 主管接班：只处理「被删的确实是显式标记的那一条」。剩余为空 ⇒ nextSupervisor 为空串 ⇒
      // 下面一个标记都不写（主管留空）。否则把标记从原条目上摘掉、戴到接班者头上。
      const wasSupervisor = entry.supervisor === true
      const nextSupervisor = wasSupervisor ? pickSuccessorCurrent(remaining) : ''
      const personasAfter = remaining.map((item) => {
        if (!wasSupervisor) return item
        const copy = { ...item }
        if (item.slug === nextSupervisor) copy.supervisor = true
        else delete copy.supervisor
        return copy
      })
      const after = { version: REGISTRY_VERSION, current: successor, personas: personasAfter }

      // 1) 注册表先落盘（磁盘此时还没动）。
      if (!(await persistRegistry(after))) return { ok: false, code: 'UNWRITABLE', message: 'failed to write personas.json' }
      // 2) 再删目录；force 本身就吞 ENOENT，这里的豁免只兜住实现差异。
      try {
        await rm(dir, { recursive: true, force: true })
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          // 目录还在 ⇒ 把条目插回原位置、current 复原，重写注册表让内存与磁盘重新对齐。
          if (await persistRegistry(before)) personasState = before
          else warn(`restore registry after failed rm of ${dir} failed: ${describe(error)}`)
          return { ok: false, code: 'UNWRITABLE', message: `failed to remove ${dir}: ${describe(error)}` }
        }
      }
      // 3) 内存与缓存收尾（漏掉清缓存 = 重建同名 slug 后读到已删内容的残影）。
      personasState = after
      forgetCachedUnder(dir)
      return { ok: true, deleted: { slug: entry.slug, name: entry.name }, current: currentFromRegistry(after) }
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

  /** 读插件设置（默认 `{ enabled:true, digestProvider:'', digestModel:'' }`）。 */
  function readSettings() {
    return { ...(settingsState ?? DEFAULT_SETTINGS) }
  }

  /**
   * 写插件设置。
   *
   * 键与类型由 `SETTINGS_KEYS` + `DEFAULT_SETTINGS` 决定：布尔键（`enabled`、
   * `recallFilterEnabled`）只接受真正的布尔，字符串键（`digestProvider` / `digestModel` /
   * `recallFilterProvider` / `recallFilterModel`）只接受字符串并 trim，
   * 其它键与类型不符的值一律忽略（非法值忽略）。**新增设置键只改那两个常量即可**，
   * 本函数与落盘都不需要再动。
   *
   * 「读当前值 → 合并 patch → 写」整体在 settingsPath 的写队列**内部**完成：
   * 合并基线在队列里重读 settingsState 的最新值，两个并发的 writeSettings 不再
   * 互相覆盖（此前 patch 在队列外基于旧 settingsState 计算，后写会覆盖前写）。
   *
   * @param {object} patch - 增量设置。
   * @returns {Promise<{ ok:true, settings:object } | { ok:false, code:string, message:string }>} 结果。
   */
  async function writeSettings(patch) {
    await ready
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return badInput('settings patch must be an object')
    return enqueue(settingsPath, async () => {
      const base = settingsState ?? DEFAULT_SETTINGS
      const next = { ...base }
      for (const key of SETTINGS_KEYS) {
        const value = patch[key]
        if (typeof value !== typeof DEFAULT_SETTINGS[key]) continue
        next[key] = typeof value === 'string' ? value.trim() : value
      }
      // 落盘内容必须按 SETTINGS_KEYS 动态拼：此前这里硬编码三个键，
      // 新增设置键会被 next 合并进去、却不进文件，读回时静默丢失。
      const file = { version: REGISTRY_VERSION }
      for (const key of SETTINGS_KEYS) file[key] = next[key]
      const written = await writeJsonAtomic(settingsPath, file)
      if (!written.ok) return { ok: false, code: 'UNWRITABLE', message: 'failed to write settings.json' }
      settingsState = next
      return { ok: true, settings: { ...next } }
    }).catch((error) => {
      warn(`write settings failed: ${describe(error)}`)
      return { ok: false, code: 'UNWRITABLE', message: describe(error) }
    })
  }

  // —————————————————————————— 项目 / 整理报告 ——————————————————————————

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

  /**
   * 列出项目记忆目录里的全部 md 文档（契约 V8.6）。
   *
   * 存在的理由：检索过去只覆盖四个记忆文件，**同目录里的 `pitfalls.md` 查不到**——
   * 最该被检索的东西恰好不可查。v8 的冷层检索要把 project 目录下所有 md 都纳入，
   * 这一层就负责给出可靠的清单。
   *
   * 三条硬规矩（契约 V8.6，逐条有测试钉住）：
   *
   * - **只列本目录下的 `*.md` 普通文件**，`history/` 子目录整个排除。快照文件名也叫
   *   `project-memory-<UTC>-<4hex>.md`，一旦混进检索目标，一条被删掉的事实会靠快照
   *   在检索结果里阴魂不散——这正是 V8.14 要防的失效模式。
   *   不递归 + 只认 `isFile()` 就是这条的机械保证：`history` 是目录，走不进清单；
   *   符号链接同样排除，不跟随链接读盘外的东西。
   * - **排序稳定**：按 `name` 码点序，不用 `localeCompare`（它随 ICU / locale 变，
   *   跨机器的检索结果顺序就不一致了）。
   * - **目录不存在是正常状态**，返回 `{ ok: true, docs: [] }` 而不是报错：绝大多数项目
   *   从没写过项目记忆，把「没有目录」当错误会让每次检索都白警告一遍。
   *
   * 每项除契约声明的 `name` / `bytes` 之外还带一个 `path`（绝对路径）：工具层要按文件
   * 读取内容并回填命中项的 `file` 字段，而 `projectDirName` 是可配置项——让调用方自己
   * 拼路径等于把配置项复制一遍，迟早漂移。
   *
   * @param {{ projectRoot?: unknown }} [input] - 项目根（必须是绝对路径）。
   * @returns {Promise<{ ok: true, docs: Array<{ name: string, bytes: number, path: string }> }
   *   | { ok: false, code: string, error: string }>} 清单，或错误码（绝不抛）。
   */
  async function listProjectDocs(input = {}) {
    await ready
    const projectRoot = typeof input?.projectRoot === 'string' ? input.projectRoot : ''
    let dir
    try {
      dir = projectDirName === '.' ? projectRoot : safeJoin(projectRoot, projectDirName)
    } catch (error) {
      return { ok: false, code: 'BAD_INPUT', error: describe(error) }
    }

    let dirents
    try {
      dirents = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      // 没有记忆目录 = 这个项目还没有任何项目记忆，正常状态，不告警也不报错。
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { ok: true, docs: [] }
      warn(`listProjectDocs failed for ${dir}: ${describe(error)}`)
      return { ok: false, code: 'UNREADABLE', error: describe(error) }
    }

    const docs = []
    for (const dirent of dirents) {
      if (!dirent.isFile() || !dirent.name.endsWith('.md')) continue
      const path = join(dir, dirent.name)
      let bytes = 0
      try {
        bytes = (await stat(path)).size
      } catch (error) {
        // 刚列出来就 stat 不到（并发的改名 / 删除）：跳过这一条，其余照常。
        warn(`stat failed for ${path}: ${describe(error)}`)
        continue
      }
      docs.push({ name: dirent.name, bytes, path })
    }
    docs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    return { ok: true, docs }
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
  // 走 loadRegistrySync：与 ready 里的异步加载**同一条归一 + 复查 + 重复主管告警**链路，
  // 否则 supervisorSync() 在 ready 之前会读到一个没做过重复主管降级的表。
  personasState = loadRegistrySync()
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
    readDoc, readDocSync, writeDoc, appendEntries, writeDocSnapshot,
    // 人设（v2）
    listPersonas, currentPersona, setCurrentPersona, createPersona, personaDir, migrateLegacyPresets,
    // 人设的重命名与删除（v5）
    renamePersona, deletePersona,
    // 主管 / 专长（v13，契约 §V13）
    supervisorSync, setSupervisor, setExpertise,
    // 设置（v2）
    readSettings, writeSettings,
    // 旧 API（v1 兼容）
    listPresets, ensurePreset,
    // 项目 / 报告 / 辅助
    touchProject, listProjects, addProjectPath, listProjectDocs, readRuns, appendRun, docPath, stats, dispose,
  }
}
