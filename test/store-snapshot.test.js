/**
 * 落盘前快照单测：命名、逐字节、目录创建、裁剪、与写锁的串行关系
 * （契约 §V4.0.5 + §V4.0.7 的 `test/store-snapshot.test.js`）。
 *
 * 快照的唯一使命是「整编把 project 记忆整篇重写之前，先把原文原样留一份」，
 * 所以本文件的断言重点全在**能不能一模一样还原**与**裁剪会不会误删**上。
 *
 * 运行：node --test test/store-snapshot.test.js
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'

import { createStore } from '../lib/core/store.js'
import { pruneSnapshotNames, snapshotFileName, snapshotStamp } from '../lib/core/store-normalize.js'

/** 临时目录一律建在系统 tmpdir 下，after 里整体删掉，不碰项目内的 .dsh/。 */
let scratchRoot
let dshHome
let personasRoot
let projectRoot
let store
let warnings
/** 注入的时钟：连续快照靠它保证时间戳严格递增（同一毫秒内先后由随机后缀决定，字典序不可控）。 */
let clock

const CLOCK_BASE = 1762758000000 // 2025-11-10T07:00:00.000Z

before(async () => {
  scratchRoot = await mkdtemp(join(tmpdir(), 'supermemory-snapshot-'))
})

after(async () => {
  await rm(scratchRoot, { recursive: true, force: true })
})

beforeEach(async () => {
  const base = await mkdtemp(join(scratchRoot, 'case-'))
  dshHome = join(base, 'dsh')
  personasRoot = join(dshHome, 'supermemory', 'personas')
  projectRoot = join(base, 'project')
  await mkdir(projectRoot, { recursive: true })
  warnings = []
  clock = CLOCK_BASE
  store = makeStore()
  await store.ready
})

/** 用当前用例的目录造一个 store（时钟可被覆盖，用于测非法时钟）。 */
function makeStore(overrides = {}) {
  return createStore({
    dshHome,
    config: { projectDirName: '.dsh/memory', projectFileName: 'project-memory.md' },
    logger: { warn: (...args) => warnings.push(args.join(' ')), info: () => {} },
    now: () => clock,
    ...overrides,
  })
}

const projectRef = () => ({ kind: 'project', projectRoot })
const soulRef = () => ({ kind: 'soul', persona: 'default' })

/** 时钟推一格，保证下一份快照的时间戳更大。 */
function advance(ms = 1000) {
  clock += ms
}

/** 连写 count 份快照（时间戳递增），返回各自的返回值。 */
async function snapshotTimes(count, keep) {
  const results = []
  for (let index = 0; index < count; index += 1) {
    advance(1000)
    results.push(await store.writeDocSnapshot(projectRef(), `原文第 ${index} 版\n`, keep))
  }
  return results
}

/** 列目录（升序）。 */
async function listDir(dir) {
  return (await readdir(dir)).sort()
}

/** 从快照文件名里取时间戳段。 */
function stampOf(name) {
  const matched = String(name).match(/-(\d{8}T\d{6}Z)-/)
  return matched ? matched[1] : ''
}

