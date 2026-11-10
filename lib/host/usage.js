/**
 * 热度统计的落盘与防抖（契约 §V8.10）。IO 全部走注入的依赖，便于测试替换。
 *
 * 落点：`<projectRoot>/<projectDirName>/usage.json`（默认 `.dsh/memory/usage.json`），
 * 与项目记忆同目录、同级——它记的是「这个项目哪些主题被反复用到」，跟着项目走。
 *
 * 三条铁律（本模块存在的全部理由都在这里）：
 *   1. **绝不抛**。热度是优化项：读失败当空统计、写失败只 warn，任何异常都不许
 *      连带把记忆注入或检索拖坏。
 *   2. **写入防抖**。命中发生在每轮 pre-step 与每次 search 上，逐次写盘等于给
 *      会话加一次同步 IO。进程内累计，攒到 `flushEvery`（默认 8，契约 §V8.15）
 *      或 dispose 时才落盘一次。
 *   3. **只读一次、写要原子**。首次访问读盘并缓存在内存，之后只改内存；落盘走
 *      同目录临时文件 + rename，不给并发读者留半个文件。
 *
 * 落盘触发只有**两种**（§V8.15 裁决 5）：每 N 次命中、以及 dispose。整编时落盘
 * 被取消——那要让整理器反向持有本模块实例，跨域耦合的收益太小。
 *
 * @module dsh-supermemory/host/usage
 */

import { dirname, isAbsolute, join, resolve } from 'node:path'
import { readFile as fsReadFile, mkdir, rename, writeFile as fsWriteFile } from 'node:fs/promises'

import { bumpUsage, emptyUsage, parseUsage, serializeUsage } from '../core/usage.js'

/** 默认攒够多少次命中才落一次盘（契约 §V8.15 裁决 5）。 */
export const DEFAULT_FLUSH_EVERY = 8

/** usage 文件名。 */
export const USAGE_FILE_NAME = 'usage.json'

/** 兜底的项目记忆目录名，与 store 的默认 `projectDirName` 一致。 */
const DEFAULT_PROJECT_DIR_NAME = '.dsh/memory'

/** 每个分片的内部状态。 */
function newShard() {
  return {
    /** 当前统计（内存态，唯一真值）。 */
    usage: emptyUsage(),
    /** 是否已读过盘。 */
    loaded: false,
    /** 自上次落盘以来累计的命中次数。 */
    pending: 0,
    /** 是否有未落盘的改动。 */
    dirty: false,
    /** 损坏只 warn 一次，避免每轮刷屏。 */
    warned: false,
    /** 串行队列：读盘 → 累加 → 落盘严格按顺序，后到的不覆盖先到的。 */
    chain: Promise.resolve(),
  }
}

/**
 * 建一个按项目分片的热度存储。
 *
 * @param {object} [options] - 依赖注入。
 * @param {(projectRoot: string) => string} [options.resolveDir] - 项目记忆目录；
 *   缺省用 `store.docPath` 的口径（`docPathRef`）或直接 `<root>/.dsh/memory`。
 * @param {(ref: object) => string} [options.docPathRef] - `store.docPath`，给了就优先按它算目录。
 * @param {(path: string) => Promise<string>} [options.readFile] - 读文本，缺省 `node:fs/promises.readFile`。
 * @param {(path: string, text: string) => Promise<void>} [options.writeFile] - 写文本（需原子或先写临时文件）。
 * @param {{ warn: Function }} [options.logger] - 宿主日志；任何 IO 问题都只 warn。
 * @param {number} [options.flushEvery] - 攒够多少次命中落一次盘；<=0 表示不自动落盘（只等 dispose）。
 * @returns {{ load: Function, record: Function, flush: Function, peek: Function, dispose: Function }} 存储。
 */
