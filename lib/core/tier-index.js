/**
 * 主题目录的生成（契约 §V8.4 目录段 + §V8.15 第 11 条）。
 *
 * 目录要回答的是「被折叠掉的那些条目里有什么、该用什么词去搜」。两类折叠信息价值差得很远，
 * 所以呈现方式**必须分开**：
 *
 * - **常驻层挤出（overflow）**：本该常驻、只是被预算挤掉的，信息价值最高 → **逐条给首句摘要**。
 *   预算装不下全部时才退化成计数，并在标题行如实说明列了几条。
 * - **冷层（cold）**：主动归档的，量大 → 按主题聚合成一行计数，逐条列会淹掉目录。
 *
 * 只报「未归类（4条）」这种零信息行是净损失：模型既不知道折叠了什么，也不知道该搜什么词。
 * 因此未归类主题的命名必须自解释，并在行内给出可检索提示。
 *
 * @module dsh-supermemory/core/tier-index
 */

import { byteLength } from './document.js'
import { asText, entryTime, escapeFrame, normalizeBudget } from './render-common.js'

/** 目录小标题。层级用 `###`：project 段标题是 `##`，目录是它的子级。 */
export const INDEX_HEADING = '### 主题目录'

/** 挤出组的组名。 */
export const OVERFLOW_GROUP = '常驻层挤出'

/** 没写 `topic` 的条目在目录里的归组名——必须自解释，「未分类」这种词等于没说话。 */
export const UNTOPICIZED = '未归类主题'

/** 挤出组标题行的检索提示（§V8.4 算法第 5 步那条固定提示行的组内回声）。 */
const OVERFLOW_HINT = '本轮被预算挤出，用 memory 工具检索取回'

/** 未归类主题行末尾的可检索提示。 */
const UNTOPICIZED_HINT = '条目未标主题名，按关键词检索'

/** 摘要兜底（取条目首句）的最长码点数。 */
const SUMMARY_MAX = 80

/**
 * 句末标记：中文标点与半角 `!?;` 直接算，**英文 `.` 只在后跟空白或行尾时才算**——
 * 否则 `workspaceRegistry.js`、`docs/CONTRACT.md`、`v8.2` 这类路径与版本号会把摘要
 * 拦腰切一刀，目录里留下一行看着像被截断的半句话。
 */
const SENTENCE_END = /[。！？；;!?]|\.(?=\s|$)/u

/**
 * 取正文首句做摘要（主题表没这个主题、或逐条列挤出条目时用）。
 * @param {unknown} body - 条目正文。
 * @returns {string} 首句，最长 80 码点。
 */
export function firstSentence(body) {
  const oneLine = asText(body).replace(/\s+/gu, ' ').trim()
  if (oneLine === '') return ''
  const cut = oneLine.search(SENTENCE_END)
  const head = cut > 0 ? oneLine.slice(0, cut + 1) : oneLine
  return [...head].slice(0, SUMMARY_MAX).join('')
}

/**
 * 条目在目录里挂的名字：没写主题就归到自解释的「未归类主题」。
 * @param {{ topic?: unknown }} entry - 条目。
 * @returns {string} 组名。
 */
function groupOf(entry) {
  return asText(entry?.topic) === '' ? UNTOPICIZED : asText(entry?.topic)
}

/**
 * 冷层条目按主题聚合成计数行。
 *
 * 一致性栅栏（§V8.3）：目录**以条目上实际写的 `topic` 为准**，主题表只提供摘要与别名；
 * 表里没有的主题用该组最新条目的首句兜底；表里有但没条目用的主题根本不出现。
 *
 * @param {Array<object>} coldEntries - 冷层条目。
 * @param {Map<string, { summary: string, aliases: string[] }>} table - 主题表。
 * @returns {Array<{ name: string, count: number, summary: string, aliases: string[], inTable: boolean }>} 目录项。
 */
