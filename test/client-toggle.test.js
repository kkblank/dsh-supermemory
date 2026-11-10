/**
 * 客户端「插件总开关」行为测试（契约 §V3.6）。
 *
 * lib/client.js 是手写的浏览器模块工厂，此前在 test/ 下没有任何归属用例：
 * 「开关写失败必须回滚」只被临时冒烟验证过一次。本文件把它固化成常驻用例，
 * 覆盖点：
 *   1. 设置页开关渲染 bootstrap 回带的权威状态（开 / 关两态的 aria-checked 与状态文案）。
 *   2. 点击 → 先乐观翻转界面 → PUT settings 成功 → 最终以服务端回带的布尔为准。
 *   3. **PUT 失败 → 必须回滚到原状态并显示 settings.enableFailed**（本文件的存在理由）。
 *   4. 服务端回带缺 enabled → 再读一次 bootstrap 确认；仍确认不到 → 回滚并报 settings.enableUnknown。
 *   5. 服务端权威值覆盖本地乐观值（绝不允许「界面说关了、后台其实还在注入」）。
 *   6. 面板页关闭态：黄条出现 + 「立即整理」disabled，且 runDigest 的内层防护不发请求。
 *   7. `enabledFrom` 三种取值口径：顶层 enabled > digestSettings.enabled > 缺失视为开启。
 *   8. 装配入口：`inject` 三件套、三处插槽注册、只 require('react')、词典含 v3 九个新键。
 *
 * 实现方式：不装任何依赖，也不用真 React。自己实现一个够用的最小 react
 * （createElement / useState / useEffect / useCallback / useRef / useSyncExternalStore）
 * 加一个假 fetch，把 lib/client.js 当浏览器脚本读进来喂给 window.__ModuleLoader__，
 * 直接驱动组件跑起来，再从渲染结果树上取 props 断言。
 *
 * 运行：node --test test/client-toggle.test.js
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** 被测文件（浏览器脚本，不能被 import，只能读源码执行）。 */
const CLIENT_PATH = fileURLToPath(new URL('../lib/client.js', import.meta.url))

/** 客户端 HTTP 前缀，与 lib/client.js 内的 API 常量一致。 */
const API_PREFIX = 'api/dsh-supermemory/'

/** 契约 §V3.6 要求新增的九个词典键。 */
const V3_KEYS = [
  'panel.disabledNotice',
  'panel.digest.disabledHint',
  'settings.enable',
  'settings.enableRow',
  'settings.enableHint',
  'settings.enableAria',
  'settings.enableBusy',
  'settings.enableFailed',
  'settings.enableUnknown',
]

/**
 * 最小假 React。
 *
 * 只做四件事：建节点、按渲染路径复用 hook 槽位、setState 标脏、渲染后补跑 effect。
 * 没有 diff、没有并发，整棵树每次重渲染；被测组件结构稳定，路径 key 因此可靠。
 *
 * @returns {object} 含 `React` 对象与渲染驱动方法的运行时。
 */
