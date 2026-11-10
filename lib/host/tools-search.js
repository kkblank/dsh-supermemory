/**
 * 检索目标枚举与命中定位（tools.js 与 inject.js 共用，契约 §V8.7 / §V8.9）。
 *
 * 单独成模块的理由：项目记忆从「一个文件」变成「一个目录的多篇 md」之后，
 * 「读哪些文档」「命中行属于哪条条目」「条目是什么层级」这三件事在检索（memory
 * search）与预取（pre-step）两条链路上都要用，留在任一边都会逼另一边复制粘贴。
 *
 * v8 要修的第一件事就是 `pitfalls.md` 查不到：检索此前只覆盖四个记忆文件，
 * 而最该被检索的踩坑记录恰好躺在项目目录里不可查（契约 §V8.6）。
 *
 * `tier` / `topic` 在 `parseEntries` 的产物上是**不可枚举**属性（与 `id` 同一套约定，
 * 见 core/document.js），所以这里全部按字段直读，任何 `{ ...entry }` 之前都要显式搬运。
 *
 * @module dsh-supermemory/host/tools-search
 */

import { dirname } from 'node:path'
import { readFile } from 'node:fs/promises'

import { isEntryHead, normalizeTier, normalizeTopic, parseEntries } from '../core/document.js'
import { safeJoin } from '../core/paths.js'
import { parseTopicIndex } from '../core/topics.js'
import { literalLines, scoredLines } from '../core/search.js'

/** 允许检索的文件后缀。`history/` 子目录由 store 的枚举负责排除。 */
const DOC_SUFFIX = '.md'

/** 默认最多读几篇项目文档（防目录里塞了上百个 md 时一次检索把 IO 打满）。 */
export const DEFAULT_MAX_DOCS = 40

/** 默认单篇检索体积上限（字节）：超过就跳过，宁可少查一篇也不拖慢整轮。 */
export const DEFAULT_MAX_DOC_BYTES = 512 * 1024

/**
 * 文件名白名单：必须是裸文件名（无路径分隔符）、以 `.md` 结尾、不是隐藏文件。
 *
 * 枚举来自 store，理论上是安全的；但拼路径之前再收一道，脏名字就永远拼不出
 * 越界路径（后面还有 `safeJoin` 兜底）。
 *
 * @param {unknown} name - 候选文件名。
 * @returns {boolean} 是否允许读。
 */
export function isProjectDocName(name) {
  if (typeof name !== 'string' || name === '') return false
  if (!name.endsWith(DOC_SUFFIX)) return false
  if (name.includes('/') || name.includes('\\')) return false
  if (name === DOC_SUFFIX || name.startsWith('.')) return false
  return true
}

/**
 * 读齐项目记忆的各篇 md。
 *
 * 「枚举哪些文件」由 store（`listProjectDocs`）决定，「怎么读」由调用方提供，
 * 本函数只做过滤、限额与容错：**任何一篇读失败都只是少一篇**，绝不抛。
 *
 * @param {object} options - 选项。
 * @param {Array<{ name?: unknown, bytes?: unknown }>} [options.docs] - `listProjectDocs` 的 docs。
 * @param {(name: string) => string | Promise<string>} options.readDoc - 按文件名读文本。
 * @param {number} [options.maxDocs] - 篇数上限。
 * @param {number} [options.maxBytesPerDoc] - 单篇字节上限。
 * @returns {Promise<Array<{ name: string, text: string }>>} 文档源（读失败的不在内）。
 */
