/**
 * 主题索引围栏（契约 §V8.3）：解析 / 生成 / 就地插入替换，纯函数、无 IO、无宿主依赖。
 *
 * 主题级的摘要与别名**不另开文件**，而是存在 project 记忆文档的 preamble 里，用一对受控
 * HTML 注释围栏承载：
 *
 * ```md
 * # 项目记忆
 *
 * <!-- 由 dsh-supermemory 维护；可直接编辑。 -->
 *
 * <!-- supermemory:topics:start -->
 * - 注入机制 · 快照如何落盘与压缩补偿 · aliases: snapshot, inject, 快照
 * - 整编模式 · consolidate 的栅栏与对账 · aliases: consolidate, 合并
 * <!-- supermemory:topics:end -->
 *
 * ## 条目
 * ```
 *
 * 为什么放 preamble：`rebuildDocument` 保证**第一个条目头之前的 preamble 逐字保留**，
 * 条目区整体重写——这是现成的安全边界，不新增文件也就不新增故障点，`memory read project`
 * 顺带可见。
 *
 * **必须点明的坑**：`inject.js` 的 `docBody` 会 `stripComments`，主题围栏在注入前就被剥掉了。
 * 这是**正确的**——目录由渲染层（`render.js` 的 `buildProjectSection`）生成，不让原文透传，
 * 否则主题表会在快照里出现两遍。所以渲染层解析主题必须拿**原始文档文本**，不能拿 `docBody`
 * 之后的正文。
 *
 * 一行三种字段，用与条目头同一个分隔符 ` · ` 连接：`- 主题名 · 摘要 · aliases: a, b`。
 * 摘要或别名里出现的 `·` 在解析时会并回前一段，往返不丢内容。
 *
 * @module dsh-supermemory/core/topics
 */

import { isEntryHead, normalizeTopic } from './document.js'

/** 围栏起止行原文（比对时忽略首尾空白）。 */
const FENCE_START = '<!-- supermemory:topics:start -->'
const FENCE_END = '<!-- supermemory:topics:end -->'

/** 字段分隔符：与条目头一致的中点。 */
const SEPARATOR = ' · '

/** 别名段的引导词，兼容中英文冒号。 */
const ALIAS_PREFIX = /^aliases\s*[:：]\s*/iu

/** 别名切分时认的分隔符：英文逗号与中文逗号。 */
const ALIAS_SPLIT = /[,，]/u

/**
 * 任意值转字符串（null/undefined → 空串）。
 * @param {unknown} value - 任意值。
 * @returns {string} 字符串。
 */
function asText(value) {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  return String(value)
}

/**
 * 压成单行：折叠所有空白为单个空格。摘要必须是「每主题一行」里的一个字段。
 * @param {unknown} value - 任意值。
 * @returns {string} 单行文本。
 */
function toOneLine(value) {
  return asText(value).replace(/\s+/gu, ' ').trim()
}

/**
 * 规范化别名列表：接受数组或以逗号分隔的字符串，逐项 trim、去空、去重。
 * @param {unknown} value - `string[]` 或以逗号分隔的 `string`。
 * @returns {string[]} 别名数组（可能为空）。
 */
function normalizeAliases(value) {
  const raw = Array.isArray(value) ? value : asText(value).split(ALIAS_SPLIT)
  const out = []
  for (const item of raw) {
    const alias = toOneLine(item)
    if (alias !== '' && !out.includes(alias)) out.push(alias)
  }
  return out
}

/**
 * 把一条主题渲染成围栏内的一行。
 * @param {{ name?: unknown, summary?: unknown, aliases?: unknown }} topic - 主题。
 * @returns {string} `- 名 · 摘要 · aliases: a, b`；主题名不合法时返回 ''（调用方丢弃）。
 */
function renderTopicLine(topic) {
  const name = normalizeTopic(asText(topic?.name ?? topic?.topic))
  if (name === '') return ''
  const parts = [name]
  const summary = toOneLine(topic?.summary)
  if (summary !== '') parts.push(summary)
  const aliases = normalizeAliases(topic?.aliases)
  if (aliases.length > 0) parts.push(`aliases: ${aliases.join(', ')}`)
  return `- ${parts.join(SEPARATOR)}`
}

/**
 * 解析围栏内的一行。
 * @param {unknown} line - 围栏内的原始行。
 * @returns {{ name: string, summary: string, aliases: string[] } | null} 解析结果；畸形行返回 null。
 */
function parseTopicLine(line) {
  if (typeof line !== 'string') return null
  const text = line.trim()
  if (!text.startsWith('-') || isEntryHead(line)) return null
  const body = text.slice(1).trim()
  if (body === '') return null

  const segments = body.split('·').map((part) => part.trim())
  let aliases = []
  // 别名段只可能是最后一段：先摘掉它，剩下的第一段是主题名、其余并回摘要。
  if (segments.length > 1 && ALIAS_PREFIX.test(segments[segments.length - 1])) {
    aliases = normalizeAliases(segments[segments.length - 1].replace(ALIAS_PREFIX, ''))
    segments.pop()
  }
  const name = normalizeTopic(segments.shift())
  if (name === '') return null
  return { name, summary: toOneLine(segments.join(SEPARATOR)), aliases }
}

