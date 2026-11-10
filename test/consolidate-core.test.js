/**
 * 整编核心（契约 §V4.0.2）单测：容错提取、输出校验、七条对账规则、三道栅栏、整编时机。
 *
 * 对账是整编唯一「可能丢记忆」的地方，所以规则 5（未安置的旧条目原样保留）按用例
 * 逐条钉住，栅栏则连「差一点触发但不触发」的边界一起测——整编的正常缩水是期望行为，
 * 栅栏只兜极端退化，误伤它等于整编永远跑不成。
 *
 * 运行：node --test test/consolidate-core.test.js
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { byteLength, parseEntries } from '../lib/core/document.js'
import { mergeDigest, parseDigestOutput } from '../lib/core/digest.js'
import {
  applyConsolidation,
  extractJsonObject,
  parseConsolidateOutput,
  shouldConsolidate,
} from '../lib/core/consolidate.js'

/** 固定时间戳，整编新条目的 time 一律用它，断言才好写。 */
const T = '2026-11-10T10:00:00.000Z'

/**
 * 拼一份带 preamble 的 project 文档。
 * @param {Array<{ id?: string, body: string, time?: string, source?: string }>} items - 条目列表。
 * @returns {string} 文档文本。
 */
function projectDoc(items) {
  const lines = ['# 项目记忆', '', '<!-- 由 dsh-supermemory 维护；可直接编辑。 -->', '', '## 条目', '']
  items.forEach((item, i) => {
    if (i > 0) lines.push('')
    const id = item.id ? ` · id:${item.id}` : ''
    lines.push(`- ${item.time ?? T} · source:${item.source ?? 'digest'}${id}`)
    lines.push(`  ${item.body}`)
  })
  return `${lines.join('\n')}\n`
}

/** 三条带显式 id 的旧条目，够长以免误触 SHRINK_GUARD。 */
const THREE = [
  { id: 'a3f2c', body: '项目使用 pnpm 管理依赖，禁止使用 npm 安装任何包，那会破坏 lockfile 的一致性。' },
  { id: 'b8e01', body: '测试统一用 node --test 运行，不要写成 node --test test/ 目录形式。' },
  { id: 'c4d9f', body: '所有对外接口错误必须捕获并转成返回值错误码，不允许抛给宿主进程。' },
]

/** 五条旧条目：DROP_GUARD 的比例边界要有奇数条才测得出「超过一半」。 */
const FIVE = THREE.concat([
  { id: 'd7a12', body: '路由层所有写接口都要先过 trust 校验，非回环地址直接拒绝，不开兼容口子。' },
  { id: 'e2b58', body: '文档条目一律 append-only，改写必须走整编路径并留落盘前快照。' },
])

/** 取整编结果里的条目正文，按顺序（结果对象与文档文本都接受）。 */
function bodies(result) {
  return (Array.isArray(result) ? result : parseEntries(result.text ?? result)).map((entry) => entry.body)
}

describe('extractJsonObject', () => {
  test('纯 JSON 字符串', () => {
    assert.deepEqual(extractJsonObject('{"a":1}'), { a: 1 })
  })

  test('带 ```json 围栏', () => {
    assert.deepEqual(extractJsonObject('```json\n{"a":1}\n```'), { a: 1 })
  })

  test('前后有说明文字也能提出平衡括号里的对象', () => {
    assert.deepEqual(extractJsonObject('结论如下：{"entries":[]} 以上。'), { entries: [] })
  })

  test('嵌套对象整体提出', () => {
    assert.deepEqual(extractJsonObject('{"a":{"b":{"c":1}}}'), { a: { b: { c: 1 } } })
  })

  test('字符串里的花括号与转义不破坏括号平衡', () => {
    assert.deepEqual(extractJsonObject('{"text":"包含 } 与 \\" 的正文"}'), { text: '包含 } 与 " 的正文' })
  })

  test('带说明文字的干扰对象不会挤掉 json 围栏里的真结果', () => {
    const raw = '先说明 {"note":"不是结果"}，真正结果：\n```json\n{"entries":[{"text":"甲"}]}\n```'
    assert.deepEqual(extractJsonObject(raw), { entries: [{ text: '甲' }] })
  })

  test('数组、标量、无对象文本一律 null', () => {
    assert.equal(extractJsonObject('[1,2,3]'), null)
    assert.equal(extractJsonObject('"字符串"'), null)
    assert.equal(extractJsonObject('42'), null)
    assert.equal(extractJsonObject('这里什么对象都没有'), null)
  })

  test('空串与非字符串输入 → null', () => {
    for (const input of ['', '   ', undefined, null, 42, true]) {
      assert.equal(extractJsonObject(input), null, `应返回 null: ${String(input)}`)
    }
  })

  test('已解析的对象直接返回，数组仍算 null', () => {
    assert.deepEqual(extractJsonObject({ a: 1 }), { a: 1 })
    assert.equal(extractJsonObject([1, 2]), null)
  })

  test('与 parseDigestOutput 对同一输入的取值一致', () => {
    const raw = '好的，结果如下 {"project":["事实"],"drop":[]} 希望有帮助'
    assert.deepEqual(extractJsonObject(raw), JSON.parse('{"project":["事实"],"drop":[]}'))
    assert.equal(parseDigestOutput(raw).ok, true, '既有解析行为不能因抽取公共容错而改变')
  })
})

