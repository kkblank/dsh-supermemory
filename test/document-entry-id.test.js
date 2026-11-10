/**
 * 条目 id 与文档整篇重建的单测（契约 §V4.0.1）。
 *
 * 覆盖三件事：派生 id 稳定且幂等、一份文档内 id 唯一（相撞逐位延长）、
 * `rebuildDocument` 的 preamble 逐字保留。向后兼容是底线，所以这里还钉住了
 * 「旧格式照读、往返不擅自补 id、`appendEntries` 逐字节不变」三条回归。
 *
 * 运行：node --test test/document-entry-id.test.js
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, test } from 'node:test'

import {
  appendEntries,
  deriveEntryId,
  emptyDocument,
  parseEntries,
  rebuildDocument,
  renderEntry,
} from '../lib/core/document.js'

/** 固定时间戳：id 派生的输入之一，测试里全程用它。 */
const T = '2026-11-10T10:00:00.000Z'

/**
 * 独立算一遍 sha1 前若干位。测试样本是否还相撞、`deriveEntryId` 有没有跑偏，
 * 都拿这个「局外事实」校验，而不是拿被测函数自己证明自己。
 *
 * @param {number} size - 取前几位。
 * @param {string} time - 条目时间。
 * @param {string} body - 条目正文。
 * @returns {string} hex 前缀。
 */
function sha1Prefix(size, time, body) {
  return createHash('sha1').update(`${time}\n${body}`, 'utf8').digest('hex').slice(0, size)
}

/**
 * 两个正文：穷举得到的一对 sha1 前 7 位相同（`d5d5e67`）的样本，用于造 id 相撞。
 * 一旦有人改了派生算法或时间戳，`id 相撞样本有效性` 用例会立刻红。
 */
const COLLIDE_A = '记忆条目-12526'
const COLLIDE_B = '记忆条目-20386'

/**
 * 拼一份标准文档：preamble + 给定行（以换行结尾，与真实落盘文档一致）。
 * @param {string[]} bodyLines - 条目区的原始行。
 * @returns {string} 文档文本。
 */
function doc(bodyLines) {
  return `${[`# 项目记忆`, '', `## 条目`, '', ...bodyLines].join('\n')}\n`
}

/**
 * 一条标准条目块（头行 + 每行两空格缩进的正文）。
 * @param {string} head - 条目头行。
 * @param {string} body - 未缩进的正文，可含换行。
 * @returns {string[]} 若干行。
 */
function block(head, body) {
  return [head, ...body.split('\n').map((line) => (line === '' ? '' : `  ${line}`))]
}

describe('deriveEntryId', () => {
  test('等于 sha1(time + 换行 + body) 的 hex 前 5 位', () => {
    assert.equal(deriveEntryId(T, '甲'), sha1Prefix(5, T, '甲'))
    assert.match(deriveEntryId(T, '甲'), /^[0-9a-f]{5}$/)
  })

  test('同一输入多次调用结果一致（幂等）', () => {
    for (let i = 0; i < 3; i += 1) {
      assert.equal(deriveEntryId(T, '同一句话'), deriveEntryId(T, '同一句话'))
    }
  })

  test('time 或 body 任一不同则 id 不同', () => {
    const base = deriveEntryId(T, '甲')
    assert.notEqual(base, deriveEntryId(T, '乙'))
    assert.notEqual(base, deriveEntryId('2026-11-11T10:00:00.000Z', '甲'))
  })

  test('非字符串字段不抛错，仍返回 5 位 hex', () => {
    for (const [time, body] of [
      [undefined, undefined],
      [null, null],
      [42, '正文'],
      [T, undefined],
    ]) {
      assert.match(deriveEntryId(time, body), /^[0-9a-f]{5}$/)
    }
  })
})

