/**
 * 条目头的**格式层**（契约 §V4.0.1 + §V8.2）：一行条目头长什么样、各段怎么规范化、
 * 以及解析期字段怎么挂到条目对象上。文档级的读改写（`parseEntries` / `renderEntry` /
 * `rebuildDocument`）在 `document.js`，它 re-export 本文件的公开面，下游 import 路径不变。
 *
 * 单独成文件的理由除了行数上限，还有一层：条目头是**跨模块契约**——`document.js` 解析它、
 * `render-tiered.js` 按它分组、`topics.js` 靠它定位围栏插入点、整编层按它写盘。
 * 正则只该有一份，放在谁那里都不如放在谁都不依赖的地方。
 *
 * @module dsh-supermemory/core/entry-format
 */

import { createHash } from 'node:crypto'

/**
 * 条目头行的正则：`- <time> · source:<source>`，后三段 `· id:` / `· tier:` / `· topic:` 依次可选。
 *
 * 关于「缺段」的判定（契约 §V8.2 / §V8.14 与写盘规则之间有一处必须裁决的冲突）：
 *
 * - **没写 `id:` 就不许写 `tier:` / `topic:`** —— 写了就整行不认作条目头，退回正文。
 *   这是 §V8.14 举的那个例子（`source:` 之后直接 `tier:`），两个可选组都嵌在 id 的可选组里。
 * - **写了 `id:` 但跳过 `tier:` 直接写 `topic:` 是合法的**。若这里也要求逐段连续，
 *   `renderEntry` 最常见的输出 `- … · id:xxx · topic:主题`（core 条目带主题、core 不写 tier 段）
 *   就会写成一行解析不回来的正文，等于整编器给 core 条目打主题标签反而把条目抹掉。
 *   契约「core 不输出 tier 段」与「缺段即整行不认」只能满足一个，这里选择保住条目。
 *
 * `topic` 允许含空格，但**不允许含段分隔符 ` · `**（`(?! · )` 逐字符把关）：否则
 * `- … · id:x · topic:注入机制 · tier:cold` 这种把 tier 写在 topic 后面的错位行，会被整段
 * 当成主题名，把 ` · tier:cold` 一起收进主题里。分隔符出现两处含义时谁都没法解释，
 * 所以这里让整行不认作条目头。
 */
const ENTRY_HEAD =
  /^-\s+(?<time>\S+)\s+·\s+source:\s*(?<source>\S*)(?:\s+·\s+id:(?<id>\S+)(?:\s+·\s+tier:(?<tier>\S+))?(?:\s+·\s+topic:(?<topic>(?:(?! · ).)*))?)?\s*$/

/** id 的基础长度：sha1 hex 前 5 位。 */
export const ID_BASE_LENGTH = 5

/** 允许写进文档的 id 最长位数；`renderEntry` 只输出 5–9 位的 id（契约 §V4.0.1）。 */
export const ID_RENDER_MAX = 9

/**
 * 解析期 id 的最长位数。派生 id 与显式 id 相撞时逐位延长（5 → 7 → 9），
 * 9 位仍撞属于哈希前缀极小概率事故，继续延长到 15 位兜底——这类 id 超过
 * `ID_RENDER_MAX`，永远不会被写盘，只在单次解析的内存里用于区分条目。
 */
export const ID_PARSE_MAX = 15

/** 合法 id 的形态：5–9 位十六进制小写。 */
const ENTRY_ID = new RegExp(`^[0-9a-f]{${ID_BASE_LENGTH},${ID_RENDER_MAX}}$`)

/** `tier` 的全部合法值（契约 §V8.2）。缺省 = `core`，`cold` 是需要显式写盘的那一档。 */
export const ENTRY_TIERS = new Set(['core', 'cold'])

/** 条目缺省所属的分层。缺 `tier` 段 = `core`，保证存量文件升级瞬间一条都不从上下文消失。 */
export const DEFAULT_TIER = 'core'

/** `topic` 的最长字符数（按 Unicode 码点计）；超长视同没写。 */
const TOPIC_MAX_LENGTH = 24

/**
 * 规范化 `tier`：只认 `core` / `cold`，其余（含缺省与非法值）一律回落到缺省 `core`。
 *
 * 与不合法的 `id:` 段退回派生同一套哲学：**脏值当没写，而不是当错误**。
 *
 * @param {unknown} value - 条目头里 `tier:` 段的原文，或调用方传入的任意值。
 * @returns {'core'|'cold'} 合法的分层名。
 */
export function normalizeTier(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return ENTRY_TIERS.has(text) ? text : DEFAULT_TIER
}