describe('parseConsolidateOutput', () => {
  test('标准输出解析成 entries 与 drop', () => {
    const raw = '{"entries":[{"text":"合并后的事实","from":["a3f2c","b8e01"]}],"drop":[{"id":"c4d9f","reason":"接口已下线"}]}'
    const result = parseConsolidateOutput(raw)
    assert.equal(result.ok, true)
    assert.deepEqual(result.entries, [{ text: '合并后的事实', from: ['a3f2c', 'b8e01'] }])
    assert.deepEqual(result.drop, [{ id: 'c4d9f', reason: '接口已下线' }])
  })

  test('围栏与前后文字一样容错', () => {
    const result = parseConsolidateOutput('整理结果：\n```json\n{"entries":[{"text":"甲"}]}\n```\n以上')
    assert.equal(result.ok, true)
    assert.deepEqual(result.entries, [{ text: '甲', from: [] }])
    assert.deepEqual(result.drop, [])
  })

  test('提不出 JSON 对象 → ok:false 且 error 非空', () => {
    for (const raw of ['这里没有对象', '[1,2,3]', '"纯字符串"']) {
      const result = parseConsolidateOutput(raw)
      assert.equal(result.ok, false)
      assert.ok(result.error.length > 0)
    }
    assert.equal(parseConsolidateOutput('').ok, false)
    assert.equal(parseConsolidateOutput('   ').ok, false)
  })

  test('entries 写成字符串项时按纯新增条目收下', () => {
    const result = parseConsolidateOutput('{"entries":["偷懒的一条"],"drop":[]}')
    assert.equal(result.ok, true)
    assert.deepEqual(result.entries, [{ text: '偷懒的一条', from: [] }])
  })

  test('text 缺失或空白的条目被丢弃', () => {
    const result = parseConsolidateOutput(
      '{"entries":[{"text":"  "},{"from":["a3f2c"]},{"text":"有效"},{"text":null}]}',
    )
    assert.deepEqual(result.entries, [{ text: '有效', from: [] }])
  })

  test('drop 缺 reason 或缺 id 的项被丢弃：没有理由的删除不执行', () => {
    const result = parseConsolidateOutput(
      '{"drop":[{"id":"a3f2c"},{"reason":"没给 id"},{"id":"b8e01","reason":"  "},{"id":"c4d9f","reason":"过期"}]}',
    )
    assert.deepEqual(result.drop, [{ id: 'c4d9f', reason: '过期' }])
  })

  test('from 转小写、去重、丢非字符串项', () => {
    const result = parseConsolidateOutput('{"entries":[{"text":"甲","from":["A3F2C","a3f2c",42,null,"  "]}]}')
    assert.deepEqual(result.entries[0].from, ['a3f2c'])
  })

  test('drop 同一 id 只留第一条', () => {
    const result = parseConsolidateOutput(
      '{"drop":[{"id":"a3f2c","reason":"理由一"},{"id":"a3f2c","reason":"理由二"}]}',
    )
    assert.deepEqual(result.drop, [{ id: 'a3f2c', reason: '理由一' }])
  })

  test('entries / drop 缺失或非数组 → ok 且都是空数组', () => {
    const result = parseConsolidateOutput('{"entries":"不是数组","drop":{"id":"a3f2c"}}')
    assert.deepEqual(result, { ok: true, entries: [], drop: [] })
  })
})

