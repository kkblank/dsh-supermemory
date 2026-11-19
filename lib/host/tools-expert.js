/**
 * dsh-supermemory —— `delegate_expert` 工具（主管人格 → 专家人格委派）。
 *
 * 用户只跟**主管人格**对话；主管遇到专业问题时调用本工具，同步等待某个专家人格跑完，
 * 把结论当轮汇报给用户。三条不可动摇的设计：
 * 1. **只有主管能委派**：注册时 `tools.register(definition, { when })` 门控，`execute`
 *    内部再判一次同样的条件——工具清单随人设切换在 step 间变化，只信一层就会漏。
 * 2. **先绑定后起 agent**：`sessionPersonas.set(childId, 专家slug)` 必须在 `startActivation`
 *    之前完成；反了的话专家第一轮注入读到主管人设，等于请了个顶着主管记忆的专家。
 *    绑定失败时**不起 agent、不写记录**。
 * 3. **结果只回调用方**：`delivery: 'caller'`，结论由本工具返回给主管，不由宿主额外注入
 *    父会话——否则主管会看到两遍（工具结果 + 一条子代理消息）。
 * 所有异常都收敛成返回值里的错误码，绝不抛到宿主；不 import 任何 `@deepseek-ai/*` 宿主包。
 *
 * `timeoutMs` 在**注册那一刻**从 `config.delegateTimeoutMs` 取一次（默认 15 分钟），不在每次调用
 * 里重读：同步委派阻塞到专家跑完，唯一能把「专家卡死」变成可终止状态的是宿主的 `tools/execute`
 * 超时包装器（替换 `exec.signal`，到期映射成 `TOOL_TIMEOUT`），本工具把 `exec.signal` 原样转给
 * `startActivation` 即满足其「协作实现」要求；自己实现超时只能 abort signal，而 `result` 的 settle
 * 仍依赖子 agent 结束，工具照样挂着，等于没有超时。配置虽是 volatile，但每次调用重算预算只会让
 * 「这一步的预算」与宿主已武装的 deadline 不一致，反而更难解释——改配置重载插件生效。
 *
 * @module dsh-supermemory/host/tools-expert
 */

import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { createDelegationLog } from './delegations.js'

/** `task` 字节上限（64 KiB）。 */
const MAX_TASK_BYTES = 64 * 1024
/** 结论字节上限 / 委派超时 / 记录保留行数的默认值（与 config.js 默认值一致）。 */
const DEFAULT_RESULT_MAX_BYTES = 16000
const DEFAULT_TIMEOUT_MS = 900000
const DEFAULT_LOG_KEEP = 200
/** 截断提示行（追加在结论末尾，不计入字节预算）；两个开关关闭时的提示。 */
const TRUNCATED_HINT = '\n[结论已截断]'
const DISABLED_MESSAGE = 'dsh-supermemory is disabled. Enable it in Settings → Memory.'
const DELEGATE_DISABLED_MESSAGE = 'Expert delegation is disabled (delegateEnabled=false).'

/**
 * 委派成功后追加的「记忆沉淀」提示（契约 §V13.9）。
 *
 * **只提示，不代写**。三条设计理由：
 *   1. 自动整理的可写范围硬编码为 project，且只在**主会话** turn/end 触发；专家子会话
 *      不触发整理（`digest.js` 的 shouldConsider 明确排除 parentSession / origin=subagent）。
 *      所以专家干完活，它那轮产出默认**不会**沉淀——这是既有事实，不是 bug。
 *   2. 「什么值得沉淀」是判断而非规则。让主管拿到结论时顺手判断一次，比让整理器
 *      事后从对话里猜更准，也不会把一次性闲聊灌进记忆。
 *   3. 提示里必须写清**该调哪个工具、传什么参数**。只说「记得沉淀」等于没说——
 *      模型会回一句「好的，已记录」然后什么都不做（本项目踩过这类空承诺）。
 *
 * 末尾刻意强调「没有值得沉淀的就跳过」：不设这句，模型会倾向于每条都写，
 * 记忆很快被低价值条目撑大，反而把真正重要的内容挤进冷层。
 */
