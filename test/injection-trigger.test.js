/**
 * 注入链路 + 自动整理触发的正向回归测试。
 *
 * 补 `test/host-install.test.js` 与 `test/routes.test.js` 未覆盖的核心缺口：
 *   A) `digestEveryTurns` 计数触发 —— 第 N 轮恰好触发一次，且真的写回文件（PLAN 成功标准 6）。
 *   B) `tokenMeter.contextPressure` 达阈值触发 `pressure` 整理。
 *   C) 快照注入 append / 内容不变不写 / 内容变化 replace / 清空后占位替换。
 *   D) 插件总开关 `deps.isEnabled` 关闭时：自动整理不触发（手动 runDigest 仍可用）、
 *      pre-step 不再更新快照且旧快照原样保留。
 *
 * 全部用假 ctx + 真实 store / createDigestRunner / installInjection，不装依赖。
 * 运行：node --test test/injection-trigger.test.js
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from '../lib/core/store.js'
import { appendEntries, emptyDocument, parseEntries } from '../lib/core/document.js'
import { resolveConfig } from '../lib/host/config.js'
import { CONSOLIDATE_SYSTEM_PROMPT } from '../lib/host/digest-input.js'
import { createDigestRunner } from '../lib/host/digest.js'
import { EMPTY_DIGEST, EMPTY_SNAPSHOT_TEXT, hasSystemHead, installInjection, SNAPSHOT_NOTICE } from '../lib/host/inject.js'

/** 整理器固定返回的 JSON（v2：只允许 project 一条新增事实）。 */
const DIGEST_JSON = '{"project":["自动整理新增的事实"]}'

/** 等待若干毫秒。 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 假 cordis ctx：可选服务、事件监听、waterfall。
 * @param {object} [services] - `ctx.get(name)` 要返回的服务。
 * @returns {object} 假 ctx。
 */
function makeCtx(services = {}) {
  const handlers = new Map()
  const disposers = []
  const warnings = []
  const ctx = {
    logger: { warn: (...args) => warnings.push(args.map(String).join(' ')), info() {} },
    get(name) {
      return services[name]
    },
    on(event, fn) {
      const list = handlers.get(event) ?? []
      list.push(fn)
      handlers.set(event, list)
      const off = () => {
        const current = handlers.get(event) ?? []
        handlers.set(event, current.filter((item) => item !== fn))
      }
      disposers.push(off)
      return off
    },
    async emit(event, ...args) {
      for (const fn of handlers.get(event) ?? []) await fn(...args)
    },
    async waterfall(event, payload, next) {
      const list = handlers.get(event) ?? []
      let index = 0
      const step = async (current) => {
        const fn = list[index]
        index += 1
        if (fn === undefined) return next()
        return fn(current, (nextPayload) => step(nextPayload ?? current))
      }
      return step(payload)
    },
    handlerCount(event) {
      return (handlers.get(event) ?? []).length
    },
    warnings,
    services,
    disposeAll() {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose()
        } catch {
          /* 清理失败忽略 */
        }
      }
    },
  }
  return ctx
}

// ——————————————————————————————————————————————
// 自动整理触发夹具（假 ctx + 真实 store + 真实 runner）
// ——————————————————————————————————————————————

/**
 * 建自动整理夹具。
 * @param {object} [options]
 * @param {object} [options.config] - 覆盖配置。
 * @param {{pressureTokens:number,contextWindow:number}} [options.pressure] - 假 tokenMeter 返回值。
 * @param {string} [options.llmText] - 假 LLM 输出文本。
 * @param {() => boolean} [options.isEnabled] - 假插件总开关（缺失视为「开启」）。
 * @returns {Promise<object>} 夹具。
 */