describe('applyConsolidation：对账规则', () => {
  const text = projectDoc(THREE)

  test('规则 3：from 命中的旧条目被新条目替代', () => {
    const result = applyConsolidation(text, { entries: [{ text: 'pnpm 与 lockfile', from: ['a3f2c'] }] }, { time: T })
    assert.equal(result.ok, true)
    assert.equal(result.text.includes('禁止使用 npm'), false)
    assert.ok(result.text.includes('pnpm 与 lockfile'))
    assert.deepEqual(result.absorbedIds, ['a3f2c'])
    assert.equal(result.counts.merged, 1)
  })

  test('规则 4：drop 命中的旧条目被移除并记录原因', () => {
    const result = applyConsolidation(text, { drop: [{ id: 'b8e01', reason: '测试命令已改' }] }, { time: T })
    assert.equal(bodies(result.text).includes(THREE[1].body), false)
    assert.deepEqual(result.droppedDetail, [{ id: 'b8e01', reason: '测试命令已改' }])
    assert.equal(result.counts.dropped, 1)
    assert.equal(result.counts.kept, 2)
  })

  test('规则 2：from 里的幽灵 id 被忽略并记入 ghosts，其余照常', () => {
    const result = applyConsolidation(
      text,
      { entries: [{ text: '合并两条', from: ['fffff', 'a3f2c'] }] },
      { time: T },
    )
    assert.deepEqual(result.ghosts, ['fffff'])
    assert.deepEqual(result.absorbedIds, ['a3f2c'])
    assert.equal(result.text.includes('合并两条'), true)
  })

  test('规则 2：drop 里的幽灵 id 记入 ghosts 且不产生删除', () => {
    const result = applyConsolidation(text, { drop: [{ id: 'eeeee', reason: '不存在' }] }, { time: T })
    assert.deepEqual(result.ghosts, ['eeeee'])
    assert.deepEqual(result.droppedDetail, [])
    assert.equal(result.counts.kept, 3)
  })

  test('同一幽灵 id 被引用两次只记一次', () => {
    const result = applyConsolidation(
      text,
      {
        entries: [{ text: '甲', from: ['fffff'] }],
        drop: [{ id: 'fffff', reason: '同一个幽灵' }],
      },
      { time: T },
    )
    assert.deepEqual(result.ghosts, ['fffff'])
  })

  test('边界 1：一个 id 被 2 条新条目引用，只有第一个吸收者生效', () => {
    const result = applyConsolidation(
      text,
      {
        entries: [
          { text: '第一个吸收者', from: ['a3f2c'] },
          { text: '第二个抢同一 id', from: ['a3f2c'] },
        ],
      },
      { time: T },
    )
    assert.equal(result.counts.merged, 1, '旧条目只可能被替代一次')
    assert.deepEqual(result.absorbedIds, ['a3f2c'])
    assert.deepEqual(result.duplicates, ['a3f2c'])
    assert.deepEqual(result.ghosts, [], '重复引用不是幽灵，两者病因不同')
    // 结果 = 2 条保留 + 2 条新增，绝不会凭空多出第三条替代品。
    assert.equal(parseEntries(result.text).length, 4)
    assert.equal(result.counts.kept, 2)
  })

  test('边界 1：一个 id 被 3 条新条目引用，后两条落到末尾', () => {
    const result = applyConsolidation(
      text,
      {
        entries: [
          { text: '甲', from: ['b8e01', 'c4d9f'] },
          { text: '乙', from: ['b8e01'] },
          { text: '丙', from: ['c4d9f'] },
        ],
      },
      { time: T },
    )
    assert.equal(result.counts.merged, 2)
    assert.deepEqual(result.absorbedIds, ['b8e01', 'c4d9f'])
    assert.deepEqual(result.duplicates, ['b8e01', 'c4d9f'])
    // 甲插在它吸收的 b8e01 原位（未安置的 a3f2c 仍在最前），乙丙无家可归落末尾。
    assert.deepEqual(bodies(result.text), [THREE[0].body, '甲', '乙', '丙'])
  })

  test('边界 2：改写却漏写 from → 新旧并存，旧条目计入 kept', () => {
    const result = applyConsolidation(
      text,
      { entries: [{ text: '项目使用 pnpm 管理依赖，禁止使用 npm 安装任何包，那会破坏 lockfile 的一致性。' }] },
      { time: T },
    )
    assert.equal(result.counts.kept, 3, '旧条目按规则 5 原样保留')
    assert.equal(result.counts.added, 1)
    assert.equal(parseEntries(result.text).length, 4, '重复但不丢')
    assert.deepEqual(result.absorbedIds, [])
  })

  test('边界 2：suspects 记下疑似漏写 from 的条目对', () => {
    const result = applyConsolidation(
      text,
      { entries: [{ text: '项目使用pnpm管理依赖禁止使用npm安装任何包那会破坏lockfile的一致性' }] },
      { time: T },
    )
    assert.equal(result.suspects.length, 1)
    assert.equal(result.suspects[0].id, 'a3f2c')
    assert.equal(result.suspects[0].time, T)
    assert.equal(result.suspects[0].oldBody, THREE[0].body)
    assert.ok(result.ok, 'suspects 不是栅栏，照常写入')
  })

  test('suspects 只比对被保留的旧条目：正常合并不误报', () => {
    const result = applyConsolidation(
      text,
      { entries: [{ text: THREE[0].body + '（补充：也禁 yarn）', from: ['a3f2c'] }] },
      { time: T },
    )
    assert.deepEqual(result.suspects, [])
  })

  test('suspects 不重复报同一条旧条目，也不报无关新条目', () => {
    const result = applyConsolidation(
      text,
      { entries: [{ text: '本项目一律用 bun 跑脚本，不再依赖 node 直接执行测试文件。' }] },
      { time: T },
    )
    assert.deepEqual(result.suspects, [])
  })

  test('正文太短时不参与相似度比对，避免满屏噪音', () => {
    const short = projectDoc([{ id: 'a3f2c', body: '确认' }, { id: 'b8e01', body: '同意' }])
    const result = applyConsolidation(short, { entries: [{ text: '确认', from: [] }] }, { time: T })
    assert.deepEqual(result.suspects, [])
  })

  test('规则 6：新条目插在它吸收的第一条旧条目原位', () => {
    const result = applyConsolidation(text, { entries: [{ text: '合并甲乙', from: ['b8e01'] }] }, { time: T })
    assert.deepEqual(bodies(result.text), [THREE[0].body, '合并甲乙', THREE[2].body])
  })

  test('规则 6：跨条目吸收插在第一条的位置，中间未安置的仍保留', () => {
    const result = applyConsolidation(text, { entries: [{ text: '合并首尾', from: ['a3f2c', 'c4d9f'] }] }, { time: T })
    assert.deepEqual(bodies(result.text), ['合并首尾', THREE[1].body])
  })

  test('规则 6：纯新条目追加到末尾', () => {
    const result = applyConsolidation(text, { entries: [{ text: '全新事实', from: [] }] }, { time: T })
    assert.deepEqual(bodies(result.text).at(-1), '全新事实')
    assert.equal(result.counts.added, 1)
    assert.equal(result.counts.merged, 0)
  })

  test('规则 6：from 全是幽灵的新条目也落到末尾', () => {
    const result = applyConsolidation(text, { entries: [{ text: '无家可归', from: ['fffff'] }] }, { time: T })
    assert.deepEqual(bodies(result.text), [THREE[0].body, THREE[1].body, THREE[2].body, '无家可归'])
    assert.deepEqual(result.ghosts, ['fffff'])
  })

  test('规则 5：模型只动一条，其余条目连时间戳带 id 原样保留', () => {
    const rich = projectDoc([
      { id: 'a3f2c', time: '2026-01-01T00:00:00.000Z', source: 'user-request', body: '要保留的老事实' },
      { id: 'b8e01', time: '2026-02-02T00:00:00.000Z', body: '被合并的老事实' },
    ])
    const result = applyConsolidation(rich, { entries: [{ text: '合并结果', from: ['b8e01'] }] }, { time: T })
    assert.ok(result.text.includes('- 2026-01-01T00:00:00.000Z · source:user-request · id:a3f2c'))
    assert.equal(result.counts.kept, 1)
    // 未被安置的老条目没有显式 id 时，整编产物也不给它补 id。
    const plain = projectDoc([{ body: '没有 id 的老条目' }, { id: 'b8e01', body: '被合并的老事实' }])
    const plainResult = applyConsolidation(plain, { entries: [{ text: '合并结果', from: ['b8e01'] }] }, { time: T })
    assert.equal(plainResult.text.includes(' · id:a3f2c'), false)
    assert.equal(plainResult.text.includes(' · id:'), false)
  })

  test('规则 5：entries 与 drop 全空时，文档内容一条不少', () => {
    const result = applyConsolidation(text, { entries: [], drop: [] }, { time: T })
    assert.equal(result.ok, true)
    assert.deepEqual(bodies(result.text), bodies(text))
    assert.equal(result.counts.kept, 3)
    assert.deepEqual(result.counts, { added: 0, merged: 0, dropped: 0, kept: 3 })
  })

  test('规则 5：引用全是幽灵时全文原样保留', () => {
    const result = applyConsolidation(
      text,
      { entries: [{ text: '新东西', from: ['fffff', 'eeeee'] }], drop: [{ id: 'ddddd', reason: '不存在' }] },
      { time: T },
    )
    for (const item of THREE) assert.ok(result.text.includes(item.body))
    assert.deepEqual(result.ghosts, ['fffff', 'eeeee', 'ddddd'])
    assert.equal(result.counts.kept, 3)
  })

  test('preamble 逐字保留在产物里', () => {
    const result = applyConsolidation(text, { entries: [{ text: '甲', from: ['a3f2c'] }] }, { time: T })
    assert.ok(result.text.startsWith('# 项目记忆\n\n<!-- 由 dsh-supermemory 维护；可直接编辑。 -->\n\n## 条目\n\n'))
  })

  test('新条目的 time / source 来自 options，source 缺省为 digest', () => {
    const withSource = applyConsolidation(text, { entries: [{ text: '甲' }] }, { time: T, source: 'consolidate' })
    assert.ok(withSource.text.includes(`- ${T} · source:consolidate`))
    const byDefault = applyConsolidation(text, { entries: [{ text: '乙' }] })
    assert.match(byDefault.text, /- \S+ · source:digest\n {2}乙/)
  })

  test('parsed 为 null 或形状畸形时不抛错，按空整编处理', () => {
    for (const parsed of [null, undefined, {}, { entries: 'x', drop: 42 }, { entries: [null, 7], drop: [{}] }]) {
      const result = applyConsolidation(text, parsed, { time: T })
      assert.equal(result.ok, true)
      assert.deepEqual(bodies(result.text), bodies(text))
    }
  })

  test('oldText 非法（非字符串）时不抛错，只写新条目', () => {
    const result = applyConsolidation(undefined, { entries: [{ text: '甲' }] }, { time: T })
    assert.equal(result.ok, true)
    assert.deepEqual(bodies(result.text), ['甲'])
    assert.equal(result.counts.kept, 0)
  })

  test('整编产物可直接被 parseEntries 再次解析（落盘形状合法）', () => {
    const result = applyConsolidation(text, { entries: [{ text: '甲', from: ['a3f2c'] }] }, { time: T })
    const reparsed = parseEntries(result.text)
    assert.equal(reparsed.length, 3)
    assert.ok(result.text.endsWith('\n'))
  })

  test('mergeDigest 追加出的文档能直接进整编', () => {
    const merged = mergeDigest({ project: projectDoc(THREE) }, { project: ['第四条新事实'] }, { time: T })
    const result = applyConsolidation(merged.project, { entries: [{ text: '第三四条合并', from: ['c4d9f'] }] }, { time: T })
    assert.equal(result.ok, true)
    assert.equal(result.text.includes('第四条新事实'), true)
    assert.equal(result.text.includes('第三四条合并'), true)
  })
})

