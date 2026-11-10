/**
 * dsh-supermemory —— 整理器输入构造。
 *
 * 从 `digest.js` 拆出的「整理输入构造 + 系统提示」：对话取样、现有记忆拼装、
 * 输入字节预算，以及喂给模型的 `DIGEST_SYSTEM_PROMPT`。这些全是**纯函数与常量**，
 * 不依赖 cordis Context，也不碰 store，单独成文件是为了让 `digest.js` 只留下
 * 「串行队列 + LLM 调用 + 写回」这条主干。
 *
 * `DIGEST_SYSTEM_PROMPT` 是给模型看的**对外承诺内容**，改动会直接改变整理输出的
 * 格式约定。文案分两部分：JSON 格式约定与「规则」那 6 条属**对外契约**，重构时
 * 不要顺手调整；「事实性守则」是项目所有者 2026-11 逐条审定的**最高优先级约束**，
 * 用来防止记忆被写成变更史与未来规划，任何改动都必须经项目所有者确认，
 * 不得为省 token 而弱化或删除。
 *
 * `KINDS` 住在这里是因为 `buildDigestInput` 要按它给每份记忆算字节预算；
 * `digest.js` 反向从这里 import，依赖保持单向，避免两个模块互相引用。
 *
 * 硬约束：不 import 任何 `@deepseek-ai/*` 宿主包。
 *
 * @module dsh-supermemory/host/digest-input
 */

import { isAbsolute } from 'node:path'

import { byteLength } from '../core/document.js'

/** 整理输入里最多保留的对话消息条数。 */
const MAX_TRANSCRIPT_MESSAGES = 40

/** 四类记忆的统一顺序，写盘与报告都按这个顺序。 */
export const KINDS = ['soul', 'user', 'global', 'project']

/**
 * 整理器的 system 提示。
 *
 * v2：只要求输出 `{"project":[...]}`，并明确不要输出 soul/user/global。
 * v3.9：末尾追加「事实性守则」——条目只描述当前为真的状态，不记变更史与未来规划
 * （契约 §V3.9，另一个生效出口是 `host/tools.js` 的 `DESCRIPTION`）。
 */
export const DIGEST_SYSTEM_PROMPT = [
  '你是 dsh-supermemory 的记忆整理器。阅读「最近的对话」与「现有记忆」，只提炼值得长期保留、且与**当前项目**相关的**新增事实**。',
  '',
  '只输出一个 JSON 对象，不要输出任何解释、前后缀或 Markdown 代码围栏。格式固定（只有一个键，值是字符串数组）：',
  '{"project":["..."]}',
  '',
  '规则：',
  '- **只输出 project 一个键**，不要输出 soul / user / global：人格设定、用户画像与全局长期记忆由用户手动维护，整理器永不写入。',
  '- 每条一句话，独立可读，不依赖上下文代词。',
  '- 只写新增事实，不要重复「现有记忆」里已有的内容。',
  '- project：只与当前项目相关的约定、结构、决策与坑。',
  '- 没有新增内容就输出 {"project":[]}；不要臆造。',
  '- 忽略寒暄、临时状态、工具调用细节与宿主注入的快照消息。',
  '',
  '## 事实性守则（最高优先级）',
  '记忆只描述「此刻为真的状态」，不记录过程。',
  '1. 用现在时陈述当前状态，像在写一份今天的说明书。',
  '2. 禁止记录记忆自身的变更史：不写「原先是 A，后改为 B」「已从 X 迁移到 Y」「v2 起…」「早期版本…」「本次重构把…改为…」，也不写数量前后对比（如「基线从 263 涨到 344」）。直接写当前结论：「测试基线是 344 个用例」。',
  '3. 禁止记录未来规划：不写「计划」「待办」「下一步」「将来可以」「尚未实现」。只写已经成立的事实。',
  '4. 允许写原因，但仅限能帮后来者避坑的因果。可写「不要用 node --test test/，本机 Node 24 会把它当模块解析」这类当前有效的坑；不写「之所以拆成 7 个文件，是因为原先 routes.js 太长」这类修改动机。',
  '5. 与「现有记忆」冲突时，说明事实已变化：输出当前正确的结论本身，不要写成「X 已改为 Y」的对比句。系统当前只能追加，旧条目会在后续整理时清除，因此你要尽量少写冲突条目——写之前先确认新结论确实成立。',
  '6. 判断标准：一年后读到这条，它还成立吗？不成立就别写。',
].join('\n')

/**
 * 按字节从尾部保留文本（用于超预算时截断旧记忆）。
 * @param {string} text - 原文。
 * @param {number} maxBytes - 最多保留的字节数。
 * @returns {string} 截断后的文本。
 */
