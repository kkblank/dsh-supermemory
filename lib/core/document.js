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
 * v8 起条目头最多五段（契约 §V8.2）：
 *
 * ```md
 * - 2026-11-10T10:00:00.000Z · source:user-request · id:a3f2c · tier:cold · topic:注入机制
 * ```
 *
 * 段顺序固定 `time · source: · id: · tier: · topic:`，**每段都可选；但没写 `id:` 就不许写
 * `tier:` / `topic:`**（写了 → 整行不认作条目头，退回正文，宁可丢一行也不错位解析）。
 * 有 `id:` 时 `tier:` 与 `topic:` 各自独立可选——`core` 条目带主题正是 `id + topic` 形态
 * （`core` 不写 tier 段），若要求逐段连续，这种行写下去就再也解析不回来了。
 * `tier` 合法值只有 `core` / `cold`，非法值视同没写，**缺省 = `core`**；
 * `topic` 取 1–24 字符、原样保留（含中文与空格），超长或空视同没写。
 * 三条不变量里最关键的一条：`tier` 只表达「这条该不该常驻」的**意图**，渲染期才做真正的
 * 取舍，写盘时 `core` 是缺省态**不输出该段**——否则存量文件全量重排会变成 diff 噪音。
 *
 * **下游注意**：`parseEntries` 返回的 `id` / `tier` / `topic` 及其 `explicit*` 标记都是
 * **不可枚举**属性（理由见 `defineEntryId`）。`entry.id` 照读无误，但 `{ ...entry }` 与
 * `JSON.stringify(entry)` 会静默丢掉它们——要把条目对象连同这些字段交给别人（写接口、
 * 发面板、塞进 JSON），必须显式带上 `id: entry.id`、`tier: entry.tier`、`topic: entry.topic`。
 *
 * **文件分工**：条目头正则、各段的规范化（`normalizeTier` / `normalizeTopic`）、id 派生与
 * 解析期字段的挂载在 `entry-format.js`；本模块只做文档级的读改写（解析、渲染、模板、追加、
 * 整篇重建）。那几个格式函数由本模块 re-export，`import … from './core/document.js'` 的
 * 路径保持不变，下游不需要知道拆分这件事。
 *
 * @module dsh-supermemory/core/document
 */

import { createHash } from 'node:crypto'

import {
  DEFAULT_TIER,
  ENTRY_TIERS,
  ID_BASE_LENGTH,
  ID_PARSE_MAX,
  asField,
  defineEntryId,
  defineEntryTier,
  deriveEntryId,
  execEntryHead,
  isEntryHead,
  isEntryId,
  normalizeTier,
  normalizeTopic,
} from './entry-format.js'

// 条目头格式的公开面留在本模块：`topics.js` / `render-tiered.js` / 各层测试一直从
// `document.js` import 这几个符号，实现在 `entry-format.js`，路径不许断。
export { deriveEntryId, isEntryHead, normalizeTier, normalizeTopic } from './entry-format.js'

