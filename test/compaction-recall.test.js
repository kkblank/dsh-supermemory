/**
 * 压缩后补偿注入自测（lib/host/inject.js 的压缩路径）。
 *
 * 宿主事实（已核实，源码只读）：
 *   - `dsh-compaction-basic/lib/index.js`：一次成功压缩连写三条事件——
 *       `compaction/start`（非 surface）→ `compaction/summary`（非 surface，带
 *       `shadowedRange` / `shadowedSeqs`）→ 一条 `user/message` checkpoint
 *       （`source.kind === 'compact-checkpoint'`）用 `surfaceOp:'replace'`
 *       把 `[start,end]` 整段 surface 区间替换掉。
 *   - `dsh-session/lib/index.js`：`snapshotEvents()` 是全量 append-only 日志，
 *     被遮蔽的事件仍留在日志里 → 判存活必须看 surface，判压缩必须看日志。
 *   - `dsh-compaction-tool-result-pruner`：`compaction/prune` 只 replace
 *     `tool/result` 单节点，不碰 user/message。
 *
 * 本文件用假 session 复刻上述语义（含宿主的 replace 硬校验），覆盖：
 *   压缩吞掉快照后重建 / digest 未变也重写 / 无压缩不重复写 /
 *   开关关闭退回旧行为 / surface 不可用的永久失忆路径 / 防抖动。
 *
 * 运行：node --test test/compaction-recall.test.js
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveConfig } from '../lib/host/config.js'
import { compactionState, installInjection, lastSnapshotEvent, SOURCE_KIND } from '../lib/host/inject.js'

/**
 * 假 session：复刻宿主 surface 折叠与压缩语义。
 * @param {{ surfaceAvailable?: boolean }} [options] - surfaceAvailable=false 模拟拿不到 surface。
 */
function makeSession(options = {}) {
  const events = []
  let nodes = []
  let replaceGeneration = 0
  const surfaceAvailable = options.surfaceAvailable !== false

  const session = {
    get seq() {
      return events.length
    },
    get surface() {
      // 模拟宿主 surface 不可用的极端场景（旧实现会在这里误判快照仍存活）。
      if (!surfaceAvailable) return undefined
      return { get nodes() { return nodes }, replaceGeneration }
    },
    snapshotEvents() {
      return events.slice()
    },
    eventAt(seq) {
      return events[seq]
    },
    append(type, data, opts) {
      const seq = events.length
      const op = opts?.surfaceOp

      if (op !== undefined && op !== 'append') {
        // —— 复刻宿主 dsh-session/lib/types/surface.js 的 replace 硬校验 ——
        const shadowed = nodes.slice(nodes.indexOf(op.startSeq), nodes.indexOf(op.endSeq) + 1)
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

      const event = { type, seq, time: Date.now(), data }
      events.push(event)
      if (op === 'append') nodes.push(seq)
      else if (op !== undefined) {
        const start = nodes.indexOf(op.startSeq)
        const end = nodes.indexOf(op.endSeq)
        nodes.splice(start, end - start + 1, seq)
        replaceGeneration += 1
      }
      return event
    },

    // —— 测试辅助 ——
    /** 复刻宿主一次完整压缩：遮蔽 surface 上 [start,end] 区间。 */
    compact(start, end) {
      const shadowedSeqs = nodes.slice(nodes.indexOf(start), nodes.indexOf(end) + 1)
      assert.ok(shadowedSeqs.length > 0, '压缩区间必须命中 surface 节点')
      const startEvent = session.append('compaction/start', { compactionId: `c-${start}-${end}` })
      const summaryEvent = session.append('compaction/summary', {
        compactionId: 'c',
        summary: [{ type: 'text', text: '摘要' }],
        shadowedRange: { start, end },
        shadowedSeqs,
      })
      const checkpoint = session.append(
        'user/message',
        {
          id: `ckpt-${start}-${end}`,
          role: 'user',
          content: [{ type: 'text', text: '（历史摘要）' }],
          source: { kind: 'compact-checkpoint', compactionId: 'c' },
        },
        {
          surfaceOp: { op: 'replace', startSeq: start, endSeq: end },
          sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowedSeqs],
        },
      )
      return { startEvent, summaryEvent, checkpoint, shadowedSeqs }
    },
    /** surface 上的本插件快照。 */
    pluginSnapshots() {
      return nodes
        .map((seq) => events[seq])
        .filter((event) => event?.type === 'user/message' && event.data?.source?.kind === SOURCE_KIND)
    },
    /** 全部（含被遮蔽的）本插件事件。 */
    allPluginEvents() {
      return events.filter((event) => event.type === 'user/message' && event.data?.source?.kind === SOURCE_KIND)
    },
    /** 追加一条与注入无关的普通用户消息，用于把快照挤到中间位置。 */
    addUserMessage(text) {
      return session.append(
        'user/message',
        { id: `u-${events.length}`, role: 'user', content: [{ type: 'text', text }] },
        { surfaceOp: 'append' },
      )
    },
  }
  return session
}

