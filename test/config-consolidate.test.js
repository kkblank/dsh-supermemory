/**
 * 整编配置项单测（契约 §V4.0.4）：6 个新键的默认值、非法回退、下限钳制，
 * 以及「老配置文件里完全没有这些键 → 一律默认」这条向后兼容保证。
 *
 * 这 6 项刻意不进面板 / settings.json，所以本文件也守护「面板那三个键不受影响」
 * 与「SETTINGS_KEYS 没被扩大」。
 *
 * 运行：node --test test/config-consolidate.test.js
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { resolveConfig } from '../lib/host/config.js'
import { SETTINGS_KEYS } from '../lib/core/store-normalize.js'

/** 契约 §V4.0.4 表格里这 6 项的默认值，逐字对照。 */
const CONSOLIDATE_DEFAULTS = {
  digestConsolidate: true,
  digestConsolidateMinEntries: 20,
  digestConsolidateMinBytes: 12288,
  digestConsolidateCooldownMs: 21600000,
  digestConsolidateMaxOutputTokens: 6000,
  digestSnapshotKeep: 3,
}

const CONSOLIDATE_KEYS = Object.freeze(Object.keys(CONSOLIDATE_DEFAULTS))

describe('整编配置项：默认值', () => {
  test('空配置 → 6 项全默认', () => {
    for (const [key, value] of Object.entries(CONSOLIDATE_DEFAULTS)) {
      assert.equal(resolveConfig({})[key], value, `${key} 默认值不符契约`)
    }
  })

  test('undefined / null / 非对象 → 6 项仍是默认', () => {
    for (const source of [undefined, null, 'nope', 42, []]) {
      const resolved = resolveConfig(source)
      for (const [key, value] of Object.entries(CONSOLIDATE_DEFAULTS)) {
        assert.equal(resolved[key], value, `${source} 形态下 ${key} 应回退默认`)
      }
    }
  })

  test('配置文件里完全没有这些新键（v3 及更早的旧配置）→ 全部默认', () => {
    const legacy = {
      enabled: true,
      personasRoot: '/tmp/personas',
      projectDirName: '.dsh/memory',
      projectFileName: 'project-memory.md',
      systemPromptMaxBytes: 12000,
      injectMaxBytes: 24000,
      autoDigest: true,
      digestEveryTurns: 5,
      digestPressureRatio: 0.75,
      digestMaxInputBytes: 120000,
      digestMaxOutputTokens: 3000,
      digestWritableScopes: ['project'],
      digestProvider: 'provider-a',
      digestModel: 'model-a',
      injectIntoSubagents: false,
      compactionRecall: true,
    }
    const resolved = resolveConfig(legacy)
    for (const key of CONSOLIDATE_KEYS) assert.equal(resolved[key], CONSOLIDATE_DEFAULTS[key])
    // 老字段一个都不能被新代码带跑。
    assert.equal(resolved.personasRoot, '/tmp/personas')
    assert.equal(resolved.digestModel, 'model-a')
    assert.equal(resolved.compactionRecall, true)
  })

  test('契约下限与默认值自洽：每项默认值都 ≥ 自己的下限', () => {
    const floors = {
      digestConsolidateMinEntries: 1,
      digestConsolidateMinBytes: 1024,
      digestConsolidateCooldownMs: 0,
      digestConsolidateMaxOutputTokens: 256,
      digestSnapshotKeep: 1,
    }
    for (const [key, floor] of Object.entries(floors)) {
      assert.ok(CONSOLIDATE_DEFAULTS[key] >= floor, `${key} 默认值低于下限`)
      assert.ok(Number.isInteger(CONSOLIDATE_DEFAULTS[key]), `${key} 默认值必须是整数`)
    }
  })
})