export async function readProjectDocs(options = {}) {
  const list = Array.isArray(options.docs) ? options.docs : []
  const maxDocs = Number.isFinite(options.maxDocs) && options.maxDocs > 0
    ? Math.floor(options.maxDocs)
    : DEFAULT_MAX_DOCS
  const maxBytes = Number.isFinite(options.maxBytesPerDoc) && options.maxBytesPerDoc > 0
    ? Math.floor(options.maxBytesPerDoc)
    : DEFAULT_MAX_DOC_BYTES
  const readDoc = typeof options.readDoc === 'function' ? options.readDoc : null
  if (readDoc === null) return []

  const docs = []
  for (const item of list) {
    if (docs.length >= maxDocs) break
    const name = typeof item?.name === 'string' ? item.name : ''
    if (!isProjectDocName(name)) continue
    // 枚举自带的 bytes 只是提示，能用来提前跳过明显超标的巨型文件。
    if (Number.isFinite(item?.bytes) && item.bytes > maxBytes) continue
    let text = ''
    try {
      const value = await readDoc(name)
      text = typeof value === 'string' ? value : ''
    } catch {
      continue
    }
    if (text === '' || Buffer.byteLength(text, 'utf8') > maxBytes) continue
    docs.push({ name, text })
  }
  return docs
}

/**
 * 建「项目记忆全部 md」的读取器（检索与预取共用同一份，避免两条链路各读一套）。
 *
 * 「枚举哪些文件」归 store（`listProjectDocs` 负责排除 `history/`、稳定排序），
 * 「怎么读」由本函数收口：拼路径过 `safeJoin`，脏名字越不了界；任何一篇读失败
 * 都只是少一篇。**store 不支持枚举时退回只读主文件**——那是 v7 的行为，
 * 比整段检索失效好，且这条退回不吭声就是静默降级，所以留一条 warn。
 *
 * @param {object} options - 依赖。
 * @param {object} [options.store] - 存储层（用 `listProjectDocs` 与 `docPath`）。
 * @param {(path: string) => Promise<string>} [options.readFile] - 读文本。
 * @param {{ warn: Function }} [options.logger] - 日志；只在退回与枚举失败时吭声。
 * @param {string} [options.mainDocName] - 主记忆文件名，默认 `project-memory.md`。
 * @returns {(projectRoot: string) => Promise<Array<{ name: string, text: string }>>} 读取器。
 */
export function createProjectDocReader(options = {}) {
  const store = options.store ?? null
  const read = typeof options.readFile === 'function' ? options.readFile : readFile
  const mainDocName = typeof options.mainDocName === 'string' && options.mainDocName !== ''
    ? options.mainDocName
    : 'project-memory.md'
  const warned = new Set()
  /** 同一个原因只 warn 一次，避免每轮 pre-step 刷屏。 */
  const warnOnce = (key, message, error) => {
    if (warned.has(key)) return
    warned.add(key)
    try {
      if (error === undefined) options.logger?.warn?.(`supermemory: ${message}`)
      else options.logger?.warn?.(`supermemory: ${message}: %o`, error)
    } catch {
      /* 日志失败不再抛 */
    }
  }

  /** 主文件走 store 读（享受缓存与空模板），失败返回空数组。 */
  const readMainOnly = async (projectRoot) => {
    try {
      const doc = await store?.readDoc?.({ kind: 'project', projectRoot })
      const text = typeof doc?.content === 'string' ? doc.content : ''
      return text === '' ? [] : [{ name: mainDocName, text }]
    } catch {
      return []
    }
  }

  return async function readProjectDocsOf(projectRoot) {
    if (typeof projectRoot !== 'string' || projectRoot === '') return []
    if (typeof store?.listProjectDocs !== 'function') {
      warnOnce('no-list', 'store 没有 listProjectDocs，项目检索与预取只覆盖主记忆文件')
      return readMainOnly(projectRoot)
    }
    let directory = ''
    try {
      const path = store?.docPath?.({ kind: 'project', projectRoot })
      if (typeof path === 'string' && path !== '') directory = dirname(path)
    } catch {
      directory = ''
    }
    if (directory === '' || directory === '.') {
      warnOnce('no-dir', '算不出项目记忆目录，项目检索与预取只覆盖主记忆文件')
      return readMainOnly(projectRoot)
    }
    let listed
    try {
      listed = await store.listProjectDocs({ projectRoot })
    } catch (error) {
      warnOnce('list-threw', 'listProjectDocs 抛错，退回只读主记忆文件', error)
      return readMainOnly(projectRoot)
    }
    if (listed?.ok !== true || !Array.isArray(listed.docs)) {
      warnOnce('list-fail', 'listProjectDocs 未返回 ok，退回只读主记忆文件')
      return readMainOnly(projectRoot)
    }
    const docs = await readProjectDocs({
      docs: listed.docs,
      // safeJoin 抛错（脏名字）由 readProjectDocs 吞掉：少一篇而已，不影响其余检索。
      readDoc: async (name) => read(safeJoin(directory, name), 'utf8'),
    })
    // 枚举没给主文件时补上 store 读到的那一份：保证「检索与预取永远覆盖
    // project-memory.md」这条不被枚举实现拖累。
    if (!docs.some((doc) => doc.name === mainDocName)) {
      const extra = await readMainOnly(projectRoot)
      for (const doc of extra) docs.unshift(doc)
    }
    return docs
  }
}

