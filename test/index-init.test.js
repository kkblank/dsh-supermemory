/**
 * 插件入口的默认人设初始化自测（契约 §V6.4 的 ⑦⑧⑨ 三条，外加 ⑧b 与 ⑩）。
 *
 * **为什么值得单独开一个文件**：本仓此前**没有任何测试 import 过 `lib/index.js`**——
 * 既有的 test/host-install.test.js 是「绕过入口」的装配测试（它自己 createStore，再直接
 * 装 installInjection / installTools / installCommands），入口里那段「装各能力之前先把
 * 默认人设建出来」的逻辑从来没被执行过。默认人设是整个插件的地基：它不存在时
 * resolveScope 会静默回退 'default'，面板下拉是空的，legacy 迁移后 current 还会悬空。
 * 所以这三条用例守的是入口层，不是 store 层。
 *
 * 覆盖（契约 §V6.2 / §V6.4）：
 *   ⑦  空环境启动 → 建出 `slug==='default'` 且 `name==='Default'`，并接管 current。
 *   ⑧  列表非空但没有默认人设（legacy 迁移后的存量环境）→ 仍然补建，
 *      **且 current 仍是用户正在用的那个**（§V6.2 铁律：不许把人设悄悄换掉）。
 *   ⑧b current 指向不存在的人设（悬空，§V5.8 第 2 条的原始症状）→ 补建并接管。
 *   ⑨  已有默认人设 → 不重复建；含「只有大写 Default」子场景（守 §V6.0 的判断宽松）。
 *   ⑩  真跑一次 apply()：不抛、零告警、空环境最终出现默认人设（装配链路真实性）。
 *
 * 等待策略：⑦⑧⑧b⑨ 直接 `await ensureDefaultPersona(store, logger)`，零轮询零静置；
 * 只有 ⑩ 因为要走 apply 内部那个 fire-and-forget 调用而允许轮询（实测 22ms 命中，超时 3s）。
 *
 * 夹具用**真实形态**的数据：默认人设 slug 小写、显示名 `Default`；普通人设用中文名 `工作`
 * （`personaSlug` 原样保留中文，实测 slug 就是 `工作`）。mock 不真实是 v5 那次
 * 「🗑 在真机上永不禁用」的根因，这里不再犯第二次。
 *
 * 运行：node --test test/index-init.test.js
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from '../lib/core/store.js'
import { resolveConfig } from '../lib/host/config.js'
import { apply, ensureDefaultPersona } from '../lib/index.js'

/** 默认人设的两个形态：v6 之后 slug 恒为小写，显示名恒为 `Default`。 */
const DEFAULT_SLUG = 'default'
const DEFAULT_NAME = 'Default'

/**
 * 精简版假 ctx——只做入口装配真正会碰的四件事。
 *
 * 精简自 test/host-install.test.js 的 `makeCtx`，刻意**不搬** `makeSession` 那套 surface
 * 强校验：入口只注册 `agent/created` / `agent/pre-step` / `session/event` 三个监听，
 * 宿主服务（session、workspaceRegistry……）全部只在事件回调里被 `ctx.get`
 * 取用，本文件不触发任何事件，所以 `get()` 一律返回 undefined 就够（已实测 apply 不抛、
 * 零告警）。搬 90 行 session 假实现过来纯属死重。
 *
 * 唯一的例外是 `webServer`：它写在入口的 `inject` 里，框架能调到 `apply` 就意味着它
 * 已经就绪，所以假 ctx 必须给一个能注册路由的实现——否则 `installRoutes` 会照常告警，
 * 「装配全程零告警」那条断言就成了在测试一个不可能的场景。
 *
 * 两份 makeCtx 各自独立、不跨测试文件 import：一个文件挂掉不该连带挂另一个。
 *
 * @returns {object} 假 ctx 与 warnings 收集数组。
 */
function makeCtx() {
  const warnings = []
  const events = []
  const ctx = {
    logger: {
      warn: (...args) => warnings.push(args.map(String).join(' ')),
      info: () => {},
    },
    get(name) {
      // webServer 是 inject 硬依赖，见上方注释：给一个能注册路由的最小实现。
      if (name === 'webServer') return { register: () => () => {} }
      return undefined
    },
    on: (event) => {
      events.push(event)
      return () => {}
    },
    effect: (fn) => fn(),
    warnings,
    events,
  }
  return ctx
}

