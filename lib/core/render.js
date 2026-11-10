/**
 * 注入文本渲染（纯函数，无 IO、无宿主依赖）。
 *
 * 本模块只负责把四段记忆文本拼成注入快照 / 系统提示 section / 索引降级文本，
 * 并通过 `document.js` 的 `byteLength`、`documentTitle`、`parseEntries` 读取文档信息。
 * 注意：render 层绝不 interpolate，`{{...}}` 一律按字面量保留。
 *
 * @module dsh-supermemory/core/render
 */

import { createHash } from 'node:crypto'

import { byteLength, documentTitle, parseEntries } from './document.js'

/** 四段固定的段标题（契约 §3.3 渲染规则 1）。 */
const SECTION_HEADINGS = {
  soul: '## 人格 (soul)',
  user: '## 用户画像 (user)',
  global: '## 全局长期记忆 (global)',
}

/** 索引降级时必须出现的固定提示行（契约 §3.3 规则 4）。 */
const INDEX_HINT = '完整内容可用 memory 工具按需读取。'

/** 快照包裹标签。 */
const FRAME_OPEN = '<supermemory>'
const FRAME_CLOSE = '</supermemory>'

/**
 * 把任意输入规整成字符串；null/undefined 视为空串。
 * @param value - 任意值。
 * @returns 字符串（不会返回 undefined）。
 */
function asText(value) {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  return String(value)
}

/**
 * 转义内容里的闭合标签，避免内容提前闭合包裹。
 * 内部把 `</supermemory>` → `<\/supermemory>`。
 * @param text - 待转义文本。
 * @param tag - 包裹标签名，默认 `supermemory`。
 * @returns 转义后的文本。
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
 * 转义正则元字符。
 * @param value - 原字符串。
 * @returns 可安全嵌入 RegExp 的字符串。
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 归一化字节预算：非有限值 → 不限制；负数 → 0。
 * @param maxBytes - 调用方预算。
 * @returns 整数上限或 Infinity。
 */
function normalizeBudget(maxBytes) {
  return Number.isFinite(maxBytes) ? Math.max(0, Math.floor(maxBytes)) : Infinity
}

/**
 * 按 UTF-8 字节数安全截断字符串，不切断多字节字符。
 * @param text - 原文本。
 * @param maxBytes - 字节上限。
 * @returns 截断结果。
 */
