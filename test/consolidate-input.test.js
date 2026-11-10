/**
 * 整编模式的提示词与输入预算单测（契约 §V4.0.3）。
 *
 * 这里守的是三条最容易被「顺手优化」掉的东西：
 * 1. **project 正文永不截断**——截断等于让模型照着残缺稿重写，被切掉的条目会永久消失；
 * 2. 超预算时**只能丢对话**，丢到 0 条仍装不下就放弃本轮（INPUT_OVERFLOW）；
 * 3. 整编提示词与追加提示词**同源共用**那 6 条事实性守则，两处文案不许各漂各的。
 *
 * 依赖说明：`[id]` 前缀相关的用例读取 `parseEntries` 返回的 `id` 字段（契约 §V4.0.1，
 * 由 `lib/core/document.js` 实现）。该字段落地前这些用例会红，落地后无需改动本文件即转绿。
 *
 * 只依赖 node:test、node:assert/strict 与项目内纯函数，不装任何依赖。
 *
 * @module dsh-supermemory/test/consolidate-input
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { appendEntries, byteLength, emptyDocument, parseEntries } from '../lib/core/document.js'
import {
  CONSOLIDATE_SYSTEM_PROMPT as PROMPT,
  DIGEST_SYSTEM_PROMPT,
  buildConsolidateInput,
  buildDigestInput,
  emptyDocs,
} from '../lib/host/digest-input.js'

/** 守则禁止出现的措辞：提示词若用到，只能出现在「禁止/不写」的否定句里。 */
const BANNED_WORDS = ['计划', '待办', '下一步', '将来可以', '尚未实现', '原先', '后改为', '已改为', '迁移到', '早期版本']

/** 否定线索：被禁措辞所在行必须同时含其中之一，否则提示词自己违反守则。 */
const NEGATION_HINTS = ['禁止', '不写', '不要写', '别写', '不记录']

/** 条目时间戳（固定值，避免用例随时间漂移）。 */
const TIME = '2026-11-10T10:00:00.000Z'

/** 造一份带 n 条目的 project 文档。 */
function makeProject(count, bodyOf) {
  let text = emptyDocument('项目记忆')
  for (let i = 0; i < count; i += 1) {
    text = appendEntries(text, [{ time: TIME, source: 'test', body: bodyOf(i) }])
  }
  return text
}

/** 造 n 条填充对话。 */
function makeTranscript(count) {
  return Array.from({ length: count }, (_, i) => `user: 临时对话消息 ${i} ${'补充说明文字。'.repeat(30)}`)
}

// —— 整编提示词：输出契约 ——

test('整编提示词：只要求 §V4.0.2 的 JSON 格式串与两个键', () => {
  assert.ok(PROMPT.includes('{"entries":[{"text":"…","from":["a3f2c"]}],"drop":[{"id":"b8e01","reason":"…"}]}'), '缺少固定格式串')
  assert.ok(PROMPT.includes('不要输出任何解释'), '缺少禁止解释与代码围栏')
  assert.ok(PROMPT.includes('不要输出 soul / user / global'), '缺少 soul/user/global 永不写入')
  assert.ok(!PROMPT.includes('```'), '提示词自身不得出现代码围栏')
})

test('整编提示词：产物是目标态整份清单而非增量（最关键语义）', () => {
  assert.ok(PROMPT.includes('整份目标态清单'), '缺少「目标态整份清单」')
  assert.ok(PROMPT.includes('不是增量'), '缺少「不是增量」')
  assert.ok(PROMPT.includes('独立可读的完整条目'), '缺少「合并结果要写全」')
  assert.ok(PROMPT.includes('不要只写它与旧条目的差别'), '缺少「不要只写差异」')
})

test('整编提示词：未提及条目原样保留与 drop 门槛、动作顺序都在', () => {
  assert.ok(PROMPT.includes('会被系统原文原样保留'), '缺少「未提及条目会被原样保留」')
  assert.ok(PROMPT.includes('没写不等于删除'), '缺少「没写不等于删除」')
  assert.ok(PROMPT.includes('不确定该不该留的条目就别写它'), '缺少「不确定就别动」')
  assert.ok(PROMPT.includes('`reason` 必填'), '缺少 drop 的 reason 必填')
  assert.ok(PROMPT.includes('事实已经失效、且没有任何新说法可以替代'), '缺少 drop 的适用门槛')
  assert.ok(PROMPT.includes('动作顺序'), '缺少优先动作顺序')
  assert.ok(
    PROMPT.indexOf('先把说同一件事的条目合并成一条') < PROMPT.indexOf('最后才考虑 `drop`'),
    '动作顺序必须是先合并、最后才 drop',
  )
})