/**
 * 一个隔离的 `$DSH_HOME/supermemory/`。
 *
 * 为什么必须动 `process.env.DSH_HOME`：`store.js` 里 `stateDir = join(dshHome, 'supermemory')`，
 * settings.json / runs.jsonl / projects 都落在那儿。只往 config 传 `personasRoot` 挡不住
 * （它只管人设目录），不设 env 就会往真实的 `~/.dsh` 写——那是 WORKER.md 的铁律禁区。
 * 照 test/paths-document.test.js 的写法在 finally 里恢复原值（原本没有就 delete）。
 *
 * @param {(home: string, personasRoot: string) => Promise<void>} run - 用例体。
 * @returns {Promise<void>} 完成即可。
 */
async function withHome(run) {
  const previous = process.env.DSH_HOME
  const home = await mkdtemp(join(tmpdir(), 'sm-init-'))
  process.env.DSH_HOME = home
  try {
    await run(home, join(home, 'supermemory', 'personas'))
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    // apply 造的 store 没有句柄可 dispose，末尾可能仍有写在途；清理失败不该让用例红。
    await rm(home, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * 造一个指向该 home 的 store（配置口径与 apply 内部一致）。
 *
 * 刻意**不传任何测试专用选项**（例如 store 为归一化复查准备的 `foldProbe`）：本文件守的
 * 是「真实装配下默认人设到底有没有建对」，一旦从这儿注入假象，测的就不是生产行为。
 * 归一化复查那条路归 store.test.js 管，两边别互相借道。
 *
 * @param {string} home - DSH 家目录。
 * @param {string} personasRoot - 人设根目录。
 * @param {{warn: Function, info: Function}} logger - 日志器。
 * @returns {object} store。
 */
function makeStore(home, personasRoot, logger) {
  return createStore({
    dshHome: home,
    personasRoot,
    config: resolveConfig({ personasRoot }),
    logger,
  })
}

/**
 * 用**真实 store API** 预置环境（而不是手写 JSON），顺带验证这些路径与 v6 归一不冲突。
 * 必须 `dispose()` 之后再让被测代码另起 store：入口的 store 构造期会同步读注册表。
 *
 * @param {string} home - DSH 家目录。
 * @param {string} personasRoot - 人设根目录。
 * @param {{warn: Function, info: Function}} logger - 日志器。
 * @param {Array<{name: string, makeCurrent?: boolean}>} personas - 要预置的人设。
 * @returns {Promise<void>} 完成即可。
 */
async function seedPersonas(home, personasRoot, logger, personas) {
  const seed = makeStore(home, personasRoot, logger)
  try {
    await seed.ready
    for (const entry of personas) {
      const created = await seed.createPersona(entry.name)
      assert.equal(created?.ok, true, `预置人设「${entry.name}」必须成功：${JSON.stringify(created)}`)
      if (entry.makeCurrent === true) {
        const switched = await seed.setCurrentPersona(created.persona.slug)
        assert.equal(switched?.ok, true, `预置 current 必须成功：${JSON.stringify(switched)}`)
      }
    }
  } finally {
    await seed.dispose()
  }
}

/**
 * 读磁盘上的注册表原文（断言「落盘了什么」，不只看内存态）。
 * @param {string} home - DSH 家目录。
 * @returns {Promise<object>} personas.json 内容。
 */
async function readRegistry(home) {
  return JSON.parse(await readFile(join(home, 'supermemory', 'personas.json'), 'utf8'))
}

/**
 * 列人设目录名。
 * @param {string} personasRoot - 人设根目录。
 * @returns {Promise<string[]>} 目录名。
 */
async function personaDirs(personasRoot) {
  return readdir(personasRoot).catch(() => [])
}

/** 一份够用的假 logger，顺带收集告警。 */
function makeLogger() {
  const warnings = []
  return { warnings, logger: { warn: (...args) => warnings.push(args.map(String).join(' ')), info: () => {} } }
}

test('⑦ 空环境启动：建出 slug 小写 default、显示名 Default，并接管 current', async () => {
  await withHome(async (home, personasRoot) => {
    const { warnings, logger } = makeLogger()
    const store = makeStore(home, personasRoot, logger)

    const outcome = await ensureDefaultPersona(store, logger)

    // 返回值钉住分支：建了、接管了、slug 是**小写**（§V6.0 的根治点）、建成功时 reason 为空。
    assert.deepEqual(outcome, { created: true, tookOverCurrent: true, slug: DEFAULT_SLUG, reason: '' })

    const list = await store.listPersonas()
    assert.equal(list.length, 1, '空环境只该多出这一个默认人设')
    assert.equal(list[0].slug, DEFAULT_SLUG, 'slug 必须是小写 default')
    assert.equal(list[0].slug, list[0].slug.toLowerCase(), 'slug 不得含大写字母')
    // 显示名是产品承诺：面板上那一行看起来完全没变。只断言 slug 就会放过显示名回归。
    assert.equal(list[0].name, DEFAULT_NAME, '显示名必须仍是 Default')

    assert.deepEqual(store.currentPersona(), { slug: DEFAULT_SLUG, name: DEFAULT_NAME })
    const registry = await readRegistry(home)
    assert.equal(registry.current, DEFAULT_SLUG, '落盘的 current 也要是小写 default')
    assert.deepEqual(await personaDirs(personasRoot), [DEFAULT_SLUG], '目录必须是小写，不能是 Default')

    assert.deepEqual(warnings, [], '正常初始化不该有任何告警')
    await store.dispose()
  })
})

test('⑧ 存量环境（列表非空、没有默认人设）：补建默认人设，且 current 不许被换掉', async () => {
  // §V6.4 里 lead 特别点的那条：legacy 迁移后人设列表非空但没有默认人设，v5 的
  // `length === 0` 条件会整段跳过，current 就悬在半空。更要紧的是 v6 补建时若照旧
  // 无条件 setCurrentPersona，正用「工作」干活的人会被后台悄悄换成人格 default。
  await withHome(async (home, personasRoot) => {
    const { warnings, logger } = makeLogger()
    await seedPersonas(home, personasRoot, logger, [{ name: '工作', makeCurrent: true }])

    const store = makeStore(home, personasRoot, logger)
    const outcome = await ensureDefaultPersona(store, logger)

    assert.equal(outcome.created, true, '列表非空也要补建默认人设')
    assert.equal(outcome.slug, DEFAULT_SLUG)
    assert.equal(outcome.tookOverCurrent, false, 'current 是活人设时一律不许接管（§V6.2 铁律）')

    // 用户正在用的人设一个字节都没动。
    assert.deepEqual(store.currentPersona(), { slug: '工作', name: '工作' }, '当前人设必须还是「工作」')
    assert.equal((await readRegistry(home)).current, '工作', '落盘的 current 也必须还是「工作」')

    const list = await store.listPersonas()
    assert.deepEqual(
      list.map((item) => `${item.slug}/${item.name}`),
      ['工作/工作', 'default/Default'],
      '两个人设共存：用户自己的在前，补建的默认人设在后',
    )
    assert.deepEqual((await personaDirs(personasRoot)).sort(), [DEFAULT_SLUG, '工作'], '两个目录都在')

    assert.deepEqual(warnings, [], '正常补建不该有任何告警')
    await store.dispose()
  })
})

test('⑧b current 指向不存在的人设（悬空）：补建默认人设并接管', async () => {
  // §V6.2 铁律的另一半——「current 为空**或指向不存在的 slug**时才设」。
  // 悬空正是 §V5.8 第 2 条描述的原始症状（迁移完列表非空、current 却没人认得）。
  // 不测这半句，等于门控只实现了一半也没人发现。
  await withHome(async (home, personasRoot) => {
    const { warnings, logger } = makeLogger()
    await mkdir(personasRoot, { recursive: true })
    await mkdir(join(personasRoot, '工作'), { recursive: true })
    await writeFile(join(personasRoot, '工作', 'persona.json'), JSON.stringify({ name: '工作', createdAt: '2026-01-01T00:00:00.000Z' }))
    await writeFile(
      join(home, 'supermemory', 'personas.json'),
      JSON.stringify({
        version: 1,
        current: 'ghost', // 磁盘上没有任何东西配得上它
        personas: [{ slug: '工作', name: '工作', createdAt: '2026-01-01T00:00:00.000Z' }],
      }),
    )

    const store = makeStore(home, personasRoot, logger)
    // 前提必须自证（store-impl 提醒的假绿形态）：手写 personas.json 之后才 createStore，
    // 反了就白——store 内存里没有这份注册表，悬空状态压根进不了被测函数，而「空环境也会
    // 建默认人设并接管 current」会让下面每一条断言照样成立，整条用例假绿。
    await store.ready
    assert.equal(store.currentPersona()?.slug, 'ghost', '预置必须生效：current 得真的悬在 ghost 上')
    assert.deepEqual(
      (await store.listPersonas()).map((item) => item.slug),
      ['工作'],
      '预置必须生效：列表里只有用户的「工作」，此刻还没有任何默认人设',
    )

    const outcome = await ensureDefaultPersona(store, logger)

    assert.equal(outcome.created, true, '列表里没有默认人设就得补建，与 current 悬不悬空无关')
    assert.equal(outcome.tookOverCurrent, true, 'current 悬空时**应该**接管，否则面板还在指一个不存在的人设')
    assert.deepEqual(store.currentPersona(), { slug: DEFAULT_SLUG, name: DEFAULT_NAME })
    assert.equal((await readRegistry(home)).current, DEFAULT_SLUG, '悬空状态必须落盘修好，不能只改内存')

    const slugs = (await store.listPersonas()).map((item) => item.slug)
    assert.ok(slugs.includes('工作'), '用户自己的「工作」不能被吞掉')
    assert.ok(slugs.includes(DEFAULT_SLUG))
    assert.deepEqual(warnings, [], '接管悬空 current 属于正常修复，不该告警')
    await store.dispose()
  })
})

test('⑨a 已有小写 default：一个都不许多建，也不碰 current', async () => {
  await withHome(async (home, personasRoot) => {
    const { warnings, logger } = makeLogger()
    await seedPersonas(home, personasRoot, logger, [{ name: 'default' }])
    // 预置走 createPersona('default')，显示名按 v6 口径改成 Default。
    const tune = makeStore(home, personasRoot, logger)
    await tune.ready
    const renamed = await tune.renamePersona(DEFAULT_SLUG, DEFAULT_NAME)
    assert.equal(renamed?.ok, true)
    await tune.dispose()

    const store = makeStore(home, personasRoot, logger)
    const outcome = await ensureDefaultPersona(store, logger)

    // reason 明写 'has-default'：这是「判定命中所以没建」，与「建失败所以没建」在磁盘上
    // 长得一模一样，靠数警告去反推分支是不行的（lead 定的原则），得由实现显式交代。
    assert.deepEqual(
      outcome,
      { created: false, tookOverCurrent: false, slug: '', reason: 'has-default' },
      '已有默认人设时必须整段跳过',
    )
    const list = await store.listPersonas()
    assert.equal(list.length, 1, '列表必须原样不动，不许多出一个默认人设')
    assert.equal(list[0].slug, DEFAULT_SLUG)
    assert.equal(list[0].name, DEFAULT_NAME)
    assert.deepEqual(await personaDirs(personasRoot), [DEFAULT_SLUG], '不许出现第二个默认人设目录')
    assert.equal((await readRegistry(home)).current, DEFAULT_SLUG)
    assert.deepEqual(warnings, [], '跳过路径不该有任何告警')
    await store.dispose()
  })
})

test('⑨b 只有大写 Default（归一被跳过 / 失败的形态）：判定宽松，照样不建', async () => {
  // §V6.0 那段论证的入口视角守网：归一发生在 ready，但「归一被跳过或失败」的环境里
  // 条目仍是大写，此时 `isDefaultPersonaSlug` 必须认得它，否则就会再建一个小写 default，
  // 于是 personas/default 与 personas/Default 两个目录并存——正是 §V6.0 要根治的裂口。
  //
  // 这里刻意用**假 store**：真 store 的 ready 会先把大写归一成小写（实测如此），
  // 那样 createPersona 没被调用只是因为「已经有个小写 default 了」，测不到判定本身。
  const calls = { create: 0, rename: 0, setCurrent: 0 }
  const fakeStore = {
    ready: Promise.resolve(),
    async listPersonas() {
      return [{ slug: 'Default', name: 'Default', createdAt: '2026-01-01T00:00:00.000Z', dir: '/tmp/Default' }]
    },
    currentPersona: () => ({ slug: 'Default', name: 'Default' }),
    async createPersona(name) {
      calls.create += 1
      return { ok: true, persona: { slug: name, name } }
    },
    async renamePersona(slug, name) {
      calls.rename += 1
      return { ok: true, persona: { slug, name } }
    },
    async setCurrentPersona(slug) {
      calls.setCurrent += 1
      return { ok: true, persona: { slug } }
    },
  }
  const { warnings, logger } = makeLogger()

  const outcome = await ensureDefaultPersona(fakeStore, logger)

  assert.deepEqual(outcome, { created: false, tookOverCurrent: false, slug: '', reason: 'has-default' })
  // 单独数调用次数：假 store 的 createPersona 就算被误调也会返回 ok，只断言返回值会被
  // 「建完之后又发现不该建」这种半错状态糊过去，所以调用计数才是真正的证据。
  assert.deepEqual(calls, { create: 0, rename: 0, setCurrent: 0 }, '看到大写 Default 就该判定为已存在，三个写操作一个都不许发生')
  assert.deepEqual(warnings, [])
})

test('⑨c 建默认人设失败：reason 是 create-failed、绝不碰 current、必须留下告警', async () => {
  // 静默失败是这一层最怕的事：建不出来又一声不吭，用户只会看到面板下拉是空的。
  // reason 让「没建」有两种可判定的解释（has-default / create-failed），告警则是给运维的
  // 唯一线索——两者都要断言，但主判据是 reason，不是数警告。
  const calls = { setCurrent: 0 }
  const fakeStore = {
    ready: Promise.resolve(),
    listPersonas: async () => [{ slug: '工作', name: '工作', createdAt: '2026-01-01T00:00:00.000Z' }],
    currentPersona: () => ({ slug: '工作', name: '工作' }),
    createPersona: async () => ({ ok: false, code: 'EACCES', message: 'read-only filesystem' }),
    renamePersona: async () => ({ ok: true }),
    async setCurrentPersona(slug) {
      calls.setCurrent += 1
      return { ok: true, persona: { slug } }
    },
  }
  const { warnings, logger } = makeLogger()

  const outcome = await ensureDefaultPersona(fakeStore, logger)

  assert.deepEqual(outcome, { created: false, tookOverCurrent: false, slug: '', reason: 'create-failed' })
  assert.equal(calls.setCurrent, 0, '人设都没建成，绝不能把 current 指过去')
  assert.equal(warnings.length, 1, '建失败必须留下恰好一条告警')
  assert.match(warnings[0], /init failed/, `告警要说明是初始化失败，实际：${warnings[0]}`)

  // 同一批失败路径顺手钉住 logger 的三态：宿主不一定给 warn，而日志失败绝不能把业务带崩
  // （ensureDefaultPersona 对外承诺永不 reject）。缺 logger、缺 warn、warn 自己抛，都不能炸。
  for (const [label, brokenLogger] of [
    ['logger 整个不给', undefined],
    ['logger 没有 warn 方法', { info: () => {} }],
    ['logger.warn 自己抛错', { info: () => {}, warn: () => { throw new Error('日志管道断了') } }],
  ]) {
    const outcomeWithoutLogger = await ensureDefaultPersona(fakeStore, brokenLogger)
    assert.deepEqual(
      outcomeWithoutLogger,
      { created: false, tookOverCurrent: false, slug: '', reason: 'create-failed' },
      `${label}时结果必须一致，日志坏掉不许改变业务结论`,
    )
  }
})

test('⑩ 真跑 apply：不抛、零告警、空环境最终出现默认人设（装配链路真实性）', async () => {
  // await ensureDefaultPersona 的代价是不经过 apply——这条把那条 fire-and-forget 调用
  // 本身补上：入口装配整条链路（建 store → 装各能力 → 后台补默认人设）必须跑得通。
  // 唯一允许轮询的一条：apply 有意不返回句柄（契约 §V6.4 的讨论：为测试改入口返回约定
  // 有让宿主 await 住插件加载的风险）。实测 22ms 命中，超时给 3s。
  await withHome(async (home, personasRoot) => {
    const ctx = makeCtx()

    assert.doesNotThrow(() => apply(ctx, {}), '最小 ctx 下入口装配必须跑通（宿主服务全缺也不抛）')

    const registryPath = join(home, 'supermemory', 'personas.json')
    const deadline = Date.now() + 3000
    let registry = null
    let lastError = null
    while (Date.now() < deadline) {
      try {
        const parsed = JSON.parse(await readFile(registryPath, 'utf8'))
        if (Array.isArray(parsed?.personas) && parsed.personas.length > 0) {
          registry = parsed
          break
        }
      } catch (error) {
        lastError = error
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }

    assert.ok(
      registry !== null,
      `apply 之后默认人设必须在 3s 内出现在 personas.json，最后读到的内容：${JSON.stringify(registry)}，最后一次读盘错误：${String(lastError)}`,
    )
    assert.deepEqual(
      registry.personas.map((item) => `${item.slug}/${item.name}`),
      ['default/Default'],
      '经装配链路建出来的默认人设也必须是 slug 小写 + 显示名 Default',
    )
    assert.equal(registry.current, DEFAULT_SLUG, '空环境的 current 应被接管到小写 default')
    assert.deepEqual(await personaDirs(personasRoot), [DEFAULT_SLUG], '磁盘目录必须是小写')

    // 入口注册了这三个事件监听，说明各能力真的装上了（而不是提前 return 了）。
    assert.deepEqual(
      ctx.events.slice().sort(),
      ['agent/created', 'agent/pre-step', 'session/event'].sort(),
      'apply 必须完成各能力的装配',
    )
    assert.deepEqual(ctx.warnings, [], '空环境装配全程不该有任何告警')
  })
})
