/**
 * 记忆文档（md）格式：空模板、标题、条目解析/渲染/追加。
 *
 * 统一格式见契约 §3.2：
 *
 * ```md
 * # 全局长期记忆
 *
 * <!-- 由 dsh-supermemory 维护；可直接编辑。 -->
 *
 * ## 条目
 *
 * - 2026-11-10T10:00:00.000Z · source:user-request · id:a3f2c
 *   内容第一行
 *   内容第二行
 * ```
 *
 * v4 起条目头允许第三段 `· id:<id>`（契约 §V4.0.1），**可选**，旧文件照读。
 * id 的意义：整编（consolidate）要让模型指着旧条目说「这几条合并成一条」，
 * 靠正文文本对不上，只能靠稳定 id。id 由 `sha1(time + '\n' + body)` 派生，
 * 因此同一份文本反复解析得到同一批 id；显式写盘的 id 优先于派生 id。
 *
 * **下游注意**：`parseEntries` 返回的 `id` 是**不可枚举**属性（理由见 `defineEntryId`）。
 * `entry.id` 照读无误，但 `{ ...entry }` 与 `JSON.stringify(entry)` 会静默丢掉它——
 * 要把条目对象连同 id 交给别人（写接口、发面板、塞进 JSON），必须显式带上 `id: entry.id`。
 *
 * @module dsh-supermemory/core/document
 */

import { createHash } from 'node:crypto'

/** 条目头行的正则：`- <time> · source:<source>`，第三段 `· id:<id>` 可选。 */
const ENTRY_HEAD = /^-\s+(\S+)\s+·\s+source:\s*(\S*)(?:\s+·\s+id:(\S+))?\s*$/

/** 一级标题正则（不能匹配 `## `）。 */
const TITLE_LINE = /^#\s+(.+?)\s*$/

/** id 的基础长度：sha1 hex 前 5 位。 */
const ID_BASE_LENGTH = 5

/** 允许写进文档的 id 最长位数；`renderEntry` 只输出 5–9 位的 id（契约 §V4.0.1）。 */
const ID_RENDER_MAX = 9

/**
 * 解析期 id 的最长位数。派生 id 与显式 id 相撞时逐位延长（5 → 7 → 9），
 * 9 位仍撞属于哈希前缀极小概率事故，继续延长到 15 位兜底——这类 id 超过
 * `ID_RENDER_MAX`，永远不会被写盘，只在单次解析的内存里用于区分条目。
 */
const ID_PARSE_MAX = 15

/** 合法 id 的形态：5–9 位十六进制小写。 */
const ENTRY_ID = new RegExp(`^[0-9a-f]{${ID_BASE_LENGTH},${ID_RENDER_MAX}}$`)

/**
 * 把任意字段转成参与 id 派生的字符串（null/undefined → 空串，其余走 String）。
 * @param value - 任意值。
 * @returns 字符串。
 */
function asField(value) {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  return String(value)
}

/**
 * 是否是可以写盘的合法 id。
 * @param value - 任意值。
 * @returns 是否为 5–9 位十六进制小写字符串。
 */
function isEntryId(value) {
  return typeof value === 'string' && ENTRY_ID.test(value)
}

/**
 * 给条目挂上 id。`id` 与 `explicitId` 都定义成**不可枚举**属性：
 *
 * - 既有调用方与既有测试把条目当 `{ time, source, body }` 逐字段比对
 *   （`test/paths-document.test.js` 里有 `assert.deepEqual(entry, { time, source, body })`），
 *   多一个可枚举字段会让 `assert.deepStrictEqual` 全线变红；要改成就得动那份测试，
 *   而它是 v1 就钉下的格式契约，不属于整编的改动范围。
 * - 写盘走 `renderEntry`、面板走 JSON 序列化，两者都不该顺手把解析期派生的
 *   id 带出去。派生 id 不落盘，靠的就是「不可枚举 + `explicitId` 标记」这一对。
 *
 * 属性本身照常可读：`entry.id` 直接拿到 id，`entry.explicitId` 表示该 id 是否
 * 来自原文的 `· id:` 段（即是否允许写盘）。代价是 `{ ...entry }` 与
 * `JSON.stringify(entry)` 会丢 id，需要显式搬运——详见模块头的下游注意。
 *
 * @param entry - 条目对象（就地改写并返回）。
 * @param id - 最终 id。
 * @param explicit - 是否来自原文的显式 id 段。
 * @returns 改写后的条目对象。
 */
function defineEntryId(entry, id, explicit) {
  const stamp = { value: id, enumerable: false, writable: true, configurable: true }
  Object.defineProperty(entry, 'id', stamp)
  Object.defineProperty(entry, 'explicitId', { ...stamp, value: explicit === true })
  return entry
}

