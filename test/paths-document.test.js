/**
 * A1 单测：paths / document / config（契约 §10 第一组）。
 *
 * 运行：node --test test/paths-document.test.js
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { resolveConfig, resolvePersonasRoot, resolvePresetsRoot } from '../lib/host/config.js'
import {
  SafeJoinError,
  personaSlug,
  presetSlug,
  projectDisplayName,
  resolveProjectRoot,
  safeJoin,
} from '../lib/core/paths.js'
import {
  appendEntries,
  byteLength,
  documentTitle,
  emptyDocument,
  parseEntries,
  renderEntry,
} from '../lib/core/document.js'

/** 临时目录，after 里清理。 */
let scratch

before(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'supermemory-paths-'))
})

after(async () => {
  await rm(scratch, { recursive: true, force: true })
})

describe('presetSlug', () => {
  test('普通 id 原样保留', () => {
    assert.equal(presetSlug('default'), 'default')
    assert.equal(presetSlug('my-preset_2.0'), 'my-preset_2.0')
  })

  test('含 : / 空格 → 逐字符替换为 -', () => {
    assert.equal(presetSlug('foo:bar'), 'foo-bar')
    assert.equal(presetSlug('a/b'), 'a-b')
    assert.equal(presetSlug('my preset'), 'my-preset')
    assert.equal(presetSlug('../../etc/passwd'), '..-..-etc-passwd')
  })

  test('空串 → default', () => {
    assert.equal(presetSlug(''), 'default')
  })

  test('全非法字符 → default（中文现在合法，见 personaSlug）', () => {
    assert.equal(presetSlug('***'), 'default')
    assert.equal(presetSlug('/'), 'default')
    assert.equal(personaSlug('中文'), '中文')
  })

  test('非字符串 → default', () => {
    assert.equal(presetSlug(undefined), 'default')
    assert.equal(presetSlug(null), 'default')
    assert.equal(presetSlug(42), 'default')
  })

  test('slug 不会是 . 或 ..', () => {
    assert.equal(presetSlug('.'), 'default')
    assert.equal(presetSlug('..'), 'default')
  })
})

describe('personaSlug', () => {
  test('普通名字原样保留', () => {
    assert.equal(personaSlug('default'), 'default')
    assert.equal(personaSlug('My-Persona_2.0'), 'My-Persona_2.0')
  })

  test('含非法字符 → 逐字符替换为 -', () => {
    assert.equal(personaSlug('foo/bar'), 'foo-bar')
    assert.equal(personaSlug('my persona'), 'my-persona')
    assert.equal(personaSlug('../../etc/passwd'), '..-..-etc-passwd')
  })

  test('空串 / 全非法字符 / 非字符串 → default', () => {
    assert.equal(personaSlug(''), 'default')
    assert.equal(personaSlug('***'), 'default')
    assert.equal(personaSlug('/'), 'default')
    assert.equal(personaSlug(undefined), 'default')
    assert.equal(personaSlug(null), 'default')
    assert.equal(personaSlug(42), 'default')
  })

  test('slug 不会是 . 或 ..', () => {
    assert.equal(personaSlug('.'), 'default')
    assert.equal(personaSlug('..'), 'default')
  })

  test('中文名保留为目录名（否则所有人设都会挤到 default）', () => {
    assert.equal(personaSlug('我的助手'), '我的助手')
    assert.equal(personaSlug('工作助手'), '工作助手')
    assert.equal(personaSlug('工作 助手'), '工作-助手')
    assert.equal(personaSlug('工作:助手'), '工作-助手')
    assert.notEqual(personaSlug('工作'), personaSlug('生活'))
  })

  test('slug 有长度上限且不残留首尾连字符', () => {
    const long = personaSlug('很长的人设名'.repeat(20))
    assert.ok([...long].length <= 48, `slug 过长: ${long.length}`)
    assert.ok(!long.startsWith('-') && !long.endsWith('-'))
  })

  test('presetSlug 是 personaSlug 的别名（同一行为）', () => {
    for (const input of ['default', 'foo:bar', '', '***', '..', '../../etc/passwd']) {
      assert.equal(presetSlug(input), personaSlug(input))
    }
    assert.equal(presetSlug, personaSlug)
  })
})