describe('整编配置项：正常值生效', () => {
  test('6 项都能被显式覆盖', () => {
    const resolved = resolveConfig({
      digestConsolidate: false,
      digestConsolidateMinEntries: 8,
      digestConsolidateMinBytes: 4096,
      digestConsolidateCooldownMs: 60000,
      digestConsolidateMaxOutputTokens: 12000,
      digestSnapshotKeep: 10,
    })
    assert.equal(resolved.digestConsolidate, false)
    assert.equal(resolved.digestConsolidateMinEntries, 8)
    assert.equal(resolved.digestConsolidateMinBytes, 4096)
    assert.equal(resolved.digestConsolidateCooldownMs, 60000)
    assert.equal(resolved.digestConsolidateMaxOutputTokens, 12000)
    assert.equal(resolved.digestSnapshotKeep, 10)
  })

  test('digestConsolidate:false 保留，不被「非布尔回退」规则吃掉', () => {
    assert.equal(resolveConfig({ digestConsolidate: false }).digestConsolidate, false)
    assert.equal(resolveConfig({ digestConsolidate: true }).digestConsolidate, true)
  })

  test('CooldownMs 允许 0（关闭冷却）', () => {
    assert.equal(resolveConfig({ digestConsolidateCooldownMs: 0 }).digestConsolidateCooldownMs, 0)
  })

  test('cordis 的 volatile 包装形态（{ get() }）同样读得到', () => {
    const resolved = resolveConfig({
      digestConsolidate: { get: () => false },
      digestConsolidateMinEntries: { get: () => 40 },
      digestConsolidateMinBytes: { get: () => 32768 },
      digestConsolidateCooldownMs: { get: () => 1000 },
      digestConsolidateMaxOutputTokens: { get: () => 9000 },
      digestSnapshotKeep: { get: () => 7 },
    })
    assert.deepEqual(
      pick(resolved, CONSOLIDATE_KEYS),
      {
        digestConsolidate: false,
        digestConsolidateMinEntries: 40,
        digestConsolidateMinBytes: 32768,
        digestConsolidateCooldownMs: 1000,
        digestConsolidateMaxOutputTokens: 9000,
        digestSnapshotKeep: 7,
      },
    )
  })

  test('取值器抛错 → 回退默认，不冒泡', () => {
    const boom = { get: () => { throw new Error('cordis exploded') } }
    const resolved = resolveConfig({ digestConsolidate: boom, digestSnapshotKeep: boom })
    assert.equal(resolved.digestConsolidate, true)
    assert.equal(resolved.digestSnapshotKeep, 3)
  })
})

describe('整编配置项：非法值回退默认', () => {
  test('布尔项：非布尔一律回退 true', () => {
    for (const bad of ['false', 'true', 0, 1, null, undefined, {}, [], Number.NaN]) {
      assert.equal(resolveConfig({ digestConsolidate: bad }).digestConsolidate, true, `应拒绝：${String(bad)}`)
    }
  })

  test('数值项：NaN / Infinity / 字符串数字 / null / 布尔一律回退默认', () => {
    const sources = {
      digestConsolidateMinEntries: 8,
      digestConsolidateMinBytes: 4096,
      digestConsolidateCooldownMs: 60000,
      digestConsolidateMaxOutputTokens: 1200,
      digestSnapshotKeep: 5,
    }
    for (const key of Object.keys(sources)) {
      const valid = sources[key]
      for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '12', '', true, false, null, undefined, {}, []]) {
        const resolved = resolveConfig({ [key]: bad })
        assert.equal(resolved[key], CONSOLIDATE_DEFAULTS[key], `${key} 收到 ${String(bad)} 应回退默认，而不是接受或变 NaN`)
      }
      // 同一个键的合法值仍可生效，确认回退规则没有把好值一起挡掉。
      assert.equal(resolveConfig({ [key]: valid })[key], valid)
    }
  })

  test('小数取整（沿用既有 digestEveryTurns 的行为）', () => {
    assert.equal(resolveConfig({ digestConsolidateMinEntries: 12.9 }).digestConsolidateMinEntries, 12)
    assert.equal(resolveConfig({ digestConsolidateMinBytes: 20000.9 }).digestConsolidateMinBytes, 20000)
    assert.equal(resolveConfig({ digestConsolidateCooldownMs: 1500.7 }).digestConsolidateCooldownMs, 1500)
    assert.equal(resolveConfig({ digestConsolidateMaxOutputTokens: 5000.5 }).digestConsolidateMaxOutputTokens, 5000)
    assert.equal(resolveConfig({ digestSnapshotKeep: 2.7 }).digestSnapshotKeep, 2)
  })
})

