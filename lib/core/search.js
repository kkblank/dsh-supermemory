/**
 * 检索层的**纯函数**：查询分词与按行打分。不碰磁盘、不碰宿主、不调模型。
 *
 * 为什么不是整串子串匹配：中文没有空格，要求「查询串一字不差连续出现」才命中，
 * 于是搜「虚拟环境」找不到写着「优先复用现成的 conda 虚拟环境」的条目。这里把查询
 * 切成词元，连续汉字额外补相邻二元组，「虚拟 / 拟环 / 环境」各自都能命中。
 *
 * 打分按**条目块**聚合而非逐行独立：本项目 md 格式（见 core/document.js）是一条
 * `- <time> · source:<source>` 头行 + 若干两空格缩进正文。一条记忆常把两三个关键词
 * 写在不同行，逐行算会让它散成一堆低分；按块聚合后整条都能浮上来，而只沾到单个
 * 二元组的噪音命中被最低块命中数刷掉。
 *
 * 刻意只做字面匹配：不做语义/embedding，不引入任何依赖。
 *
 * @module dsh-supermemory/core/search
 */

/** 查询词元总数上限：超长查询直接截断，避免打分被拖爆。 */
export const MAX_QUERY_TERMS = 64

/** 参与分词的查询文本长度上限（字符）。 */
const MAX_QUERY_CHARS = 2000

/** 命中行的展示长度上限（字符）。 */
const MAX_TEXT_CHARS = 400

/** 行角色权重，对应「标题 / 条目（头行或首行正文） / 普通正文」三档。 */
const WEIGHT_HEADING = 4
const WEIGHT_ENTRY = 2
const WEIGHT_BODY = 1

/** 多词元查询要求同一个条目块内至少命中几个词元，用于压掉二元组的单点误命中。 */
const MIN_BLOCK_HITS = 2

/** 条目头行：与 core/document.js 的 ENTRY_HEAD 同形，这里只认前缀不取字段。 */
const ENTRY_HEAD = /^-\s+\S+\s+·\s+source:/

/** 标题行：`#` 到 `######` 后跟空格。 */
const HEADING = /^#{1,6}\s/

/** 条目正文的一层缩进（两个空格或一个制表符）。 */
const INDENT = /^(?: {2}|\t)/

/** NFKC 归一并转小写：查询侧与文本侧同一套折叠，全角半角与大小写差异不影响命中。 */
function fold(text) {
  return String(text ?? '').normalize('NFKC').toLowerCase()
}

/**
 * 把查询切成打分用的词元。
 *
 * 规则：折叠后取 `[\p{L}\p{N}_-]+` 词元；连续汉字额外补相邻二元组；
 * 长度 <= 1 的词元丢弃（单字噪音太多）；总数截到 MAX_QUERY_TERMS。
 *
 * @param {unknown} query - 原始查询文本；非字符串视为非法输入。
 * @returns {string[]} 去重词元；纯符号、单字或非字符串查询返回空数组。
 */
export function queryTerms(query) {
  if (typeof query !== 'string') return []
  const value = fold(query).slice(0, MAX_QUERY_CHARS)
  const terms = new Set(value.match(/[\p{L}\p{N}_-]+/gu) ?? [])
  for (const run of value.match(/[\p{Script=Han}]+/gu) ?? []) {
    for (let i = 0; i + 1 < run.length; i += 1) terms.add(run.slice(i, i + 2))
  }
  return [...terms].filter((term) => term.length > 1).slice(0, MAX_QUERY_TERMS)
}

/**
 * 按 md 结构给每行贴上角色权重与所属条目块号。
 *
 * 块 0 是第一条条目头之前的前言（一级标题、维护注释、`## 条目`）；每遇到一个
 * 条目头行开一个新块，条目的缩进首行按「条目」档计、后续缩进行与散行按正文档。
 *
 * @param {unknown} content - 文档文本。
 * @returns {Array<{ line: number, text: string, folded: string, block: number, weight: number }>}
 *   行标注数组，`line` 从 1 起。
 */
