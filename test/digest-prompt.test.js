/**
 * DIGEST_SYSTEM_PROMPT 防回归单测。
 *
 * 提示词里两类内容都不能被「顺手」改掉：JSON 格式约定 + 那 6 条既有规则是对外契约；
 * 「事实性守则」是项目所有者逐条审定的最高优先级约束。这里一律只断言**关键片段存在**，
 * 不断言整段文本逐字相等——改标点、调排版不该让测试变红。
 *
 * 只依赖 node:test、node:assert/strict 与被测常量，不装任何依赖。
 *
 * @module dsh-supermemory/test/digest-prompt
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { DIGEST_SYSTEM_PROMPT as PROMPT } from '../lib/host/digest-input.js'

/** 守则禁止出现的措辞：提示词自身若用到它们，只能出现在「禁止/不写」的否定句里。 */
const BANNED_WORDS = ['计划', '待办', '下一步', '将来可以', '尚未实现', '原先', '后改为', '已改为', '迁移到', '早期版本']

/** 否定线索：被禁措辞所在行必须同时含其中之一，否则提示词自己违反守则。 */
const NEGATION_HINTS = ['禁止', '不写', '不要写', '别写', '不记录']

/** 断言提示词含某关键片段，并把片段名带进失败信息，便于定位被删的是哪条。 */
function includes(fragment, label) {
  assert.ok(PROMPT.includes(fragment), `提示词缺少${label}：${fragment}`)
}

// —— 对外契约：JSON 格式约定与单键约束 ——

test('提示词：格式串与「只输出 project 一个键」的对外契约仍在', () => {
  includes('{"project":["..."]}', '固定格式串')
  includes('只输出 project 一个键', '单键约束')
  includes('不要输出任何解释', '禁止解释与代码围栏')
  includes('不要输出 soul / user / global', 'soul/user/global 永不写入')
})

// —— 对外契约：既有 6 条规则的关键约束 ——

test('提示词：既有 6 条规则的关键约束逐条仍在', () => {
  includes('规则：', '规则小节标题')
  includes('每条一句话', '一句话规则')
  includes('只写新增事实', '不重复现有记忆规则')
  includes('只与当前项目相关', 'project 范围规则')
  includes('没有新增内容就输出 {"project":[]}', '空数组规则')
  includes('不要臆造', '禁止臆造')
  includes('忽略寒暄', '忽略寒暄规则')
  includes('宿主注入的快照消息', '忽略宿主快照规则')
})

// —— 事实性守则 ——

test('提示词：事实性守则小节存在且位于既有规则之后', () => {
  includes('## 事实性守则', '守则小节标题')
  includes('最高优先级', '守则优先级')
  includes('记忆只描述「此刻为真的状态」', '守则总纲')
  assert.ok(
    PROMPT.indexOf('## 事实性守则') > PROMPT.indexOf('规则：'),
    '守则必须排在既有规则之后',
  )
})

test('提示词：守则覆盖现在时、变更史、未来规划、避坑因果与一年后标准', () => {
  includes('用现在时陈述当前状态', '现在时要求')
  includes('禁止记录记忆自身的变更史', '禁止变更史')
  // 变更史的示例词至少要能命中，防止条文被抽象化到无法执行。
  assert.ok(
    PROMPT.includes('已从') || PROMPT.includes('后改为'),
    '禁止变更史必须带「已从 / 后改为」这类具体示例词',
  )
  includes('禁止记录未来规划', '禁止未来规划')
  includes('只写已经成立的事实', '未来规划条文的正向要求')
  includes('允许写原因', '允许写因果的前提')
  includes('避坑', '允许避坑因果')
  includes('一年后', '一年后仍成立的判断标准')
  includes('与「现有记忆」冲突时', '冲突处理条文')
  includes('尽量少写冲突条目', '追加模式下的克制要求')
})

test('提示词：守则的 6 个编号条目齐全且各占一行', () => {
  for (let n = 1; n <= 6; n += 1) {
    assert.match(PROMPT, new RegExp(`^${n}\\. `, 'm'), `守则缺少第 ${n} 条`)
  }
  // 守则从总纲到最后一条连续成段，中间不该被别的段落插进来。
  const block = PROMPT.slice(PROMPT.indexOf('## 事实性守则'))
  assert.match(block, /^## 事实性守则（最高优先级）\n记忆只描述/m)
})

// —— 提示词自身不得违反守则 ——

test('提示词：被禁措辞只出现在否定句里，不自相矛盾', () => {
  for (const line of PROMPT.split('\n')) {
    const hit = BANNED_WORDS.filter((word) => line.includes(word))
    if (hit.length === 0) continue
    assert.ok(
      NEGATION_HINTS.some((hint) => line.includes(hint)),
      `该行把被禁措辞写成了正面表述（${hit.join('、')}）：${line}`,
    )
  }
})