function createRuntime() {
  /** 组件实例的 hook 槽位，key 是渲染路径。 */
  const instances = new Map()
  /** 当前正在渲染的组件实例（hook 调用挂到它身上）。 */
  let current = null
  let pendingEffects = []
  let dirty = false
  let rootNode = null
  let tree = null

  /**
   * 依赖数组是否变化（语义与 React 一致：长度或任一项 !== 即变化）。
   * @param {Array|undefined} previous - 上次的依赖。
   * @param {Array|undefined} next - 本次的依赖。
   * @returns {boolean} 是否应重跑 effect。
   */
  function depsChanged(previous, next) {
    if (previous === undefined || next === undefined) return true
    if (previous.length !== next.length) return true
    for (let index = 0; index < previous.length; index += 1) {
      if (!Object.is(previous[index], next[index])) return true
    }
    return false
  }

  /** 渲染一个节点（元素 / 组件 / 文本 / 数组 / 条件假值）。 */
  function renderNode(node, key) {
    if (node === null || node === undefined || typeof node === 'boolean') return null
    if (Array.isArray(node)) {
      const children = []
      node.forEach((child, index) => {
        const rendered = renderNode(child, `${key}/@${index}`)
        if (rendered) children.push(rendered)
      })
      return { type: '#fragment', props: {}, key, children }
    }
    if (typeof node === 'string' || typeof node === 'number') {
      return { type: '#text', props: {}, key, text: String(node), children: [] }
    }
    if (typeof node.type === 'function') return renderComponent(node, key)
    const children = []
    node.children.forEach((child, index) => {
      const rendered = renderNode(child, `${key}/${index}`)
      if (rendered) children.push(rendered)
    })
    return { type: node.type, props: node.props, key, children }
  }

  /** 渲染一个函数组件，并复用它那一格的 hooks。 */
  function renderComponent(node, key) {
    if (!instances.has(key)) instances.set(key, [])
    const hooks = instances.get(key)
    const outer = current
    current = { hooks, index: 0 }
    let child
    try {
      child = node.type(node.props)
    } finally {
      current = outer
    }
    const rendered = renderNode(child, `${key}/~`)
    return { type: '#component', props: node.props, key, children: rendered ? [rendered] : [] }
  }

  /** 渲染整棵树并补跑本批 effect。 */
  function renderTree() {
    dirty = false
    pendingEffects = []
    tree = renderNode(rootNode, 'root')
    const effects = pendingEffects
    pendingEffects = []
    for (const run of effects) run()
    return tree
  }

  /** 让宏任务跑一轮（异步 effect 里的 await 链在其中一次 tick 内清空）。 */
  function tick() {
    return new Promise((resolve) => {
      setImmediate(resolve)
    })
  }

  const runtime = {
    /** 交给被测工厂的 `require('react')` 结果。 */
    React: {
      createElement(type, props, ...children) {
        return { type, props: props ?? {}, children }
      },
      useState(initialValue) {
        const instance = current
        const slot = instance.index++
        if (instance.hooks[slot] === undefined) {
          instance.hooks[slot] = { state: typeof initialValue === 'function' ? initialValue() : initialValue }
        }
        const hook = instance.hooks[slot]
        return [
          hook.state,
          (next) => {
            hook.state = typeof next === 'function' ? next(hook.state) : next
            dirty = true
          },
        ]
      },
      useEffect(setup, deps) {
        const instance = current
        const slot = instance.index++
        const previous = instance.hooks[slot]
        if (previous && !depsChanged(previous.deps, deps)) return
        if (previous && typeof previous.cleanup === 'function') pendingEffects.push(previous.cleanup)
        const record = { deps, cleanup: undefined }
        instance.hooks[slot] = record
        pendingEffects.push(() => {
          const cleanup = setup()
          if (typeof cleanup === 'function') record.cleanup = cleanup
        })
      },
      useCallback(callback, deps) {
        const instance = current
        const slot = instance.index++
        const previous = instance.hooks[slot]
        if (previous && !depsChanged(previous.deps, deps)) return previous.callback
        instance.hooks[slot] = { callback, deps }
        return callback
      },
      useRef(initialValue) {
        const instance = current
        const slot = instance.index++
        if (instance.hooks[slot] === undefined) instance.hooks[slot] = { ref: { current: initialValue } }
        return instance.hooks[slot].ref
      },
      useSyncExternalStore(subscribe, getSnapshot) {
        const instance = current
        const slot = instance.index++
        if (instance.hooks[slot] === undefined) {
          instance.hooks[slot] = {}
          try {
            subscribe(() => {
              dirty = true
            })
          } catch {
            /* 订阅失败只影响语言刷新，不影响渲染 */
          }
        }
        try {
          return getSnapshot()
        } catch {
          return 0
        }
      },
    },

    /**
     * 挂载一个组件并渲染首屏。
     * @param {Function} Component - 组件函数（已是 wire 过的）。
     * @param {object} [props] - 宿主侧 props。
     * @returns {Promise<object>} 可驱动的页柄。
     */
    async open(Component, props = {}) {
      rootNode = runtime.React.createElement(Component, props)
      renderTree()
      const page = {
        /** 最近一次渲染结果树。 */
        get tree() {
          return tree
        },
        /** 驱动若干轮渲染，直到没有新的状态变化。 */
        async settle() {
          let stable = 0
          for (let round = 0; round < 40; round += 1) {
            await tick()
            renderTree()
            await tick()
            if (dirty) {
              stable = 0
              continue
            }
            stable += 1
            if (stable >= 2) return
          }
        },
      }
      await page.settle()
      return page
    },
  }

  return runtime
}

/**
 * 假 fetch：按 `METHOD path` 查处理器，并记下每一次调用。
 *
 * 处理器返回 `{ status, body, reject }`：
 *   - `body` 是响应 JSON（`undefined` 表示响应体不是合法 JSON）；
 *   - `reject` 是一个 Error，表示 fetch 本身抛错（网络失败）。
 *
 * @param {object<string, Function>} handlers - `PUT settings` → 处理器。
 * @returns {{ fetch: Function, calls: Array, requests: Function }} 假 fetch 与调用记录。
 */
