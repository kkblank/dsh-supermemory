/**
 * A1 单测：store 读写、冲突、并发、runs、projects（契约 §10 第二组）。
 *
 * 运行：node --test test/store.test.js
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'

import { createStore } from '../lib/core/store.js'

/** 每个用例一个干净的 dshHome，after 里统一清理。 */
let scratchRoot
let dshHome
let presetsRoot
let projectRoot
let store

/** 收集告警，便于断言"坏行被跳过"这类行为。 */
let warnings

before(async () => {
  scratchRoot = await mkdtemp(join(tmpdir(), 'supermemory-store-'))
})

after(async () => {
  await rm(scratchRoot, { recursive: true, force: true })
})

beforeEach(async () => {
  // 每次用例用独立子目录，互不干扰。
  const base = await mkdtemp(join(scratchRoot, 'case-'))
  dshHome = join(base, 'dsh')
  presetsRoot = join(dshHome, 'supermemory', 'presets')
  projectRoot = join(base, 'project')
  await mkdir(projectRoot, { recursive: true })
  warnings = []
  store = createStore({
    dshHome,
    presetsRoot,
    config: { projectDirName: '.dsh/memory', projectFileName: 'project-memory.md' },
    logger: { warn: (...args) => warnings.push(args.join(' ')), info: () => {} },
    now: () => 1762758000000,
  })
})

/** 便捷 ref 构造器。 */
const soulRef = () => ({ kind: 'soul', presetId: 'default' })
const userRef = () => ({ kind: 'user', presetId: 'p:1' })
const globalRef = () => ({ kind: 'global', presetId: 'default' })
const projectRef = () => ({ kind: 'project', projectRoot })

describe('文档读取', () => {
  test('首次读不存在的文件 → 空模板，且不落盘', async () => {
    const doc = await store.readDoc(soulRef())
    assert.ok(doc.content.startsWith('# 人格 (soul)'))
    assert.ok(doc.content.endsWith('\n'))
    assert.equal(doc.mtimeMs, 0)
    assert.equal(doc.bytes, Buffer.byteLength(doc.content, 'utf8'))

    // 目录与文件都不应被创建。
    let exists = true
    try {
      await stat(doc.path)
    } catch (error) {
      assert.equal(error.code, 'ENOENT')
      exists = false
    }
    assert.equal(exists, false)
    let dirExists = true
    try {
      await stat(presetsRoot)
    } catch {
      dirExists = false
    }
    assert.equal(dirExists, false)
  })

  test('readDocSync 未缓存 → 空模板，不抛错', () => {
    const doc = store.readDocSync(globalRef())
    assert.ok(doc.content.startsWith('# 全局长期记忆'))
    assert.equal(doc.mtimeMs, 0)
  })

  test('readDocSync 读到缓存中的已写内容', async () => {
    const written = await store.writeDoc(globalRef(), '# 全局长期记忆\n\nhello\n')
    assert.equal(written.ok, true)
    const cached = store.readDocSync(globalRef())
    assert.equal(cached.content, '# 全局长期记忆\n\nhello\n')
    assert.equal(cached.mtimeMs, written.mtimeMs)
  })

  test('readDocSync 非法 ref → 空模板，不抛错', () => {
    for (const bad of [null, { kind: 'nope' }, { kind: 'project' }, { kind: 'project', projectRoot: 'rel' }]) {
      const doc = store.readDocSync(bad)
      assert.equal(typeof doc.content, 'string')
      assert.ok(doc.content.length > 0)
    }
  })

  test('项目文档路径遵循 projectDirName/projectFileName 且经 safeJoin', async () => {
    const doc = await store.readDoc(projectRef())
    assert.equal(doc.path, join(projectRoot, '.dsh/memory/project-memory.md'))
    assert.equal(store.docPath(projectRef()), doc.path)
  })

  test('非法 ref 读 → 空模板而非抛错', async () => {
    const doc = await store.readDoc({ kind: 'project', projectRoot: 'relative/path' })
    assert.ok(doc.content.startsWith('# '))
    assert.equal(doc.mtimeMs, 0)
  })

  test('path 参数不可用任意路径读取', async () => {
    const doc = await store.readDoc({ kind: 'project', projectRoot })
    // 只允许项目目录下的固定文件。
    assert.ok(doc.path.startsWith(projectRoot + '/'))
    assert.ok(doc.path.endsWith('project-memory.md'))
  })
})

