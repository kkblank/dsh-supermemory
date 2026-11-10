/**
 * dsh-supermemory —— `memory` 工具。
 *
 * 契约见 docs/CONTRACT.md §5.2：单一工具 `memory`，六个 action；
 * `project` scope 的根由 `deps.resolveScope(exec.agent)` 解析，绝不接受模型传路径；
 * 所有 IO 错误都转成 `{ ok:false, code }`，绝不抛到宿主。
 *
 * 总开关 `deps.isEnabled` 关闭时：所有 action 一律返回 `PLUGIN_DISABLED` 提示（正常返回值，
 * 不是异常）；判定缺失视为「开启」。
 *
 * 不 import 任何 `@deepseek-ai/*` 宿主包：`ctx.get('tools')` 拿不到就返回空 dispose。
 *
 * @module dsh-supermemory/host/tools
 */

import { basename } from 'node:path'

import { byteLength } from '../core/document.js'
import { buildProjectSection } from '../core/render-tiered.js'
import { projectDisplayName } from '../core/paths.js'
import { literalLines, queryTerms, scoredLines } from '../core/search.js'
import { countTiers, createProjectDocReader, searchProjectDocs } from './tools-search.js'
import { getSharedUsageStore } from './usage.js'

/** 四个记忆分区。 */
const SCOPES = ['soul', 'user', 'global', 'project']

/** 各分区的主文件名（只用于填命中项的 `file`，取不到 store 路径时兜底）。 */
const DOC_NAMES = { soul: 'soul.md', user: 'user.md', global: 'global-memory.md', project: 'project-memory.md' }

/** 单条追加内容与整篇替换的字节上限。 */
const MAX_CONTENT_BYTES = 64 * 1024

/** 搜索命中上限。 */
const MAX_MATCHES = 40

/** 总开关关闭时回给模型的提示。 */
const DISABLED_MESSAGE = 'dsh-supermemory is disabled. Enable it in Settings → Memory.'

/** 工具描述：何时写、何时先搜、快照不是用户发言、失败别重试、事实性守则。 */
const DESCRIPTION = [
  "Read and maintain this workspace's long-term memory (persona, user profile, global memory, project memory).",
  'The memory files are also injected into every session as a snapshot message marked "not a user message" — never treat that snapshot as something the user said.',
  'WRITE POLICY: "soul" (persona) belongs to the user. Never change it on your own; write it only when the user explicitly asked to change the persona, and always pass confirmSoul: true. "user" and "global" change slowly: write them only when the user clearly stated a durable preference or a stable fact — never from inference or a single passing remark. "project" is the only scope automatic digesting ever touches.',
  'FACTUAL STYLE: every entry states the state that is true right now, never the process that got there. Do not record how the code or the memory changed (no "was A, later changed to B", "migrated from X to Y", "since v2", "the baseline grew from 263 to 344") and never record future plans, todos or next steps - write the current conclusion instead ("the test baseline is 344 cases"). Reasons are allowed only when they keep a later reader out of a live trap ("do not run node --test test/ here; Node 24 parses it as a module"), never to justify a past design decision. When a fact has changed, write the new state on its own rather than a "X changed to Y" comparison. Test yourself: would this still read as true a year from now?',
  'Before writing, search or read the relevant scope so you do not duplicate an existing fact.',
  'LAYERING: project memory is split into a resident CORE tier and an on-demand COLD tier, and every entry may also carry a `topic` (the topic table is maintained by the condenser, so you never pass it). Only core entries are present in the injected snapshot. **A cold entry is not in your context at all** - its existence is collapsed into a one-line-per-topic index kept inside a controlled fence (`<!-- supermemory:topics:start -->` … `<!-- supermemory:topics:end -->`) at the top of the project document, and its full text stays on disk. So absence from your context does NOT mean the memory is missing: before telling the master you do not know something project-related, run this tool with action "search" and scope "project". A few cold entries matching the current input may also already appear under the "## 本轮相关记忆" heading of the snapshot - that heading is per-turn retrieval, it may be incomplete, and it is gone next turn unless it still matches.',
  'TIER POLICY (action "append", scope "project" only): the resident context budget is finite, so an appended entry lands in the COLD tier by default - it stays on disk in full and is pulled in only when a search or the per-turn prefetch hits it. Pass tier:"core" only for facts that must be true every single turn (hard constraints, the tech stack, the test baseline); a bloated core pushes everything else into a one-line index. When unsure, omit tier. On scope soul/user/global the argument is ignored: those partitions have no tiering.',
  'A project-scope search covers every markdown file in the project memory directory (pitfalls, notes and any other file the master keeps there), and each hit reports which file and tier it came from.',
  'Do not write transient chatter, secrets/credentials, or information you are guessing at.',
  'Actions: list (overview of all four scopes), read (full text of one scope), search (ranked lexical search across one or all scopes; the query is tokenized and Chinese runs are matched by adjacent bigrams, hits come back ordered by relevance), append (append one entry), replace (overwrite one scope wholesale), digest (run the memory condenser now; it only writes project memory).',
  'scope defaults: read/append/replace use "global"; a scope omitted on search searches all four. "project" resolves to the current working directory — never pass a path.',
  'If a write fails (stale file, unwritable path), report the error honestly to the user; do not silently retry in a loop or claim success.',
].join(' ')