function sliceByBytes(text, maxBytes) {
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
 * @param text - 原文本。
 * @param maxBytes - 字节上限。
 * @param suffix - 追加的提示行（含前导换行）。
 * @returns 截断结果。
 */
function truncateWithSuffix(text, maxBytes, suffix) {
  const source = asText(text)
  const limit = normalizeBudget(maxBytes)
  if (limit === Infinity || byteLength(source) <= limit) return source
  const suffixBytes = byteLength(suffix)
  if (limit <= suffixBytes) return sliceByBytes(source, limit)
  return sliceByBytes(source, limit - suffixBytes) + suffix
}

/**
 * 读取文档正文里的 `##` 小节标题列表（排除 `###` 及更深层级）。
 * @param text - 文档文本。
 * @returns 标题文本数组（按出现顺序）。
 */
function extractHeadings(text) {
  const headings = []
  for (const line of asText(text).split(/\r?\n/)) {
    const match = /^##[ \t]+(.+?)[ \t]*$/.exec(line)
    if (match !== null) headings.push(match[1])
  }
  return headings
}

/**
 * 从文档条目里取最新的 ISO 时间；没有可解析时间时返回空串。
 * @param text - 文档文本。
 * @returns ISO 8601 字符串或 ''。
 */
function latestEntryTime(text) {
  let latest = Number.NEGATIVE_INFINITY
  for (const entry of parseEntries(asText(text))) {
    const parsed = Date.parse(entry?.time)
    if (Number.isFinite(parsed) && parsed > latest) latest = parsed
  }
  return latest === Number.NEGATIVE_INFINITY ? '' : new Date(latest).toISOString()
}

/**
 * 人格 + 画像 → 系统提示 section 文本。
 * soul 优先；超预算时先保 soul，再截断 user 并追加 `[画像已截断]`；
 * soul 单独超预算时截断 soul 并追加 `[人格已截断]`，不再输出 user。
 * @param input - { soul, user, maxBytes }。
 * @returns section 文本；两段都空时返回 ''。
 */
export function buildPersonaSection(input = {}) {
  const soulBody = asText(input.soul).trim()
  const userBody = asText(input.user).trim()
  if (soulBody === '' && userBody === '') return ''

  const limit = normalizeBudget(input.maxBytes)
  const soulBlock = soulBody === '' ? '' : `${SECTION_HEADINGS.soul}\n\n${escapeFrame(soulBody)}`
  const userBlock = userBody === '' ? '' : `${SECTION_HEADINGS.user}\n\n${escapeFrame(userBody)}`
  const fullText = [soulBlock, userBlock].filter((part) => part !== '').join('\n\n')
  if (limit === Infinity || byteLength(fullText) <= limit) return fullText

  // 预算小到连「段标题 + 截断提示行」都放不下时，宁可不注入也不输出半截标题。
  const primaryHeading = soulBlock === '' ? SECTION_HEADINGS.user : SECTION_HEADINGS.soul
  const primarySuffix = soulBlock === '' ? '[画像已截断]' : '[人格已截断]'
  if (limit < byteLength(`${primaryHeading}\n\n${primarySuffix}`)) return ''

  // soul 单独就超预算：截断 soul 并标记，不再输出 user。
  if (soulBlock !== '' && byteLength(soulBlock) > limit) {
    return truncateWithSuffix(soulBlock, limit, '\n[人格已截断]')
  }

  // soul 完整保留，剩余预算给 user。
  if (soulBlock !== '') {
    const prefix = `${soulBlock}\n\n`
    const userSuffix = '\n[画像已截断]'
    const userPrefix = `${SECTION_HEADINGS.user}\n\n`
    const remaining = limit - byteLength(prefix)
    const available = remaining - byteLength(userPrefix) - byteLength(userSuffix)
    if (available > 0) {
      const body = sliceByBytes(escapeFrame(userBody), available)
      return `${prefix}${userPrefix}${body}${userSuffix}`
    }
    // 剩余预算放不下「标题 + 提示」：优先保住完整 soul，其次只放提示行。
    const withHeading = `${prefix}${userPrefix}${userSuffix}`
    if (byteLength(withHeading) <= limit) return withHeading
    const withSuffixOnly = `${prefix}${userSuffix}`
    if (byteLength(withSuffixOnly) <= limit) return withSuffixOnly
    return soulBlock
  }

  // 只有 user 且超预算。
  return truncateWithSuffix(userBlock, limit, '\n[画像已截断]')
}

/**
 * 索引降级文本（四段合并超预算时使用）。返回正文，不含 `<supermemory>` 包裹。
 * @param files - [{ label, title, headings, updatedAt, bytes, error? }]。
 * @param options - { projectName, reason }。
 * @returns 索引正文（动态字段已转义，防止提前闭合包裹）。
 */
export function buildIndex(files, options = {}) {
  const list = Array.isArray(files) ? files : []
  const projectName = asText(options.projectName).trim()
  const reason = asText(options.reason).trim()
  const lines = ['记忆索引（注入内容已超出预算，已降级为索引）']
  if (projectName !== '') lines.push(`- 项目：${escapeFrame(projectName)}`)
  if (reason !== '') lines.push(`- 原因：${escapeFrame(reason)}`)

  for (const file of list) {
    if (file === null || file === undefined) continue
    const label = asText(file.label).trim() === '' ? '未命名文件' : asText(file.label).trim()
    const title = asText(file.title).trim()
    const headings = Array.isArray(file.headings)
      ? file.headings.map((item) => asText(item).trim()).filter((item) => item !== '')
      : []
    const updatedAt = asText(file.updatedAt).trim()
    const bytes = Number.isFinite(file.bytes) ? Math.max(0, Math.floor(file.bytes)) : 0
    const error = asText(file.error).trim()
    lines.push('')
    lines.push(`- ${escapeFrame(label)}`)
    lines.push(`  - 标题：${title === '' ? '（无标题）' : escapeFrame(title)}`)
    lines.push(`  - 小节：${headings.length === 0 ? '（无）' : escapeFrame(headings.join('、'))}`)
    lines.push(`  - 更新：${updatedAt === '' ? '未知' : escapeFrame(updatedAt)}`)
    lines.push(`  - 字节：${bytes}`)
    if (error !== '') lines.push(`  - 错误：${escapeFrame(error)}`)
  }

  if (list.length === 0) {
    lines.push('')
    lines.push('- （暂无可用记忆文件）')
  }
  lines.push('')
  lines.push(INDEX_HINT)
  return lines.join('\n')
}

/**
 * 用 `<supermemory>` 包裹正文。
 * @param body - 已转义的正文。
 * @returns 包裹后的文本。
 */
function wrapFrame(body) {
  return `${FRAME_OPEN}\n${body}\n${FRAME_CLOSE}`
}

/**
 * 按行截断正文，尽量不把一行切成两半；返回值保证是完整行组成的文本。
 * @param body - 已转义的索引正文。
 * @param maxBytes - 可用字节数。
 * @returns 截断后的正文（可能是空串）。
 */
function sliceLinesByBytes(body, maxBytes) {
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
 * 保证索引包裹文本不超过预算。
 * 极端预算下优先保住「完整内容可用 memory 工具按需读取。」提示行与合法包裹，
 * 宁可略微超出预算，也不让降级文本失去可读性（契约 §3.3 规则 4 要求该行必须存在）。
 * @param body - 已转义的索引正文。
 * @param limit - 字节上限。
 * @returns 包裹后的索引文本。
 */
function fitWrappedIndex(body, limit) {
  const text = wrapFrame(body)
  if (limit === Infinity || byteLength(text) <= limit) return text
  const minimal = wrapFrame(INDEX_HINT)
  if (limit < byteLength(minimal)) return minimal
  const suffix = `\n${INDEX_HINT}\n${FRAME_CLOSE}`
  const prefix = `${FRAME_OPEN}\n`
  const available = limit - byteLength(prefix) - byteLength(suffix)
  if (available > 0) {
    const clipped = sliceLinesByBytes(body, available)
    if (clipped !== '') return `${prefix}${clipped}${suffix}`
  }
  return minimal
}

/**
 * 计算快照指纹（sha1 十六进制）。
 *
 * 口径：对**原始四段输入内容 + projectName + truncated 状态**取哈希，
 * 而不是对渲染后的 text 取哈希。原因：降级为索引后，两段长度相同、
 * 结构相同的正文可能渲染出完全一样的索引文本，若按 text 取哈希，
 * 下游会把「记忆已变」误判成「记忆没变」而跳过快照刷新。
 *
 * @param raw - 已 trim 的四段正文 { soul, user, global, project }。
 * @param projectName - 项目名。
 * @param truncated - 是否降级为索引。
 * @returns 40 位十六进制字符串。
 */
function fingerprint(raw, projectName, truncated) {
  const payload = JSON.stringify({
    soul: raw.soul,
    user: raw.user,
    global: raw.global,
    project: raw.project,
    projectName,
    truncated,
  })
  return createHash('sha1').update(payload, 'utf8').digest('hex')
}

/**
 * 构建注入快照。
 * @param input - { soul, user, global, project, projectName, maxBytes, updatedAt? }。
 * @returns { text, digest, truncated, sections }。
 *   text：`<supermemory>…</supermemory>`；四段全空时为 ''。
 *   digest：sha1 十六进制（对原始四段内容 + projectName + truncated 取指纹）。
 *   truncated：是否降级为索引。
 *   sections：{ soul, user, global, project } 各段渲染后的字节数。
 */
export function buildSnapshot(input = {}) {
  const projectName = asText(input.projectName).trim()
  const escapedProjectName = escapeFrame(projectName)
  const projectLabel = escapedProjectName === '' ? '项目记忆 (project)' : `项目记忆 (project: ${escapedProjectName})`

  const raw = {
    soul: asText(input.soul).trim(),
    user: asText(input.user).trim(),
    global: asText(input.global).trim(),
    project: asText(input.project).trim(),
  }

  const blocks = []
  const sections = { soul: 0, user: 0, global: 0, project: 0 }
  for (const scope of ['soul', 'user', 'global', 'project']) {
    if (raw[scope] === '') continue
    const heading = scope === 'project' ? `## ${projectLabel}` : SECTION_HEADINGS[scope]
    const block = `${heading}\n\n${escapeFrame(raw[scope])}`
    blocks.push(block)
    sections[scope] = byteLength(block)
  }

  // 四段全空：调用方不应注入任何内容。
  if (blocks.length === 0) {
    return {
      text: '',
      digest: fingerprint(raw, projectName, false),
      truncated: false,
      sections,
    }
  }

  const limit = normalizeBudget(input.maxBytes)
  const fullText = wrapFrame(blocks.join('\n\n'))
  const fullBytes = byteLength(fullText)
  if (limit === Infinity || fullBytes <= limit) {
    return {
      text: fullText,
      digest: fingerprint(raw, projectName, false),
      truncated: false,
      sections,
    }
  }

  const updatedAt = asText(input.updatedAt).trim()
  const indexFiles = [
    { key: 'soul', label: '人格 (soul)' },
    { key: 'user', label: '用户画像 (user)' },
    { key: 'global', label: '全局长期记忆 (global)' },
    { key: 'project', label: projectLabel },
  ]
    .filter((item) => raw[item.key] !== '')
    .map((item) => ({
      label: item.label,
      title: documentTitle(raw[item.key]) ?? '',
      headings: extractHeadings(raw[item.key]),
      updatedAt: updatedAt !== '' ? updatedAt : latestEntryTime(raw[item.key]),
      bytes: byteLength(raw[item.key]),
    }))

  const body = buildIndex(indexFiles, {
    projectName,
    reason: `全量 ${fullBytes} 字节，超过预算 ${limit} 字节`,
  })
  const indexText = fitWrappedIndex(body, limit)
  return {
    text: indexText,
    // 注意：digest 取原始四段内容，而非索引文本。
    // 降级后不同正文可能产生相同索引，按 text 取哈希会让下游误判「没变」。
    digest: fingerprint(raw, projectName, true),
    truncated: true,
    sections,
  }
}
