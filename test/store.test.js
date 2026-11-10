/**
 * A1 单测：store 读写、冲突、并发、runs、projects、人设、设置、迁移
 * （契约 §10 第二组 + §V2.8）。
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
let personasRoot
let legacyRoot
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
  personasRoot = join(dshHome, 'supermemory', 'personas')
  legacyRoot = join(dshHome, 'supermemory', 'presets')
  projectRoot = join(base, 'project')
  await mkdir(projectRoot, { recursive: true })
  warnings = []
  store = makeStore()
  await store.ready
})

/** 用当前用例的 dshHome 造一个 store。 */
function makeStore(overrides = {}) {
  return createStore({
    dshHome,
    config: { projectDirName: '.dsh/memory', projectFileName: 'project-memory.md' },
    logger: { warn: (...args) => warnings.push(args.join(' ')), info: () => {} },
    now: () => 1762758000000,
    ...overrides,
  })
}

/** 便捷 ref 构造器（v2：persona）。 */
const soulRef = () => ({ kind: 'soul', persona: 'default' })
const userRef = () => ({ kind: 'user', persona: 'p:1' })
const globalRef = () => ({ kind: 'global', persona: 'default' })
const projectRef = () => ({ kind: 'project', projectRoot })

/** 读 personas.json。 */
async function readRegistry() {
  return JSON.parse(await readFile(join(dshHome, 'supermemory/personas.json'), 'utf8'))
}

describe('文档读取', () => {
  test('首次读不存在的文件 → 空模板，且不落盘', async () => {
    const doc = await store.readDoc(soulRef())
    assert.ok(doc.content.startsWith('# 人格 (soul)'))
    assert.ok(doc.content.endsWith('\n'))
    assert.equal(doc.mtimeMs, 0)
    assert.equal(doc.bytes, Buffer.byteLength(doc.content, 'utf8'))

    // 目录与文件都不应被创建。
    for (const target of [doc.path, personasRoot, legacyRoot]) {
      await assert.rejects(stat(target), (error) => error.code === 'ENOENT')
    }
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
    assert.ok(doc.path.startsWith(projectRoot + '/'))
    assert.ok(doc.path.endsWith('project-memory.md'))
  })

  test('soul/user/global 文件名固定：soul.md / user.md / global-memory.md', async () => {
    assert.equal(store.docPath(soulRef()), join(personasRoot, 'default/soul.md'))
    assert.equal(store.docPath(userRef()), join(personasRoot, 'p-1/user.md'))
    assert.equal(store.docPath(globalRef()), join(personasRoot, 'default/global-memory.md'))

    await store.writeDoc(globalRef(), '# 全局长期记忆\n\nx\n')
    assert.equal(await readFile(join(personasRoot, 'default/global-memory.md'), 'utf8'), '# 全局长期记忆\n\nx\n')
  })
})