async function makeDigestHarness(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'sm-trigger-'))
  // v2：人格/画像/全局记忆落在 personas/ 下；store 可能只认 personasRoot。
  const presetsRoot = join(dir, 'personas')
  const rawConfig = { presetsRoot, personasRoot: presetsRoot, digestProvider: 'fake-provider', digestModel: 'fake-model', ...options.config }
  const store = createStore({
    dshHome: dir,
    presetsRoot,
    personasRoot: presetsRoot,
    config: resolveConfig(rawConfig),
    logger: { warn() {} },
  })
  if (store?.ready !== undefined) await store.ready

  let streamCalls = 0
  /** 最后一次 llm.stream 的入参（整编模式要断言 system 与 maxTokens）。 */
  let lastStreamParams = null
  // 整编用例要在读到条目 id 之后才能拼出模型输出，故留出可换文案的口子。
  let llmText = options.llmText ?? DIGEST_JSON
  /** 假流的收尾原因；`length` 用来模拟输出被 maxTokens 截断。 */
  const finishKind = options.finishKind ?? 'stop'
  // 关键：stream 必须**同步**返回 AsyncIterable，不能是 Promise。
  const llm = {
    stream(params) {
      streamCalls += 1
      lastStreamParams = params
      return (async function* () {
        yield { type: 'text-delta', index: 0, text: llmText }
        yield { type: 'finish', reason: { kind: finishKind } }
      })()
    },
  }
  const agents = new Map()
  const services = { llm, agents }
  if (options.pressure !== undefined) {
    services.tokenMeter = { contextPressure: () => options.pressure }
  }

  const ctx = makeCtx(services)
  const scope = { persona: 'default', presetId: 'default', projectRoot: dir, projectName: 'proj' }
  const deps = {
    store,
    getConfig: () => resolveConfig(rawConfig),
    resolveScope: async () => scope,
    currentRoute: () => ({ provider: 'fake-provider', model: 'fake-model' }),
    isSubagent: (agent) => agent?.isSubagent === true,
    isEnabled: options.isEnabled,
    logger: ctx.logger,
  }
  const runner = createDigestRunner(ctx, deps)
  const uninstall = runner.install()

  const session = { id: 'sess-main', header: {}, snapshotEvents: () => [] }
  agents.set(session.id, { session, isSubagent: false })

  /** 补注册一个会话（子智能体场景）。 */
  const addSession = (id, header = {}, isSubagent = false) => {
    const target = { id, header, snapshotEvents: () => [] }
    agents.set(id, { session: target, isSubagent })
    return target
  }

  /** 触发一次 turn/end。 */
  const emitTurn = (target = session, reasonKind = 'completed') =>
    ctx.emit('session/event', target, { type: 'turn/end', data: { reason: { kind: reasonKind } } })

  /** 轮询等待至少 count 条 run 记录。 */
  const waitForRuns = async (count, timeoutMs = 3000) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const runs = await store.readRuns(50)
      if (runs.length >= count) return runs
      if (Date.now() > deadline) return runs
      await delay(10)
    }
  }

  const cleanup = async () => {
    try {
      uninstall()
    } catch {
      /* ignore */
    }
    try {
      runner.dispose()
    } catch {
      /* ignore */
    }
    try {
      ctx.disposeAll()
    } catch {
      /* ignore */
    }
    await store.dispose()
    await rm(dir, { recursive: true, force: true })
  }

  return {
    dir,
    store,
    ctx,
    runner,
    session,
    addSession,
    emitTurn,
    waitForRuns,
    streamCalls: () => streamCalls,
    streamParams: () => lastStreamParams,
    setLlmText: (text) => {
      llmText = text
    },
    cleanup,
  }
}

// ——————————————————————————————————————————————
// A) 轮数触发
// ——————————————————————————————————————————————

test('digestEveryTurns=3：前两轮不触发，第 3 轮恰好触发一次 turns 整理并写回文件', async (t) => {
  const h = await makeDigestHarness({ config: { digestEveryTurns: 3 } })
  t.after(h.cleanup)

  await h.emitTurn()
  await h.emitTurn()
  await delay(150)
  assert.equal(h.streamCalls(), 0, '前两轮不得触发整理')
  assert.deepEqual(await h.store.readRuns(20), [], '前两轮不得产生运行记录')

  await h.emitTurn()
  const runs = await h.waitForRuns(1)
  assert.equal(runs.length, 1, '第 3 轮必须触发一次整理')
  assert.equal(runs[0].trigger, 'turns')
  assert.equal(runs[0].ok, true)
  assert.equal(runs[0].sessionId, 'sess-main')
  assert.deepEqual(runs[0].counts, { soul: 0, user: 0, global: 0, project: 1 })
  assert.equal(h.streamCalls(), 1, '恰好调用一次 LLM')

  // v2：整理条目必须真的落到 project 文件里（soul/user/global 永不自动写）。
  const doc = await h.store.readDoc({ kind: 'project', projectRoot: h.dir })
  assert.ok(doc.content.includes('自动整理新增的事实'), '整理结果必须写进 project 文件')
  assert.ok(doc.content.includes('source:digest'), '条目来源必须是 source:digest')

  // 新周期的前两轮不触发：证明是每 N 轮而不是每轮。
  await h.emitTurn()
  await h.emitTurn()
  await delay(150)
  assert.equal(h.streamCalls(), 1, '新周期前两轮不得再触发')
  assert.equal((await h.store.readRuns(20)).length, 1)
})

// ——————————————————————————————————————————————
// A2) v2：整理只写 project
// ——————————————————————————————————————————————

test('v2 整理只写 project：模型输出的 soul/user/global 条目全部被丢弃', async (t) => {
  const h = await makeDigestHarness({
    config: { digestEveryTurns: 1 },
    llmText: JSON.stringify({
      soul: ['自动整理不得写人格'],
      user: ['自动整理不得写画像'],
      global: ['自动整理不得写全局'],
      project: ['整理器应该只写这条项目事实'],
    }),
  })
  t.after(h.cleanup)

  await h.emitTurn()
  const runs = await h.waitForRuns(1)
  assert.equal(runs.length, 1, '必须产生一条运行记录')
  assert.equal(runs[0].ok, true, JSON.stringify(runs[0]))
  assert.deepEqual(runs[0].counts, { soul: 0, user: 0, global: 0, project: 1 }, '非 project 的 counts 必须恒为 0')

  const projectDoc = await h.store.readDoc({ kind: 'project', projectRoot: h.dir })
  assert.ok(projectDoc.content.includes('整理器应该只写这条项目事实'), 'project 条目必须写入')

  const forbidden = [
    ['soul', '自动整理不得写人格'],
    ['user', '自动整理不得写画像'],
    ['global', '自动整理不得写全局'],
  ]
  for (const [kind, marker] of forbidden) {
    const doc = await h.store.readDoc({ kind, persona: 'default', presetId: 'default' })
    assert.equal(doc.content.includes(marker), false, `${kind} 不得被自动整理写入`)
  }
})