/** 假 ctx（仅需 on / get / waterfall / logger）。 */
function makeCtx() {
  const handlers = new Map()
  const disposers = []
  const warnings = []
  return {
    logger: { warn: (...args) => warnings.push(args.map(String).join(' ')), info: () => {} },
    get() {
      return undefined // 不挂 systemPrompt / tools / commands，只装 pre-step 注入
    },
    on(event, fn) {
      const list = handlers.get(event) ?? []
      list.push(fn)
      handlers.set(event, list)
      const dispose = () => {
        handlers.set(event, (handlers.get(event) ?? []).filter((entry) => entry !== fn))
      }
      disposers.push(dispose)
      return dispose
    },
    warnings,
    disposeAll() {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose()
        } catch {
          /* 忽略 */
        }
      }
    },
    async waterfall(event, payload, last) {
      const list = handlers.get(event) ?? []
      if (list.length === 0) return last()
      let index = 0
      const step = async (current) => {
        const fn = list[index]
        index += 1
        if (fn === undefined) return last()
        return fn(current, (nextPayload) => step(nextPayload ?? current))
      }
      return step(payload)
    },
  }
}

/** 固定记忆内容：保证同一进程内 digest 稳定，才能测「digest 未变」的行为。 */
const DOC_BODIES = {
  global: '# 全局长期记忆\n\n<!-- 注释 -->\n\n## 条目\n\n- 2026-11-10T10:00:00.000Z · source:test\n  主人偏好绝对路径。',
  soul: '',
  user: '',
  project: '',
}

/**
 * 建一套注入夹具。
 * @param {{ config?: object, surfaceAvailable?: boolean }} [options]
 */
function makeHarness(options = {}) {
  const ctx = makeCtx()
  const session = makeSession({ surfaceAvailable: options.surfaceAvailable })
  const store = {
    async readDoc(ref) {
      return { content: DOC_BODIES[ref?.kind] ?? '' }
    },
    readDocSync(ref) {
      return { content: DOC_BODIES[ref?.kind] ?? '' }
    },
  }
  const scope = { persona: 'default', presetId: 'default', projectRoot: '/tmp/proj', projectName: 'proj' }
  const deps = {
    store,
    logger: ctx.logger,
    getConfig: () => resolveConfig(options.config ?? {}),
    loadScope: async () => scope,
    isSubagent: (agent) => agent?.isSubagent === true,
  }
  const agent = { session, options: {} }
  const dispose = installInjection(ctx, deps)
  const runPreStep = () =>
    ctx.waterfall('agent/pre-step', { agent, messages: [], step: 1, signal: { aborted: false } }, () => ({
      kind: 'enter',
      messages: [],
      startsRequestSeries: true,
    }))
  return { ctx, session, agent, runPreStep, dispose }
}

// ——————————————————————————————————————————————
// compactionState：压缩识别
// ——————————————————————————————————————————————

