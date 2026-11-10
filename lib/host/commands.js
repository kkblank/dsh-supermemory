/**
 * dsh-supermemory —— 斜杠命令 `/remember` 与 `/memory-digest`。
 *
 * 契约见 docs/CONTRACT.md §5.3：
 *   - `/remember [scope] <内容>` → 追加一条记忆条目；
 *   - `/memory-digest` → 立即跑一次整理。
 *
 * 命令处理器只能返回 `{ kind: 'success' | 'error', text }`，宿主会二次校验；
 * 任何异常都必须在这里收敛成 `kind: 'error'`，绝不抛给宿主。
 *
 * 总开关 `deps.isEnabled` 关闭时：两条命令只回一句提示（仍是 `kind: 'error'`），
 * 既不写记忆也不触发整理；判定缺失视为「开启」。
 *
 * 不 import 任何 `@deepseek-ai/*` 宿主包：`ctx.get('commands')` 拿不到就返回空 dispose。
 *
 * @module dsh-supermemory/host/commands
 */

import { byteLength } from '../core/document.js'

/** 四个记忆分区。 */
const SCOPES = ['soul', 'user', 'global', 'project']

/** 单条记忆的最大字节数，避免一次灌爆文档。 */
const MAX_ENTRY_BYTES = 64 * 1024

/** `/remember` 的用法说明。 */
const REMEMBER_USAGE =
  '用法：/remember [soul|user|global|project] <内容>（省略 scope 默认写入 global）'

/** 总开关关闭时两条命令统一的提示。 */
const DISABLED_HINT = 'dsh-supermemory 已关闭，请在「设置 → 记忆」中启用后再使用这条命令。'

/**
 * 把任意错误对象渲染成可读文本。
 * @param {unknown} error
 * @returns {string}
 */
function renderError(error) {
  try {
    if (error instanceof Error) return error.message
    return String(error)
  } catch {
    return '<unrenderable error>'
  }
}

/**
 * 把命令的原始输入解析成 `{ scope, body }`。
 *
 * 首个词只看**完整匹配**的分区名；不是分区名就整段当内容（scope 用默认值），
 * 这样 `/remember global 喜欢深色主题` 与 `/remember 喜欢深色主题` 都能工作。
 *
 * @param {string} rawInput - 斜杠命令后的原始参数文本。
 * @param {string} fallbackScope - 未指定 scope 时使用的分区。
 * @returns {{ scope: string, body: string, explicitScope: boolean }}
 */
export function parseRememberInput(rawInput, fallbackScope = 'global') {
  const source = typeof rawInput === 'string' ? rawInput : ''
  const trimmed = source.replace(/^\s+/u, '')
  if (trimmed === '') return { scope: fallbackScope, body: '', explicitScope: false }

  const match = /^([A-Za-z]+)(?:\s+([\s\S]*))?$/u.exec(trimmed)
  const candidate = match?.[1]?.toLowerCase()
  if (candidate !== undefined && SCOPES.includes(candidate)) {
    return {
      scope: candidate,
      body: (match?.[2] ?? '').replace(/\s+$/u, ''),
      explicitScope: true,
    }
  }
  return { scope: fallbackScope, body: trimmed.replace(/\s+$/u, ''), explicitScope: false }
}

/**
 * 安装两条斜杠命令。
 *
 * @param {object} ctx - cordis Context。
 * @param {object} deps - 由 lib/index.js 注入。
 * @param {object} deps.store - 存储层。
 * @param {(agent: object) => Promise<object|undefined>} deps.resolveScope - 解析作用域。
 * @param {(request: object) => Promise<object>} deps.runDigest - 触发整理。
 * @param {() => boolean} [deps.isEnabled] - 插件总开关；返回 false 时两条命令只回提示，缺失视为「开启」。
 * @param {{ warn: Function }} deps.logger - 宿主日志。
 * @returns {() => void} dispose（服务缺失时为空 dispose）。
 */