describe('parseEntries 的 id 分配', () => {
  test('旧格式（无 id 段）照读，字段与 v3 完全一致', () => {
    const text = doc([
      ...block(`- ${T} · source:user-request`, '内容第一行\n内容第二行'),
    ])
    const [entry] = parseEntries(text)
    assert.equal(entry.time, T)
    assert.equal(entry.source, 'user-request')
    assert.equal(entry.body, '内容第一行\n内容第二行')
  })

  test('旧格式的 id 是派生 id，且只有三个可枚举字段（不打破既有逐字段比对）', () => {
    const text = doc(block(`- ${T} · source:digest`, '老事实'))
    const [entry] = parseEntries(text)
    assert.equal(entry.id, deriveEntryId(T, '老事实'))
    assert.equal(entry.explicitId, false)
    assert.deepEqual(Object.keys(entry), ['time', 'source', 'body'])
    assert.deepEqual(entry, { time: T, source: 'digest', body: '老事实' })
    assert.equal(JSON.stringify(entry), '{"time":"' + T + '","source":"digest","body":"老事实"}')
  })

  test('带 id 段时显式 id 优先，explicitId 为 true', () => {
    const text = doc(block(`- ${T} · source:digest · id:a3f2c`, '有身份的条目'))
    const [entry] = parseEntries(text)
    assert.equal(entry.id, 'a3f2c')
    assert.equal(entry.explicitId, true)
    // 显式 id 与派生 id 无关：即使两者不同，也以显式为准。
    assert.notEqual(entry.id, deriveEntryId(T, '有身份的条目'))
  })

  test('id 段格式不合法（非 hex / 长度越界）时退回派生 id', () => {
    for (const bad of ['ZZZZZ', 'abc', 'A3F2C', 'a3f2c123456']) {
      const [entry] = parseEntries(doc(block(`- ${T} · source:digest · id:${bad}`, '脏 id')))
      assert.equal(entry.id, deriveEntryId(T, '脏 id'), `脏 id 未被忽略: ${bad}`)
      assert.equal(entry.explicitId, false)
    }
  })

  test('同一份文本多次解析得到同一批 id（幂等）', () => {
    const text = doc([
      ...block(`- ${T} · source:digest`, '甲'),
      '',
      ...block(`- ${T} · source:tool · id:b8e01`, '乙'),
      '',
      ...block(`- ${T} · source:user-request`, '丙'),
    ])
    const first = parseEntries(text).map((entry) => entry.id)
    const second = parseEntries(text).map((entry) => entry.id)
    assert.deepEqual(first, second)
    assert.equal(new Set(first).size, 3)
  })

  test('CRLF 归一后与 LF 版本得到同一批 id', () => {
    const text = doc(block(`- ${T} · source:digest`, '换行风格不该影响 id'))
    const lf = parseEntries(text)[0].id
    const crlf = parseEntries(text.split('\n').join('\r\n'))[0].id
    assert.equal(crlf, lf)
  })

  test('手写重复的显式 id 只有第一处作数，其余退回派生', () => {
    const text = doc([
      ...block(`- ${T} · source:digest · id:a3f2c`, '第一处'),
      '',
      ...block(`- ${T} · source:digest · id:a3f2c`, '第二处'),
    ])
    const entries = parseEntries(text)
    assert.equal(entries[0].id, 'a3f2c')
    assert.equal(entries[0].explicitId, true)
    assert.equal(entries[1].explicitId, false)
    assert.notEqual(entries[1].id, 'a3f2c')
    assert.equal(entries[1].id, deriveEntryId(T, '第二处'))
  })

  test('id 相撞样本有效性：两条正文的 sha1 前 7 位确实相同', () => {
    // 这条不测实现，只钉住上面两个常量的相撞前提；派生算法一改就会红。
    assert.equal(sha1Prefix(7, T, COLLIDE_A), 'd5d5e67')
    assert.equal(sha1Prefix(7, T, COLLIDE_B), 'd5d5e67')
    assert.equal(deriveEntryId(T, COLLIDE_A), 'd5d5e')
    assert.equal(deriveEntryId(T, COLLIDE_B), 'd5d5e')
    assert.notEqual(sha1Prefix(9, T, COLLIDE_A), sha1Prefix(9, T, COLLIDE_B))
  })

  test('派生 id 与显式 id 相撞：逐位延长到 7 位', () => {
    // 显式占用 d5d5e7… 之外的 5 位前缀 d5d5e，逼两条派生条目让位。
    const text = doc([
      ...block(`- ${T} · source:digest · id:d5d5e`, '抢占 5 位前缀'),
      '',
      ...block(`- ${T} · source:digest`, COLLIDE_A),
      '',
      ...block(`- ${T} · source:digest`, COLLIDE_B),
    ])
    const entries = parseEntries(text)
    assert.equal(entries[0].id, 'd5d5e')
    assert.equal(entries[1].id, 'd5d5e67', '第一条派生应延长到 7 位')
    assert.equal(entries[2].id, sha1Prefix(9, T, COLLIDE_B), '第二条派生 7 位仍撞，应延长到 9 位')
    assert.equal(new Set(entries.map((entry) => entry.id)).size, 3)
    assert.deepEqual(entries.map((entry) => entry.explicitId), [true, false, false])
  })

  test('5 位与 7 位都被占用时，派生 id 连延到 9 位', () => {
    const text = doc([
      ...block(`- ${T} · source:digest · id:d5d5e`, '占用 5 位'),
      '',
      ...block(`- ${T} · source:digest · id:d5d5e67`, '占用 7 位'),
      '',
      ...block(`- ${T} · source:digest`, COLLIDE_A),
      '',
      ...block(`- ${T} · source:digest`, COLLIDE_B),
    ])
    const entries = parseEntries(text)
    assert.equal(entries[2].id, 'd5d5e6720')
    assert.equal(entries[3].id, 'd5d5e6774')
    assert.equal(new Set(entries.map((entry) => entry.id)).size, 4)
    // 9 位仍在可写盘范围内。
    for (const entry of entries.slice(2)) assert.match(entry.id, /^[0-9a-f]{5,9}$/)
  })

  test('连 9 位都被占用时继续延长，超长的 id 不写盘', () => {
    const text = doc([
      ...block(`- ${T} · source:digest · id:d5d5e`, '占用 5 位'),
      '',
      ...block(`- ${T} · source:digest · id:d5d5e67`, '占用 7 位'),
      '',
      ...block(`- ${T} · source:digest · id:d5d5e6720`, '占用 9 位'),
      '',
      ...block(`- ${T} · source:digest`, COLLIDE_A),
      '',
      ...block(`- ${T} · source:digest`, COLLIDE_B),
    ])
    const entries = parseEntries(text)
    const long = entries[3]
    assert.equal(long.id, 'd5d5e672011', '兜底延长到 11 位')
    assert.equal(long.explicitId, false)
    // 超过契约的 5–9 位范围，所以只活在内存里，绝不写进文档。
    assert.equal(renderEntry(long).includes(' · id:'), false)
    assert.equal(new Set(entries.map((entry) => entry.id)).size, 5)
  })

  test('空文档与非法输入仍是 []', () => {
    assert.deepEqual(parseEntries(''), [])
    assert.deepEqual(parseEntries(undefined), [])
    assert.deepEqual(parseEntries(emptyDocument('x')), [])
  })
})