test('v2 整理输出只有 soul/user/global 时：一次空写、不产生任何文件变更', async (t) => {
  const h = await makeDigestHarness({
    config: { digestEveryTurns: 1 },
    llmText: JSON.stringify({ soul: ['人格'], user: ['画像'], global: ['全局'] }),
  })
  t.after(h.cleanup)

  await h.emitTurn()
  const runs = await h.waitForRuns(1)
  assert.equal(runs.length, 1)
  assert.equal(runs[0].ok, true)
  assert.deepEqual(runs[0].counts, { soul: 0, user: 0, global: 0, project: 0 })

  const projectDoc = await h.store.readDoc({ kind: 'project', projectRoot: h.dir })
  assert.equal(projectDoc.content.includes('人格'), false)
  assert.equal(projectDoc.content.includes('画像'), false)
  assert.equal(projectDoc.content.includes('全局'), false)
})

test('子智能体的 turn/end 不触发自动整理（parentSession 或 isSubagent 两种判定都要拦住）', async (t) => {
  const h = await makeDigestHarness({ config: { digestEveryTurns: 1 } })
  t.after(h.cleanup)

  const byHeader = h.addSession('child-header', { parentSession: 'sess-main' }, true)
  await h.emitTurn(byHeader)
  await h.emitTurn(byHeader)

  const onlyFlag = h.addSession('child-flag', {}, true)
  await h.emitTurn(onlyFlag)

  await delay(200)
  assert.equal(h.streamCalls(), 0, '子智能体不得触发自动整理')
  assert.deepEqual(await h.store.readRuns(20), [])
})

test('autoDigest=false 时不触发任何自动整理', async (t) => {
  const h = await makeDigestHarness({ config: { digestEveryTurns: 1, autoDigest: false } })
  t.after(h.cleanup)
  for (let index = 0; index < 3; index += 1) await h.emitTurn()
  await delay(200)
  assert.equal(h.streamCalls(), 0)
  assert.deepEqual(await h.store.readRuns(20), [])
})

test('turn/end 的 reason.kind 非 completed（aborted / error）不触发', async (t) => {
  const h = await makeDigestHarness({ config: { digestEveryTurns: 1 } })
  t.after(h.cleanup)
  await h.emitTurn(h.session, 'aborted')
  await h.emitTurn(h.session, 'error')
  await delay(200)
  assert.equal(h.streamCalls(), 0)
  assert.deepEqual(await h.store.readRuns(20), [])
})

// ——————————————————————————————————————————————
// B) 上下文压力触发
// ——————————————————————————————————————————————

test('tokenMeter 压力达阈值（0.9 >= 0.75）→ 触发 pressure 整理', async (t) => {
  const h = await makeDigestHarness({
    config: { digestEveryTurns: 0, digestPressureRatio: 0.75 },
    pressure: { pressureTokens: 90000, contextWindow: 100000 },
  })
  t.after(h.cleanup)

  await h.emitTurn()
  const runs = await h.waitForRuns(1)
  assert.equal(runs.length, 1)
  assert.equal(runs[0].trigger, 'pressure')
  assert.equal(runs[0].ok, true)
  assert.equal(h.streamCalls(), 1)
})

test('上下文压力低于阈值（0.5 < 0.75）不触发', async (t) => {
  const h = await makeDigestHarness({
    config: { digestEveryTurns: 0, digestPressureRatio: 0.75 },
    pressure: { pressureTokens: 50000, contextWindow: 100000 },
  })
  t.after(h.cleanup)
  await h.emitTurn()
  await h.emitTurn()
  await delay(200)
  assert.equal(h.streamCalls(), 0)
  assert.deepEqual(await h.store.readRuns(20), [])
})

// ——————————————————————————————————————————————
// C) 注入链路回归
// ——————————————————————————————————————————————

/**
 * 假 session：append-only 日志 + 当前 surface 节点，复刻宿主 replace 的硬校验。
 * @param {string} id - 会话 id。
 * @param {{ systemHead?: boolean }} [options] - `systemHead: false` 模拟宿主还没写出
 *   system/message 的最初那个 step——此时注入必须整体让路，抢跑会把会话永久写坏。
 * @returns {object} 假 session。
 */