function createFetch(handlers) {
  const calls = []

  /**
   * @param {string} path - 接口路径（不含前缀与查询串）。
   * @param {string} method - 大写方法名。
   * @returns {Function|undefined} 处理器。
   */
  function pick(path, method) {
    return handlers[`${method} ${path}`] ?? handlers[path]
  }

  const fetchImpl = async (url, init) => {
    const method = String(init?.method ?? 'GET').toUpperCase()
    const full = String(url)
    const rest = full.startsWith(API_PREFIX) ? full.slice(API_PREFIX.length) : full
    const [path, query = ''] = rest.split('?')
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ url: full, path, method, query, body })
    const handler = pick(path, method)
    if (!handler) throw new Error(`测试未给 ${method} ${path} 准备处理器`)
    const result = await handler({ path, method, body, query, index: calls.length - 1 })
    if (result?.reject) throw result.reject
    const status = result?.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (result?.body === undefined) throw new Error('响应体不是合法 JSON')
        return result.body
      },
    }
  }

  return {
    fetch: fetchImpl,
    calls,
    /**
     * 已发生的调用列表（便于断言请求次数与请求体）。
     * @param {string} path - 接口路径。
     * @param {string} [method] - 方法名。
     * @returns {Array<object>} 匹配的调用。
     */
    requests(path, method) {
      return calls.filter((call) => call.path === path && (method === undefined || call.method === method))
    },
  }
}

/**
 * 模板插值，语义与客户端 t(key, params) 一致。
 * @param {object} dictionary - 词典对象。
 * @param {string} key - 词典键。
 * @param {object} [params] - 占位符参数。
 * @returns {string} 文案。
 */
function interpolate(dictionary, key, params) {
  const template = dictionary?.[key]
  if (typeof template !== 'string') return key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name) => (params[name] === undefined ? match : String(params[name])))
}

/**
 * 一份够用的 bootstrap 响应 data。
 * 覆盖项里显式写 `undefined` 表示「这个键不存在」，用来构造缺字段的响应。
 */
function bootstrapData(overrides = {}) {
  const data = {
    enabled: true,
    personas: [{ slug: 'default', name: 'Default' }],
    currentPersona: { slug: 'default', name: 'Default' },
    projects: [],
    active: {},
    presets: [],
    presetsRoot: '/home/user/.dsh/supermemory/personas',
    dshHome: '/home/user/.dsh',
    config: { injectMaxBytes: 24000, systemPromptMaxBytes: 12000, autoDigest: true },
    digestSettings: { enabled: true, digestProvider: '', digestModel: '' },
    ...overrides,
  }
  for (const key of Object.keys(data)) if (data[key] === undefined) delete data[key]
  return data
}

/** 一份够用的 doc 响应 data（path 只是喂给界面显示的字符串，不碰磁盘）。 */
const DOC_BODY = {
  ok: true,
  data: {
    content: '## 条目\n',
    bytes: 16,
    mtimeMs: 1000,
    path: '/home/user/.dsh/supermemory/personas/default/global-memory.md',
  },
}

/**
 * 装载 lib/client.js，并装配一个假宿主上下文。
 *
 * @param {object} [options] - 选项。
 * @param {object<string, Function>} [options.routes] - 覆盖某个接口的响应处理器。
 * @param {string} [options.language] - 词典语言，默认 zh。
 * @returns {Promise<object>} 含 open / 词典 / 调用记录的装载结果。
 */