describe('整编配置项：取值下限钳制', () => {
  test('低于下限按下限钳，不是回退默认', () => {
    const floors = {
      digestConsolidateMinEntries: 1,
      digestConsolidateMinBytes: 1024,
      digestConsolidateCooldownMs: 0,
      digestConsolidateMaxOutputTokens: 256,
      digestSnapshotKeep: 1,
    }
    for (const [key, floor] of Object.entries(floors)) {
      for (const bad of [floor - 1, floor - 1000, -1, -3.5]) {
        assert.equal(resolveConfig({ [key]: bad })[key], floor, `${key} 收到 ${bad} 应钳到下限`)
      }
      assert.equal(resolveConfig({ [key]: floor })[key], floor)
    }
  })

  test('小数取下整后仍低于下限 → 按下限钳', () => {
    assert.equal(resolveConfig({ digestSnapshotKeep: 0.9 }).digestSnapshotKeep, 1)
    assert.equal(resolveConfig({ digestConsolidateMinBytes: 1023.5 }).digestConsolidateMinBytes, 1024)
    assert.equal(resolveConfig({ digestConsolidateCooldownMs: -20.5 }).digestConsolidateCooldownMs, 0)
  })

  test('不设上限：超过默认值的大数原样通过', () => {
    assert.equal(resolveConfig({ digestConsolidateMinEntries: 5000 }).digestConsolidateMinEntries, 5000)
    assert.equal(resolveConfig({ digestSnapshotKeep: 999 }).digestSnapshotKeep, 999)
    assert.equal(resolveConfig({ digestConsolidateCooldownMs: 31536000000 }).digestConsolidateCooldownMs, 31536000000)
  })

  test('逐项钳制互不牵连，其余字段仍按默认', () => {
    const resolved = resolveConfig({ digestSnapshotKeep: 0, digestConsolidateMinBytes: 1 })
    assert.equal(resolved.digestSnapshotKeep, 1)
    assert.equal(resolved.digestConsolidateMinBytes, 1024)
    assert.equal(resolved.digestConsolidateMinEntries, 20)
    assert.equal(resolved.digestConsolidateMaxOutputTokens, 6000)
    assert.equal(resolved.digestConsolidate, true)
  })
})

describe('与面板设置互不影响', () => {
  test('只配新键：面板那三个键仍是默认', () => {
    const resolved = resolveConfig({ digestConsolidate: false, digestSnapshotKeep: 9 })
    assert.equal(resolved.enabled, true)
    assert.equal(resolved.digestProvider, '')
    assert.equal(resolved.digestModel, '')
  })

  test('只配面板那三个键：6 个新键仍是默认', () => {
    const resolved = resolveConfig({ enabled: false, digestProvider: 'p', digestModel: 'm' })
    assert.equal(resolved.enabled, false)
    assert.equal(resolved.digestProvider, 'p')
    assert.deepEqual(pick(resolved, CONSOLIDATE_KEYS), CONSOLIDATE_DEFAULTS)
  })

  test('SETTINGS_KEYS 未被扩大：新键不会经 settings.json 生效', () => {
    assert.deepEqual([...SETTINGS_KEYS], ['enabled', 'digestProvider', 'digestModel'])
    for (const key of CONSOLIDATE_KEYS) assert.equal(SETTINGS_KEYS.includes(key), false)
  })

  test('返回对象的键集合就是既有 17 项 + 新 6 项，没有多余键', () => {
    assert.deepEqual(Object.keys(resolveConfig({})), [
      'enabled',
      'personasRoot',
      'presetsRoot',
      'projectDirName',
      'projectFileName',
      'systemPromptMaxBytes',
      'injectMaxBytes',
      'autoDigest',
      'digestEveryTurns',
      'digestPressureRatio',
      'digestMaxInputBytes',
      'digestMaxOutputTokens',
      'digestWritableScopes',
      'digestProvider',
      'digestModel',
      'injectIntoSubagents',
      'compactionRecall',
      ...CONSOLIDATE_KEYS,
    ])
  })

  test('坑位标记：新增配置键必须同步 paths-document.test.js 的全默认断言', () => {
    // `test/paths-document.test.js` 用 deepStrictEqual 对 resolveConfig 的返回值做**全量**比对，
    // 键数一变它就红在**那边**而不是这里。加配置键时的完整改动清单：
    //   1. lib/host/config.js 的 zod `.default()` 与 DEFAULTS 常量（两处必须一致）；
    //   2. test/paths-document.test.js 的 defaults 期望对象；
    //   3. 本文件的 CONSOLIDATE_DEFAULTS / 键集合 / 下面这个总数。
    const keys = Object.keys(resolveConfig({}))
    for (const key of CONSOLIDATE_KEYS) assert.ok(keys.includes(key), `${key} 没进解析结果`)
    assert.equal(keys.length, 23, '配置键总数变了 → 同步 test/paths-document.test.js 的全默认断言')
  })
})

/** 从解析结果里挑出指定键。 */
function pick(resolved, keys) {
  const result = {}
  for (const key of keys) result[key] = resolved[key]
  return result
}
