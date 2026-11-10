/**
 * Host 侧装配自测：inject / tools / commands。
 *
 * 用假 ctx（get / on / effect / logger）+ 假 session（append / snapshotEvents /
 * surface）+ 真实 store（临时目录）覆盖契约 §5.1–§5.3 的关键路径。
 *
 * 运行：node --test test/host-install.test.js
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from '../lib/core/store.js'
import { resolveConfig } from '../lib/host/config.js'
import { installInjection, SNAPSHOT_NOTICE } from '../lib/host/inject.js'
import { installTools } from '../lib/host/tools.js'
import { installCommands, parseRememberInput } from '../lib/host/commands.js'

  /**
   * 假 session：维护 append-only 日志与 surface 节点顺序。
   *
   * `append` 复刻宿主的强制性校验（dsh-session/lib/types/surface.js）：
   *   - `user/message` 必须带 `id` 与非空 `content`；
   *   - `source.kind` 必须是非空字符串；
   *   - `surfaceOp:'replace'` 必须带覆盖全部被遮蔽节点的非空 `sourceEventSeqs`，
   *     且只能引用更早的事件。
   * 这样「忘了传 sourceEventSeqs」这类错误在自测里就会暴露，而不是等到真实宿主。
   *
   * @returns {object} 假 session。
   */
  function makeSession() {
    const events = []
    let nodes = []

    const assertMessageShape = (seq, type, data) => {
      assert.equal(type, 'user/message')
      assert.equal(typeof data?.id, 'string')
      assert.notEqual(data.id, '')
      assert.equal(data?.role, 'user')
      assert.ok(Array.isArray(data?.content) && data.content.length > 0, 'content 必须是非空数组')
      assert.equal(typeof data?.source?.kind, 'string')
      assert.notEqual(data?.source?.kind, '')
    }

    const session = {
      get seq() {
        return events.length
      },
      get surface() {
        return { get nodes() { return nodes } }
      },
      snapshotEvents() {
        return events.slice()
      },
      append(type, data, opts) {
        const seq = events.length
        const op = opts?.surfaceOp
        if (op !== undefined) assertMessageShape(seq, type, data)

        if (op !== undefined && op !== 'append') {
          // —— 复刻宿主的 replace 校验 ——
          const shadowed = nodes.slice(
            nodes.indexOf(op.startSeq),
            nodes.indexOf(op.endSeq) + 1,
          )
          assert.ok(shadowed.length > 0, 'replace 的范围必须命中 surface 节点')
          const sources = opts?.sourceEventSeqs
          assert.ok(Array.isArray(sources) && sources.length > 0, 'replace 必须带非空 sourceEventSeqs')
          assert.equal(new Set(sources).size, sources.length, 'sourceEventSeqs 不得重复')
          for (const source of sources) {
            assert.equal(source < seq, true, `sourceEventSeqs 只能引用更早事件（${source} >= ${seq}）`)
          }
          const missing = shadowed.filter((node) => !sources.includes(node))
          assert.deepEqual(missing, [], `sourceEventSeqs 必须覆盖全部被遮蔽节点，缺失 ${missing.join(', ')}`)
        }

        const event = {
          type,
          seq,
          time: Date.now(),
          data,
          ...(op === undefined ? {} : { surfaceOp: op }),
          ...(opts?.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: opts.sourceEventSeqs }),
        }
        events.push(event)
        if (op === 'append') nodes.push(seq)
        else if (op !== undefined) {
          const start = nodes.indexOf(op.startSeq)
          const end = nodes.indexOf(op.endSeq)
          nodes.splice(start, end - start + 1, seq)
        }
        return event
      },
    /** 测试辅助：surface 上的本插件快照事件。 */
    pluginSnapshots() {
      return nodes
        .map((seq) => events[seq])
        .filter((event) => event?.type === 'user/message' && event.data?.source?.kind === 'dsh-supermemory')
    },
    /** 测试辅助：全部（含被 replace 掉的）本插件事件。 */
    allPluginEvents() {
      return events.filter(
        (event) => event.type === 'user/message' && event.data?.source?.kind === 'dsh-supermemory',
      )
    },
  }
  return session
}

/**
 * 假 ctx：可选服务、事件监听、effect 生命周期。
 * @returns {object} 假 ctx 与辅助句柄。
 */
