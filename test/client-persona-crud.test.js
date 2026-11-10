/**
 * 客户端「人设重命名 / 删除」行为测试（契约 §V5.5 + §V5.6 + §V5.7）。
 *
 * 覆盖点：
 *   1. 词典四处（client.js 内嵌 en / zh + locale/en.json + locale/zh.json）逐键一致，
 *      且 v5 的 8 个新键 zh 文案与契约表逐字相同。
 *   2. 顶部人设组三态互斥：idle 才有 ✎ 🗑；进入 rename / delete 后「+ 添加人设」收起，
 *      反过来打开「+ 添加人设」也会收起 rename 表单；切换人设同样复位 idle。
 *   3. ✎：预填当前显示名；保存发 PATCH { slug, name }；成功后刷 bootstrap 换新显示名，
 *      **且不重载四个文档**；失败留在表单并报错；取消 / Escape 不发请求。
 *   4. 🗑：确认文案带当前人设名；取消不发 DELETE；确认后发 DELETE { slug }，
 *      成功后下拉切到响应 current.slug、**drafts 被清空**（旧人设的脏草稿绝不能落到新人设文件）、
 *      文档按新人设重载；409 PERSONA_PROTECTED 用 personaDeleteLocked 文案。
 *   5. 禁用条件：选中 default 时 🗑 disabled 且 title 给原因；busy 时人设区控件全 disabled。
 *
 * 实现方式与 test/client-toggle.test.js 同源（自带一份最小 react + 假 fetch，把 lib/client.js
 * 当浏览器脚本读进来驱动组件），但本文件自带全部 mock，不 import、也不改那个已有文件。
 *
 * 运行：node --test test/client-persona-crud.test.js
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** 被测文件（浏览器脚本，不能被 import，只能读源码执行）。 */
const CLIENT_PATH = fileURLToPath(new URL('../lib/client.js', import.meta.url))
const EN_JSON_PATH = fileURLToPath(new URL('../locale/en.json', import.meta.url))
const ZH_JSON_PATH = fileURLToPath(new URL('../locale/zh.json', import.meta.url))

/** 客户端 HTTP 前缀，与 lib/client.js 内的 API 常量一致。 */
const API_PREFIX = 'api/dsh-supermemory/'

/** 契约 §V5.6 表定的 8 个新键与其中文文案（逐字，作为回归守护）。 */
const V5_ZH = {
  'panel.personaRename': '重命名',
  'panel.personaRenamed': '已重命名人设。',
  'panel.personaRenameFailed': '重命名人设失败：{error}',
  'panel.personaDelete': '删除人设',
  'panel.personaDeleteConfirm': '确定删除「{name}」及其人格、画像与全局记忆？此操作不可撤销。',
  'panel.personaDeleted': '已删除人设及其记忆文件。',
  'panel.personaDeleteFailed': '删除人设失败：{error}',
  'panel.personaDeleteLocked': 'Default 人设不能删除。',
}

const V5_KEYS = Object.keys(V5_ZH)

// ——————————————————————————————————————————————
// 最小假 React（只做建节点 / 按路径复用 hook 槽 / setState 标脏 / 渲染后补跑 effect）
// ——————————————————————————————————————————————

