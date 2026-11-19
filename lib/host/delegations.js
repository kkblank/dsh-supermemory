/**
 * dsh-supermemory —— 委派记录（`delegations.jsonl`）。
 *
 * 每次 `delegate_expert` 委派（成功或失败）写一行 JSON，供面板「委派记录」
 * 列表展示与排障。设计约束：
 *
 * - **绝不抛异常**：所有 IO 失败都收敛成 `{ ok:false }` / 空数组，只 `logger.warn`。
 * - 同路径写串行（照 `lib/core/store.js` 的 enqueue 思路）：追加与裁剪不会互相踩。
 * - 裁剪用「同目录临时文件 + rename」原子替换；rename 可见时内容已经完整。
 * - 行数控制按**读盘后的真实行数**而不是内存计数：文件可能被外部追加、或进程重启后
 *   继续使用，内存计数会失准；记录量很低（一次委派一行），整读成本可以忽略。
 *
 * 记录形状固定为十个键（见 {@link normalizeRecord}）；预览字段在这里统一单行化
 * 并截断到 200 字符，调用方直接传原文即可，不必自己处理落盘形态。
 *
 * 不 import 任何 `@deepseek-ai/*` 宿主包：只依赖 `node:*` 内置模块。
 *
 * @module dsh-supermemory/host/delegations
 */

