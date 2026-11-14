/**
 * dsh-supermemory —— 整理器输入构造。
 *
 * 从 `digest.js` 拆出的「整理输入构造」：对话取样、现有记忆拼装、输入字节预算。
 * 这些全是**纯函数与常量**，不依赖 cordis Context，也不碰 store，单独成文件是为了让
 * `digest.js` 只留下「串行队列 + LLM 调用 + 写回」这条主干。
 *
 * 两个 system 提示（`DIGEST_SYSTEM_PROMPT` 追加模式 / `CONSOLIDATE_SYSTEM_PROMPT` 整编模式）
 * 住在同目录的 `./digest-prompt.js`，这里原样 re-export，导入路径不变——它们是给模型看的
 * **对外承诺文案**，与「这一轮喂什么数据」的改动理由从来不同，不该同文件演进。
 *
 * v8（契约 V8.8）在整编输入里加了三件事：条目当前的**分层现状**、盘上已有的**主题表**、
 * 以及主题的**检索热度**。三者都只在有内容时才成节，存量项目一条 tier 都没写时
 * 整份输入与升级前逐字节相同（契约 V8.0 不变量三「缺省 = 旧行为」）。
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
import { UNTOPICIZED } from '../core/tier-index.js'

// 提示词文案的单一真源在 ./digest-prompt.js；re-export 保持既有调用方与测试的导入路径。
export {
  CONSOLIDATE_BATCH_NOTE,
  CONSOLIDATE_BOOTSTRAP_NOTE,
  CONSOLIDATE_SYSTEM_PROMPT,
  DIGEST_SYSTEM_PROMPT,
  selectConsolidateSystemPrompt,
} from './digest-prompt.js'

/** 整理输入里最多保留的对话消息条数。 */
const MAX_TRANSCRIPT_MESSAGES = 40

/** 四类记忆的统一顺序，写盘与报告都按这个顺序。 */
export const KINDS = ['soul', 'user', 'global', 'project']

/** 整理输入缺省的字节上限（追加与整编共用）。 */
const DEFAULT_INPUT_BYTES = 120000

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
 * 收集被压缩遮蔽掉的事件 seq（契约 V8.15 第 24 条）。
 *
 * **只认 `shadowedSeqs` 这个显式集合，绝不拿 `shadowedRange` 去展开。** 判据来自真实会话日志
 * （`~/.dsh/sessions` 下 29 个 `session.v4.jsonl.zstd`，用 `zlib.zstdDecompressSync` 实测）：
 *
 * - 一条 `compaction/summary` 的 `shadowedRange` 是 `{start:10, end:217}`，而它的
 *   `shadowedSeqs` 只有 **80** 个——按 range 展开会多遮蔽 128 个从未被遮蔽的事件；
 * - 另一条的 `shadowedSeqs` 里出现 **220**，比它自己的 `range.start = 556` 还小，
 *   说明 range 不是这组 seq 的包络，两个字段各说各话。
 *
 * 按 range 过滤的后果不是多算一点，而是把**没被摘要过的真实对话**踢出整编输入，而那些对话
 * 没有任何别的地方能补回来（摘要里也没有它们）——那才是真正不可逆的丢记忆。集合字段才是权威。
 *
 * `compaction/summary` 与 `compaction/prune` **两种都要收**：prune 单独遮蔽自己的那批事件，
 * 只认 summary 会整批漏掉。日志里两者与 `compact-checkpoint` 一一对应。
 *
 * @param {Array<object>} events - `session.snapshotEvents()` 的结果。
 * @returns {Set<number>} 被遮蔽的 seq 集合；读不到就是空集（宁可多读，不可误删）。
 */
function collectShadowedSeqs(events) {
  const shadowed = new Set()
  for (const event of events) {
    const type = event?.type
    if (type !== 'compaction/summary' && type !== 'compaction/prune') continue
    const seqs = event?.data?.shadowedSeqs
    if (!Array.isArray(seqs)) continue
    for (const seq of seqs) {
      if (Number.isInteger(seq)) shadowed.add(seq)
    }
  }
  return shadowed
}