function makeSession(id, options = {}) {
  const events = []
  let nodes = []
  // 真实宿主在第一个 step 内就写好 system/message，并登记为 surface 的受保护头部，
  // 此后一直挂在 nodes 上。桩默认带上它：inject 的头部门控（hasSystemHead）会挡住
  // 全部注入，而那道门控正是「快照抢跑写坏会话」的修复本身。少了这条事件，测的就
  // 不是宿主真实形态。
  if (options.systemHead !== false) {
    events.push({
      type: 'system/message',
      seq: 0,
      data: { role: 'system', content: [{ type: 'text', text: 'system prompt' }] },
    })
    nodes.push(0)
  }
  return {
    id,
    header: {},
    get surface() {
      return { nodes }
    },
    snapshotEvents() {
      return events.slice()
    },
    append(type, data, opts) {
      const seq = events.length
      const op = opts?.surfaceOp
      if (op !== undefined) {
        assert.equal(type, 'user/message')
        assert.equal(typeof data?.id, 'string')
        assert.ok(Array.isArray(data?.content) && data.content.length > 0, 'content 必须非空')
        assert.equal(data?.role, 'user')
        assert.equal(typeof data?.source?.kind, 'string')
      }
      if (op !== undefined && op !== 'append') {
        const start = nodes.indexOf(op.startSeq)
        const end = nodes.indexOf(op.endSeq)
        assert.ok(start >= 0 && end >= start, 'replace 范围必须命中 surface 节点')
        const sources = opts?.sourceEventSeqs
        assert.ok(Array.isArray(sources) && sources.length > 0, 'replace 必须带非空 sourceEventSeqs')
        for (const source of sources) assert.ok(source < seq, 'sourceEventSeqs 只能引用更早事件')
        for (const node of nodes.slice(start, end + 1)) {
          assert.ok(sources.includes(node), `sourceEventSeqs 必须覆盖被遮蔽节点 ${node}`)
        }
      }
      events.push({
        type,
        seq,
        data,
        ...(op === undefined ? {} : { surfaceOp: op }),
        ...(opts?.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: opts.sourceEventSeqs }),
      })
      if (op === 'append') nodes.push(seq)
      else if (op !== undefined) {
        const start = nodes.indexOf(op.startSeq)
        const end = nodes.indexOf(op.endSeq)
        nodes.splice(start, end - start + 1, seq)
      }
      return seq
    },
    /** surface 上的本插件快照。 */
    pluginSnapshots() {
      return nodes.map((seq) => events[seq]).filter((event) => event?.data?.source?.kind === 'dsh-supermemory')
    },
    /** 日志里全部（含被 replace 掉的）本插件事件。 */
    allPluginEvents() {
      return events.filter((event) => event.data?.source?.kind === 'dsh-supermemory')
    },
  }
}

/**
 * 建注入夹具（真实 store + 真实 installInjection）。
 * @param {object} [options]
 * @param {object} [options.config] - 覆盖配置。
 * @param {() => boolean} [options.isEnabled] - 假插件总开关（缺失视为「开启」）。
 * @param {boolean} [options.systemHead] - 传 false 表示宿主还没写出 system/message，
 *   即会话最初那个 step——此时注入必须整体让路。
 * @returns {Promise<object>} 夹具。
 */
async function makeInjectionHarness(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'sm-inject-'))
  // v2：人格/画像/全局记忆落在 personas/ 下；store 可能只认 personasRoot。
  const presetsRoot = join(dir, 'personas')
  const rawConfig = { presetsRoot, personasRoot: presetsRoot, ...options.config }
  const store = createStore({
    dshHome: dir,
    presetsRoot,
    personasRoot: presetsRoot,
    config: resolveConfig(rawConfig),
    logger: { warn() {} },
  })
  if (store?.ready !== undefined) await store.ready
  const session = makeSession('sess-inject', options)
  const scope = { persona: 'default', presetId: 'default', projectRoot: dir, projectName: 'proj' }
  const ctx = makeCtx({})
  const deps = {
    store,
    getConfig: () => resolveConfig(rawConfig),
    loadScope: async () => scope,
    isSubagent: () => false,
    isEnabled: options.isEnabled,
    logger: ctx.logger,
  }
  const dispose = installInjection(ctx, deps)
  const refs = {
    soul: { kind: 'soul', persona: 'default', presetId: 'default' },
    user: { kind: 'user', persona: 'default', presetId: 'default' },
    global: { kind: 'global', persona: 'default', presetId: 'default' },
    project: { kind: 'project', projectRoot: dir },
  }
  const seed = (kind, body, time = '2026-11-10T00:00:00.000Z') =>
    store.appendEntries(refs[kind], [{ time, source: 'user-request', body }])
  /**
   * 触发一次 pre-step，并**复刻宿主的提交动作**：`dsh-agent-loop` 在 append 完
   * system/message 之后、构造请求之前，会把 `decision.messages` 里非 runtime-context
   * 的消息逐条 `session.append('user/message', ..., { surfaceOp: 'append' })`。
   * 插件把首次快照交给这条通道，所以夹具不模拟它就看不到快照落到 surface。
   * @param {{ commit?: boolean }} [opts] - `commit: false` 只看插件返回了什么，
   *   不落盘——用于证明插件没有自己 append。
   * @returns {Promise<object>} pre-step 的 decision。
   */
  const runPreStep = async (opts = {}) => {
    const decision = await ctx.waterfall(
      'agent/pre-step',
      { agent: { session }, messages: [], step: 1, signal: { aborted: false } },
      () => ({ kind: 'enter', messages: [], startsRequestSeries: true }),
    )
    if (opts.commit !== false && Array.isArray(decision?.messages)) {
      for (const message of decision.messages) session.append('user/message', message, { surfaceOp: 'append' })
    }
    return decision
  }
  const cleanup = async () => {
    try {
      dispose()
    } catch {
      /* ignore */
    }
    try {
      ctx.disposeAll()
    } catch {
      /* ignore */
    }
    await store.dispose()
    await rm(dir, { recursive: true, force: true })
  }
  return { dir, store, ctx, session, refs, seed, runPreStep, cleanup }
}