describe('applyConsolidation：三道栅栏', () => {
  const text = projectDoc(THREE)

  test('EMPTY：原文有条目而产物为空，优先于 DROP_GUARD 报出', () => {
    const result = applyConsolidation(text, { drop: THREE.map((item) => ({ id: item.id, reason: '全删' })) }, { time: T })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'EMPTY')
    assert.equal(typeof result.bytesBefore, 'number')
    assert.equal(typeof result.bytesAfter, 'number')
    assert.equal('text' in result, false, '栅栏失败时不产出文本')
  })

  test('EMPTY 不拦「原文本来就没条目」', () => {
    const empty = projectDoc([])
    const result = applyConsolidation(empty, { entries: [], drop: [] }, { time: T })
    assert.equal(result.ok, true)
  })

  test('SHRINK_GUARD：二十条压成一句话被拦下', () => {
    const many = projectDoc(
      Array.from({ length: 20 }, (_, i) => ({ id: `a${String(i).padStart(4, '0')}`, body: `第${i}条事实，内容足够长以撑住原文字节数，避免误判。` })),
    )
    const result = applyConsolidation(
      many,
      { entries: [{ text: '一句话', from: Array.from({ length: 20 }, (_, i) => `a${String(i).padStart(4, '0')}`) }] },
      { time: T },
    )
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'SHRINK_GUARD')
    assert.ok(result.bytesAfter < result.bytesBefore)
  })

  test('SHRINK_GUARD 边界：比例刚好等于实际缩水比时不触发', () => {
    const parsed = { entries: [{ text: '压缩后的短句', from: ['a3f2c', 'b8e01'] }] }
    const okOnce = applyConsolidation(text, parsed, { time: T, minKeepRatio: 0 })
    assert.equal(okOnce.ok, true)
    const ratio = byteLength(okOnce.text) / byteLength(text)

    // 阈值略高于实际留存比 → 触发；等于或低于 → 不触发（严格小于才判退化）。
    assert.equal(applyConsolidation(text, parsed, { time: T, minKeepRatio: ratio * 1.000001 }).reason, 'SHRINK_GUARD')
    assert.equal(applyConsolidation(text, parsed, { time: T, minKeepRatio: ratio }).ok, true)
    assert.equal(applyConsolidation(text, parsed, { time: T, minKeepRatio: ratio * 0.99 }).ok, true)
  })

  test('SHRINK_GUARD 阈值非法时退回默认 0.15', () => {
    for (const bad of [NaN, -1, 'abc', undefined]) {
      const result = applyConsolidation(text, { entries: [{ text: '甲', from: ['a3f2c'] }] }, { time: T, minKeepRatio: bad })
      assert.equal(result.ok, true, `非法阈值应退回默认: ${String(bad)}`)
    }
  })

  test('DROP_GUARD：纯删一半以上且没有任何合并', () => {
    const five = projectDoc(FIVE)
    const result = applyConsolidation(
      five,
      {
        drop: [
          { id: 'a3f2c', reason: '过期' },
          { id: 'b8e01', reason: '过期' },
          { id: 'c4d9f', reason: '过期' },
        ],
      },
      { time: T, minKeepRatio: 0 },
    )
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'DROP_GUARD', '3 > 5×0.5 且 merged 为 0')
  })

  test('DROP_GUARD 边界：正好一半不触发', () => {
    const five = projectDoc(FIVE)
    const result = applyConsolidation(
      five,
      {
        drop: [
          { id: 'a3f2c', reason: '过期' },
          { id: 'b8e01', reason: '过期' },
        ],
      },
      { time: T, minKeepRatio: 0 },
    )
    assert.equal(result.ok, true)
    assert.equal(result.counts.dropped, 2, '2 > 5×0.5 为假，不该拦')
    assert.equal(result.counts.kept, 3)
  })

  test('DROP_GUARD 边界：只要伴随合并就不触发', () => {
    const five = projectDoc(FIVE)
    const result = applyConsolidation(
      five,
      {
        entries: [{ text: '合并一条', from: ['d7a12'] }],
        drop: [
          { id: 'a3f2c', reason: '过期' },
          { id: 'b8e01', reason: '过期' },
          { id: 'c4d9f', reason: '过期' },
        ],
      },
      { time: T, minKeepRatio: 0 },
    )
    assert.equal(result.ok, true)
    assert.equal(result.counts.merged, 1)
    assert.equal(result.counts.dropped, 3)
  })

  test('DROP_GUARD 可用 maxDropRatio 放宽；全删仍先撞 EMPTY', () => {
    const five = projectDoc(FIVE)
    const loose = applyConsolidation(
      five,
      {
        drop: [
          { id: 'a3f2c', reason: 'x' },
          { id: 'b8e01', reason: 'y' },
          { id: 'c4d9f', reason: 'z' },
        ],
      },
      { time: T, minKeepRatio: 0, maxDropRatio: 0.9 },
    )
    assert.equal(loose.ok, true, '阈值放宽到 0.9 后 3/5 不算异常')

    const allGone = applyConsolidation(
      five,
      { drop: FIVE.map((item) => ({ id: item.id, reason: '全删' })) },
      { time: T, minKeepRatio: 0, maxDropRatio: 0.99 },
    )
    assert.equal(allGone.reason, 'EMPTY', '产物一条不剩时先撞 EMPTY 栅栏')
  })
})