/**
 * 从会话日志里取最近的用户 / 助手纯文本，跳过插件快照与工具结果。
 *
 * 压缩只**遮蔽**事件、不删除（`session.v4.jsonl.zstd` 是 append-only），所以
 * `snapshotEvents()` 默认全区间时那些旧原文**仍然读得到**。这里按 `shadowedSeqs` 把它们跳过：
 * 一段已经被摘要压过的对话再进整编，模型会把当时的原文当成"现在的事实"重述一遍。
 *
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
  if (!Array.isArray(events)) return []
  const shadowed = collectShadowedSeqs(events)
  const picked = []
  for (const event of events) {
    if (event?.type !== 'user/message' && event?.type !== 'assistant/message') continue
    // 只跳过**确实被某次压缩遮蔽过**的 seq。`seq` 读不到（旧宿主、测试替身）时落在
    // `shadowed.has(undefined) === false` 上，也就是照旧保留——判断不了就宁可多读。
    if (shadowed.has(event.seq)) continue
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
 * 「分层现状」小节：逐条列出**显式**写了 `tier` / `topic` 的条目当前的分层。
 *
 * 单独成节而不是在 `[id] 正文` 后面贴标记，是两个理由逼出来的：
 *
 * - 标记跟在正文尾巴上，模型有相当概率把它一起抄进 `text`，落盘就成了正文里的脏字符。
 *   分层是元数据，物理上与正文分开写，比在提示里恳求它「别抄」可靠得多。
 * - `[id] 正文` 这个形状是整编的引用契约（`from` / `drop` 照抄行首 id），
 *   也是 `test/consolidate-input.test.js` 钉住的行格式，不该为排版而变形。
 *
 * **一条显式分层都没有就整节省略**：存量项目升级的那一刻输入体积必须零增长，
 * 而且「现状是 core 且未分类」这件事由提示词的缺省规则讲一次就够，逐条重复只是烧预算。
 *
 * @param {Array<object>} entries - parseEntries 解析出的条目。
 * @returns {string} 小节文本；无需提示时返回空串。
 */
function renderTierStatus(entries) {
  const lines = []
  for (const entry of entries) {
    if (typeof entry?.id !== 'string' || entry.id === '') continue
    const marks = []
    // explicitTier / explicitTopic 为 false 是 parseEntries 派生的缺省值（契约 V8.2），
    // 那是「没写过」，不是现状——列出来会把每一条都变成 core，这一节就失去意义了。
    if (entry.explicitTier !== false && (entry.tier === 'core' || entry.tier === 'cold')) {
      marks.push(`tier:${entry.tier}`)
    }
    if (entry.explicitTopic !== false && typeof entry.topic === 'string' && entry.topic !== '') {
      marks.push(`topic:${entry.topic}`)
    }
    if (marks.length > 0) lines.push(`- ${entry.id} · ${marks.join(' · ')}`)
  }
  if (lines.length === 0) return ''
  return [
    '## 分层现状（只读：这些条目当前写着的 tier / topic。不要把这里的标记抄进条目正文）',
    '没列在这里的条目当前是 core 且未分类。要改某条的分层，就在它的 entries 项里写 tier / topic；不写就是维持这条现状。',
    ...lines,
  ].join('\n')
}

/**
 * 把距今天数渲染成模型一眼能读的粒度。
 *
 * 不给精确到小数的天数：模型要判的是「近期 / 较久 / 很久」三档，`0.73 天` 只会让它
 * 误以为这是个需要精确比较的量。超过一年折成「约 N 年」，避免出现「距今 913 天」这种
 * 反而更难判的写法。
 *
 * @param {number} days - 距今天数（非负）。
 * @returns {string} 可读文本。
 */
function formatAgeDays(days) {
  const value = Math.max(0, days)
  if (value < 1) return '1 天内'
  if (value < 30) return `${Math.round(value)} 天`
  if (value < 365) return `约 ${Math.round(value / 30)} 个月`
  return `约 ${Math.round(value / 365)} 年`
}

