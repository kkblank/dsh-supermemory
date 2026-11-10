/**
 * render.js / digest.js 纯函数单测（契约 §10 第二组）。
 *
 * 只依赖 node:test、node:assert/strict 与 lib/core 下的相对模块，不装任何依赖。
 *
 * @module dsh-supermemory/test/render-digest
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { byteLength, emptyDocument, parseEntries } from '../lib/core/document.js'
import {
  buildIndex,
  buildPersonaSection,
  buildSnapshot,
  escapeFrame,
} from '../lib/core/render.js'
import { mergeDigest, parseDigestOutput } from '../lib/core/digest.js'

/** 索引降级文本必须包含的固定提示行（契约 §3.3 规则 4）。 */
const INDEX_HINT = '完整内容可用 memory 工具按需读取。'

/** 构造 sha1 十六进制摘要，用于校验 digest 口径。 */
function sha1(value) {
  return createHash('sha1').update(value, 'utf8').digest('hex')
}

/**
 * 契约口径：digest = sha1(JSON.stringify({ soul, user, global, project, projectName, truncated }))。
 * 取原始四段内容（trim 后）而非渲染文本，保证降级时正文变化也能反映到 digest。
 */
function expectedDigest(input, truncated) {
  const payload = JSON.stringify({
    soul: (input.soul ?? '').trim(),
    user: (input.user ?? '').trim(),
    global: (input.global ?? '').trim(),
    project: (input.project ?? '').trim(),
    projectName: (input.projectName ?? '').trim(),
    truncated,
  })
  return sha1(payload)
}

/** 统计 `</supermemory>` 在文本里出现的次数（真实闭合标签数）。 */
function closeTagCount(text) {
  return text.split('</supermemory>').length - 1
}

/** 四段齐全的样例输入。 */
function fullInput(overrides = {}) {
  return {
    soul: '你是一个严谨的工程师。',
    user: '用户偏好简体中文。',
    global: '项目使用 Node 24。',
    project: '本项目禁止 import 宿主包。',
    projectName: 'dsh-supermemory',
    maxBytes: 1_000_000,
    ...overrides,
  }
}

// —— escapeFrame ——

test('escapeFrame：把闭合标签转义成 <\\/supermemory>', () => {
  assert.equal(escapeFrame('a</supermemory>b'), 'a<\\/supermemory>b')
  // 大小写与标签内空白也要转义。
  assert.equal(escapeFrame('a</SuperMemory >b'), 'a<\\/SuperMemory >b')
  // 自定义 tag。
  assert.equal(escapeFrame('x</frame>y', 'frame'), 'x<\\/frame>y')
  // 空输入与非字符串安全。
  assert.equal(escapeFrame(''), '')
  assert.equal(escapeFrame(null), '')
})

// —— buildSnapshot ——