describe('写入与冲突', () => {
  test('写入后读回，mtime 变化', async () => {
    const first = await store.writeDoc(soulRef(), '# 人格 (soul)\n\nv1\n')
    assert.equal(first.ok, true)
    assert.ok(first.bytes > 0)

    const read = await store.readDoc(soulRef())
    assert.equal(read.content, '# 人格 (soul)\n\nv1\n')
    assert.equal(read.mtimeMs, first.mtimeMs)

    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = await store.writeDoc(soulRef(), '# 人格 (soul)\n\nv2\n')
    assert.equal(second.ok, true)
    assert.notEqual(second.mtimeMs, first.mtimeMs)

    const reread = await store.readDoc(soulRef())
    assert.equal(reread.content, '# 人格 (soul)\n\nv2\n')
  })

  test('expectedMtimeMs 不符 → STALE', async () => {
    const first = await store.writeDoc(soulRef(), '# 人格 (soul)\n\nA\n')
    assert.equal(first.ok, true)

    const stale = await store.writeDoc(soulRef(), '# 人格 (soul)\n\nB\n', {
      expectedMtimeMs: first.mtimeMs - 1,
    })
    assert.equal(stale.ok, false)
    assert.equal(stale.code, 'STALE')
    assert.equal(stale.mtimeMs, first.mtimeMs)

    // 原内容未被覆盖。
    const read = await store.readDoc(soulRef())
    assert.equal(read.content, '# 人格 (soul)\n\nA\n')
  })

  test('expectedMtimeMs 正确 → 写入成功', async () => {
    const first = await store.writeDoc(soulRef(), 'v1\n')
    const second = await store.writeDoc(soulRef(), 'v2\n', { expectedMtimeMs: first.mtimeMs })
    assert.equal(second.ok, true)
    assert.equal((await store.readDoc(soulRef())).content, 'v2\n')
  })

  test('外部编辑器改动后 readDoc 能看到新内容', async () => {
    const first = await store.writeDoc(globalRef(), 'v1\n')
    assert.equal(first.ok, true)

    const target = store.docPath(globalRef())
    await new Promise((resolve) => setTimeout(resolve, 5))
    await writeFile(target, '外部改动\n', 'utf8')

    const read = await store.readDoc(globalRef())
    assert.equal(read.content, '外部改动\n')
    assert.notEqual(read.mtimeMs, first.mtimeMs)
  })

  test('BAD_INPUT：content 非字符串 / ref 非法 / expectedMtimeMs 非法', async () => {
    const badContent = await store.writeDoc(soulRef(), null)
    assert.equal(badContent.ok, false)
    assert.equal(badContent.code, 'BAD_INPUT')

    const badRef = await store.writeDoc({ kind: 'nope' }, 'x')
    assert.equal(badRef.ok, false)
    assert.equal(badRef.code, 'BAD_INPUT')

    const badExpected = await store.writeDoc(soulRef(), 'x', { expectedMtimeMs: Number.NaN })
    assert.equal(badExpected.ok, false)
    assert.equal(badExpected.code, 'BAD_INPUT')
  })

  test('不可写路径 → UNWRITABLE，且不抛', async () => {
    // 让 presetsRoot 指向一个普通文件，mkdir 必然失败。
    const blocker = join(scratchRoot, `blocker-${Date.now()}`)
    await writeFile(blocker, 'not a directory', 'utf8')
    const broken = createStore({
      dshHome,
      presetsRoot: join(blocker, 'presets'),
      config: {},
      logger: { warn: () => {}, info: () => {} },
    })
    const result = await broken.writeDoc(soulRef(), 'x')
    assert.equal(result.ok, false)
    assert.equal(result.code, 'UNWRITABLE')
    assert.equal(typeof result.message, 'string')
    await broken.dispose()
  })

  test('写入使用原子替换：不留下临时文件', async () => {
    const first = await store.writeDoc(globalRef(), 'atomic\n')
    assert.equal(first.ok, true)
    const dir = join(presetsRoot, 'default')
    const names = await readdir(dir)
    assert.deepEqual(names, ['global.md'])
  })

  test('写入后磁盘内容与返回值一致', async () => {
    const content = '# 全局长期记忆\n\n内容\n'
    const result = await store.writeDoc(globalRef(), content)
    const onDisk = await readFile(store.docPath(globalRef()), 'utf8')
    assert.equal(onDisk, content)
    assert.equal(result.bytes, Buffer.byteLength(content, 'utf8'))
  })
})