test('整编提示词：from 的用法与「改写也算取代」讲清了', () => {
  assert.ok(PROMPT.includes('吸收或取代了哪些现有条目'), '缺少 from 的定义')
  assert.ok(PROMPT.includes('全新事实'), '缺少全新事实 from 留空')
  assert.ok(PROMPT.includes('空数组'), '缺少 from 用空数组的写法')
  assert.ok(PROMPT.includes('改写也算取代'), '缺少「改写也算取代」')
  assert.ok(PROMPT.includes('会变成两条重复条目'), '缺少漏写 from 的后果说明')
  assert.ok(PROMPT.includes('同一个 id 只写进一条新条目的 `from`'), '缺少 id 不得重复引用')
})

test('整编提示词：id 示例是真实 hex 形态，不用误导性占位符', () => {
  assert.match(PROMPT, /\b[0-9a-f]{5}\b/, '应给出 5 位十六进制的 id 示例')
  assert.ok(PROMPT.includes('a3f2c'), '缺少形如 a3f2c 的示例 id')
  for (const placeholder of ['id1', 'id2', 'xxx', 'XXX', '<id>', 'ABC123']) {
    assert.ok(!PROMPT.includes(placeholder), `不该出现占位符 ${placeholder}`)
  }
})

test('整编提示词：不臆造、不把对话临时状态写进记忆、无活可干就交空数组', () => {
  assert.ok(PROMPT.includes('不许臆造'), '缺少禁止臆造')
  assert.ok(PROMPT.includes('临时状态'), '缺少「不写对话里的临时状态」')
  assert.ok(PROMPT.includes('寒暄'), '缺少忽略寒暄')
  assert.ok(PROMPT.includes('{"entries":[],"drop":[]}'), '缺少空数组出口')
  assert.ok(PROMPT.includes('宁可少改'), '缺少「宁可少改，不要制造变更」')
})

// —— 整编提示词：事实性守则 ——