/**
 * 「主题表与热度」小节：盘上已有的主题（摘要 + 别名）与各主题的检索命中次数。
 *
 * 主题表来自调用方从 project 文档受控围栏里解析的结果（解析在 `core/topics.js`，
 * 本模块不 import 它：输入构造只负责排版，不认识盘上格式）；热度来自 usage，
 * 由装配层注入。两者都没有就整节省略。
 *
 * 为什么必须把表喂给模型：整编最容易做坏的一件事就是**给同一件事起第二个主题名**——
 * 目录一旦裂开，检索就永远只能命中一半。看不到已有名字的模型几乎必然重命名，
 * 因为它无法把「注入机制」和它想写的「快照注入」判成同一件事。
 *
 * 热度是**全量**：装配层喂的是 `usageSummary().topicRows`（每个主题一行），不是面板那个
 * 只截前 10 的 `hottest` 热点视图——那份喂进来会让第 11 名往后的主题在输入里没有数字，
 * 模型就把它们判成冷门降进冷层，而整编全程不报错、事后也查不到依据（契约 V8.15 第 22 条）。
 *
 * 即便如此，本节仍**不把缺数字写成「零命中」**：读不到命中数的原因不止「没被检索过」
 * （usage 文件缺失、某一项损坏被丢弃、装配层没接上都会缺），任何一种都不构成
 * 「这条主题没人用」的证据。下面小标题那句「不等于零命中」由 `test/consolidate-input.test.js`
 * 守着，不要因为看起来啰嗦就简化掉。
 *
 * v12 补时效：每行在「热度 N」之后追加「距今 D 天」（`ageDays` 由装配层算好喂进来）。
 * 只给命中数不给时效，模型就分不出「昨天被搜过 12 次」和「去年被搜过 12 次」，而分层的
 * 全部意义就在时效。**没有 `ageDays` 时整段退回旧格式**（升级前后逐字节一致）。
 *
 * @param {Array<{ name?: string, summary?: string, aliases?: string[] }>|undefined} topics - 盘上主题表。
 * @param {Array<{ name?: string, hits?: number, ageDays?: number }>|undefined} usage - 主题热度（按命中次数，可带距今天数）。
 * @returns {string} 小节文本；两者都空时返回空串。
 */
function renderTopicTable(topics, usage) {
  const table = new Map()
  for (const topic of Array.isArray(topics) ? topics : []) {
    const name = typeof topic?.name === 'string' ? topic.name.trim() : ''
    if (name === '') continue
    table.set(name, {
      summary: typeof topic.summary === 'string' ? topic.summary.trim() : '',
      aliases: Array.isArray(topic.aliases) ? topic.aliases.filter((alias) => typeof alias === 'string' && alias !== '') : [],
      hits: undefined,
    })
  }
  for (const item of Array.isArray(usage) ? usage : []) {
    const name = typeof item?.name === 'string' ? item.name.trim() : ''
    if (name === '') continue
    const hits = Number.isFinite(item?.hits) ? Math.max(0, Math.trunc(item.hits)) : 0
    const row = table.get(name) ?? { summary: '', aliases: [], hits: undefined, ageDays: undefined }
    row.hits = (row.hits ?? 0) + hits
    // 距今天数取同一主题里**最近**的那一次：时效判据问的是「最近还用过吗」。
    if (Number.isFinite(item?.ageDays)) {
      row.ageDays = row.ageDays === undefined ? item.ageDays : Math.min(row.ageDays, item.ageDays)
    }
    table.set(name, row)
  }
  if (table.size === 0) return ''

  const lines = []
  for (const [name, row] of table) {
    const parts = [name]
    if (row.summary !== '') parts.push(row.summary)
    if (row.hits !== undefined) parts.push(`热度 ${row.hits}`)
    if (Number.isFinite(row.ageDays)) parts.push(`距今 ${formatAgeDays(row.ageDays)}`)
    if (row.aliases.length > 0) parts.push(`aliases: ${row.aliases.join(', ')}`)
    lines.push(`- ${parts.join(' · ')}`)
  }
  return [
    '## 主题表与热度（热度是各主题近期被检索命中的次数；没有数字表示这一轮没拿到它的命中数，不等于零命中）',
    '给条目写 `topic` 时**优先复用下面已有的主题名**；`topics` 里更新某个主题时要连 `name` 一起逐字照抄，只有确实要改写它的摘要或别名时才重写整条。',
    ...lines,
  ].join('\n')
}

