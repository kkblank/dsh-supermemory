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
 * - 2026-11-10T10:00:00.000Z · source:user-request
 *   内容第一行
 *   内容第二行
 * ```
 *
 * @module dsh-supermemory/core/document
 */

/** 条目头行的正则：`- <time> · source:<source>`。 */
const ENTRY_HEAD = /^-\s+(\S+)\s+·\s+source:\s*(\S*)\s*$/

/** 一级标题正则（不能匹配 `## `）。 */
const TITLE_LINE = /^#\s+(.+?)\s*$/

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
 * @param {unknown} text - 文档文本。
 * @returns {Array<{ time: string, source: string, body: string }>} 条目数组（可能为空）。
 */
export function parseEntries(text) {
  if (typeof text !== 'string' || text === '') return []
  const lines = text.replace(/\r\n?/g, '\n').split('\n')

  const entries = []
  let current = null

  const flush = () => {
    if (current === null) return
    const body = current.lines.join('\n').trim()
    entries.push({ time: current.time, source: current.source, body })
    current = null
  }

  for (const line of lines) {
    const match = ENTRY_HEAD.exec(line)
    if (match !== null) {
      flush()
      current = { time: match[1], source: match[2], lines: [] }
      continue
    }
    if (current === null) continue
    // 去掉条目体的一层缩进（两个空格或一个 tab），保留其余空白。
    current.lines.push(line.replace(/^(?: {2}|\t)/, ''))
  }
  flush()

  return entries
}

/**
 * 把条目渲染成 md 片段（不含前导空行）。
 *
 * @param {{ time?: unknown, source?: unknown, body?: unknown }} entry - 条目。
 * @returns {string} 段落文本；body 为空时只有头行。
 */
export function renderEntry(entry) {
  const time = typeof entry?.time === 'string' && entry.time !== '' ? entry.time : new Date().toISOString()
  const source = typeof entry?.source === 'string' ? entry.source : 'unknown'
  const rawBody = typeof entry?.body === 'string' ? entry.body : String(entry?.body ?? '')
  const body = rawBody.replace(/\r\n?/g, '\n').trim()

  const head = `- ${time} · source:${source}`
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
 * 字节数（UTF-8）。
 *
 * @param {unknown} text - 文本。
 * @returns {number} 字节数；非字符串返回 0。
 */
export function byteLength(text) {
  if (typeof text !== 'string') return 0
  return Buffer.byteLength(text, 'utf8')
}
