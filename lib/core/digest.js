/**
 * 整理器的**追加模式**：输出解析与条目追加（纯函数）。
 *
 * 整理器（LLM）要求只输出固定 JSON，但实际输出常带 ```json 围栏或前后说明文字，
 * 因此 `parseDigestOutput` 做多级容错提取；`mergeDigest` 只负责把条目追加到四份文档，
 * 文件格式细节全部交给 `document.js` 的 `appendEntries`。
 *
 * v4 的整编模式（拿旧条目 id 对账算目标态）住在 `consolidate.js`，本模块只剩「追加」
 * 这一条路。两个模式共用的容错遍历 `pickJsonObject` 以本文件为唯一真源，`consolidate.js`
 * 复用而不是复制它，依赖方向是单向的 consolidate → digest → document。
 *
 * @module dsh-supermemory/core/digest
 */

import { appendEntries } from './document.js'

/** 四个记忆分区，顺序固定。 */
const SCOPES = ['soul', 'user', 'global', 'project']

/** JSON.parse 失败哨兵（用于区分「解析失败」和「解析出 null」）。 */
const NOT_JSON = Symbol('not-json')

/**
 * 从解析出的 JSON 对象里挑出合法条目。
 * 只接受四个已知字段；数组内非字符串项、空串、纯空白项全部丢弃。
 * @param object - 已解析的 JSON 对象。
 * @returns entries 对象（四个 key 必定存在且为数组）。
 */
function pickEntries(object) {
  const entries = { soul: [], user: [], global: [], project: [] }
  if (object === null || typeof object !== 'object') return entries
  for (const scope of SCOPES) {
    const value = object[scope]
    if (!Array.isArray(value)) continue
    for (const item of value) {
      if (typeof item !== 'string') continue
      const body = item.trim()
      if (body !== '') entries[scope].push(body)
    }
  }
  return entries
}

/**
 * 尝试 JSON.parse，失败返回哨兵而不是抛错。
 * @param candidate - 候选文本。
 * @returns 解析结果或 NOT_JSON。
 */
function tryParse(candidate) {
  try {
    return JSON.parse(candidate)
  } catch {
    return NOT_JSON
  }
}

/**
 * 从文本中提取所有 ``` 围栏代码块内容（优先带 json 标记的）。
 * @param text - 原文。
 * @returns 代码块内容数组。
 */
function fencedBlocks(text) {
  const blocks = []
  const marked = []
  const pattern = /```[ \t]*([A-Za-z0-9_-]*)[ \t]*\r?\n?([\s\S]*?)```/g
  let match
  while ((match = pattern.exec(text)) !== null) {
    const content = match[2].trim()
    if (content === '') continue
    if (match[1].toLowerCase() === 'json') marked.push(content)
    else blocks.push(content)
  }
  return [...marked, ...blocks]
}

/**
 * 扫描文本里所有平衡的 `{...}` 切片（正确处理字符串与转义）。
 * @param text - 原文。
 * @returns 切片数组，按 `{` 出现顺序。
 */
function balancedObjects(text) {
  const slices = []
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== '{') continue
    let depth = 0
    let inString = false
    let escaped = false
    for (let i = start; i < text.length; i += 1) {
      const char = text[i]
      if (inString) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') inString = false
        continue
      }
      if (char === '"') {
        inString = true
        continue
      }
      if (char === '{') depth += 1
      else if (char === '}') {
        depth -= 1
        if (depth === 0) {
          slices.push(text.slice(start, i + 1))
          break
        }
      }
    }
  }
  return slices
}

/**
 * 生成候选 JSON 文本，按可靠性从高到低排列。
 * @param text - 原文。
 * @returns 候选数组。
 */
function jsonCandidates(text) {
  const candidates = [text]
  for (const block of fencedBlocks(text)) candidates.push(block)
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1))
  for (const slice of balancedObjects(text)) candidates.push(slice)
  return candidates
}

/**
 * 判断一个已解析对象是否像是整理结果（含任一已知分区字段）。
 * @param object - 已解析的 JSON 值。
 * @returns 是否含已知字段。
 */
function looksLikeDigest(object) {
  if (object === null || typeof object !== 'object' || Array.isArray(object)) return false
  return SCOPES.some((scope) => scope in object)
}