function makeCtx() {
  const handlers = new Map()
  const disposers = []
  const services = new Map()
  const warnings = []

  const ctx = {
    logger: {
      warn: (...args) => warnings.push(args.map(String).join(' ')),
      info: () => {},
    },
    get(name) {
      return services.get(name)
    },
    on(event, fn) {
      const list = handlers.get(event) ?? []
      list.push(fn)
      handlers.set(event, list)
      const dispose = () => {
        const current = handlers.get(event) ?? []
        handlers.set(event, current.filter((entry) => entry !== fn))
      }
      disposers.push(dispose)
      return dispose
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    /** 测试辅助：触发某个事件的全部监听器。 */
    async emit(event, payload) {
      const list = handlers.get(event) ?? []
      const results = []
      for (const fn of list) results.push(await fn(payload))
      return results
    },
    /** 测试辅助：触发 waterfall 事件（监听器签名为 (payload, next)）。 */
    async waterfall(event, payload, next) {
      const list = handlers.get(event) ?? []
      if (list.length === 0) return next()
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
    services,
    warnings,
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

/**
 * 建一套完整的 deps + ctx + session 测试夹具。
 * @param {object} [options]
 * @param {object} [options.config] - 覆盖的配置字段。
 * @param {boolean} [options.withTools] - 是否挂 tools 服务。
 * @param {boolean} [options.withCommands] - 是否挂 commands 服务。
 * @param {boolean} [options.withPrompt] - 是否挂 systemPrompt 服务。
 */
async function makeHarness(options = {}) {
  const dshHome = await mkdtemp(join(tmpdir(), 'sm-host-'))
  const projectRoot = await mkdtemp(join(tmpdir(), 'sm-proj-'))
  const presetsRoot = join(dshHome, 'supermemory', 'presets')
  const config = resolveConfig({
    presetsRoot,
    ...options.config,
  })
  const store = createStore({ dshHome, presetsRoot, config, logger: { warn: () => {} } })

  const ctx = makeCtx()
  const session = makeSession()

  const sections = []
  const toolDefinitions = []
  const commandDefinitions = []
  const digestRequests = []
  let digestReport = { at: new Date().toISOString(), ok: true, trigger: 'manual', counts: { soul: 0, user: 0, global: 2, project: 0 } }

  if (options.withPrompt !== false) {
    ctx.services.set('systemPrompt', {
      section(definition) {
        sections.push(definition)
        return () => {
          const index = sections.indexOf(definition)
          if (index >= 0) sections.splice(index, 1)
        }
      },
    })
  }
  if (options.withTools !== false) {
    ctx.services.set('tools', {
      register(definition) {
        toolDefinitions.push(definition)
        return () => {
          const index = toolDefinitions.indexOf(definition)
          if (index >= 0) toolDefinitions.splice(index, 1)
        }
      },
    })
  }
  if (options.withCommands !== false) {
    ctx.services.set('commands', {
      register(definition) {
        commandDefinitions.push(definition)
        return () => {
          const index = commandDefinitions.indexOf(definition)
          if (index >= 0) commandDefinitions.splice(index, 1)
        }
      },
    })
  }

  const agent = {
    session,
    options: {},
  }

  const scope = { presetId: 'default', projectRoot, projectName: 'proj' }
  const deps = {
    store,
    dshHome,
    presetsRoot,
    logger: ctx.logger,
    getConfig: () => resolveConfig({ presetsRoot, ...options.config }),
    resolveScope: async () => scope,
    loadScope: async () => scope,
    isSubagent: (candidate) => candidate?.isSubagent === true,
    runDigest: async (request) => {
      digestRequests.push(request)
      return { ...digestReport, trigger: request?.trigger ?? 'manual' }
    },
  }

  const cleanup = async () => {
    ctx.disposeAll()
    await store.dispose()
    await rm(dshHome, { recursive: true, force: true })
    await rm(projectRoot, { recursive: true, force: true })
  }

  return {
    ctx,
    session,
    store,
    deps,
    agent,
    scope,
    sections,
    toolDefinitions,
    commandDefinitions,
    digestRequests,
    setDigestReport: (report) => {
      digestReport = report
    },
    cleanup,
  }
}

/** 跑一次 pre-step，返回 decision。 */
async function runPreStep(ctx, agent, extra = {}) {
  const decision = {
    kind: 'enter',
    messages: [],
    startsRequestSeries: true,
    ...extra,
  }
  return ctx.waterfall(
    'agent/pre-step',
    { agent, messages: [], step: 1, signal: { aborted: false } },
    () => decision,
  )
}

// ——————————————————————————————————————————————
// §5.1 注入
// ——————————————————————————————————————————————

test('pre-step 首次注入：surface 上恰好一条快照，source 结构符合契约', async (t) => {
  const h = await makeHarness()
  t.after(h.cleanup)

  await h.store.appendEntries(
    { kind: 'global', presetId: 'default' },
    [{ time: '2026-11-10T10:00:00.000Z', source: 'user-request', body: '喜欢深色主题' }],
  )

  const dispose = installInjection(h.ctx, h.deps)
  t.after(dispose)

  const decision = await runPreStep(h.ctx, h.agent)

  // 监听器绝不修改 decision.messages，也不破坏 startsRequestSeries。
  assert.deepEqual(decision.messages, [])
  assert.equal(decision.startsRequestSeries, true)

  const snapshots = h.session.pluginSnapshots()
  assert.equal(snapshots.length, 1)

  const data = snapshots[0].data
  assert.equal(data.source.kind, 'dsh-supermemory')
  assert.equal(data.source.form, 'snapshot')
  assert.equal(typeof data.source.digest, 'string')
  assert.equal(data.source.truncated, false)
  assert.ok(Array.isArray(data.source.sections))
  assert.ok(data.source.sections.some((section) => section.name === 'global'))
  assert.ok(data.source.byteSections !== undefined)
  assert.equal(snapshots[0].surfaceOp, 'append')

  const text = data.content[0].text
  assert.ok(text.startsWith(SNAPSHOT_NOTICE))
  assert.ok(text.includes('喜欢深色主题'))
})

test('pre-step 内容未变：不追加、不 replace', async (t) => {
  const h = await makeHarness()
  t.after(h.cleanup)
  await h.store.appendEntries(
    { kind: 'global', presetId: 'default' },
    [{ time: '2026-11-10T10:00:00.000Z', source: 'user-request', body: '稳定事实' }],
  )
  t.after(installInjection(h.ctx, h.deps))

  await runPreStep(h.ctx, h.agent)
  const firstDigest = h.session.pluginSnapshots()[0].data.source.digest
  const appendCountAfterFirst = h.session.allPluginEvents().length

  await runPreStep(h.ctx, h.agent)
  await runPreStep(h.ctx, h.agent)

  assert.equal(h.session.allPluginEvents().length, appendCountAfterFirst)
  assert.equal(h.session.pluginSnapshots().length, 1)
  assert.equal(h.session.pluginSnapshots()[0].data.source.digest, firstDigest)
})

test('pre-step 内容变化：用 surfaceOp replace 替换同一条，surface 仍只有一条', async (t) => {
  const h = await makeHarness()
  t.after(h.cleanup)
  const ref = { kind: 'global', presetId: 'default' }
  await h.store.appendEntries(ref, [{ time: '2026-11-10T10:00:00.000Z', source: 'user-request', body: '旧事实' }])
  t.after(installInjection(h.ctx, h.deps))

  await runPreStep(h.ctx, h.agent)
  const oldEvent = h.session.pluginSnapshots()[0]
  const oldDigest = oldEvent.data.source.digest

  await h.store.appendEntries(ref, [{ time: '2026-11-10T11:00:00.000Z', source: 'user-request', body: '新事实' }])

  const disposedApps = []
  const originalAppend = h.session.append
  h.session.append = (type, data, opts) => {
    disposedApps.push(opts)
    return originalAppend(type, data, opts)
  }
  t.after(() => {
    h.session.append = originalAppend
  })

  await runPreStep(h.ctx, h.agent)

  const snapshots = h.session.pluginSnapshots()
  assert.equal(snapshots.length, 1)
  const current = snapshots[0]
  assert.notEqual(current.data.source.digest, oldDigest)
  assert.equal(current.seq > oldEvent.seq, true)
  assert.deepEqual(disposedApps.at(-1), {
    surfaceOp: { op: 'replace', startSeq: oldEvent.seq, endSeq: oldEvent.seq },
    // 宿主强制要求：必须覆盖全部被遮蔽的 surface 节点。
    sourceEventSeqs: [oldEvent.seq],
  })
  assert.ok(current.data.content[0].text.includes('新事实'))
  assert.equal(current.data.content[0].text.includes('旧事实'), true, '追加语义下旧条目仍在文档里')
})

test('四段全空：不注入任何快照', async (t) => {
  const h = await makeHarness()
  t.after(h.cleanup)
  t.after(installInjection(h.ctx, h.deps))

  const decision = await runPreStep(h.ctx, h.agent)
  assert.equal(decision.kind, 'enter')
  assert.equal(h.session.allPluginEvents().length, 0)
})

test('记忆被清空：旧快照被替换成占位，surface 仍恰好 1 条且不再重复替换', async (t) => {
  const h = await makeHarness()
  t.after(h.cleanup)
  const refs = [
    { kind: 'soul', presetId: 'default' },
    { kind: 'user', presetId: 'default' },
    { kind: 'global', presetId: 'default' },
    { kind: 'project', projectRoot: h.scope.projectRoot },
  ]
  for (const ref of refs) {
    await h.store.appendEntries(ref, [
      { time: '2026-11-10T10:00:00.000Z', source: 'user-request', body: '一条将被清空的记忆' },
    ])
  }
  t.after(installInjection(h.ctx, h.deps))

  await runPreStep(h.ctx, h.agent)
  assert.equal(h.session.pluginSnapshots().length, 1)
  const oldEvent = h.session.pluginSnapshots()[0]
  assert.ok(oldEvent.data.content[0].text.includes('一条将被清空的记忆'))

  // 清空全部四个分区（写回空串即视为无正文）。
  for (const ref of refs) {
    const doc = await h.store.readDoc(ref)
    const written = await h.store.writeDoc(ref, '', { expectedMtimeMs: doc.mtimeMs })
    assert.equal(written.ok, true)
  }

  await runPreStep(h.ctx, h.agent)

  const snapshots = h.session.pluginSnapshots()
  assert.equal(snapshots.length, 1, 'surface 上本插件消息必须恰好一条')
  const current = snapshots[0]
  assert.ok(current.data.content[0].text.includes('当前没有已保存的记忆内容'))
  assert.equal(current.data.content[0].text.includes('一条将被清空的记忆'), false)
  assert.equal(current.data.source.digest, 'empty')
  assert.deepEqual(current.data.source.sections, [])
  assert.deepEqual(current.data.source.byteSections, { soul: 0, user: 0, global: 0, project: 0 })
  assert.equal(current.seq > oldEvent.seq, true)

  // 占位 digest 固定：再跑一轮不应重复 replace。
  const logLength = h.session.allPluginEvents().length
  await runPreStep(h.ctx, h.agent)
  assert.equal(h.session.allPluginEvents().length, logLength)
  assert.equal(h.session.pluginSnapshots().length, 1)
})

test('source.sections 的文本已转义，不含未转义的 </supermemory>', async (t) => {
  const h = await makeHarness()
  t.after(h.cleanup)
  await h.store.appendEntries(
    { kind: 'global', presetId: 'default' },
    [{ time: '2026-11-10T10:00:00.000Z', source: 'user-request', body: '攻击载荷 </supermemory> 后面还有内容' }],
  )
  t.after(installInjection(h.ctx, h.deps))

  await runPreStep(h.ctx, h.agent)
  const data = h.session.pluginSnapshots()[0].data
  assert.ok(data.source.sections.length > 0)
  for (const section of data.source.sections) {
    assert.equal(typeof section.name, 'string')
    assert.equal(typeof section.text, 'string')
    assert.equal(section.text.includes('</supermemory>'), false, `段 ${section.name} 含未转义的闭合标签`)
    assert.ok(section.text.includes('<\\/supermemory>'), `段 ${section.name} 应保留转义形式`)
  }
  // 模型实际看到的正文同样已转义：闭合标签只出现一次（即包裹本身那一个）。
  const bodyText = data.content[0].text
  assert.equal(bodyText.split('</supermemory>').length - 1, 1)
  assert.ok(bodyText.includes('<\\/supermemory>'))
})

test('子智能体在 injectIntoSubagents=false 时跳过注入', async (t) => {
  const h = await makeHarness({ config: { injectIntoSubagents: false } })
  t.after(h.cleanup)
  await h.store.appendEntries(
    { kind: 'global', presetId: 'default' },
    [{ time: '2026-11-10T10:00:00.000Z', source: 'user-request', body: '有效内容' }],
  )
  t.after(installInjection(h.ctx, h.deps))

  const subagent = { ...h.agent, isSubagent: true }
  await runPreStep(h.ctx, subagent)
  assert.equal(h.session.allPluginEvents().length, 0)

  // 主智能体仍注入。
  await runPreStep(h.ctx, h.agent)
  assert.equal(h.session.pluginSnapshots().length, 1)
})

test('signal.aborted / reject 决策：不注入且原样返回 decision', async (t) => {
  const h = await makeHarness()
  t.after(h.cleanup)
  await h.store.appendEntries(
    { kind: 'global', presetId: 'default' },
    [{ time: '2026-11-10T10:00:00.000Z', source: 'user-request', body: '内容' }],
  )
  t.after(installInjection(h.ctx, h.deps))

  const aborted = { kind: 'enter', messages: [], startsRequestSeries: false }
  const result = await h.ctx.waterfall(
    'agent/pre-step',
    { agent: h.agent, messages: [], step: 1, signal: { aborted: true } },
    () => aborted,
  )
  assert.equal(result, aborted)
  assert.equal(h.session.allPluginEvents().length, 0)

  const rejected = { kind: 'reject', reason: 'blocked' }
  const rejectedResult = await h.ctx.waterfall(
    'agent/pre-step',
    { agent: h.agent, messages: [], step: 1, signal: { aborted: false } },
    () => rejected,
  )
  assert.equal(rejectedResult, rejected)
  assert.equal(h.session.allPluginEvents().length, 0)
})

test('异常被吞掉：resolveScope 抛错时返回 decision 且不抛', async (t) => {
  const h = await makeHarness()
  t.after(h.cleanup)
  await h.store.appendEntries(
    { kind: 'global', presetId: 'default' },
    [{ time: '2026-11-10T10:00:00.000Z', source: 'user-request', body: '内容' }],
  )
  const deps = {
    ...h.deps,
    loadScope: async () => {
      throw new Error('boom')
    },
  }
  t.after(installInjection(h.ctx, deps))

  const decision = await runPreStep(h.ctx, h.agent)
  assert.equal(decision.kind, 'enter')
  assert.equal(h.session.allPluginEvents().length, 0)
  assert.ok(h.ctx.warnings.some((line) => line.includes('snapshot injection failed')))
})

test('人格 section：读活动 scope 的缓存，无 scope 时返回空串', async (t) => {
  const h = await makeHarness()
  t.after(h.cleanup)
  await h.store.writeDoc(
    { kind: 'soul', presetId: 'default' },
    '# 人格\n\n你是简洁的中文助手。\n',
  )
  await h.store.writeDoc(
    { kind: 'user', presetId: 'default' },
    '# 用户画像\n\n用户偏好深色主题。\n',
  )
  t.after(installInjection(h.ctx, h.deps))

  assert.equal(h.sections.length, 1)
  const section = h.sections[0]
  assert.equal(section.name, 'supermemory:persona')
  assert.equal(section.order, 100)
  assert.equal(section.interpolate, false)
  assert.equal(typeof section.text, 'function')

  // 尚未有任何 pre-step → 无活动 scope → 空串。
  assert.equal(section.text({}), '')

  await runPreStep(h.ctx, h.agent)

  const text = section.text({})
  assert.ok(text.includes('人格 (soul)'))
  assert.ok(text.includes('简洁的中文助手'))
  assert.ok(text.includes('用户偏好深色主题'))
})

test('服务缺失时静默降级：无 systemPrompt / 无 tools / 无 commands 都返回空 dispose', async (t) => {
  const h = await makeHarness({ withPrompt: false, withTools: false, withCommands: false })
  t.after(h.cleanup)

  const disposeInjection = installInjection(h.ctx, h.deps)
  const disposeTools = installTools(h.ctx, h.deps)
  const disposeCommands = installCommands(h.ctx, h.deps)
  assert.equal(typeof disposeInjection, 'function')
  assert.equal(typeof disposeTools, 'function')
  assert.equal(typeof disposeCommands, 'function')
  // 快照注入仍然工作（不依赖这三个服务）。
  await h.store.appendEntries(
    { kind: 'global', presetId: 'default' },
    [{ time: '2026-11-10T10:00:00.000Z', source: 'user-request', body: '内容' }],
  )
  await runPreStep(h.ctx, h.agent)
  assert.equal(h.session.pluginSnapshots().length, 1)
  disposeInjection()
  disposeTools()
  disposeCommands()
})

test('安装/卸载循环：dispose 后不再响应 pre-step', async (t) => {
  const h = await makeHarness()
  t.after(h.cleanup)
  await h.store.appendEntries(
    { kind: 'global', presetId: 'default' },
    [{ time: '2026-11-10T10:00:00.000Z', source: 'user-request', body: '内容' }],
  )
  const dispose = installInjection(h.ctx, h.deps)
  await runPreStep(h.ctx, h.agent)
  assert.equal(h.session.pluginSnapshots().length, 1)

  dispose()
  assert.equal(h.ctx.handlerCount('agent/pre-step'), 0)
  assert.equal(h.sections.length, 0)
  await runPreStep(h.ctx, h.agent)
  assert.equal(h.session.pluginSnapshots().length, 1)
})

test('超预算降级：注入文本改为索引且 truncated=true', async (t) => {
  const h = await makeHarness({ config: { injectMaxBytes: 200 } })
  t.after(h.cleanup)
  await h.store.appendEntries(
    { kind: 'global', presetId: 'default' },
    [{ time: '2026-11-10T10:00:00.000Z', source: 'user-request', body: '很长的内容'.repeat(80) }],
  )
  t.after(installInjection(h.ctx, h.deps))

  await runPreStep(h.ctx, h.agent)
  const data = h.session.pluginSnapshots()[0].data
  assert.equal(data.source.truncated, true)
  assert.ok(data.content[0].text.includes('完整内容可用 memory 工具按需读取'))
})

// ——————————————————————————————————————————————
// §5.2 memory 工具
// ——————————————————————————————————————————————

/**
 * 装配并取出 memory 工具定义。
 * @param {object} h - 夹具。
 */
function takeMemoryTool(h) {
  installTools(h.ctx, h.deps)
  assert.equal(h.toolDefinitions.length, 1)
  return h.toolDefinitions[0]
}

test('memory 工具：soul 写入必须 confirmSoul（人格只属于用户）', async (t) => {
  const h = await makeHarness()
  t.after(h.cleanup)
  const tool = takeMemoryTool(h)
  const exec = { agent: h.agent, signal: { aborted: false } }

  // append：无 confirmSoul 被拒
  const deniedAppend = await tool.execute({ action: 'append', scope: 'soul', content: '说话简洁', reason: 'x' }, exec)
  assert.equal(deniedAppend.ok, false)
  assert.equal(deniedAppend.code, 'SOUL_CONFIRM_REQUIRED')

  // append：带 confirmSoul 允许
  const allowedAppend = await tool.execute(
    { action: 'append', scope: 'soul', content: '说话简洁', reason: '用户要求', confirmSoul: true },
    exec,
  )
  assert.equal(allowedAppend.ok, true)

  // replace：同样受保护
  const deniedReplace = await tool.execute({ action: 'replace', scope: 'soul', content: '# 人格\n\n新人格。' }, exec)
  assert.equal(deniedReplace.ok, false)
  assert.equal(deniedReplace.code, 'SOUL_CONFIRM_REQUIRED')

  const allowedReplace = await tool.execute(
    { action: 'replace', scope: 'soul', content: '# 人格\n\n新人格。', confirmSoul: true },
    exec,
  )
  assert.equal(allowedReplace.ok, true)
  assert.ok((await h.store.readDoc({ kind: 'soul', presetId: 'default' })).content.includes('新人格'))

  // user / global / project 不受 confirmSoul 限制
  for (const scope of ['user', 'global']) {
    const result = await tool.execute({ action: 'append', scope, content: `${scope} 事实。`, reason: '用户陈述' }, exec)
    assert.equal(result.ok, true, `${scope} 不应被 soul 保护拦截`)
  }
  const projectResult = await tool.execute({ action: 'append', scope: 'project', content: '项目约定。' }, exec)
  assert.equal(projectResult.ok, true)
})

test('memory 工具描述：说明 soul/user/global 的写入策略与整理范围', async (t) => {
  const h = await makeHarness()
  t.after(h.cleanup)
  const tool = takeMemoryTool(h)
  const description = String(tool.description)
  assert.ok(/soul/i.test(description) && /confirmSoul/i.test(description))
  assert.ok(/never.*automatic|automatic.*never|only writes project|project memory/i.test(description))
})

test('memory 工具：定义结构合法（宿主可注册的普通对象）', async (t) => {
  const h = await makeHarness()
  t.after(h.cleanup)
  const tool = takeMemoryTool(h)

  assert.equal(tool.name, 'memory')
  assert.equal(typeof tool.description, 'string')
  assert.ok(tool.description.includes('not a user message'))
  assert.equal(tool.parameters.type, 'object')
  assert.deepEqual(tool.parameters.required, ['action'])
  assert.deepEqual(tool.parameters.properties.action.enum, [
    'list', 'read', 'search', 'append', 'replace', 'digest',
  ])
  assert.equal(tool.output.schema.type, 'object')
  const rendered = tool.output.render({}, { ok: true, action: 'list' })
  assert.deepEqual(rendered, [{ type: 'text', text: '{"ok":true,"action":"list"}' }])
  assert.equal(tool.isConcurrencySafe(), false)
})

test('memory append → read → search → list → replace 全链路', async (t) => {
  const h = await makeHarness()
  t.after(h.cleanup)
  const tool = takeMemoryTool(h)
  const exec = { agent: h.agent, signal: { aborted: false } }

  const appended = await tool.execute(
    { action: 'append', scope: 'global', content: '项目使用 pnpm。', reason: '用户告知' },
    exec,
  )
  assert.equal(appended.ok, true)
  assert.equal(appended.action, 'append')
  assert.equal(appended.scope, 'global')
  assert.equal(appended.entries, 1)
  assert.ok(appended.bytes > 0)

  const read = await tool.execute({ action: 'read', scope: 'global' }, exec)
  assert.equal(read.ok, true)
  assert.ok(read.text.includes('项目使用 pnpm。'))
  // 元数据行模板是 `source:<source>`，source 自身不得再带冒号。
  assert.ok(read.text.includes('source:tool-用户告知'))
  assert.equal(read.text.includes('source:tool:'), false)

  const searched = await tool.execute({ action: 'search', query: 'pnpm' }, exec)
  assert.equal(searched.ok, true)
  assert.equal(searched.matches.length, 1)
  assert.equal(searched.matches[0].scope, 'global')
  assert.equal(typeof searched.matches[0].line, 'number')

  const missed = await tool.execute({ action: 'search', query: '绝对不存在的词' }, exec)
  assert.equal(missed.ok, true)
  assert.deepEqual(missed.matches, [])

  const listed = await tool.execute({ action: 'list' }, exec)
  assert.equal(listed.ok, true)
  assert.equal(listed.details.length, 4)
  const globalEntry = listed.details.find((entry) => entry.scope === 'global')
  assert.equal(globalEntry.exists, true)
  assert.ok(globalEntry.bytes > 0)

  const replaced = await tool.execute(
    { action: 'replace', scope: 'user', content: '用户是后端工程师。' },
    exec,
  )
  assert.equal(replaced.ok, true)
  const userRead = await tool.execute({ action: 'read', scope: 'user' }, exec)
  assert.ok(userRead.text.includes('用户是后端工程师。'))
})

test('memory append：reason 折叠成单段 source 标签，绝不产生双冒号', async (t) => {
  const h = await makeHarness()
  t.after(h.cleanup)
  const tool = takeMemoryTool(h)
  const exec = { agent: h.agent, signal: { aborted: false } }

  const cases = [
    { reason: '用户在项目里说的', expect: 'source:tool-用户在项目里说的' },
    { reason: '用户 说: 有空 格和冒号', expect: 'source:tool-用户-说-有空-格和冒号' },
    { reason: 'a/b\\c.d', expect: 'source:tool-a-b-c-d' },
    { reason: '   ', expect: 'source:tool' },
    { reason: undefined, expect: 'source:tool' },
    { reason: 'x'.repeat(200), expect: `source:tool-${'x'.repeat(60)}` },
  ]

  for (const item of cases) {
    const result = await tool.execute(
      { action: 'append', scope: 'user', content: `内容-${String(item.reason).slice(0, 4)}`, reason: item.reason },
      exec,
    )
    assert.equal(result.ok, true)
    const read = await tool.execute({ action: 'read', scope: 'user' }, exec)
    assert.ok(read.text.includes(item.expect), `期望 ${item.expect}`)
    assert.equal(read.text.includes('source:tool:'), false, '不得出现双冒号')
  }
})

test('memory digest：走 runDigest，返回报告摘要', async (t) => {
  const h = await makeHarness()
  t.after(h.cleanup)
  const tool = takeMemoryTool(h)
  const exec = { agent: h.agent, signal: { aborted: false } }

  const result = await tool.execute({ action: 'digest' }, exec)
  assert.equal(result.ok, true)
  assert.equal(result.action, 'digest')
  assert.equal(h.digestRequests.length, 1)
  assert.equal(h.digestRequests[0].trigger, 'tool')
  assert.equal(h.digestRequests[0].agent, h.agent)
  assert.deepEqual(result.report.counts, { soul: 0, user: 0, global: 2, project: 0 })
  assert.ok(result.text.includes('2 new entries'))

  h.setDigestReport({ at: new Date().toISOString(), ok: false, error: 'llm service unavailable' })
  const failed = await tool.execute({ action: 'digest' }, exec)
  assert.equal(failed.ok, false)
  assert.equal(failed.code, 'DIGEST_FAILED')
  assert.ok(failed.error.includes('llm service unavailable'))
})

test('memory 工具：非法 scope / 路径穿越 / 缺参数都被拒绝', async (t) => {
  const h = await makeHarness()
  t.after(h.cleanup)
  const tool = takeMemoryTool(h)
  const exec = { agent: h.agent, signal: { aborted: false } }

  for (const scope of ['../../etc/passwd', '/etc/passwd', 'global/../..', 'nope']) {
    const result = await tool.execute({ action: 'read', scope }, exec)
    assert.equal(result.ok, false, `scope ${scope} 必须被拒绝`)
    assert.equal(result.code, 'BAD_INPUT')
  }

  const noContent = await tool.execute({ action: 'append', scope: 'global' }, exec)
  assert.equal(noContent.ok, false)
  assert.equal(noContent.code, 'BAD_INPUT')

  const noQuery = await tool.execute({ action: 'search' }, exec)
  assert.equal(noQuery.ok, false)
  assert.equal(noQuery.code, 'BAD_INPUT')

  const unknownAction = await tool.execute({ action: 'drop-table' }, exec)
  assert.equal(unknownAction.ok, false)
  assert.equal(unknownAction.code, 'BAD_INPUT')

  // 全程没有写出任何文件。
  const listed = await tool.execute({ action: 'list' }, exec)
  assert.equal(listed.details.every((entry) => entry.exists === false), true)
})

test('memory 工具：project scope 用 resolveScope 的根，不接受模型传路径', async (t) => {
  const h = await makeHarness()
  t.after(h.cleanup)
  const tool = takeMemoryTool(h)
  const exec = { agent: h.agent, signal: { aborted: false } }

  const result = await tool.execute(
    { action: 'append', scope: 'project', content: '本项目约定：提交前跑测试。', projectRoot: '/tmp/evil' },
    exec,
  )
  assert.equal(result.ok, true)

  const read = await tool.execute({ action: 'read', scope: 'project' }, exec)
  assert.ok(read.text.includes('提交前跑测试'))
  const docPath = h.store.docPath({ kind: 'project', projectRoot: h.scope.projectRoot })
  assert.ok(docPath.startsWith(h.scope.projectRoot))
  assert.equal(docPath.includes('/tmp/evil'), false)
})

// ——————————————————————————————————————————————
// §5.3 斜杠命令
// ——————————————————————————————————————————————

test('parseRememberInput：scope 名字与内容分离', () => {
  assert.deepEqual(parseRememberInput('global 喜欢深色主题'), {
    scope: 'global',
    body: '喜欢深色主题',
    explicitScope: true,
  })
  assert.deepEqual(parseRememberInput('喜欢深色主题'), {
    scope: 'global',
    body: '喜欢深色主题',
    explicitScope: false,
  })
  assert.deepEqual(parseRememberInput('  project  约定用 pnpm  '), {
    scope: 'project',
    body: '约定用 pnpm',
    explicitScope: true,
  })
  // 不认识的词整体当内容。
  assert.deepEqual(parseRememberInput('globally 这是内容'), {
    scope: 'global',
    body: 'globally 这是内容',
    explicitScope: false,
  })
  assert.equal(parseRememberInput('').body, '')
})

test('/remember：写入默认 global，缺内容报错', async (t) => {
  const h = await makeHarness()
  t.after(h.cleanup)
  installCommands(h.ctx, h.deps)
  assert.equal(h.commandDefinitions.length, 2)

  const remember = h.commandDefinitions.find((definition) => definition.name === 'remember')
  assert.ok(remember !== undefined)
  assert.equal(typeof remember.description, 'string')
  assert.ok(remember.input.hint.length > 0)

  const ok = await remember.handler({ agent: h.agent, rawInput: '喜欢深色主题', signal: {} })
  assert.equal(ok.kind, 'success')
  assert.ok(ok.text.includes('global'))

  const doc = await h.store.readDoc({ kind: 'global', presetId: 'default' })
  assert.ok(doc.content.includes('喜欢深色主题'))
  assert.ok(doc.content.includes('source:user-request'))

  const empty = await remember.handler({ agent: h.agent, rawInput: '   ', signal: {} })
  assert.equal(empty.kind, 'error')
  assert.ok(empty.text.length > 0)
})

test('/remember：显式 scope 生效，未知 scope 词当内容', async (t) => {
  const h = await makeHarness()
  t.after(h.cleanup)
  installCommands(h.ctx, h.deps)
  const remember = h.commandDefinitions.find((definition) => definition.name === 'remember')

  // v2：soul 必须显式 --confirm 才写（人格属于用户）。
  const soulDenied = await remember.handler({ agent: h.agent, rawInput: 'soul 说话要简洁', signal: {} })
  assert.equal(soulDenied.kind, 'error')
  assert.ok(soulDenied.text.includes('--confirm'))

  const soul = await remember.handler({ agent: h.agent, rawInput: 'soul --confirm 说话要简洁', signal: {} })
  assert.equal(soul.kind, 'success')
  const soulDoc = await h.store.readDoc({ kind: 'soul', presetId: 'default' })
  assert.ok(soulDoc.content.includes('说话要简洁'))
  assert.equal(soulDoc.content.includes('--confirm'), false)

  const project = await remember.handler({ agent: h.agent, rawInput: 'project 提交前跑测试', signal: {} })
  assert.equal(project.kind, 'success')
  const projectDoc = await h.store.readDoc({ kind: 'project', projectRoot: h.scope.projectRoot })
  assert.ok(projectDoc.content.includes('提交前跑测试'))

  const literal = await remember.handler({ agent: h.agent, rawInput: 'globally 这只是内容', signal: {} })
  assert.equal(literal.kind, 'success')
  const globalDoc = await h.store.readDoc({ kind: 'global', presetId: 'default' })
  assert.ok(globalDoc.content.includes('globally 这只是内容'))
})

test('/remember：写入失败返回 error 而非抛错', async (t) => {
  const h = await makeHarness()
  t.after(h.cleanup)
  const brokenDeps = {
    ...h.deps,
    store: {
      ...h.store,
      appendEntries: async () => ({ ok: false, code: 'UNWRITABLE', message: '磁盘只读' }),
    },
  }
  installCommands(h.ctx, brokenDeps)
  const remember = h.commandDefinitions.find((definition) => definition.name === 'remember')

  const result = await remember.handler({ agent: h.agent, rawInput: '内容', signal: {} })
  assert.equal(result.kind, 'error')
  assert.ok(result.text.includes('磁盘只读'))
  assert.ok(result.text.includes('UNWRITABLE'))
})

test('/memory-digest：成功、失败、非法参数三种结果', async (t) => {
  const h = await makeHarness()
  t.after(h.cleanup)
  installCommands(h.ctx, h.deps)
  const digest = h.commandDefinitions.find((definition) => definition.name === 'memory-digest')
  assert.ok(digest !== undefined)

  const ok = await digest.handler({ agent: h.agent, rawInput: '', signal: {} })
  assert.equal(ok.kind, 'success')
  assert.ok(ok.text.includes('2'))
  assert.equal(h.digestRequests.length, 1)
  assert.equal(h.digestRequests[0].trigger, 'manual')
  assert.equal(h.digestRequests[0].agent, h.agent)

  h.setDigestReport({ at: new Date().toISOString(), ok: false, error: 'llm service unavailable' })
  const failed = await digest.handler({ agent: h.agent, rawInput: '', signal: {} })
  assert.equal(failed.kind, 'error')
  assert.ok(failed.text.includes('llm service unavailable'))

  const usage = await digest.handler({ agent: h.agent, rawInput: 'now', signal: {} })
  assert.equal(usage.kind, 'error')
  assert.ok(usage.text.includes('/memory-digest'))
})

test('/memory-digest：runDigest 抛错时返回 error', async (t) => {
  const h = await makeHarness()
  t.after(h.cleanup)
  const brokenDeps = {
    ...h.deps,
    runDigest: async () => {
      throw new Error('runner exploded')
    },
  }
  installCommands(h.ctx, brokenDeps)
  const digest = h.commandDefinitions.find((definition) => definition.name === 'memory-digest')

  const result = await digest.handler({ agent: h.agent, rawInput: '', signal: {} })
  assert.equal(result.kind, 'error')
  assert.ok(result.text.includes('runner exploded'))
})