async function loadClient(options = {}) {
  const runtime = createRuntime()
  const source = readFileSync(CLIENT_PATH, 'utf8')
  // client.js 顶层只有一句 window.__ModuleLoader__.load(...)，把它当浏览器脚本执行即可；
  // fetch 由外层参数注入，factory 闭包会捕获它；require 走 factory 的形参。
  const runScript = new Function('window', 'fetch', source)
  const loader = {
    modules: [],
    load(module) {
      this.modules.push(module)
    },
  }
  const requested = []
  const fake = createFetch(options.routes ?? {})
  runScript({ __ModuleLoader__: loader }, fake.fetch)
  assert.equal(loader.modules.length, 1, '工厂必须恰好 load 一次')
  const descriptor = loader.modules[0]
  const exported = descriptor.factory((name) => {
    requested.push(name)
    if (name === 'react') return runtime.React
    throw new Error(`客户端不该 require 其它模块：${name}`)
  })

  const slots = []
  const injected = []
  let dictionary = null
  const ctx = {
    effect: (fn) => fn(),
    // 设置页的「打开记忆面板」会 ctx.get('layout')；本文件不测它，给个空实现即可。
    get: (name) => (name === 'layout' ? { selectPanel: () => {} } : undefined),
    locale: {
      register(namespace, dictionaries) {
        dictionary = options.language === 'en' ? dictionaries.en : dictionaries.zh
        return { namespace }
      },
      bind: (namespace) => (key, params) => interpolate(dictionary, key, params),
      subscribe: () => () => {},
      getSnapshot: () => ({ revision: 0 }),
    },
    slots: {
      inject: (name, factory) => {
        injected.push(name)
        factory()
      },
      register: (meta, Component) => slots.push({ meta, Component }),
    },
  }
  exported.apply(ctx)

  return {
    id: descriptor.id,
    inject: exported.inject,
    injected,
    requested,
    calls: fake.calls,
    requests: fake.requests,
    /**
     * 取词典文案（用来拼期望值，避免把中文长句硬编码进断言）。
     * @param {string} key - 词典键。
     * @param {object} [params] - 插值参数。
     * @returns {string} 文案。
     */
    text: (key, params) => interpolate(dictionary, key, params),
    /** 词典本体（供逐键存在性断言）。 */
    dictionary: () => dictionary,
    /**
     * 打开一个注册过的位置。
     * @param {string} name - 槽位名（main / settings.section / sidebar.panellist）。
     * @param {object} [props] - 传给组件的宿主 props。
     * @returns {Promise<object>} 页柄。
     */
    async open(name, props = {}) {
      const entry = slots.find((item) => item.meta.name === name)
      assert.ok(entry, `未注册槽位 ${name}`)
      return runtime.open(entry.Component, props)
    },
    /**
     * 查注册的元信息。
     * @param {string} name - 槽位名。
     * @returns {object|undefined} meta。
     */
    metaOf: (name) => slots.find((item) => item.meta.name === name)?.meta,
  }
}

// ——————————————————————————————————————————————
// 渲染树查询小工具
// ——————————————————————————————————————————————

/** 深度优先展开渲染树。 */
function walk(node, out = []) {
  if (!node) return out
  out.push(node)
  for (const child of node.children ?? []) walk(child, out)
  return out
}

/** 节点可见文本。 */
function textOf(node) {
  if (!node) return ''
  if (node.type === '#text') return node.text
  return (node.children ?? []).map(textOf).join('')
}

/** 按类名筛选。 */
const byClass = (name) => (node) => typeof node.props?.className === 'string' && node.props.className.split(/\s+/).includes(name)

/** 按 role 筛选。 */
const byRole = (role) => (node) => node.props?.role === role

/** 按按钮可见文本筛选。 */
const byButtonText = (text) => (node) => node.type === 'button' && textOf(node) === text

/** 找文本恰好等于给定值的按钮。 */
function buttonByText(root, text) {
  return walk(root).find(byButtonText(text))
}

/**
 * 找唯一一个匹配节点，找不到或找到多个都直接失败。
 * @param {object} root - 渲染树根。
 * @param {Function} predicate - 谓词。
 * @param {string} what - 出错时的说明。
 * @returns {object} 节点。
 */
function mustFind(root, predicate, what) {
  const found = walk(root).filter(predicate)
  assert.equal(found.length, 1, `期望恰好一个${what}，实际 ${found.length} 个`)
  return found[0]
}

/** 总开关滑块节点。 */
function switchNode(root) {
  return mustFind(root, byRole('switch'), ' role=switch 滑块')
}

/** 当前所有错误提示条文本。 */
function errorNotices(root) {
  return walk(root).filter(byClass('sm-notice-error')).map(textOf)
}

/**
 * 触发一次点击并驱动渲染（不 await onClick 的返回值，避免被人为挂起的请求卡住）。
 * @param {object} page - 页柄。
 * @param {object} node - 目标节点。
 * @returns {Promise<void>} 驱动完成。
 */
async function click(page, node) {
  assert.equal(typeof node.props.onClick, 'function', '目标元素必须有 onClick')
  node.props.onClick({ type: 'click', target: {}, currentTarget: {} })
  await page.settle()
}

// ——————————————————————————————————————————————
// 装配入口
// ——————————————————————————————————————————————