describe('renderEntry 的 id 段', () => {
  test('手工给的合法 id 会写出来', () => {
    assert.equal(
      renderEntry({ time: T, source: 'digest', body: '正文', id: 'a3f2c' }),
      `- ${T} · source:digest · id:a3f2c\n  正文`,
    )
  })

  test('id 缺省或格式不合法时不写 id 段', () => {
    for (const id of [undefined, null, '', 'zzzzz', 'abc', 'A3F2C', 'a3f2c123456']) {
      const rendered = renderEntry({ time: T, source: 'digest', body: '正文', id })
      assert.equal(rendered.includes(' · id:'), false, `不该写出 id: ${String(id)}`)
    }
  })

  test('解析期派生的 id 不写盘（explicitId 为 false）', () => {
    const [entry] = parseEntries(doc(block(`- ${T} · source:digest`, '派生身份')))
    assert.equal(typeof entry.id, 'string')
    assert.equal(renderEntry(entry).includes(' · id:'), false)
  })

  test('往返：老文档 parse → render 后仍不含任何 id 段', () => {
    const text = doc([
      ...block(`- ${T} · source:user-request`, '甲'),
      '',
      ...block(`- ${T} · source:digest`, '乙'),
    ])
    assert.equal(text.includes(' · id:'), false)
    const rebuilt = rebuildDocument(text, parseEntries(text))
    assert.equal(rebuilt.includes(' · id:'), false, '不擅自给老条目补 id')
    assert.deepEqual(
      parseEntries(rebuilt).map((entry) => entry.body),
      ['甲', '乙'],
    )
  })

  test('往返：显式 id 在 parse → render 后逐字不变', () => {
    const head = `- ${T} · source:digest · id:d5d5e67`
    const rebuilt = rebuildDocument(doc(block(head, '带 id 的条目')), parseEntries(doc(block(head, '带 id 的条目'))))
    assert.ok(rebuilt.includes(head))
  })

  test('body 为空时只有头行，id 段照写', () => {
    assert.equal(renderEntry({ time: T, source: 'digest', body: '', id: 'a3f2c' }), `${`- ${T} · source:digest`} · id:a3f2c`)
  })
})

