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

  // ———— v5：重命名与删除（契约 §V5.7，细则见 §V5.2）————

  describe('重命名与删除（v5）', () => {
    test('renamePersona 只改显示名：slug / 目录 / 文档内容与 mtime 一概不动，personas.json 落盘正确', async () => {
      const created = await store.createPersona('灰灰')
      const ref = { kind: 'soul', persona: '灰灰' }
      await store.setCurrentPersona('灰灰')
      const content = '# 人格 (soul)\n\n- 原样保留\n'
      assert.equal((await store.writeDoc(ref, content)).ok, true)
      const docFile = store.docPath(ref)
      const mtimeBefore = (await stat(docFile)).mtimeMs

      const renamed = await store.renamePersona('灰灰', '  阿灰  ')
      assert.equal(renamed.ok, true)
      assert.deepEqual(renamed.persona, {
        slug: '灰灰',
        name: '阿灰',
        createdAt: created.persona.createdAt,
        dir: join(personasRoot, '灰灰'),
      })

      // 目录与文档没动，路径也没变（重命名不参与任何路径计算）。
      assert.equal(store.docPath(ref), docFile)
      assert.equal((await stat(docFile)).mtimeMs, mtimeBefore)
      assert.equal((await store.readDoc(ref)).content, content)
      assert.equal(store.listPersonas()[0].name, '阿灰')

      // 落盘：只改 name，slug / createdAt / current 原样。
      const registry = await readRegistry()
      assert.deepEqual(registry.personas, [{ slug: '灰灰', name: '阿灰', createdAt: created.persona.createdAt }])
      assert.equal(registry.current, '灰灰')
      assert.deepEqual(store.currentPersona(), { slug: '灰灰', name: '阿灰' })

      // 细则 4：不写 persona.json——多写一个文件只会多一个失败面。
      await assert.rejects(stat(join(personasRoot, '灰灰/persona.json')), (error) => error.code === 'ENOENT')

      const fresh = makeStore()
      await fresh.ready
      assert.deepEqual(fresh.currentPersona(), { slug: '灰灰', name: '阿灰' })
      await fresh.dispose()
    })

    test('renamePersona 未知 slug → NOT_FOUND；空 / 非字符串 name → BAD_INPUT；超长按码点截 60', async () => {
      const created = await store.createPersona('Work')

      const missing = await store.renamePersona('nope', 'X')
      assert.equal(missing.ok, false)
      assert.equal(missing.code, 'NOT_FOUND')
      assert.deepEqual(store.listPersonas().map((item) => item.slug), ['Work'])

      for (const bad of ['', '   ', null, undefined, 42]) {
        const result = await store.renamePersona('Work', bad)
        assert.equal(result.ok, false)
        assert.equal(result.code, 'BAD_INPUT')
      }
      for (const bad of ['', null, 42]) {
        const result = await store.renamePersona(bad, 'X')
        assert.equal(result.ok, false)
        assert.equal(result.code, 'BAD_INPUT')
      }
      // 非法入参不能把既有名字改坏。
      assert.equal(store.listPersonas()[0].name, 'Work')

      const long = await store.renamePersona('Work', `  ${'字'.repeat(80)}  `)
      assert.equal(long.ok, true)
      assert.equal(long.persona.name, '字'.repeat(60))
      assert.equal([...long.persona.name].length, 60)
      assert.equal(created.persona.slug, 'Work')
      assert.equal(store.listPersonas()[0].slug, 'Work')
    })

    test('deletePersona("Default") → PERSONA_PROTECTED，检查在任何 IO 之前（连注册表都不碰）', async () => {
      // 真实环境里默认人设的 slug 是 **大写 D**：lib/index.js 用 createPersona('Default')，
      // 而 personaSlug 原样保留大小写。用小写 'default' 测保护，全绿也挡不住真实事故。
      // 这里只用 writeDoc 落出 personas/Default/ 目录（不登记、不写注册表），
      // 好让下面那条「注册表文件仍未被创建」的断言成立——禁删发生在查表之前。
      const ref = { kind: 'soul', persona: 'Default' }
      assert.equal((await store.writeDoc(ref, '# 人格 (soul)\n\n- 别删我\n')).ok, true)
      assert.deepEqual(store.listPersonas(), [])

      const result = await store.deletePersona('Default')
      assert.equal(result.ok, false)
      assert.equal(result.code, 'PERSONA_PROTECTED')

      // 目录与内容完好。
      assert.equal((await stat(join(personasRoot, 'Default'))).isDirectory(), true)
      assert.equal((await stat(join(personasRoot, 'Default/soul.md'))).isFile(), true)
      // 没有任何 IO 副作用：注册表文件根本没被创建。
      await assert.rejects(stat(join(dshHome, 'supermemory/personas.json')), (error) => error.code === 'ENOENT')
    })

    test('deletePersona 三种大小写写法全都禁删：Default / default / DEFAULT', async () => {
      // 文件系统大小写敏感，三种写法是两个不同的目录名；但语义上都是「默认人设」，一律不许删。
      const created = await store.createPersona('Default')
      assert.equal(created.persona.slug, 'Default')
      await store.setCurrentPersona('Default')
      // 顺带造一个小写同名目录：证明禁删不是靠「该目录不存在」蒙对的
      // （退回逐字比较后，'default' 会走查表返回 NOT_FOUND，同样过不了这条）。
      await mkdir(join(personasRoot, 'default'), { recursive: true })
      assert.equal((await store.writeDoc({ kind: 'soul', persona: 'Default' }, '# 人格 (soul)\n\n- 默认人格\n')).ok, true)

      for (const slug of ['Default', 'default', 'DEFAULT', 'DeFaUlT']) {
        const result = await store.deletePersona(slug)
        assert.equal(result.ok, false, slug)
        assert.equal(result.code, 'PERSONA_PROTECTED', slug)
      }

      // 两个目录都还在，注册表条目与 current 也没被动过。
      assert.equal((await stat(join(personasRoot, 'Default'))).isDirectory(), true)
      assert.equal((await stat(join(personasRoot, 'Default/soul.md'))).isFile(), true)
      assert.equal((await stat(join(personasRoot, 'default'))).isDirectory(), true)
      assert.deepEqual(store.listPersonas().map((item) => item.slug), ['Default'])
      assert.deepEqual(store.currentPersona(), { slug: 'Default', name: 'Default' })
    })

    test('deletePersona 删掉非 current：current 与其余人设不受影响', async () => {
      const alpha = await store.createPersona('Alpha')
      await store.createPersona('Beta')
      await store.setCurrentPersona(alpha.persona.slug)

      const result = await store.deletePersona('Beta')
      assert.equal(result.ok, true)
      assert.deepEqual(result.deleted, { slug: 'Beta', name: 'Beta' })
      assert.deepEqual(result.current, { slug: 'Alpha', name: 'Alpha' })
      assert.deepEqual(store.currentPersona(), { slug: 'Alpha', name: 'Alpha' })
      assert.deepEqual(store.listPersonas().map((item) => item.slug), ['Alpha'])

      const registry = await readRegistry()
      assert.equal(registry.current, 'Alpha')
      assert.deepEqual(registry.personas.map((item) => item.slug), ['Alpha'])
      assert.equal((await stat(join(personasRoot, 'Alpha'))).isDirectory(), true)
    })

    test('deletePersona 删掉 current：迁到 default；无 default 时迁到 createdAt 最早的', async () => {
      await store.createPersona('Work')
      await store.setCurrentPersona('default') // 登记 default（目录可以还不存在）
      await store.setCurrentPersona('Work')
      assert.deepEqual(store.currentPersona(), { slug: 'Work', name: 'Work' })

      const deleted = await store.deletePersona('Work')
      assert.equal(deleted.ok, true)
      assert.deepEqual(deleted.current, { slug: 'default', name: 'default' })
      assert.deepEqual(store.currentPersona(), { slug: 'default', name: 'default' })
      assert.equal((await readRegistry()).current, 'default')
    })

    test('deletePersona 删掉 current 且没有 default：迁到剩余里 createdAt 最早的一个', async () => {
      await store.createPersona('Alpha')
      await store.createPersona('Beta')
      const registryPath = join(dshHome, 'supermemory/personas.json')
      const raw = JSON.parse(await readFile(registryPath, 'utf8'))
      raw.current = 'Alpha'
      raw.personas.find((item) => item.slug === 'Alpha').createdAt = '2026-11-10T05:00:00.000Z'
      raw.personas.find((item) => item.slug === 'Beta').createdAt = '2026-11-10T01:00:00.000Z'
      await writeFile(registryPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8')

      const fresh = makeStore()
      await fresh.ready
      assert.deepEqual(fresh.currentPersona(), { slug: 'Alpha', name: 'Alpha' })

      const deleted = await fresh.deletePersona('Alpha')
      assert.equal(deleted.ok, true)
      assert.deepEqual(deleted.current, { slug: 'Beta', name: 'Beta' })
      assert.deepEqual(fresh.currentPersona(), { slug: 'Beta', name: 'Beta' })
      assert.equal((await readRegistry()).current, 'Beta')
      await fresh.dispose()
    })

    test('deletePersona 删掉 current：接班优先大写的 Default，而不是 createdAt 最早的那个', async () => {
      // 真实环境剩余列表里躺着的是 'Default'（大写），逐字比小写会跳过它、
      // 落进「createdAt 最早」分支——所以这里故意让 Default 是剩余里最晚创建的。
      //
      // 场景刻意**不给 Default 建目录**：v6 的归一化只管磁盘上真实存在的变体目录，
      // 悬空的大写条目它碰不到。这正是 §V6.0 说的「归一完成前 / 归一被跳过的环境」，
      // 也是 isDefaultSlug 不得退回逐字比小写的理由——否则默认人设在这些环境里又能被删。
      const registryPath = join(dshHome, 'supermemory/personas.json')
      await mkdir(join(dshHome, 'supermemory'), { recursive: true })
      await writeFile(registryPath, `${JSON.stringify({
        version: 1,
        current: 'Work',
        personas: [
          { slug: 'Default', name: 'Default', createdAt: '2026-11-10T09:00:00.000Z' }, // 最晚
          { slug: 'Work', name: 'Work', createdAt: '2026-11-10T01:00:00.000Z' },
          { slug: 'Alpha', name: 'Alpha', createdAt: '2026-11-10T05:00:00.000Z' },
        ],
      }, null, 2)}\n`, 'utf8')
      for (const slug of ['Work', 'Alpha']) await mkdir(join(personasRoot, slug), { recursive: true })

      const fresh = makeStore()
      await fresh.ready
      // 前提：磁盘上没有变体目录 ⇒ 归一化没有触碰这个悬空条目。
      assert.deepEqual(fresh.listPersonas().map((item) => item.slug), ['Work', 'Alpha', 'Default'])
      assert.deepEqual(fresh.currentPersona(), { slug: 'Work', name: 'Work' })

      const deleted = await fresh.deletePersona('Work')
      assert.equal(deleted.ok, true)
      assert.deepEqual(deleted.current, { slug: 'Default', name: 'Default' })
      assert.deepEqual(fresh.currentPersona(), { slug: 'Default', name: 'Default' })
      assert.equal((await readRegistry()).current, 'Default')
      await fresh.dispose()
    })

    test('deletePersona 删掉最后一个（且非 default）：current 回退空串 → null', async () => {
      const solo = await store.createPersona('Solo')
      await store.setCurrentPersona(solo.persona.slug)

      const result = await store.deletePersona(solo.persona.slug)
      assert.equal(result.ok, true)
      assert.deepEqual(result.deleted, { slug: 'Solo', name: 'Solo' })
      assert.equal(result.current, null)
      assert.equal(store.currentPersona(), null)
      assert.equal((await readRegistry()).current, '')
      assert.deepEqual(store.listPersonas(), [])
    })

    test('deletePersona 注册表里没有 default 条目时删掉最后一个：current null，不报错也不凭空造条目', async () => {
      // 契约 §V5.0 的边界：真实运行下 index.js 启动会建 Default，但只把 personas/ 目录
      // 拷到新机器、没带 personas.json 时，reconcileRegistry 只登记扫到的目录，
      // 不会凭空补一条 default。此刻删掉最后一个就是「全空」，那是允许的收敛态。
      const dir = join(personasRoot, 'Solo')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'soul.md'), '# 人格 (soul)\n\n- 唯一的一份\n', 'utf8')

      const fresh = makeStore()
      await fresh.ready
      // 前提：扫描登记出 Solo 并把它当 current，注册表里确实没有 default。
      assert.deepEqual(fresh.listPersonas().map((item) => item.slug), ['Solo'])
      assert.deepEqual(fresh.currentPersona(), { slug: 'Solo', name: 'Solo' })

      const result = await fresh.deletePersona('Solo')
      assert.equal(result.ok, true) // 禁止动作一：删除时报错
      assert.deepEqual(result.deleted, { slug: 'Solo', name: 'Solo' })
      assert.equal(result.current, null)
      assert.equal(fresh.currentPersona(), null)
      assert.deepEqual(fresh.listPersonas(), []) // 禁止动作二：凭空造条目

      // 落盘形态同样是干净的全空，没有偷偷塞回 default。
      assert.deepEqual(await readRegistry(), { version: 1, current: '', personas: [] })
      await assert.rejects(stat(join(personasRoot, 'default')), (error) => error.code === 'ENOENT')

      // 下一次启动也不该由 reconcileRegistry 补出条目（自愈属于 index.js 的初始化，不在存储层）。
      const after = makeStore()
      await after.ready
      assert.deepEqual(after.listPersonas(), [])
      assert.equal(after.currentPersona(), null)
      await after.dispose()
    })

    test('deletePersona 连目录带 history/ 快照一并消失，重启也不会被重新登记', async () => {
      await store.createPersona('Ghost')
      const ref = { kind: 'soul', persona: 'Ghost' }
      assert.equal((await store.writeDoc(ref, '# 人格 (soul)\n\n- 现内容\n')).ok, true)
      const snap = await store.writeDocSnapshot(ref, '# 人格 (soul)\n\n- 旧内容\n')
      assert.equal(snap.ok, true)
      const dir = join(personasRoot, 'Ghost')
      assert.equal((await stat(join(dir, 'history'))).isDirectory(), true)

      assert.equal((await store.deletePersona('Ghost')).ok, true)
      assert.deepEqual(store.listPersonas(), [])
      await assert.rejects(stat(dir), (error) => error.code === 'ENOENT')

      const fresh = makeStore()
      await fresh.ready
      assert.deepEqual(fresh.listPersonas(), [])
      await fresh.dispose()
    })

    test('slug 逐字查表，绝不做 personaSlug 归一化：`../etc` 命中不了已登记的 `..-etc`', async () => {
      // 磁盘上有个归一化后与 `../etc` 恰好同名的目录，而且它已被登记成人设：
      // 一旦对入参做归一化，这个无辜人设就会被误删（§V5.2 的安全要点）。
      await mkdir(join(personasRoot, '..-etc'), { recursive: true })
      const fresh = makeStore()
      await fresh.ready
      assert.ok(fresh.listPersonas().some((item) => item.slug === '..-etc'))

      for (const sneaky of ['../etc', '../../etc', '..-etc/../..-etc', 'nope']) {
        const renamed = await fresh.renamePersona(sneaky, 'X')
        assert.equal(renamed.ok, false, sneaky)
        assert.equal(renamed.code, 'NOT_FOUND', sneaky)
        const removed = await fresh.deletePersona(sneaky)
        assert.equal(removed.ok, false, sneaky)
        assert.equal(removed.code, 'NOT_FOUND', sneaky)
      }
      // 越界无从发生：那个无辜人设的目录与条目都还在。
      assert.equal((await stat(join(personasRoot, '..-etc'))).isDirectory(), true)
      assert.ok(fresh.listPersonas().some((item) => item.slug === '..-etc'))

      // 只有逐字给出的 slug 才删得掉。
      assert.equal((await fresh.deletePersona('..-etc')).ok, true)
      assert.deepEqual(fresh.listPersonas(), [])
      await fresh.dispose()

      assert.equal((await store.deletePersona('')).code, 'BAD_INPUT')
      assert.equal((await store.deletePersona(null)).code, 'BAD_INPUT')
      assert.equal((await store.renamePersona('', 'X')).code, 'BAD_INPUT')
    })

    test('删人设会清掉进程内缓存：readDocSync 不再吐出没掉的内容', async () => {
      await store.createPersona('Ghost')
      const ref = { kind: 'soul', persona: 'Ghost' }
      const content = '# 人格 (soul)\n\n- 已随人设删除\n'
      assert.equal((await store.writeDoc(ref, content)).ok, true)
      assert.equal(store.readDocSync(ref).content, content) // 先确认缓存里确实有

      assert.equal((await store.deletePersona('Ghost')).ok, true)
      const after = store.readDocSync(ref)
      assert.notEqual(after.content, content)
      assert.ok(after.content.startsWith('# 人格 (soul)'))
      assert.equal(after.mtimeMs, 0)
    })

    test('删后重建同名 slug → readDoc 返回空模板（缓存不留残影，回归 §V5.2 第 5 步）', async () => {
      await store.createPersona('Ghost')
      const ref = { kind: 'soul', persona: 'Ghost' }
      assert.equal((await store.writeDoc(ref, '# 人格 (soul)\n\n- 上一世的记忆\n')).ok, true)
      assert.equal((await store.deletePersona('Ghost')).ok, true)

      const again = await store.createPersona('Ghost')
      assert.equal(again.ok, true)
      assert.equal(again.persona.slug, 'Ghost') // 目录已删，slug 不该被追加 -2

      const doc = await store.readDoc(ref)
      assert.equal(doc.content.includes('上一世的记忆'), false)
      assert.ok(doc.content.startsWith('# 人格 (soul)'))
      assert.equal(doc.mtimeMs, 0)
      assert.equal(store.readDocSync(ref).content.includes('上一世的记忆'), false)
    })
  })
})