test('客户端装配：只 require react，注册三处插槽，词典含 v3 九个新键', async () => {
  const client = await loadClient({})
  assert.equal(client.id, 'dsh-supermemory')
  assert.deepEqual(client.inject, ['slots', 'locale', 'layout'])
  assert.deepEqual(client.requested, ['react'], '除 react 外不得 require 任何模块')
  assert.deepEqual(client.injected, ['sidebar.panellist', 'main', 'settings.section'])
  assert.equal(client.metaOf('main').key, 'supermemory')
  assert.equal(client.metaOf('settings.section').id, 'supermemory')

  const dictionary = client.dictionary()
  for (const key of V3_KEYS) {
    assert.equal(typeof dictionary[key], 'string', `词典缺少 ${key}`)
    assert.ok(dictionary[key].length > 0, `词典 ${key} 为空`)
  }
})

// ——————————————————————————————————————————————
// 设置页：开关渲染两态
// ——————————————————————————————————————————————

test('设置页开关按 bootstrap 权威值渲染：开 / 关两态的 aria-checked 与状态文案', async () => {
  for (const enabled of [true, false]) {
    const client = await loadClient({
      routes: { 'GET bootstrap': () => ({ status: 200, body: { ok: true, data: bootstrapData({ enabled }) } }) },
    })
    const page = await client.open('settings.section')
    const toggle = switchNode(page.tree)
    assert.equal(toggle.props['aria-checked'], enabled, `aria-checked 应跟随 bootstrap.enabled=${enabled}`)
    assert.equal(toggle.props.disabled, false)
    assert.equal(toggle.props['aria-label'], client.text('settings.enableAria'))
    assert.equal(toggle.props.className.includes('is-on'), enabled, 'is-on 类名应表达开 / 关')
    assert.equal(
      textOf(mustFind(page.tree, byClass('sm-enable-state'), '状态文案')),
      `${client.text('settings.enableRow')}: ${enabled ? client.text('common.on') : client.text('common.off')}`,
    )
    // 关闭态不得把整页变成砖：其余概览卡片照常渲染，且没有任何错误条。
    assert.ok(buttonByText(page.tree, client.text('settings.openPanel')), '概览内容必须照常渲染')
    assert.deepEqual(errorNotices(page.tree), [])
  }
})

test('开关初值取口径：顶层 enabled > digestSettings.enabled > 两者皆缺视为开启', async () => {
  const cases = [
    { name: '顶层 enabled 优先于 digestSettings', data: { enabled: false, digestSettings: { enabled: true } }, expected: false },
    { name: '顶层缺失时回退 digestSettings.enabled', data: { enabled: undefined, digestSettings: { enabled: false } }, expected: false },
    { name: '两处都缺视为开启', data: { enabled: undefined, digestSettings: undefined }, expected: true },
    { name: '非布尔值不作为关闭依据', data: { enabled: 'false', digestSettings: { digestProvider: '' } }, expected: true },
  ]
  for (const testCase of cases) {
    const client = await loadClient({
      routes: { 'GET bootstrap': () => ({ status: 200, body: { ok: true, data: bootstrapData(testCase.data) } }) },
    })
    const page = await client.open('settings.section')
    assert.equal(switchNode(page.tree).props['aria-checked'], testCase.expected, testCase.name)
  }
})

// ——————————————————————————————————————————————
// 设置页：乐观翻转 + 成功以回带为准
// ——————————————————————————————————————————————

test('点击开关：先乐观翻转，PUT 成功后以服务端回带布尔为准且无错误', async () => {
  let resolvePut
  const client = await loadClient({
    routes: {
      'GET bootstrap': () => ({ status: 200, body: { ok: true, data: bootstrapData({ enabled: true }) } }),
      'PUT settings': () => new Promise((resolve) => { resolvePut = resolve }),
    },
  })
  const page = await client.open('settings.section')
  assert.equal(switchNode(page.tree).props['aria-checked'], true)

  await click(page, switchNode(page.tree))

  // 请求仍在途：界面必须已经翻到「关闭」，并显示保存中、滑块暂时禁用。
  assert.equal(client.requests('settings', 'PUT').length, 1, '必须发一次 PUT settings')
  assert.deepEqual(client.requests('settings', 'PUT')[0].body, { enabled: false }, '请求体只带 enabled')
  assert.equal(switchNode(page.tree).props['aria-checked'], false, '请求在途时必须显示乐观新值')
  assert.equal(switchNode(page.tree).props.disabled, true, '在途期间滑块必须禁用，避免连点')
  assert.ok(textOf(page.tree).includes(client.text('settings.enableBusy')), '在途时必须显示保存中')
  assert.deepEqual(errorNotices(page.tree), [], '在途时不该有错误')

  resolvePut({ status: 200, body: { ok: true, data: { enabled: false, digestSettings: { enabled: false } } } })
  await page.settle()

  assert.equal(switchNode(page.tree).props['aria-checked'], false, '成功后以服务端回带为准')
  assert.equal(switchNode(page.tree).props.disabled, false, '成功后解除禁用')
  assert.deepEqual(errorNotices(page.tree), [], '成功路径不得出现错误条')
  assert.equal(client.requests('bootstrap').length, 1, '回带里有布尔就不该再读 bootstrap')
})