describe('rebuildDocument', () => {
  test('原文没有条目头：整段是 preamble，条目追加其后', () => {
    const out = rebuildDocument('# T\n\n说明段。\n', [{ time: T, source: 's', body: 'b' }])
    assert.equal(out, '# T\n\n说明段。\n\n' + `- ${T} · source:s\n  b\n`)
  })

  test('用户手写说明段逐字保留在第一个条目头之前', () => {
    const text = [
      '# 项目记忆',
      '',
      '<!-- 由 dsh-supermemory 维护；可直接编辑。 -->',
      '',
      '## 条目',
      '',
      '下面三条是老张整理的，别动。',
      '',
      `- ${T} · source:user-request`,
      '  甲',
      '',
    ].join('\n')
    const keep = text.slice(0, text.indexOf(`- ${T}`))
    const out = rebuildDocument(text, parseEntries(text))
    assert.ok(out.startsWith(keep.replace(/\s+$/, '')), 'preamble 被改写了')
    assert.ok(out.includes('下面三条是老张整理的，别动。'))
    assert.ok(out.includes('可直接编辑'))
  })

  test('条目为空数组：只留 preamble，尾部规范化为一个换行', () => {
    const text = doc([`- ${T} · source:digest`, '  甲'])
    const out = rebuildDocument(text, [])
    assert.equal(out.includes('甲'), false)
    assert.equal(out, '# 项目记忆\n\n## 条目\n')
    assert.deepEqual(parseEntries(out), [])
  })

  test('空文本 + 空条目 → 空串', () => {
    assert.equal(rebuildDocument('', []), '')
    assert.equal(rebuildDocument(undefined, undefined), '')
    assert.equal(rebuildDocument('   \n  ', []), '')
  })

  test('整篇替换：旧条目区被完全换掉，不留残余', () => {
    const text = doc([
      ...block(`- ${T} · source:digest`, '旧甲'),
      '',
      ...block(`- ${T} · source:digest`, '旧乙'),
    ])
    const out = rebuildDocument(text, [
      { time: T, source: 'digest', body: '新甲' },
      { time: T, source: 'digest', body: '新乙' },
    ])
    assert.equal(out.includes('旧甲'), false)
    assert.equal(out.includes('旧乙'), false)
    assert.deepEqual(parseEntries(out).map((entry) => entry.body), ['新甲', '新乙'])
  })

  test('entries 带合法 id / 不带 id，两种渲染结果各自正确', () => {
    const out = rebuildDocument('', [
      { time: T, source: 'digest', body: '有身份', id: 'a3f2c' },
      { time: T, source: 'digest', body: '没身份' },
    ])
    assert.ok(out.includes(`- ${T} · source:digest · id:a3f2c`))
    assert.ok(out.includes(`- ${T} · source:digest\n  没身份`))
  })

  test('幂等：rebuild 一次后再按其结果 rebuild，文本不变', () => {
    const text = doc([
      ...block(`- ${T} · source:digest · id:a3f2c`, '甲'),
      '',
      ...block(`- ${T} · source:digest`, '乙'),
    ])
    const once = rebuildDocument(text, parseEntries(text))
    const twice = rebuildDocument(once, parseEntries(once))
    assert.equal(twice, once)
  })

  test('CRLF 输入被归一，产物以换行结尾', () => {
    const out = rebuildDocument(`# T\r\n\r\n- ${T} · source:s\r\n  b\r\n`, [{ time: T, source: 's', body: 'b' }])
    assert.equal(out.includes('\r'), false)
    assert.ok(out.endsWith('\n'))
  })
})