describe('快照命名与位置', () => {
  test('首次快照建出 history/ 并按契约命名，内容读回一致', async () => {
    const original = '# 项目记忆\n\n- 2026-11-10T10:00:00.000Z · source:digest · id:a3f2c 旧内容\n'
    await store.writeDoc(projectRef(), original)

    const result = await store.writeDocSnapshot(projectRef(), original)
    assert.equal(result.ok, true)

    // 位置：文档同目录的 history/。
    const docPath = store.docPath(projectRef())
    assert.equal(dirname(result.path), join(dirname(docPath), 'history'))
    // 文件名：<原文件名去扩展>-<yyyyMMdd'T'HHmmss'Z'>-<4hex>.md
    assert.match(basename(result.path), /^project-memory-20251110T070000Z-[0-9a-f]{4}\.md$/)
    assert.deepEqual(await listDir(dirname(result.path)), [basename(result.path)])
    assert.equal(await readFile(result.path, 'utf8'), original)
  })

  test('时间戳取自注入的时钟：推一格就是新的一份', async () => {
    const first = await store.writeDocSnapshot(projectRef(), 'v1\n')
    assert.match(basename(first.path), /-20251110T070000Z-[0-9a-f]{4}\.md$/)

    advance(3600_000)
    const second = await store.writeDocSnapshot(projectRef(), 'v2\n')
    assert.equal(second.ok, true)
    assert.match(basename(second.path), /-20251110T080000Z-[0-9a-f]{4}\.md$/)
    assert.notEqual(second.path, first.path)
    assert.equal(stampOf(basename(first.path)) < stampOf(basename(second.path)), true, '字典序须等于时间序')
  })

  test('soul 文档的快照落在人设目录下的 history/', async () => {
    const result = await store.writeDocSnapshot(soulRef(), '人格原文\n')
    assert.equal(result.ok, true)
    assert.equal(dirname(result.path), join(personasRoot, 'default', 'history'))
    assert.match(basename(result.path), /^soul-20251110T070000Z-[0-9a-f]{4}\.md$/)
  })

  test('逐字节还原：BOM / CRLF / 尾随空格 / 无尾换行一个都不被改写', async () => {
    const raw = '\uFEFF# 项目记忆\r\n\r\n尾随空格   \r\n这一行没有换行符'
    const result = await store.writeDocSnapshot(projectRef(), raw)
    assert.equal(result.ok, true)

    const onDisk = await readFile(result.path)
    assert.equal(onDisk.equals(Buffer.from(raw, 'utf8')), true, '快照必须逐字节可还原')
    assert.equal(onDisk.length, Buffer.byteLength(raw, 'utf8'))
  })

  test('空串是合法内容，落一个 0 字节快照', async () => {
    const result = await store.writeDocSnapshot(projectRef(), '')
    assert.equal(result.ok, true)
    assert.equal((await stat(result.path)).size, 0)
  })

  test('文档文件本身还不存在时也能留底（空模板场景）', async () => {
    const docPath = store.docPath(projectRef())
    await assert.rejects(stat(docPath), (error) => error.code === 'ENOENT')

    const result = await store.writeDocSnapshot(projectRef(), '# 项目记忆\n\n空模板\n')
    assert.equal(result.ok, true)
    assert.equal(await readFile(result.path, 'utf8'), '# 项目记忆\n\n空模板\n')
    // 只创建了 history/ 与快照，没有偷偷写文档本身。
    await assert.rejects(stat(docPath), (error) => error.code === 'ENOENT')
  })
})

describe('参数与失败路径（一律返回错误对象，不抛）', () => {
  test('ref 非法 → ok:false + error，不建目录', async () => {
    for (const bad of [null, undefined, 'x', { kind: 'nope' }, { kind: 'project' }, { kind: 'project', projectRoot: 'rel' }]) {
      const result = await store.writeDocSnapshot(bad, 'x')
      assert.equal(result.ok, false)
      assert.equal(typeof result.error, 'string')
      assert.ok(result.error.length > 0)
    }
    await assert.rejects(stat(join(projectRoot, '.dsh')), (error) => error.code === 'ENOENT')
  })

  test('content 非字符串 → ok:false + error', async () => {
    for (const bad of [null, undefined, 42, {}, [], Buffer.from('x'), new Uint8Array(2)]) {
      const result = await store.writeDocSnapshot(projectRef(), bad)
      assert.equal(result.ok, false)
      assert.match(result.error, /content must be a string/)
    }
    await assert.rejects(stat(join(projectRoot, '.dsh')), (error) => error.code === 'ENOENT')
  })

  test('时钟返回非法值 → ok:false，不落盘', async () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 'not-a-clock', undefined]) {
      const broken = makeStore({ now: () => bad })
      await broken.ready
      const result = await broken.writeDocSnapshot(soulRef(), 'x')
      assert.equal(result.ok, false, `非法时钟应被拒：${String(bad)}`)
      assert.equal(typeof result.error, 'string')
      await broken.dispose()
    }
  })

  test('目录创建失败 → ok:false 而不是抛错', async () => {
    const blocker = join(scratchRoot, `blocker-${Date.now()}`)
    await writeFile(blocker, 'not a directory', 'utf8')
    const broken = makeStore({ personasRoot: join(blocker, 'personas') })
    await broken.ready
    const result = await broken.writeDocSnapshot(soulRef(), '原文\n')
    assert.equal(result.ok, false)
    assert.equal(typeof result.error, 'string')
    await broken.dispose()
  })
})