test('首次 pre-step：恰好追加 1 条快照，source 结构与首行提示符合契约', async (t) => {
  const h = await makeInjectionHarness()
  t.after(h.cleanup)
  await h.seed('global', '喜欢深色主题')

  const decision = await h.runPreStep()
  assert.equal(decision.kind, 'enter')
  assert.equal(h.session.pluginSnapshots().length, 1)

  const event = h.session.pluginSnapshots()[0]
  assert.equal(event.surfaceOp, 'append')
  assert.equal(event.data.source.kind, 'dsh-supermemory')
  assert.equal(event.data.source.form, 'snapshot')
  assert.equal(typeof event.data.source.digest, 'string')
  assert.ok(event.data.source.sections.some((section) => section.name === 'global'))

  const text = event.data.content[0].text
  assert.ok(text.startsWith(SNAPSHOT_NOTICE), '正文首行必须是「不是用户发言」提示')
  assert.ok(text.includes('喜欢深色主题'))
})

test('首次注入交给宿主落盘：插件绝不自己 append（自己写必然抢跑）', async (t) => {
  const h = await makeInjectionHarness()
  t.after(h.cleanup)
  await h.seed('global', '喜欢深色主题')

  const decision = await h.runPreStep({ commit: false })
  assert.equal(h.session.allPluginEvents().length, 0, '插件自己 append 就会抢在 system/message 之前，把会话永久写坏')
  const mine = (decision.messages ?? []).filter((m) => m?.source?.kind === 'dsh-supermemory')
  assert.equal(mine.length, 1, '快照必须放进 decision.messages 交给宿主')
  assert.ok(mine[0]?.content?.[0]?.text?.startsWith(SNAPSHOT_NOTICE), '交给宿主的仍是合规快照')

  // 宿主按自己的时机落盘之后，surface 上恰好一条。
  for (const message of decision.messages) h.session.append('user/message', message, { surfaceOp: 'append' })
  assert.equal(h.session.pluginSnapshots().length, 1)
})

test('replace 兜底：历史里没有 system/message 时跳过替换并留下告警', async (t) => {
  const h = await makeInjectionHarness({ systemHead: false })
  t.after(h.cleanup)
  await h.seed('global', '喜欢深色主题')

  // 手工落盘造出「快照已在、受保护头部却不在」的越界形态——正常路径出不出来，
  // 正因如此这道兜底才需要有人替它站岗。
  const first = await h.runPreStep({ commit: false })
  for (const message of first.messages) h.session.append('user/message', message, { surfaceOp: 'append' })
  assert.equal(h.session.pluginSnapshots().length, 1)

  await h.seed('global', '再记一条，让 digest 变化')
  const nodesBefore = h.session.surface.nodes.slice()
  await h.runPreStep()
  assert.deepEqual(h.session.surface.nodes, nodesBefore, '越界形态下 surface 必须原样不动')
  assert.ok(
    h.ctx.warnings.some((w) => /system\/message/.test(String(w))),
    '跳过替换必须留下告警，静默等于把问题埋掉',
  )
})

test('hasSystemHead：读不到日志一律判 false（宁可不写，也不写坏会话）', () => {
  assert.equal(hasSystemHead(undefined), false)
  assert.equal(hasSystemHead(null), false)
  assert.equal(hasSystemHead({}), false, '没有 snapshotEvents 的宿主按未就绪处理')
  assert.equal(hasSystemHead({ snapshotEvents: () => { throw new Error('log corrupted') } }), false)
  assert.equal(hasSystemHead({ snapshotEvents: () => [{ type: 'user/message' }] }), false)
  assert.equal(
    hasSystemHead({ snapshotEvents: () => [{ type: 'user/message' }, { type: 'system/message' }] }),
    true,
    'append-only 日志里写过就算就绪，不受压缩遮蔽影响',
  )
})