function truncateTail(text, maxBytes) {
  const source = String(text ?? '')
  if (byteLength(source) <= maxBytes) return source
  const buffer = Buffer.from(source, 'utf8')
  let start = buffer.length - Math.max(0, maxBytes)
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1
  return `[前文已截断]\n${buffer.subarray(start).toString('utf8')}`
}

/**
 * 提取一条消息里的纯文本（只取 text block）。
 * @param {unknown} content - 消息 content。
 * @returns {string} 纯文本。
 */
function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/**
 * 从会话日志里取最近的用户 / 助手纯文本，跳过插件快照与工具结果。
 * @param {object} agent - 宿主 Agent。
 * @param {number} [limit] - 最多消息条数。
 * @returns {string[]} 形如 `user: ...` 的文本行。
 */
export function collectTranscript(agent, limit = MAX_TRANSCRIPT_MESSAGES) {
  let events
  try {
    events = agent?.session?.snapshotEvents?.() ?? []
  } catch {
    return []
  }
  const picked = []
  for (const event of events) {
    if (event?.type !== 'user/message' && event?.type !== 'assistant/message') continue
    const message = event.type === 'user/message' ? event.data : event.data?.message
    if (message === undefined || message === null) continue
    if (message.source?.kind === 'dsh-supermemory') continue
    if (message.source?.kind === 'tool') continue
    const role = message.role === 'assistant' ? 'assistant' : 'user'
    const text = textOfContent(message.content).trim()
    if (text === '') continue
    picked.push(`${role}: ${text}`)
  }
  return picked.slice(-limit)
}

/**
 * 空的四文件内容表。
 * @returns {{soul:string,user:string,global:string,project:string}} 文档表。
 */
export function emptyDocs() {
  return { soul: '', user: '', global: '', project: '' }
}

/**
 * 计算某一类记忆的 store ref；project 无合法根时返回 undefined。
 *
 * v2：soul/user/global 的隔离键从 `presetId` 改为 `persona`。
 * 由于 store（§V2.2）在 ref 同时给出 `persona` 与 `presetId` 时**persona 优先**，
 * 这里把两者写成同一个值：旧 store 走 presetId，新 store 走 persona，行为一致。
 *
 * @param {string} kind - soul | user | global | project。
 * @param {string} persona - 人设 slug。
 * @param {string|undefined} projectRoot - 项目根绝对路径。
 * @returns {object|undefined} store ref。
 */
export function refFor(kind, persona, projectRoot) {
  if (kind === 'project') {
    if (typeof projectRoot !== 'string' || projectRoot === '' || !isAbsolute(projectRoot)) return undefined
    return { kind: 'project', projectRoot }
  }
  if (typeof persona !== 'string' || persona === '') return undefined
  return { kind, persona, presetId: persona }
}

/**
 * 拼装整理输入文本。
 * @param {string[]} transcriptLines - 对话行（时间顺序）。
 * @param {{soul:string,user:string,global:string,project:string}} docs - 现有记忆。
 * @returns {string} 输入文本。
 */
function composeDigestInput(transcriptLines, docs) {
  const parts = ['## 最近的对话（按时间顺序）']
  parts.push(transcriptLines.length === 0 ? '(无)' : transcriptLines.join('\n'))
  parts.push('')
  parts.push('## 现有记忆（不要重复这些内容）')
  const labels = [
    ['soul', '人格 soul'],
    ['user', '用户画像 user'],
    ['global', '全局长期记忆 global'],
    ['project', '项目记忆 project'],
  ]
  for (const [kind, label] of labels) {
    parts.push(`### ${label}`)
    const content = String(docs[kind] ?? '').trim()
    parts.push(content === '' ? '(空)' : content)
  }
  return parts.join('\n')
}

/**
 * 构建整理请求的输入：先丢最旧的对话，仍超预算再截断文件内容尾部。
 * @param {string[]} transcriptLines - 对话行。
 * @param {{soul:string,user:string,global:string,project:string}} docs - 现有记忆。
 * @param {number} maxBytes - 输入字节上限。
 * @returns {string} 输入文本（不超过 maxBytes，极端情况除外）。
 */
export function buildDigestInput(transcriptLines, docs, maxBytes) {
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : 120000
  let lines = Array.isArray(transcriptLines) ? [...transcriptLines] : []
  let text = composeDigestInput(lines, docs)
  while (byteLength(text) > limit && lines.length > 0) {
    lines = lines.slice(1)
    text = composeDigestInput(lines, docs)
  }
  if (byteLength(text) <= limit) return text

  const trimmed = { ...docs }
  const perBudget = Math.max(2048, Math.floor(limit / (KINDS.length + 1)))
  for (const kind of KINDS) trimmed[kind] = truncateTail(trimmed[kind], perBudget)
  return composeDigestInput(lines, trimmed)
}