describe('裁剪：保留最近 keep 份', () => {
  test('不足 keep 份：一份都不删', async () => {
    const results = await snapshotTimes(2)
    for (const result of results) {
      assert.equal(result.ok, true)
      assert.deepEqual(result.removed, [])
    }
    const dir = join(projectRoot, '.dsh/memory/history')
    assert.equal((await listDir(dir)).length, 2)
  })

  test('恰好 keep 份：仍不删', async () => {
    const results = await snapshotTimes(3)
    assert.deepEqual(results[2].removed, [])
    const dir = join(projectRoot, '.dsh/memory/history')
    assert.equal((await listDir(dir)).length, 3)
  })

  test('超出：删最旧的那份，且 removed 里的路径确实从磁盘消失', async () => {
    const results = await snapshotTimes(5) // 默认 keep=3
    assert.deepEqual(results[2].removed, [])

    // 第 4 次挤出第 1 次，第 5 次挤出第 2 次。
    assert.deepEqual(results[3].removed, [results[0].path])
    assert.deepEqual(results[4].removed, [results[1].path])
    for (const gone of [...results[3].removed, ...results[4].removed]) {
      await assert.rejects(stat(gone), (error) => error.code === 'ENOENT', `${gone} 应已删除`)
    }

    const dir = join(projectRoot, '.dsh/memory/history')
    const left = await listDir(dir)
    assert.equal(left.length, 3)
    assert.deepEqual(left, [basename(results[2].path), basename(results[3].path), basename(results[4].path)])
    assert.deepEqual(left.map(stampOf), ['20251110T070003Z', '20251110T070004Z', '20251110T070005Z'])
  })

  test('keep=1：只留最新一份', async () => {
    const results = await snapshotTimes(3, 1)
    assert.deepEqual(results[0].removed, [])
    assert.deepEqual(results[1].removed, [results[0].path])
    assert.deepEqual(results[2].removed, [results[1].path])

    const dir = join(projectRoot, '.dsh/memory/history')
    assert.deepEqual(await listDir(dir), [basename(results[2].path)])
    assert.equal(await readFile(results[2].path, 'utf8'), '原文第 2 版\n')
  })

  test('keep 非法回退 3；小于 1 钳到 1（不会把刚写的快照删掉）', async () => {
    const loose = await snapshotTimes(5, '2')
    assert.deepEqual(loose[4].removed.length, 1, '字符串 keep 视作非法 → 按默认 3 裁，每轮只挤出最旧一份')
    assert.equal((await listDir(join(projectRoot, '.dsh/memory/history'))).length, 3)

    const tight = await snapshotTimes(3, 0)
    assert.equal(tight[2].removed.length, 1)
    const left = await listDir(join(projectRoot, '.dsh/memory/history'))
    assert.deepEqual(left, [basename(tight[2].path)])

    const nonsense = await snapshotTimes(2, Number.NaN)
    assert.deepEqual(nonsense.map((item) => item.removed.length), [0, 0])
  })

  test('history/ 里混入的文件不误删', async () => {
    const dir = join(projectRoot, '.dsh/memory/history')
    await mkdir(dir, { recursive: true })
    const strangers = [
      'README.md',
      'project-memory-notes.md',
      'project-memory-2025-11-10T07Z-abcd.md', // 时间戳段格式不对
      'project-memory-20251110T070000Z-ZZZZ.md', // 后缀不是小写 hex
      '.hidden.tmp',
    ]
    for (const name of strangers) await writeFile(join(dir, name), '无关文件\n', 'utf8')

    const results = await snapshotTimes(4, 2)
    assert.deepEqual(results[3].removed.length, 1, '每轮裁到 2 份：第 4 次挤出当轮最旧那份')
    const left = await listDir(dir)
    for (const name of strangers) assert.ok(left.includes(name), `误删了 ${name}`)
    assert.equal(left.filter((name) => /-\d{8}T\d{6}Z-[0-9a-f]{4}\.md$/.test(name)).length, 2)
    for (const removed of [...results[2].removed, ...results[3].removed]) {
      await assert.rejects(stat(removed), (error) => error.code === 'ENOENT')
    }
  })

  test('符合命名的旧文件（哪怕不是本次写的）参与裁剪', async () => {
    const dir = join(projectRoot, '.dsh/memory/history')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'project-memory-20200101T000000Z-0000.md'), '很久以前\n', 'utf8')

    const result = await store.writeDocSnapshot(projectRef(), '新原文\n', 1)
    assert.equal(result.ok, true)
    assert.deepEqual(result.removed, [join(dir, 'project-memory-20200101T000000Z-0000.md')])
    assert.deepEqual(await listDir(dir), [basename(result.path)])
  })
})