describe('默认人设 slug 归一化（v6）', () => {
  /** 判定独立于被测实现：测试要能在 store.js 的判断被改坏时照样报警。 */
  const isDefaultLike = (slug) => typeof slug === 'string' && slug.toLowerCase() === 'default'

  /** 造一个带 persona.json 与 soul.md 的人设目录（模拟存量环境的磁盘形态）。 */
  async function seedDir(dir, meta, soul) {
    await mkdir(dir, { recursive: true })
    if (meta !== undefined) await writeFile(join(dir, 'persona.json'), `${JSON.stringify(meta)}\n`, 'utf8')
    if (soul !== undefined) await writeFile(join(dir, 'soul.md'), soul, 'utf8')
    return dir
  }

  const seedPersonaDir = (slug, meta, soul) => seedDir(join(personasRoot, slug), meta, soul)
  const seedLegacyDir = (slug, meta, soul) => seedDir(join(legacyRoot, slug), meta, soul)

  /** 直接写 personas.json（存量环境的注册表形态）。 */
  async function writeRegistry(registry) {
    await writeFile(join(dshHome, 'supermemory/personas.json'), `${JSON.stringify(registry, null, 2)}\n`, 'utf8')
  }

  test('① 存量 Default：ready 之后目录 / 条目 / current 全变小写，显示名仍是 Default', async () => {
    const soul = '# 人格 (soul)\n\n- 存量内容\n'
    await seedPersonaDir('Default', { name: 'Default', createdAt: '2026-11-10T01:00:00.000Z' }, soul)
    await writeRegistry({
      version: 1,
      current: 'Default',
      personas: [{ slug: 'Default', name: 'Default', createdAt: '2026-11-10T01:00:00.000Z' }],
    })

    const fresh = makeStore()
    await fresh.ready
    assert.equal((await stat(join(personasRoot, 'default/soul.md'))).isFile(), true)
    assert.equal(await readFile(join(personasRoot, 'default/soul.md'), 'utf8'), soul)
    await assert.rejects(stat(join(personasRoot, 'Default')), (error) => error.code === 'ENOENT')

    const registry = await readRegistry()
    assert.deepEqual(registry.personas, [{ slug: 'default', name: 'Default', createdAt: '2026-11-10T01:00:00.000Z' }])
    assert.equal(registry.current, 'default')
    assert.deepEqual(fresh.currentPersona(), { slug: 'default', name: 'Default' })
    assert.deepEqual(fresh.listPersonas().map((item) => item.dir), [join(personasRoot, 'default')])
    await fresh.dispose()
  })

  test('② 小写与变体并存：两个目录都还在、内容不动、注册表不变，只 warn', async () => {
    const lower = '# 人格 (soul)\n\n- 小写侧\n'
    const upper = '# 人格 (soul)\n\n- 大写侧\n'
    await seedPersonaDir('default', { name: 'Default', createdAt: '2026-11-10T01:00:00.000Z' }, lower)
    await seedPersonaDir('Default', { name: 'Default', createdAt: '2026-11-10T02:00:00.000Z' }, upper)
    const snapshot = {
      version: 1,
      current: 'Default',
      personas: [
        { slug: 'Default', name: 'Default', createdAt: '2026-11-10T02:00:00.000Z' },
        { slug: 'default', name: 'Default', createdAt: '2026-11-10T01:00:00.000Z' },
      ],
    }
    await writeRegistry(snapshot)

    const fresh = makeStore()
    await fresh.ready
    // 两个目录都活着，内容一字未动（自动合并等于赌哪个该留，禁止）。
    assert.equal(await readFile(join(personasRoot, 'default/soul.md'), 'utf8'), lower)
    assert.equal(await readFile(join(personasRoot, 'Default/soul.md'), 'utf8'), upper)
    assert.deepEqual((await readRegistry()).personas.map((item) => item.slug), ['Default', 'default'])
    assert.deepEqual(await readRegistry(), snapshot)
    assert.ok(warnings.some((line) => line.includes('default persona slug conflict')))
    await fresh.dispose()
  })

  test('②b 多个大写变体同时存在：同样放弃并 warn，不挑一个改名（§V6.1 第 3 步的同一原则）', async () => {
    await seedPersonaDir('Default', { name: 'Default', createdAt: '2026-11-10T01:00:00.000Z' })
    await seedPersonaDir('DEFAULT', { name: 'DEFAULT', createdAt: '2026-11-10T02:00:00.000Z' })

    const fresh = makeStore()
    await fresh.ready
    assert.equal((await stat(join(personasRoot, 'Default'))).isDirectory(), true)
    assert.equal((await stat(join(personasRoot, 'DEFAULT'))).isDirectory(), true)
    assert.equal((await readdir(personasRoot)).some((name) => name.startsWith('.default-migrating-')), false)
    assert.deepEqual((await readRegistry()).personas.map((item) => item.slug).sort(), ['DEFAULT', 'Default'])
    assert.ok(warnings.some((line) => line.includes('default persona slug conflict')))
    await fresh.dispose()
  })

  test('③ 只有小写 default 时不发生任何改名：personasRoot 的 mtime 一步未动', async () => {
    // store 内部 import 的 rename 无法从测试侧 spy（ESM 绑定只读），所以用父目录 mtime 取证：
    // 任何一次改名（哪怕是「Default→临时名→default」这种绕圈）都会改动 personasRoot 的 mtime。
    await seedPersonaDir('default', { name: 'Default', createdAt: '2026-11-10T01:00:00.000Z' }, '# 人格 (soul)\n\n- x\n')
    await seedPersonaDir('工作', { name: '工作', createdAt: '2026-11-10T02:00:00.000Z' }) // 有别的目录也不许动手
    await writeRegistry({
      version: 1,
      current: 'default',
      personas: [
        { slug: 'default', name: 'Default', createdAt: '2026-11-10T01:00:00.000Z' },
        { slug: '工作', name: '工作', createdAt: '2026-11-10T02:00:00.000Z' },
      ],
    })

    const before = await stat(personasRoot)
    const fresh = makeStore()
    await fresh.ready
    const after = await stat(personasRoot)
    assert.equal(after.mtimeMs, before.mtimeMs)
    assert.equal(after.inode, before.inode)
    assert.deepEqual(await readRegistry(), {
      version: 1,
      current: 'default',
      personas: [
        { slug: 'default', name: 'Default', createdAt: '2026-11-10T01:00:00.000Z' },
        { slug: '工作', name: '工作', createdAt: '2026-11-10T02:00:00.000Z' },
      ],
    })
    assert.deepEqual(warnings, []) // 连「冲突」都不该误报
    await fresh.dispose()
  })

  test('④ 改名失败（目标名被一个文件占着）：Default 原样回来、绝不 rm、不抛、只 warn', async () => {
    const soul = '# 人格 (soul)\n\n- 绝不能丢\n'
    await seedPersonaDir('Default', { name: 'Default', createdAt: '2026-11-10T01:00:00.000Z' }, soul)
    // 用普通文件占住 default 这个名字：scanPersonaDirs 只收目录（不触发冲突豁免），
    // 而 rename(临时名 → 该文件) 必然抛错 —— 正好真实演练「第二跳失败」。
    await writeFile(join(personasRoot, 'default'), '我不是目录', 'utf8')
    const snapshot = {
      version: 1,
      current: 'Default',
      personas: [{ slug: 'Default', name: 'Default', createdAt: '2026-11-10T01:00:00.000Z' }],
    }
    await writeRegistry(snapshot)

    const fresh = makeStore()
    await fresh.ready // 归一失败只 warn，ready 永不 reject
    assert.equal(await readFile(join(personasRoot, 'Default/soul.md'), 'utf8'), soul)
    assert.equal((await stat(join(personasRoot, 'Default'))).isDirectory(), true)
    // 第二跳失败后临时名必须被回滚掉：scanPersonaDirs 不跳过点号目录，留下它就是幽灵人设。
    assert.equal((await readdir(personasRoot)).some((name) => name.startsWith('.default-migrating-')), false)
    // 注册表停在归一前的形态，没有半截改完。
    assert.deepEqual(await readRegistry(), snapshot)
    assert.ok(warnings.some((line) => line.includes('second hop')))
    assert.ok(warnings.length < 5) // 只告警，没有刷屏式重试
    await fresh.dispose()
  })

  test('归一绝不碰 current：current 是「工作」时归一完还是「工作」（§V6.5 主人这台机器）', async () => {
    // 存量用户正用「工作」这个人格干活。归一只是把 Default 目录与条目换成小写，
    // current 一个字节都不许动；非默认人设一律不碰。
    await seedPersonaDir('Default', { name: 'Default', createdAt: '2026-11-10T01:00:00.000Z' }, '# 人格 (soul)\n\n- 默认\n')
    await seedPersonaDir('工作', { name: '工作', createdAt: '2026-11-10T02:00:00.000Z' }, '# 人格 (soul)\n\n- 工作人格\n')
    await writeRegistry({
      version: 1,
      current: '工作',
      personas: [
        { slug: 'Default', name: 'Default', createdAt: '2026-11-10T01:00:00.000Z' },
        { slug: '工作', name: '工作', createdAt: '2026-11-10T02:00:00.000Z' },
      ],
    })

    const fresh = makeStore()
    await fresh.ready
    assert.equal((await readRegistry()).current, '工作')
    assert.deepEqual(fresh.currentPersona(), { slug: '工作', name: '工作' })
    // current 不动与归一成功是两件事，两件都要成立：
    assert.deepEqual(fresh.listPersonas().map((item) => item.slug), ['default', '工作'])
    assert.equal((await stat(join(personasRoot, 'default'))).isDirectory(), true)
    await assert.rejects(stat(join(personasRoot, 'Default')), (error) => error.code === 'ENOENT')
    // 「工作」的目录与内容分毫未动。
    assert.equal(await readFile(join(personasRoot, '工作/soul.md'), 'utf8'), '# 人格 (soul)\n\n- 工作人格\n')
    assert.ok(!warnings.some((line) => line.includes('conflict')))
    await fresh.dispose()
  })

  test('扫描豁免只认 .default-migrating- 前缀：临时目录不会变成幽灵人设', async () => {
    // 归一崩溃可能把临时目录留在原地。它不是人设，不许被登记进面板。
    await seedDir(join(personasRoot, '.default-migrating-a1b2c3d4'), { name: '看起来像人设', createdAt: '2026-11-10T01:00:00.000Z' })
    await seedPersonaDir('工作', { name: '工作', createdAt: '2026-11-10T02:00:00.000Z' })

    const fresh = makeStore()
    await fresh.ready
    assert.deepEqual(fresh.listPersonas().map((item) => item.slug), ['工作'])
    assert.deepEqual((await readRegistry()).personas.map((item) => item.slug), ['工作'])
    // 目录本身留在原地：豁免是「不登记」，不是「删掉」——归一恢复还要靠它。
    assert.equal((await stat(join(personasRoot, '.default-migrating-a1b2c3d4'))).isDirectory(), true)
    await fresh.dispose()
  })

  test('豁免不许扩大：..-..-etc 这种点开头的合法人设照旧登记', async () => {
    // personaSlug('../../etc') 产出 '..-..-etc' —— 合法 slug 且以点开头。
    // 谁把豁免改成「跳过所有点号开头的目录」，这条就红在谁脸上：那等于让真人设凭空消失。
    await seedPersonaDir('..-..-etc', { name: '../../etc', createdAt: '2026-11-10T01:00:00.000Z' }, '# 人格 (soul)\n\n- 越界名字的人设\n')
    await seedDir(join(personasRoot, '.default-migrating-x'), { name: '临时', createdAt: '2026-11-10T02:00:00.000Z' })

    const fresh = makeStore()
    await fresh.ready
    assert.deepEqual(fresh.listPersonas().map((item) => item.slug), ['..-..-etc'])
    assert.deepEqual((await readRegistry()).personas.map((item) => item.slug), ['..-..-etc'])
    // 顺带确认它被当成正常人设对待：current 为空时被补位成它。
    assert.deepEqual(fresh.currentPersona(), { slug: '..-..-etc', name: '../../etc' })
    await fresh.dispose()
  })

  test('复查兜底：rename 不抛错但磁盘名仍是大写时，注册表条目绝不跟着改', async () => {
    const soul = '# 人格 (soul)\n\n- 存量内容\n'
    await seedPersonaDir('Default', { name: 'Default', createdAt: '2026-11-10T01:00:00.000Z' }, soul)
    const snapshot = {
      version: 1,
      current: 'Default',
      personas: [{ slug: 'Default', name: 'Default', createdAt: '2026-11-10T01:00:00.000Z' }],
    }
    await writeRegistry(snapshot)

    const fresh = makeStore({
      foldProbe: (names) => {
        // 前提自证（Linux 上 rename 其实成功了）：兜底**不是**因为改名失败才触发的，
        // 而是复查说「磁盘上没有恰好叫 default 的名字」。少了这两行，这条用例是假绿。
        assert.ok(names.includes('default'), '前提：本机 rename 真的落到了小写名上')
        return false // 模拟 macOS APFS：rename 被判等而静默无效，磁盘名仍是 Default
      },
    })
    await fresh.ready
    // 注册表一字未改 ⇒ 不会出现「条目写 default、磁盘还是 Default」，下次扫盘也就多不出一行重复。
    assert.deepEqual(await readRegistry(), snapshot)
    assert.deepEqual(fresh.listPersonas().map((item) => item.slug), ['Default'])
    assert.ok(warnings.some((line) => line.includes("still not named 'default'")))
    await fresh.dispose()
  })

  test('复查兜底的磁盘恢复：残留的临时目录被改回原变体名，内容一个不丢', async () => {
    // 模拟上次归一崩在中途：磁盘上既有 Default（本轮要归一的），又有 .default-migrating-zzz。
    // 复查判失败后，恢复逻辑必须把临时名 rename 回 Default —— 是改名，绝不 rm。
    await seedPersonaDir('Default', { name: 'Default', createdAt: '2026-11-10T01:00:00.000Z' })
    await seedDir(join(personasRoot, '.default-migrating-zzz'), { name: 'Default', createdAt: '2026-11-10T01:00:00.000Z' }, '# 人格 (soul)\n\n- 崩溃前写下的内容\n')
    await writeRegistry({
      version: 1,
      current: 'Default',
      personas: [{ slug: 'Default', name: 'Default', createdAt: '2026-11-10T01:00:00.000Z' }],
    })

    const fresh = makeStore({ foldProbe: () => false })
    await fresh.ready
    assert.equal((await readdir(personasRoot)).some((name) => name.startsWith('.default-migrating-')), false)
    assert.equal(
      await readFile(join(personasRoot, 'Default/soul.md'), 'utf8'),
      '# 人格 (soul)\n\n- 崩溃前写下的内容\n',
    )
    assert.deepEqual((await readRegistry()).personas.map((item) => item.slug), ['Default'])
    await fresh.dispose()
  })

  test('⑤ 归一之后 deletePersona("Default") 仍然 PERSONA_PROTECTED（跨版本守网）', async () => {
    await seedPersonaDir('Default', { name: 'Default', createdAt: '2026-11-10T01:00:00.000Z' }, '# 人格 (soul)\n\n- 默认人格\n')

    const fresh = makeStore()
    await fresh.ready
    assert.deepEqual(fresh.listPersonas().map((item) => item.slug), ['default'])

    for (const slug of ['Default', 'default', 'DEFAULT']) {
      const result = await fresh.deletePersona(slug)
      assert.equal(result.ok, false, slug)
      assert.equal(result.code, 'PERSONA_PROTECTED', slug)
    }
    assert.equal((await stat(join(personasRoot, 'default'))).isDirectory(), true)
    assert.equal((await stat(join(personasRoot, 'default/soul.md'))).isFile(), true)
    assert.deepEqual(fresh.listPersonas().map((item) => item.slug), ['default'])
    await fresh.dispose()
  })

  test('⑥ 归一排在扫盘合并之前：注册表不会同时出现 Default 与 default', async () => {
    // 注册表里什么都没有（条目全靠扫描登记）——归一若排在合并之后，
    // 会先按大写塞进一个条目、再把目录改名，终态留下对不上的条目。
    await seedPersonaDir('Default', { name: 'Default', createdAt: '2026-11-10T01:00:00.000Z' }, '# 人格 (soul)\n\n- x\n')
    await seedPersonaDir('工作', { name: '工作', createdAt: '2026-11-10T02:00:00.000Z' })

    const fresh = makeStore()
    await fresh.ready
    const registry = await readRegistry()
    assert.deepEqual(registry.personas.map((item) => item.slug), ['default', '工作'])
    assert.equal(registry.personas.filter((item) => isDefaultLike(item.slug)).length, 1)
    assert.equal(registry.personas.some((item) => /[A-Z]/.test(item.slug)), false) // 没有大写残留条目
    assert.equal(registry.personas[0].name, 'Default') // 显示名照旧
    assert.equal(registry.current, 'default') // current 补位时也落在小写上
    await fresh.dispose()
  })

  test('legacy 迁移把 Default 搬进来时，defaultCurrent 跟着归一，current 不漂到别的人设', async () => {
    // 迁移首选取 migrated[0]（这里是 Default）。归一把它改名成 default 之后，
    // 若不映射 preferred，逐字比较会 miss 并回退「createdAt 最早」——current 就漂到 工作 上了。
    await seedLegacyDir('Default', { name: 'Default', createdAt: '2026-11-10T09:00:00.000Z' })
    await seedLegacyDir('工作', { name: '工作', createdAt: '2026-11-10T01:00:00.000Z' })

    const fresh = makeStore()
    await fresh.ready
    assert.deepEqual(fresh.listPersonas().map((item) => item.slug), ['工作', 'default'])
    assert.equal((await readRegistry()).current, 'default')
    assert.deepEqual(fresh.currentPersona(), { slug: 'default', name: 'Default' })
    assert.equal((await stat(join(personasRoot, 'default'))).isDirectory(), true)
    await fresh.dispose()
  })
})