test('内容不变：重复 pre-step 不追加、不 replace', async (t) => {
  const h = await makeInjectionHarness()
  t.after(h.cleanup)
  await h.seed('global', '稳定事实')
  await h.runPreStep()
  const first = h.session.pluginSnapshots()[0]
  const count = h.session.allPluginEvents().length

  await h.runPreStep()
  await h.runPreStep()
  assert.equal(h.session.allPluginEvents().length, count, '内容不变不得新增日志事件')
  assert.equal(h.session.pluginSnapshots().length, 1)
  assert.equal(h.session.pluginSnapshots()[0].data.source.digest, first.data.source.digest)
})

test('内容变化：surfaceOp replace 替换同一条，surface 仍恰好 1 条', async (t) => {
  const h = await makeInjectionHarness()
  t.after(h.cleanup)
  await h.seed('global', '旧事实')
  await h.runPreStep()
  const old = h.session.pluginSnapshots()[0]

  await h.seed('global', '新事实', '2026-11-10T01:00:00.000Z')
  await h.runPreStep()

  const snapshots = h.session.pluginSnapshots()
  assert.equal(snapshots.length, 1, 'surface 上本插件消息必须恰好一条')
  const current = snapshots[0]
  assert.notEqual(current.data.source.digest, old.data.source.digest)
  assert.equal(current.seq > old.seq, true)
  assert.deepEqual(current.surfaceOp, {
    op: 'replace',
    startSeq: old.seq,
    endSeq: old.seq,
  })
  assert.deepEqual(current.sourceEventSeqs, [old.seq], '宿主校验要求覆盖被遮蔽节点')
  assert.ok(current.data.content[0].text.includes('新事实'))
})

test('四段全空：旧快照被替换成 digest=empty 的占位，surface 仍 1 条且不重复替换', async (t) => {
  const h = await makeInjectionHarness()
  t.after(h.cleanup)
  for (const kind of ['soul', 'user', 'global', 'project']) {
    await h.seed(kind, '一条将被清空的记忆')
  }
  await h.runPreStep()
  assert.equal(h.session.pluginSnapshots().length, 1)
  const old = h.session.pluginSnapshots()[0]
  assert.ok(old.data.content[0].text.includes('一条将被清空的记忆'))

  // 清空四个分区：写回空串即视为无正文。
  for (const kind of ['soul', 'user', 'global', 'project']) {
    const doc = await h.store.readDoc(h.refs[kind])
    const written = await h.store.writeDoc(h.refs[kind], '', { expectedMtimeMs: doc.mtimeMs })
    assert.equal(written.ok, true)
  }

  await h.runPreStep()
  const snapshots = h.session.pluginSnapshots()
  assert.equal(snapshots.length, 1)
  const placeholder = snapshots[0]
  assert.equal(placeholder.data.source.digest, EMPTY_DIGEST)
  assert.deepEqual(placeholder.data.source.sections, [])
  assert.ok(placeholder.data.content[0].text.includes(EMPTY_SNAPSHOT_TEXT))
  assert.equal(placeholder.data.content[0].text.includes('一条将被清空的记忆'), false)
  assert.equal(placeholder.seq > old.seq, true)

  // 占位 digest 固定：再跑一轮不应重复 replace。
  const logLength = h.session.allPluginEvents().length
  await h.runPreStep()
  assert.equal(h.session.allPluginEvents().length, logLength)
  assert.equal(h.session.pluginSnapshots().length, 1)
})

// ——————————————————————————————————————————————
// D) 插件总开关 deps.isEnabled
// ——————————————————————————————————————————————

test('总开关关闭：轮数与压力都不触发自动整理，也不产生任何运行记录', async (t) => {
  let enabled = false
  const byTurns = await makeDigestHarness({ config: { digestEveryTurns: 1 }, isEnabled: () => enabled })
  t.after(byTurns.cleanup)
  for (let index = 0; index < 3; index += 1) await byTurns.emitTurn()
  await delay(200)
  assert.equal(byTurns.streamCalls(), 0, '关闭时轮数达到阈值也不得整理')
  assert.deepEqual(await byTurns.store.readRuns(20), [], '关闭时不得产生运行记录')

  const byPressure = await makeDigestHarness({
    config: { digestEveryTurns: 0, digestPressureRatio: 0.75 },
    pressure: { pressureTokens: 90000, contextWindow: 100000 },
    isEnabled: () => enabled,
  })
  t.after(byPressure.cleanup)
  await byPressure.emitTurn()
  await byPressure.emitTurn()
  await delay(200)
  assert.equal(byPressure.streamCalls(), 0, '关闭时压力越阈也不得整理')
  assert.deepEqual(await byPressure.store.readRuns(20), [])

  // 重新开启后轮数触发恢复：证明拦住行为的是开关本身。
  enabled = true
  await byTurns.emitTurn()
  const runs = await byTurns.waitForRuns(1)
  assert.equal(runs.length, 1, '重新开启后必须恢复自动整理')
  assert.equal(runs[0].trigger, 'turns')
})