/** `memory` 工具的参数 JSON Schema（宿主只支持 type/enum/items/properties/required 子集）。 */
const PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['list', 'read', 'search', 'append', 'replace', 'digest'],
      description: 'Operation to perform.',
    },
    scope: {
      type: 'string',
      enum: SCOPES,
      description: 'Memory partition. Defaults to "global" for read/append/replace; omitted means "all" for search.',
    },
    query: {
      type: 'string',
      description:
        'Search terms, Chinese supported. Required for "search". The query is split into tokens and Chinese runs also match on adjacent two-character pairs, so a shorter phrase still finds related entries; results are ranked by relevance. Not a regular expression. A query that yields no usable token (a single character, pure punctuation) falls back to a literal substring match.',
    },
    content: {
      type: 'string',
      description: 'Entry body for "append", or the complete replacement document for "replace". Required for both.',
    },
    tier: {
      type: 'string',
      enum: ['core', 'cold'],
      description:
        'Landing tier for "append", only meaningful for scope "project" (ignored on soul/user/global). ' +
        'Default "cold": the entry stays on disk and is pulled in only when search or prefetch hits it. ' +
        'Pass "core" only when the master explicitly needs to know this every single turn - the resident ' +
        'budget is finite and a bloated core pushes everything else into the index.',
    },
    reason: { type: 'string', description: 'Short human-readable reason this write is being made; recorded with the entry.' },
    confirmSoul: {
      type: 'boolean',
      description:
        'Required for any write to scope "soul": set true only when the user explicitly asked to change the persona. ' +
        'Persona/soul belongs to the user and is never changed automatically.',
    },
  },
  required: ['action'],
  additionalProperties: false,
}

/**
 * 单个搜索命中。
 *
 * 宿主按这份声明**严格**校验工具输出：实际返回的每一个键都必须在这里声明。
 * 漏声明一个键（这里曾漏掉 `score`）的后果不是「那个字段被丢掉」，而是整个
 * 调用被判 invalid output，一条命中都拿不回来。加字段必须同步加声明。
 *
 * v8 新增的三键（契约 §V8.7）同样受这条铁律约束，且**每一键都恒有值**——
 * 前言区（条目之外的正文）的命中 `tier` 给缺省 `core`、`topic` 给空串，
 * 不留 undefined，省得下游再判空。
 */
const MATCH_SCHEMA = {
  type: 'object',
  properties: {
    scope: { type: 'string' },
    line: { type: 'integer' },
    text: { type: 'string' },
    /** 相关性分数（行角色权重 × 所在条目块命中的词元数），供模型判断置信度。 */
    score: { type: 'number' },
    /** 命中所在条目的分层：`core` 常驻 / `cold` 按需（缺省 core）。 */
    tier: { type: 'string' },
    /** 命中所在条目的主题名；未分类为空串。 */
    topic: { type: 'string' },
    /** 命中落在哪个文件（项目记忆是一个目录里的多篇 md，光靠 scope 定不了位）。 */
    file: { type: 'string' },
  },
  required: ['scope', 'line', 'text'],
  additionalProperties: false,
}