describe('projectDisplayName', () => {
  test('取 basename', () => {
    assert.equal(projectDisplayName('/home/user/project'), 'project')
    assert.equal(projectDisplayName('/home/user/project/'), 'project')
  })

  test('非法输入 → 空串', () => {
    assert.equal(projectDisplayName(''), '')
    assert.equal(projectDisplayName(undefined), '')
  })
})

describe('resolveProjectRoot', () => {
  test('找到含 .git 的目录', async () => {
    const root = join(scratch, 'with-git')
    const nested = join(root, 'a', 'b')
    await mkdir(join(root, '.git'), { recursive: true })
    await mkdir(nested, { recursive: true })
    const { root: found, reason } = await resolveProjectRoot(nested)
    assert.equal(found, root)
    assert.equal(reason, 'marker')
  })

  test('没有 .git → 回退 cwd 且 reason fallback', async () => {
    const plain = join(scratch, 'no-git')
    await mkdir(plain, { recursive: true })
    const { root, reason } = await resolveProjectRoot(plain)
    assert.equal(root, plain)
    assert.equal(reason, 'fallback')
  })

  test('probe 抛错 → { root: cwd, reason: error } 且不抛', async () => {
    const cwd = join(scratch, 'probe-throws')
    await mkdir(cwd, { recursive: true })
    const { root, reason } = await resolveProjectRoot(cwd, async () => {
      throw new Error('EACCES')
    })
    assert.equal(root, cwd)
    assert.equal(reason, 'error')
  })

  test('自定义 probe 决定 marker 位置', async () => {
    const target = join(scratch, 'custom', 'inner')
    const { root, reason } = await resolveProjectRoot(target, (dir) => dir.endsWith(`${sep}custom`))
    assert.equal(root, join(scratch, 'custom'))
    assert.equal(reason, 'marker')
  })
})

describe('safeJoin', () => {
  /** root 必须在 before() 之后取，不能在 describe 求值时计算。 */
  const root = () => join(scratch, 'safe-root')

  test('正常相对路径', () => {
    assert.equal(safeJoin(root(), 'a/b.md'), join(root(), 'a/b.md'))
    assert.equal(safeJoin(root(), 'file.md'), join(root(), 'file.md'))
  })

  test('绝对路径 → PATH_TRAVERSAL', () => {
    assert.throws(() => safeJoin(root(), '/etc/passwd'), (error) => {
      assert.ok(error instanceof SafeJoinError)
      assert.equal(error.code, 'PATH_TRAVERSAL')
      return true
    })
  })

  test('含 .. 段 → PATH_TRAVERSAL', () => {
    for (const bad of ['../evil.md', 'a/../../evil.md', 'a/..', '..']) {
      assert.throws(() => safeJoin(root(), bad), (error) => {
        assert.equal(error.code, 'PATH_TRAVERSAL')
        return true
      })
    }
  })

  test('越界解析 → PATH_TRAVERSAL', () => {
    // 只用 `..` 会被段检查拦下；这里构造一个解析后越界的等价场景（前缀相近的兄弟目录名）。
    assert.throws(() => safeJoin(root(), '../safe-root-evil/x.md'), (error) => {
      assert.equal(error.code, 'PATH_TRAVERSAL')
      return true
    })
  })

  test('非字符串 / 空串 / root 非法 → BAD_INPUT', () => {
    assert.throws(() => safeJoin(root(), 42), (error) => {
      assert.equal(error.code, 'BAD_INPUT')
      return true
    })
    assert.throws(() => safeJoin(root(), ''), (error) => {
      assert.equal(error.code, 'BAD_INPUT')
      return true
    })
    assert.throws(() => safeJoin('relative/root', 'a.md'), (error) => {
      assert.equal(error.code, 'BAD_INPUT')
      return true
    })
    assert.throws(() => safeJoin(root(), 'a//b.md'), (error) => {
      assert.equal(error.code, 'BAD_INPUT')
      return true
    })
  })

  test('尾随分隔符允许', () => {
    assert.equal(safeJoin(root(), 'a/'), join(root(), 'a'))
  })

  test('根目录为 "/" 时前缀检查不出错', () => {
    assert.equal(safeJoin('/', 'tmp/x.md'), join('/', 'tmp/x.md'))
    assert.throws(() => safeJoin('/', '../etc/passwd'), (error) => error.code === 'PATH_TRAVERSAL')
  })
})

