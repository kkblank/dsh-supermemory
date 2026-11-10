/**
 * dsh-supermemory 自动整理执行器。
 *
 * 职责（契约 §5.4 + v2 §V2.3）：
 *   - 监听 `session/event` 的 `turn/end`，按轮数 / 上下文压力自动触发整理。
 *   - 在独立的一次 LLM 调用里把「最近对话 + 现有记忆」整理成**新增条目** JSON。
 *   - **v2 起自动整理只写 project**：soul/user/global 永不自动写（用户手动维护或
 *     经 memory 工具明确要求时写入），模型对这三个 scope 的任何输出都丢弃。
 *   - 解析后追加写回（写入前重新读 mtime，STALE 重试一次）。
 *   - 模型选择四层回退：settings.json → 配置 → 当前会话路由 → 宿主默认模型。
 *   - 同一 session 串行；结果写 `runs.jsonl`。
 *
 * 硬约束：不 import 任何 `@deepseek-ai/*` 宿主包；LLM 通过 `ctx.get('llm')` 可选获取，
 * 缺失时返回失败 RunRecord，绝不抛到宿主。
 *
 * @module dsh-supermemory/host/digest
 */

import { isAbsolute } from 'node:path'

import { byteLength } from '../core/document.js'
import { mergeDigest, parseDigestOutput } from '../core/digest.js'

/** 整理输入里最多保留的对话消息条数。 */
const MAX_TRANSCRIPT_MESSAGES = 40

/** 四类记忆的统一顺序，写盘与报告都按这个顺序。 */
const KINDS = ['soul', 'user', 'global', 'project']

/**
 * v2 允许自动整理写入的 scope 白名单。
 *
 * 契约 §V2.3：配置项 `digestWritableScopes` 默认 `['project']`，便于将来扩展；
 * 但 v2 的产品约束是「人格/画像/全局记忆不可自动修改」，因此这里把白名单**硬编码**
 * 为 project —— 即使配置里写了 soul/user/global 也不会被采用。
 */
const HARD_WRITABLE_SCOPES = new Set(['project'])

/** v2 默认的可写 scope。 */
const DEFAULT_WRITABLE_SCOPES = Object.freeze(['project'])

/**
 * 解析本次整理允许写入的 scope 列表。
 *
 * @param {object} config - ResolvedConfig。
 * @returns {string[]} 非空 scope 列表（默认 `['project']`）。
 */
function resolveWritableScopes(config) {
  const declared = Array.isArray(config?.digestWritableScopes)
    ? config.digestWritableScopes
    : DEFAULT_WRITABLE_SCOPES
  const allowed = declared.filter((kind) => typeof kind === 'string' && HARD_WRITABLE_SCOPES.has(kind))
  return allowed.length > 0 ? allowed : [...DEFAULT_WRITABLE_SCOPES]
}

/**
 * 整理器的 system 提示。
 *
 * v2：只要求输出 `{"project":[...]}`，并明确不要输出 soul/user/global。
 */
const DIGEST_SYSTEM_PROMPT = [
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
].join('\n')

/**
 * 安全获取一个可选宿主服务。
 * @param {object} ctx - cordis Context。
 * @param {string} name - 服务名。
 * @returns {unknown} 服务实例或 undefined。
 */
function optionalService(ctx, name) {
  try {
    return ctx?.get?.(name)
  } catch {
    return undefined
  }
}

/**
 * 把任意异常转成一行可读文本。
 * @param {unknown} error - 异常。
 * @returns {string} 文本。
 */