/**
 * 建「行号 → 条目」定位器。
 *
 * `scoredLines` 返回的是**行**级命中，而 `tier` / `topic` 挂在**条目**上，两者要靠
 * 行号对上。条目头行号用与解析同一个 `isEntryHead` 扫出来，顺序与 `parseEntries`
 * 一致（同一个正则、同一份文本）；数量对不上时按较小值对齐，多出来的行按「不属于
 * 任何条目」处理——预设为「对不上」留出口，而不是假设它不会发生。
 *
 * @param {unknown} text - 文档文本。
 * @returns {{ entryAt: (line: number) => object | undefined, entries: object[] }} 定位器。
 */
export function entryLocator(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
  const entries = parseEntries(text)
  const heads = []
  for (let index = 0; index < lines.length; index += 1) {
    if (isEntryHead(lines[index])) heads.push(index + 1)
  }
  const usable = Math.min(heads.length, entries.length)
  const located = []
  for (let i = 0; i < usable; i += 1) {
    const entry = entries[i]
    located.push({
      line: heads[i],
      id: entry.id,
      tier: normalizeTier(entry.tier),
      topic: normalizeTopic(entry.topic),
      time: typeof entry.time === 'string' ? entry.time : '',
      body: typeof entry.body === 'string' ? entry.body : '',
    })
  }

  /** 二分找「最后一个头行号 <= line」；命中前言区返回 undefined。 */
  const entryAt = (line) => {
    if (!Number.isFinite(line) || located.length === 0) return undefined
    let low = 0
    let high = located.length - 1
    let found
    while (low <= high) {
      const mid = (low + high) >> 1
      if (located[mid].line <= line) {
        found = located[mid]
        low = mid + 1
      } else {
        high = mid - 1
      }
    }
    return found
  }
  return { entryAt, entries: located }
}

/**
 * 主题别名表：`主题名 → 别名字符串`。命中的词元可以来自别名而不必出现在正文里
 * （契约 §V8.0 决策 3：别名是「穷人版 embedding」，检索侧的唯一召回增强）。
 *
 * @param {unknown} text - 文档原文（含 preamble 的围栏）。
 * @returns {Map<string, string>} 主题名到拼接后的别名文本。
 */
function aliasByTopic(text) {
  const map = new Map()
  for (const topic of parseTopicIndex(text)) {
    const name = normalizeTopic(topic?.name)
    if (name === '') continue
    const aliases = (Array.isArray(topic?.aliases) ? topic.aliases : [])
      .filter((item) => typeof item === 'string' && item !== '')
      .join(' ')
    map.set(name, `${name} ${aliases}`)
  }
  return map
}

/**
 * 行级检索若干篇项目文档（`memory search` 用）。
 *
 * 命中项补上 `file` / `tier` / `topic`：命中落在前言区时 `tier` 给缺省 `core`、
 * `topic` 给空串，让 schema 的每个键都恒有值（漏键会被宿主判非法输出）。
 *
 * @param {Array<{ name: string, text: string }>} docs - 文档源。
 * @param {{ terms?: string[], needle?: string, limit?: number }} options - 检索参数。
 * @returns {Array<{ file: string, line: number, text: string, score: number, id: string, tier: string, topic: string }>}
 *   未排序的命中（排序与截断由调用方统一做）。
 */
