/**
 * 专家人格目录（纯函数，无 IO）。
 *
 * 主管人设的会话需要知道「手上有哪些专家可派」。目录就是这份名册：一行一个专家，
 * 写「名称（专长）」。名称就是 `delegate_expert` 的 `persona` 参数要传的值，
 * 所以格式的第一要求是**让模型一眼分出哪一段是名称**。
 *
 * 三条口径（契约 §V13.4）：
 *   - **所有非主管人设都是专家**：没有 `expertise` 的人设也照列，只写名称。
 *     漏掉它等于让主管看不见这个专家，比多一行噪音的代价大得多。
 *   - **目录不含主管自己**：主管派自己没有意义，白占预算。
 *   - **同步**：调用方是 `systemPrompt.section` 的 `text()` 回调，不能 await，
 *     所以本模块只接受调用方已经拿到手的数组，绝不自己读盘/读 store。
 *
 * 预算口径：总字节超 `maxBytes` 时**按条目从尾部丢弃**（顺序即名册顺序，靠前的
 * 先留下），末尾补一行「（另有 N 个专家未列出）」把删减这件事说出来。连标题与
 * 提示行都放不下时返回空文本——半截标题没有任何信息量，不如不注入。
 *
 * @module dsh-supermemory/core/experts
 */

import { byteLength } from './document.js'
import { escapeFrame, normalizeBudget } from './render-common.js'

/** 目录标题行。 */
export const EXPERT_DIRECTORY_HEADING = '## 专家人格'

/** 目录尾部的固定说明行：说清「怎么用」和「专家不汇报」。 */
export const EXPERT_DIRECTORY_HINT =
  '需要专长判断时，用 `delegate_expert` 工具，`persona` 传上面的名称；专家只执行你交代的任务，不会替你向用户汇报。'

/** 专长描述的最大码点数（契约 §V13.4）。 */
const EXPERTISE_MAX = 500

/**
 * 专家显示名的最大码点数。
 *
 * 名称是用户输入（人设名），本身没有长度约束。不截的话一个几 KB 的名字会让整条
 * 目录永远放不下、把别的专家全挤掉——这是「一条坏数据毁掉整份名册」的典型形态。
 */
const NAME_MAX = 80

/** 名称里带括号时换用冒号分隔（见 `renderExpertLine` 的注释）。 */
const PAREN = /[（）()]/u

/**
 * 按码点安全截断，绝不切断代理对（emoji 之类）。
 * @param {string} text - 原文本。
 * @param {number} max - 最大码点数。
 * @returns {string} 截断结果。
 */
function sliceCodePoints(text, max) {
  if (max <= 0) return ''
  const points = [...text]
  return points.length <= max ? text : points.slice(0, max).join('')
}

/**
 * 清洗专长描述：单行化（换行/连续空白折叠成一个空格）、去首尾空白、按码点截断到 500。
 *
 * 为什么要单行化：专长是用户在人设面板里随手写的，可能带换行甚至整段说明。多行描述
 * 会让目录一条占好几行，把「一行一个专家」这个结构彻底破坏，模型也数不清有几个专家。
 *
 * 与 store 侧 `normalizeExpertise`（`lib/core/store-normalize.js`）的关系：那边是**落盘
 * 口径**（只折叠 `\r\n` / `\n`，保留 tab 与连续空格，因为要尽量不改用户原文）；这里是
 * **注入口径**，更严格地把所有空白折叠成单个空格。两处都截 500 码点，所以同一段专长
 * 落盘后再过这里只可能变得更短，不会出现「目录比面板长」的反向差异。刻意不 import
 * 那个模块：目录是注入面，不该因为存储层内部重构而被动改行为。
 *
 * @param {unknown} value - 原始专长。
 * @returns {string} 清洗结果；非字符串返回空串。
 */
export function cleanExpertise(value) {
  if (typeof value !== 'string') return ''
  const oneLine = value.replace(/\s+/gu, ' ').trim()
  if (oneLine === '') return ''
  return sliceCodePoints(oneLine, EXPERTISE_MAX)
}

/**
 * 清洗专家显示名：与 `cleanExpertise` 同口径的单行化，另按 `NAME_MAX` 截断。
 * @param {unknown} value - 原始名称。
 * @param {string} slug - 名称缺失时的兜底（用 slug，保证目录里不会出现无名条目）。
 * @returns {string} 清洗结果。
 */
function cleanName(value, slug) {
  if (typeof value !== 'string') return slug
  const oneLine = value.replace(/\s+/gu, ' ').trim()
  return oneLine === '' ? slug : sliceCodePoints(oneLine, NAME_MAX)
}