const PERSIST_HINT = [
  '',
  '---',
  '[记忆沉淀] 如果上面的结论里有值得长期保留的知识（新的项目约定、踩到的坑、',
  '可复用的结论、被推翻的旧假设），用 `memory` 工具写进项目记忆：',
  '  action="append", scope="project", content="<一句话结论>", reason="expert-delegation"',
  '  —— 默认落 cold 层即可；只有「每轮都必须知道」的硬约束才加 tier="core"。',
  '如果只是这次任务的一次性结果（临时计算、单次查询、闲聊），**不要写**，直接向用户汇报即可。',
].join('\n')
/** 非 `completed` 的 stopReason → 错误码与中文说明；未列出的回退 `DELEGATE_FAILED`。 */
const STOP_REASON_MAP = {
  aborted: { code: 'CANCELLED', message: '委派已取消（专家执行被中止）。' },
  'max-tokens': { code: 'MAX_TOKENS', message: '专家在输出上限前未能给出完整结论。' },
  refusal: { code: 'REFUSAL', message: '专家拒绝执行这项任务。' },
}

/** 工具描述（英文，与 `memory` 工具一致；模型直接读这一段）。 */
const DESCRIPTION = [
  'Delegate one self-contained task to an expert persona (专家人格) and wait for its conclusion in the same turn.',
  'Only a session whose effective persona is the supervisor may call this tool; a delegated expert cannot delegate again.',
  'Pass the expert name or slug and a complete task description: the expert sees only that text, not your conversation.',
  'The result is the expert final conclusion, already truncated to the configured budget; report it to the user directly.',
  'Prefer this over doing specialist work yourself when an expert persona matches the task; do not delegate trivial work.',
].join(' ')

/** 参数 JSON Schema（宿主只支持 type/enum/items/properties/required 子集）。 */
const PARAMETERS = {
  type: 'object',
  properties: {
    persona: {
      type: 'string',
      description: 'Expert persona name or slug, exactly as listed in the expert directory. The supervisor itself is not a valid target.',
    },
    task: {
      type: 'string',
      description:
        'Complete task description for the expert, at most 64 KiB. The expert only sees this text: include all context it needs, and ask for a self-contained conclusion.',
    },
    label: { type: 'string', description: 'Optional one-line description of this delegation, used for display and logs.' },
  },
  required: ['persona', 'task'],
  additionalProperties: false,
}

// 输出 JSON Schema。宿主按这份声明**严格**校验输出：返回对象里出现未声明的键，整个调用
// 会被判 invalid output。这里声明所有可能返回键的并集，返回值只经 fail() 与成功分支产出。
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    persona: { type: 'string' },
    text: { type: 'string' },
    truncated: { type: 'boolean' },
    code: { type: 'string' },
    error: { type: 'string' },
    durationMs: { type: 'integer' },
  },
  required: ['ok'],
  additionalProperties: false,
}

/** 把异常转成可读消息（与 store.js 的 `describe` 同口径）。 */
const describe = (error) => (error === null || error === undefined ? 'unknown error' : error?.message !== undefined ? String(error.message) : String(error))

/** 构造失败返回值（只允许 schema 声明过的键，防止手滑加字段把整个调用判非法）。 */
function fail(code, message, persona) {
  const result = { ok: false, code, error: message }
  if (typeof persona === 'string' && persona !== '') result.persona = persona
  return result
}

/**
 * 按 UTF-8 字节上限截断，绝不切断码点：先砍到 maxBytes，再从末尾回退掉残缺的多字节
 * 序列（跳过 continuation 字节 10xxxxxx，再丢掉露出的首字节 11xxxxxx）。直接切会切出
 * 半个字符变成替换字符（U+FFFD），中文结论的末行就是乱码。
 * @param {string} text 原文。 @param {number} maxBytes 字节上限。
 * @returns {{ text: string, truncated: boolean }} 截断结果。
 */
function truncateToBytes(text, maxBytes) {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false }
  const bytes = Buffer.from(text, 'utf8').subarray(0, maxBytes)
  let end = bytes.length
  while (end > 0 && (bytes[end - 1] & 0xc0) === 0x80) end -= 1
  if (end > 0 && (bytes[end - 1] & 0xc0) === 0xc0) end -= 1
  return { text: bytes.subarray(0, end).toString('utf8'), truncated: true }
}

/** 拼出交给专家的用户消息（写在这里，不写进 soul）。 */
function buildPrompt(expertName, task) {
  return [
    `你是「${expertName}」，被主管人格调用来完成下面这项任务。`,
    '',
    task,
    '',
    '要求：',
    '- 你只负责这一项任务，完成后直接给出结论。',
    '- 你不能委派其它人格，但可以起普通子代理协助。',
    '- 结论要自包含：主管会拿你的结论直接向用户汇报，不要写「如上所述」这类指代。',
  ].join('\n')
}