/**
 * 拼装整编输入文本：整理对象在前，对话与三份参考记忆在后。
 * @param {string[]} transcriptLines - 对话行。
 * @param {Array<object>} entries - project 条目（已解析）。
 * @param {object} docs - 现有记忆。
 * @param {{ topics?: Array<object>, topicUsage?: Array<object> }} [extras] - 分层与热度的补充上下文。
 * @returns {string} 输入文本。
 */
function composeConsolidateInput(transcriptLines, entries, docs, extras = {}) {
  // 分批模式（契约 §V11.0.3）：只把本批主题的条目交给模型，其余**原封不动**。
  // 必须显式告诉模型「范围之外还有很多条目」，否则它会以为整份记忆只有这几条，
  // 于是把没看见的内容当成已删除——这是分批最危险的失效模式，用提示词先堵死。
  const scope = Array.isArray(extras?.scopeTopics) ? extras.scopeTopics : []
  const inScope = scope.length === 0
    ? entries
    : entries.filter((entry) => scope.includes(typeof entry?.topic === 'string' && entry.topic !== '' ? entry.topic : UNTOPICIZED))
  const parts = ['## 现有 project 记忆（本次要整理的对象）']
  if (scope.length > 0) {
    parts.push(`**本轮只整理这几个主题：${scope.map((name) => `「${name}」`).join('、')}。**`)
    parts.push(`范围之外还有 ${entries.length - inScope.length} 条条目，本轮**不列出来、也不要提及**；系统会把它们原样保留，你既不需要、也没有资格处置它们。`)
    parts.push('因此本轮 `from` 与 `drop` 只能引用下面列出的 id；范围外的条目即使你觉得该合并，也不要动——留给后续批次。')
  }
  parts.push('每条行首方括号内是该条目的 id，`from` 与 `drop` 里照抄它。')
  parts.push(inScope.map((entry) => renderIdedEntry(entry)).join('\n'))
  for (const section of [
    renderTierStatus(inScope),
    renderTopicTable(
      Array.isArray(extras?.topics) && scope.length > 0
        ? extras.topics.filter((topic) => scope.includes(typeof topic?.name === 'string' ? topic.name : ''))
        : extras?.topics,
      extras?.topicUsage,
    ),
  ]) {
    if (section === '') continue
    parts.push('')
    parts.push(section)
  }
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
 * @param {{ topics?: Array<object>, topicUsage?: Array<object>, scopeTopics?: string[] }} [extras] - 盘上主题表、检索热度
 *   与分批范围（v8 契约 V8.8；v11 §V11.0.3 加 `scopeTopics`）。都由调用方备好再传进来：
 *   本模块不认识盘上围栏，也不碰 usage 文件。
 *   `scopeTopics` 为空数组或缺省 = 全量模式，行为与 v11 之前**逐字节相同**；非空时只排版
 *   这些主题的条目，并在输入里明确声明「范围外的条目原样保留」，防止模型把它们当已删除。
 * @returns {{ ok:true, input:string } | { ok:false, reason:'INPUT_OVERFLOW'|'NO_PROJECT' }} 输入或失败原因。
 */
export function buildConsolidateInput(docs, transcriptLines, maxBytes, extras = {}) {
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_INPUT_BYTES
  const entries = parseEntries(typeof docs?.project === 'string' ? docs.project : '')
  if (entries.length === 0) return { ok: false, reason: 'NO_PROJECT' }

  let lines = Array.isArray(transcriptLines) ? [...transcriptLines] : []
  let text = composeConsolidateInput(lines, entries, docs, extras)
  while (byteLength(text) > limit && lines.length > 0) {
    lines = lines.slice(1)
    text = composeConsolidateInput(lines, entries, docs, extras)
  }
  if (byteLength(text) <= limit) return { ok: true, input: text }

  const budget = Math.max(REFERENCE_MIN_BYTES, Math.floor(limit / 12))
  const refs = {}
  for (const [kind] of REFERENCE_LABELS) refs[kind] = truncateTail(String(docs?.[kind] ?? ''), budget)
  text = composeConsolidateInput([], entries, { ...docs, ...refs }, extras)
  if (byteLength(text) > limit) return { ok: false, reason: 'INPUT_OVERFLOW' }
  return { ok: true, input: text }
}
