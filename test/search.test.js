/**
 * 检索层单测：lib/core/search.js 的 queryTerms / scoredLines / literalLines。
 *
 * 运行：node --test test/search.test.js
 * （tools 层的 search 端到端行为在 host-install.test.js 的全链路用例里覆盖。）
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { MAX_QUERY_TERMS, literalLines, queryTerms, scoredLines } from '../lib/core/search.js'

/** 一段符合 core/document.js 格式的真实形状样本：前言块 + 三条条目。 */
const SAMPLE = [
  '# 全局长期记忆',
  '',
  '<!-- 由 dsh-supermemory 维护；可直接编辑。 -->',
  '',
  '## 条目',
  '',
  '- 2026-11-10T10:00:00.000Z · source:user-request',
  '  用户使用 conda 管理 Python 虚拟环境，不希望自行新建环境。',
  '  工具调用要求使用绝对路径。',
  '',
  '- 2026-11-10T10:01:00.000Z · source:tool-沉淀-v3-总开关的设计决策',
  '  v3 插件总开关存在 settings.json 的 enabled 布尔键。',
  '  门控铁律：一律写 deps.isEnabled?.() === false 才拦截。',
  '',
  '- 2026-11-10T10:02:00.000Z · source:user-request',
  '  生产环境机器不得先改后报。',
].join('\n')

/** 把命中行折成 `行号` 数组，方便断言顺序。 */
const lines = (rows) => rows.map((row) => row.line)

describe('queryTerms 分词', () => {
  test('纯英文：按词切开并转小写', () => {
    assert.deepEqual(queryTerms('conda env'), ['conda', 'env'])
    assert.deepEqual(queryTerms('PNPM'), ['pnpm'])
  })

  test('连字符与下划线词元整体保留', () => {
    assert.deepEqual(queryTerms('digest_every-turns'), ['digest_every-turns'])
  })

  test('纯中文：整串 + 相邻二元组', () => {
    assert.deepEqual(queryTerms('虚拟环境'), ['虚拟环境', '虚拟', '拟环', '环境'])
  })

  test('中英混合：各自成词，汉字段只在本段内产二元组', () => {
    assert.deepEqual(queryTerms('conda 虚拟环境'), ['conda', '虚拟环境', '虚拟', '拟环', '环境'])
  })

  test('长度 <= 1 的词元丢弃（单字、单字母、孤立符号）', () => {
    assert.deepEqual(queryTerms('a 图 -'), [])
    assert.deepEqual(queryTerms('conda'), ['conda'])
  })

  test('全角经 NFKC 折叠成半角', () => {
    assert.deepEqual(queryTerms('ＣＯＮＤＡ'), ['conda'])
  })

  test('词元总数截到 MAX_QUERY_TERMS', () => {
    const long = Array.from({ length: 100 }, (_, i) => String.fromCharCode(0x4e00 + i)).join('')
    const terms = queryTerms(long)
    assert.equal(terms.length, MAX_QUERY_TERMS)
    assert.ok(terms.includes(long.slice(0, 2)), '截断保留的应是查询前部的词元')
  })

  test('空/非字符串查询返回空数组', () => {
    assert.deepEqual(queryTerms(''), [])
    assert.deepEqual(queryTerms('   '), [])
    assert.deepEqual(queryTerms(undefined), [])
    assert.deepEqual(queryTerms(null), [])
    assert.deepEqual(queryTerms(42), [])
  })
})