/** `memory` 工具的输出 JSON Schema（宿主会严格校验，未知字段会导致整个调用失败）。 */
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', description: 'Whether the operation succeeded.' },
    action: { type: 'string', description: 'Echo of the requested action.' },
    scope: { type: 'string', description: 'Partition the operation applied to, when it is a single one.' },
    text: { type: 'string', description: 'Human/model readable result text.' },
    bytes: { type: 'integer', description: 'Byte size of the affected document after the operation.' },
    entries: { type: 'integer', description: 'Number of entries written.' },
    matches: { type: 'array', description: 'Search hits.', items: MATCH_SCHEMA },
    details: {
      type: 'array',
      description: 'Per-scope overview returned by action "list".',
      items: {
        type: 'object',
        properties: {
          scope: { type: 'string' },
          exists: { type: 'boolean' },
          bytes: { type: 'integer' },
          path: { type: 'string' },
          /** 以下五项只有 project 带（v8 §V8.7 分层概览）；缺省时整个键不出现。 */
          /** 常驻层（tier:core，含未标 tier 的存量条目）条数。 */
          coreEntries: { type: 'integer' },
          /** 冷层（tier:cold）条数。 */
          coldEntries: { type: 'integer' },
          /** 被条目实际使用的主题数。 */
          topics: { type: 'integer' },
          /** 常驻正文实际占用的字节（渲染层就位后才给）。 */
          coreBytes: { type: 'integer' },
          /** 主题目录实际占用的字节（渲染层就位后才给）。 */
          indexBytes: { type: 'integer' },
        },
        required: ['scope', 'exists', 'bytes', 'path'],
        additionalProperties: false,
      },
    },
    report: { type: 'object', description: 'Digest run record.', additionalProperties: true },
    error: { type: 'string', description: 'Failure detail.' },
    code: { type: 'string', description: 'Stable failure code.' },
    message: {
      type: 'string',
      description: 'Human readable hint shown when the whole plugin is switched off (code PLUGIN_DISABLED).',
    },
  },
  required: ['ok', 'action'],
  additionalProperties: false,
}

/** 把任意错误对象渲染成可读文本。 */
function renderError(error) {
  try {
    if (error instanceof Error) return error.message
    return String(error)
  } catch {
    return '<unrenderable error>'
  }
}

/** 把内容规范成条目正文：CRLF 归一、去首尾空行。 */
function normalizeBody(raw) {
  if (typeof raw !== 'string') return ''
  return raw.replace(/\r\n?/gu, '\n').replace(/^\n+/u, '').replace(/\s+$/u, '')
}

/**
 * 把 reason 收敛成可写进条目元数据行的单段标签。
 *
 * `document.js` 的头行模板已经是 `source:<source>`，所以这里绝不能返回带
 * 冒号的值（否则写出 `source:tool:xxx` 双冒号）。空格、冒号、点号等一律
 * 折叠成 `-` 并去重，长度上限 60，保证头部单行、易于 grep。
 *
 * @param {unknown} reason - 模型提供的写入原因。
 * @returns {string} 形如 `tool-user-request` 的标签；无有效字符时返回 `tool`。
 */
function normalizeReason(reason) {
  if (typeof reason !== 'string') return 'tool'
  const slug = reason
    .trim()
    .slice(0, 60)
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
  return slug === '' ? 'tool' : `tool-${slug}`
}

/** 构造带错误码的失败结果。 */
function fail(action, error, code, scope) {
  return { ok: false, action, ...(scope === undefined ? {} : { scope }), error, code }
}

/** 把 store 的失败返回值转成工具失败结果。 */
function failFromStore(action, result, fallbackCode, scope) {
  const message = typeof result?.message === 'string' ? result.message : 'write failed'
  const code = typeof result?.code === 'string' ? result.code : fallbackCode
  return fail(action, message, code, scope)
}