test('整编提示词：6 条守则编号齐全且各占一行', () => {
  assert.ok(PROMPT.includes('## 事实性守则'), '缺少守则小节')
  assert.ok(PROMPT.includes('最高优先级'), '缺少守则优先级')
  assert.ok(PROMPT.includes('记忆只描述「此刻为真的状态」'), '缺少守则总纲')
  for (let n = 1; n <= 6; n += 1) {
    assert.match(PROMPT, new RegExp(`^${n}\\. `, 'm'), `守则缺少第 ${n} 条`)
  }
  assert.match(PROMPT, /^## 事实性守则（最高优先级）\n记忆只描述/m)
})

test('整编提示词：守则与追加模式逐字同源，不各写一份', () => {
  const block = (text) => text.slice(text.indexOf('## 事实性守则'))
  assert.ok(DIGEST_SYSTEM_PROMPT.includes('## 事实性守则'), '追加模式守则被挪走了')
  assert.equal(block(PROMPT), block(DIGEST_SYSTEM_PROMPT), '两个提示词的守则文本必须逐字一致')
})

test('整编提示词：自身不把被禁措辞写成正面表述', () => {
  for (const line of PROMPT.split('\n')) {
    const hit = BANNED_WORDS.filter((word) => line.includes(word))
    if (hit.length === 0) continue
    assert.ok(
      NEGATION_HINTS.some((hint) => line.includes(hint)),
      `该行把被禁措辞写成了正面表述（${hit.join('、')}）：${line}`,
    )
  }
})

test('整编提示词：压住过度删除的那两句单独钉死，删掉或弱化都要红', () => {
  // 追加模式最坏只是多写一条冲突条目（代价是可读性），整编最坏是删掉有效记忆（代价是数据），
  // 所以整编侧的克制要求要单独钉：将来谁「优化」提示词把下面任何一句删了或改成含糊表述，
  // 这条用例必须红，而不是靠那句安全网悄悄消失。断言取整句原文，弱化措辞同样会红。
  assert.ok(
    PROMPT.includes('- **既没出现在任何 `from`、也没出现在 `drop` 里的现有条目，会被系统原文原样保留。**'),
    '缺少「未提及条目会被原文原样保留」整句（压住过度删除的关键指令）',
  )
  assert.ok(PROMPT.includes('没写不等于删除'), '缺少「没写进 from 也没写进 drop 不等于删除」这层意思')
  assert.ok(PROMPT.includes('不动它就是正确答案'), '缺少「不确定就别动」的退让指令')
  // 反向核对：整编不许把新旧两种说法并存，否则「少删」会变成「留着矛盾」。
  assert.ok(PROMPT.includes('不要把新旧两种说法各写一条留着矛盾'), '缺少守则第 5 条对整编的落点')
})

// —— 整编输入：id 前缀（依赖契约 §V4.0.1 的 parseEntries().id） ——

test('整编输入：每条 project 条目带 [id] 前缀且与 parseEntries 的 id 一致', () => {
  const project = makeProject(4, (i) => `项目事实第 ${i} 条`)
  const entries = parseEntries(project)
  assert.equal(entries.length, 4)
  const result = buildConsolidateInput({ ...emptyDocs(), project }, [], 120000)
  assert.equal(result.ok, true, '预算充足时应返回 ok')
  for (const entry of entries) {
    assert.match(result.input, new RegExp(`^\\[${entry.id}\\] `, 'm'), `条目缺少 [${entry.id}] 行首前缀`)
    assert.ok(result.input.includes(`${entry.id}] ${entry.body}`), `前缀后紧跟的正文不对：${entry.body}`)
  }
})

test('整编输入：正文单行的条目各占一行，行数与条目数相符', () => {
  const project = makeProject(5, (i) => `单行事实 ${i}`)
  const entries = parseEntries(project)
  const result = buildConsolidateInput({ ...emptyDocs(), project }, [], 120000)
  assert.equal(result.ok, true)
  for (const entry of entries) {
    assert.ok(result.input.includes(` ${entry.body}\n`) || result.input.endsWith(` ${entry.body}`), `正文所在行不完整：${entry.body}`)
  }
})

// —— 整编输入：project 正文永不截断 ——

test('整编输入：project 超长时正文逐条完整，只丢对话', () => {
  const project = makeProject(12, (i) => `第 ${i} 条 ${'项目当前结构与边界说明，读到这句说明正文未被截断。'.repeat(6)}`)
  const lines = makeTranscript(40)
  const entries = parseEntries(project)
  const budget = byteLength(project) + 4000
  const result = buildConsolidateInput({ ...emptyDocs(), project }, lines, budget)

  assert.equal(result.ok, true, '装得下时应成功，且只靠丢对话解决')
  assert.ok(byteLength(result.input) <= budget, `输入 ${byteLength(result.input)} 超出预算 ${budget}`)
  for (const entry of entries) {
    assert.ok(result.input.includes(entry.body), `project 正文被截断了：${entry.body.slice(0, 24)}…`)
  }
  assert.ok(!result.input.includes('[前文已截断]'), 'project 与参考记忆都不该出现截断标记')
  assert.ok(result.input.includes(lines[lines.length - 1]), '最新对话应保留')
  assert.ok(!result.input.includes(lines[0]), '应从最旧的对话开始丢')
})

test('整编输入：丢光对话仍超预算返回 INPUT_OVERFLOW，绝不截断 project', () => {
  const project = makeProject(12, (i) => `第 ${i} 条 ${'这段内容把整份 project 顶到任何预算之上。'.repeat(200)}`)
  const result = buildConsolidateInput({ ...emptyDocs(), project }, makeTranscript(20), 4096)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'INPUT_OVERFLOW')
})

test('整编输入：project 单独就超预算时同样溢出，不回退成残缺稿', () => {
  const project = makeProject(3, () => '很长的单条记忆。'.repeat(600))
  const result = buildConsolidateInput({ ...emptyDocs(), project }, [], 2048)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'INPUT_OVERFLOW')
})

// —— 整编输入：三份参考记忆可截断 ——