describe('并发写', () => {
  test('并发写同一文件不半写，最终内容完整', async () => {
    const big = 'x'.repeat(64 * 1024)
    const jobs = []
    for (let index = 0; index < 24; index += 1) {
      jobs.push(store.writeDoc(globalRef(), `# 全局长期记忆\n\n${big}\n${index}\n`))
    }
    const results = await Promise.all(jobs)
    for (const result of results) assert.equal(result.ok, true)

    const read = await store.readDoc(globalRef())
    assert.ok(read.content.endsWith('\n'))
    assert.ok(read.content.includes(big))
    // 必须是某一个完整版本，不能是拼接残片。
    assert.match(read.content, /^# 全局长期记忆\n\nx+\n\d+\n$/)
    assert.equal(read.bytes, Buffer.byteLength(read.content, 'utf8'))

    // 目录里不应残留 temp 文件。
    const names = await readdir(join(presetsRoot, 'default'))
    assert.deepEqual(names.sort(), ['global.md'])
  })

  test('并发 appendEntries 不丢条目', async () => {
    await store.writeDoc(globalRef(), '# 全局长期记忆\n\n## 条目\n')
    const jobs = []
    for (let index = 0; index < 10; index += 1) {
      jobs.push(
        store.appendEntries(globalRef(), [
          { time: `2026-11-10T10:00:0${index}.000Z`, source: 'user-request', body: `条目-${index}` },
        ]),
      )
    }
    const results = await Promise.all(jobs)
    for (const result of results) assert.equal(result.ok, true)

    const read = await store.readDoc(globalRef())
    for (let index = 0; index < 10; index += 1) {
      assert.ok(read.content.includes(`条目-${index}`), `缺少条目-${index}`)
    }
  })
})

describe('appendEntries', () => {
  test('首次 append 创建文件并写入条目', async () => {
    const result = await store.appendEntries(projectRef(), [
      { time: '2026-11-10T10:00:00.000Z', source: 'user-request', body: '记住这个' },
    ])
    assert.equal(result.ok, true)

    const read = await store.readDoc(projectRef())
    assert.ok(read.content.startsWith('# 项目记忆'))
    assert.ok(read.content.includes('记住这个'))
    assert.ok(read.content.endsWith('\n'))
  })

  test('appendEntries 的 expectedMtimeMs 不符 → STALE', async () => {
    const first = await store.appendEntries(globalRef(), [
      { time: '2026-11-10T10:00:00.000Z', source: 'digest', body: 'a' },
    ])
    assert.equal(first.ok, true)
    const stale = await store.appendEntries(
      globalRef(),
      [{ time: '2026-11-10T11:00:00.000Z', source: 'digest', body: 'b' }],
      { expectedMtimeMs: first.mtimeMs - 5 },
    )
    assert.equal(stale.ok, false)
    assert.equal(stale.code, 'STALE')
    assert.equal((await store.readDoc(globalRef())).content.includes('b'), false)
  })

  test('appendEntries 空数组 → ok 且内容不变', async () => {
    const first = await store.appendEntries(globalRef(), [
      { time: '2026-11-10T10:00:00.000Z', source: 'digest', body: 'a' },
    ])
    const second = await store.appendEntries(globalRef(), [])
    assert.equal(second.ok, true)
    assert.equal(second.bytes, first.bytes)
  })

  test('appendEntries BAD_INPUT：entries 非数组 / ref 非法', async () => {
    const badEntries = await store.appendEntries(globalRef(), 'nope')
    assert.equal(badEntries.ok, false)
    assert.equal(badEntries.code, 'BAD_INPUT')

    const badRef = await store.appendEntries({ kind: 'nope' }, [])
    assert.equal(badRef.ok, false)
    assert.equal(badRef.code, 'BAD_INPUT')
  })
})

describe('stats / docPath', () => {
  test('stats 反映存在性与字节数', async () => {
    const before = await store.stats(globalRef())
    assert.equal(before.exists, false)
    assert.equal(before.bytes, 0)

    await store.writeDoc(globalRef(), 'abc\n')
    const afterWrite = await store.stats(globalRef())
    assert.equal(afterWrite.exists, true)
    assert.equal(afterWrite.bytes, 4)
    assert.ok(afterWrite.mtimeMs > 0)
  })

  test('stats 非法 ref → 全 false，不抛', async () => {
    assert.deepEqual(await store.stats(null), { exists: false, bytes: 0, mtimeMs: 0 })
    assert.deepEqual(await store.stats({ kind: 'project', projectRoot: 'rel' }), {
      exists: false,
      bytes: 0,
      mtimeMs: 0,
    })
  })

  test('docPath 不读盘', () => {
    const target = store.docPath(soulRef())
    assert.equal(target, join(presetsRoot, 'default/soul.md'))
    assert.throws(() => store.docPath({ kind: 'bad' }), (error) => error.code === 'BAD_INPUT')
  })

  test('presetId 中的非法字符不会穿越目录', () => {
    const target = store.docPath({ kind: 'user', presetId: '../../etc' })
    assert.ok(target.startsWith(presetsRoot))
    assert.equal(target, join(presetsRoot, '..-..-etc/user.md'))
  })
})

describe('projects.json', () => {
  test('touchProject 去重并更新 lastSeenAt', async () => {
    await store.touchProject('/repo/one', 'one')
    let projects = await store.listProjects()
    assert.equal(projects.length, 1)
    assert.equal(projects[0].root, '/repo/one')
    assert.equal(projects[0].name, 'one')
    assert.equal(projects[0].path, '/repo/one')

    let firstSeen = projects[0].lastSeenAt
    assert.ok(firstSeen.length > 0)

    // 同一路径再次 touch：不新增，更新 lastSeenAt（这里用递增时钟）。
    const later = new Date(Date.parse(firstSeen) + 60_000).toISOString()
    const store2 = createStore({
      dshHome,
      presetsRoot,
      config: {},
      logger: { warn: () => {}, info: () => {} },
      now: () => Date.parse(later),
    })
    await store2.touchProject('/repo/one', 'renamed')
    await store2.dispose()

    projects = await store.listProjects()
    assert.equal(projects.length, 1)
    assert.equal(projects[0].name, 'renamed')
    assert.equal(projects[0].lastSeenAt, later)
  })

  test('projects.json 结构是 { version: 1, projects: [...] }', async () => {
    await store.touchProject('/repo/two', 'two')
    const raw = JSON.parse(await readFile(join(dshHome, 'supermemory/projects.json'), 'utf8'))
    assert.equal(raw.version, 1)
    assert.ok(Array.isArray(raw.projects))
    assert.equal(raw.projects[0].root, '/repo/two')
  })

  test('坏 JSON → 空列表，不抛', async () => {
    await mkdir(join(dshHome, 'supermemory'), { recursive: true })
    await writeFile(join(dshHome, 'supermemory/projects.json'), '{not json', 'utf8')
    const projects = await store.listProjects()
    assert.deepEqual(projects, [])
  })

  test('addProjectPath 非法路径 → ok:false', async () => {
    assert.equal((await store.addProjectPath('relative')).ok, false)
    assert.equal((await store.addProjectPath(42)).ok, false)
  })

  test('addProjectPath 解析 .git 并记录', async () => {
    const repo = join(projectRoot, 'repo')
    await mkdir(join(repo, '.git'), { recursive: true })
    const nested = join(repo, 'src')
    await mkdir(nested, { recursive: true })

    const result = await store.addProjectPath(nested)
    assert.equal(result.ok, true)
    assert.equal(result.root, repo)
    assert.equal(result.name, 'repo')

    const projects = await store.listProjects()
    assert.ok(projects.some((item) => item.root === repo))
  })
})

describe('presets', () => {
  test('listPresets 空目录 → []', async () => {
    assert.deepEqual(await store.listPresets(), [])
  })

  test('ensurePreset 建目录与 preset.json，listPresets 可见', async () => {
    const preset = await store.ensurePreset('my:preset')
    assert.equal(preset.slug, 'my-preset')
    assert.equal(preset.id, 'my:preset')
    assert.equal(preset.dir, join(presetsRoot, 'my-preset'))

    const meta = JSON.parse(await readFile(join(preset.dir, 'preset.json'), 'utf8'))
    assert.equal(meta.id, 'my:preset')
    assert.equal(meta.slug, 'my-preset')

    const presets = await store.listPresets()
    assert.equal(presets.length, 1)
    assert.equal(presets[0].slug, 'my-preset')
    assert.equal(presets[0].id, 'my:preset')
    assert.ok(presets[0].updatedAt.length > 0)
  })

  test('ensurePreset 幂等（已存在时不重复写）', async () => {
    const first = await store.ensurePreset('default')
    const rawFirst = await readFile(join(first.dir, 'preset.json'), 'utf8')
    const second = await store.ensurePreset('default')
    assert.equal(second.dir, first.dir)
    const rawSecond = await readFile(join(second.dir, 'preset.json'), 'utf8')
    assert.equal(rawSecond, rawFirst)
  })
})

describe('runs.jsonl', () => {
  test('空文件 → []', async () => {
    assert.deepEqual(await store.readRuns(), [])
  })

  test('appendRun 追加并可读回', async () => {
    await store.appendRun({
      at: '2026-11-10T10:00:00.000Z',
      trigger: 'manual',
      ok: true,
      counts: { soul: 0, user: 1, global: 2, project: 0 },
    })
    await store.appendRun({ trigger: 'turns', ok: false, error: 'boom' })

    const runs = await store.readRuns()
    assert.equal(runs.length, 2)
    assert.equal(runs[0].trigger, 'manual')
    assert.equal(runs[0].ok, true)
    assert.equal(runs[1].trigger, 'turns')
    assert.equal(runs[1].ok, false)
    // 缺省 at 自动补 ISO 时间。
    assert.match(runs[1].at, /^\d{4}-\d{2}-\d{2}T/)
  })

  test('readRuns(limit) 只取尾部 N 条', async () => {
    for (let index = 0; index < 5; index += 1) {
      await store.appendRun({ at: `2026-11-10T10:00:0${index}.000Z`, trigger: 'manual', ok: true, index })
    }
    const runs = await store.readRuns(2)
    assert.equal(runs.length, 2)
    assert.equal(runs[0].index, 3)
    assert.equal(runs[1].index, 4)
  })

  test('超过 200 条自动裁剪，只保留最近 200', async () => {
    for (let index = 0; index < 205; index += 1) {
      await store.appendRun({ trigger: 'turns', ok: true, index })
    }
    const raw = await readFile(join(dshHome, 'supermemory/runs.jsonl'), 'utf8')
    const lines = raw.split('\n').filter((line) => line.trim() !== '')
    assert.equal(lines.length, 200)

    const runs = await store.readRuns(200)
    assert.equal(runs.length, 200)
    assert.equal(runs[0].index, 5)
    assert.equal(runs[199].index, 204)
  })

  test('坏行被跳过并告警', async () => {
    await mkdir(join(dshHome, 'supermemory'), { recursive: true })
    const path = join(dshHome, 'supermemory/runs.jsonl')
    await writeFile(
      path,
      [
        JSON.stringify({ at: '2026-11-10T10:00:00.000Z', trigger: 'manual', ok: true }),
        '{broken json',
        JSON.stringify({ at: '2026-11-10T11:00:00.000Z', trigger: 'turns', ok: false }),
        '',
      ].join('\n'),
      'utf8',
    )

    const runs = await store.readRuns()
    assert.equal(runs.length, 2)
    assert.ok(warnings.some((line) => line.includes('corrupt')))
  })

  test('appendRun 后坏行被清理（重写时只保留能解析的记录）', async () => {
    await mkdir(join(dshHome, 'supermemory'), { recursive: true })
    await writeFile(join(dshHome, 'supermemory/runs.jsonl'), '{broken\n', 'utf8')
    await store.appendRun({ trigger: 'manual', ok: true })
    const raw = await readFile(join(dshHome, 'supermemory/runs.jsonl'), 'utf8')
    assert.equal(raw.trim().split('\n').length, 1)
  })
})

describe('dispose', () => {
  test('dispose 等待在途写并清空缓存', async () => {
    const pending = store.writeDoc(globalRef(), 'last\n')
    await store.dispose()
    const result = await pending
    assert.equal(result.ok, true)
    // 缓存已清空：readDocSync 回到空模板。
    assert.equal(store.readDocSync(globalRef()).mtimeMs, 0)
  })
})