/** @returns {object} 含 `React` 与挂载方法的运行时。 */
function createRuntime() {
  const instances = new Map()
  let current = null
  let pendingEffects = []
  let dirty = false
  let rootNode = null
  let tree = null

  /** 依赖数组是否变化（语义同 React：长度或任一项 !== 即变化）。 */
  function depsChanged(previous, next) {
    if (previous === undefined || next === undefined) return true
    if (previous.length !== next.length) return true
    for (let index = 0; index < previous.length; index += 1) {
      if (!Object.is(previous[index], next[index])) return true
    }
    return false
  }

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

  function renderTree() {
    dirty = false
    pendingEffects = []
    tree = renderNode(rootNode, 'root')
    const effects = pendingEffects
    pendingEffects = []
    for (const run of effects) run()
    return tree
  }

  function tick() {
    return new Promise((resolve) => {
      setImmediate(resolve)
    })
  }

  const runtime = {
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
            /* 订阅失败只影响语言刷新 */
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
     * 挂载组件并渲染首屏。
     * @param {Function} Component - 组件函数。
     * @param {object} [props] - 宿主 props。
     * @returns {Promise<object>} 页柄。
     */
    async open(Component, props = {}) {
      rootNode = runtime.React.createElement(Component, props)
      renderTree()
      const page = {
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
 * @param {object<string, Function>} handlers - 处理器表。
 * @returns {{ fetch: Function, calls: Array, requests: Function }} 假 fetch 与调用记录。
 */
function createFetch(handlers) {
  const calls = []

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
     * 已发生的调用列表。
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
 * @param {string} key - 键。
 * @param {object} [params] - 占位符。
 * @returns {string} 文案。
 */
function interpolate(dictionary, key, params) {
  const template = dictionary?.[key]
  if (typeof template !== 'string') return key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name) => (params[name] === undefined ? match : String(params[name])))
}

// ——————————————————————————————————————————————
// 词典读取与扁平化（供四处逐键比对）
// ——————————————————————————————————————————————

/** 递归展开嵌套对象为 `a.b` 形式的键集合。 */
function flatKeys(value, prefix = '', out = new Set()) {
  for (const [key, child] of Object.entries(value)) {
    const full = prefix ? `${prefix}.${key}` : key
    if (child !== null && typeof child === 'object' && !Array.isArray(child)) flatKeys(child, full, out)
    else out.add(full)
  }
  return out
}

/**
 * 从 lib/client.js 源码里取出内嵌词典（靠既有的 __EN_START__ / __EN_END__ 标记定位）。
 * @param {'EN'|'ZH'} mark - 词典标记。
 * @returns {object<string, string>} 词典。
 */
function embeddedDictionary(mark) {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  const start = source.indexOf(`/*__${mark}_START__*/`)
  const end = source.indexOf(`/*__${mark}_END__*/`)
  assert.ok(start > 0 && end > start, `找不到 __${mark}_START__/__${mark}_END__ 标记`)
  const text = source.slice(start + `/*__${mark}_START__*/`.length, end)
  // 内嵌词典是手写的，容忍尾随逗号。
  return JSON.parse(text.replace(/,(\s*[}\]])/g, '$1'))
}

/** 递归展开为 `a.b` → 值 的扁平表。 */
function flatValues(value, prefix = '', out = {}) {
  for (const [key, child] of Object.entries(value)) {
    const full = prefix ? `${prefix}.${key}` : key
    if (child !== null && typeof child === 'object' && !Array.isArray(child)) flatValues(child, full, out)
    else out[full] = child
  }
  return out
}

/** 读一份 locale/*.json。 */
function localeJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

// ——————————————————————————————————————————————
// 假宿主装载
// ——————————————————————————————————————————————

/**
 * 一份够用的 bootstrap 响应 data。
 *
 * 默认人设按 **v6 的真实形态**给：slug 是小写 `default`，显示名是 `Default`
 * （§V6.0：slug 与 personaKey / resolveScope 的兜底键同名，面板上那一行看起来没变）。
 * 「mock 必须反映当前版本的真实形态」是 v5 的教训——那会儿默认人设真是大写 `Default`，
 * 而 mock 写的是小写，于是「🗑 在真机上永不禁用」全绿漏过。如今真实形态换成小写，
 * mock 就跟着换成小写；大写变体只留在专门测大小写的那几条用例里（见 openWithPersona）。
 * @param {object} [overrides] - 覆盖项（写 undefined 表示该键不存在）。
 * @returns {object} data。
 */
function bootstrapData(overrides = {}) {
  const data = {
    enabled: true,
    personas: [
      { slug: 'default', name: 'Default' },
      { slug: 'huihui', name: '灰灰' },
    ],
    currentPersona: { slug: 'huihui', name: '灰灰' },
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

/**
 * 按 persona 返回不同正文的 doc 响应，用来验证「删除后确实按新人设重新载入」。
 * @param {string} query - 查询串。
 * @returns {object} doc 响应体。
 */
function docBodyFor(query) {
  const params = new URLSearchParams(query)
  const persona = params.get('persona') ?? 'default'
  const scope = params.get('scope') ?? 'soul'
  return {
    ok: true,
    data: {
      content: `# ${persona}/${scope}\n`,
      bytes: 12,
      mtimeMs: 1000,
      path: `/home/user/.dsh/supermemory/personas/${persona}/${scope}.md`,
    },
  }
}

/**
 * 装载 lib/client.js 并装配假宿主上下文。
 * @param {object} [options] - 选项。
 * @param {object<string, Function>} [options.routes] - 接口处理器覆盖。
 * @param {string} [options.language] - 词典语言，默认 zh。
 * @returns {Promise<object>} 装载结果。
 */
async function loadClient(options = {}) {
  const runtime = createRuntime()
  const source = readFileSync(CLIENT_PATH, 'utf8')
  const runScript = new Function('window', 'fetch', source)
  const loader = {
    modules: [],
    load(module) {
      this.modules.push(module)
    },
  }
  const fake = createFetch(options.routes ?? {})
  runScript({ __ModuleLoader__: loader }, fake.fetch)
  assert.equal(loader.modules.length, 1, '工厂必须恰好 load 一次')
  const descriptor = loader.modules[0]
  const exported = descriptor.factory((name) => {
    if (name === 'react') return runtime.React
    throw new Error(`客户端不该 require 其它模块：${name}`)
  })

  const slots = []
  let dictionaries = null
  /** 当前语言的词典（register 之后才有值）。 */
  const dictionary = () => (options.language === 'en' ? dictionaries?.en : dictionaries?.zh)
  const ctx = {
    effect: (fn) => fn(),
    get: (name) => (name === 'layout' ? { selectPanel: () => {} } : undefined),
    locale: {
      register(namespace, dict) {
        dictionaries = dict
        return { namespace }
      },
      bind: (namespace) => (key, params) => interpolate(dictionary(), key, params),
      subscribe: () => () => {},
      getSnapshot: () => ({ revision: 0 }),
    },
    slots: {
      inject: (name, factory) => factory(),
      register: (meta, Component) => slots.push({ meta, Component }),
    },
  }
  exported.apply(ctx)

  return {
    id: descriptor.id,
    calls: fake.calls,
    requests: fake.requests,
    /** 取词典文案（拼期望值用，避免把中文长句硬编码进断言）。 */
    text: (key, params) => interpolate(dictionary(), key, params),
    /**
     * 打开注册过的位置。
     * @param {string} name - 槽位名。
     * @param {object} [props] - 组件 props。
     * @returns {Promise<object>} 页柄。
     */
    async open(name, props = {}) {
      const entry = slots.find((item) => item.meta.name === name)
      assert.ok(entry, `未注册槽位 ${name}`)
      return runtime.open(entry.Component, props)
    },
  }
}

/** 面板页要用到的接口默认表（PATCH / DELETE 由用例覆盖，默认直接报错防止漏断言）。 */
function panelRoutes(overrides = {}) {
  return {
    'GET bootstrap': () => ({ status: 200, body: { ok: true, data: bootstrapData() } }),
    'GET runs': () => ({ status: 200, body: { ok: true, data: [] } }),
    'GET models': () => ({ status: 200, body: { ok: true, data: { models: [] } } }),
    'GET doc': ({ query }) => ({ status: 200, body: docBodyFor(query) }),
    ...overrides,
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

/** 按 aria-label 筛选。 */
const byAria = (label) => (node) => node.props?.['aria-label'] === label

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
 * @param {string} what - 出错说明。
 * @returns {object} 节点。
 */
function mustFind(root, predicate, what) {
  const found = walk(root).filter(predicate)
  assert.equal(found.length, 1, `期望恰好一个${what}，实际 ${found.length} 个`)
  return found[0]
}

/** 图标按钮（✎ / 🗑），按 aria-label 区分。 */
function iconButton(root, label) {
  return walk(root).find((node) => node.type === 'button' && byClass('sm-icon-btn')(node) && node.props['aria-label'] === label)
}

/** 当前所有错误提示条文本。 */
function errorNotices(root) {
  return walk(root).filter(byClass('sm-notice-error')).map(textOf)
}

/**
 * 人设下拉。topbar 里有人设与项目两个 `.sm-select`，靠 aria-label 区分。
 * @param {object} root - 渲染树根。
 * @param {string} label - panel.persona 的文案。
 * @returns {object} select 节点。
 */
function personaSelect(root, label) {
  return mustFind(root, (node) => node.type === 'select' && byAria(label)(node), '人设下拉')
}

/** 成功提示条文本。 */
function okNotices(root) {
  return walk(root).filter(byClass('sm-notice-ok')).map(textOf)
}

/** 人设输入框（添加或重命名，按 aria-label 区分）。 */
function inputByAria(root, label) {
  return walk(root).find((node) => node.type === 'input' && node.props['aria-label'] === label)
}

/** 下拉的 option 文本列表。 */
function optionTexts(root) {
  return walk(root)
    .filter((node) => node.type === 'option')
    .map(textOf)
}

/**
 * 触发一次点击并驱动渲染。
 * @param {object} page - 页柄。
 * @param {object} node - 目标节点。
 * @returns {Promise<void>} 驱动完成。
 */
async function click(page, node) {
  assert.equal(typeof node.props.onClick, 'function', '目标元素必须有 onClick')
  node.props.onClick({ type: 'click', target: {}, currentTarget: {} })
  await page.settle()
}

/** 往输入框里打字（走 onChange）。 */
async function type(page, node, value) {
  node.props.onChange({ target: { value } })
  await page.settle()
}

/** 给编辑器 textarea 造一份未保存草稿。 */
async function makeDraft(page, value) {
  const area = mustFind(page.tree, byClass('sm-textarea'), '编辑器')
  area.props.onChange({ target: { value } })
  await page.settle()
}

// ——————————————————————————————————————————————
// 词典四处逐键同步
// ——————————————————————————————————————————————

test('词典四处逐键一致：client.js 内嵌 en/zh 与 locale/en.json、locale/zh.json 键集合完全相等', () => {
  const sets = {
    'client.js en': flatKeys(embeddedDictionary('EN')),
    'client.js zh': flatKeys(embeddedDictionary('ZH')),
    'locale/en.json': flatKeys(localeJson(EN_JSON_PATH)),
    'locale/zh.json': flatKeys(localeJson(ZH_JSON_PATH)),
  }
  const names = Object.keys(sets)
  const reference = sets[names[0]]
  for (const name of names) {
    const difference = [...reference].filter((key) => !sets[name].has(key)).concat([...sets[name]].filter((key) => !reference.has(key)))
    assert.deepEqual(difference.sort(), [], `${name} 与 ${names[0]} 键集合不一致`)
  }
  // v5 的 8 个新键必须四处都在，且值非空。
  for (const [label, set] of Object.entries(sets)) {
    for (const key of V5_KEYS) assert.ok(set.has(key), `${label} 缺 ${key}`)
  }
  assert.ok(reference.size > 90, `词典规模异常：${reference.size}`)
})

test('v5 八个新键的中文文案与契约 §V5.6 表逐字相同（内嵌词典与 locale 都要对）', () => {
  const sources = {
    'client.js zh': embeddedDictionary('ZH'),
    'locale/zh.json': flatValues(localeJson(ZH_JSON_PATH)),
  }
  for (const [label, dict] of Object.entries(sources)) {
    for (const [key, expected] of Object.entries(V5_ZH)) {
      assert.equal(dict[key], expected, `${label} 的 ${key} 文案不符`)
    }
  }
  // en 侧同键必须都有非空文案，且占位符不能丢。
  const en = embeddedDictionary('EN')
  for (const key of V5_KEYS) {
    assert.equal(typeof en[key], 'string', `en 缺 ${key}`)
    assert.ok(en[key].trim().length > 0, `en 的 ${key} 为空`)
  }
  assert.ok(en['panel.personaDeleteConfirm'].includes('{name}'), 'en 确认文案要保留 {name} 占位符')
  assert.ok(en['panel.personaRenameFailed'].includes('{error}'), 'en 失败文案要保留 {error} 占位符')
  assert.ok(en['panel.personaDeleteFailed'].includes('{error}'), 'en 删除失败文案要保留 {error} 占位符')
})

// ——————————————————————————————————————————————
// idle 态：两个入口与禁用条件
// ——————————————————————————————————————————————

test('idle 态：✎ 与 🗑 都在下拉旁，默认选中 huihui 时两者可用且带 aria-label', async () => {
  const client = await loadClient({ routes: panelRoutes({}) })
  const page = await client.open('main')

  const rename = iconButton(page.tree, client.text('panel.personaRename'))
  const remove = iconButton(page.tree, client.text('panel.personaDelete'))
  assert.ok(rename, '缺重命名按钮')
  assert.ok(remove, '缺删除按钮')
  assert.equal(rename.props.disabled, false)
  assert.equal(remove.props.disabled, false, '选中的是 huihui，删除应可用')
  assert.equal(remove.props.title, client.text('panel.personaDelete'))
  // 图标本身不进可访问名（aria-hidden），可访问名由按钮 aria-label 承担。
  const svg = walk(rename).find((node) => node.type === 'svg')
  assert.ok(svg, '按钮内应有内联 svg 图标')
  assert.equal(svg.props['aria-hidden'], 'true')
  assert.equal(textOf(svg), '', '图标不得产出文本')
  // 既有「+ 添加人设」仍在，且没有内联表单。
  assert.ok(buttonByText(page.tree, client.text('panel.personaAdd')))
  assert.equal(inputByAria(page.tree, client.text('panel.personaAdd')), undefined, 'idle 态不得有添加输入框')
})

/**
 * 打开面板并把当前选中人设换成指定条目。
 * @param {{slug:string,name:string}} entry - 要选中的人设（会成为 bootstrap 的 currentPersona）。
 * @param {object<string, Function>} [routes] - 额外的接口处理器。
 * @returns {Promise<{client: object, page: object}>} 装载结果与页柄。
 */
async function openWithPersona(entry, routes = {}) {
  const client = await loadClient({
    routes: panelRoutes({
      'GET bootstrap': () => ({
        status: 200,
        body: {
          ok: true,
          data: bootstrapData({
            personas: [entry, { slug: 'huihui', name: '灰灰' }],
            currentPersona: entry,
          }),
        },
      }),
      ...routes,
    }),
  })
  return { client, page: await client.open('main') }
}

test('🗑 禁用：选中真实默认人设 Default（大写 D）时必须 disabled 且 title 给原因', async () => {
  // 这条就是 v5 真实环境踩过的坑：真实 slug 是 'Default'，逐字比小写 'default' 永不命中，
  // 于是禁用条件在真机上从不上岗。mock 必须用真实大小写，否则测了等于没测。
  const { client, page } = await openWithPersona({ slug: 'Default', name: 'Default' })

  const remove = iconButton(page.tree, client.text('panel.personaDelete'))
  assert.ok(remove, 'Default 也要渲染出 🗑（禁用而不是藏起来）')
  assert.equal(remove.props.disabled, true, "真实默认人设 'Default' 的删除入口必须禁用")
  assert.equal(remove.props.title, client.text('panel.personaDeleteLocked'), '禁用原因要写进 title')
  assert.equal(iconButton(page.tree, client.text('panel.personaRename')).props.disabled, false, 'Default 仍可改名（只改显示名）')
})

test('🗑 禁用：历史数据里的小写 default 同样禁用（判定大小写不敏感，与 store 同口径）', async () => {
  const { client, page } = await openWithPersona({ slug: 'default', name: 'Default' })

  const remove = iconButton(page.tree, client.text('panel.personaDelete'))
  assert.equal(remove.props.disabled, true, "小写 'default' 也必须禁用")
  assert.equal(remove.props.title, client.text('panel.personaDeleteLocked'))
})

test('🗑 可用：选中的是中文显示名的普通人设时不该被误禁', async () => {
  const { client, page } = await openWithPersona({ slug: 'mingming', name: '明明' })

  const remove = iconButton(page.tree, client.text('panel.personaDelete'))
  assert.equal(remove.props.disabled, false, '普通人设的删除入口必须可用')
  assert.equal(remove.props.title, client.text('panel.personaDelete'), '未禁用时 title 是动作名，不是禁用原因')
})

test('内层防护：Default 时即使绕过 disabled 直接点「删除」，也不会发出 DELETE', async () => {
  // 这层不是冗余：将来谁把按钮的 disabled 摘掉，submitPersonaDelete 的闸门仍然挡住，
  // 而这条用例存在的意义就是证明「摘掉 disabled 不会变成能删 Default」。
  // 写法照 test/client-toggle.test.js 测 runDigest 内层防护那条：直接调 onClick，不看 disabled。
  for (const slug of ['Default', 'default']) {
    const { client, page } = await openWithPersona(
      { slug, name: 'Default' },
      {
        'DELETE personas': () => {
          throw new Error(`${slug} 受保护，根本不该发起 DELETE`)
        },
      },
    )
    const docsBefore = client.requests('doc').length

    await click(page, iconButton(page.tree, client.text('panel.personaDelete')))
    await click(page, mustFind(page.tree, byButtonText(client.text('panel.personaDelete')), '「删除」按钮'))

    assert.equal(client.requests('personas', 'DELETE').length, 0, `${slug}：内层防护必须挡住 DELETE 请求`)
    assert.equal(personaSelect(page.tree, client.text('panel.persona')).props.value, slug, `${slug}：本地 persona 不得被改动`)
    assert.equal(client.requests('doc').length, docsBefore, `${slug}：被挡下时不得清文档重载`)
    assert.deepEqual(errorNotices(page.tree), [], `${slug}：被防护挡掉时不该弹错误`)
    assert.deepEqual(okNotices(page.tree), [], `${slug}：没删成就不该报删除成功`)
  }
})

test('没有任何人设时 ✎ 也禁用（没有可改名的目标）', async () => {
  const client = await loadClient({
    routes: panelRoutes({
      'GET bootstrap': () => ({
        status: 200,
        body: { ok: true, data: bootstrapData({ personas: [], currentPersona: undefined }) },
      }),
    }),
  })
  const page = await client.open('main')

  assert.equal(iconButton(page.tree, client.text('panel.personaRename')).props.disabled, true)
  assert.ok(optionTexts(page.tree).includes(client.text('panel.noPersona')), '下拉应显示没有人设')
})

// ——————————————————————————————————————————————
// 重命名
// ——————————————————————————————————————————————

test('点 ✎ 进入重命名态：输入框预填当前显示名，✎ 🗑 与「+ 添加人设」一起收起', async () => {
  const client = await loadClient({ routes: panelRoutes({}) })
  const page = await client.open('main')

  await click(page, iconButton(page.tree, client.text('panel.personaRename')))

  const box = inputByAria(page.tree, client.text('panel.personaRename'))
  assert.ok(box, '重命名输入框必须出现')
  assert.equal(box.props.value, '灰灰', '预填的必须是当前选中人设的显示名，不是 slug')
  assert.equal(box.props.maxLength, 60, '长度上限与服务端一致')
  assert.equal(buttonByText(page.tree, client.text('panel.save')).props.disabled, false)
  assert.ok(buttonByText(page.tree, client.text('panel.personaCancel')))
  assert.equal(iconButton(page.tree, client.text('panel.personaRename')), undefined, '三态互斥：进入后图标按钮要收起')
  assert.equal(iconButton(page.tree, client.text('panel.personaDelete')), undefined)
  assert.equal(buttonByText(page.tree, client.text('panel.personaAdd')), undefined, '「+ 添加人设」不得同时出现')
  assert.deepEqual(errorNotices(page.tree), [])
})

test('重命名清空后保存禁用；改名后保存发 PATCH，成功后只刷 bootstrap 不重载文档', async () => {
  let bootstrapReads = 0
  const client = await loadClient({
    routes: panelRoutes({
      'GET bootstrap': () => {
        bootstrapReads += 1
        const name = bootstrapReads === 1 ? '灰灰' : '灰灰大人'
        return {
          status: 200,
          body: {
            ok: true,
            data: bootstrapData({
              personas: [
                { slug: 'default', name: 'Default' },
                { slug: 'huihui', name },
              ],
              currentPersona: { slug: 'huihui', name },
            }),
          },
        }
      },
      'PATCH personas': () => ({
        status: 200,
        body: { ok: true, data: { personas: [], current: { slug: 'huihui', name: '灰灰大人' } } },
      }),
    }),
  })
  const page = await client.open('main')
  const docsBefore = client.requests('doc').length
  assert.ok(docsBefore > 0, '首屏应当已载入过文档')

  await click(page, iconButton(page.tree, client.text('panel.personaRename')))
  let box = inputByAria(page.tree, client.text('panel.personaRename'))
  await type(page, box, '   ')
  box = inputByAria(page.tree, client.text('panel.personaRename'))
  assert.equal(buttonByText(page.tree, client.text('panel.save')).props.disabled, true, '纯空白不该能提交')

  await type(page, box, '灰灰大人')
  await click(page, buttonByText(page.tree, client.text('panel.save')))

  const patches = client.requests('personas', 'PATCH')
  assert.equal(patches.length, 1, '必须发一次 PATCH personas')
  assert.deepEqual(patches[0].body, { slug: 'huihui', name: '灰灰大人' }, 'body 必须是 { slug, name }')
  assert.equal(bootstrapReads, 2, '成功后必须刷 bootstrap 拿新显示名')
  assert.equal(client.requests('doc').length, docsBefore, '重命名不得重载四个记忆分区（人设名不参与路径）')
  assert.ok(optionTexts(page.tree).includes('灰灰大人'), '下拉必须显示新名字')
  assert.deepEqual(okNotices(page.tree), [client.text('panel.personaRenamed')])
  assert.deepEqual(errorNotices(page.tree), [])
  // 回到 idle：图标按钮回来，输入框消失。
  assert.ok(iconButton(page.tree, client.text('panel.personaRename')))
  assert.equal(inputByAria(page.tree, client.text('panel.personaRename')), undefined)
})

test('重命名失败：报 personaRenameFailed、留在表单里、不刷 bootstrap 也不重载文档', async () => {
  const client = await loadClient({
    routes: panelRoutes({
      'PATCH personas': () => ({ status: 400, body: { ok: false, code: 'BAD_INPUT', error: '名称不能为空' } }),
    }),
  })
  const page = await client.open('main')
  const docsBefore = client.requests('doc').length

  await click(page, iconButton(page.tree, client.text('panel.personaRename')))
  await click(page, buttonByText(page.tree, client.text('panel.save')))

  assert.equal(client.requests('personas', 'PATCH').length, 1)
  assert.equal(client.requests('bootstrap').length, 1, '失败路径不得再刷 bootstrap')
  assert.equal(client.requests('doc').length, docsBefore)
  assert.deepEqual(errorNotices(page.tree), [client.text('panel.personaRenameFailed', { error: '名称不能为空' })])
  assert.equal(inputByAria(page.tree, client.text('panel.personaRename')).props.value, '灰灰', '失败要留着输入内容让用户改')
  assert.ok(buttonByText(page.tree, client.text('panel.personaCancel')), '失败后仍可取消')
})

test('重命名：回车提交、Escape 取消，取消不发任何请求', async () => {
  const client = await loadClient({ routes: panelRoutes({}) })
  const page = await client.open('main')

  await click(page, iconButton(page.tree, client.text('panel.personaRename')))
  let box = inputByAria(page.tree, client.text('panel.personaRename'))
  await type(page, box, '新名字')
  box = inputByAria(page.tree, client.text('panel.personaRename'))
  box.props.onKeyDown({ key: 'Escape' })
  await page.settle()

  assert.equal(inputByAria(page.tree, client.text('panel.personaRename')), undefined, 'Escape 必须收起表单')
  assert.equal(client.requests('personas', 'PATCH').length, 0, '取消不得发请求')
  assert.ok(iconButton(page.tree, client.text('panel.personaRename')), '取消后回到 idle')

  await click(page, iconButton(page.tree, client.text('panel.personaRename')))
  box = inputByAria(page.tree, client.text('panel.personaRename'))
  box.props.onKeyDown({ key: 'Enter' })
  await page.settle()
  assert.equal(client.requests('personas', 'PATCH').length, 1, 'Enter 等价于点保存')
})

// ——————————————————————————————————————————————
// 删除
// ——————————————————————————————————————————————

test('点 🗑 进入确认态：文案带当前人设名，取消不发 DELETE', async () => {
  const client = await loadClient({ routes: panelRoutes({}) })
  const page = await client.open('main')

  await click(page, iconButton(page.tree, client.text('panel.personaDelete')))

  const confirm = mustFind(page.tree, (node) => node.props?.role === 'alert', '删除确认条')
  assert.equal(textOf(confirm).startsWith(client.text('panel.personaDeleteConfirm', { name: '灰灰' })), true, '确认文案必须内插当前人设名')
  assert.ok(client.text('panel.personaDeleteConfirm').includes('不可撤销'), '确认文案必须说明不可撤销')
  const danger = mustFind(confirm, byButtonText(client.text('panel.personaDelete')), '「删除」按钮')
  assert.ok(danger.props.className.split(/\s+/).includes('sm-btn-danger'), '危险按钮用 .sm-btn-danger')
  assert.equal(danger.props.disabled, false)
  assert.equal(buttonByText(page.tree, client.text('panel.personaAdd')), undefined, '确认态与添加表单互斥')
  assert.equal(iconButton(page.tree, client.text('panel.personaDelete')), undefined, '确认态图标按钮收起')

  await click(page, buttonByText(page.tree, client.text('panel.personaCancel')))
  assert.equal(client.requests('personas', 'DELETE').length, 0, '取消绝不发删除请求')
  assert.ok(iconButton(page.tree, client.text('panel.personaDelete')), '取消后回到 idle')
  assert.deepEqual(errorNotices(page.tree), [])
})

test('确认删除：发 DELETE { slug }，成功后下拉切到 current.slug、草稿清空、文档按新人设重载', async () => {
  const DEFAULT = { slug: 'default', name: 'Default' }
  let deleted = false
  const client = await loadClient({
    routes: panelRoutes({
      'DELETE personas': () => {
        deleted = true
        return { status: 200, body: { ok: true, data: { personas: [DEFAULT], current: DEFAULT } } }
      },
      // 删除之后 bootstrap 只剩 Default，与 DELETE 回带一致。
      'GET bootstrap': () => ({
        status: 200,
        body: {
          ok: true,
          data: deleted
            ? bootstrapData({ personas: [DEFAULT], currentPersona: DEFAULT })
            : bootstrapData(),
        },
      }),
    }),
  })
  const page = await client.open('main')

  // 先造一份属于 huihui 的未保存草稿——删除后它绝不能出现在 Default 的编辑器里。
  await makeDraft(page, '# huihui/未保存的草稿\n')
  const area = mustFind(page.tree, byClass('sm-textarea'), '编辑器')
  assert.equal(area.props.value.includes('未保存的草稿'), true, '草稿此刻应正在编辑器里')
  const docsBefore = client.requests('doc').length

  await click(page, iconButton(page.tree, client.text('panel.personaDelete')))
  await click(page, mustFind(page.tree, byButtonText(client.text('panel.personaDelete')), '「删除」按钮'))

  const deletes = client.requests('personas', 'DELETE')
  assert.equal(deletes.length, 1, '必须发一次 DELETE personas')
  assert.deepEqual(deletes[0].body, { slug: 'huihui' }, 'body 必须带被删的 slug')

  const select = personaSelect(page.tree, client.text('panel.persona'))
  assert.equal(select.props.value, 'default', '本地 persona 必须切到响应回带的 current.slug')
  const after = client.requests('doc')
  assert.ok(after.length > docsBefore, '删除后必须重新载入文档')
  const lastPersona = new URLSearchParams(after[after.length - 1].query).get('persona')
  assert.equal(lastPersona, 'default', '重载请求必须打给新人设')
  const reloaded = mustFind(page.tree, byClass('sm-textarea'), '编辑器')
  assert.equal(reloaded.props.value.includes('未保存的草稿'), false, '已删人设的草稿必须被清掉')
  assert.equal(reloaded.props.value.includes('default/soul'), true, '编辑器应显示新人设的正文')
  assert.ok(client.text('panel.personaDeleted').length > 0)
  assert.deepEqual(okNotices(page.tree), [client.text('panel.personaDeleted')])
  assert.deepEqual(errorNotices(page.tree), [])
})

test('删除回带 current 为空（注册表里没有 default 条目的迁移场景）：逐级兜底，绝不把本地 persona 置空', async () => {
  const cases = [
    {
      name: '响应还有剩余人设 → 切到 personas[0]',
      deleteData: { personas: [{ slug: 'koko', name: '可可' }], current: null },
      afterBootstrap: { personas: [{ slug: 'koko', name: '可可' }], currentPersona: undefined },
      expected: 'koko',
      // persona 变了，既有的 loadDocs effect 会重跑。
      reloaded: true,
    },
    {
      name: '响应里连人设都没有 → 保留本地值，不置空',
      deleteData: { personas: [], current: null },
      afterBootstrap: { personas: [], currentPersona: undefined },
      expected: 'huihui',
      reloaded: false,
    },
  ]
  for (const testCase of cases) {
    let deleted = false
    const client = await loadClient({
      routes: panelRoutes({
        'DELETE personas': () => {
          deleted = true
          return { status: 200, body: { ok: true, data: testCase.deleteData } }
        },
        'GET bootstrap': () => ({
          status: 200,
          body: { ok: true, data: bootstrapData(deleted ? testCase.afterBootstrap : {}) },
        }),
      }),
    })
    const page = await client.open('main')
    const docsBefore = client.requests('doc').length

    await click(page, iconButton(page.tree, client.text('panel.personaDelete')))
    await click(page, mustFind(page.tree, byButtonText(client.text('panel.personaDelete')), '「删除」按钮'))

    assert.equal(personaSelect(page.tree, client.text('panel.persona')).props.value, testCase.expected, testCase.name)
    const docs = client.requests('doc')
    const lastPersona = new URLSearchParams(docs[docs.length - 1].query).get('persona')
    assert.equal(lastPersona, testCase.expected, `${testCase.name}：文档请求必须打给兜底后的人设，不能悄悄落到 default`)
    if (testCase.reloaded) assert.ok(docs.length > docsBefore, `${testCase.name}：persona 变了，文档必须重载`)
    assert.deepEqual(okNotices(page.tree), [client.text('panel.personaDeleted')], testCase.name)
    assert.deepEqual(errorNotices(page.tree), [], testCase.name)
  }
})

test('删除失败 409 PERSONA_PROTECTED：提示用 personaDeleteLocked，不做任何重载', async () => {
  const client = await loadClient({
    routes: panelRoutes({
      'DELETE personas': () => ({ status: 409, body: { ok: false, code: 'PERSONA_PROTECTED', error: 'Default 不能删' } }),
    }),
  })
  const page = await client.open('main')
  const docsBefore = client.requests('doc').length

  await click(page, iconButton(page.tree, client.text('panel.personaDelete')))
  await click(page, mustFind(page.tree, byButtonText(client.text('panel.personaDelete')), '「删除」按钮'))

  assert.deepEqual(errorNotices(page.tree), [client.text('panel.personaDeleteLocked')], '受保护必须给专门文案而不是通用失败')
  assert.equal(client.requests('bootstrap').length, 1, '失败不得顺手刷 bootstrap')
  assert.equal(client.requests('doc').length, docsBefore, '失败不得清文档重载')
  assert.equal(walk(page.tree).filter((node) => node.props?.role === 'alert').length, 0, '失败后确认条必须收起')
  assert.ok(iconButton(page.tree, client.text('panel.personaDelete')), '失败退回 idle，🗑 重新出现（人设并未被删，入口仍该在）')
  assert.deepEqual(okNotices(page.tree), [])
})

test('删除失败（其它错误码）：提示 personaDeleteFailed 带服务端原因', async () => {
  const client = await loadClient({
    routes: panelRoutes({
      'DELETE personas': () => ({ status: 500, body: { ok: false, code: 'UNWRITABLE', error: '磁盘写入失败' } }),
    }),
  })
  const page = await client.open('main')

  await click(page, iconButton(page.tree, client.text('panel.personaDelete')))
  await click(page, mustFind(page.tree, byButtonText(client.text('panel.personaDelete')), '「删除」按钮'))

  assert.deepEqual(errorNotices(page.tree), [client.text('panel.personaDeleteFailed', { error: '磁盘写入失败' })])
})

// ——————————————————————————————————————————————
// busy 与互斥
// ——————————————————————————————————————————————

test('请求在途（busy）时人设区控件全 disabled，避免连点发出第二次请求', async () => {
  let releaseDigest
  let releasePatch
  const client = await loadClient({
    routes: panelRoutes({
      'POST digest': () => new Promise((resolve) => { releaseDigest = resolve }),
      'PATCH personas': () => new Promise((resolve) => { releasePatch = resolve }),
    }),
  })
  const page = await client.open('main')

  // 一、busy 且 idle（整理在途）：图标按钮必须都禁用。
  await click(page, buttonByText(page.tree, client.text('panel.digest.now')))
  assert.equal(client.requests('digest', 'POST').length, 1, '整理请求应在途')
  assert.equal(iconButton(page.tree, client.text('panel.personaRename')).props.disabled, true, 'busy 时 ✎ 必须禁用')
  assert.equal(iconButton(page.tree, client.text('panel.personaDelete')).props.disabled, true, 'busy 时 🗑 必须禁用')
  assert.equal(buttonByText(page.tree, client.text('panel.personaAdd')).props.disabled, true, 'busy 时「+ 添加人设」也必须禁用')
  releaseDigest({ status: 200, body: { ok: true, data: { record: { ok: true, counts: {} } } } })
  await page.settle()
  assert.equal(iconButton(page.tree, client.text('panel.personaRename')).props.disabled, false, '整理结束后解除禁用')

  // 二、busy 且在重命名表单里（PATCH 在途）：表单控件必须都禁用。
  await click(page, iconButton(page.tree, client.text('panel.personaRename')))
  await click(page, buttonByText(page.tree, client.text('panel.save')))

  assert.equal(client.requests('personas', 'PATCH').length, 1)
  assert.equal(personaSelect(page.tree, client.text('panel.persona')).props.disabled, true, '在途时下拉必须禁用')
  assert.equal(buttonByText(page.tree, client.text('panel.personaCancel')).props.disabled, true, '在途时取消也要禁用')
  assert.equal(buttonByText(page.tree, client.text('panel.save')).props.disabled, true, '在途时保存按钮必须禁用')

  releasePatch({ status: 200, body: { ok: true, data: { personas: [], current: { slug: 'huihui', name: '灰灰' } } } })
  await page.settle()
  assert.equal(iconButton(page.tree, client.text('panel.personaRename')).props.disabled, false, '结束后解除禁用')
})

test('互斥：先开「+ 添加人设」，再点 ✎，添加表单必须收起；切换人设也会复位 idle', async () => {
  const client = await loadClient({
    routes: panelRoutes({
      'PUT personas': () => ({ status: 200, body: { ok: true, data: { personas: [], current: { slug: 'default', name: 'Default' } } } }),
    }),
  })
  const page = await client.open('main')

  await click(page, buttonByText(page.tree, client.text('panel.personaAdd')))
  assert.ok(inputByAria(page.tree, client.text('panel.personaAdd')), '添加表单应已打开')

  await click(page, iconButton(page.tree, client.text('panel.personaRename')))
  assert.equal(inputByAria(page.tree, client.text('panel.personaAdd')), undefined, '重命名打开时添加表单必须收起')
  assert.ok(inputByAria(page.tree, client.text('panel.personaRename')), '重命名表单应已打开')

  // 切换人设：重命名表单也必须复位 idle（它针对的是切换前的那个人设）。
  const select = personaSelect(page.tree, client.text('panel.persona'))
  select.props.onChange({ target: { value: 'default' } })
  await page.settle()
  assert.equal(inputByAria(page.tree, client.text('panel.personaRename')), undefined, '切换人设后重命名表单必须收起')
  assert.equal(client.requests('personas', 'PATCH').length, 0, '切换只发 PUT，不得顺手提交重命名')
  assert.ok(iconButton(page.tree, client.text('panel.personaRename')), '切换后回到 idle')
})

test('客户端不得用 window.confirm / window.prompt（v2 起既定约束）', () => {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  assert.equal(/window\.(confirm|prompt|alert)\s*\(/.test(source), false, '源码里不得出现 window.confirm/prompt/alert')
})