describe('scoredLines 加权打分', () => {
  test('整串子串命中：与升级前等价的基本能力仍在', () => {
    const rows = scoredLines(SAMPLE, queryTerms('conda'))
    assert.equal(rows.length, 1)
    assert.equal(rows[0].line, 8)
    assert.match(rows[0].text, /conda/)
  })

  test('中文二元组命中未整串出现的查询（升级前搜不到）', () => {
    // 文档里只写了「虚拟环境」，查询是「虚拟环境配置」，整串 substring 必然落空。
    const rows = scoredLines(SAMPLE, queryTerms('虚拟环境配置'))
    assert.ok(rows.length >= 1, '应通过 虚拟/拟环/环境 二元组命中')
    assert.equal(rows[0].line, 8)
  })

  test('标题行权重高于正文行，排在前面', () => {
    const doc = ['# 生产环境规范', '', '## 条目', '', '- 2026-01-01T00:00:00.000Z · source:t', '  生产环境不得先改后报。'].join('\n')
    const rows = scoredLines(doc, queryTerms('生产环境'))
    assert.ok(rows.length >= 2)
    assert.equal(rows[0].line, 1, '标题行应排第一')
    assert.ok(rows[0].score > rows[rows.length - 1].score, '标题行分数应高于正文行')
  })

  test('同一条目跨行命中的词元按块聚合，整条都浮上来', () => {
    const doc = [
      '## 条目',
      '',
      '- 2026-01-01T00:00:00.000Z · source:t',
      '  绝对路径写在配置里。',
      '  虚拟环境复用现成的 conda。',
    ].join('\n')
    const rows = scoredLines(doc, queryTerms('绝对路径虚拟环境'))
    assert.deepEqual(lines(rows), [4, 5], '两行正文都该浮上来，条目头行自身不含词元则不出现')
    assert.ok(rows[0].score > rows[1].score, '条目首行权重高于续行')
  })

  test('只沾到单个二元组的噪音条目被门槛刷掉', () => {
    const doc = [
      '## 条目',
      '',
      '- 2026-01-01T00:00:00.000Z · source:full',
      '  优先复用现成的 conda 虚拟环境。',
      '',
      '- 2026-01-01T00:00:01.000Z · source:noise',
      '  今天天气不错，适合出门散步。',
      '  顺带提一句环境变量。',
    ].join('\n')
    const rows = scoredLines(doc, queryTerms('虚拟环境配置'))
    assert.deepEqual(lines(rows), [4], '只命中「环境」的噪音条目不该出现')
  })

  test('单词元查询门槛降为 1', () => {
    const doc = ['## 条目', '', '- 2026-01-01T00:00:00.000Z · source:t', '  只有一个词 pnpm 在这里。'].join('\n')
    const rows = scoredLines(doc, queryTerms('pnpm'))
    assert.equal(rows.length, 1)
    assert.equal(rows[0].line, 4)
  })

  test('命中行按分数降序，limit 截断保留最高分', () => {
    const doc = [
      '## 条目',
      '',
      '- 2026-01-01T00:00:00.000Z · source:t',
      '  隔离级别说明。',
      '',
      '- 2026-01-01T00:00:01.000Z · source:t2',
      '  隔离级别的完整设计：人设隔离与项目隔离互不影响，隔离粒度按项目根走。',
    ].join('\n')
    const terms = queryTerms('隔离级别设计')
    const all = scoredLines(doc, terms)
    const top = scoredLines(doc, terms, 1)
    assert.equal(top.length, 1)
    assert.equal(top[0].line, all[0].line, 'limit 保留的应是全局最高分行')
    assert.ok(all[0].score >= all[all.length - 1].score)
  })

  test('无命中返回空数组', () => {
    assert.deepEqual(scoredLines(SAMPLE, queryTerms('绝对不存在的词')), [])
  })

  test('空词元数组返回空数组，不吃内容', () => {
    assert.deepEqual(scoredLines(SAMPLE, []), [])
    assert.deepEqual(scoredLines(SAMPLE, undefined), [])
  })

  test('非字符串内容与非字符串内容不抛异常', () => {
    assert.deepEqual(scoredLines(undefined, queryTerms('conda')), [])
    assert.deepEqual(scoredLines(123, queryTerms('conda')), [])
  })

  test('CRLF 与 CR 换行都能按行定位', () => {
    const doc = '# 标题\r\n\r\n- 2026-01-01T00:00:00.000Z · source:t\r\n  绝对路径要求\r'
    const rows = scoredLines(doc, queryTerms('绝对路径'))
    assert.ok(rows.some((row) => row.line === 4))
  })

  test('命中行文本折掉缩进并截断到 400 字符', () => {
    const long = `  ${'啊'.repeat(500)}`
    const doc = ['## 条目', '', '- 2026-01-01T00:00:00.000Z · source:t', long].join('\n')
    const rows = scoredLines(doc, queryTerms('啊啊'))
    assert.equal(rows[0].text.length, 400)
    assert.equal(rows[0].text.startsWith(' '), false)
  })

  test('行号从 1 起且对应原文行', () => {
    const rows = scoredLines(SAMPLE, queryTerms('门控铁律'))
    assert.equal(rows.length, 1)
    assert.equal(SAMPLE.split('\n')[rows[0].line - 1].includes('门控铁律'), true)
  })
})

describe('literalLines 子串兜底', () => {
  test('单字查询仍能命中（queryTerms 切不出词元时的退路）', () => {
    const doc = ['# 图形算法', '', '## 条目', '', '  图像深度学习方向。']
    const rows = literalLines(doc.join('\n'), '图')
    assert.deepEqual(lines(rows), [1, 5])
    assert.equal(rows[0].score, 1, '兜底路径不参与加权')
  })

  test('大小写不敏感', () => {
    const rows = literalLines(SAMPLE, 'PNPM')
    assert.deepEqual(rows, [])
    assert.equal(literalLines('项目使用 pnpm。', 'PNPM').length, 1)
  })

  test('空 needle 返回空数组', () => {
    assert.deepEqual(literalLines(SAMPLE, ''), [])
    assert.deepEqual(literalLines(SAMPLE, undefined), [])
  })

  test('limit 生效且不改动命中行为', () => {
    const doc = ['图一', '图二', '图三'].join('\n')
    assert.deepEqual(lines(literalLines(doc, '图', 2)), [1, 2])
  })

  test('单字查询端到端串起来：queryTerms 空 → 走 literalLines', () => {
    const terms = queryTerms('图')
    assert.deepEqual(terms, [])
    assert.equal(literalLines(SAMPLE, '图').length, 0)
    assert.ok(literalLines('# 图形算法', '图').length === 1)
  })
})