function markLines(content) {
  const lines = String(content ?? '').replace(/\r\n?/g, '\n').split('\n')
  const marks = []
  let block = 0
  let leadTaken = true

  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index]
    let weight = WEIGHT_BODY

    if (ENTRY_HEAD.test(text)) {
      block += 1
      leadTaken = false
      weight = WEIGHT_ENTRY
    } else if (HEADING.test(text)) {
      weight = WEIGHT_HEADING
    } else if (!leadTaken && INDENT.test(text) && text.trim() !== '') {
      leadTaken = true
      weight = WEIGHT_ENTRY
    }

    marks.push({ line: index + 1, text, folded: fold(text), block, weight })
  }
  return marks
}

/** 该行自身命中的去重词元数。 */
function ownHits(foldedLine, terms) {
  let hits = 0
  for (const term of terms) {
    if (foldedLine.includes(term)) hits += 1
  }
  return hits
}

/** 截断与排序的公共收口：分数降序，同分按行号升序。 */
function rank(rows, limit) {
  const sorted = [...rows].sort((a, b) => b.score - a.score || a.line - b.line)
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : sorted.length
  return sorted.slice(0, cap)
}

/**
 * 用词元给一篇文档的命中行打分，按相关性降序返回。
 *
 * 分数 = 行角色权重 × 所在条目块命中的去重词元数。同一次查询词元总数固定，
 * 所以分数高即覆盖率高。只有自身含词元的行才会进结果，块命中数决定它排多远。
 *
 * @param {unknown} content - 文档文本。
 * @param {string[]} terms - queryTerms 的产出；空数组返回空结果。
 * @param {number} [limit] - 返回行上限，缺省不截断。
 * @returns {Array<{ line: number, text: string, score: number }>} 命中行（`line` 从 1 起）。
 */
export function scoredLines(content, terms, limit) {
  const list = (Array.isArray(terms) ? terms : []).filter((term) => typeof term === 'string' && term !== '')
  if (list.length === 0) return []

  const marks = markLines(content)

  // 块内命中的去重词元集合：块决定相关性，行决定它出不出现。
  const blockTerms = new Map()
  for (const mark of marks) {
    let seen = blockTerms.get(mark.block)
    if (seen === undefined) {
      seen = new Set()
      blockTerms.set(mark.block, seen)
    }
    for (const term of list) {
      if (mark.folded.includes(term)) seen.add(term)
    }
  }

  const floor = list.length >= 2 ? MIN_BLOCK_HITS : 1
  const rows = marks.flatMap((mark) => {
    if (ownHits(mark.folded, list) === 0) return []
    const aggregated = blockTerms.get(mark.block)?.size ?? 0
    if (aggregated < floor) return []
    return [{ line: mark.line, text: mark.text.trim().slice(0, MAX_TEXT_CHARS), score: mark.weight * aggregated }]
  })
  return rank(rows, limit)
}

/**
 * 整串子串匹配，供 queryTerms 切不出词元时兜底（单字、纯符号查询）。
 * 行为与升级前一致，保证「搜一个汉字」仍然可用；分数恒为 1，不参与加权。
 *
 * @param {unknown} content - 文档文本。
 * @param {unknown} needle - 查询原文（内部折叠，调用方无需预处理）。
 * @param {number} [limit] - 返回行上限，缺省不截断。
 * @returns {Array<{ line: number, text: string, score: number }>} 命中行（`line` 从 1 起）。
 */
export function literalLines(content, needle, limit) {
  const target = fold(needle)
  if (target === '') return []
  const lines = String(content ?? '').replace(/\r\n?/g, '\n').split('\n')
  const rows = []
  for (let index = 0; index < lines.length; index += 1) {
    if (!fold(lines[index]).includes(target)) continue
    rows.push({ line: index + 1, text: lines[index].trim().slice(0, MAX_TEXT_CHARS), score: 1 })
  }
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : rows.length
  return rows.slice(0, cap)
}