/** 安装 `delegate_expert` 工具；`tools` 服务缺失时返回空 dispose，绝不抛。 */
export function installExpertTool(ctx, deps) {
  /** 取宿主服务；`ctx.get` 抛错也当成缺失。 */
  const getService = (name) => {
    try { return ctx?.get?.(name) } catch { return undefined }
  }

  const tools = getService('tools')
  if (tools === undefined || tools === null || typeof tools.register !== 'function') return () => {}

  /** 记一条告警；日志器本身抛错也忽略（日志失败不能反过来影响业务）。 */
  const warn = (message, detail) => {
    try { deps?.logger?.warn?.(`supermemory: ${message}: %o`, detail) } catch { /* 忽略 */ }
  }

  /** 调用 deps 上的可选方法；缺失或抛错都返回 undefined（静默降级）。 */
  const callDeps = (name, ...args) => {
    if (typeof deps?.[name] !== 'function') return undefined
    try { return deps[name](...args) } catch (error) { warn(`deps.${name} failed`, error); return undefined }
  }

  /** 读配置快照（每次调用读一次 volatile 的最新值；读不到回退空对象）。 */
  const readConfig = () => {
    const value = callDeps('getConfig')
    return value !== null && typeof value === 'object' ? value : {}
  }

  // 记录器只创建一次：同路径写串行与裁剪都在它内部。`keep` 是「历史文件留多少行」的
  // 运维口径而非实时策略，注册那一刻定值即可（改配置重载插件生效）。
  const initialConfig = readConfig()
  const envHome = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  const dshHome =
    typeof deps?.dshHome === 'string' && deps.dshHome !== '' ? deps.dshHome : envHome !== '' ? envHome : join(homedir(), '.dsh')
  const keep = Number.isInteger(initialConfig.delegateLogKeep) ? initialConfig.delegateLogKeep : DEFAULT_LOG_KEEP
  const log = createDelegationLog({ filePath: join(dshHome, 'supermemory', 'delegations.jsonl'), logger: deps?.logger, keep })

  /** 门控条件：不是子代理，且当前生效人设是主管（注册与执行共用同一条判据）。 */
  const admitted = (agent) => callDeps('isSubagent', agent) !== true && callDeps('isSupervisorAgent', agent) === true

  /** 取父 agent 的当前工作目录：workingDirectory 服务 → session.header.cwd → process.cwd()。 */
  const resolveCwd = (agent) => {
    let fromService
    try { fromService = getService('workingDirectory')?.get?.(agent?.session) } catch { fromService = undefined }
    if (typeof fromService === 'string' && fromService !== '') return fromService
    const fromHeader = agent?.session?.header?.cwd
    return typeof fromHeader === 'string' && fromHeader !== '' ? fromHeader : process.cwd()
  }

  /** 解析人设目录（同步）；store 缺失或抛错返回 undefined。 */
  const listPersonas = () => {
    if (typeof deps?.store?.listPersonas !== 'function') return undefined
    try {
      const items = deps.store.listPersonas()
      return Array.isArray(items) ? items : []
    } catch (error) { warn('listPersonas failed', error); return undefined }
  }

  /** 绑定专家会话的人设。只有 true 才算成功：抛错、返回 `{ ok:false }`、服务缺失都是失败。 */
  const bindPersona = async (childId, slug) => {
    if (typeof deps?.sessionPersonas?.set !== 'function') return false
    try { return (await deps.sessionPersonas.set(childId, slug))?.ok !== false } catch (error) {
      warn('sessionPersonas.set failed', error)
      return false
    }
  }

  /** 回滚绑定；失败只告警。 */
  const clearBinding = async (childId) => {
    try { if (typeof deps?.sessionPersonas?.clear === 'function') await deps.sessionPersonas.clear(childId) } catch (error) {
      warn('sessionPersonas.clear failed', error)
    }
  }

  /** 尽力取主管人设 slug（记录用）；失败返回空串。 */
  const supervisorOf = async (agent) => {
    if (typeof deps?.resolveScope !== 'function') return ''
    try { return (await deps.resolveScope(agent))?.persona ?? '' } catch (error) {
      warn('resolveScope failed', error)
      return ''
    }
  }

  /** 写一条委派记录；失败只告警，不影响工具返回值。 */
  const writeRecord = async (record) => {
    try { await log.append(record) } catch (error) { warn('delegation record failed', error) }
  }

  /** 委派主体：按固定顺序做校验与执行（步骤编号对应需求文档）。 */
  async function run(args, exec, startedAt) {
    // 1/2. 插件总开关，再判委派开关（总开关关插件，这个只关委派能力）。
    if (callDeps('isEnabled') === false) return fail('PLUGIN_DISABLED', DISABLED_MESSAGE)
    const config = readConfig()
    if (config.delegateEnabled === false) return fail('DELEGATE_DISABLED', DELEGATE_DISABLED_MESSAGE)

    // 3. 调用方 agent 必须存在（没有它既判不了门控，也起不了子代理）。
    const agent = exec?.agent
    if (agent === undefined || agent === null) return fail('BAD_INPUT', '缺少调用方 agent，无法委派。')

    // 4/5. 门控：专家不能再委派；非主管不能委派。
    if (callDeps('isSubagent', agent) === true) return fail('NOT_SUPERVISOR', '专家人格不能再次委派；请把任务直接做完并给出结论。')
    if (callDeps('isSupervisorAgent', agent) !== true) return fail('NOT_SUPERVISOR', '只有主管人格可以调用 delegate_expert。')

    // 6. 参数校验。
    const personaArg = typeof args?.persona === 'string' ? args.persona.trim() : ''
    const task = typeof args?.task === 'string' ? args.task : ''
    if (personaArg === '') return fail('BAD_INPUT', 'persona 必须是非空字符串（专家人设名称或 slug）。')
    if (task.trim() === '') return fail('BAD_INPUT', 'task 必须是非空字符串。')
    const taskBytes = Buffer.byteLength(task, 'utf8')
    if (taskBytes > MAX_TASK_BYTES) return fail('BAD_INPUT', `task 超过 ${MAX_TASK_BYTES} 字节上限（当前 ${taskBytes} 字节）。`)

    // 7. 在专家目录里找人：先 slug 精确，再 name 精确。
    const personas = listPersonas()
    if (personas === undefined) return fail('DELEGATE_UNAVAILABLE', '专家目录不可用，无法解析目标人格。')
    const usable = personas.filter((item) => item !== null && typeof item === 'object')
    const target = usable.find((item) => item.slug === personaArg) ?? usable.find((item) => item.name === personaArg)
    if (target === undefined) return fail('NOT_FOUND', `找不到专家人格「${personaArg}」。`)
    if (target.supervisor === true) return fail('BAD_INPUT', '不能把任务委派给主管自己。')
    const expertSlug = typeof target.slug === 'string' && target.slug !== '' ? target.slug : personaArg
    const expertName = typeof target.name === 'string' && target.name !== '' ? target.name : expertSlug

    // 8. 子代理服务必须可用。
    const subagents = getService('subagents')
    if (typeof subagents?.startActivation !== 'function') {
      return fail('DELEGATE_UNAVAILABLE', '子代理服务不可用，无法启动专家会话。')
    }

    // 9. 预留子会话 id（UUID 满足宿主 sessionId 白名单）。
    const childId = randomUUID()

    // 10. 先绑定人设，再起 agent。顺序不可换：反了专家第一轮就顶着主管记忆跑。
    if (!(await bindPersona(childId, expertSlug))) {
      return fail('DELEGATE_BIND_FAILED', `无法为专家会话绑定人设「${expertSlug}」。`)
    }

    // 11. 启动激活。记录用的公共字段一次算好，三条失败出口与成功出口共用。
    // 记录口径：只有**走到起 agent 这一步之后**的成败才落盘。绑定前的失败（开关、参数、
    // NOT_FOUND、BIND_FAILED）不写——需求明确要求绑定失败不写记录，而前几种根本没发生
    // 委派，写进去只会污染面板的「最近委派」列表。
    const labelArg = typeof args?.label === 'string' && args.label.trim() !== '' ? args.label.trim() : expertName
    const base = {
      supervisor: await supervisorOf(agent),
      persona: expertSlug,
      sessionId: typeof agent?.session?.id === 'string' ? agent.session.id : '',
      label: Array.from(labelArg).slice(0, 120).join(''),
      taskPreview: task,
    }
    const record = (ok, stopReason, resultPreview) =>
      writeRecord({ ...base, ok, stopReason, durationMs: Date.now() - startedAt, resultPreview })
    const spec = {
      provider: typeof config.delegateProvider === 'string' && config.delegateProvider !== '' ? config.delegateProvider : 'spawn',
      childId,
      prompt: [{ type: 'text', text: buildPrompt(expertName, task) }],
      parent: agent,
      cwd: resolveCwd(agent),
      label: base.label,
      // 转发宿主 signal：timeoutMs 承诺的协作式取消靠它生效。
      signal: typeof exec?.signal?.aborted === 'boolean' ? exec.signal : new AbortController().signal,
      delivery: 'caller',
    }

    let activation
    try {
      activation = await subagents.startActivation(spec)
      if (activation === undefined || activation === null || activation.result === undefined) {
        throw new Error('子代理服务返回了无效的 activation')
      }
    } catch (error) {
      warn('startActivation failed', error)
      // 14. 起不来就回滚绑定：残留绑定会让那个 UUID 永远指着一个不存在的专家会话。
      await clearBinding(childId)
      const message = `启动专家会话失败：${describe(error)}`
      await record(false, 'error', message)
      return fail('DELEGATE_FAILED', message, expertName)
    }

    // 12. 等结论；无论结果如何都要 dispose 掉这次激活。
    let subResult
    try {
      subResult = await activation.result
    } catch (error) {
      warn('activation.result rejected', error)
      const message = `专家执行失败：${describe(error)}`
      await record(false, 'error', message)
      return fail('DELEGATE_FAILED', message, expertName)
    } finally {
      try {
        await activation.dispose?.()
      } catch (error) {
        // dispose 失败不影响已经拿到的结论，只告警。
        warn('activation.dispose failed', error)
      }
    }

    // 13. 结果映射。`completed` 拼文本并截断，其余按 stopReason 映射错误码。
    const stopReason = typeof subResult?.stopReason === 'string' ? subResult.stopReason : 'error'
    if (stopReason === 'completed') {
      const maxBytes =
        Number.isInteger(config.delegateResultMaxBytes) && config.delegateResultMaxBytes > 0
          ? config.delegateResultMaxBytes
          : DEFAULT_RESULT_MAX_BYTES
      const joined = Array.isArray(subResult?.output)
        ? subResult.output
            .filter((b) => b !== null && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string')
            .map((b) => b.text)
            .join('\n')
        : ''
      const clipped = truncateToBytes(joined, maxBytes)
      const body = clipped.truncated ? `${clipped.text}${TRUNCATED_HINT}` : clipped.text
      // 14b. 记忆沉淀提示（契约 §V13.9）：只提示、不代写，所以它**不计入**
      //      delegateResultMaxBytes（预算是给专家正文的），也不进委派记录——
      //      记录里的 resultPreview 应该只有专家说了什么，不该混进我们加的元指令。
      const text = config.delegatePersistHint === false ? body : `${body}${PERSIST_HINT}`
      await record(true, stopReason, body)
      // 15. 成功结束**不**清绑定：子会话可冷恢复，清了专家会丢人格。
      return clipped.truncated
        ? { ok: true, persona: expertName, text, truncated: true }
        : { ok: true, persona: expertName, text }
    }
    const mapped = STOP_REASON_MAP[stopReason] ?? {
      code: 'DELEGATE_FAILED',
      message: `专家执行失败（stopReason: ${String(stopReason)}）。`,
    }
    const diagnostic = typeof subResult?.diagnostic === 'string' && subResult.diagnostic.trim() !== '' ? subResult.diagnostic : ''
    const message = diagnostic !== '' ? `${mapped.message}（${diagnostic}）` : mapped.message
    await record(false, stopReason, message)
    return fail(mapped.code, message, expertName)
  }

  /** 工具入口：任何异常都收敛成 `ok:false`，并统一补 `durationMs`。 */
  async function execute(args, exec) {
    const startedAt = Date.now()
    let outcome
    try {
      outcome = await run(args, exec, startedAt)
    } catch (error) {
      warn('delegate_expert failed', error)
      outcome = fail('INTERNAL', `委派内部错误：${describe(error)}`)
    }
    return { ...outcome, durationMs: Math.max(0, Date.now() - startedAt) }
  }

  const definition = {
    name: 'delegate_expert',
    description: DESCRIPTION,
    parameters: PARAMETERS,
    output: { schema: OUTPUT_SCHEMA, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute,
    // 每次委派有独立 childId、独立子会话，不共享父会话状态，可以并行。
    isConcurrencySafe: () => true,
    // 注册时定值：见模块头「timeoutMs」一段。
    timeoutMs:
      Number.isInteger(initialConfig.delegateTimeoutMs) && initialConfig.delegateTimeoutMs > 0
        ? initialConfig.delegateTimeoutMs
        : DEFAULT_TIMEOUT_MS,
  }

  try {
    const disposer = tools.register(definition, { when: (context) => admitted(context?.agent) })
    return () => {
      try {
        if (typeof disposer === 'function') disposer()
      } catch (error) {
        warn('tool dispose failed', error)
      }
      void log.dispose()
    }
  } catch (error) {
    warn('delegate_expert registration failed', error)
    void log.dispose()
    return () => {}
  }
}