import { randomBytes } from 'node:crypto'
import { appendFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/** 保留行数默认值（与 `delegateLogKeep` 的配置默认值一致）。 */
const DEFAULT_KEEP = 200

/** `recent()` 默认返回条数。 */
const DEFAULT_RECENT = 50

/** `taskPreview` / `resultPreview` 的字符上限。 */
const PREVIEW_CHARS = 200

/**
 * 按**文件路径**共享的写队列尾指针。
 *
 * 为什么不是每个实例一个队列：装配层（`lib/index.js`）为面板另建了一个实例读同一个
 * `delegations.jsonl`，工具侧也建一个写。两个实例各有各的队列时，A 的「追加 + 裁剪重写」
 * 可能与 B 的追加交错——A 先读到 N 行、B 又追加一行、A 再把旧快照写回，B 那条就丢了。
 * 队列按路径共享才能让「读-改-写」整段串行。模块级 Map 会随路径数增长，但本插件
 * 只有这一个日志文件，无需淘汰。
 */
const queues = new Map()

/** 取字符串原值；非字符串 → 空串。 */
function asText(value) {
  return typeof value === 'string' ? value : ''
}

/** 单行化：所有空白折叠成一个空格并去首尾。 */
function singleLine(value) {
  const text = asText(value)
  if (text === '') return ''
  return text.replace(/\s+/gu, ' ').trim()
}

/** 单行化后按字符（码点）截断到 {@link PREVIEW_CHARS}。 */
function previewOf(value) {
  const line = singleLine(value)
  const chars = Array.from(line)
  return chars.length <= PREVIEW_CHARS ? line : chars.slice(0, PREVIEW_CHARS).join('')
}

/**
 * 把一条调用方记录规整成固定的落盘形状。
 *
 * 只输出白名单里的十个键：日志是给人看的历史数据，多出来的内部字段（signal、
 * 完整 prompt 等）既无用又可能很大，不进盘。
 *
 * @param {unknown} record - 调用方传入的记录。
 * @returns {{
 *   at: string, supervisor: string, persona: string, sessionId: string, label: string,
 *   ok: boolean, stopReason: string | null, durationMs: number,
 *   taskPreview: string, resultPreview: string
 * }} 规整后的记录。
 */
function normalizeRecord(record) {
  const source = record !== null && typeof record === 'object' ? record : {}
  return {
    at: asText(source.at) !== '' ? asText(source.at) : new Date().toISOString(),
    supervisor: asText(source.supervisor),
    persona: asText(source.persona),
    sessionId: asText(source.sessionId),
    label: asText(source.label),
    ok: source.ok === true,
    stopReason: typeof source.stopReason === 'string' && source.stopReason !== '' ? source.stopReason : null,
    durationMs: Number.isFinite(source.durationMs) ? Math.max(0, Math.round(source.durationMs)) : 0,
    taskPreview: previewOf(source.taskPreview ?? source.task),
    resultPreview: previewOf(source.resultPreview ?? source.result),
  }
}

/**
 * 创建委派记录读写器。
 *
 * @param {object} [options] - 选项。
 * @param {string} [options.filePath] - `delegations.jsonl` 的绝对路径；缺失时所有写都返回失败、读返回空数组。
 * @param {{ warn?: Function }} [options.logger] - 日志器（只用到 `warn`）。
 * @param {number} [options.keep] - 保留行数（默认 200）；非法值回退默认。
 * @returns {{
 *   append: (record: object) => Promise<{ ok: boolean }>,
 *   recent: (limit?: number) => Promise<object[]>,
 *   dispose: () => Promise<void>
 * }} 记录读写器。
 */
export function createDelegationLog({ filePath, logger, keep } = {}) {
  const target = typeof filePath === 'string' && filePath !== '' ? filePath : ''
  const keepLines = Number.isInteger(keep) && keep > 0 ? keep : DEFAULT_KEEP
  const log = logger ?? {}
  let warnedBadLine = false

  /** 记一条告警；日志器本身抛错也忽略（日志失败不能反过来影响业务）。 */
  function warn(message, detail) {
    try {
      log.warn?.(`supermemory: delegations ${message}: %o`, detail)
    } catch {
      /* 日志失败忽略 */
    }
  }

  /** 把任务排到该路径的串行队列尾部；任务自身不抛（异常已在内部收敛）。 */
  function enqueue(task) {
    const key = target === '' ? '' : target
    const previous = queues.get(key) ?? Promise.resolve()
    const run = previous.then(task, task)
    const settled = run.then(() => undefined, () => undefined)
    queues.set(key, settled)
    void settled.then(() => queues.get(key) === settled && queues.delete(key))
    return run
  }

  /** 当前实例路径的队列尾（dispose 用；路径为空时是已完成的 promise）。 */
  function queueTail() {
    return queues.get(target) ?? Promise.resolve()
  }

  /**
   * 原子重写整个文件：同目录临时文件 + rename。
   *
   * @param {string[]} lines - 要保留的行（不含行尾换行）。
   * @returns {Promise<boolean>} 是否写入成功。
   */
  async function rewrite(lines) {
    const directory = dirname(target)
    const temporary = join(directory, `.${basename(target)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
    try {
      await mkdir(directory, { recursive: true })
      await writeFile(temporary, `${lines.join('\n')}\n`, 'utf8')
      await rename(temporary, target)
      return true
    } catch (error) {
      try {
        await unlink(temporary)
      } catch {
        /* 临时文件可能还没创建 */
      }
      warn('rewrite failed', error)
      return false
    }
  }

  /** 读全部行；缺失或读失败返回 undefined（读失败已 warn）。 */
  async function readLines() {
    try {
      return (await readFile(target, 'utf8')).split('\n')
    } catch (error) {
      if (error?.code !== 'ENOENT') warn('read failed', error)
      return undefined
    }
  }

  /** 追加一行，并在超出保留行数时裁剪。 */
  async function doAppend(record) {
    if (target === '') return { ok: false }
    let line
    try {
      line = JSON.stringify(normalizeRecord(record))
    } catch (error) {
      // 记录里出现循环引用等不可序列化值：记一条告警，不写盘。
      warn('serialize failed', error)
      return { ok: false }
    }
    try {
      await mkdir(dirname(target), { recursive: true })
      await appendFile(target, `${line}\n`, 'utf8')
    } catch (error) {
      warn('append failed', error)
      return { ok: false }
    }
    const lines = await readLines()
    if (lines === undefined) return { ok: true }
    const rows = lines.filter((item) => item.trim() !== '')
    if (rows.length > keepLines) await rewrite(rows.slice(-keepLines))
    return { ok: true }
  }

  /** 读最近 `count` 条，倒序（最新在前）；坏行跳过。 */
  async function doRecent(count) {
    if (target === '') return []
    const lines = await readLines()
    if (lines === undefined) return []
    const records = []
    for (const line of lines) {
      if (line.trim() === '') continue
      let parsed
      try {
        parsed = JSON.parse(line)
      } catch {
        // 坏行只告警一次：文件损坏时每次刷新都刷一条日志会把真正的问题埋掉。
        if (!warnedBadLine) {
          warnedBadLine = true
          warn('skipped malformed line', line.slice(0, 80))
        }
        continue
      }
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) records.push(parsed)
    }
    return records.slice(-count).reverse()
  }

  /**
   * 追加一条记录；失败只告警并返回 `{ ok:false }`，绝不抛。
   *
   * @param {object} record - 委派记录（原始文本即可，预览截断由本模块负责）。
   * @returns {Promise<{ ok: boolean }>} 是否写入成功。
   */
  function append(record) {
    return enqueue(() => doAppend(record)).then(
      (value) => value,
      (error) => {
        warn('append failed', error)
        return { ok: false }
      },
    )
  }

  /**
   * 读最近 `limit` 条记录，倒序（最新在前）；任何异常返回空数组。
   *
   * @param {number} [limit] - 条数（默认 50）；非法值回退默认。
   * @returns {Promise<object[]>} 记录数组（最新在前）。
   */
  function recent(limit = DEFAULT_RECENT) {
    const count = Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_RECENT
    return enqueue(() => doRecent(count)).then(
      (value) => value,
      (error) => {
        warn('read failed', error)
        return []
      },
    )
  }

  /** 等待该路径上所有在途写完成（含别的实例排的）；不抛。 */
  async function dispose() {
    try {
      await queueTail()
    } catch {
      /* 写任务自己吞错 */
    }
  }

  return { append, recent, dispose }
}