test('compactionState：汇总 shadowedSeqs 并集与最后一条 summary 的 seq', () => {
  const session = makeSession()
  session.addUserMessage('u1')
  session.addUserMessage('u2')

  assert.deepEqual(compactionState(session), { seq: -1, shadowed: new Set() }, '没有压缩时 seq 为 -1')

  const first = session.compact(0, 0)
  const state1 = compactionState(session)
  assert.equal(state1.seq, first.summaryEvent.seq)
  assert.deepEqual([...state1.shadowed].sort((a, b) => a - b), [0])

  session.addUserMessage('u3')
  const nodes = session.surface.nodes.slice()
  const second = session.compact(nodes[1], nodes[nodes.length - 1])
  const state2 = compactionState(session)
  assert.equal(state2.seq, second.summaryEvent.seq, '取最后一次压缩')
  assert.deepEqual(
    [...state2.shadowed].sort((a, b) => a - b),
    [0, ...second.shadowedSeqs].sort((a, b) => a - b),
    '遮蔽集是历史并集',
  )
})

test('compactionState：session 缺失 / 无 snapshotEvents / 抛错都降级为空状态', () => {
  assert.deepEqual(compactionState(undefined), { seq: -1, shadowed: new Set() })
  assert.deepEqual(compactionState({}), { seq: -1, shadowed: new Set() })
  const boom = { snapshotEvents: () => { throw new Error('log corrupted') } }
  assert.deepEqual(compactionState(boom), { seq: -1, shadowed: new Set() }, '日志读取失败必须静默降级')
})

test('lastSnapshotEvent：遮蔽集能排除已被压缩吞掉的旧快照（surface 不可用时）', () => {
  const session = makeSession({ surfaceAvailable: false })
  session.append(
    'user/message',
    { id: 'p1', role: 'user', content: [{ type: 'text', text: 'x' }], source: { kind: SOURCE_KIND, digest: 'D' } },
    { surfaceOp: 'append' },
  )
  // 不传遮蔽集：退回旧的宽松行为，能找到（这就是过去的误判来源）。
  assert.equal(lastSnapshotEvent(session)?.seq, 0)
  // 传入遮蔽集：同一条被吞掉的事件不再算存活。
  assert.equal(lastSnapshotEvent(session, new Set([0])), undefined)
  // 遮蔽集里没有它 → 仍算存活。
  assert.equal(lastSnapshotEvent(session, new Set([7, 8]))?.seq, 0)
})

// ——————————————————————————————————————————————
// 注入路径：吞掉后重建 / digest 未变也重写 / 不抖动
// ——————————————————————————————————————————————

test('压缩吞掉快照：下一轮 pre-step 重建，surface 上恢复恰好一条', async (t) => {
  const h = makeHarness()
  t.after(() => h.dispose())

  await h.runPreStep()
  assert.equal(h.session.pluginSnapshots().length, 1)
  const snapshotSeq = h.session.pluginSnapshots()[0].seq

  // 把快照挤到中间后压缩整段历史，快照被摘要覆盖。
  h.session.addUserMessage('u2')
  h.session.compact(0, 1)
  assert.equal(h.session.pluginSnapshots().length, 0, '压缩后 surface 上已无快照')

  await h.runPreStep()
  const alive = h.session.pluginSnapshots()
  assert.equal(alive.length, 1, '必须重建且 surface 上仍恰好一条')
  assert.ok(alive[0].seq > snapshotSeq, '重建的事件 seq 必须晚于被吞掉的旧事件')
  assert.equal(h.session.allPluginEvents().length, 2, '日志里留下旧事件与重建事件两条')
})

test('digest 未变也重写：压缩晚于快照且快照幸存时仍需补偿重写', async (t) => {
  const h = makeHarness()
  t.after(() => h.dispose())

  h.session.addUserMessage('u1') // seq 0：让快照落在 seq 1，压缩才能只遮蔽它前面的节点
  await h.runPreStep()
  const old = h.session.pluginSnapshots()[0]
  const digestBefore = old.data.source.digest

  h.session.compact(0, 0)
  assert.equal(h.session.pluginSnapshots()[0].seq, old.seq, '快照未被吞掉，位置不变')

  await h.runPreStep()
  const now = h.session.pluginSnapshots()[0]
  assert.equal(now.seq > old.seq, true, 'digest 未变也必须重写')
  assert.equal(now.data.source.digest, digestBefore, '正文与 digest 逐字节一致，补偿不污染内容')
  assert.equal(h.session.pluginSnapshots().length, 1, '重写后 surface 仍恒为一条')
})

