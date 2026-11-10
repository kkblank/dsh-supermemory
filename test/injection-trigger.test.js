/**
 * 注入链路 + 自动整理触发的正向回归测试。
 *
 * 补 `test/host-install.test.js` 与 `test/routes.test.js` 未覆盖的核心缺口：
 *   A) `digestEveryTurns` 计数触发 —— 第 N 轮恰好触发一次，且真的写回文件（PLAN 成功标准 6）。
 *   B) `tokenMeter.contextPressure` 达阈值触发 `pressure` 整理。
 *   C) 快照注入 append / 内容不变不写 / 内容变化 replace / 清空后占位替换。
 *
 * 全部用假 ctx + 真实 store / createDigestRunner / installInjection，不装依赖。
 * 运行：node --test test/injection-trigger.test.js
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from '../lib/core/store.js'
import { resolveConfig } from '../lib/host/config.js'
import { createDigestRunner } from '../lib/host/digest.js'
import { EMPTY_DIGEST, EMPTY_SNAPSHOT_TEXT, installInjection, SNAPSHOT_NOTICE } from '../lib/host/inject.js'

/** 整理器固定返回的 JSON（global 一条新增事实）。 */
const DIGEST_JSON = '{"soul":[],"user":[],"global":["自动整理新增的事实"],"project":[]}'

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
 * @returns {Promise<object>} 夹具。
 */
async function makeDigestHarness(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'sm-trigger-'))
  const presetsRoot = join(dir, 'presets')
  const rawConfig = { presetsRoot, digestProvider: 'fake-provider', digestModel: 'fake-model', ...options.config }
  const store = createStore({ dshHome: dir, presetsRoot, config: resolveConfig(rawConfig), logger: { warn() {} } })

  let streamCalls = 0
  const llmText = options.llmText ?? DIGEST_JSON
  // 关键：stream 必须**同步**返回 AsyncIterable，不能是 Promise。
  const llm = {
    stream() {
      streamCalls += 1
      return (async function* () {
        yield { type: 'text-delta', index: 0, text: llmText }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const agents = new Map()
  const services = { llm, agents }
  if (options.pressure !== undefined) {
    services.tokenMeter = { contextPressure: () => options.pressure }
  }

  const ctx = makeCtx(services)
  const scope = { presetId: 'default', projectRoot: dir, projectName: 'proj' }
  const deps = {
    store,
    getConfig: () => resolveConfig(rawConfig),
    resolveScope: async () => scope,
    currentRoute: () => ({ provider: 'fake-provider', model: 'fake-model' }),
    isSubagent: (agent) => agent?.isSubagent === true,
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
  assert.equal(runs[0].counts.global, 1)
  assert.equal(h.streamCalls(), 1, '恰好调用一次 LLM')

  // 整理条目必须真的落到文件里。
  const doc = await h.store.readDoc({ kind: 'global', presetId: 'default' })
  assert.ok(doc.content.includes('自动整理新增的事实'), '整理结果必须写进 global 文件')
  assert.ok(doc.content.includes('source:digest'), '条目来源必须是 source:digest')

  // 新周期的前两轮不触发：证明是每 N 轮而不是每轮。
  await h.emitTurn()
  await h.emitTurn()
  await delay(150)
  assert.equal(h.streamCalls(), 1, '新周期前两轮不得再触发')
  assert.equal((await h.store.readRuns(20)).length, 1)
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
 * @returns {object} 假 session。
 */
function makeSession(id) {
  const events = []
  let nodes = []
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
 * @returns {Promise<object>} 夹具。
 */
async function makeInjectionHarness(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'sm-inject-'))
  const presetsRoot = join(dir, 'presets')
  const rawConfig = { presetsRoot, ...options.config }
  const store = createStore({ dshHome: dir, presetsRoot, config: resolveConfig(rawConfig), logger: { warn() {} } })
  const session = makeSession('sess-inject')
  const scope = { presetId: 'default', projectRoot: dir, projectName: 'proj' }
  const ctx = makeCtx({})
  const deps = {
    store,
    getConfig: () => resolveConfig(rawConfig),
    loadScope: async () => scope,
    isSubagent: () => false,
    logger: ctx.logger,
  }
  const dispose = installInjection(ctx, deps)
  const refs = {
    soul: { kind: 'soul', presetId: 'default' },
    user: { kind: 'user', presetId: 'default' },
    global: { kind: 'global', presetId: 'default' },
    project: { kind: 'project', projectRoot: dir },
  }
  const seed = (kind, body, time = '2026-11-10T00:00:00.000Z') =>
    store.appendEntries(refs[kind], [{ time, source: 'user-request', body }])
  const runPreStep = () =>
    ctx.waterfall(
      'agent/pre-step',
      { agent: { session }, messages: [], step: 1, signal: { aborted: false } },
      () => ({ kind: 'enter', messages: [], startsRequestSeries: true }),
    )
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