export function searchProjectDocs(docs, options = {}) {
  const list = Array.isArray(docs) ? docs : []
  const terms = Array.isArray(options.terms) ? options.terms : []
  const limit = Number.isFinite(options.limit) ? options.limit : undefined
  const out = []
  for (const doc of list) {
    const text = typeof doc?.text === 'string' ? doc.text : ''
    if (text === '') continue
    const locator = entryLocator(text)
    const rows = terms.length === 0
      ? literalLines(text, options.needle, limit)
      : scoredLines(text, terms, limit)
    for (const row of rows) {
      const entry = locator.entryAt(row.line)
      out.push({
        file: typeof doc.name === 'string' ? doc.name : '',
        line: row.line,
        text: row.text,
        score: Number.isFinite(row.score) ? row.score : 0,
        id: typeof entry?.id === 'string' ? entry.id : '',
        tier: typeof entry?.tier === 'string' ? entry.tier : 'core',
        topic: typeof entry?.topic === 'string' ? entry.topic : '',
      })
    }
  }
  return out
}

/**
 * 条目级检索（动态预取用，契约 §V8.9）。
 *
 * 与行级检索的区别在于打分单位是一条条目而不是一个物理行：预取要注入的是
 * 「完整的一条记忆」，按行命中会把一条记忆切成半句。做法是给每条条目单独跑一遍
 * `scoredLines`（块内命中数的下限逻辑照旧生效），并把该条目所属主题的别名并进
 * 被匹配文本，让「正文没提但别名里有」的查询也能召回。
 *
 * @param {Array<{ name: string, text: string }>} docs - 文档源。
 * @param {{ terms?: string[], limit?: number }} options - 检索参数。
 * @returns {Array<{ file: string, id: string, tier: string, topic: string, time: string, text: string, score: number }>}
 *   按分数降序、同分按时间倒序。
 */
export function searchProjectEntries(docs, options = {}) {
  const list = Array.isArray(docs) ? docs : []
  const terms = Array.isArray(options.terms) ? options.terms : []
  if (terms.length === 0) return []
  const out = []
  for (const doc of list) {
    const text = typeof doc?.text === 'string' ? doc.text : ''
    if (text === '') continue
    const locator = entryLocator(text)
    const aliases = aliasByTopic(text)
    for (const entry of locator.entries) {
      const haystack = `${entry.body}\n${aliases.get(entry.topic) ?? ''}`
      const rows = scoredLines(haystack, terms, 1)
      if (rows.length === 0) continue
      out.push({
        file: typeof doc.name === 'string' ? doc.name : '',
        id: entry.id,
        tier: entry.tier,
        topic: entry.topic,
        time: entry.time,
        text: entry.body === '' ? entry.topic : entry.body,
        score: Number.isFinite(rows[0].score) ? rows[0].score : 0,
      })
    }
  }
  out.sort((a, b) => b.score - a.score || compareTimeDesc(a.time, b.time) || a.id.localeCompare(b.id))
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.floor(options.limit) : out.length
  return out.slice(0, limit)
}

/** 时间倒序比较器：新在前；无法解析的时间排到最后。 */
function compareTimeDesc(a, b) {
  const left = Date.parse(a)
  const right = Date.parse(b)
  const leftValue = Number.isFinite(left) ? left : 0
  const rightValue = Number.isFinite(right) ? right : 0
  return rightValue - leftValue
}

/**
 * 统计一篇（或几篇）项目文档的分层构成，供 `memory list` 与可观测使用。
 *
 * @param {Array<{ name: string, text: string }>} docs - 文档源。
 * @returns {{ core: number, cold: number, topics: string[], files: number }} 计数结果。
 */
export function countTiers(docs) {
  const list = Array.isArray(docs) ? docs : []
  const topics = new Set()
  let core = 0
  let cold = 0
  for (const doc of list) {
    const text = typeof doc?.text === 'string' ? doc.text : ''
    if (text === '') continue
    for (const entry of parseEntries(text)) {
      if (normalizeTier(entry.tier) === 'cold') cold += 1
      else core += 1
      const topic = normalizeTopic(entry.topic)
      if (topic !== '') topics.add(topic)
    }
  }
  return { core, cold, topics: [...topics], files: list.length }
}