test('总开关只在 maybeTrigger 拦：手动 runDigest 仍可正常跑（手动由 routes 层负责拦）', async (t) => {
  const h = await makeDigestHarness({ config: { digestEveryTurns: 1 }, isEnabled: () => false })
  t.after(h.cleanup)

  await h.emitTurn()
  await delay(150)
  assert.equal(h.streamCalls(), 0, '自动触发必须被拦住')
  assert.deepEqual(await h.store.readRuns(20), [])

  const agent = h.ctx.services.agents.get('sess-main')
  const record = await h.runner.runDigest({ agent, trigger: 'manual' })
  assert.equal(record.ok, true, JSON.stringify(record))
  assert.equal(record.trigger, 'manual')
  assert.equal(h.streamCalls(), 1, '本层不得拦手动整理')
  const runs = await h.store.readRuns(20)
  assert.equal(runs.length, 1)
  assert.equal(runs[0].trigger, 'manual')
})

test('总开关关闭：pre-step 不再更新快照，已有快照原样保留（不替换、不写占位）', async (t) => {
  let enabled = true
  const h = await makeInjectionHarness({ isEnabled: () => enabled })
  t.after(h.cleanup)
  await h.seed('global', '旧事实')
  await h.runPreStep()
  const before = h.session.pluginSnapshots()[0]
  assert.ok(before.data.content[0].text.includes('旧事实'))
  const logLength = h.session.allPluginEvents().length

  // 关闭后即使记忆内容变化，pre-step 也必须一动不动（开启时这里一定会 replace）。
  enabled = false
  await h.seed('global', '新事实', '2026-11-10T01:00:00.000Z')
  const decision = await h.runPreStep()
  assert.equal(decision.kind, 'enter', '必须原样返回 decision')
  assert.equal(h.session.allPluginEvents().length, logLength, '关闭时不得新增任何事件')
  assert.equal(h.session.pluginSnapshots()[0], before, '旧快照必须原样保留')
  assert.equal(h.session.pluginSnapshots()[0].data.content[0].text.includes('新事实'), false)

  // 记忆被清空也不写「记忆已清空」占位：关闭状态下不做替换也不做清理。
  for (const kind of ['soul', 'user', 'global', 'project']) {
    const doc = await h.store.readDoc(h.refs[kind])
    const written = await h.store.writeDoc(h.refs[kind], '', { expectedMtimeMs: doc.mtimeMs })
    assert.equal(written.ok, true)
  }
  await h.runPreStep()
  assert.equal(h.session.allPluginEvents().length, logLength, '关闭时不得写占位快照')
  assert.equal(h.session.pluginSnapshots()[0], before)

  // 重新开启后恢复更新。
  enabled = true
  await h.runPreStep()
  assert.equal(h.session.pluginSnapshots().length, 1)
  assert.notEqual(h.session.pluginSnapshots()[0], before)
  assert.ok(h.session.pluginSnapshots()[0].data.content[0].text.includes(EMPTY_SNAPSHOT_TEXT))
})

// ——————————————————————————————————————————————
// E) v4 整编模式的编排（契约 §V4.0.6）
//
// 这一节只盯编排层该负责的三件事：走没走对模式、失败时有没有守住"不写盘"、
// 快照这道安全网有没有生效。对账算法本身的正确性由 test/consolidate-core.test.js 管。
// ——————————————————————————————————————————————

/** 造一份条目数达到整编阈值（默认 20 条）的 project 记忆。 */
async function seedProject(h, count = 20) {
  const items = []
  for (let index = 0; index < count; index += 1) {
    items.push({
      time: `2026-01-01T${String(index % 24).padStart(2, '0')}:00:00.000Z`,
      source: 'digest',
      body: `第 ${index} 条项目事实：这条记忆用来把文档撑到整编阈值以上，正文本身没有额外含义。`,
    })
  }
  await h.store.writeDoc({ kind: 'project', projectRoot: h.dir }, appendEntries(emptyDocument('项目记忆'), items), {})
}

/** 读 project 全文。 */
async function readProject(h) {
  const doc = await h.store.readDoc({ kind: 'project', projectRoot: h.dir })
  return String(doc?.content ?? '')
}

/** 手动跑一次整理并返回 RunRecord。 */
async function runManual(h) {
  return h.runner.runDigest({ agent: h.ctx.services.agents.get('sess-main'), trigger: 'manual' })
}

