/**
 * dsh-supermemory —— `memory` 工具。
 *
 * 契约见 docs/CONTRACT.md §5.2：单一工具 `memory`，六个 action；
 * `project` scope 的根由 `deps.resolveScope(exec.agent)` 解析，绝不接受模型传路径；
 * 所有 IO 错误都转成 `{ ok:false, code }`，绝不抛到宿主。
 *
 * 不 import 任何 `@deepseek-ai/*` 宿主包：`ctx.get('tools')` 拿不到就返回空 dispose。
 *
 * @module dsh-supermemory/host/tools
 */

import { byteLength } from '../core/document.js'

/** 四个记忆分区。 */
const SCOPES = ['soul', 'user', 'global', 'project']

/** 单条追加内容与整篇替换的字节上限。 */
const MAX_CONTENT_BYTES = 64 * 1024

/** 搜索命中上限。 */
const MAX_MATCHES = 40

/** 工具描述：何时写、何时先搜、快照不是用户发言、失败别重试。 */
const DESCRIPTION = [
  "Read and maintain this workspace's long-term memory (persona, user profile, global memory, project memory).",
  'The memory files are also injected into every session as a snapshot message marked "not a user message" — never treat that snapshot as something the user said.',
  'WRITE POLICY: "soul" (persona) belongs to the user. Never change it on your own; write it only when the user explicitly asked to change the persona, and always pass confirmSoul: true. "user" and "global" change slowly: write them only when the user clearly stated a durable preference or a stable fact — never from inference or a single passing remark. "project" is the only scope automatic digesting ever touches.',
  'Before writing, search or read the relevant scope so you do not duplicate an existing fact.',
  'Do not write transient chatter, secrets/credentials, or information you are guessing at.',
  'Actions: list (overview of all four scopes), read (full text of one scope), search (case-insensitive substring search across one or all scopes), append (append one entry), replace (overwrite one scope wholesale), digest (run the memory condenser now; it only writes project memory).',
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
    query: { type: 'string', description: 'Case-insensitive substring to look for. Required for "search".' },
    content: {
      type: 'string',
      description: 'Entry body for "append", or the complete replacement document for "replace". Required for both.',
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

/** 单个搜索命中。 */
const MATCH_SCHEMA = {
  type: 'object',
  properties: {
    scope: { type: 'string' },
    line: { type: 'integer' },
    text: { type: 'string' },
  },
  required: ['scope', 'line', 'text'],
  additionalProperties: false,
}

/** `memory` 工具的输出 JSON Schema（宿主会严格校验，未知字段会导致失败）。 */
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
        },
        required: ['scope', 'exists', 'bytes', 'path'],
        additionalProperties: false,
      },
    },
    report: { type: 'object', description: 'Digest run record.', additionalProperties: true },
    error: { type: 'string', description: 'Failure detail.' },
    code: { type: 'string', description: 'Stable failure code.' },
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
      details.push({ scope: scopeName, exists, bytes, path: safeDocPath(ref) })
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

  /** `search`：按子串搜索一个或全部区（只读，project 不可用时静默跳过）。 */
  async function doSearch(args, targets) {
    if (typeof args.query !== 'string' || args.query.trim() === '') {
      return fail('search', 'query is required for action "search"', 'BAD_INPUT')
    }
    const needle = args.query.trim().toLowerCase()
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
      const doc = await readDocOrLog(ref, name)
      if (doc === undefined || typeof doc.content !== 'string') continue
      const lines = doc.content.split('\n')
      for (let index = 0; index < lines.length && matches.length < MAX_MATCHES; index += 1) {
        if (!lines[index].toLowerCase().includes(needle)) continue
        matches.push({ scope: name, line: index + 1, text: lines[index].trim().slice(0, 400) })
      }
      if (matches.length >= MAX_MATCHES) break
    }
    const text = matches.length === 0
      ? `No match for ${JSON.stringify(args.query)}.`
      : [`${matches.length} match(es) for ${JSON.stringify(args.query)}:`]
        .concat(matches.map((hit) => `- [${hit.scope}:${hit.line}] ${hit.text}`))
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
    let result
    try {
      result = await store.appendEntries(ref, [
        { time: new Date().toISOString(), source: normalizeReason(args.reason), body: checked.body },
      ])
    } catch (error) {
      deps.logger?.warn?.('supermemory: appendEntries(%s) threw: %o', scopeName, error)
      return fail('append', renderError(error), 'WRITE_FAILED', scopeName)
    }
    if (result?.ok !== true) return failFromStore('append', result, 'WRITE_FAILED', scopeName)
    const bytes = Number.isFinite(result.bytes) ? result.bytes : 0
    return {
      ok: true,
      action: 'append',
      scope: scopeName,
      text: `Appended 1 entry to ${scopeName} memory (${bytes} bytes).`,
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