/**
 * 给条目分配一个**文档内唯一**的派生 id：先取 5 位，与已占用的 id 相撞就逐位延长。
 *
 * @param entry - 待分配 id 的条目（就地改写）。
 * @param taken - 本文档内已被占用的 id 集合（会被追加）。
 * @returns 分配到的 id。
 */
function assignDerivedId(entry, taken) {
  const hex = createHash('sha1')
    .update(`${asField(entry.time)}\n${asField(entry.body)}`, 'utf8')
    .digest('hex')
  let id = hex.slice(0, ID_BASE_LENGTH)
  for (let size = ID_BASE_LENGTH + 2; size <= ID_PARSE_MAX && taken.has(id); size += 2) {
    id = hex.slice(0, size)
  }
  taken.add(id)
  defineEntryId(entry, id, false)
  return id
}

/**
 * 条目 id：`sha1(time + '\n' + body)` 的 hex 前 5 位（契约 §V4.0.1）。
 *
 * 纯函数、幂等：同一份文本多次解析得到同一批 id。正文被改写后 id 随之改变，
 * 所以它标识的是「这条内容的这一版本」，而不是可寻址的记录号。
 *
 * @param {unknown} time - 条目时间字段。
 * @param {unknown} body - 条目正文。
 * @returns {string} 5 位十六进制小写 id。
 */
export function deriveEntryId(time, body) {
  return createHash('sha1')
    .update(`${asField(time)}\n${asField(body)}`, 'utf8')
    .digest('hex')
    .slice(0, ID_BASE_LENGTH)
}

/**
 * 空文档模板。
 *
 * @param {unknown} title - 一级标题文本。
 * @returns {string} 以 `\n` 结尾的模板文本。
 */
export function emptyDocument(title) {
  const heading = typeof title === 'string' && title.trim() !== '' ? title.trim() : '长期记忆'
  return `# ${heading}\n\n<!-- 由 dsh-supermemory 维护；可直接编辑。 -->\n\n## 条目\n`
}

/**
 * 从文件文本取一级标题。
 *
 * @param {unknown} text - 文档文本。
 * @returns {string | undefined} 标题文本；没有则 undefined。
 */
export function documentTitle(text) {
  if (typeof text !== 'string') return undefined
  for (const line of text.split('\n')) {
    const match = TITLE_LINE.exec(line.trim())
    if (match !== null) {
      const title = match[1].trim()
      return title === '' ? undefined : title
    }
  }
  return undefined
}

/**
 * 把文本切成条目数组。
 *
 * 条目体是头行之后、下一个条目头之前的若干行；每行去掉一层两空格缩进后 `trim()`。
 *
 * id 的分配（契约 §V4.0.1）分两步：先收下所有**合法**的显式 id（不合法的 `id:` 段
 * 视同没写，退回派生），再给其余条目派生 id，撞车时逐位延长——所以显式 id 永远优先，
 * 且一份文档内 id 唯一。派生 id 不会因此被写盘（见 `defineEntryId`）。
 *
 * @param {unknown} text - 文档文本。
 * @returns {Array<{ time: string, source: string, body: string }>} 条目数组（可能为空）；
 *   每项附带不可枚举的 `id` 与 `explicitId`，`entry.id` 可读。
 */
export function parseEntries(text) {
  if (typeof text !== 'string' || text === '') return []
  const lines = text.replace(/\r\n?/g, '\n').split('\n')

  const entries = []
  let current = null

  const flush = () => {
    if (current === null) return
    const body = current.lines.join('\n').trim()
    // 显式 id 必须格式合法才认，否则宁可用派生 id，也不让脏数据挤进对账索引。
    const explicit = isEntryId(current.rawId) ? current.rawId : ''
    entries.push({ time: current.time, source: current.source, body, explicit })
    current = null
  }

  for (const line of lines) {
    const match = ENTRY_HEAD.exec(line)
    if (match !== null) {
      flush()
      current = { time: match[1], source: match[2], rawId: match[3], lines: [] }
      continue
    }
    if (current === null) continue
    // 去掉条目体的一层缩进（两个空格或一个 tab），保留其余空白。
    current.lines.push(line.replace(/^(?: {2}|\t)/, ''))
  }
  flush()

  // 第二遍：显式 id 先占位，派生 id 只能挑剩下的。
  const taken = new Set()
  for (const entry of entries) {
    if (entry.explicit !== '') taken.add(entry.explicit)
  }
  const claimed = new Set()
  for (const entry of entries) {
    const explicit = entry.explicit
    delete entry.explicit
    // 同一个显式 id 被手写重复时只有第一处作数，其余退回派生——
    // 「一份文档内 id 唯一」是整编对账的前提，不能留给脏数据破坏。
    if (explicit !== '' && !claimed.has(explicit)) {
      claimed.add(explicit)
      defineEntryId(entry, explicit, true)
    } else assignDerivedId(entry, taken)
  }

  return entries
}