describe('document', () => {
  test('emptyDocument 以换行结尾并含一级标题与条目小节', () => {
    const text = emptyDocument('全局长期记忆')
    assert.ok(text.endsWith('\n'))
    assert.equal(documentTitle(text), '全局长期记忆')
    assert.match(text, /## 条目/)
    assert.match(text, /由 dsh-supermemory 维护/)
  })

  test('documentTitle 没有标题 → undefined', () => {
    assert.equal(documentTitle(''), undefined)
    assert.equal(documentTitle('no heading here'), undefined)
    assert.equal(documentTitle(undefined), undefined)
  })

  test('documentTitle 不把二级标题当一级', () => {
    assert.equal(documentTitle('## 条目\n正文'), undefined)
  })

  test('parseEntries 解析多条目与多行正文', () => {
    const text = [
      '# 全局长期记忆',
      '',
      '## 条目',
      '',
      '- 2026-11-10T10:00:00.000Z · source:user-request',
      '  内容第一行',
      '  内容第二行',
      '',
      '- 2026-11-09T08:00:00.000Z · source:digest',
      '  另一个条目',
      '',
    ].join('\n')
    const entries = parseEntries(text)
    assert.equal(entries.length, 2)
    assert.deepEqual(entries[0], {
      time: '2026-11-10T10:00:00.000Z',
      source: 'user-request',
      body: '内容第一行\n内容第二行',
    })
    assert.deepEqual(entries[1], {
      time: '2026-11-09T08:00:00.000Z',
      source: 'digest',
      body: '另一个条目',
    })
  })

  test('parseEntries 空文档 → []', () => {
    assert.deepEqual(parseEntries(''), [])
    assert.deepEqual(parseEntries(undefined), [])
    assert.deepEqual(parseEntries(emptyDocument('x')), [])
  })

  test('renderEntry 格式固定，body 每行两空格缩进', () => {
    assert.equal(
      renderEntry({ time: '2026-11-10T10:00:00.000Z', source: 'user-request', body: 'a\nb' }),
      '- 2026-11-10T10:00:00.000Z · source:user-request\n  a\n  b',
    )
  })

  test('appendEntries 追加并保持尾部换行', () => {
    const base = emptyDocument('全局长期记忆')
    const next = appendEntries(base, [
      { time: '2026-11-10T10:00:00.000Z', source: 'user-request', body: '第一条' },
    ])
    assert.ok(next.endsWith('\n'))
    assert.match(next, /- 2026-11-10T10:00:00\.000Z · source:user-request\n  第一条/)
    assert.equal(next.indexOf('第一条') < next.indexOf('## 条目') ? false : true, true)
  })

  test('往返幂等：append 后再 append 空数组不改变文本', () => {
    const once = appendEntries(emptyDocument('t'), [
      { time: '2026-11-10T10:00:00.000Z', source: 'digest', body: '甲' },
      { time: '2026-11-10T11:00:00.000Z', source: 'digest', body: '乙' },
    ])
    const twice = appendEntries(once, [])
    assert.equal(twice, once)
    const entries = parseEntries(once)
    assert.equal(entries.length, 2)
    assert.equal(entries[0].body, '甲')
    assert.equal(entries[1].body, '乙')
  })

  test('appendEntries 空文档也能写', () => {
    const next = appendEntries('', [{ time: 't', source: 's', body: 'x' }])
    assert.equal(next, '- t · source:s\n  x\n')
  })

  test('byteLength 是 UTF-8 字节数', () => {
    assert.equal(byteLength('abc'), 3)
    assert.equal(byteLength('中'), 3)
    assert.equal(byteLength(''), 0)
    assert.equal(byteLength(undefined), 0)
  })
})

describe('resolveConfig', () => {
  const defaults = {
    enabled: true,
    personasRoot: '',
    presetsRoot: '',
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
    digestProvider: '',
    digestModel: '',
    injectIntoSubagents: true,
  }

  test('undefined / null / 非对象 → 全默认', () => {
    assert.deepEqual(resolveConfig(undefined), defaults)
    assert.deepEqual(resolveConfig(null), defaults)
    assert.deepEqual(resolveConfig('nope'), defaults)
    assert.deepEqual(resolveConfig(42), defaults)
    assert.deepEqual(resolveConfig({}), defaults)
  })

  test('部分覆盖', () => {
    const resolved = resolveConfig({ enabled: false, digestEveryTurns: 9, digestModel: 'm1' })
    assert.equal(resolved.enabled, false)
    assert.equal(resolved.digestEveryTurns, 9)
    assert.equal(resolved.digestModel, 'm1')
    assert.equal(resolved.injectMaxBytes, 24000)
  })

  test('enabled:false 保留，其它字段仍规范化', () => {
    const resolved = resolveConfig({ enabled: false, presetsRoot: '/tmp/p' })
    assert.equal(resolved.enabled, false)
    assert.equal(resolved.personasRoot, '/tmp/p')
    // v1 字段名作为废弃别名保留，与 personasRoot 同值。
    assert.equal(resolved.presetsRoot, '/tmp/p')
  })

  test('personasRoot 优先于废弃别名 presetsRoot', () => {
    const resolved = resolveConfig({ personasRoot: '/new/root', presetsRoot: '/old/root' })
    assert.equal(resolved.personasRoot, '/new/root')
    assert.equal(resolved.presetsRoot, '/new/root')
  })

  test('personasRoot 为空串时回退到 presetsRoot 别名', () => {
    const resolved = resolveConfig({ personasRoot: '', presetsRoot: '/legacy/root' })
    assert.equal(resolved.personasRoot, '/legacy/root')
    assert.equal(resolved.presetsRoot, '/legacy/root')
  })

  test('digestWritableScopes 默认只 project', () => {
    assert.deepEqual(resolveConfig({}).digestWritableScopes, ['project'])
    assert.deepEqual(resolveConfig({ digestWritableScopes: ['project', 'global'] }).digestWritableScopes, [
      'project',
      'global',
    ])
  })

  test('digestWritableScopes 过滤非法 scope、去重、空/非法回退默认', () => {
    assert.deepEqual(
      resolveConfig({ digestWritableScopes: ['project', 'PROJECT', 'nope', 42, ' global '] }).digestWritableScopes,
      ['project', 'global'],
    )
    assert.deepEqual(resolveConfig({ digestWritableScopes: [] }).digestWritableScopes, ['project'])
    assert.deepEqual(resolveConfig({ digestWritableScopes: 'project' }).digestWritableScopes, ['project'])
    assert.deepEqual(resolveConfig({ digestWritableScopes: ['bogus'] }).digestWritableScopes, ['project'])
  })

  test('非法数值回退默认', () => {
    const resolved = resolveConfig({
      systemPromptMaxBytes: Number.NaN,
      injectMaxBytes: Number.POSITIVE_INFINITY,
      digestPressureRatio: '0.5',
      digestMaxInputBytes: null,
      digestMaxOutputTokens: undefined,
    })
    assert.equal(resolved.systemPromptMaxBytes, 12000)
    assert.equal(resolved.injectMaxBytes, 24000)
    assert.equal(resolved.digestPressureRatio, 0.75)
    assert.equal(resolved.digestMaxInputBytes, 120000)
    assert.equal(resolved.digestMaxOutputTokens, 3000)
  })

  test('digestEveryTurns 取整且 ≥ 0', () => {
    assert.equal(resolveConfig({ digestEveryTurns: 7.8 }).digestEveryTurns, 7)
    assert.equal(resolveConfig({ digestEveryTurns: -3 }).digestEveryTurns, 0)
    assert.equal(resolveConfig({ digestEveryTurns: Number.NaN }).digestEveryTurns, 5)
  })

  test('非布尔布尔字段回退默认', () => {
    const resolved = resolveConfig({ enabled: 'yes', autoDigest: 0, injectIntoSubagents: null })
    assert.equal(resolved.enabled, true)
    assert.equal(resolved.autoDigest, true)
    assert.equal(resolved.injectIntoSubagents, true)
  })

  test('非字符串字符串字段回退默认，空串合法', () => {
    const resolved = resolveConfig({ projectDirName: 7, projectFileName: null, digestProvider: '' })
    assert.equal(resolved.projectDirName, '.dsh/memory')
    assert.equal(resolved.projectFileName, 'project-memory.md')
    assert.equal(resolved.digestProvider, '')
  })

  test('支持 schemastery volatile 字段形态（{ get() }）', () => {
    const fake = {
      enabled: { get: () => false },
      digestEveryTurns: { get: () => 11 },
      digestProvider: { get: () => 'p' },
    }
    const resolved = resolveConfig(fake)
    assert.equal(resolved.enabled, false)
    assert.equal(resolved.digestEveryTurns, 11)
    assert.equal(resolved.digestProvider, 'p')
  })

  test('volatile get() 抛错 → 回退默认', () => {
    const fake = {
      enabled: {
        get() {
          throw new Error('boom')
        },
      },
    }
    assert.equal(resolveConfig(fake).enabled, true)
  })
})

describe('resolvePresetsRoot / resolvePersonasRoot', () => {
  test('非空 personasRoot 直接使用', () => {
    assert.equal(resolvePresetsRoot({ personasRoot: '/custom/personas' }, '/dsh'), '/custom/personas')
    assert.equal(resolvePersonasRoot({ personasRoot: '/custom/personas' }, '/dsh'), '/custom/personas')
  })

  test('只有废弃别名 presetsRoot → 直接使用', () => {
    assert.equal(resolvePresetsRoot({ presetsRoot: '/custom/presets' }, '/dsh'), '/custom/presets')
  })

  test('personasRoot 优先于 presetsRoot', () => {
    assert.equal(
      resolvePresetsRoot({ personasRoot: '/new/root', presetsRoot: '/old/root' }, '/dsh'),
      '/new/root',
    )
  })

  test('空串 → $DSH_HOME/supermemory/personas', () => {
    const expected = join('/dsh', 'supermemory', 'personas')
    assert.equal(resolvePresetsRoot({ personasRoot: '', presetsRoot: '' }, '/dsh'), expected)
    assert.equal(resolvePresetsRoot({}, '/dsh'), expected)
    assert.equal(resolvePresetsRoot(undefined, '/dsh'), expected)
  })

  test('resolvePersonasRoot 与 resolvePresetsRoot 是同一函数', () => {
    assert.equal(resolvePersonasRoot, resolvePresetsRoot)
  })

  test('dshHome 缺失时回退 DSH_HOME 环境变量', () => {
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = '/env/dsh'
    try {
      assert.equal(resolvePresetsRoot({ personasRoot: '' }), join('/env/dsh', 'supermemory', 'personas'))
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })
})

describe('document title 一致性（模板 → 解析）', () => {
  test('四个标题都能往返', async () => {
    for (const title of ['人格 (soul)', '用户画像 (user)', '全局长期记忆', '项目记忆']) {
      const text = emptyDocument(title)
      assert.equal(documentTitle(text), title)
    }
  })
})