describe('ref：persona 与 presetId 过渡兼容', () => {
  test('只有 presetId 时当作 persona', () => {
    assert.equal(store.docPath({ kind: 'soul', presetId: 'default' }), join(personasRoot, 'default/soul.md'))
    assert.equal(store.docPath({ kind: 'global', presetId: 'p:1' }), join(personasRoot, 'p-1/global-memory.md'))
  })

  test('persona 与 presetId 同时存在时 persona 优先', () => {
    assert.equal(store.docPath({ kind: 'soul', persona: 'A', presetId: 'B' }), join(personasRoot, 'A/soul.md'))
  })

  test('persona 非法字符被 slug 化，不会穿越目录', () => {
    const target = store.docPath({ kind: 'user', persona: '../../etc' })
    assert.ok(target.startsWith(personasRoot))
    assert.equal(target, join(personasRoot, '..-..-etc/user.md'))
  })

  test('缺省 persona/presetId → default', () => {
    assert.equal(store.docPath({ kind: 'soul' }), join(personasRoot, 'default/soul.md'))
  })

  test('persona ref 与 presetId ref 写到同一文件', async () => {
    await store.writeDoc({ kind: 'global', persona: 'shared' }, 'v1\n')
    const read = await store.readDoc({ kind: 'global', presetId: 'shared' })
    assert.equal(read.content, 'v1\n')
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
    // 让人设根目录指向一个普通文件下的子路径，mkdir 必然失败。
    const blocker = join(scratchRoot, `blocker-${Date.now()}`)
    await writeFile(blocker, 'not a directory', 'utf8')
    const broken = makeStore({ personasRoot: join(blocker, 'personas') })
    const result = await broken.writeDoc(soulRef(), 'x')
    assert.equal(result.ok, false)
    assert.equal(result.code, 'UNWRITABLE')
    assert.equal(typeof result.message, 'string')
    await broken.dispose()
  })

  test('写入使用原子替换：不留下临时文件', async () => {
    const first = await store.writeDoc(globalRef(), 'atomic\n')
    assert.equal(first.ok, true)
    const dir = join(personasRoot, 'default')
    const names = await readdir(dir)
    assert.deepEqual(names, ['global-memory.md'])
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
    const names = await readdir(join(personasRoot, 'default'))
    assert.deepEqual(names.sort(), ['global-memory.md'])
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
    assert.equal(target, join(personasRoot, 'default/soul.md'))
    assert.throws(() => store.docPath({ kind: 'bad' }), (error) => error.code === 'BAD_INPUT')
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

    const firstSeen = projects[0].lastSeenAt
    assert.ok(firstSeen.length > 0)

    // 同一路径再次 touch：不新增，更新 lastSeenAt（这里用递增时钟）。
    const later = new Date(Date.parse(firstSeen) + 60_000).toISOString()
    const store2 = makeStore({ now: () => Date.parse(later) })
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

describe('人设注册表（v2）', () => {
  test('全新 store：listPersonas 为空、currentPersona 为 null、不创建 personas.json', async () => {
    assert.deepEqual(store.listPersonas(), [])
    assert.equal(store.currentPersona(), null)
    await assert.rejects(stat(join(dshHome, 'supermemory/personas.json')), (error) => error.code === 'ENOENT')
  })

  test('createPersona 建目录并写入 personas.json 结构', async () => {
    const result = await store.createPersona('Work')
    assert.equal(result.ok, true)
    assert.equal(result.persona.slug, 'Work')
    assert.equal(result.persona.name, 'Work')
    assert.match(result.persona.createdAt, /^\d{4}-\d{2}-\d{2}T/)
    assert.equal(result.persona.dir, join(personasRoot, 'Work'))
    assert.equal((await stat(join(personasRoot, 'Work'))).isDirectory(), true)

    const registry = await readRegistry()
    assert.equal(registry.version, 1)
    assert.equal(typeof registry.current, 'string')
    assert.deepEqual(registry.personas.map((item) => item.slug), ['Work'])
    assert.equal(registry.personas[0].name, 'Work')

    const listed = store.listPersonas()
    assert.equal(listed.length, 1)
    assert.deepEqual(listed[0], {
      slug: 'Work',
      name: 'Work',
      createdAt: result.persona.createdAt,
      dir: join(personasRoot, 'Work'),
    })
  })

  test('createPersona 去空白、截断到 60 字符', async () => {
    const longName = `  ${'a'.repeat(80)}  `
    const result = await store.createPersona(longName)
    assert.equal(result.ok, true)
    assert.equal(result.persona.name.length, 60)
    assert.equal(result.persona.name, 'a'.repeat(60))
  })

  test('createPersona 名称非法 → BAD_INPUT', async () => {
    for (const bad of ['', '   ', null, undefined, 42]) {
      const result = await store.createPersona(bad)
      assert.equal(result.ok, false)
      assert.equal(result.code, 'BAD_INPUT')
    }
  })

  test('slug 冲突追加 -2 / -3', async () => {
    const first = await store.createPersona('Work')
    const second = await store.createPersona('Work')
    const third = await store.createPersona('Work')
    assert.equal(first.persona.slug, 'Work')
    assert.equal(second.persona.slug, 'Work-2')
    assert.equal(third.persona.slug, 'Work-3')
    assert.equal(store.listPersonas().length, 3)
  })

  test('listPersonas 按 createdAt 升序', async () => {
    await store.createPersona('Alpha')
    await store.createPersona('Beta')
    const registryPath = join(dshHome, 'supermemory/personas.json')
    const raw = JSON.parse(await readFile(registryPath, 'utf8'))
    const alpha = raw.personas.find((item) => item.slug === 'Alpha')
    const beta = raw.personas.find((item) => item.slug === 'Beta')
    alpha.createdAt = '2026-11-10T02:00:00.000Z'
    beta.createdAt = '2026-11-10T01:00:00.000Z'
    await writeFile(registryPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8')

    const fresh = makeStore()
    await fresh.ready
    assert.deepEqual(fresh.listPersonas().map((item) => item.slug), ['Beta', 'Alpha'])
    await fresh.dispose()
  })

  test('setCurrentPersona 切换并持久化', async () => {
    await store.createPersona('Work')
    const switched = await store.setCurrentPersona('Work')
    assert.equal(switched.ok, true)
    assert.equal(switched.persona.slug, 'Work')
    assert.deepEqual(store.currentPersona(), { slug: 'Work', name: 'Work' })

    const fresh = makeStore()
    await fresh.ready
    assert.deepEqual(fresh.currentPersona(), { slug: 'Work', name: 'Work' })
    await fresh.dispose()
  })

  test('setCurrentPersona 参数非法 → BAD_INPUT；未知人设 → NOT_FOUND；default 总可切', async () => {
    const missing = await store.setCurrentPersona('nope')
    assert.equal(missing.ok, false)
    assert.equal(missing.code, 'NOT_FOUND')

    for (const bad of ['', '  ', null, 42]) {
      const result = await store.setCurrentPersona(bad)
      assert.equal(result.ok, false)
      assert.equal(result.code, 'BAD_INPUT')
    }

    const fallback = await store.setCurrentPersona('default')
    assert.equal(fallback.ok, true)
    assert.equal(fallback.persona.slug, 'default')
  })

  test('personaDir 纯计算且 slug 化', () => {
    assert.equal(store.personaDir('Work'), join(personasRoot, 'Work'))
    assert.equal(store.personaDir('a/b'), join(personasRoot, 'a-b'))
    assert.equal(store.personaDir(), join(personasRoot, 'default'))
  })

  test('磁盘上已存在但未登记的人设目录会被发现并登记', async () => {
    await mkdir(join(personasRoot, 'manual'), { recursive: true })
    const fresh = makeStore()
    await fresh.ready
    assert.ok(fresh.listPersonas().some((item) => item.slug === 'manual'))
    const registry = await readRegistry()
    assert.ok(registry.personas.some((item) => item.slug === 'manual'))
    assert.equal(registry.current, 'manual')
    await fresh.dispose()
  })

  test('旧 API：listPresets / ensurePreset 兼容', async () => {
    assert.deepEqual(await store.listPresets(), [])
    const preset = await store.ensurePreset('my:preset')
    assert.equal(preset.slug, 'my-preset')
    assert.equal(preset.id, 'my:preset')
    assert.equal(preset.dir, join(personasRoot, 'my-preset'))

    const listed = await store.listPresets()
    assert.equal(listed.length, 1)
    assert.equal(listed[0].slug, 'my-preset')
    assert.equal(listed[0].id, 'my-preset')
    assert.ok(listed[0].updatedAt.length > 0)

    // 幂等：重复 ensurePreset 不产生重复登记。
    await store.ensurePreset('my:preset')
    assert.equal(store.listPersonas().length, 1)
  })
})

describe('插件设置（v2）', () => {
  test('默认值：文件不存在 → 空 provider/model', () => {
    assert.deepEqual(store.readSettings(), { digestProvider: '', digestModel: '' })
  })

  test('写入后可读回，并持久化到 settings.json', async () => {
    const written = await store.writeSettings({ digestProvider: 'provider-a', digestModel: 'model-a' })
    assert.equal(written.ok, true)
    assert.deepEqual(written.settings, { digestProvider: 'provider-a', digestModel: 'model-a' })
    assert.deepEqual(store.readSettings(), { digestProvider: 'provider-a', digestModel: 'model-a' })

    const raw = JSON.parse(await readFile(join(dshHome, 'supermemory/settings.json'), 'utf8'))
    assert.equal(raw.version, 1)
    assert.equal(raw.digestProvider, 'provider-a')
    assert.equal(raw.digestModel, 'model-a')

    const fresh = makeStore()
    await fresh.ready
    assert.deepEqual(fresh.readSettings(), { digestProvider: 'provider-a', digestModel: 'model-a' })
    await fresh.dispose()
  })

  test('只接受 digestProvider / digestModel；其它键与非字符串值被忽略', async () => {
    await store.writeSettings({ digestProvider: 'p', digestModel: 'm' })
    const written = await store.writeSettings({ digestProvider: 42, digestModel: ' m2 ', evil: 'x' })
    assert.equal(written.ok, true)
    assert.deepEqual(written.settings, { digestProvider: 'p', digestModel: 'm2' })

    const raw = JSON.parse(await readFile(join(dshHome, 'supermemory/settings.json'), 'utf8'))
    assert.deepEqual(Object.keys(raw).sort(), ['digestModel', 'digestProvider', 'version'])
    assert.equal(raw.evil, undefined)
  })

  test('坏 JSON 不炸：读回默认值，仍可写入覆盖', async () => {
    await mkdir(join(dshHome, 'supermemory'), { recursive: true })
    await writeFile(join(dshHome, 'supermemory/settings.json'), '{not json', 'utf8')
    const fresh = makeStore()
    await fresh.ready
    assert.deepEqual(fresh.readSettings(), { digestProvider: '', digestModel: '' })
    const written = await fresh.writeSettings({ digestProvider: 'p', digestModel: 'm' })
    assert.equal(written.ok, true)
    assert.deepEqual(fresh.readSettings(), { digestProvider: 'p', digestModel: 'm' })
    await fresh.dispose()
  })

  test('patch 非对象 → BAD_INPUT', async () => {
    for (const bad of [null, 'x', 42, ['a']]) {
      const result = await store.writeSettings(bad)
      assert.equal(result.ok, false)
      assert.equal(result.code, 'BAD_INPUT')
    }
  })
})

describe('迁移旧 presets 目录（v2）', () => {
  /** 造旧 v1 的 presets 目录。 */
  async function buildLegacy() {
    await mkdir(join(legacyRoot, 'alpha'), { recursive: true })
    await mkdir(join(legacyRoot, 'zeta'), { recursive: true })
    await writeFile(join(legacyRoot, 'alpha/soul.md'), '# 人格 (soul)\n\n旧人格 alpha\n', 'utf8')
    await writeFile(
      join(legacyRoot, 'alpha/preset.json'),
      JSON.stringify({ version: 1, id: 'alpha', name: 'Alpha Persona', createdAt: '2026-01-01T00:00:00.000Z' }),
      'utf8',
    )
    await writeFile(join(legacyRoot, 'zeta/user.md'), '# 用户画像 (user)\n\n旧画像 zeta\n', 'utf8')
  }

  test('createStore → await ready 后整体搬到 personas/ 并登记', async () => {
    await buildLegacy()
    const fresh = makeStore()
    await fresh.ready

    // 1) personas 目录出现，内容完整保留。
    assert.equal(await readFile(join(personasRoot, 'alpha/soul.md'), 'utf8'), '# 人格 (soul)\n\n旧人格 alpha\n')
    assert.equal(await readFile(join(personasRoot, 'zeta/user.md'), 'utf8'), '# 用户画像 (user)\n\n旧画像 zeta\n')

    // 2) 旧目录不残留。
    await assert.rejects(stat(legacyRoot), (error) => error.code === 'ENOENT')

    // 3) personas.json 正确：current 取第一个迁移到的 slug。
    const registry = await readRegistry()
    assert.equal(registry.version, 1)
    assert.equal(registry.current, 'alpha')
    assert.deepEqual(registry.personas.map((item) => item.slug).sort(), ['alpha', 'zeta'])
    assert.equal(registry.personas.find((item) => item.slug === 'alpha').name, 'Alpha Persona')
    assert.equal(registry.personas.find((item) => item.slug === 'alpha').createdAt, '2026-01-01T00:00:00.000Z')

    // 4) 迁移后文档可读。
    assert.ok((await fresh.readDoc({ kind: 'soul', persona: 'alpha' })).content.includes('旧人格 alpha'))
    assert.ok((await fresh.readDoc({ kind: 'user', persona: 'zeta' })).content.includes('旧画像 zeta'))
    assert.deepEqual(fresh.currentPersona(), { slug: 'alpha', name: 'Alpha Persona' })
    assert.deepEqual(
      fresh.listPersonas().map((item) => item.slug).sort(),
      ['alpha', 'zeta'],
    )

    // 5) migrateLegacyPresets 返回本次迁移结果，且重复调用幂等。
    assert.deepEqual(await fresh.migrateLegacyPresets(), { migrated: ['alpha', 'zeta'] })
    assert.deepEqual(await fresh.migrateLegacyPresets(), { migrated: ['alpha', 'zeta'] })
    await fresh.dispose()
  })

  test('幂等：再次 createStore 不会重复登记', async () => {
    await buildLegacy()
    const first = makeStore()
    await first.ready
    await first.dispose()

    const second = makeStore()
    await second.ready
    assert.equal(second.listPersonas().length, 2)
    assert.deepEqual(await second.migrateLegacyPresets(), { migrated: [] })
    const registry = await readRegistry()
    assert.equal(registry.personas.length, 2)
    await second.dispose()
  })

  test('personas/ 已存在时只搬走还没搬的，不动已有目录', async () => {
    await mkdir(join(personasRoot, 'keep'), { recursive: true })
    await writeFile(join(personasRoot, 'keep/soul.md'), '# 人格 (soul)\n\n已有 keep\n', 'utf8')
    await mkdir(join(legacyRoot, 'old'), { recursive: true })

    const fresh = makeStore()
    await fresh.ready
    assert.equal(await readFile(join(personasRoot, 'keep/soul.md'), 'utf8'), '# 人格 (soul)\n\n已有 keep\n')
    assert.equal((await stat(join(personasRoot, 'old'))).isDirectory(), true)
    await assert.rejects(stat(legacyRoot), (error) => error.code === 'ENOENT')

    const registry = await readRegistry()
    assert.equal(registry.current, 'old')
    assert.deepEqual(registry.personas.map((item) => item.slug).sort(), ['keep', 'old'])
    await fresh.dispose()
  })

  test('旧 presets 为空目录：仍创建 personas.json，current 为 default', async () => {
    await mkdir(legacyRoot, { recursive: true })
    const fresh = makeStore()
    await fresh.ready
    await assert.rejects(stat(legacyRoot), (error) => error.code === 'ENOENT')
    const registry = await readRegistry()
    assert.equal(registry.current, 'default')
    assert.deepEqual(registry.personas, [])
    await fresh.dispose()
  })

  test('显式把 personasRoot 指向旧 presets 路径时直接沿用，不搬迁', async () => {
    await mkdir(join(legacyRoot, 'adopted'), { recursive: true })
    await writeFile(join(legacyRoot, 'adopted/global-memory.md'), '# 全局长期记忆\n\n沿用\n', 'utf8')

    const fresh = makeStore({ personasRoot: legacyRoot })
    await fresh.ready
    assert.equal((await stat(join(legacyRoot, 'adopted'))).isDirectory(), true)
    assert.ok(fresh.listPersonas().some((item) => item.slug === 'adopted'))
    assert.ok((await fresh.readDoc({ kind: 'global', persona: 'adopted' })).content.includes('沿用'))
    const registry = JSON.parse(await readFile(join(dshHome, 'supermemory/personas.json'), 'utf8'))
    assert.equal(registry.current, 'adopted')
    await fresh.dispose()
  })

  test('ready 永不 reject：dshHome 不可用时也不抛，写入返回 UNWRITABLE', async () => {
    const badHome = join(scratchRoot, `bad-home-${Date.now()}`)
    await writeFile(badHome, 'not a directory', 'utf8')
    const bad = createStore({ dshHome: badHome, config: {}, logger: { warn: () => {} } })
    await assert.doesNotReject(() => bad.ready)
    assert.deepEqual(bad.listPersonas(), [])
    assert.equal(bad.currentPersona(), null)
    assert.deepEqual(bad.readSettings(), { digestProvider: '', digestModel: '' })
    const result = await bad.writeDoc({ kind: 'soul', persona: 'default' }, 'x')
    assert.equal(result.ok, false)
    assert.equal(result.code, 'UNWRITABLE')
    await bad.dispose()
  })

  test('坏 personas.json 不炸：按空注册表处理并可重建', async () => {
    await mkdir(join(dshHome, 'supermemory'), { recursive: true })
    await writeFile(join(dshHome, 'supermemory/personas.json'), '{not json', 'utf8')
    const fresh = makeStore()
    await fresh.ready
    assert.deepEqual(fresh.listPersonas(), [])
    assert.equal(fresh.currentPersona(), null)
    const created = await fresh.createPersona('Fresh')
    assert.equal(created.ok, true)
    const registry = await readRegistry()
    assert.deepEqual(registry.personas.map((item) => item.slug), ['Fresh'])
    await fresh.dispose()
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