test('无压缩时：digest 未变绝不重复写入', async (t) => {
  const h = makeHarness()
  t.after(() => h.dispose())

  await h.runPreStep()
  await h.runPreStep()
  await h.runPreStep()
  assert.equal(h.session.allPluginEvents().length, 1, '没有压缩就不该有任何额外写入')
  assert.equal(h.session.pluginSnapshots().length, 1)
})

test('防抖动：重写之后连续两次 pre-step 无新压缩，只允许写一次', async (t) => {
  const h = makeHarness()
  t.after(() => h.dispose())

  await h.runPreStep()
  h.session.addUserMessage('u2')
  h.session.compact(0, 1) // 吞掉快照

  await h.runPreStep() // 补偿重写：第 2 条
  assert.equal(h.session.allPluginEvents().length, 2)
  const resynced = h.session.pluginSnapshots()[0]

  await h.runPreStep()
  await h.runPreStep()
  assert.equal(h.session.allPluginEvents().length, 2, '无新压缩时不得反复 replace')
  assert.equal(h.session.pluginSnapshots()[0].seq, resynced.seq, '快照必须原地保留')
})

test('compactionRecall=false：退回旧行为，压缩后不做补偿重写', async (t) => {
  // 场景 A：快照幸存 + 压缩更晚。开关关闭时必须完全保持旧行为（不写）。
  const survived = makeHarness({ config: { compactionRecall: false } })
  t.after(() => survived.dispose())
  survived.session.addUserMessage('u1')
  await survived.runPreStep()
  survived.session.compact(0, 0)
  await survived.runPreStep()
  assert.equal(survived.session.allPluginEvents().length, 1, '关闭后 digest 未变即跳过（旧行为）')

  // 场景 B：快照被整段吞掉。旧行为下 surface 可用时本来就会 append 重建——
  // 这条断言是为了把「补偿」与「自愈」的边界固定住：开关只关掉补偿重写，
  // 不影响快照丢失后的基本自愈能力。
  const swallowed = makeHarness({ config: { compactionRecall: false } })
  t.after(() => swallowed.dispose())
  await swallowed.runPreStep()
  swallowed.session.addUserMessage('u2')
  swallowed.session.compact(0, 1)
  await swallowed.runPreStep()
  assert.equal(swallowed.session.allPluginEvents().length, 2, '被吞掉时仍应重建（与开关无关）')
  assert.equal(swallowed.session.pluginSnapshots().length, 1)
})

test('永久失忆路径：surface 不可用 + 快照已被遮蔽 + digest 未变 → 仍能重建', async (t) => {
  // 同一场景做开关对照，证明修复确实来自遮蔽排除，而不是别的原因。
  const closed = makeHarness({ surfaceAvailable: false, config: { compactionRecall: false } })
  t.after(() => closed.dispose())
  await closed.runPreStep()
  closed.session.addUserMessage('u2')
  closed.session.compact(0, 1) // 快照被吞，但 surface 拿不到
  await closed.runPreStep()
  assert.equal(closed.session.allPluginEvents().length, 1, '旧行为：误判快照存活 → 永久不重写')

  const open = makeHarness({ surfaceAvailable: false })
  t.after(() => open.dispose())
  await open.runPreStep()
  open.session.addUserMessage('u2')
  open.session.compact(0, 1)
  await open.runPreStep()
  assert.equal(open.session.allPluginEvents().length, 2, '修复后：遮蔽排除让它判定快照已死并重写')
})

test('多次压缩交替：每次都只补偿一次，surface 恒为一条', async (t) => {
  const h = makeHarness()
  t.after(() => h.dispose())

  await h.runPreStep()
  for (let round = 1; round <= 3; round += 1) {
    const nodes = h.session.surface.nodes.slice()
    h.session.compact(nodes[0], nodes[nodes.length - 1]) // 整段吞掉
    assert.equal(h.session.pluginSnapshots().length, 0)
    await h.runPreStep()
    assert.equal(h.session.pluginSnapshots().length, 1, `第 ${round} 轮压缩后恰好一条`)
    assert.equal(h.session.allPluginEvents().length, round + 1, `第 ${round} 轮只多写一条`)
  }
})