test('服务端回带覆盖本地乐观值：PUT 回 enabled=true 时界面必须回到开启并报不一致', async () => {
  const client = await loadClient({
    routes: {
      'GET bootstrap': () => ({ status: 200, body: { ok: true, data: bootstrapData({ enabled: true }) } }),
      // 服务端「保存成功」但回带仍是 true（例如存储层没真正落地这一位）。
      'PUT settings': () => ({ status: 200, body: { ok: true, data: { enabled: true } } }),
    },
  })
  const page = await client.open('settings.section')
  await click(page, switchNode(page.tree))

  assert.equal(switchNode(page.tree).props['aria-checked'], true, '界面必须显示服务端权威值，绝不显示没生效的关闭')
  const notices = errorNotices(page.tree)
  assert.equal(notices.length, 1, '状态与请求不一致必须给出提示')
  assert.equal(
    notices[0],
    client.text('settings.enableFailed', { error: client.text('settings.enableUnknown') }),
  )
  assert.equal(client.requests('bootstrap').length, 1, '回带已有布尔时不需要额外确认')
})

// ——————————————————————————————————————————————
// 设置页：失败回滚（本文件的核心）
// ——————————————————————————————————————————————

test('PUT 返回 500：开关必须回滚到原状态并显示 settings.enableFailed', async () => {
  const client = await loadClient({
    routes: {
      'GET bootstrap': () => ({ status: 200, body: { ok: true, data: bootstrapData({ enabled: true }) } }),
      'PUT settings': () => ({ status: 500, body: { ok: false, code: 'WRITE_FAILED', error: '磁盘写入失败' } }),
    },
  })
  const page = await client.open('settings.section')
  await click(page, switchNode(page.tree))

  assert.equal(switchNode(page.tree).props['aria-checked'], true, 'PUT 失败必须回滚为原值 true')
  assert.equal(switchNode(page.tree).props.className.includes('is-on'), true, '回滚后视觉态也要跟回开启')
  assert.equal(switchNode(page.tree).props.disabled, false, '回滚后要能再点一次')
  const notices = errorNotices(page.tree)
  assert.equal(notices.length, 1, '必须显示一条错误')
  assert.equal(notices[0], client.text('settings.enableFailed', { error: '磁盘写入失败' }))
  assert.ok(mustFind(page.tree, byRole('alert'), '错误提示条').props.className.includes('sm-notice-error'))
  assert.equal(client.requests('bootstrap').length, 1, '失败路径不得再多读一次')
})

test('PUT 从初始关闭态失败：同样回滚为关闭，错误文案带服务端原因', async () => {
  const client = await loadClient({
    routes: {
      'GET bootstrap': () => ({ status: 200, body: { ok: true, data: bootstrapData({ enabled: false }) } }),
      'PUT settings': () => ({ status: 400, body: { ok: false, code: 'BAD_INPUT', error: '参数不合法' } }),
    },
  })
  const page = await client.open('settings.section')
  assert.equal(switchNode(page.tree).props['aria-checked'], false)

  await click(page, switchNode(page.tree))

  assert.equal(switchNode(page.tree).props['aria-checked'], false, '从关闭态失败必须回滚为关闭')
  assert.equal(
    errorNotices(page.tree)[0],
    client.text('settings.enableFailed', { error: '参数不合法' }),
  )
})

test('PUT 网络异常（fetch 抛错）也回滚：callApi 的 NETWORK 分支同样要复原开关', async () => {
  const client = await loadClient({
    routes: {
      'GET bootstrap': () => ({ status: 200, body: { ok: true, data: bootstrapData({ enabled: true }) } }),
      'PUT settings': () => ({ reject: new Error('network down') }),
    },
  })
  const page = await client.open('settings.section')
  await click(page, switchNode(page.tree))

  assert.equal(switchNode(page.tree).props['aria-checked'], true, '网络失败必须回滚')
  assert.equal(errorNotices(page.tree).length, 1)
  assert.ok(
    errorNotices(page.tree)[0].includes('network down'),
    `错误条应带网络原因，实际：${errorNotices(page.tree)[0]}`,
  )
})