/**
 * 把调用方给的专家列表收敛成目录条目：剔非对象、剔空 slug、剔主管、按 slug 去重。
 *
 * 去重是必要的：`listPersonas` 理论上不会重复，但目录是注入面，一份重复名册会让
 * 模型以为有两个同名专家可派。宁可少列，不可重列。
 *
 * @param {unknown} experts - `[{ slug, name, expertise }]`。
 * @param {unknown} supervisorSlug - 主管人设 slug（目录里排除它）。
 * @returns {Array<{ slug: string, name: string, expertise: string }>} 目录条目。
 */
function normalizeExperts(experts, supervisorSlug) {
  const supervisor = typeof supervisorSlug === 'string' ? supervisorSlug : ''
  const seen = new Set()
  const out = []
  for (const item of Array.isArray(experts) ? experts : []) {
    if (item === null || typeof item !== 'object') continue
    const slug = typeof item.slug === 'string' ? item.slug.trim() : ''
    if (slug === '' || slug === supervisor || seen.has(slug)) continue
    seen.add(slug)
    out.push({ slug, name: cleanName(item.name, slug), expertise: cleanExpertise(item.expertise) })
  }
  return out
}

/**
 * 渲染一行专家。
 *
 * 格式：有专长写 `- 名称（专长）`，没有只写 `- 名称`。括号是「名称到此为止」的视觉
 * 分隔，模型据此知道该把哪一段传给 `persona`；而**名称自身带括号**时括号就失去
 * 区分度（`- 财务（分析）（财务分析）` 读起来像两个专长），这一条改用冒号形式
 * `- 名称：专长`。两种形式混排是有意的取舍：歧义只影响个别人设，而统一冒号会让
 * 全部条目都失去「哪段是名称」的提示。
 *
 * @param {{ name: string, expertise: string }} entry - 目录条目。
 * @returns {string} 一行文本（已转义闭合标签）。
 */
function renderExpertLine(entry) {
  const name = escapeFrame(entry.name)
  const expertise = escapeFrame(entry.expertise)
  if (expertise === '') return `- ${name}`
  if (PAREN.test(entry.name)) return `- ${name}：${expertise}`
  return `- ${name}（${expertise}）`
}

/**
 * 组装目录全文（标题 + 条目 + 可选「未列出」行 + 提示行）。
 * @param {Array<{ name: string, expertise: string }>} entries - 本次列出的条目。
 * @param {number} dropped - 被丢弃的条目数。
 * @returns {string} 目录文本。
 */
function assembleDirectory(entries, dropped) {
  const lines = [EXPERT_DIRECTORY_HEADING, '']
  for (const entry of entries) lines.push(renderExpertLine(entry))
  if (dropped > 0) lines.push(`（另有 ${dropped} 个专家未列出）`)
  lines.push('', EXPERT_DIRECTORY_HINT)
  return lines.join('\n')
}

/**
 * 渲染专家人格目录。
 *
 * 取舍顺序是「从尾部丢条目」，因此**名册顺序就是优先级**：靠前的是先登记的专家。
 * 每一档都整段重新量字节（`byteLength`），不做增量估算——目录最长也就几 KB，
 * 而增量估算与真实字节差一点就会让注入超预算，那是宿主侧看不见的软失败。
 *
 * @param {object} input - 输入。
 * @param {unknown} input.experts - `[{ slug, name, expertise }]`。
 * @param {unknown} input.supervisorSlug - 主管人设 slug；目录里排除它。
 * @param {unknown} input.maxBytes - 字节预算；非有限值视为不限。
 * @returns {{ text: string, truncated: boolean, count: number }} 目录文本（无专家或
 *   连标题都放不下时为空串）、是否发生过删减、实际列出的专家数。
 */
export function buildExpertDirectory({ experts, supervisorSlug, maxBytes } = {}) {
  const list = normalizeExperts(experts, supervisorSlug)
  if (list.length === 0) return { text: '', truncated: false, count: 0 }
  const limit = normalizeBudget(maxBytes)
  // 只试「至少列出一条」。count === 0 的那一档只剩标题、未列出计数与说明行，
  // 而说明行写着「persona 传上面的名称」——上面一个名称都没有，这份文本既不能用
  // 又白占系统提示预算，所以直接落到下面的空返回。
  for (let count = list.length; count >= 1; count -= 1) {
    const text = assembleDirectory(list.slice(0, count), list.length - count)
    if (byteLength(text) <= limit) {
      return { text, truncated: count < list.length, count }
    }
  }
  // 连「标题 + 第一条 + 说明行」都放不下：返回空串让调用方按「不注入」处理。
  // 这里 truncated 报 false 而不是 true，是因为**什么都没有渲染**——调用方拿到空串
  // 时唯一正确的动作就是不注入，再区分「删了多少」没有可用的下游。
  return { text: '', truncated: false, count: 0 }
}