/**
 * 在行数组里定位成对出现的围栏。
 * @param {string[]} lines - 文档的行。
 * @returns {{ start: number, end: number } | null} 起止下标；缺失或不成对返回 null。
 */
function locateFence(lines) {
  let start = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() !== FENCE_START) continue
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j].trim() === FENCE_END) return { start: i, end: j }
    }
    // 只有 start 没有 end（或用户手删了一半）→ 当没有围栏，绝不去猜结尾在哪。
    return null
  }
  return null
}

/**
 * 去掉行数组尾部全部空行，并补回一个结尾空元素（使 join 后以 `\n` 结尾）。
 * @param {string[]} lines - 行数组（就地不改，返回副本）。
 * @returns {string[]} 新行数组。
 */
function trimEndLines(lines) {
  const out = lines.slice()
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop()
  out.push('')
  return out
}

/**
 * 解析文档里的主题索引。
 *
 * 围栏缺失、不成对、或只有一个 start → 返回 `[]`（用户手删围栏是允许的操作，下次整编会补回）。
 * 单行畸形只丢那一行，不影响其余行。
 *
 * @param {unknown} text - 文档**原始**文本（含注释，不是 `docBody` 之后的正文）。
 * @returns {Array<{ name: string, summary: string, aliases: string[] }>} 主题数组，按出现顺序。
 */
export function parseTopicIndex(text) {
  if (typeof text !== 'string' || text === '') return []
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const fence = locateFence(lines)
  if (fence === null) return []
  const out = []
  for (let i = fence.start + 1; i < fence.end; i += 1) {
    const topic = parseTopicLine(lines[i])
    if (topic !== null) out.push(topic)
  }
  return out
}

/**
 * 渲染含围栏的主题索引文本块（不含尾随换行）。
 * @param {Array<{ name?: unknown, summary?: unknown, aliases?: unknown }>} topics - 主题数组。
 * @returns {string} 围栏文本块；`topics` 为空或全部非法时返回 ''。
 */
export function renderTopicIndex(topics) {
  const list = Array.isArray(topics) ? topics : []
  const lines = list.map((topic) => renderTopicLine(topic)).filter((line) => line !== '')
  if (lines.length === 0) return ''
  return [FENCE_START, ...lines, FENCE_END].join('\n')
}

/**
 * 就地更新文档里的主题围栏，返回新文本。
 *
 * - 围栏存在 → 只换围栏内的行，围栏行与 preamble 其余内容一字不动。
 * - 围栏不存在 → 插到**第一个条目头之前**（无条目头则追加到末尾），前后各留一个空行。
 * - `topics` 为空 → 删除围栏，并顺手收掉围栏自带的那个空行，不给 preamble 留双空行。
 *
 * @param {unknown} text - 文档原始文本。
 * @param {Array<{ name?: unknown, summary?: unknown, aliases?: unknown }>} topics - 目标态主题。
 * @returns {string} 新文本。
 */
export function upsertTopicIndex(text, topics) {
  const base = typeof text === 'string' ? text.replace(/\r\n?/g, '\n') : ''
  const lines = base.split('\n')
  const fence = locateFence(lines)
  const block = renderTopicIndex(topics)

  // 删除分支：没有围栏就原样返回，有围栏则连同它造成的多余空行一起收掉。
  if (block === '') {
    if (fence === null) return base
    const out = lines.slice(0, fence.start).concat(lines.slice(fence.end + 1))
    if (fence.start >= out.length) return trimEndLines(out).join('\n')
    const prevBlank = fence.start > 0 && out[fence.start - 1].trim() === ''
    const curBlank = out[fence.start].trim() === ''
    if ((prevBlank && curBlank) || (fence.start === 0 && curBlank)) out.splice(fence.start, 1)
    return out.join('\n')
  }

  const blockLines = block.split('\n')

  // 替换分支：只动围栏内部——起止行整体交给 block 重写，所以两侧的围栏行都要跳过，
  // 留着任何一侧都会和新写的那一行叠成两个围栏。
  if (fence !== null) {
    return lines.slice(0, fence.start).concat(blockLines, lines.slice(fence.end + 1)).join('\n')
  }

  // 插入分支：落在第一个条目头之前，preamble 其余内容保持原样。
  let headIndex = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (isEntryHead(lines[i])) {
      headIndex = i
      break
    }
  }
  if (headIndex === -1) {
    const head = trimEndLines(lines)
    const body = head.length <= 1 ? blockLines : [...head.slice(0, -1), '', ...blockLines]
    return `${body.join('\n')}\n`
  }
  const preamble = trimEndLines(lines.slice(0, headIndex))
  const rest = lines.slice(headIndex)
  const prefix = preamble.length <= 1 ? [] : preamble.slice(0, -1).concat([''])
  return [...prefix, ...blockLines, '', ...rest].join('\n')
}
