/**
 * dsh-supermemory —— 整理器输入构造。
 *
 * 从 `digest.js` 拆出的「整理输入构造 + 系统提示」：对话取样、现有记忆拼装、
 * 输入字节预算，以及喂给模型的 `DIGEST_SYSTEM_PROMPT`（追加模式）与
 * `CONSOLIDATE_SYSTEM_PROMPT`（整编模式，契约 §V4.0.3）。这些全是**纯函数与常量**，
 * 不依赖 cordis Context，也不碰 store，单独成文件是为了让 `digest.js` 只留下
 * 「串行队列 + LLM 调用 + 写回」这条主干。
 *
 * 两个 system 提示是给模型看的**对外承诺内容**，改动会直接改变整理输出的
 * 格式约定。文案分两部分：JSON 格式约定与「规则」那几条属**对外契约**，重构时
 * 不要顺手调整；「事实性守则」是项目所有者 2026-11 逐条审定的**最高优先级约束**，
 * 两种模式同源共用模块内的 `FACT_RULES`，用来防止记忆被写成变更史与未来规划，
 * 任何改动都必须经项目所有者确认，
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

import { byteLength, parseEntries } from '../core/document.js'

/** 整理输入里最多保留的对话消息条数。 */
const MAX_TRANSCRIPT_MESSAGES = 40

/** 四类记忆的统一顺序，写盘与报告都按这个顺序。 */
export const KINDS = ['soul', 'user', 'global', 'project']

/** 整理输入缺省的字节上限（追加与整编共用）。 */
const DEFAULT_INPUT_BYTES = 120000

/**
 * 「事实性守则」全文（契约 §V3.9，项目所有者逐条审定的最高优先级约束）。
 *
 * 追加模式与整编模式**同源共用**这段文本：整编正是清洗变更史与流水账的主战场，
 * 两个提示词各写一份迟早会漂移，因此抽成常量后由两个提示各自拼接。
 * 共用的代价是这段文本里没有「只对某一种模式成立」的余地：**每一句都必须同时是追加时的要求、
 * 也是整编时的要求**。写进这里之前先检查它是否偷偷描述了系统能力（例如「系统当前只能追加」），
 * 那种句子属于某个模式的规则区，放进共用常量会反过来指令另一个模式。
 * 逐字改动须经项目所有者确认，不得为省 token 而弱化或删除。
 */
const FACT_RULES = [
  '## 事实性守则（最高优先级）',
  '记忆只描述「此刻为真的状态」，不记录过程。',
  '1. 用现在时陈述当前状态，像在写一份今天的说明书。',
  '2. 禁止记录记忆自身的变更史：不写「原先是 A，后改为 B」「已从 X 迁移到 Y」「v2 起…」「早期版本…」「本次重构把…改为…」，也不写数量前后对比（如「基线从 263 涨到 344」）。直接写当前结论：「测试基线是 344 个用例」。',
  '3. 禁止记录未来规划：不写「计划」「待办」「下一步」「将来可以」「尚未实现」。只写已经成立的事实。',
  '4. 允许写原因，但仅限能帮后来者避坑的因果。可写「不要用 node --test test/，本机 Node 24 会把它当模块解析」这类当前有效的坑；不写「之所以拆成 7 个文件，是因为原先 routes.js 太长」这类修改动机。',
  '5. 与「现有记忆」冲突时，说明事实已变化：输出当前正确的结论本身，不要写成「X 已改为 Y」的对比句，也不要把新旧两种说法各写一条留着矛盾。写之前先确认新结论确实成立。',
  '6. 判断标准：一年后读到这条，它还成立吗？不成立就别写。',
].join('\n')