test('整编输入：soul/user/global 可截断且标注不属于整理范围，project 不受影响', () => {
  const project = makeProject(6, (i) => `项目事实 ${i}`)
  const docs = { soul: 's'.repeat(20000), user: 'u'.repeat(20000), global: 'g'.repeat(20000), project }
  const result = buildConsolidateInput(docs, ['user: 对话一', 'assistant: 对话二'], 6000)

  assert.equal(result.ok, true, '丢完对话再压参考记忆就该装得下')
  assert.ok(byteLength(result.input) <= 6000)
  assert.match(result.input, /不属于本次整理范围/, '参考记忆区要标注不属于本次整理范围')
  assert.equal(result.input.split('[前文已截断]').length - 1, 3, '三份参考记忆各截一次')
  for (const entry of parseEntries(project)) {
    assert.ok(result.input.includes(entry.body), `project 正文受牵连被截断：${entry.body}`)
  }
})

test('整编输入：参考记忆为空时渲染成 (空) 且不影响 project', () => {
  const project = makeProject(2, (i) => `事实 ${i}`)
  const result = buildConsolidateInput({ ...emptyDocs(), project }, [], 120000)
  assert.equal(result.ok, true)
  for (const label of ['### 人格 soul', '### 用户画像 user', '### 全局长期记忆 global']) {
    assert.ok(result.input.includes(label), `缺少参考记忆小节 ${label}`)
  }
  assert.ok(result.input.includes('### 人格 soul\n(空)'), '空参考记忆应渲染成 (空)')
  assert.ok(result.input.includes('## 最近的对话'), '缺少对话区（无对话时应写 (无)）')
})

// —— 整编输入：NO_PROJECT ——

test('整编输入：project 无条目（空串 / 模板骨架 / 非字符串）一律 NO_PROJECT', () => {
  const cases = [
    ['空串', ''],
    ['模板骨架', emptyDocument('项目记忆')],
    ['只有前言没有条目', '# 项目记忆\n\n<!-- 手工写的说明段 -->\n\n## 条目\n'],
    ['非字符串', 42],
    ['undefined', undefined],
  ]
  for (const [label, project] of cases) {
    const result = buildConsolidateInput({ ...emptyDocs(), project }, ['user: 有对话也不该救场'], 120000)
    assert.deepEqual(result, { ok: false, reason: 'NO_PROJECT' }, `${label} 应判 NO_PROJECT`)
  }
})

test('整编输入：docs 缺失或对话形状异常都不抛', () => {
  assert.deepEqual(buildConsolidateInput(undefined, [], 120000), { ok: false, reason: 'NO_PROJECT' })
  const project = makeProject(2, (i) => `事实 ${i}`)
  const bad = buildConsolidateInput({ ...emptyDocs(), project }, undefined, 120000)
  assert.equal(bad.ok, true, '对话缺失按 0 条处理')
  assert.ok(bad.input.includes('(无)'))
  const badLimit = buildConsolidateInput({ ...emptyDocs(), project }, [], 0)
  assert.equal(badLimit.ok, true, '非法预算回退默认值')
})

// —— 输入构造的纯度 ——

test('整编输入：不改动传入的 docs 与对话数组', () => {
  const project = makeProject(3, (i) => `事实 ${i}`)
  const docs = { soul: 's'.repeat(9000), user: 'u'.repeat(9000), global: 'g'.repeat(9000), project }
  const docsSnapshot = { ...docs }
  const lines = makeTranscript(30)
  const linesSnapshot = [...lines]

  buildConsolidateInput(docs, lines, 512)
  assert.deepEqual(docs, docsSnapshot, 'docs 被就地改写了')
  assert.deepEqual(lines, linesSnapshot, '对话数组被就地改写了')
})

// —— 追加模式回归 ——

test('追加模式输入行为不变：返回字符串、超预算会截断文件内容尾部', () => {
  const docs = {
    soul: 's'.repeat(5000),
    user: 'u'.repeat(5000),
    global: 'g'.repeat(5000),
    project: makeProject(8, (i) => `项目事实 ${i}`),
  }
  const out = buildDigestInput(makeTranscript(20), docs, 4000)
  assert.equal(typeof out, 'string', '追加模式仍返回字符串')
  assert.ok(out.includes('## 现有记忆（不要重复这些内容）'), '追加模式的区标题变了')
  assert.ok(out.includes('[前文已截断]'), '追加模式的第二级截断降级被改掉了')
  assert.ok(byteLength(out) <= 4000 + 2048 * 4, '截断后应回到预算量级')

  const small = buildDigestInput(['user: 一句话'], { ...emptyDocs(), project: '项目事实 A' }, 120000)
  assert.ok(small.includes('项目事实 A'), '预算内的追加模式输入不该被动过')
  assert.ok(small.includes('user: 一句话'), '对话应原样带上')
})