/**
 * 遍历所有候选文本，取第一个合法 JSON 对象——追加与整编两个模式**共用这一份遍历**。
 *
 * 两者的差别只用一个 `prefer` 谓词表达：追加模式传 `looksLikeDigest`，让「像整理结果」的
 * 对象插队到说明文字里的干扰对象之前；整编模式不传，第一个合法对象就是它要的那个。
 *
 * 顺带报出 `sawNonObject`：解析成功但不是对象（数组、标量）与压根提不出对象是两种病因，
 * `parseDigestOutput` 据此给两条不同的错误文案。这也是没法让整编那个契约要求的
 * `extractJsonObject(text) -> object | null` 反过来替它解析的原因——这条信息塞不进
 * 那个返回值，与其塞成 `{ object, meta }` 破坏契约，不如让两个出口共用本函数。
 *
 * 因为要给 `consolidate.js` 复用才导出，它**不属于对外契约**：外部只应经
 * `parseDigestOutput`（追加）或 `consolidate.js` 的 `extractJsonObject`（整编）进来。
 *
 * @param {string} text - 候选文本（调用方负责 trim）。
 * @param {(object: object) => boolean} [prefer] - 命中即优先返回的谓词。
 * @returns {{ object: object | null, sawNonObject: boolean }} 第一个合法对象与「见过非对象」标记。
 */
export function pickJsonObject(text, prefer) {
  let firstObject = null
  let sawNonObject = false
  for (const candidate of jsonCandidates(text)) {
    const parsed = tryParse(candidate)
    if (parsed === NOT_JSON) continue
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      sawNonObject = true
      continue
    }
    if (prefer !== undefined && prefer(parsed) === true) return { object: parsed, sawNonObject }
    if (firstObject === null) firstObject = parsed
  }
  return { object: firstObject, sawNonObject }
}


/**
 * 解析整理器输出的 JSON。
 * 输入可能是 ```json 围栏、纯 JSON、或带前后说明文字。
 * @param raw - 整理器原始输出（字符串；也容忍已解析的对象）。
 * @returns { ok: true, entries } 或 { ok: false, error }。
 *   entries 固定含 soul/user/global/project 四个字符串数组键；
 *   全空数组视为 ok 且四段皆空（调用方据此判定「无新增」）。
 */
export function parseDigestOutput(raw) {
  // 已经是对象：直接挑条目，省去再序列化。
  if (raw !== null && typeof raw === 'object') {
    if (Array.isArray(raw)) return { ok: false, error: 'digest 输出必须是 JSON 对象' }
    return { ok: true, entries: pickEntries(raw) }
  }
  if (typeof raw !== 'string') return { ok: false, error: 'digest 输出必须是字符串或对象' }

  const text = raw.trim()
  if (text === '') return { ok: false, error: 'digest 输出为空' }

  // 优先选「像整理结果」的对象；只有全都不像时才退回第一个合法对象，
  // 避免说明文字里的 `{}` 之类干扰对象把真正结果挤掉。
  const { object, sawNonObject } = pickJsonObject(text, looksLikeDigest)
  if (object !== null) return { ok: true, entries: pickEntries(object) }
  if (sawNonObject) return { ok: false, error: 'digest 输出必须是 JSON 对象' }
  return { ok: false, error: 'digest 输出中没有合法 JSON 对象' }
}

/**
 * 归一化 entries：缺字段按空数组，非字符串项与空串丢弃。
 * @param entries - 调用方传入的条目对象。
 * @returns 四段字符串数组。
 */
function normalizeEntries(entries) {
  return pickEntries(entries ?? {})
}

/**
 * 合并模式：把 entries 追加到四个文件文本上。
 * @param docs - { soul, user, global, project } 现有文本。
 * @param entries - { soul, user, global, project } 新增条目数组。
 * @param options - { time, source }；time 缺省为当前 ISO 8601 UTC。
 * @returns { soul, user, global, project, counts }。
 *   counts 是本次各文件实际追加的条目数。
 */
export function mergeDigest(docs, entries, options = {}) {
  const sourceDocs = docs ?? {}
  const time =
    typeof options.time === 'string' && options.time.trim() !== ''
      ? options.time
      : new Date().toISOString()
  const source =
    typeof options.source === 'string' && options.source.trim() !== ''
      ? options.source
      : 'digest'
  const normalized = normalizeEntries(entries)

  const next = { soul: '', user: '', global: '', project: '' }
  const counts = { soul: 0, user: 0, global: 0, project: 0 }

  for (const scope of SCOPES) {
    const doc = typeof sourceDocs[scope] === 'string' ? sourceDocs[scope] : ''
    const bodies = normalized[scope]
    if (bodies.length === 0) {
      next[scope] = doc
      continue
    }
    const items = bodies.map((body) => ({ time, source, body }))
    next[scope] = appendEntries(doc, items)
    counts[scope] = items.length
  }

  return { ...next, counts }
}