describe('shouldConsolidate', () => {
  const base = {
    enabled: true,
    entryCount: 25,
    bytes: 20000,
    minEntries: 20,
    minBytes: 12288,
    lastConsolidateAt: '2026-11-10T00:00:00.000Z',
    cooldownMs: 21600000,
    now: '2026-11-10T10:00:00.000Z',
  }

  test('开关关闭直接否', () => {
    assert.deepEqual(shouldConsolidate({ ...base, enabled: false }), { consolidate: false, reason: 'disabled' })
    assert.equal(shouldConsolidate({ ...base, enabled: undefined }).reason, 'disabled')
    assert.equal(shouldConsolidate().reason, 'disabled')
    assert.equal(shouldConsolidate({ ...base, enabled: 'true' }).reason, 'disabled', '只认真 true')
  })

  test('条目数达标即整编', () => {
    const result = shouldConsolidate({ ...base, entryCount: 20, bytes: 100 })
    assert.deepEqual(result, { consolidate: true, reason: 'entry-count' })
  })

  test('体积达标即整编', () => {
    const result = shouldConsolidate({ ...base, entryCount: 3, bytes: 12288 })
    assert.deepEqual(result, { consolidate: true, reason: 'bytes' })
  })

  test('两者都不达标时不整编，也不看 cooldown', () => {
    const result = shouldConsolidate({ ...base, entryCount: 19, bytes: 12287, cooldownMs: 0 })
    assert.deepEqual(result, { consolidate: false, reason: 'below-threshold' })
  })

  test('cooldown 未到不整编', () => {
    const result = shouldConsolidate({ ...base, now: '2026-11-10T05:00:00.000Z' })
    assert.deepEqual(result, { consolidate: false, reason: 'cooldown' })
  })

  test('cooldown 已过则整编（正好到点也算过）', () => {
    assert.equal(shouldConsolidate({ ...base, now: '2026-11-10T06:00:00.000Z' }).consolidate, true)
    assert.equal(shouldConsolidate({ ...base, now: '2026-11-10T05:59:59.999Z' }).reason, 'cooldown')
  })

  test('lastConsolidateAt 缺失或非法时间串按没有整编过处理', () => {
    for (const value of [undefined, null, '', 'not-a-date', 0, '2026-13-45T99:00:00Z']) {
      assert.equal(
        shouldConsolidate({ ...base, lastConsolidateAt: value }).consolidate,
        true,
        `非法 lastConsolidateAt 应放行: ${String(value)}`,
      )
    }
  })

  test('now 缺失时用当前时间判定 cooldown', () => {
    const past = shouldConsolidate({ ...base, lastConsolidateAt: '2000-01-01T00:00:00.000Z', now: undefined })
    assert.equal(past.consolidate, true)
    const future = shouldConsolidate({ ...base, lastConsolidateAt: '2099-01-01T00:00:00.000Z', now: undefined })
    assert.equal(future.reason, 'cooldown', '上次整编时间在遥远的将来，无论现在几点都还在冷却')
  })

  test('cooldownMs 为 0 或非法时不冷却', () => {
    for (const value of [0, undefined, NaN, 'abc', -1]) {
      assert.equal(
        shouldConsolidate({ ...base, cooldownMs: value }).consolidate,
        true,
        `不该冷却: ${String(value)}`,
      )
    }
  })

  test('阈值缺省用契约默认 20 条 / 12288 字节', () => {
    const { minEntries, minBytes, ...rest } = base
    assert.equal(shouldConsolidate({ ...rest, entryCount: 20, bytes: 0 }).consolidate, true)
    assert.equal(shouldConsolidate({ ...rest, entryCount: 19, bytes: 12287 }).consolidate, false)
    assert.equal(shouldConsolidate({ ...rest, entryCount: 0, bytes: 12288 }).consolidate, true)
  })

  test('entryCount / bytes 非法按 0 处理，不整编也不抛', () => {
    for (const bad of [undefined, null, NaN, -5, 'abc']) {
      assert.equal(shouldConsolidate({ ...base, entryCount: bad, bytes: bad }).reason, 'below-threshold')
    }
  })

  test('数字字符串阈值可用（配置从 yml 读出来常是字符串）', () => {
    assert.equal(shouldConsolidate({ ...base, entryCount: '25', minEntries: '20' }).reason, 'entry-count')
  })
})