/**
 * 整理器（追加模式）的 system 提示。
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
  '- 系统当前只能追加，写下的冲突条目不会被自动清除，因此尽量少写冲突条目。',
  '- project：只与当前项目相关的约定、结构、决策与坑。',
  '- 没有新增内容就输出 {"project":[]}；不要臆造。',
  '- 忽略寒暄、临时状态、工具调用细节与宿主注入的快照消息。',
  '',
  FACT_RULES,
].join('\n')

/**
 * 整编模式（consolidate）的 system 提示（契约 §V4.0.3）。
 *
 * 与追加模式的根本差别：产物是 project 记忆的**目标态整份清单**，不是增量。模型一旦把任务
 * 理解成「只写要改的那几条」，对账时会把它没提到的条目一律当成待原样保留项，整编等于白跑，
 * 所以这一点重复说、往重了说都不算过头。「未提及的条目会被系统原样保留」则是刻意写给模型看的
 * 安全网，用来压掉它「顺手清理一遍」的过度删除倾向。
 *
 * 事实性守则与追加模式**同源共用** `FACT_RULES`，共用成立的前提是守则里不出现模式特定的句子。
 * 第 5 条只讲冲突怎么处理——「输出当前结论本身，不要新旧并存」：追加时它让你别写「X 已改为 Y」
 * 的对比句，整编时它让你把新旧合成一条或把失效的那条 `drop` 掉，而不是留着两条互相矛盾。
 * 同一条要求，两种模式下都是同一个动作方向，所以能逐字共用而不自相矛盾。
 */