describe('与既有写操作共用同一把锁', () => {
  test('快照与 writeDoc 并发：全部成功、互不踩踏', async () => {
    const jobs = []
    for (let index = 0; index < 4; index += 1) {
      advance(1000)
      jobs.push(store.writeDocSnapshot(projectRef(), `snap-${index}\n`, 20))
      jobs.push(store.writeDoc(projectRef(), `# 项目记忆\n\n正文 ${index}\n`))
    }
    const results = await Promise.all(jobs)
    for (const result of results) assert.equal(result.ok, true)

    const dir = join(projectRoot, '.dsh/memory/history')
    assert.equal((await listDir(dir)).length, 4)
    // 文档仍是最后一次 writeDoc 的完整内容，没被快照影响。
    const read = await store.readDoc(projectRef())
    assert.match(read.content, /^# 项目记忆\n\n正文 3\n$/)
    // 每份快照内容完整，没出现半写。
    for (const name of await listDir(dir)) {
      const content = await readFile(join(dir, name), 'utf8')
      assert.match(content, /^snap-\d\n$/)
    }
  })

  test('快照排在它保护的那次 writeDoc 之前（同一队列，顺序稳定）', async () => {
    const original = '# 项目记忆\n\n旧内容\n'
    await store.writeDoc(projectRef(), original)

    const snapshot = store.writeDocSnapshot(projectRef(), original)
    const rewrite = store.writeDoc(projectRef(), '# 项目记忆\n\n整编后\n')
    const [first, second] = await Promise.all([snapshot, rewrite])

    assert.equal(first.ok, true)
    assert.equal(second.ok, true)
    assert.equal(await readFile(first.path, 'utf8'), original)
    assert.equal((await store.readDoc(projectRef())).content, '# 项目记忆\n\n整编后\n')
  })
})

describe('命名与裁剪的纯函数（store-normalize）', () => {
  test('snapshotStamp：紧凑 UTC 定长 15 字符，非法一律空串', () => {
    assert.equal(snapshotStamp(CLOCK_BASE), '20251110T070000Z')
    assert.equal(snapshotStamp(CLOCK_BASE + 1000), '20251110T070001Z')
    assert.equal(snapshotStamp(0), '19700101T000000Z')
    for (const bad of [NaN, Infinity, undefined, null, '1762758000000', {}, 8.64e15 + 1]) {
      assert.equal(snapshotStamp(bad), '', `应拒绝：${String(bad)}`)
    }
  })

  test('snapshotFileName：剥目录与 .md 扩展、随机串截 4 位', () => {
    assert.equal(
      snapshotFileName('/a/b/project-memory.md', CLOCK_BASE, 'a1b2c3d4'),
      'project-memory-20251110T070000Z-a1b2.md',
    )
    assert.equal(snapshotFileName('soul.MD', CLOCK_BASE, 'ff00'), 'soul-20251110T070000Z-ff00.md')
    assert.equal(snapshotFileName('global-memory.md', CLOCK_BASE, 'ab12'), 'global-memory-20251110T070000Z-ab12.md')
    assert.equal(snapshotFileName('.md', CLOCK_BASE, 'ab12'), 'memory-20251110T070000Z-ab12.md')
    // 随机串不足 4 位就原样用，超了截断；时间戳非法一律空串。
    assert.equal(snapshotFileName('soul.md', CLOCK_BASE, 'ab'), 'soul-20251110T070000Z-ab.md')
    assert.equal(snapshotFileName('soul.md', Number.NaN, 'abcd'), '')
  })

  test('pruneSnapshotNames：排序、外来回退、混入项不参与', () => {
    const names = [
      'project-memory-20251110T070003Z-0003.md',
      'project-memory-20251110T070001Z-0001.md',
      'notes.txt',
      'project-memory-20251110T070002Z-0002.md',
    ]
    assert.deepEqual(pruneSnapshotNames(names, 2), {
      keep: ['project-memory-20251110T070002Z-0002.md', 'project-memory-20251110T070003Z-0003.md'],
      removed: ['project-memory-20251110T070001Z-0001.md'],
    })
    // 不足与恰好：都不删。
    assert.deepEqual(pruneSnapshotNames(names, 3).removed, [])
    assert.deepEqual(pruneSnapshotNames(names, 9).removed, [])
    // 非法 keep：字符串/NaN 回退默认 3，负数与 0 钳到 1。
    assert.equal(pruneSnapshotNames(names, '1').keep.length, 3)
    assert.equal(pruneSnapshotNames(names, '1').removed.length, 0)
    assert.equal(pruneSnapshotNames(names, Number.NaN).keep.length, 3)
    assert.deepEqual(pruneSnapshotNames(names, 0), {
      keep: ['project-memory-20251110T070003Z-0003.md'],
      removed: ['project-memory-20251110T070001Z-0001.md', 'project-memory-20251110T070002Z-0002.md'],
    })
    assert.deepEqual(pruneSnapshotNames(names, -5).removed.length, 2)
    // 非数组入参一律当作空目录。
    assert.deepEqual(pruneSnapshotNames(undefined, 3), { keep: [], removed: [] })
    assert.deepEqual(pruneSnapshotNames('abc', 3), { keep: [], removed: [] })
    assert.deepEqual(pruneSnapshotNames([1, null, {}, 'x.md'], 3), { keep: [], removed: [] })
  })
})