describe('id 的不可枚举是刻意设计（已知后果，一并钉住）', () => {
  test('派生 id 不写盘，显式 id 走 renderEntry / rebuildDocument 都不丢', () => {
    const text = doc([
      ...block(`- ${T} · source:digest · id:a3f2c`, '有身份'),
      '',
      ...block(`- ${T} · source:digest`, '没身份'),
    ])
    const entries = parseEntries(text)
    const rebuilt = rebuildDocument(text, entries)
    assert.ok(rebuilt.includes(' · id:a3f2c'), 'rebuildDocument 不能因为 spread 丢 id')
    assert.ok(renderEntry(entries[0]).includes(' · id:a3f2c'))
    assert.equal(rebuilt.includes(deriveEntryId(T, '没身份')), false)
    // 整编链路只传文本，不传条目对象，所以展开丢 id 影响不到它。
    assert.deepEqual(parseEntries(rebuilt).map((entry) => entry.id), ['a3f2c', entries[1].id])
  })

  test('展开与 JSON 序列化会丢 id——下游若这么做必须自己带上', () => {
    const [entry] = parseEntries(doc(block(`- ${T} · source:digest · id:a3f2c`, '有身份')))
    assert.equal({ ...entry }.id, undefined, 'spread 丢 id：这是不可枚举的已知代价')
    assert.equal(JSON.parse(JSON.stringify(entry)).id, undefined)
    // 手工带上就还在，提醒下游 id 需要显式搬运。
    assert.equal(renderEntry({ ...entry, id: entry.id }).includes(' · id:a3f2c'), true)
  })
})

describe('appendEntries 行为不变（回归守护）', () => {
  test('追加产物逐字节等于硬编码期望，且不含 id 段', () => {
    const out = appendEntries(emptyDocument('t'), [
      { time: T, source: 'digest', body: '甲' },
      { time: T, source: 'digest', body: '乙' },
    ])
    assert.equal(
      out,
      `# t\n\n<!-- 由 dsh-supermemory 维护；可直接编辑。 -->\n\n## 条目\n\n- ${T} · source:digest\n  甲\n\n- ${T} · source:digest\n  乙\n`,
    )
  })

  test('把解析结果再 append 回去，不会给老条目补 id', () => {
    const text = doc(block(`- ${T} · source:digest`, '老条目'))
    const out = appendEntries(text, parseEntries(text))
    assert.equal(out.includes(' · id:'), false)
  })

  test('空 entries 只标准化尾部换行，内容不动', () => {
    const text = doc(block(`- ${T} · source:digest`, '甲'))
    assert.equal(appendEntries(text, []), text)
    assert.equal(appendEntries('', []), '')
    assert.equal(appendEntries('# T', []), '# T\n')
  })
})