/**
 * 规范化 `topic`：trim 后取 1–24 个码点，原样保留（含中文与空格）；空或超长返回空串。
 *
 * 按码点而非 `length` 计长，避免一个 emoji 或代理对被算成两个字符而误判超长。
 * 含段分隔符 ` · ` 的值一律不认——条目头靠它分段，让值里再出现一次就等于写下一行谁也
 * 解释不了的文本（`ENTRY_HEAD` 那边同样拒收，两边必须一致）。
 *
 * @param {unknown} value - 条目头里 `topic:` 段的原文，或调用方传入的任意值。
 * @returns {string} 合法的主题名；不合法时返回 `''`（表示未分类）。
 */
export function normalizeTopic(value) {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  if (text === '' || text.includes(' · ')) return ''
  if (Array.from(text).length > TOPIC_MAX_LENGTH) return ''
  return text
}

/**
 * 把任意字段转成参与 id 派生的字符串（null/undefined → 空串，其余走 String）。
 * @param value - 任意值。
 * @returns 字符串。
 */
export function asField(value) {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  return String(value)
}

/**
 * 是否是可以写盘的合法 id。
 * @param value - 任意值。
 * @returns 是否为 5–9 位十六进制小写字符串。
 */
export function isEntryId(value) {
  return typeof value === 'string' && ENTRY_ID.test(value)
}

/**
 * 这一行是否是条目头。给需要定位「第一个条目头」的调用方用（`rebuildDocument` 的 preamble
 * 边界、`topics.js` 的围栏插入点），避免第二份正则字面量漂走。
 *
 * @param {unknown} line - 文档里的一行。
 * @returns {boolean} 是否匹配条目头。
 */
export function isEntryHead(line) {
  return typeof line === 'string' && ENTRY_HEAD.test(line)
}

/**
 * 条目 id 的匹配结果：解析器需要拿到 `ENTRY_HEAD` 的命名组自己走一遍解析流程，
 * 但**不许**把正则字面量抄到别处（口径只能有一处）。
 *
 * @param {unknown} line - 文档里的一行。
 * @returns {RegExpExecArray | null} 匹配结果（含 `groups.time/source/id/tier/topic`）。
 */
export function execEntryHead(line) {
  return typeof line === 'string' ? ENTRY_HEAD.exec(line) : null
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
 * `JSON.stringify(entry)` 会丢 id，需要显式搬运——详见 `document.js` 模块头的下游注意。
 *
 * @param entry - 条目对象（就地改写并返回）。
 * @param id - 最终 id。
 * @param explicit - 是否来自原文的显式 id 段。
 * @returns 改写后的条目对象。
 */
export function defineEntryId(entry, id, explicit) {
  const stamp = { value: id, enumerable: false, writable: true, configurable: true }
  Object.defineProperty(entry, 'id', stamp)
  Object.defineProperty(entry, 'explicitId', { ...stamp, value: explicit === true })
  return entry
}

/**
 * 给条目挂上 `tier` / `topic`，与 `defineEntryId` 完全同构：四个属性都是**不可枚举**。
 *
 * - `tier` 永远是合法值（缺省 `core`），`explicitTier` 表示它是否来自原文的 `· tier:` 段。
 *   只有显式写过才允许落盘——派生的缺省 `core` 不写盘，否则存量文件全量重排变 diff 噪音。
 * - `topic` 空串表示未分类，`explicitTopic` 同理。
 *
 * 不可枚举的理由与 id 一字不差：`test/paths-document.test.js` 里
 * `assert.deepEqual(entry, { time, source, body })` 是 v1 钉下的格式契约，
 * 多一个可枚举字段会让它全线变红。
 *
 * @param {object} entry - 条目对象（就地改写并返回）。
 * @param {string} tier - 已规范化的分层名（`core` / `cold`）。
 * @param {boolean} explicitTier - 该 tier 是否来自原文的显式段。
 * @param {string} topic - 已规范化的主题名（可为空串）。
 * @param {boolean} explicitTopic - 该 topic 是否来自原文的显式段。
 * @returns {object} 改写后的条目对象。
 */
export function defineEntryTier(entry, tier, explicitTier, topic, explicitTopic) {
  const stamp = { enumerable: false, writable: true, configurable: true }
  Object.defineProperty(entry, 'tier', { ...stamp, value: tier })
  Object.defineProperty(entry, 'explicitTier', { ...stamp, value: explicitTier === true })
  Object.defineProperty(entry, 'topic', { ...stamp, value: topic })
  Object.defineProperty(entry, 'explicitTopic', { ...stamp, value: explicitTopic === true })
  return entry
}