function errorText(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

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
function collectTranscript(agent, limit = MAX_TRANSCRIPT_MESSAGES) {
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
function emptyDocs() {
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
function refFor(kind, persona, projectRoot) {
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
function buildDigestInput(transcriptLines, docs, maxBytes) {
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

/**
 * 创建整理执行器。
 *
 * @param {object} ctx - cordis Context。
 * @param {object} deps - 装配层注入的依赖。
 * @param {object} deps.store - 存储层（v2 需 `readSettings()` 读面板里选的整理模型）。
 * @param {() => object} deps.getConfig - 读取最新配置。
 * @param {(agent:object) => Promise<object|undefined>} [deps.resolveScope] - 解析 agent 作用域。
 * @param {(agent:object) => object|undefined} [deps.currentRoute] - 读取当前模型路由。
 * @param {(agent:object) => boolean} [deps.isSubagent] - 判断子智能体。
 * @param {{ read?: () => object }} [deps.settings] - 设置直通（store.readSettings 缺失时的回退）。
 * @param {object} [deps.logger] - 日志。
 * @returns {{ install: () => () => void, runDigest: (request:object) => Promise<object>, dispose: () => void }}
 */
export function createDigestRunner(ctx, deps) {
  const store = deps.store
  const logger = deps.logger ?? { warn() {}, info() {} }

  /** 正在整理的 session key → Promise。 */
  const running = new Map()
  /** 自动整理的轮次计数 sessionId → number。 */
  const turnCounts = new Map()
  /** 本次插件生命周期内创建的所有 AbortController。 */
  const controllers = new Set()

  /** 安全读取最新配置。 */
  function readConfig() {
    try {
      const value = deps.getConfig?.()
      return value !== null && typeof value === 'object' ? value : {}
    } catch (error) {
      logger.warn?.('supermemory: getConfig failed: %o', error)
      return {}
    }
  }

  /** 静默追加一条运行报告。 */
  async function appendRun(record) {
    try {
      await store?.appendRun?.(record)
    } catch (error) {
      logger.warn?.('supermemory: appendRun failed: %o', error)
    }
  }

  /** 构造一条失败记录并落盘。 */
  async function fail(record, error) {
    record.ok = false
    record.error = errorText(error)
    await appendRun(record)
    return record
  }

  /** 同一 session 并发触发时的返回记录（不落盘）。 */
  function busyRecord(trigger, persona, projectRoot) {
    return {
      at: new Date().toISOString(),
      trigger,
      ok: false,
      error: '已在整理中',
      skipped: true,
      persona,
      presetId: persona,
      projectRoot,
    }
  }

  /**
   * 读取 settings.json 里保存的整理模型（面板里选的）。
   *
   * 契约 §V2.3 首选 `store.readSettings()`；同时兼容装配层提供的 `deps.settings.read`
   * 直通，以及两者都缺失 / 抛错的情况（返回空串，让后续层级接手）。
   *
   * @returns {Promise<{digestProvider:string, digestModel:string}>} 归一化后的设置。
   */
  async function readDigestSettings() {
    let reader
    if (typeof store?.readSettings === 'function') reader = () => store.readSettings()
    else if (typeof deps.settings?.read === 'function') reader = () => deps.settings.read()
    if (reader === undefined) return { digestProvider: '', digestModel: '' }
    let value
    try {
      value = await reader()
    } catch (error) {
      logger.warn?.('supermemory: readSettings failed: %o', error)
      return { digestProvider: '', digestModel: '' }
    }
    return {
      digestProvider: typeof value?.digestProvider === 'string' ? value.digestProvider : '',
      digestModel: typeof value?.digestModel === 'string' ? value.digestModel : '',
    }
  }

  /**
   * 判断一条路由是否「provider 与 model 同时非空」。
   * @param {unknown} route - 候选路由。
   * @returns {{provider:string, model:string}|undefined} 合法路由。
   */
  function completeRoute(route) {
    if (route === null || typeof route !== 'object') return undefined
    const provider = typeof route.provider === 'string' ? route.provider.trim() : ''
    const model = typeof route.model === 'string' ? route.model.trim() : ''
    if (provider === '' || model === '') return undefined
    return { provider, model }
  }

  /**
   * 解析本次整理使用的 provider/model（契约 §V2.3 四层优先级）。
   *
   * 1. `store.readSettings()`（面板里选的）
   * 2. `getConfig().digestProvider/digestModel`（cordis.patch.yml）
   * 3. `deps.currentRoute(agent)`（当前会话路由）
   * 4. `ctx.get('agentDefaultModel').currentSelection()`（宿主默认模型）
   *
   * 任一层 provider 与 model 必须**同时非空**才采用，不再跨层拼装。
   *
   * @param {object|undefined} agent - 宿主 Agent。
   * @param {object} config - ResolvedConfig。
   * @returns {Promise<{provider:string, model:string}|undefined>} 路由。
   */
  async function resolveRoute(agent, config) {
    // 1) settings.json
    const stored = await readDigestSettings()
    const fromSettings = completeRoute({ provider: stored.digestProvider, model: stored.digestModel })
    if (fromSettings !== undefined) return fromSettings

    // 2) 插件配置
    const fromConfig = completeRoute({ provider: config?.digestProvider, model: config?.digestModel })
    if (fromConfig !== undefined) return fromConfig

    // 3) 当前会话路由
    try {
      const route = await deps.currentRoute?.(agent)
      const fromAgent = completeRoute(route)
      if (fromAgent !== undefined) return fromAgent
    } catch (error) {
      logger.warn?.('supermemory: currentRoute failed: %o', error)
    }

    // 4) 宿主默认模型
    try {
      const selection = await optionalService(ctx, 'agentDefaultModel')?.currentSelection?.()
      const fromDefault = completeRoute(selection)
      if (fromDefault !== undefined) return fromDefault
    } catch (error) {
      logger.warn?.('supermemory: agentDefaultModel failed: %o', error)
    }
    return undefined
  }

  /**
   * 解析本次整理的作用域：优先用 agent 的真实 scope，其次用调用参数。
   *
   * v2 的隔离键是 `persona`；请求体里可能仍带旧字段 `presetId`，两者都接受，
   * 但 `persona` 优先。
   *
   * @param {object} request - runDigest 请求。
   * @returns {Promise<{persona:string, projectRoot:string|undefined}>} 作用域。
   */
  async function resolveScopeOf(request) {
    let persona =
      typeof request.persona === 'string' && request.persona !== ''
        ? request.persona
        : typeof request.presetId === 'string'
          ? request.presetId
          : ''
    let projectRoot = typeof request.projectRoot === 'string' ? request.projectRoot : ''
    if (request.agent !== undefined && typeof deps.resolveScope === 'function') {
      try {
        const scope = await deps.resolveScope(request.agent)
        if (scope !== undefined && scope !== null) {
          const fromScope =
            typeof scope.persona === 'string' && scope.persona !== ''
              ? scope.persona
              : typeof scope.presetId === 'string'
                ? scope.presetId
                : ''
          if (fromScope !== '') persona = fromScope
          if (typeof scope.projectRoot === 'string' && scope.projectRoot !== '') projectRoot = scope.projectRoot
        }
      } catch (error) {
        logger.warn?.('supermemory: resolveScope failed for digest: %o', error)
      }
    }
    if (persona === '') persona = 'default'
    return { persona, projectRoot: projectRoot === '' ? undefined : projectRoot }
  }

  /**
   * 调一次 LLM 流，收集 text-delta。
   * @param {object} params - provider / model / system / input / maxTokens / signal / sessionId。
   * @returns {Promise<string>} 模型输出文本。
   */
  async function callModel(params) {
    const llm = optionalService(ctx, 'llm')
    if (llm === undefined || llm === null || typeof llm.stream !== 'function') {
      throw new Error('llm service unavailable')
    }
    if (params.signal?.aborted) throw new Error('digest aborted')
    const stream = llm.stream({
      provider: params.provider,
      model: params.model,
      system: DIGEST_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: [{ type: 'text', text: params.input }] }],
      maxTokens: params.maxTokens,
      signal: params.signal,
      sessionId: params.sessionId,
    })
    let text = ''
    let failure
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
        text += chunk.text
      } else if (chunk?.type === 'finish') {
        const kind = chunk.reason?.kind
        if (kind === 'error' || kind === 'aborted') {
          failure = chunk.reason?.failure?.message ?? kind
        }
        break
      }
    }
    if (failure !== undefined) throw new Error(failure)
    if (params.signal?.aborted) throw new Error('digest aborted')
    return text
  }

  /**
   * 调用一次并解析；首次解析失败时用同参数重试一次。
   * @param {object} params - callModel 参数。
   * @returns {Promise<{ok:true, entries:object}|{ok:false, error:string}>} 解析结果。
   */
  async function requestEntries(params) {
    let lastError = ''
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let raw
      try {
        raw = await callModel(params)
      } catch (error) {
        lastError = errorText(error)
        // LLM 服务缺失 / 被取消不再重试。
        if (lastError === 'llm service unavailable' || lastError.includes('aborted')) break
        continue
      }
      const parsed = parseDigestOutput(raw)
      if (parsed?.ok === true) {
        const entries = parsed.entries ?? {}
        return {
          ok: true,
          entries: {
            soul: Array.isArray(entries.soul) ? entries.soul : [],
            user: Array.isArray(entries.user) ? entries.user : [],
            global: Array.isArray(entries.global) ? entries.global : [],
            project: Array.isArray(entries.project) ? entries.project : [],
          },
        }
      }
      lastError = String(parsed?.error ?? 'digest output is not valid JSON')
    }
    return { ok: false, error: lastError }
  }

  /**
   * 把一批条目追加进一个文件：写前重读 mtime，STALE 再试一次。
   * @param {string} kind - 记忆类别。
   * @param {object} ref - store ref。
   * @param {string[]} items - 新增条目。
   * @param {string} time - 统一时间戳。
   * @returns {Promise<{ok:true, before:number, after:number}|{ok:false, error:string}>} 写入结果。
   */
  async function writeKind(kind, ref, items, time) {
    if (typeof store?.readDoc !== 'function' || typeof store?.writeDoc !== 'function') {
      return { ok: false, error: 'store readDoc/writeDoc unavailable' }
    }
    let lastError = 'write failed'
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let current
      try {
        current = await store.readDoc(ref)
      } catch (error) {
        return { ok: false, error: errorText(error) }
      }
      const docs = emptyDocs()
      docs[kind] = String(current?.content ?? '')
      let merged
      try {
        merged = mergeDigest(docs, { soul: [], user: [], global: [], project: [], [kind]: items }, { time, source: 'digest' })
      } catch (error) {
        return { ok: false, error: errorText(error) }
      }
      const nextText = String(merged?.[kind] ?? docs[kind])
      let result
      try {
        result = await store.writeDoc(ref, nextText, { expectedMtimeMs: current?.mtimeMs })
      } catch (error) {
        return { ok: false, error: errorText(error) }
      }
      if (result?.ok === true) {
        return {
          ok: true,
          before: Number.isFinite(current?.bytes) ? current.bytes : byteLength(current?.content),
          after: Number.isFinite(result?.bytes) ? result.bytes : byteLength(nextText),
        }
      }
      if (result?.code !== 'STALE') {
        return { ok: false, error: String(result?.message ?? result?.code ?? 'write failed') }
      }
      lastError = 'file changed externally (STALE)'
    }
    return { ok: false, error: lastError }
  }

  /**
   * 执行一次整理（调用方已保证同一 session 串行）。
   * @param {object} request - runDigest 请求。
   * @param {string} trigger - 触发源。
   * @param {string|undefined} sessionId - 会话 id。
   * @param {AbortController} controller - 本次的取消控制器。
   * @returns {Promise<object>} RunRecord。
   */
  async function execute(request, trigger, sessionId, controller) {
    const config = readConfig()
    const writableScopes = resolveWritableScopes(config)
    const { persona, projectRoot } = await resolveScopeOf(request)
    const record = {
      at: new Date().toISOString(),
      sessionId: sessionId === undefined ? undefined : String(sessionId),
      trigger,
      ok: false,
      persona,
      presetId: persona, // 兼容字段：v1 的 RunRecord / 面板仍读 presetId
      projectRoot,
    }

    const llm = optionalService(ctx, 'llm')
    if (llm === undefined || llm === null || typeof llm.stream !== 'function') {
      return fail(record, 'llm service unavailable')
    }

    // v2 §V2.3：settings.json → 配置 → 当前会话路由 → 宿主默认模型。
    const route = await resolveRoute(request.agent, config)
    if (route === undefined) return fail(record, 'llm route unavailable')
    const provider = route.provider
    const model = route.model

    // 1) 读四份现有记忆（project 无合法根时留空）。soul/user/global 只作为去重上下文输入。
    const docs = emptyDocs()
    const refs = {}
    for (const kind of KINDS) {
      const ref = refFor(kind, persona, projectRoot)
      if (ref === undefined) continue
      refs[kind] = ref
      try {
        const doc = await store?.readDoc?.(ref)
        docs[kind] = String(doc?.content ?? '')
      } catch (error) {
        logger.warn?.('supermemory: readDoc failed for %s: %o', kind, error)
      }
    }

    // 2) 组装输入（对话 + 现有记忆，超预算从旧到新截断）。
    const transcriptLines = collectTranscript(request.agent)
    const input = buildDigestInput(transcriptLines, docs, config.digestMaxInputBytes)

    // 3) 调模型并解析；失败重试一次。
    const parsed = await requestEntries({
      provider,
      model,
      input,
      maxTokens: config.digestMaxOutputTokens,
      signal: controller.signal,
      sessionId: sessionId === undefined ? undefined : String(sessionId),
    })
    if (parsed.ok !== true) {
      return fail(record, `digest output parse failed: ${parsed.error}`)
    }

    // 4) v2 写入范围收窄：只有 writableScopes 里的 scope 会被写回，
    //    模型对 soul/user/global 的任何输出在这里被丢弃。
    const entries = { soul: [], user: [], global: [], project: [] }
    for (const kind of writableScopes) {
      const picked = parsed.entries[kind]
      if (Array.isArray(picked)) entries[kind] = picked
    }

    // 5) 逐文件写回；counts 的四个 key 保留，非 writable scope 恒为 0。
    const time = new Date().toISOString()
    const counts = { soul: 0, user: 0, global: 0, project: 0 }
    const bytesBefore = {}
    const bytesAfter = {}
    const errors = []
    for (const kind of KINDS) {
      const items = entries[kind]
      counts[kind] = items.length
      if (items.length === 0) continue
      const ref = refs[kind]
      if (ref === undefined) {
        errors.push(`${kind}: scope unresolved`)
        continue
      }
      const written = await writeKind(kind, ref, items, time)
      if (written.ok === true) {
        bytesBefore[kind] = written.before
        bytesAfter[kind] = written.after
      } else {
        errors.push(`${kind}: ${written.error}`)
      }
    }
    record.counts = counts
    if (Object.keys(bytesBefore).length > 0) record.bytesBefore = bytesBefore
    if (Object.keys(bytesAfter).length > 0) record.bytesAfter = bytesAfter
    if (errors.length > 0) {
      record.ok = false
      record.error = errors.join('; ')
    } else {
      record.ok = true
    }
    await appendRun(record)
    return record
  }

  /**
   * 触发一次整理。同一 session 同时只跑一个。
   * @param {{agent?:object, trigger?:string, signal?:AbortSignal,
   *   persona?:string, presetId?:string, projectRoot?:string, sessionId?:string}} [request] - 请求。
   *   `presetId` 是 v1 兼容字段，`persona` 优先。
   * @returns {Promise<object>} RunRecord（并发触发返回 skipped 记录）。
   */
  async function runDigest(request = {}) {
    const trigger = typeof request.trigger === 'string' && request.trigger !== '' ? request.trigger : 'manual'
    const sessionId = request.sessionId ?? request.agent?.session?.id
    const persona = typeof request.persona === 'string' && request.persona !== '' ? request.persona : request.presetId
    const key =
      sessionId === undefined || sessionId === null
        ? `${String(persona ?? '')}\u0000${String(request.projectRoot ?? '')}`
        : String(sessionId)

    if (running.has(key)) return busyRecord(trigger, persona, request.projectRoot)

    const controller = new AbortController()
    controllers.add(controller)

    let effectDisposer
    if (typeof ctx?.effect === 'function') {
      try {
        effectDisposer = ctx.effect(() => () => {
          try {
            controller.abort()
          } catch {
            /* ignore */
          }
        })
      } catch {
        effectDisposer = undefined
      }
    }

    let detachSignal
    if (request.signal !== undefined && typeof request.signal.addEventListener === 'function') {
      const onAbort = () => {
        try {
          controller.abort()
        } catch {
          /* ignore */
        }
      }
      try {
        request.signal.addEventListener('abort', onAbort, { once: true })
        detachSignal = () => request.signal.removeEventListener('abort', onAbort)
      } catch {
        detachSignal = undefined
      }
    }

    const task = execute(request, trigger, sessionId === undefined ? undefined : String(sessionId), controller)
      .catch((error) => {
        logger.warn?.('supermemory: digest failed: %o', error)
        return {
          at: new Date().toISOString(),
          trigger,
          ok: false,
          error: errorText(error),
          skipped: false,
        }
      })
      .finally(() => {
        running.delete(key)
        controllers.delete(controller)
        try {
          detachSignal?.()
        } catch {
          /* ignore */
        }
        if (typeof effectDisposer === 'function') {
          try {
            // cordis 的 disposer 可能返回 Promise；吞掉拒绝，避免 unhandled rejection。
            const settled = effectDisposer()
            if (settled !== null && typeof settled === 'object' && typeof settled.catch === 'function') {
              settled.catch(() => {})
            }
          } catch {
            /* ignore */
          }
        }
      })

    running.set(key, task)
    return task
  }

  /**
   * 判断一次 session/event 是否可能触发自动整理。
   * @param {object} session - 会话。
   * @param {object} event - 事件。
   * @returns {boolean} 是否考虑。
   */
  function shouldConsider(session, event) {
    if (event?.type !== 'turn/end') return false
    if (event.data?.reason?.kind !== 'completed') return false
    if (session === undefined || session === null) return false
    const header = session.header
    if (header?.parentSession !== undefined) return false
    if (header?.origin === 'subagent') return false
    return true
  }

  /**
   * 计数并判断是否达到触发阈值。
   * @param {object} session - 会话。
   * @param {object} agent - 已在本轮同步取到的活 agent。
   * @returns {Promise<void>}
   */
  async function maybeTrigger(session, agent) {
    const config = readConfig()
    if (config.autoDigest === false) return
    const sessionId = session?.id
    if (sessionId === undefined || sessionId === null) return
    if (agent === undefined || agent === null) return
    try {
      if (deps.isSubagent?.(agent) === true) return
    } catch {
      return
    }

    const turns = (turnCounts.get(String(sessionId)) ?? 0) + 1
    let trigger
    const everyTurns = Number.isFinite(config.digestEveryTurns) ? Math.trunc(config.digestEveryTurns) : 0
    if (everyTurns > 0 && turns >= everyTurns) {
      trigger = 'turns'
      turnCounts.set(String(sessionId), 0)
    } else {
      turnCounts.set(String(sessionId), turns)
    }

    const meter = optionalService(ctx, 'tokenMeter')
    if (typeof meter?.contextPressure === 'function') {
      try {
        // 宿主签名是同步的（ContextPressureProjection 的 Pick）；这里 await 是**有意**的：
        // await 非 Promise 值等价于同步取值，同时兼容未来 / 第三方实现返回 Promise 的情况，
        // 且拒绝会被同一个 try/catch 收住，不会变成 unhandled rejection。
        const pressure = await meter.contextPressure(session)
        const window = Number(pressure?.contextWindow)
        const used = Number(pressure?.pressureTokens)
        if (Number.isFinite(window) && Number.isFinite(used) && window > 0 && used > 0) {
          const ratio = used / window
          const threshold = Number.isFinite(config.digestPressureRatio) ? config.digestPressureRatio : 0.75
          if (ratio > 0 && ratio >= threshold && trigger === undefined) trigger = 'pressure'
        }
      } catch (error) {
        logger.warn?.('supermemory: contextPressure failed: %o', error)
      }
    }

    if (trigger === undefined) return
    runDigest({ agent, trigger }).catch((error) => {
      logger.warn?.('supermemory: auto digest failed: %o', error)
    })
  }

  /**
   * 监听 session/event，fire-and-forget 触发自动整理。
   *
   * 注意取 agent 的时机：宿主在 agent loop 的 finally 里同步 `session.append('turn/end')`，
   * 此刻该 agent 一定仍在 `agents` 注册表中（注销只发生在 owner unload / 显式 dispose）。
   * 因此这里**同步**取一次 agent，再把后续判断挪到微任务里；这样即使整理真正跑起来时
   * agent 已经被注销，我们手里仍有可用的 agent 对象（只需要它的 session 与 id）。
   *
   * @param {object} session - 会话。
   * @param {object} event - 事件。
   */
  function onSessionEvent(session, event) {
    try {
      if (!shouldConsider(session, event)) return
      const agent = optionalService(ctx, 'agents')?.get?.(session?.id)
      void Promise.resolve()
        .then(() => maybeTrigger(session, agent))
        .catch((error) => logger.warn?.('supermemory: digest trigger failed: %o', error))
    } catch (error) {
      logger.warn?.('supermemory: digest trigger listener failed: %o', error)
    }
  }

  /** 中止所有在跑的整理请求。 */
  function dispose() {
    for (const controller of controllers) {
      try {
        controller.abort()
      } catch {
        /* ignore */
      }
    }
    controllers.clear()
    turnCounts.clear()
  }

  /**
   * 安装自动触发监听。
   * @returns {() => void} dispose。
   */
  function install() {
    if (typeof ctx?.on !== 'function') return dispose
    let off
    try {
      off = ctx.on('session/event', onSessionEvent)
    } catch (error) {
      logger.warn?.('supermemory: digest listener install failed: %o', error)
      return dispose
    }
    return () => {
      try {
        if (typeof off === 'function') off()
      } catch (error) {
        logger.warn?.('supermemory: digest listener dispose failed: %o', error)
      }
      dispose()
    }
  }

  return { install, runDigest, dispose }
}