/** 一级标题正则（不能匹配 `## `）。 */
const TITLE_LINE = /^#\s+(.+?)\s*$/

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
 *   每项附带不可枚举的 `id` / `explicitId` / `tier` / `explicitTier` / `topic` /
 *   `explicitTopic`，`entry.id`、`entry.tier`、`entry.topic` 照读无误。
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
    // tier / topic 与 id 同一套纪律：非法值与缺段都归一成「没写」（空串），
    // 到第二遍才补成缺省态，这样 explicitTier / explicitTopic 能区分「原文写过」与「我们补的」。
    const rawTier = asField(current.rawTier).trim().toLowerCase()
    entries.push({
      time: current.time,
      source: current.source,
      body,
      explicit,
      rawTier: ENTRY_TIERS.has(rawTier) ? rawTier : '',
      rawTopic: normalizeTopic(current.rawTopic),
    })
    current = null
  }

  for (const line of lines) {
    const match = execEntryHead(line)
    if (match !== null) {
      flush()
      const groups = match.groups
      current = {
        time: groups.time,
        source: groups.source,
        rawId: groups.id,
        rawTier: groups.tier,
        rawTopic: groups.topic,
        lines: [],
      }
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
    const rawTier = entry.rawTier
    const rawTopic = entry.rawTopic
    delete entry.explicit
    delete entry.rawTier
    delete entry.rawTopic
    // 同一个显式 id 被手写重复时只有第一处作数，其余退回派生——
    // 「一份文档内 id 唯一」是整编对账的前提，不能留给脏数据破坏。
    if (explicit !== '' && !claimed.has(explicit)) {
      claimed.add(explicit)
      defineEntryId(entry, explicit, true)
    } else assignDerivedId(entry, taken)
    defineEntryTier(entry, rawTier === '' ? DEFAULT_TIER : rawTier, rawTier !== '', rawTopic, rawTopic !== '')
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
 * v8 的两段写盘方向（契约 §V8.2，**方向别写反**）：
 *
 * - `tier === 'cold'` 才输出 ` · tier:cold`；`core` 是缺省态**不输出**——存量条目全是 core，
 *   全写一遍会把整篇变成 diff 噪音。`explicitTier === false`（我们补的缺省）同样不输出。
 * - `topic` 非空才输出，`explicitTopic === false` 不输出。
 * - 输出顺序恒为 `id` → `tier` → `topic`。
 * - **例外**：要输出 `tier` / `topic` 却没有可写的 id 时，补一个派生 id。缺了 id 而写后面的段
 *   会让整行不认作条目头（§V8.2），条目就会从解析结果里凭空消失；不写这两段的条目照旧不补 id。
 *
 * @param {{ time?: unknown, source?: unknown, body?: unknown, id?: unknown,
 *   explicitId?: unknown, tier?: unknown, explicitTier?: unknown, topic?: unknown,
 *   explicitTopic?: unknown }} entry - 条目。
 * @returns {string} 段落文本；body 为空时只有头行。
 */
export function renderEntry(entry) {
  const time = typeof entry?.time === 'string' && entry.time !== '' ? entry.time : new Date().toISOString()
  const source = typeof entry?.source === 'string' ? entry.source : 'unknown'
  const rawBody = typeof entry?.body === 'string' ? entry.body : String(entry?.body ?? '')
  const body = rawBody.replace(/\r\n?/g, '\n').trim()

  let id = isEntryId(entry?.id) && entry?.explicitId !== false ? ` · id:${entry.id}` : ''
  // 只有显式的 cold 才配写盘；core（含缺省与非法值回落）一律不写这一段。
  const tier = entry?.explicitTier !== false && normalizeTier(entry?.tier) === 'cold' ? ' · tier:cold' : ''
  const topic = entry?.explicitTopic === false ? '' : normalizeTopic(entry?.topic)
  const topicPart = topic === '' ? '' : ` · topic:${topic}`

  // 段顺序是硬规矩（§V8.2）：写了 tier / topic 却没写 id，整行就不认作条目头了。
  // 所以「要写后面两段却没有可写的 id」时，必须补一个派生 id——这不是嫌派生 id 难看，
  // 而是否则会把条目写成一行正文，整条记忆从解析结果里凭空消失。
  // （不写 tier / topic 的普通条目仍然一个 id 都不补，与 v4「派生 id 不落盘」完全一致。）
  if (id === '' && (tier !== '' || topicPart !== '')) id = ` · id:${deriveEntryId(time, body)}`

  const head = `- ${time} · source:${source}${id}${tier}${topicPart}`
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
 * @param {Array<{ time?: unknown, source?: unknown, body?: unknown, id?: unknown,
 *   tier?: unknown, topic?: unknown }>} entries - 目标态条目。`tier` / `topic` 经
 *   `renderEntry` 自动透传，**禁止改用字符串替换去动条目**（契约 §V8.2）：正文里一个
 *   `- 2026…` 开头的句子就能把基于文本的改写带偏。
 * @returns {string} 新文本，以 `\n` 结尾（preamble 与条目都为空时返回空串）。
 */
export function rebuildDocument(text, entries) {
  const base = typeof text === 'string' ? text.replace(/\r\n?/g, '\n') : ''
  const lines = base.split('\n')

  let headIndex = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (isEntryHead(lines[i])) {
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