export function createUsageStore(options = {}) {
  const logger = options.logger ?? null
  const readFile = typeof options.readFile === 'function' ? options.readFile : defaultReadFile
  const writeFile = typeof options.writeFile === 'function' ? options.writeFile : defaultWriteFile
  const flushEvery = Number.isFinite(options.flushEvery)
    ? Math.max(0, Math.floor(options.flushEvery))
    : DEFAULT_FLUSH_EVERY
  const warn = (message, error) => {
    try {
      // 一次事故一条日志（仓库里 `warn('...: %o', error)` 的既有写法）：拆成两条会让
      // 「warn 一次」这种约束根本没法断言。
      if (error === undefined) logger?.warn?.(`supermemory: usage ${message}`)
      else logger?.warn?.(`supermemory: usage ${message}: %o`, error)
    } catch {
      /* 日志本身失败不能再抛 */
    }
  }

  /** 项目目录解析：优先问 store（口径与记忆文件同源），退回 `<root>/.dsh/memory`。 */
  const resolveDir = (projectRoot) => {
    if (typeof options.resolveDir === 'function') return options.resolveDir(projectRoot)
    if (typeof options.docPathRef === 'function' && isAbsolute(projectRoot)) {
      try {
        const path = options.docPathRef({ kind: 'project', projectRoot })
        if (typeof path === 'string' && path !== '') return dirname(path)
      } catch {
        /* 交给兜底路径 */
      }
    }
    return join(projectRoot, DEFAULT_PROJECT_DIR_NAME)
  }

  const shards = new Map()

  /** 取（或建）某项目的分片；非法 projectRoot 返回 null（调用方一律当空统计处理）。 */
  const shardOf = (projectRoot) => {
    // 必须是**传进来就绝对**的路径。这里不能先 resolve 再判：相对路径一旦被
    // resolve 成 cwd 下的绝对路径，usage.json 就会静默落到当前工作目录里去。
    if (typeof projectRoot !== 'string' || projectRoot === '' || !isAbsolute(projectRoot)) return null
    const key = resolve(projectRoot)
    let shard = shards.get(key)
    if (shard === undefined) {
      shard = newShard()
      shards.set(key, shard)
    }
    return shard
  }

  /** 读一次盘：缺失当空统计（正常态、不 warn），JSON 损坏 warn 一次。 */
  const loadInto = async (shard, projectRoot) => {
    if (shard.loaded) return
    const path = join(resolveDir(projectRoot), USAGE_FILE_NAME)
    let text = ''
    try {
      const value = await readFile(path)
      text = typeof value === 'string' ? value : ''
    } catch (error) {
      // ENOENT 是「这个项目还没热度过」，最常见，不惊动日志；其余读错误必须吭声。
      if (error?.code !== 'ENOENT' && !shard.warned) {
        shard.warned = true
        warn(`read failed for ${path}, treating it as empty`, error)
      }
      shard.loaded = true
      return
    }
    shard.loaded = true
    shard.usage = parseUsage(text)
    const broken = text.trim() !== '' && !isJsonArrayOrObject(text)
    if (broken && !shard.warned) {
      shard.warned = true
      warn(`corrupted ${path}, continuing with empty stats`)
    }
  }

  /** 写一次盘：临时文件 + rename，失败只 warn。 */
  const writeOut = async (shard, projectRoot) => {
    if (!shard.dirty) return
    const path = join(resolveDir(projectRoot), USAGE_FILE_NAME)
    const text = serializeUsage(shard.usage)
    try {
      await writeFile(path, text)
      shard.dirty = false
      shard.pending = 0
    } catch (error) {
      warn(`write failed for ${path}, keeping stats in memory`, error)
    }
  }

  /**
   * 往某项目的队列尾部追加一步：`ensureLoaded` → 累加 → 按阈值落盘。
   * 返回的 Promise 可 await（便于 dispose 与测试），但内部已全捕获，不会 reject。
   */
  const enqueue = (shard, projectRoot, work) => {
    shard.chain = shard.chain.then(async () => {
      try {
        await loadInto(shard, projectRoot)
        await work(shard)
      } catch (error) {
        warn(`step failed for ${projectRoot}`, error)
      }
    })
    return shard.chain
  }

  return {
    /**
     * 读统计（首次会读盘）。任何失败都回空统计，绝不抛。
     * @param {string} projectRoot - 项目根。
     * @returns {Promise<object>} 统计对象。
     */
    async load(projectRoot) {
      const shard = shardOf(projectRoot)
      if (shard === null) return emptyUsage()
      await enqueue(shard, projectRoot, () => {})
      return shard.usage
    },

    /**
     * 记一批命中（主题名与条目 id）。同步返回队列 Promise，调用方可不等。
     *
     * @param {string} projectRoot - 项目根。
     * @param {{ topics?: string[], entries?: string[] }} [hits] - 命中项。
     * @param {string} [at] - ISO 时间戳。
     * @returns {Promise<void>} 队列尾部（内部全捕获，不会 reject）。
     */
    record(projectRoot, hits, at) {
      const shard = shardOf(projectRoot)
      if (shard === null) return Promise.resolve()
      const topics = Array.isArray(hits?.topics) ? hits.topics : []
      const entries = Array.isArray(hits?.entries) ? hits.entries : []
      if (topics.length === 0 && entries.length === 0) return Promise.resolve()
      return enqueue(shard, projectRoot, async (current) => {
        current.usage = bumpUsage(current.usage, { topics, entries }, at)
        current.dirty = true
        current.pending += topics.length + entries.length
        if (flushEvery > 0 && current.pending >= flushEvery) await writeOut(current, projectRoot)
      })
    },

    /**
     * 立即把所有脏分片落盘（dispose 用）。返回的 Promise 不会 reject。
     * @returns {Promise<void>} 全部写完后 resolve。
     */
    async flush() {
      for (const [projectRoot, shard] of shards) {
        await enqueue(shard, projectRoot, async (current) => {
          await writeOut(current, projectRoot)
        })
      }
    },

    /**
     * 只看内存态，不读盘（渲染前的快路径与测试断言用）。
     * @param {string} projectRoot - 项目根。
     * @returns {object} 统计对象（未加载时为空统计）。
     */
    peek(projectRoot) {
      const shard = shardOf(projectRoot)
      return shard === null ? emptyUsage() : shard.usage
    },

    /** 落盘并丢掉全部分片缓存。 */
    async dispose() {
      await this.flush()
      shards.clear()
    },
  }
}

