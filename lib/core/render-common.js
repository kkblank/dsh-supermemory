/**
 * 渲染层共享工具（纯函数，无 IO）。
 *
 * 从 `render.js` 抽出，供两条渲染路径共用：v7 的 `buildSnapshot`（回滚通道）与 v8 的
 * `buildTieredSnapshot`（分层路径）。两条路径必须用**同一套**转义、包裹与字节截断口径，
 * 否则 `tieredInjection: false` 逐字节退回旧行为这件事根本无从谈起（契约 §V8.5 / §V8.13）。
 *
 * 本模块不是公共 API：`render.js` 只对外 re-export `escapeFrame`，其余一律按内部工具对待。
 *
 * @module dsh-supermemory/core/render-common
 */

import { byteLength } from './document.js'

/** 快照包裹标签。 */
export const FRAME_OPEN = '<supermemory>'
export const FRAME_CLOSE = '</supermemory>'

/**
 * 把任意输入规整成字符串；null/undefined 视为空串。
 * @param {unknown} value - 任意值。
 * @returns {string} 字符串（不会返回 undefined）。
 */
export function asText(value) {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  return String(value)
}

/**
 * 转义正则元字符。
 * @param {string} value - 原字符串。
 * @returns {string} 可安全嵌入 RegExp 的字符串。
 */
export function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 转义内容里的闭合标签，避免内容提前闭合包裹。
 * 内部把 `</supermemory>` → `<\/supermemory>`。
 * @param {unknown} text - 待转义文本。
 * @param {string} [tag] - 包裹标签名，默认 `supermemory`。
 * @returns {string} 转义后的文本。
 */
export function escapeFrame(text, tag = 'supermemory') {
  const source = asText(text)
  if (source === '') return ''
  const name = asText(tag) === '' ? 'supermemory' : asText(tag)
  // 标签名可能含正则特殊字符，先转义；兼容大小写与标签内空白（`</supermemory >`）。
  const pattern = new RegExp(`</${escapeRegExp(name)}\\s*>`, 'gi')
  return source.replace(pattern, (match) => `<\\${match.slice(1)}`)
}

/**
 * 归一化字节预算：非有限值 → 不限制；负数 → 0。
 * @param {unknown} maxBytes - 调用方预算。
 * @returns {number} 整数上限或 Infinity。
 */
export function normalizeBudget(maxBytes) {
  return Number.isFinite(maxBytes) ? Math.max(0, Math.floor(maxBytes)) : Infinity
}

/**
 * 按 UTF-8 字节数安全截断字符串，不切断多字节字符。
 * @param {unknown} text - 原文本。
 * @param {number} maxBytes - 字节上限。
 * @returns {string} 截断结果。
 */
export function sliceByBytes(text, maxBytes) {
  const source = asText(text)
  if (maxBytes <= 0) return ''
  if (byteLength(source) <= maxBytes) return source
  let used = 0
  let out = ''
  for (const char of source) {
    const size = byteLength(char)
    if (used + size > maxBytes) break
    out += char
    used += size
  }
  return out
}

/**
 * 截断文本并追加提示行；预算连提示行都放不下时只做纯字节截断。
 * @param {unknown} text - 原文本。
 * @param {number} maxBytes - 字节上限。
 * @param {string} suffix - 追加的提示行（含前导换行）。
 * @returns {string} 截断结果。
 */
export function truncateWithSuffix(text, maxBytes, suffix) {
  const source = asText(text)
  const limit = normalizeBudget(maxBytes)
  if (limit === Infinity || byteLength(source) <= limit) return source
  const suffixBytes = byteLength(suffix)
  if (limit <= suffixBytes) return sliceByBytes(source, limit)
  return sliceByBytes(source, limit - suffixBytes) + suffix
}

/**
 * 用 `<supermemory>` 包裹正文。
 * @param {string} body - 已转义的正文。
 * @returns {string} 包裹后的文本。
 */
export function wrapFrame(body) {
  return `${FRAME_OPEN}\n${body}\n${FRAME_CLOSE}`
}

/**
 * 按行截断正文，尽量不把一行切成两半；返回值保证是完整行组成的文本。
 * @param {unknown} body - 已转义的正文。
 * @param {number} maxBytes - 可用字节数。
 * @returns {string} 截断后的正文（可能是空串）。
 */
export function sliceLinesByBytes(body, maxBytes) {
  if (maxBytes <= 0) return ''
  const lines = asText(body).split('\n')
  const kept = []
  let used = 0
  for (const line of lines) {
    const size = byteLength(line) + (kept.length === 0 ? 0 : 1)
    if (used + size > maxBytes) break
    kept.push(line)
    used += size
  }
  if (kept.length === 0) return ''
  return `${kept.join('\n')}\n…`
}

/**
 * 条目头时间的时间戳；不可解析记为 -Infinity（排序时落在最后）。
 * 渲染层与目录层都要按时间比较，口径只能有一份。
 *
 * @param {{ time?: unknown }} entry - 条目。
 * @returns {number} 毫秒或 -Infinity。
 */
export function entryTime(entry) {
  const parsed = Date.parse(asText(entry?.time))
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY
}