test('响应体不是合法 JSON 时也算失败：回滚并给出 HTTP 状态原因', async () => {
  const client = await loadClient({
    routes: {
      'GET bootstrap': () => ({ status: 200, body: { ok: true, data: bootstrapData({ enabled: true }) } }),
      'PUT settings': () => ({ status: 502, body: undefined }),
    },
  })
  const page = await client.open('settings.section')
  await click(page, switchNode(page.tree))

  assert.equal(switchNode(page.tree).props['aria-checked'], true, '非 JSON 响应必须按失败处理并回滚')
  assert.equal(errorNotices(page.tree)[0], client.text('settings.enableFailed', { error: 'HTTP 502' }))
})

test('连点两次都失败：状态始终回到最初值，不出现「半开半关」', async () => {
  let failure = '第一次失败'
  const client = await loadClient({
    routes: {
      'GET bootstrap': () => ({ status: 200, body: { ok: true, data: bootstrapData({ enabled: true }) } }),
      'PUT settings': () => ({ status: 500, body: { ok: false, error: failure } }),
    },
  })
  const page = await client.open('settings.section')

  await click(page, switchNode(page.tree))
  assert.equal(switchNode(page.tree).props['aria-checked'], true)
  failure = '第二次失败'
  await click(page, switchNode(page.tree))

  assert.equal(switchNode(page.tree).props['aria-checked'], true, '第二次回滚的基准必须是最初值')
  assert.equal(client.requests('settings', 'PUT').length, 2)
  assert.deepEqual(
    client.requests('settings', 'PUT').map((call) => call.body),
    [{ enabled: false }, { enabled: false }],
    '两次请求都应是「关掉」',
  )
  assert.equal(errorNotices(page.tree)[0], client.text('settings.enableFailed', { error: '第二次失败' }))
})

// ——————————————————————————————————————————————
// 设置页：服务端没回带布尔 → 再读 bootstrap 确认
// ——————————————————————————————————————————————

test('PUT 回带缺 enabled：再读一次 bootstrap 确认，确认到新值就不报错', async () => {
  let bootstrapReads = 0
  const client = await loadClient({
    routes: {
      'GET bootstrap': () => {
        bootstrapReads += 1
        // 首屏 true；确认那次已落到 false。
        const enabled = bootstrapReads === 1
        return { status: 200, body: { ok: true, data: bootstrapData({ enabled }) } }
      },
      'PUT settings': () => ({ status: 200, body: { ok: true, data: { digestSettings: { digestProvider: '' } } } }),
    },
  })
  const page = await client.open('settings.section')
  await click(page, switchNode(page.tree))

  assert.equal(client.requests('settings', 'PUT').length, 1)
  assert.equal(client.requests('bootstrap').length, 2, '回带缺布尔必须补读一次 bootstrap 确认')
  assert.equal(switchNode(page.tree).props['aria-checked'], false, '确认后采用服务端真实状态')
  assert.deepEqual(errorNotices(page.tree), [], '确认成功不该报错')
})

test('PUT 回带缺 enabled 且 bootstrap 仍读到旧值：采用旧值并报 settings.enableUnknown', async () => {
  const client = await loadClient({
    routes: {
      'GET bootstrap': () => ({ status: 200, body: { ok: true, data: bootstrapData({ enabled: true }) } }),
      'PUT settings': () => ({ status: 200, body: { ok: true, data: {} } }),
    },
  })
  const page = await client.open('settings.section')
  await click(page, switchNode(page.tree))

  assert.equal(client.requests('bootstrap').length, 2, '必须补读确认')
  assert.equal(switchNode(page.tree).props['aria-checked'], true, '确认不到新值就显示服务端权威值，绝不显示未生效的关闭')
  assert.equal(
    errorNotices(page.tree)[0],
    client.text('settings.enableFailed', { error: client.text('settings.enableUnknown') }),
  )
})

test('确认用的 bootstrap 也读失败：回滚原值并报 settings.enableUnknown', async () => {
  let bootstrapReads = 0
  const client = await loadClient({
    routes: {
      'GET bootstrap': () => {
        bootstrapReads += 1
        if (bootstrapReads === 1) return { status: 200, body: { ok: true, data: bootstrapData({ enabled: true }) } }
        return { status: 500, body: { ok: false, code: 'READ_FAILED', error: '读盘失败' } }
      },
      'PUT settings': () => ({ status: 200, body: { ok: true, data: { enabled: undefined } } }),
    },
  })
  const page = await client.open('settings.section')
  await click(page, switchNode(page.tree))

  assert.equal(client.requests('bootstrap').length, 2)
  assert.equal(switchNode(page.tree).props['aria-checked'], true, '确认失败必须回滚原值')
  assert.equal(
    errorNotices(page.tree)[0],
    client.text('settings.enableFailed', { error: client.text('settings.enableUnknown') }),
  )
})