export const CONSOLIDATE_SYSTEM_PROMPT = [
  '你是 dsh-supermemory 的记忆整编器。阅读「现有 project 记忆」（每条行首方括号内是它的 id）、「最近的对话」与三份仅供参考的记忆，把 **project 记忆**重写成一份干净的当前态清单。',
  '',
  '**你输出的是整理完成后那份记忆的整份目标态清单，不是增量。** 把多条合并成一条时，合并结果要写成一条独立可读的完整条目，不要只写它与旧条目的差别。',
  '',
  '只输出一个 JSON 对象，不要输出任何解释、前后缀或 Markdown 代码围栏。格式固定（单行，只有 entries 与 drop 两个键）：',
  '{"entries":[{"text":"…","from":["a3f2c"]}],"drop":[{"id":"b8e01","reason":"…"}]}',
  '',
  '规则：',
  '- **只处理 project**，不要输出 soul / user / global：那三份由用户手动维护，整编器永不写入，输入里给出只供你判断有无重复或冲突。',
  '- `entries` 是整理后的新条目；每条一句话，独立可读，不依赖上下文代词。',
  '- `from` 写这条新条目**吸收或取代了哪些现有条目**的 id。id 照抄行首方括号里的内容（形如 a3f2c 的十六进制串），不要自行改写或凭空拼造。全新事实没有对应的旧条目，`from` 写成空数组。同一个 id 只写进一条新条目的 `from`。',
  '- **改写也算取代**：想把某条过时或含糊的说法改对，就输出改写后的整条正文，并把它的 id 写进 `from`；漏写 `from` 会变成两条重复条目。',
  '- `drop` 只用于「事实已经失效、且没有任何新说法可以替代」的条目，`reason` 必填，一句话说清它为何不再成立。能被某条新条目吸收的走 `from`，不放 `drop`。',
  '- **既没出现在任何 `from`、也没出现在 `drop` 里的现有条目，会被系统原文原样保留。** 不确定该不该留的条目就别写它——不动它就是正确答案，没写不等于删除。',
  '- 动作顺序：先把说同一件事的条目合并成一条，再改写过时或含糊的表述，最后才考虑 `drop`。整编的收益来自合并与删除，不要为了改写而改写。',
  '- 不许臆造输入里没有的事实；不要把对话里的寒暄、临时状态、工具调用细节写成条目。对话只用来判断现有条目是否已经失效，以及提炼确实值得长期保留的新增事实。',
  '- 没有该合并、该改写、该删除的内容就输出 {"entries":[],"drop":[]}；宁可少改，也不要制造变更。',
  '',
  FACT_RULES,
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
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_INPUT_BYTES
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

/** 整编输入里三份参考记忆的标签：它们只作上下文，不属于本次整理对象。 */
const REFERENCE_LABELS = [
  ['soul', '人格 soul'],
  ['user', '用户画像 user'],
  ['global', '全局长期记忆 global'],
]

/** 参考记忆被截断时每份至少保留的字节数。 */
const REFERENCE_MIN_BYTES = 1024

/**
 * 把一条 project 条目渲染成 `[<id>] <正文>`——整编输入里模型唯一的引用手段。
 *
 * id 缺失时（文档还没有 `id:` 段、解析端也未提供派生 id）退化为只输出正文：
 * 与其伪造一个对账时对不上的 id，不如不给引用手段。
 *
 * @param {{ id?: unknown, body?: unknown }} entry - parseEntries 解析出的条目。
 * @returns {string} 一行（正文自带换行时可能多行）。
 */
function renderIdedEntry(entry) {
  const body = String(entry?.body ?? '')
  const id = typeof entry?.id === 'string' ? entry.id : ''
  return id === '' ? body : `[${id}] ${body}`
}

/**
 * 拼装整编输入文本：整理对象在前，对话与三份参考记忆在后。
 * @param {string[]} transcriptLines - 对话行。
 * @param {Array<object>} entries - project 条目（已解析）。
 * @param {object} docs - 现有记忆。
 * @returns {string} 输入文本。
 */
function composeConsolidateInput(transcriptLines, entries, docs) {
  const parts = ['## 现有 project 记忆（本次要整理的对象）']
  parts.push('每条行首方括号内是该条目的 id，`from` 与 `drop` 里照抄它。')
  parts.push(entries.map((entry) => renderIdedEntry(entry)).join('\n'))
  parts.push('')
  parts.push('## 最近的对话（仅供参考，只用于判断现有条目是否已失效）')
  parts.push(transcriptLines.length === 0 ? '(无)' : transcriptLines.join('\n'))
  parts.push('')
  parts.push('## 参考记忆（不属于本次整理范围：不要合并、改写、删除或输出这三份的内容）')
  for (const [kind, label] of REFERENCE_LABELS) {
    parts.push(`### ${label}`)
    const content = String(docs?.[kind] ?? '').trim()
    parts.push(content === '' ? '(空)' : content)
  }
  return parts.join('\n')
}

/**
 * 构建整编请求的输入（契约 §V4.0.3）。
 *
 * 降级顺序与追加模式**不同**，而且是刻意的：project 正文**任何情况下都不截断**——截断等于让
 * 模型照着残缺稿重写，它会照着残缺稿交付，丢掉的条目就再也回不来了。所以超预算只能丢对话
 * （丢到 0 条为止），丢光仍装不下就把三份参考记忆按 `truncateTail` 压一遍（它们只是去重与
 * 冲突上下文），再装不下就返回 INPUT_OVERFLOW，由调用方放弃本轮整编。
 *
 * @param {{soul?:string,user?:string,global?:string,project?:string}} docs - 现有记忆。
 * @param {string[]} transcriptLines - 对话行。
 * @param {number} maxBytes - 输入字节上限。
 * @returns {{ ok:true, input:string } | { ok:false, reason:'INPUT_OVERFLOW'|'NO_PROJECT' }} 输入或失败原因。
 */
export function buildConsolidateInput(docs, transcriptLines, maxBytes) {
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_INPUT_BYTES
  const entries = parseEntries(typeof docs?.project === 'string' ? docs.project : '')
  if (entries.length === 0) return { ok: false, reason: 'NO_PROJECT' }

  let lines = Array.isArray(transcriptLines) ? [...transcriptLines] : []
  let text = composeConsolidateInput(lines, entries, docs)
  while (byteLength(text) > limit && lines.length > 0) {
    lines = lines.slice(1)
    text = composeConsolidateInput(lines, entries, docs)
  }
  if (byteLength(text) <= limit) return { ok: true, input: text }

  const budget = Math.max(REFERENCE_MIN_BYTES, Math.floor(limit / 12))
  const refs = {}
  for (const [kind] of REFERENCE_LABELS) refs[kind] = truncateTail(String(docs?.[kind] ?? ''), budget)
  text = composeConsolidateInput([], entries, { ...docs, ...refs })
  if (byteLength(text) > limit) return { ok: false, reason: 'INPUT_OVERFLOW' }
  return { ok: true, input: text }
}