test('buildSnapshot：四段齐全时输出四段标题且 digest 是 40 位十六进制', () => {
  const snapshot = buildSnapshot(fullInput())
  assert.equal(snapshot.truncated, false)
  assert.equal(snapshot.text.startsWith('<supermemory>'), true)
  assert.equal(snapshot.text.endsWith('</supermemory>'), true)
  assert.equal(closeTagCount(snapshot.text), 1)
  assert.match(snapshot.text, /^## 人格 \(soul\)$/m)
  assert.match(snapshot.text, /^## 用户画像 \(user\)$/m)
  assert.match(snapshot.text, /^## 全局长期记忆 \(global\)$/m)
  assert.match(snapshot.text, /^## 项目记忆 \(project: dsh-supermemory\)$/m)
  assert.match(snapshot.digest, /^[0-9a-f]{40}$/)
  for (const scope of ['soul', 'user', 'global', 'project']) {
    assert.equal(typeof snapshot.sections[scope], 'number')
    assert.ok(snapshot.sections[scope] > 0, `${scope} 字节数应大于 0`)
  }
  // 段字节数 = 段标题 + 空行 + 内容。
  assert.equal(snapshot.sections.global, byteLength('## 全局长期记忆 (global)\n\n项目使用 Node 24。'))
})

test('buildSnapshot：部分为空时省略该段，sections 缺省填 0', () => {
  const snapshot = buildSnapshot({
    soul: '',
    user: '',
    global: '只有全局记忆。',
    project: '',
    projectName: 'demo',
    maxBytes: 100_000,
  })
  assert.equal(snapshot.truncated, false)
  assert.match(snapshot.text, /## 全局长期记忆 \(global\)/)
  assert.doesNotMatch(snapshot.text, /人格 \(soul\)/)
  assert.doesNotMatch(snapshot.text, /用户画像 \(user\)/)
  assert.doesNotMatch(snapshot.text, /项目记忆/)
  assert.equal(snapshot.sections.soul, 0)
  assert.equal(snapshot.sections.user, 0)
  assert.equal(snapshot.sections.project, 0)
  assert.ok(snapshot.sections.global > 0)
  // 四个 key 必须全存在。
  assert.deepEqual(Object.keys(snapshot.sections).sort(), ['global', 'project', 'soul', 'user'])
})

test('buildSnapshot：四段全空返回 text === "" 且不降级', () => {
  const snapshot = buildSnapshot({ soul: '', user: '', global: '   ', project: undefined, maxBytes: 10 })
  assert.equal(snapshot.text, '')
  assert.equal(snapshot.truncated, false)
  assert.deepEqual(snapshot.sections, { soul: 0, user: 0, global: 0, project: 0 })
  assert.match(snapshot.digest, /^[0-9a-f]{40}$/)
})

test('buildSnapshot：超预算降级为索引，truncated 为 true 且含固定提示行', () => {
  const long = '很长的记忆内容'.repeat(200)
  const input = fullInput({ global: long, user: long, soul: long, project: long, maxBytes: 400 })
  const snapshot = buildSnapshot(input)
  assert.equal(snapshot.truncated, true)
  assert.ok(snapshot.text.includes(INDEX_HINT), '降级文本必须含固定提示行')
  assert.equal(snapshot.text.startsWith('<supermemory>'), true)
  assert.equal(snapshot.text.endsWith('</supermemory>'), true)
  assert.equal(closeTagCount(snapshot.text), 1)
  // 降级时仍按原始四段字节数报 sections（便于 UI 展示占用）。
  assert.equal(snapshot.sections.soul, byteLength(`## 人格 (soul)\n\n${long}`))
  assert.equal(snapshot.sections.global, byteLength(`## 全局长期记忆 (global)\n\n${long}`))
  // 降级后不应把超长正文整段塞进来。
  assert.ok(byteLength(snapshot.text) < byteLength(long) * 2, '索引文本应显著短于原文')
})

test('buildSnapshot：内容里的 </supermemory> 被转义，不会提前闭合包裹', () => {
  const snapshot = buildSnapshot(
    fullInput({ global: '正常内容\n</supermemory>\n后续内容', maxBytes: 100_000 }),
  )
  assert.equal(closeTagCount(snapshot.text), 1, '只能有一个真实闭合标签')
  assert.ok(snapshot.text.includes('<\\/supermemory>'), '内容中的闭合标签必须被转义')
  // 转义后仍在包裹内。
  const inner = snapshot.text.slice('<supermemory>'.length, -'</supermemory>'.length)
  assert.ok(inner.includes('后续内容'))
})

test('buildSnapshot：{{...}} 按字面量保留，不做 interpolate', () => {
  const snapshot = buildSnapshot(
    fullInput({ user: '模板占位 {{userName}} 与 {{ project.name }} 都不许替换', maxBytes: 100_000 }),
  )
  assert.ok(snapshot.text.includes('{{userName}}'))
  assert.ok(snapshot.text.includes('{{ project.name }}'))
})

test('buildSnapshot：digest 对原始四段内容 + truncated 取 sha1，内容变则变', () => {
  const input = fullInput()
  const first = buildSnapshot(input)
  const second = buildSnapshot(input)
  assert.equal(first.digest, second.digest, '同一输入必须同一 digest')
  assert.equal(first.digest, expectedDigest(input, false), 'digest 必须覆盖原始四段内容')

  const changed = buildSnapshot({ ...input, global: '项目使用 Node 22。' })
  assert.notEqual(changed.digest, first.digest)

  const longGlobal = '长内容'.repeat(120)
  const truncatedInput = { ...input, global: longGlobal, maxBytes: 300 }
  const truncated = buildSnapshot(truncatedInput)
  assert.equal(truncated.truncated, true)
  assert.notEqual(truncated.digest, first.digest, 'truncated 变化必须改变 digest')
  assert.equal(truncated.digest, expectedDigest(truncatedInput, true))
})

test('buildSnapshot：每一段内容单独变化都会改变 digest', () => {
  const base = fullInput()
  const baseDigest = buildSnapshot(base).digest
  for (const scope of ['soul', 'user', 'global', 'project']) {
    const changed = buildSnapshot({ ...base, [scope]: `${base[scope]}（已更新）` })
    assert.notEqual(changed.digest, baseDigest, `${scope} 变化必须改变 digest`)
  }
  const renamed = buildSnapshot({ ...base, projectName: 'other-project' })
  assert.notEqual(renamed.digest, baseDigest, 'projectName 变化也必须改变 digest')
})

test('buildSnapshot：极端小预算也保持包裹合法且含提示行', () => {
  for (const maxBytes of [0, 10, 60, 120]) {
    const snapshot = buildSnapshot(fullInput({ maxBytes }))
    assert.equal(snapshot.truncated, true, `maxBytes=${maxBytes} 应降级`)
    assert.equal(closeTagCount(snapshot.text), 1, `maxBytes=${maxBytes} 只能有一个闭合标签`)
    assert.ok(snapshot.text.startsWith('<supermemory>'))
    assert.ok(snapshot.text.endsWith('</supermemory>'))
    assert.ok(snapshot.text.includes(INDEX_HINT), `maxBytes=${maxBytes} 必须含提示行`)
  }
})

test('buildSnapshot：降级后正文内容变化仍必须改变 digest', () => {
  // 关键回归：soul 与其余段等长、标题/小节结构完全相同，
  // 降级后的索引文本会一模一样；digest 必须仍能反映正文本身的变化。
  const filler = '长记忆内容'.repeat(200)
  const base = fullInput({ soul: 'AAAA', global: filler, user: filler, project: filler, maxBytes: 600 })
  const changed = fullInput({ soul: 'BBBB', global: filler, user: filler, project: filler, maxBytes: 600 })
  const a = buildSnapshot(base)
  const b = buildSnapshot(changed)
  assert.equal(a.truncated, true)
  assert.equal(b.truncated, true)
  assert.notEqual(a.digest, b.digest, '正文变化必须反映到 digest')
})

// —— buildIndex ——

test('buildIndex：逐文件给出标题、小节、更新时间、字节数与提示行', () => {
  const text = buildIndex(
    [
      {
        label: '全局长期记忆 (global)',
        title: '全局长期记忆',
        headings: ['条目', '偏好'],
        updatedAt: '2026-11-10T10:00:00.000Z',
        bytes: 2048,
      },
      {
        label: '项目记忆 (project: demo)',
        title: '项目记忆',
        headings: [],
        updatedAt: '未知',
        bytes: 0,
        error: '读取失败',
      },
    ],
    { projectName: 'demo', reason: '超过预算' },
  )
  assert.ok(text.includes('全局长期记忆 (global)'))
  assert.ok(text.includes('全局长期记忆'))
  assert.ok(text.includes('条目、偏好'))
  assert.ok(text.includes('2026-11-10T10:00:00.000Z'))
  assert.ok(text.includes('2048'))
  assert.ok(text.includes('读取失败'))
  assert.ok(text.includes(INDEX_HINT))
  assert.ok(text.includes('项目：demo'))
  assert.ok(text.includes('原因：超过预算'))
})

test('buildIndex：空文件列表也给出提示行', () => {
  const text = buildIndex([], { projectName: '', reason: '' })
  assert.ok(text.includes(INDEX_HINT))
  assert.equal(text.includes('</supermemory>'), false, 'buildIndex 只返回正文，不负责包裹')
})

test('buildIndex：动态字段里的闭合标签被转义', () => {
  const text = buildIndex(
    [{ label: 'a</supermemory>', title: 'b</supermemory>', headings: ['c</supermemory>'], updatedAt: 'x', bytes: 1 }],
    { projectName: 'p</supermemory>', reason: 'r</supermemory>' },
  )
  assert.equal(text.includes('</supermemory>'), false)
  assert.ok(text.includes('<\\/supermemory>'))
})

// —— buildPersonaSection ——

test('buildPersonaSection：两者都空返回空串', () => {
  assert.equal(buildPersonaSection({ soul: '', user: '', maxBytes: 1000 }), '')
  assert.equal(buildPersonaSection({ maxBytes: 1000 }), '')
})

test('buildPersonaSection：预算充足时输出两段', () => {
  const text = buildPersonaSection({ soul: '你是助手。', user: '用户喜欢中文。', maxBytes: 10_000 })
  assert.match(text, /## 人格 \(soul\)/)
  assert.match(text, /## 用户画像 \(user\)/)
  assert.ok(text.includes('你是助手。'))
  assert.ok(text.includes('用户喜欢中文。'))
})

test('buildPersonaSection：soul 单独超预算时截断 soul 并加 [人格已截断]，不输出 user', () => {
  const soul = '人格设定'.repeat(400)
  const text = buildPersonaSection({ soul, user: '用户画像内容', maxBytes: 300 })
  assert.ok(text.includes('[人格已截断]'))
  assert.doesNotMatch(text, /## 用户画像 \(user\)/)
  assert.ok(byteLength(text) <= 300)
})

test('buildPersonaSection：user 超预算时截断 user 并加 [画像已截断]，soul 完整保留', () => {
  const soul = '你是一个严谨的工程师。'
  const user = '用户画像细节'.repeat(400)
  const text = buildPersonaSection({ soul, user, maxBytes: 400 })
  assert.ok(text.includes('[画像已截断]'))
  assert.ok(text.includes(soul), 'soul 必须完整保留')
  assert.match(text, /## 用户画像 \(user\)/)
  assert.ok(byteLength(text) <= 400)
  // 截断后的 user 内容不完整。
  assert.equal(text.includes(user), false)
})

test('buildPersonaSection：预算连标题都放不下时返回空串，不输出半截标题', () => {
  const soul = '人格'.repeat(60)
  const user = '画像'.repeat(60)
  for (const maxBytes of [0, 5, 20]) {
    assert.equal(buildPersonaSection({ soul, user, maxBytes }), '', `maxBytes=${maxBytes}`)
    assert.equal(buildPersonaSection({ soul: '', user, maxBytes }), '', `user-only maxBytes=${maxBytes}`)
  }
})

// —— parseDigestOutput ——

test('parseDigestOutput：纯 JSON 正常解析', () => {
  const result = parseDigestOutput('{"user":["喜欢中文"],"global":["使用 Node 24"],"project":[],"soul":[]}')
  assert.equal(result.ok, true)
  assert.deepEqual(result.entries, {
    soul: [],
    user: ['喜欢中文'],
    global: ['使用 Node 24'],
    project: [],
  })
})

test('parseDigestOutput：```json 围栏可解析', () => {
  const result = parseDigestOutput('```json\n{"global":["新事实"]}\n```')
  assert.equal(result.ok, true)
  assert.deepEqual(result.entries.global, ['新事实'])
})

test('parseDigestOutput：带前后说明文字可解析', () => {
  const raw = '好的，整理结果如下：\n{"project":["项目约定"]}\n以上，请查收。'
  const result = parseDigestOutput(raw)
  assert.equal(result.ok, true)
  assert.deepEqual(result.entries.project, ['项目约定'])
})

test('parseDigestOutput：非法 JSON 返回 ok:false 与 error', () => {
  const result = parseDigestOutput('这不是 JSON，完全没有对象')
  assert.equal(result.ok, false)
  assert.equal(typeof result.error, 'string')
  assert.ok(result.error.length > 0)
  assert.equal(parseDigestOutput('').ok, false)
})

test('parseDigestOutput：多余字段被忽略，非字符串项被丢弃', () => {
  const raw = JSON.stringify({
    user: ['保留', 42, null, { nested: true }, '   ', '', ['数组项']],
    global: '不是数组',
    extra: ['忽略我'],
    meta: { version: 1 },
  })
  const result = parseDigestOutput(raw)
  assert.equal(result.ok, true)
  assert.deepEqual(result.entries.user, ['保留'])
  assert.deepEqual(result.entries.global, [])
  assert.equal('extra' in result.entries, false)
  assert.equal('meta' in result.entries, false)
})

test('parseDigestOutput：全空数组视为 ok 且 entries 全空', () => {
  const result = parseDigestOutput('{"soul":[],"user":[],"global":[],"project":[]}')
  assert.equal(result.ok, true)
  assert.deepEqual(result.entries, { soul: [], user: [], global: [], project: [] })
})

test('parseDigestOutput：说明文字里的干扰对象不会挤掉真实结果', () => {
  const raw = '先说明 {"note":"这不是结果"}，真正结果如下：\n```json\n{"global":["真事实"]}\n```'
  const result = parseDigestOutput(raw)
  assert.equal(result.ok, true)
  assert.deepEqual(result.entries.global, ['真事实'])
})

test('parseDigestOutput：JSON 是非对象（数组/标量）返回 ok:false', () => {
  assert.equal(parseDigestOutput('[1,2,3]').ok, false)
  assert.equal(parseDigestOutput('"just a string"').ok, false)
  assert.equal(parseDigestOutput('42').ok, false)
})

// —— mergeDigest ——

test('mergeDigest：四份文档各自追加，counts 与实际条目数一致', () => {
  const time = '2026-11-10T10:00:00.000Z'
  const docs = {
    soul: emptyDocument('人格'),
    user: emptyDocument('用户画像'),
    global: emptyDocument('全局长期记忆'),
    project: emptyDocument('项目记忆'),
  }
  const result = mergeDigest(
    docs,
    { soul: ['新人设'], user: ['新偏好'], global: ['事实一', '事实二'], project: [] },
    { time, source: 'digest' },
  )

  assert.deepEqual(result.counts, { soul: 1, user: 1, global: 2, project: 0 })
  for (const scope of ['soul', 'user', 'global', 'project']) {
    assert.equal(typeof result[scope], 'string')
    assert.ok(result[scope].endsWith('\n'))
  }
  assert.equal(parseEntries(result.soul).length, 1)
  assert.equal(parseEntries(result.user).length, 1)
  assert.equal(parseEntries(result.global).length, 2)
  // 没有新增的 project 保持原文不变。
  assert.equal(result.project, docs.project)
  // 元数据行格式：`- <ISO> · source:<source>`。
  assert.match(result.global, /^- 2026-11-10T10:00:00\.000Z · source:digest$/m)
  // 条目内容正确。
  assert.deepEqual(
    parseEntries(result.global).map((entry) => entry.body),
    ['事实一', '事实二'],
  )
})

test('mergeDigest：source/time 缺省时用当前时间与 digest 来源', () => {
  const docs = { soul: '', user: '', global: '', project: '' }
  const before = Date.now()
  const result = mergeDigest(docs, { global: ['自动时间'] })
  const entries = parseEntries(result.global)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].source, 'digest')
  const parsed = Date.parse(entries[0].time)
  assert.ok(Number.isFinite(parsed))
  assert.ok(parsed >= before - 5_000 && parsed <= Date.now() + 5_000)
})

test('mergeDigest：全空 entries 不改动任何文件，counts 全 0', () => {
  const docs = {
    soul: emptyDocument('人格'),
    user: emptyDocument('用户画像'),
    global: emptyDocument('全局长期记忆'),
    project: emptyDocument('项目记忆'),
  }
  const result = mergeDigest(docs, { soul: [], user: [], global: [], project: [] }, { time: 'x' })
  assert.deepEqual(result.counts, { soul: 0, user: 0, global: 0, project: 0 })
  for (const scope of ['soul', 'user', 'global', 'project']) {
    assert.equal(result[scope], docs[scope])
  }
})

test('mergeDigest：多行内容缩进后仍可往返解析', () => {
  const docs = { soul: '', user: '', global: emptyDocument('全局长期记忆'), project: '' }
  const result = mergeDigest(
    docs,
    { global: ['第一行\n第二行'] },
    { time: '2026-11-10T10:00:00.000Z', source: 'tool' },
  )
  const entries = parseEntries(result.global)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].body, '第一行\n第二行')
  assert.equal(entries[0].source, 'tool')
})