describe('插件设置（v2）', () => {
  test('默认值：文件不存在 → enabled 开启 + 空 provider/model', () => {
    assert.deepEqual(store.readSettings(), { enabled: true, digestProvider: '', digestModel: '' })
  })

  test('写入后可读回，并持久化到 settings.json', async () => {
    const written = await store.writeSettings({ digestProvider: 'provider-a', digestModel: 'model-a' })
    assert.equal(written.ok, true)
    assert.deepEqual(written.settings, { enabled: true, digestProvider: 'provider-a', digestModel: 'model-a' })
    assert.deepEqual(store.readSettings(), { enabled: true, digestProvider: 'provider-a', digestModel: 'model-a' })

    const raw = JSON.parse(await readFile(join(dshHome, 'supermemory/settings.json'), 'utf8'))
    assert.equal(raw.version, 1)
    assert.equal(raw.enabled, true)
    assert.equal(raw.digestProvider, 'provider-a')
    assert.equal(raw.digestModel, 'model-a')

    const fresh = makeStore()
    await fresh.ready
    assert.deepEqual(fresh.readSettings(), { enabled: true, digestProvider: 'provider-a', digestModel: 'model-a' })
    await fresh.dispose()
  })

  test('只接受 enabled / digestProvider / digestModel；其它键与类型不符值被忽略', async () => {
    await store.writeSettings({ digestProvider: 'p', digestModel: 'm' })
    const written = await store.writeSettings({ digestProvider: 42, digestModel: ' m2 ', evil: 'x' })
    assert.equal(written.ok, true)
    assert.deepEqual(written.settings, { enabled: true, digestProvider: 'p', digestModel: 'm2' })

    const raw = JSON.parse(await readFile(join(dshHome, 'supermemory/settings.json'), 'utf8'))
    assert.deepEqual(Object.keys(raw).sort(), ['digestModel', 'digestProvider', 'enabled', 'version'])
    assert.equal(raw.evil, undefined)
  })

  test('坏 JSON 不炸：读回默认值，仍可写入覆盖', async () => {
    await mkdir(join(dshHome, 'supermemory'), { recursive: true })
    await writeFile(join(dshHome, 'supermemory/settings.json'), '{not json', 'utf8')
    const fresh = makeStore()
    await fresh.ready
    assert.deepEqual(fresh.readSettings(), { enabled: true, digestProvider: '', digestModel: '' })
    const written = await fresh.writeSettings({ digestProvider: 'p', digestModel: 'm' })
    assert.equal(written.ok, true)
    assert.deepEqual(fresh.readSettings(), { enabled: true, digestProvider: 'p', digestModel: 'm' })
    await fresh.dispose()
  })

  test('patch 非对象 → BAD_INPUT', async () => {
    for (const bad of [null, 'x', 42, ['a']]) {
      const result = await store.writeSettings(bad)
      assert.equal(result.ok, false)
      assert.equal(result.code, 'BAD_INPUT')
    }
  })

  test('enabled 默认开启：文件不存在时为 true', () => {
    assert.equal(store.readSettings().enabled, true)
  })

  test('写 enabled:false → 读回 false 且落盘，重开 store 仍为 false', async () => {
    const written = await store.writeSettings({ enabled: false })
    assert.equal(written.ok, true)
    assert.equal(written.settings.enabled, false)
    assert.equal(store.readSettings().enabled, false)

    const raw = JSON.parse(await readFile(join(dshHome, 'supermemory/settings.json'), 'utf8'))
    assert.equal(raw.enabled, false)
    assert.deepEqual(Object.keys(raw).sort(), ['digestModel', 'digestProvider', 'enabled', 'version'])

    const fresh = makeStore()
    await fresh.ready
    assert.equal(fresh.readSettings().enabled, false)
    await fresh.dispose()
  })

  test('enabled 关掉后可再开回 true 并落盘', async () => {
    await store.writeSettings({ enabled: false })
    const written = await store.writeSettings({ enabled: true })
    assert.equal(written.ok, true)
    assert.equal(written.settings.enabled, true)
    assert.equal(store.readSettings().enabled, true)
    const raw = JSON.parse(await readFile(join(dshHome, 'supermemory/settings.json'), 'utf8'))
    assert.equal(raw.enabled, true)
  })

  test('enabled 非布尔值忽略：保持当前值不被关闭', async () => {
    for (const bad of ['false', 'true', 0, 1, null, undefined, {}, []]) {
      const written = await store.writeSettings({ enabled: bad })
      assert.equal(written.ok, true)
      assert.equal(written.settings.enabled, true, `应忽略非法 enabled: ${String(bad)}`)
    }
    assert.equal(store.readSettings().enabled, true)
    const raw = JSON.parse(await readFile(join(dshHome, 'supermemory/settings.json'), 'utf8'))
    assert.equal(raw.enabled, true)
  })

  test('settings.json 坏 JSON → enabled 回退 true，绝不因异常关闭插件', async () => {
    await mkdir(join(dshHome, 'supermemory'), { recursive: true })
    await writeFile(join(dshHome, 'supermemory/settings.json'), '{"enabled":false,"digestProvider":"p"', 'utf8')
    const fresh = makeStore()
    await fresh.ready
    assert.deepEqual(fresh.readSettings(), { enabled: true, digestProvider: '', digestModel: '' })
    await fresh.dispose()
  })

  test('旧版文件缺 enabled 键 → 默认开启且保留已配置模型', async () => {
    await mkdir(join(dshHome, 'supermemory'), { recursive: true })
    await writeFile(
      join(dshHome, 'supermemory/settings.json'),
      JSON.stringify({ version: 1, digestProvider: 'p', digestModel: 'm' }),
      'utf8',
    )
    const fresh = makeStore()
    await fresh.ready
    assert.deepEqual(fresh.readSettings(), { enabled: true, digestProvider: 'p', digestModel: 'm' })
    await fresh.dispose()
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
    assert.deepEqual(bad.readSettings(), { enabled: true, digestProvider: '', digestModel: '' })
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