export function installCommands(ctx, deps) {
  const commands = (() => {
    try {
      return ctx.get('commands')
    } catch {
      return undefined
    }
  })()

  if (commands === undefined || commands === null || typeof commands.register !== 'function') {
    return () => {}
  }

  const store = deps.store

  /**
   * 解析本次调用的人设与项目根。
   * @param {object|undefined} agent
   * @returns {Promise<{ persona: string, presetId: string, projectRoot: string|undefined }>}
   */
  async function resolveTargets(agent) {
    let scope
    try {
      scope = await deps.resolveScope?.(agent)
    } catch (error) {
      deps.logger?.warn?.('supermemory: resolveScope failed: %o', error)
      scope = undefined
    }
    const persona =
      typeof scope?.persona === 'string' && scope.persona !== ''
        ? scope.persona
        : typeof scope?.presetId === 'string' && scope.presetId !== ''
          ? scope.presetId
          : 'default'
    return {
      persona,
      presetId: persona,
      projectRoot: typeof scope?.projectRoot === 'string' ? scope.projectRoot : undefined,
    }
  }

  /**
   * 把分区名转成 store 的 ref（白名单，杜绝任意路径）。
   * @param {string} scopeName
   * @param {{ persona: string, presetId?: string, projectRoot?: string }} targets
   * @returns {object}
   */
  function refFor(scopeName, targets) {
    if (!SCOPES.includes(scopeName)) {
      throw new Error(`unknown memory scope ${JSON.stringify(scopeName)}`)
    }
    if (scopeName === 'project') {
      if (typeof targets.projectRoot !== 'string' || targets.projectRoot === '') {
        throw new Error('无法解析当前项目根目录，project 分区暂时不可用')
      }
      return { kind: 'project', projectRoot: targets.projectRoot }
    }
    return { kind: scopeName, persona: targets.persona ?? targets.presetId }
  }

  /** `/remember` 的处理器。 */
  async function handleRemember(invocation) {
    // 总开关关闭：只回提示，不碰存储（判定缺失视为「开启」）。
    if (deps.isEnabled?.() === false) return { kind: 'error', text: DISABLED_HINT }
    const { scope: scopeName, body: parsedBody } = parseRememberInput(invocation?.rawInput, 'global')
    if (parsedBody === '') {
      return { kind: 'error', text: `缺少要记住的内容。${REMEMBER_USAGE}` }
    }
    // v2：人格只能用户显式确认后改。
    const confirmed = /(^|\s)--confirm(\s|$)/u.test(parsedBody)
    const body = parsedBody.replace(/(^|\s)--confirm(?=\s|$)/gu, ' ').replace(/\s{2,}/gu, ' ').trim()
    if (body === '') {
      return { kind: 'error', text: `缺少要记住的内容。${REMEMBER_USAGE}` }
    }
    if (scopeName === 'soul' && !confirmed) {
      return {
        kind: 'error',
        text: '人格（soul）属于用户，只能由用户手动修改。若用户明确要求改动人格，请追加 --confirm：/remember soul --confirm <内容>',
      }
    }
    if (byteLength(body) > MAX_ENTRY_BYTES) {
      return { kind: 'error', text: `内容超过 ${MAX_ENTRY_BYTES} 字节上限，请拆分后再写入。` }
    }

    try {
      const targets = await resolveTargets(invocation?.agent)
      const ref = refFor(scopeName, targets)
      const entry = {
        time: new Date().toISOString(),
        source: 'user-request',
        body: body.replace(/\r\n?/gu, '\n'),
      }
      const result = await store.appendEntries(ref, [entry])
      if (result?.ok !== true) {
        const detail = typeof result?.message === 'string' ? result.message : '写入失败'
        const code = typeof result?.code === 'string' ? `（${result.code}）` : ''
        return { kind: 'error', text: `写入 ${scopeName} 记忆失败${code}：${detail}` }
      }
      const bytes = Number.isFinite(result.bytes) ? result.bytes : 0
      return { kind: 'success', text: `已写入 ${scopeName} 记忆（当前 ${bytes} 字节）。` }
    } catch (error) {
      deps.logger?.warn?.('supermemory: /remember failed: %o', error)
      return { kind: 'error', text: `写入记忆失败：${renderError(error)}` }
    }
  }

  /**
   * 整编明细的一行可读摘要；无整编信息时返回空串。
   * @param {object} consolidation - RunRecord.consolidation。
   * @returns {string} 文本。
   */
  function consolidateSummary(consolidation) {
    if (consolidation === null || typeof consolidation !== 'object') return ''
    // added 是「本次写入的新条目」（含合并产物），说「新增」会被读成净增条数。
    const labels = [
      ['added', '写入'],
      ['merged', '合并'],
      ['dropped', '移除'],
      ['kept', '保留'],
    ]
    const parts = labels
      .filter(([key]) => Number.isFinite(consolidation[key]))
      .map(([key, label]) => `${label} ${consolidation[key]} 条`)
    if (Array.isArray(consolidation.ghosts) && consolidation.ghosts.length > 0) {
      parts.push(`${consolidation.ghosts.length} 个引用已失效`)
    }
    return parts.join('、')
  }

  /** `/memory-digest` 的处理器。 */
  async function handleDigest(invocation) {
    // 总开关关闭：只回提示，不触发整理。
    if (deps.isEnabled?.() === false) return { kind: 'error', text: DISABLED_HINT }
    const rawInput = typeof invocation?.rawInput === 'string' ? invocation.rawInput.trim() : ''
    if (rawInput !== '') {
      return { kind: 'error', text: '用法：/memory-digest（不接受参数）' }
    }
    let report
    try {
      report = await deps.runDigest?.({ agent: invocation?.agent, trigger: 'manual' })
    } catch (error) {
      deps.logger?.warn?.('supermemory: /memory-digest failed: %o', error)
      return { kind: 'error', text: `整理失败：${renderError(error)}` }
    }
    if (report === undefined || report === null) {
      return { kind: 'error', text: '整理器不可用（digest runner unavailable）。' }
    }
    if (report.ok !== true) {
      const detail = typeof report.error === 'string' ? report.error : '未知错误'
      return { kind: 'error', text: `整理失败：${detail}` }
    }
    const counts = report.counts ?? {}
    // 整编模式：产物是整份目标态，counts 语义仍是「新增条数」，明细走 consolidation 字段。
    if (report.mode === 'consolidate') {
      const summary = consolidateSummary(report.consolidation)
      const snapshotted = typeof report.consolidation?.snapshot === 'string' && report.consolidation.snapshot !== ''
      const tail = snapshotted ? '原文已快照备份。' : ''
      return { kind: 'success', text: `整编完成：${summary === '' ? '记忆无需调整' : summary}。${tail}` }
    }
    const parts = SCOPES
      .filter((name) => Number.isFinite(counts[name]) && counts[name] > 0)
      .map((name) => `${name} ${counts[name]}`)
    const total = SCOPES.reduce((sum, name) => (Number.isFinite(counts[name]) ? sum + counts[name] : sum), 0)
    if (total === 0) return { kind: 'success', text: '整理完成：没有发现新的记忆条目。' }
    return { kind: 'success', text: `整理完成：新增 ${total} 条（${parts.join('，')}）。` }
  }

  const disposers = []

  /** 注册一条命令；失败只告警。 */
  const register = (label, definition) => {
    try {
      const disposer = commands.register(definition)
      if (typeof disposer === 'function') disposers.push(disposer)
    } catch (error) {
      deps.logger?.warn?.('supermemory: %s registration failed: %o', label, error)
    }
  }

  register('commands.register(/remember)', {
    name: 'remember',
    description: '把一段内容写入长期记忆（默认 global 分区）',
    input: { hint: '[soul|user|global|project] <内容>' },
    recordInput: true,
    handler: handleRemember,
  })

  register('commands.register(/memory-digest)', {
    name: 'memory-digest',
    description: '立即整理当前会话并合并进长期记忆',
    recordInput: false,
    handler: handleDigest,
  })

  return () => {
    for (const disposer of disposers.splice(0)) {
      try {
        disposer()
      } catch {
        /* 卸载期清理失败不影响其它 */
      }
    }
  }
}