/**
 * 把条目渲染成 md 片段（不含前导空行）。
 *
 * `entry.id` 合法时才输出 ` · id:<id>`；`entry.explicitId === false`（id 是本次解析
 * 派生出来的）时同样不输出——派生 id 不落盘，条目正文一旦被改写它就是错的。
 * 手工构造的 `{ id: 'a3f2c' }` 没有 `explicitId` 字段，按「调用方自己写的 id」处理，照常输出。
 *
 * @param {{ time?: unknown, source?: unknown, body?: unknown, id?: unknown }} entry - 条目。
 * @returns {string} 段落文本；body 为空时只有头行。
 */
export function renderEntry(entry) {
  const time = typeof entry?.time === 'string' && entry.time !== '' ? entry.time : new Date().toISOString()
  const source = typeof entry?.source === 'string' ? entry.source : 'unknown'
  const rawBody = typeof entry?.body === 'string' ? entry.body : String(entry?.body ?? '')
  const body = rawBody.replace(/\r\n?/g, '\n').trim()

  const id = isEntryId(entry?.id) && entry?.explicitId !== false ? ` · id:${entry.id}` : ''
  const head = `- ${time} · source:${source}${id}`
  if (body === '') return head
  const indented = body
    .split('\n')
    .map((line) => (line === '' ? '' : `  ${line}`))
    .join('\n')
  return `${head}\n${indented}`
}

/**
 * 追加若干条目，返回新文本（保持尾部换行）。
 *
 * `entries` 为空时原样返回（仅标准化为以 `\n` 结尾），保证往返幂等。
 *
 * @param {unknown} text - 现有文档文本。
 * @param {Array<{ time?: unknown, source?: unknown, body?: unknown }>} entries - 要追加的条目。
 * @returns {string} 新文本，以 `\n` 结尾。
 */
export function appendEntries(text, entries) {
  const base = typeof text === 'string' ? text.replace(/\r\n?/g, '\n') : ''
  const list = Array.isArray(entries) ? entries : []
  const fragment = list.map((entry) => renderEntry(entry)).join('\n\n')

  if (fragment === '') {
    if (base === '') return ''
    return base.endsWith('\n') ? base : `${base}\n`
  }

  const trimmed = base.replace(/\s+$/, '')
  if (trimmed === '') return `${fragment}\n`
  return `${trimmed}\n\n${fragment}\n`
}

/**
 * 整篇重建条目区：preamble 原样保留，条目全部换成 `entries` 重新渲染。
 *
 * 与 `appendEntries` 的区别是语义而非实现：追加是「加几条」，重建是「目标态就这份」。
 * 整编（consolidate）的产物会**整体替换**条目区，因此这是它唯一的落盘构造方式——
 * 不允许用字符串替换去改条目，那样一条正文里的 `- 2026…` 之类文本就能把改写带偏。
 *
 * preamble 是原文**第一个条目头之前**的全部内容（一级标题、维护注释、用户手写的
 * 说明段），逐字保留，只规范化掉尾部空白；原文没有条目头时整段都是 preamble，
 * 条目追加其后。`entries` 为空则只留 preamble——想清空条目请走这条，而不是删文件。
 *
 * @param {unknown} text - 现有文档文本。
 * @param {Array<{ time?: unknown, source?: unknown, body?: unknown, id?: unknown }>} entries - 目标态条目。
 * @returns {string} 新文本，以 `\n` 结尾（preamble 与条目都为空时返回空串）。
 */
export function rebuildDocument(text, entries) {
  const base = typeof text === 'string' ? text.replace(/\r\n?/g, '\n') : ''
  const lines = base.split('\n')

  let headIndex = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (ENTRY_HEAD.test(lines[i])) {
      headIndex = i
      break
    }
  }

  const preamble = (headIndex === -1 ? base : lines.slice(0, headIndex).join('\n')).replace(/\s+$/, '')
  const list = Array.isArray(entries) ? entries : []
  const fragment = list.map((entry) => renderEntry(entry)).join('\n\n')

  if (fragment === '') return preamble === '' ? '' : `${preamble}\n`
  if (preamble === '') return `${fragment}\n`
  return `${preamble}\n\n${fragment}\n`
}

/**
 * 字节数（UTF-8）。
 *
 * @param {unknown} text - 文本。
 * @returns {number} 字节数；非字符串返回 0。
 */
export function byteLength(text) {
  if (typeof text !== 'string') return 0
  return Buffer.byteLength(text, 'utf8')
}