test('整编模式：规模达标即走整编，落盘的是目标态，未提及的条目一条不少，原文进了快照', async (t) => {
  const h = await makeDigestHarness()
  t.after(h.cleanup)
  await seedProject(h)
  const before = await readProject(h)
  const ids = parseEntries(before).map((entry) => entry.id)

  h.setLlmText(JSON.stringify({
    entries: [
      { text: '第 0 条与第 1 条合并后的结论。', from: [ids[0], ids[1]] },
      { text: '一条全新的项目事实。', from: [] },
    ],
    drop: [{ id: ids[2], reason: '该事实已失效，且没有可替代的说法' }],
  }))

  const record = await runManual(h)
  assert.equal(record.ok, true, JSON.stringify(record))
  assert.equal(h.streamParams().system, CONSOLIDATE_SYSTEM_PROMPT, '必须用整编提示词调模型')
  assert.equal(record.mode, 'consolidate')
  assert.deepEqual(
    [record.consolidation.added, record.consolidation.merged, record.consolidation.dropped, record.consolidation.kept],
    // added 数的是**本次写入的新条目**（合并产物那条也算），故结果条数 = kept + added = 19。
    [2, 2, 1, 17],
    JSON.stringify(record.consolidation),
  )

  const after = await readProject(h)
  assert.ok(after.includes('第 0 条与第 1 条合并后的结论。'), '合并结果要落盘')
  assert.ok(after.includes('一条全新的项目事实。'), '新增条目要落盘')
  assert.equal(parseEntries(after).length, 19, '20 − 吸收 2 + 新增 1 − drop 1 = 19')
  assert.ok(!after.includes('第 2 条项目事实'), '被 drop 的条目应已移除')
  // 生命线：模型没点名的 17 条必须原样还在。
  for (let index = 3; index < 20; index += 1) {
    assert.ok(after.includes(`第 ${index} 条项目事实`), `未提及的第 ${index} 条被弄丢了`)
  }

  const dir = join(h.dir, '.dsh', 'memory', 'history')
  const files = await readdir(dir)
  assert.equal(files.length, 1, '整编落盘前要留一份原文快照')
  assert.equal(await readFile(join(dir, files[0]), 'utf8'), before, '快照必须逐字节等于被覆盖的原文')
})

test('整编栅栏命中就拒绝落盘：原文一个字节不改，也不留快照', async (t) => {
  const h = await makeDigestHarness()
  t.after(h.cleanup)
  await seedProject(h)
  const before = await readProject(h)
  const ids = parseEntries(before).map((entry) => entry.id)

  // 20 条全吸收成一句话，体积远低于 minKeepRatio → SHRINK_GUARD。
  h.setLlmText(JSON.stringify({ entries: [{ text: '全都合并成这一句。', from: ids }], drop: [] }))

  const record = await runManual(h)
  assert.equal(record.ok, false)
  assert.match(String(record.error), /SHRINK_GUARD/, JSON.stringify(record))
  assert.equal(await readProject(h), before, '被拒绝的整编不得改动原文')
  await assert.rejects(readdir(join(h.dir, '.dsh', 'memory', 'history')), '栅栏拒绝时不该产生快照')
})

test('快照备不出来就拒绝覆盖：唯一的安全网缺失时宁可不写', async (t) => {
  const h = await makeDigestHarness()
  t.after(h.cleanup)
  await seedProject(h)
  const before = await readProject(h)
  const ids = parseEntries(before).map((entry) => entry.id)
  h.setLlmText(JSON.stringify({
    entries: [{ text: '第 0 条与第 1 条合并后的结论。', from: [ids[0], ids[1]] }],
    drop: [],
  }))
  h.store.writeDocSnapshot = undefined

  const record = await runManual(h)
  assert.equal(record.ok, false)
  assert.match(String(record.error), /snapshot failed/, JSON.stringify(record))
  assert.equal(await readProject(h), before, '没有快照兜底就不得覆盖记忆')
})

test('整编输入装不下：直接放弃整编，一次模型都不调，也不退回追加', async (t) => {
  const h = await makeDigestHarness({ config: { digestMaxInputBytes: 600 } })
  t.after(h.cleanup)
  await seedProject(h)
  const before = await readProject(h)

  const record = await runManual(h)
  assert.equal(record.ok, false)
  assert.equal(h.streamCalls(), 0, '装不下就不该花钱调模型')
  assert.match(String(record.error), /INPUT_OVERFLOW/, JSON.stringify(record))
  assert.equal(await readProject(h), before)
})

test('冷却期内下一次整理退回追加：不重复整编', async (t) => {
  const h = await makeDigestHarness()
  t.after(h.cleanup)
  await seedProject(h)
  const ids = parseEntries(await readProject(h)).map((entry) => entry.id)

  h.setLlmText(JSON.stringify({
    entries: [{ text: '第 0 条与第 1 条合并后的结论。', from: [ids[0], ids[1]] }],
    drop: [],
  }))
  const first = await runManual(h)
  assert.equal(first.mode, 'consolidate', JSON.stringify(first))

  h.setLlmText(DIGEST_JSON)
  const second = await runManual(h)
  assert.equal(second.ok, true, JSON.stringify(second))
  assert.equal(second.mode, 'append', '刚整编过就落在冷却期里，第二次必须走追加')
  assert.ok((await readProject(h)).includes('自动整理新增的事实'), '追加路径照常写回')
})

test('输出被 maxTokens 截断要报出可行动的错误，不能含糊成「输出为空」', async (t) => {
  // 推理模型的真实死法：思考把预算用光，正文一个字没产出，流以 length 收尾。
  const h = await makeDigestHarness({ finishKind: 'length', llmText: '' })
  t.after(h.cleanup)

  const record = await runManual(h)
  assert.equal(record.ok, false)
  assert.match(String(record.error), /maxTokens/, JSON.stringify(record))
})