/**
 * 总开关关闭时的统一返回值。
 *
 * 这是一条**正常返回**而非异常：模型要能看到「插件已关闭」这个事实，
 * 而不是让工具调用崩掉。action 仍然回显，保持输出 schema 的 required 约束。
 *
 * @param {string} action - 请求的 action（空串时回显 `'unknown'`）。
 * @returns {object} `{ ok: false, action, code: 'PLUGIN_DISABLED', message }`。
 */
function disabledResult(action) {
  return {
    ok: false,
    action: action === '' ? 'unknown' : action,
    code: 'PLUGIN_DISABLED',
    message: DISABLED_MESSAGE,
  }
}

/**
 * 安装 `memory` 工具。
 *
 * @param {object} ctx - cordis Context。
 * @param {object} deps - 由 lib/index.js 注入（store / resolveScope / runDigest / logger）。
 * @returns {() => void} dispose（服务缺失时为空 dispose）。
 */
export function installTools(ctx, deps) {
  const tools = (() => {
    try {
      return ctx.get('tools')
    } catch {
      return undefined
    }
  })()
  if (tools === undefined || tools === null || typeof tools.register !== 'function') return () => {}

  const store = deps.store

  /** 解析本次调用的 persona / projectRoot。 */
  async function resolveTargets(agent) {
    const scope = await deps.resolveScope?.(agent)
    const persona =
      typeof scope?.persona === 'string' && scope.persona !== ''
        ? scope.persona
        : typeof scope?.presetId === 'string' && scope.presetId !== ''
          ? scope.presetId
          : 'default'
    return {
      persona,
      presetId: persona, // v1 兼容字段
      projectRoot: typeof scope?.projectRoot === 'string' ? scope.projectRoot : undefined,
    }
  }

  /**
   * 分区名 → store 的 ref。用数组白名单校验，
   * 任何多余字符（`../`、绝对路径、未知名字）都在这里被拒绝。
   */
  function refFor(scopeName, targets) {
    if (!SCOPES.includes(scopeName)) {
      const error = new Error(`unknown scope ${JSON.stringify(scopeName)}; expected one of ${SCOPES.join(', ')}`)
      error.code = 'BAD_INPUT'
      throw error
    }
    if (scopeName !== 'project') return { kind: scopeName, persona: targets.persona ?? targets.presetId }
    if (typeof targets.projectRoot !== 'string' || targets.projectRoot === '') {
      const error = new Error('project scope is unavailable: the current project root could not be resolved')
      error.code = 'BAD_INPUT'
      throw error
    }
    return { kind: 'project', projectRoot: targets.projectRoot }
  }

  /** 读一份文档；失败记日志并返回 undefined。 */
  async function readDocOrLog(ref, label) {
    try {
      const doc = await store.readDoc(ref)
      return doc === undefined || doc === null ? undefined : doc
    } catch (error) {
      deps.logger?.warn?.('supermemory: readDoc(%s) failed: %o', label, error)
      return undefined
    }
  }

  /** 取文档路径（纯展示用，失败返回空串）。 */
  function safeDocPath(ref) {
    try {
      const value = store.docPath?.(ref)
      return typeof value === 'string' ? value : ''
    } catch {
      return ''
    }
  }

  /** 热度存储：默认进程内共享（与预取同一个实例，否则两份内存互相覆盖文件）。 */
  const usage = deps.usage ?? getSharedUsageStore({ docPathRef: store.docPath, logger: deps.logger })

  /**
   * 项目记忆**全部** md 的读取器（契约 §V8.7：检索范围从单文件扩为一整个目录）。
   *
   * 与动态预取共用同一个实现（tools-search.js），两条链路看到的文档集合必须一致，
   * 否则「搜得到但预取不到」这种差异根本没法向用户解释。store 不支持枚举时它自己
   * 退回只读主文件并 warn 一次。
   */
  const readProjectDocsOf = createProjectDocReader({ store, logger: deps.logger })

  /** 分区的展示文件名（命中项的 `file`）。 */
  function docNameFor(scopeName, ref) {
    const path = safeDocPath(ref)
    if (path !== '') return basename(path)
    return DOC_NAMES[scopeName] ?? `${scopeName}.md`
  }

  /**
   * 项目记忆的分层字节（契约 §V8.7「各段字节」）。
   *
   * 渲染层的 `buildProjectSection` 还没就位时（A 在途）整个键省略而不是报 0——
   * 报 0 会被读成「常驻层一个字节都没有」。`bytes` 的口径契约里没定死，
   * 因此单个数字与 `{ core, index }` 两种形态都认。
   *
   * @param {string} projectRoot - 项目根。
   * @param {string} projectName - 项目名（渲染标题用）。
   * @param {string} text - 项目主记忆文档原文。
   * @returns {Record<string, number>} 可并入 details 的字节字段（可能为空对象）。
   */
  function projectSectionBytes(projectRoot, projectName, text) {
    const build = deps.render?.buildProjectSection ?? buildProjectSection
    if (typeof build !== 'function' || text === '') return {}
    try {
      const config = deps.getConfig?.() ?? {}
      const built = build({
        text,
        projectName,
        usage: usage?.peek?.(projectRoot),
        coreMaxBytes: config.projectCoreMaxBytes,
        indexMaxBytes: config.projectIndexMaxBytes,
      })
      // `bytes` 的单一形状 `{ total, core, index }`（契约 V8.15 第 18 条，渲染层已钉死）。
      // 这里刻意**不做**「数字或对象都兼容」的读取：那种兼容分支会把口径分歧永远藏起来，
      // 面板与 list 各猜一半，出错时没人知道是哪一边错。形状对不上就是不报，宁缺。
      const bytes = built?.bytes
      const out = {}
      if (Number.isFinite(bytes?.core)) out.coreBytes = Math.max(0, Math.floor(bytes.core))
      if (Number.isFinite(bytes?.index)) out.indexBytes = Math.max(0, Math.floor(bytes.index))
      return out
    } catch (error) {
      deps.logger?.warn?.('supermemory: buildProjectSection failed: %o', error)
      return {}
    }
  }

  /** `list`：四个分区的概览。 */
  async function doList(targets) {
    const lines = ['Memory scopes:']
    const details = []
    for (const scopeName of SCOPES) {
      let ref
      try {
        ref = refFor(scopeName, targets)
      } catch (error) {
        lines.push(`- ${scopeName}: unavailable (${renderError(error)})`)
        continue
      }
      let stats
      try {
        stats = await store.stats?.(ref)
      } catch {
        stats = undefined
      }
      const exists = stats?.exists === true
      const bytes = Number.isFinite(stats?.bytes) ? stats.bytes : 0
      lines.push(`- ${scopeName}: ${exists ? `${bytes} bytes` : 'empty'}`)
      const detail = { scope: scopeName, exists, bytes, path: safeDocPath(ref) }
      if (scopeName === 'project') {
        // v8：项目记忆是一整个目录，条数按全部 md 汇总（契约 §V8.7）。
        const docs = await readProjectDocsOf(targets.projectRoot)
        const tiers = countTiers(docs)
        const mainDoc = docs.find((doc) => doc.name === DOC_NAMES.project)
        Object.assign(detail, projectSectionBytes(targets.projectRoot, projectDisplayName(targets.projectRoot), mainDoc?.text ?? ''))
        detail.coreEntries = tiers.core
        detail.coldEntries = tiers.cold
        detail.topics = tiers.topics.length
        lines.push(`    resident core ${tiers.core} / cold ${tiers.cold} / topics ${tiers.topics.length}`)
      }
      details.push(detail)
    }
    lines.push('', 'Use action "read" with a scope to get its full text, or "search" with a query.')
    return { ok: true, action: 'list', text: lines.join('\n'), details }
  }

  /** `read`：读一个分区的全文。 */
  async function doRead(args, targets) {
    const scopeName = typeof args.scope === 'string' ? args.scope : 'global'
    const ref = refFor(scopeName, targets)
    const doc = await readDocOrLog(ref, scopeName)
    if (doc === undefined) return fail('read', 'read failed', 'READ_FAILED', scopeName)
    const content = typeof doc.content === 'string' ? doc.content : ''
    return { ok: true, action: 'read', scope: scopeName, text: content, bytes: byteLength(content) }
  }

  /**
   * 记一次检索热度（契约 §V8.10 的两个记录点之一；另一个是 pre-step 的预取命中）。
   *
   * 主键是 topic：条目 id 会随整编重写正文而换代，只记 id 等于每次整编都把历史清零。
   * 热度只是排序优化，任何失败都不能连带影响检索结果，所以整段包在 try 里。
   *
   * @param {string} projectRoot - 项目根。
   * @param {Array<{ topic?: string, id?: string }>} hits - 项目记忆的命中项。
   * @returns {Promise<void>} 累加完成（内存操作；达阈值时才顺带落盘）。
   */
  function noteUsage(projectRoot, hits) {
    try {
      const topics = []
      const entries = []
      for (const hit of hits) {
        if (typeof hit?.topic === 'string' && hit.topic !== '' && !topics.includes(hit.topic)) {
          topics.push(hit.topic)
        }
        if (typeof hit?.id === 'string' && hit.id !== '') entries.push(hit.id)
      }
      if (topics.length === 0 && entries.length === 0) return Promise.resolve()
      return Promise.resolve(usage?.record?.(projectRoot, { topics, entries })).catch(() => {})
    } catch (error) {
      deps.logger?.warn?.('supermemory: usage record failed: %o', error)
      return Promise.resolve()
    }
  }

  /** `search`：分词加权检索一个或全部区（只读，project 不可用时静默跳过）。 */
  async function doSearch(args, targets) {
    if (typeof args.query !== 'string' || args.query.trim() === '') {
      return fail('search', 'query is required for action "search"', 'BAD_INPUT')
    }
    const needle = args.query.trim()
    // 切不出词元（单字、纯符号）时退回整串子串匹配，行为与升级前一致。
    const terms = queryTerms(needle)
    const scopeName = typeof args.scope === 'string' ? args.scope : undefined
    const wanted = scopeName === undefined ? SCOPES : [scopeName]

    const matches = []
    for (const name of wanted) {
      let ref
      try {
        ref = refFor(name, targets)
      } catch {
        continue
      }
      // project 是「一个目录的多篇 md」：踩坑记录这类文件就躺在目录里，
      // 只查主文件等于让最该被查的东西不可查（契约 §V8.6）。
      if (name === 'project') {
        const docs = await readProjectDocsOf(targets.projectRoot)
        const hits = searchProjectDocs(docs, { terms, needle, limit: MAX_MATCHES })
        for (const hit of hits) {
          matches.push({
            scope: 'project',
            line: hit.line,
            text: hit.text,
            score: Number.isFinite(hit.score) ? hit.score : 0,
            tier: hit.tier,
            topic: hit.topic,
            file: hit.file,
          })
        }
        await noteUsage(targets.projectRoot, hits)
        continue
      }
      const doc = await readDocOrLog(ref, name)
      if (doc === undefined || typeof doc.content !== 'string') continue
      const hits = terms.length === 0
        ? literalLines(doc.content, needle, MAX_MATCHES)
        : scoredLines(doc.content, terms, MAX_MATCHES)
      const file = docNameFor(name, ref)
      // score 必须是有限数：NaN 不属于 JSON Schema 的 number，一个 NaN 就能让
      // 宿主把整份输出判非法，连带丢掉全部命中。
      for (const hit of hits) {
        const score = Number.isFinite(hit.score) ? hit.score : 0
        matches.push({ scope: name, line: hit.line, text: hit.text, score, tier: 'core', topic: '', file })
      }
    }
    // 各分区内部已按分数截断过，这里再全局排序：中文二元组会带来大量低分噪音，
    // 若沿用「先扫到的分区占满名额」，高分命中可能被低分噪音挤出结果。
    matches.sort(
      (a, b) =>
        b.score - a.score ||
        SCOPES.indexOf(a.scope) - SCOPES.indexOf(b.scope) ||
        a.line - b.line ||
        a.file.localeCompare(b.file),
    )
    if (matches.length > MAX_MATCHES) matches.length = MAX_MATCHES
    const text = matches.length === 0
      ? `No match for ${JSON.stringify(args.query)}.`
      : [`${matches.length} match(es) for ${JSON.stringify(args.query)}:`]
        .concat(matches.map((hit) => `- [${hit.scope}:${hit.file}:${hit.line}] ${hit.text}`))
        .join('\n')
    return { ok: true, action: 'search', ...(scopeName === undefined ? {} : { scope: scopeName }), text, matches }
  }

  /** 校验写入内容，返回错误结果或正文。 */
  function requireContent(args, action, scopeName) {
    const body = normalizeBody(args.content)
    if (body === '') return { error: fail(action, 'content is required for action "' + action + '"', 'BAD_INPUT', scopeName) }
    if (byteLength(body) > MAX_CONTENT_BYTES) {
      return {
        error: fail(action, `content exceeds the ${MAX_CONTENT_BYTES} byte limit`, 'BAD_INPUT', scopeName),
      }
    }
    return { body }
  }

  /**
   * soul 写保护：人格只能用户手动改，或用户明确要求时由 agent 写。
   * 没有 `confirmSoul: true` 一律拒绝。
   * @param {object} args - 工具参数。
   * @param {string} action - 'append' | 'replace'。
   * @param {string} scopeName - 目标 scope。
   * @returns {object|undefined} 拒绝时的失败结果；放行返回 undefined。
   */
  function guardSoulWrite(args, action, scopeName) {
    if (scopeName !== 'soul') return undefined
    if (args?.confirmSoul === true) return undefined
    return {
      ...fail(action, 'Persona (soul) belongs to the user and is never changed automatically.', 'SOUL_CONFIRM_REQUIRED', scopeName),
      text: 'Persona (soul) belongs to the user. Retry with confirmSoul: true only if the user explicitly asked to change it.',
    }
  }

  /** `append`：追加一条条目。 */
  async function doAppend(args, targets) {
    const scopeName = typeof args.scope === 'string' ? args.scope : 'global'
    const checked = requireContent(args, 'append', scopeName)
    if (checked.error !== undefined) return checked.error
    const guarded = guardSoulWrite(args, 'append', scopeName)
    if (guarded !== undefined) return guarded

    const ref = refFor(scopeName, targets)
    /**
     * 落哪个分层（契约 §V8.7 + §V8.15 裁决 5）。
     *
     * - **默认 `cold`**：常驻预算有限，模型主动记的东西绝大多数不该每轮都占上下文；
     *   冷层条目全量留在盘上，被 search / 预取命中时才进快照。只有主人明确要求
     *   「必须始终知道」，模型才该传 `tier:"core"`。
     * - **只对 project 生效**：soul / user / global 没有分层语义，写了 tier 注入层
     *   根本不感知。这里**忽略且不回错误**——回错误会让模型以为参数有意义，
     *   收下反而更误导（让它以为自己把这条折进了冷层）。
     */
    const tier = scopeName === 'project' ? (args.tier === 'core' ? 'core' : 'cold') : ''
    let result
    try {
      result = await store.appendEntries(ref, [
        { time: new Date().toISOString(), source: normalizeReason(args.reason), body: checked.body, ...(tier === '' ? {} : { tier }) },
      ])
    } catch (error) {
      deps.logger?.warn?.('supermemory: appendEntries(%s) threw: %o', scopeName, error)
      return fail('append', renderError(error), 'WRITE_FAILED', scopeName)
    }
    if (result?.ok !== true) return failFromStore('append', result, 'WRITE_FAILED', scopeName)
    const bytes = Number.isFinite(result.bytes) ? result.bytes : 0
    const tierNote = tier === ''
      ? ''
      : tier === 'core'
        ? ' (tier core: resident in context every turn)'
        : ' (tier cold: stays on disk, pulled in when search or the prefetch hits it)'
    return {
      ok: true,
      action: 'append',
      scope: scopeName,
      text: `Appended 1 entry to ${scopeName} memory (${bytes} bytes)${tierNote}.`,
      bytes,
      entries: 1,
    }
  }

  /** `replace`：整体覆盖一个分区（STALE 时重读重试一次）。 */
  async function doReplace(args, targets) {
    const scopeName = typeof args.scope === 'string' ? args.scope : 'global'
    const checked = requireContent(args, 'replace', scopeName)
    if (checked.error !== undefined) return checked.error
    const guarded = guardSoulWrite(args, 'replace', scopeName)
    if (guarded !== undefined) return guarded

    const ref = refFor(scopeName, targets)
    const nextContent = `${checked.body}\n`
    let lastFailure
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const doc = await readDocOrLog(ref, scopeName)
      if (doc === undefined) return fail('replace', 'read failed', 'READ_FAILED', scopeName)
      let result
      try {
        result = await store.writeDoc(ref, nextContent, { expectedMtimeMs: doc.mtimeMs })
      } catch (error) {
        deps.logger?.warn?.('supermemory: writeDoc(%s) threw: %o', scopeName, error)
        return fail('replace', renderError(error), 'WRITE_FAILED', scopeName)
      }
      if (result?.ok === true) {
        const bytes = Number.isFinite(result.bytes) ? result.bytes : 0
        return { ok: true, action: 'replace', scope: scopeName, text: `Replaced ${scopeName} memory (${bytes} bytes).`, bytes }
      }
      lastFailure = result
      if (result?.code !== 'STALE') break
    }
    return failFromStore('replace', lastFailure, 'WRITE_FAILED', scopeName)
  }

  /** `digest`：跑一次整理。 */
  async function doDigest(exec) {
    let report
    try {
      report = await deps.runDigest?.({ agent: exec?.agent, trigger: 'tool' })
    } catch (error) {
      deps.logger?.warn?.('supermemory: runDigest failed: %o', error)
      return fail('digest', renderError(error), 'DIGEST_FAILED')
    }
    if (report === undefined || report === null) {
      return fail('digest', 'digest runner unavailable', 'DIGEST_UNAVAILABLE')
    }
    const ok = report.ok === true
    const counts = report.counts ?? {}
    const written = SCOPES.map((name) => (Number.isFinite(counts[name]) ? counts[name] : 0))
    const total = written.reduce((sum, value) => sum + value, 0)
    if (!ok) {
      const detail = typeof report.error === 'string' ? report.error : 'digest failed'
      return { ...fail('digest', detail, 'DIGEST_FAILED'), report }
    }
    return {
      ok: true,
      action: 'digest',
      text: `Digest finished: ${total} new entr${total === 1 ? 'y' : 'ies'} `
        + `(soul ${written[0]}, user ${written[1]}, global ${written[2]}, project ${written[3]}).`,
      report,
    }
  }

  /** 工具入口：分派到具体 action，任何异常都收敛成 ok:false。 */
  async function execute(args, exec) {
    const action = typeof args?.action === 'string' ? args.action : ''
    // 总开关关闭：任何 action 都不执行，直接回一句提示（绝不抛异常）。
    if (deps.isEnabled?.() === false) return disabledResult(action)
    try {
      if (action === 'digest') return await doDigest(exec)
      const targets = await resolveTargets(exec?.agent)
      switch (action) {
        case 'list': return await doList(targets)
        case 'read': return await doRead(args, targets)
        case 'search': return await doSearch(args, targets)
        case 'append': return await doAppend(args, targets)
        case 'replace': return await doReplace(args, targets)
        default:
          return fail(
            action === '' ? 'unknown' : action,
            `unknown action ${JSON.stringify(action)}; expected one of list, read, search, append, replace, digest`,
            'BAD_INPUT',
          )
      }
    } catch (error) {
      deps.logger?.warn?.('supermemory: memory tool failed: %o', error)
      const code = typeof error?.code === 'string' ? error.code : 'INTERNAL'
      return fail(action === '' ? 'unknown' : action, renderError(error), code)
    }
  }

  try {
    const disposer = tools.register({
      name: 'memory',
      description: DESCRIPTION,
      parameters: PARAMETERS,
      output: {
        schema: OUTPUT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute,
      isConcurrencySafe: () => false,
    })
    return typeof disposer === 'function' ? disposer : () => {}
  } catch (error) {
    deps.logger?.warn?.('supermemory: memory tool registration failed: %o', error)
    return () => {}
  }
}