/** 文本是否是合法 JSON 对象/数组（用来区分「空文件」与「损坏」）。 */
function isJsonArrayOrObject(text) {
  try {
    const value = JSON.parse(text)
    return value !== null && typeof value === 'object'
  } catch {
    return false
  }
}

/** 默认读文本。 */
async function defaultReadFile(path) {
  return fsReadFile(path, 'utf8')
}

/**
 * 默认写文本：同目录临时文件 + rename，读者永远看不到半个文件。
 * 目录不存在时补建一次（usage 可能先于任何记忆文件出现）。
 */
async function defaultWriteFile(path, text) {
  const directory = dirname(path)
  await mkdir(directory, { recursive: true })
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  await fsWriteFile(tmp, text, 'utf8')
  await rename(tmp, path)
}

/**
 * 进程内共享的热度存储。
 *
 * 为什么要共享：`memory search` 命中（tools.js）与动态预取命中（inject.js）是两个
 * 记录点，各自持有一份内存态就会互相覆盖同一个 usage.json——后写的把先写的整个盖掉。
 * 生产只有一个进程、一个插件实例，所以模块级单例足矣。
 *
 * 测试不要用它：`createUsageStore({ readFile, writeFile })` 显式注入假 IO。
 *
 * @param {object} [options] - 首次创建时的依赖注入；后续调用忽略。
 * @returns {object} 共享的存储实例（见 `createUsageStore` 的返回值）。
 */
let shared = null
export function getSharedUsageStore(options = {}) {
  if (shared === null) shared = createUsageStore(options)
  return shared
}