test('首屏 bootstrap 读失败：设置页显示载入错误，不渲染出假的开关', async () => {
  const client = await loadClient({
    routes: {
      'GET bootstrap': () => ({ status: 500, body: { ok: false, code: 'READ_FAILED', error: '读盘失败' } }),
    },
  })
  const page = await client.open('settings.section')

  assert.equal(walk(page.tree).filter(byRole('switch')).length, 0, '没有权威状态时不得渲染开关')
  assert.deepEqual(
    errorNotices(page.tree),
    [client.text('settings.loadFailed', { error: '读盘失败' })],
  )
})

// ——————————————————————————————————————————————
// 面板页：关闭态
// ——————————————————————————————————————————————

/** 面板页用到的四个接口的默认处理器（只给最小可用数据）。 */
function panelRoutes(enabled) {
  return {
    'GET bootstrap': () => ({ status: 200, body: { ok: true, data: bootstrapData({ enabled }) } }),
    'GET runs': () => ({ status: 200, body: { ok: true, data: [] } }),
    'GET models': () => ({ status: 200, body: { ok: true, data: { models: [] } } }),
    'GET doc': () => ({ status: 200, body: DOC_BODY }),
  }
}

test('面板关闭态：顶部黄条出现，「立即整理」disabled 且带 disabledHint', async () => {
  const client = await loadClient({ routes: panelRoutes(false) })
  const page = await client.open('main')

  const banner = mustFind(page.tree, byClass('sm-banner'), '关闭态警示条')
  assert.ok(banner.props.className.includes('sm-notice-warn'), '警示条必须用 warn 态样式')
  assert.equal(banner.props.role, 'status')
  assert.equal(textOf(banner), client.text('panel.disabledNotice'))

  const digestButton = mustFind(page.tree, byButtonText(client.text('panel.digest.now')), '「立即整理」按钮')
  assert.equal(digestButton.props.disabled, true, '关闭态必须禁用手动整理')
  assert.equal(digestButton.props.title, client.text('panel.digest.disabledHint'))

  // 关闭只停注入与整理，面板本身必须还能读能改。
  assert.ok(buttonByText(page.tree, client.text('panel.save')), '保存按钮仍要存在')
  assert.ok(buttonByText(page.tree, client.text('panel.reload')), '重新载入按钮仍要存在')
  assert.deepEqual(errorNotices(page.tree), [])
})

test('面板开启态：没有黄条，「立即整理」可用且不带 disabledHint', async () => {
  const client = await loadClient({ routes: panelRoutes(true) })
  const page = await client.open('main')

  assert.equal(walk(page.tree).filter(byClass('sm-banner')).length, 0, '开启态不得出现关闭警示')
  const digestButton = buttonByText(page.tree, client.text('panel.digest.now'))
  assert.ok(digestButton, '开启态必须有「立即整理」')
  assert.equal(digestButton.props.disabled, false)
  assert.equal(digestButton.props.title, undefined)
})

test('关闭态即便绕过 disabled 点「立即整理」，runDigest 内层防护也不发 POST digest', async () => {
  const client = await loadClient({
    routes: {
      ...panelRoutes(false),
      'POST digest': () => {
        throw new Error('关闭态不应该被调用到整理接口')
      },
    },
  })
  const page = await client.open('main')
  const digestButton = buttonByText(page.tree, client.text('panel.digest.now'))

  await click(page, digestButton)

  assert.equal(client.requests('digest', 'POST').length, 0, '内层防护必须挡住请求')
  assert.deepEqual(errorNotices(page.tree), [], '被防护挡掉时不该弹错误')
})

test('面板首屏 bootstrap 读失败：只显示载入错误，不显示假的关闭黄条', async () => {
  const client = await loadClient({
    routes: {
      ...panelRoutes(false),
      'GET bootstrap': () => ({ status: 500, body: { ok: false, code: 'READ_FAILED', error: '读盘失败' } }),
    },
  })
  const page = await client.open('main')

  assert.equal(walk(page.tree).filter(byClass('sm-banner')).length, 0, '不知道权威状态时不得断言关闭态')
  assert.deepEqual(errorNotices(page.tree), [client.text('panel.loadFailed', { error: '读盘失败' })])
})