export function collectTopicRows(coldEntries, table) {
  const groups = new Map()
  for (const entry of Array.isArray(coldEntries) ? coldEntries : []) {
    const name = groupOf(entry)
    const group = groups.get(name) ?? { name, count: 0, newest: null }
    group.count += 1
    if (group.newest === null || entryTime(entry) > entryTime(group.newest)) group.newest = entry
    groups.set(name, group)
  }
  const out = []
  for (const group of groups.values()) {
    const known = table?.get(group.name)
    const untopiced = group.name === UNTOPICIZED
    out.push({
      name: group.name,
      count: group.count,
      summary: known === undefined || known.summary === '' ? firstSentence(group.newest?.body) : known.summary,
      aliases: untopiced ? [UNTOPICIZED_HINT] : known === undefined ? [] : known.aliases.slice(),
      inTable: known !== undefined,
    })
  }
  // 条目多的主题排前面，同数按名字字典序——保证同样输入永远同样输出。
  return out.sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/**
 * 被挤出的 core 条目逐条成行（§V8.15 第 11 条：不许只报条数）。
 * 顺序沿用 core 的取舍顺序（热度降序），最该常驻的先露面。
 *
 * @param {Array<object>} overflowEntries - 被预算挤出的 core 条目。
 * @returns {Array<{ topic: string, summary: string }>} 逐条行。
 */
export function collectOverflowRows(overflowEntries) {
  return (Array.isArray(overflowEntries) ? overflowEntries : []).map((entry) => ({
    topic: groupOf(entry),
    summary: firstSentence(entry?.body),
  }))
}

/**
 * 一行主题计数：`- 主题（N条）：摘要 → 别名`。摘要或别名缺失时对应部分不出现。
 * @param {{ name: string, count: number, summary: string, aliases: string[] }} topic - 目录项。
 * @returns {string} 一行文本。
 */
function renderTopicLine(topic) {
  const base = `- ${escapeFrame(topic.name)}（${topic.count}条）`
  const summary = asText(topic.summary).trim()
  if (summary === '') return base
  const aliases = (Array.isArray(topic.aliases) ? topic.aliases : [])
    .map((alias) => asText(alias).trim())
    .filter((alias) => alias !== '')
  const tail = aliases.length === 0 ? '' : ` → ${escapeFrame(aliases.join(', '))}`
  return `${base}：${escapeFrame(summary)}${tail}`
}

/**
 * 一行挤出条目：`  - 主题：首句摘要`。缩进两空格，与条目正文的缩进口径一致。
 *
 * 未归类的条目**不重复组名**：真实记忆里常有整片没人打主题的条目，四行开头全是
 * 「未归类主题：」既不说明内容也白占预算，这时直接给摘要才读得下去。
 *
 * @param {{ topic: string, summary: string }} row - 逐条行。
 * @returns {string} 一行文本。
 */
function renderOverflowLine(row) {
  const summary = asText(row.summary).trim()
  const body = summary === '' ? '（正文为空）' : escapeFrame(summary)
  return asText(row.topic) === UNTOPICIZED ? `  - ${body}` : `  - ${escapeFrame(row.topic)}：${body}`
}

/**
 * 挤出组标题行。`shown === total` 最简短；`shown === 0` 与部分列出更啰嗦。
 * @param {number} total - 挤出条目总数。
 * @param {number} shown - 实际逐条列出的条数。
 * @returns {string} 一行文本。
 */
function overflowHeader(total, shown) {
  if (shown >= total) return `- ${OVERFLOW_GROUP}（${total}条）：${OVERFLOW_HINT}`
  if (shown === 0) return `- ${OVERFLOW_GROUP}（${total}条）：未逐条列出，${OVERFLOW_HINT}`
  return `- ${OVERFLOW_GROUP}（${total}条，列出 ${shown} 条）：其余 ${total - shown} 条${OVERFLOW_HINT}`
}

/**
 * 挤出组标题的最短写法：预算紧到放不下完整说明时，至少让「有 N 条被挤出」这件事在场。
 * @param {number} total - 挤出条目总数。
 * @returns {string} 一行文本。
 */
function overflowHeaderMin(total) {
  return `- ${OVERFLOW_GROUP}（${total}条）：用 memory 检索`
}

/**
 * 组装目录段并按预算取舍。
 *
 * 取舍优先级（§V8.15）：**挤出组 > 冷层主题行**——前者是「本该常驻却被挤掉」的信息，
 * 后者是本来就不打算常驻的归档条目。两类都在预算里放不下时，先砍冷层主题行的尾部，
 * 再让挤出组退化成计数行；`maxTopics` 与 `listOverflow` 供快照降级逐步收紧。
 *
 * @param {{ overflow?: unknown, cold?: unknown, table?: unknown, indexMaxBytes?: unknown,
 *   maxTopics?: unknown, listOverflow?: unknown }} input - 目录输入。
 * @returns {{ text: string, topics: Array<object>, overflowRows: Array<object>, overflowTotal: number }}
 *   目录文本（空目录为 ''）、留下的主题行、实际列出的挤出条目、挤出总数。
 */
export function buildIndex(input = {}) {
  const limit = normalizeBudget(input.indexMaxBytes)
  const table = input.table instanceof Map ? input.table : new Map()
  const overflow = Array.isArray(input.overflow) ? input.overflow : []
  const maxTopics = Number.isFinite(input.maxTopics) ? Math.max(0, Math.floor(input.maxTopics)) : Number.POSITIVE_INFINITY
  const listOverflow = input.listOverflow !== false

  const lines = [INDEX_HEADING]
  /**
   * 试加若干行是否仍在预算内。
   * @param {string[]} extra - 待加入的行。
   * @returns {boolean} 是否放得下。
   */
  const fits = (extra) => byteLength(lines.concat(extra).join('\n')) <= limit

  // 第一优先：挤出组。标题行按信息量从高到低逐级试，取第一个放得下的——被挤出的 core 比
  // 冷层归档更该占这份预算，所以宁可省掉说明文案，也不能让整组消失、把预算让给冷层主题行。
  const rows = listOverflow ? collectOverflowRows(overflow) : []
  let shown = 0
  if (overflow.length > 0) {
    const header = [
      overflowHeader(overflow.length, rows.length),
      overflowHeader(overflow.length, 0),
      overflowHeaderMin(overflow.length),
    ].find((line) => fits([line]))
    if (header !== undefined) {
      lines.push(header)
      while (shown < rows.length && fits([renderOverflowLine(rows[shown])])) {
        lines.push(renderOverflowLine(rows[shown]))
        shown += 1
      }
      if (shown !== 0 && shown !== rows.length) {
        // 报准条数比文案完整更要紧：放不下准确文案就退回最短写法，
        // 绝不留下一行与实际列出条数不符的措辞。
        const accurate = overflowHeader(overflow.length, shown)
        lines[1] = fits([accurate]) ? accurate : overflowHeaderMin(overflow.length)
      }
    }
  }
  const shownRows = rows.slice(0, shown)

  // 第二优先：冷层主题行，一行一行加，放不下或到 maxTopics 就停。
  const topics = []
  for (const topic of collectTopicRows(input.cold, table)) {
    if (topics.length >= maxTopics) break
    if (!fits([renderTopicLine(topic)])) break
    lines.push(renderTopicLine(topic))
    topics.push(topic)
  }

  return {
    text: lines.length <= 1 ? '' : lines.join('\n'),
    topics,
    overflowRows: shownRows,
    overflowTotal: overflow.length,
  }
}
