/**
 * `lib/host/routes.js` 与 `lib/host/digest.js` 的单元测试（v2）。
 *
 * 覆盖（契约 §10 routes 组 + §5.4 + v2 §V2.3/§V2.4/§V2.8）：
 *   - 信任栅栏：非 loopback socket / 代理头 / cross-site / 异源 Origin / 非 loopback Host → 403。
 *   - 正常 loopback + 同源 → 200 且 `{ ok:true, data }`。
 *   - bootstrap v2 新结构；models 路由；settings PUT；personas GET/POST/PUT 与名称校验，
 *     v5 补 PATCH（改显示名）/ DELETE（删人设）：错误码映射、响应同构、关闭态不拦（§V5.7）。
 *   - doc 路由 persona 参数（兼容 presetId）、路径穿越 → 400；PUT 冲突 409；请求体超限 413。
 *   - 整理器：llm 缺失不抛；并发只跑一个；**只写 project（soul/user/global 输出被丢弃）**；
 *     模型选择四层回退（settings → config → currentRoute → agentDefaultModel）。
 *
 * 说明：403 用例需要伪造 socket / headers，因此既用 mock req/res 直连 handler，
 * 也用 node:http 起真实回环服务验证端到端行为。
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { after, before, describe, it } from 'node:test'

import { installRoutes, isTrustedRequest } from '../lib/host/routes.js'
import { createDigestRunner } from '../lib/host/digest.js'
import { createStore } from '../lib/core/store.js'
import { resolveConfig } from '../lib/host/config.js'

// ---------------------------------------------------------------- 测试工具

/** 临时目录（整个文件共享）。 */
let workDir
let store
let personasRoot

before(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'dsh-sm-routes-'))
  personasRoot = join(workDir, 'personas')
  const config = resolveConfig({
    presetsRoot: personasRoot,
    personasRoot,
    projectDirName: '.dsh/memory',
    projectFileName: 'project-memory.md',
  })
  // v2 的 store 可能带 ready（迁移）；v1 store 没有该字段。
  store = createStore({ dshHome: workDir, presetsRoot: personasRoot, personasRoot, config, logger: { warn() {}, info() {} } })
  if (store?.ready !== undefined) await store.ready
})

after(async () => {
  await store?.dispose?.()
  await rm(workDir, { recursive: true, force: true })
})

/**
 * 构造一个假 cordis ctx，收集路由注册。
 * @param {object} [services] - `ctx.get(name)` 要返回的服务。
 * @returns {{ctx:object, routes:Map<string,Function>, disposers:Function[]}} 测试上下文。
 */
function makeCtx(services = {}) {
  const routes = new Map()
  const disposers = []
  const webServer = {
    register(route) {
      routes.set(route.path, route.handler)
      const dispose = () => routes.delete(route.path)
      disposers.push(dispose)
      return dispose
    },
  }
  const ctx = {
    get(name) {
      if (name === 'webServer') return webServer
      return services[name]
    },
    effect(execute) {
      const disposer = execute()
      return () => disposer?.()
    },
    on() {
      return () => {}
    },
    logger: { warn() {}, info() {} },
  }
  return { ctx, routes, disposers }
}

/**
 * 构造 mock 请求。
 * @param {object} [options] - 覆盖项。
 * @returns {object} mock IncomingMessage（可异步迭代）。
 */
function mockReq(options = {}) {
  const body = options.body === undefined ? [] : [Buffer.from(options.body, 'utf8')]
  return {
    method: options.method ?? 'GET',
    url: options.url ?? '/',
    headers: options.headers ?? {},
    socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
    [Symbol.asyncIterator]: () => Readable.from(body)[Symbol.asyncIterator](),
  }
}

/**
 * 构造 mock 响应，收集状态码与 JSON 体。
 * @returns {object} mock ServerResponse。
 */
function mockRes() {
  const res = {
    statusCode: 0,
    headers: undefined,
    body: '',
    writeHead(status, headers) {
      res.statusCode = status
      res.headers = headers
    },
    end(chunk) {
      res.body += chunk === undefined ? '' : String(chunk)
    },
  }
  return res
}

/** 默认可信请求头。 */
const TRUSTED_HEADERS = { host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin' }

/** 全部路由 + 各自的合法 method（信任栅栏矩阵要逐条打）。 */
const ROUTE_PATHS = Object.freeze({
  bootstrap: 'api/dsh-supermemory/bootstrap',
  doc: 'api/dsh-supermemory/doc',
  digest: 'api/dsh-supermemory/digest',
  runs: 'api/dsh-supermemory/runs',
  models: 'api/dsh-supermemory/models',
  settings: 'api/dsh-supermemory/settings',
  personas: 'api/dsh-supermemory/personas',
})

/** 每条路由的「正常 method」，用于 403 矩阵（栅栏先于 method 校验）。 */
const ROUTE_METHODS = Object.freeze({
  bootstrap: 'GET',
  doc: 'GET',
  digest: 'POST',
  runs: 'GET',
  models: 'GET',
  settings: 'PUT',
  personas: 'GET',
})

/**
 * 直接调用某个已注册路由。
 * @param {Map<string,Function>} routes - 路由表。
 * @param {string} path - document-relative 路径。
 * @param {object} req - mock 请求。
 * @returns {Promise<{status:number, json:object|undefined, raw:string}>} 结果。
 */
async function call(routes, path, req) {
  const handler = routes.get(`/${path}`)
  assert.equal(typeof handler, 'function', `route ${path} not registered`)
  const res = mockRes()
  await handler(req, res)
  let json
  try {
    json = JSON.parse(res.body)
  } catch {
    json = undefined
  }
  return { status: res.statusCode, json, raw: res.body }
}

/**
 * 内存版人设 API：模拟 store 的 listPersonas / currentPersona / createPersona / setCurrentPersona。
 * @param {Array<{slug:string,name:string,createdAt:string}>} [initial] - 初始人设。
 * @returns {{api:object, personas:object[], currentSlug:()=>string}} 夹具。
 */
function makePersonasFake(initial = [{ slug: 'default', name: '默认', createdAt: '2026-11-01T00:00:00.000Z' }]) {
  const personas = initial.map((persona) => ({ ...persona }))
  let currentSlug = personas[0]?.slug ?? 'default'
  const api = {
    list: () => personas.map((persona) => ({ ...persona })),
    current: () => {
      const found = personas.find((persona) => persona.slug === currentSlug)
      return found === undefined ? null : { slug: found.slug, name: found.name }
    },
    create: async (name) => {
      const trimmed = String(name ?? '').trim()
      if (trimmed === '') return { ok: false, code: 'BAD_INPUT', message: 'name is required' }
      const base = trimmed.toLowerCase().replace(/[^a-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'persona'
      let slug = base
      let suffix = 2
      while (personas.some((persona) => persona.slug === slug)) {
        slug = `${base}-${suffix}`
        suffix += 1
      }
      const persona = { slug, name: trimmed, createdAt: new Date().toISOString() }
      personas.push(persona)
      return { ok: true, persona: { ...persona } }
    },
    select: async (slug) => {
      const found = personas.find((persona) => persona.slug === slug)
      if (found === undefined) return { ok: false, code: 'NOT_FOUND', message: 'persona not found' }
      currentSlug = slug
      return { ok: true, persona: { slug: found.slug, name: found.name } }
    },
    // v5 §V5.2 语义的最小复刻：rename 只改 name；delete 先守 default，再摘条目并迁移 current。
    rename: async (slug, name) => {
      const display = String(name ?? '').trim()
      if (display === '') return { ok: false, code: 'BAD_INPUT', message: 'name is required' }
      const found = personas.find((persona) => persona.slug === slug)
      if (found === undefined) return { ok: false, code: 'NOT_FOUND', message: 'persona not found' }
      found.name = [...display].slice(0, 60).join('')
      return { ok: true, persona: { ...found } }
    },
    remove: async (slug) => {
      if (slug === 'default') return { ok: false, code: 'PERSONA_PROTECTED', message: 'default persona cannot be deleted' }
      const index = personas.findIndex((persona) => persona.slug === slug)
      if (index < 0) return { ok: false, code: 'NOT_FOUND', message: 'persona not found' }
      const [removed] = personas.splice(index, 1)
      if (currentSlug === slug) {
        currentSlug = personas.find((persona) => persona.slug === 'default')?.slug ?? personas[0]?.slug ?? ''
      }
      const fallback = personas.find((persona) => persona.slug === currentSlug)
      return {
        ok: true,
        deleted: { slug: removed.slug, name: removed.name },
        current: fallback === undefined ? null : { slug: fallback.slug, name: fallback.name },
      }
    },
  }
  return { api, personas, currentSlug: () => currentSlug }
}

/**
 * 内存版设置 API：模拟 store 的 readSettings / writeSettings。
 * @param {{enabled?:boolean, digestProvider?:string, digestModel?:string}} [initial] - 初始设置。
 * @returns {{api:object, state:object}} 夹具。
 */
function makeSettingsFake(initial = {}) {
  const state = { enabled: true, digestProvider: '', digestModel: '', ...initial }
  const api = {
    read: () => ({ ...state }),
    write: async (patch) => {
      if (typeof patch?.enabled === 'boolean') state.enabled = patch.enabled
      if (typeof patch?.digestProvider === 'string') state.digestProvider = patch.digestProvider
      if (typeof patch?.digestModel === 'string') state.digestModel = patch.digestModel
      return { ok: true, settings: { ...state } }
    },
  }
  return { api, state }
}

/** 安装路由所需的默认 deps（v2 形态）。 */
function makeDeps(overrides = {}) {
  const personas = makePersonasFake()
  const settings = makeSettingsFake()
  return {
    store,
    getConfig: () => resolveConfig({ digestProvider: 'p', digestModel: 'm' }),
    readActiveContext: () => ({ persona: 'default', presetId: 'default', projectRoot: workDir, projectName: 'ws' }),
    presetsRoot: personasRoot,
    personasRoot,
    dshHome: workDir,
    logger: { warn() {}, info() {} },
    listModels: async () => [
      { provider: 'prov-a', id: 'model-1', name: 'Model 1', label: 'Prov A / Model 1' },
      { provider: 'prov-b', id: 'model-2', name: 'Model 2', label: 'Prov B / Model 2' },
    ],
    listProjects: async () => [
      { path: join(workDir, 'ws-a'), name: 'ws-a', id: 'workspace-a' },
      { path: join(workDir, 'ws-b'), name: 'ws-b', id: 'workspace-b' },
    ],
    personas: personas.api,
    settings: settings.api,
    runDigest: async () => ({ at: new Date().toISOString(), ok: true, counts: { soul: 0, user: 0, global: 0, project: 1 } }),
    currentRoute: () => ({ provider: 'p', model: 'm' }),
    ...overrides,
  }
}

// ---------------------------------------------------------------- 信任栅栏

describe('信任栅栏', () => {
  /**
   * 用给定请求事实调用一个路由，返回状态码。
   * @param {string} path - document-relative 路径。
   * @param {object} options - mockReq 覆盖项。
   * @returns {Promise<number>} HTTP 状态码。
   */
  async function statusFor(path, options) {
    const { ctx, routes } = makeCtx()
    installRoutes(ctx, makeDeps())
    const result = await call(routes, path, mockReq(options))
    return result.status
  }

  it('接受 loopback socket + loopback Host + 同源 → 200', async () => {
    assert.equal(await statusFor(ROUTE_PATHS.bootstrap, { headers: TRUSTED_HEADERS }), 200)
  })

  it('接受 IPv4-mapped 回环地址', async () => {
    const status = await statusFor(ROUTE_PATHS.bootstrap, {
      remoteAddress: '::ffff:127.0.0.1',
      headers: { host: '127.0.0.1:3080' },
    })
    assert.equal(status, 200)
  })

  it('接受 ::1 与 [::1] Host', async () => {
    const status = await statusFor(ROUTE_PATHS.bootstrap, {
      remoteAddress: '::1',
      headers: { host: '[::1]:3080' },
    })
    assert.equal(status, 200)
  })

  it('拒绝非 loopback socket', async () => {
    assert.equal(await statusFor(ROUTE_PATHS.bootstrap, { remoteAddress: '10.0.0.7', headers: TRUSTED_HEADERS }), 403)
  })

  it('拒绝 x-forwarded-for', async () => {
    const headers = { ...TRUSTED_HEADERS, 'x-forwarded-for': '1.2.3.4' }
    assert.equal(await statusFor(ROUTE_PATHS.bootstrap, { headers }), 403)
  })

  it('拒绝 cf-connecting-ip', async () => {
    const headers = { ...TRUSTED_HEADERS, 'cf-connecting-ip': '1.2.3.4' }
    assert.equal(await statusFor(ROUTE_PATHS.bootstrap, { headers }), 403)
  })

  it('拒绝 sec-fetch-site: cross-site', async () => {
    const headers = { ...TRUSTED_HEADERS, 'sec-fetch-site': 'cross-site' }
    assert.equal(await statusFor(ROUTE_PATHS.bootstrap, { headers }), 403)
  })

  it('拒绝与 Host 异源的 Origin', async () => {
    const headers = { ...TRUSTED_HEADERS, origin: 'http://evil.example' }
    assert.equal(await statusFor(ROUTE_PATHS.bootstrap, { headers }), 403)
  })

  it('接受与 Host 同源的 Origin', async () => {
    const headers = { ...TRUSTED_HEADERS, origin: 'http://127.0.0.1:3080' }
    assert.equal(await statusFor(ROUTE_PATHS.bootstrap, { headers }), 200)
  })

  it('拒绝非 loopback Host（DNS rebinding）', async () => {
    assert.equal(await statusFor(ROUTE_PATHS.bootstrap, { headers: { host: 'evil.example:3080' } }), 403)
  })

  it('拒绝缺少 Host', async () => {
    assert.equal(await statusFor(ROUTE_PATHS.bootstrap, { headers: {} }), 403)
  })

  it('isTrustedRequest 直接断言：可信最小事实集合', () => {
    assert.equal(isTrustedRequest(mockReq({ headers: TRUSTED_HEADERS })), true)
    assert.equal(isTrustedRequest(mockReq({ headers: TRUSTED_HEADERS, remoteAddress: '192.168.0.2' })), false)
    assert.equal(isTrustedRequest(undefined), false)
  })
})

// ---------------------------------------------------------------- 路由注册

describe('installRoutes', () => {
  it('注册 7 条 document-relative 前缀对应的绝对 pathname', () => {
    const { ctx, routes } = makeCtx()
    installRoutes(ctx, makeDeps())
    assert.equal(ROUTE_PATHS.bootstrap, 'api/dsh-supermemory/bootstrap')
    for (const path of Object.values(ROUTE_PATHS)) {
      assert.ok(routes.has(`/${path}`), `${path} 必须注册为 /${path}`)
      assert.equal(routes.has(path), false, `${path} 不得注册为无前导斜杠`)
    }
  })

  it('每个路由第一行都执行信任栅栏：非 loopback 一律 403', async () => {
    const { ctx, routes } = makeCtx()
    installRoutes(ctx, makeDeps())
    for (const [name, path] of Object.entries(ROUTE_PATHS)) {
      const req = mockReq({
        headers: TRUSTED_HEADERS,
        remoteAddress: '192.168.1.5',
        method: ROUTE_METHODS[name],
      })
      const result = await call(routes, path, req)
      assert.equal(result.status, 403, `${path} must be 403`)
      assert.equal(result.json?.ok, false)
      assert.equal(result.json?.error, 'forbidden')
    }
  })

  it('dispose 注销全部路由', () => {
    const { ctx, routes } = makeCtx()
    const dispose = installRoutes(ctx, makeDeps())
    assert.equal(routes.size, 7)
    dispose()
    assert.equal(routes.size, 0)
  })

  it('没有 webServer 时不抛错，但必须留下一条告警（静默是事故藏身处）', () => {
    const warnings = []
    const ctx = { get: () => undefined, effect: (fn) => fn?.(), logger: { warn() {} } }
    const deps = makeDeps({ logger: { warn: (...a) => warnings.push(a.map(String).join(' ')), info() {} } })
    const dispose = installRoutes(ctx, deps)
    assert.equal(typeof dispose, 'function')
    assert.doesNotThrow(() => dispose())
    assert.equal(warnings.length, 1, `拿不到 webServer 要恰好告警一次，实际：${JSON.stringify(warnings)}`)
    assert.match(warnings[0], /webServer/, `告警要指名 webServer，实际：${warnings[0]}`)
  })

  it('webServer 由 inject 注入到 ctx 时也要能注册（不只看 ctx.get）', () => {
    const routes = new Map()
    const ctx = {
      webServer: {
        register(route) {
          routes.set(route.path, route.handler)
          return () => routes.delete(route.path)
        },
      },
      // get 一律拿不到，逼这条路径只能走 ctx.webServer
      get: () => undefined,
      effect: (fn) => fn?.(),
      logger: { warn() {}, info() {} },
    }
    installRoutes(ctx, makeDeps())
    assert.equal(routes.size, 7, `注入态应当注册满 7 条路由，实际 ${routes.size} 条`)
  })
})

// ---------------------------------------------------------------- bootstrap

describe('GET bootstrap（v2 结构）', () => {
  it('返回 personas / currentPersona / projects / active / config / digestSettings / presetsRoot / dshHome', async () => {
    const personas = makePersonasFake([{ slug: 'work', name: '工作', createdAt: '2026-11-01T00:00:00.000Z' }])
    const settings = makeSettingsFake({ digestProvider: 'prov-a', digestModel: 'model-1' })
    const { ctx, routes } = makeCtx()
    installRoutes(ctx, makeDeps({ personas: personas.api, settings: settings.api }))
    const result = await call(routes, ROUTE_PATHS.bootstrap, mockReq({ headers: TRUSTED_HEADERS }))
    assert.equal(result.status, 200, result.raw)
    const data = result.json?.data
    assert.deepEqual(data.personas, [{ slug: 'work', name: '工作', createdAt: '2026-11-01T00:00:00.000Z' }])
    assert.deepEqual(data.currentPersona, { slug: 'work', name: '工作' })
    assert.deepEqual(data.projects, [
      { path: join(workDir, 'ws-a'), name: 'ws-a' },
      { path: join(workDir, 'ws-b'), name: 'ws-b' },
    ])
    assert.deepEqual(data.active, { persona: 'default', projectRoot: workDir, projectName: 'ws' })
    assert.deepEqual(data.config.digestWritableScopes, ['project'])
    assert.equal(typeof data.config.injectMaxBytes, 'number')
    assert.equal(typeof data.config.systemPromptMaxBytes, 'number')
    assert.equal(typeof data.config.autoDigest, 'boolean')
    assert.equal(typeof data.config.digestEveryTurns, 'number')
    assert.equal(typeof data.config.digestPressureRatio, 'number')
    assert.equal(data.config.projectDirName, '.dsh/memory')
    assert.equal(data.config.projectFileName, 'project-memory.md')
    assert.deepEqual(data.digestSettings, { enabled: true, digestProvider: 'prov-a', digestModel: 'model-1' })
    // v3：顶层 enabled；mock deps 没提供 isEnabled，缺失一律视为开启。
    assert.equal(data.enabled, true)
    assert.equal(data.digestSettings.enabled, true)
    assert.equal(data.presetsRoot, personasRoot)
    assert.equal(data.dshHome, workDir)
    assert.equal('presets' in data, false, 'v2 不应再输出 presets 字段')
  })

  it('项目列表来自 deps.listProjects()，不接受客户端传路径（GET 无 body 也不读 query）', async () => {
    let called = 0
    const { ctx, routes } = makeCtx()
    installRoutes(
      ctx,
      makeDeps({
        listProjects: async () => {
          called += 1
          return [{ path: '/only/workspace', name: 'only' }]
        },
      }),
    )
    const result = await call(
      routes,
      ROUTE_PATHS.bootstrap,
      mockReq({ headers: TRUSTED_HEADERS, url: '/api/dsh-supermemory/bootstrap?projectRoot=/etc' }),
    )
    assert.equal(result.status, 200)
    assert.equal(called, 1)
    assert.deepEqual(result.json?.data.projects, [{ path: '/only/workspace', name: 'only' }])
  })

  it('active 为 null 与 currentPersona 为 null 时如实返回 null', async () => {
    const personas = makePersonasFake([])
    const { ctx, routes } = makeCtx()
    installRoutes(ctx, makeDeps({ personas: personas.api, readActiveContext: () => null }))
    const result = await call(routes, ROUTE_PATHS.bootstrap, mockReq({ headers: TRUSTED_HEADERS }))
    assert.equal(result.status, 200)
    assert.equal(result.json?.data.active, null)
    assert.equal(result.json?.data.currentPersona, null)
  })

  it('listPersonas 抛错时降级为空数组，不让 bootstrap 500', async () => {
    const { ctx, routes } = makeCtx()
    installRoutes(
      ctx,
      makeDeps({
        personas: {
          list: () => {
            throw new Error('store exploded')
          },
          current: () => null,
          create: async () => ({ ok: false }),
          select: async () => ({ ok: false }),
        },
        listProjects: async () => {
          throw new Error('registry exploded')
        },
      }),
    )
    const result = await call(routes, ROUTE_PATHS.bootstrap, mockReq({ headers: TRUSTED_HEADERS }))
    assert.equal(result.status, 200)
    assert.deepEqual(result.json?.data.personas, [])
    assert.deepEqual(result.json?.data.projects, [])
  })
})

// ---------------------------------------------------------------- models

describe('GET models', () => {
  it('返回 deps.listModels() 的模型列表与当前设置', async () => {
    const settings = makeSettingsFake({ digestProvider: 'prov-b', digestModel: 'model-2' })
    const { ctx, routes } = makeCtx()
    installRoutes(ctx, makeDeps({ settings: settings.api }))
    const result = await call(routes, ROUTE_PATHS.models, mockReq({ headers: TRUSTED_HEADERS }))
    assert.equal(result.status, 200, result.raw)
    assert.deepEqual(result.json?.data.models, [
      { provider: 'prov-a', id: 'model-1', name: 'Model 1', label: 'Prov A / Model 1' },
      { provider: 'prov-b', id: 'model-2', name: 'Model 2', label: 'Prov B / Model 2' },
    ])
    assert.deepEqual(result.json?.data.current, { provider: 'prov-b', model: 'model-2' })
  })

  it('设置全空时 current 为 null；listModels 缺失/抛错时返回空数组', async () => {
    const { ctx, routes } = makeCtx()
    installRoutes(
      ctx,
      makeDeps({
        listModels: async () => {
          throw new Error('llm down')
        },
        settings: makeSettingsFake().api,
      }),
    )
    const result = await call(routes, ROUTE_PATHS.models, mockReq({ headers: TRUSTED_HEADERS }))
    assert.equal(result.status, 200)
    assert.deepEqual(result.json?.data.models, [])
    assert.equal(result.json?.data.current, null)
  })

  it('非 GET 方法返回 405', async () => {
    const { ctx, routes } = makeCtx()
    installRoutes(ctx, makeDeps())
    const result = await call(routes, ROUTE_PATHS.models, mockReq({ headers: TRUSTED_HEADERS, method: 'POST' }))
    assert.equal(result.status, 405)
  })
})

// ---------------------------------------------------------------- settings

describe('PUT settings', () => {
  it('保存整理模型并回读', async () => {
    const settings = makeSettingsFake()
    const { ctx, routes } = makeCtx()
    installRoutes(ctx, makeDeps({ settings: settings.api }))
    const result = await call(
      routes,
      ROUTE_PATHS.settings,
      mockReq({ method: 'PUT', headers: TRUSTED_HEADERS, body: JSON.stringify({ digestProvider: 'prov-a', digestModel: 'model-1' }) }),
    )
    assert.equal(result.status, 200, result.raw)
    assert.deepEqual(result.json?.data.digestSettings, { enabled: true, digestProvider: 'prov-a', digestModel: 'model-1' })
    assert.deepEqual(settings.state, { enabled: true, digestProvider: 'prov-a', digestModel: 'model-1' })
  })

  it('空串表示「跟随当前会话」，可清空设置', async () => {
    const settings = makeSettingsFake({ digestProvider: 'prov-a', digestModel: 'model-1' })
    const { ctx, routes } = makeCtx()
    installRoutes(ctx, makeDeps({ settings: settings.api }))
    const result = await call(
      routes,
      ROUTE_PATHS.settings,
      mockReq({ method: 'PUT', headers: TRUSTED_HEADERS, body: JSON.stringify({ digestProvider: '', digestModel: '' }) }),
    )
    assert.equal(result.status, 200)
    assert.deepEqual(result.json?.data.digestSettings, { enabled: true, digestProvider: '', digestModel: '' })
    assert.deepEqual(settings.state, { enabled: true, digestProvider: '', digestModel: '' })
  })

  it('缺少两个字段 / 类型非法 → 400', async () => {
    const { ctx, routes } = makeCtx()
    installRoutes(ctx, makeDeps())
    const empty = await call(routes, ROUTE_PATHS.settings, mockReq({ method: 'PUT', headers: TRUSTED_HEADERS, body: '{}' }))
    assert.equal(empty.status, 400)
    const badType = await call(
      routes,
      ROUTE_PATHS.settings,
      mockReq({ method: 'PUT', headers: TRUSTED_HEADERS, body: JSON.stringify({ digestProvider: 42 }) }),
    )
    assert.equal(badType.status, 400)
  })

  it('settings 存储不可用 → 500', async () => {
    const { ctx, routes } = makeCtx()
    installRoutes(ctx, makeDeps({ store: {}, settings: undefined }))
    const result = await call(
      routes,
      ROUTE_PATHS.settings,
      mockReq({ method: 'PUT', headers: TRUSTED_HEADERS, body: JSON.stringify({ digestProvider: 'p', digestModel: 'm' }) }),
    )
    assert.equal(result.status, 500)
    assert.equal(result.json?.code, 'SETTINGS_UNAVAILABLE')
  })

  it('非 PUT 方法返回 405', async () => {
    const { ctx, routes } = makeCtx()
    installRoutes(ctx, makeDeps())
    const result = await call(routes, ROUTE_PATHS.settings, mockReq({ headers: TRUSTED_HEADERS }))
    assert.equal(result.status, 405)
  })
})

// ---------------------------------------------------------------- 插件总开关（v3）

describe('插件总开关 enabled（v3）', () => {
  /** 关闭态 deps：isEnabled 明确返回 false。 */
  function disabledDeps(overrides = {}) {
    return makeDeps({ isEnabled: () => false, ...overrides })
  }

  it('bootstrap 顶层回带 enabled=false，digestSettings 也带 enabled', async () => {
    const settings = makeSettingsFake({ digestProvider: 'prov-a', digestModel: 'model-1' })
    const { ctx, routes } = makeCtx()
    installRoutes(ctx, disabledDeps({ settings: settings.api }))
    const result = await call(routes, ROUTE_PATHS.bootstrap, mockReq({ headers: TRUSTED_HEADERS }))
    assert.equal(result.status, 200, result.raw)
    assert.equal(result.json?.data.enabled, false)
    assert.deepEqual(result.json?.data.digestSettings, {
      enabled: false,
      digestProvider: 'prov-a',
      digestModel: 'model-1',
    })
  })

  it('deps 未提供 isEnabled 时视为开启；抛错时也视为开启', async () => {
    const { ctx, routes } = makeCtx()
    installRoutes(
      ctx,
      makeDeps({
        isEnabled: () => {
          throw new Error('settings.json unreadable')
        },
      }),
    )
    const result = await call(routes, ROUTE_PATHS.bootstrap, mockReq({ headers: TRUSTED_HEADERS }))
    assert.equal(result.status, 200, result.raw)
    assert.equal(result.json?.data.enabled, true)
    assert.equal(result.json?.data.digestSettings.enabled, true)
  })

  it('PUT settings 写 enabled 生效并回带，不影响 digestProvider / digestModel', async () => {
    const settings = makeSettingsFake({ digestProvider: 'prov-a', digestModel: 'model-1' })
    const { ctx, routes } = makeCtx()
    // 与 lib/index.js 的真实装配一致：isEnabled 就是读存储层这一位。
    installRoutes(
      ctx,
      makeDeps({ settings: settings.api, isEnabled: () => settings.state.enabled !== false }),
    )
    const result = await call(
      routes,
      ROUTE_PATHS.settings,
      mockReq({ method: 'PUT', headers: TRUSTED_HEADERS, body: JSON.stringify({ enabled: false }) }),
    )
    assert.equal(result.status, 200, result.raw)
    assert.equal(result.json?.data.enabled, false)
    assert.equal(result.json?.data.digestSettings.enabled, false)
    assert.equal(settings.state.enabled, false)
    // 既有两键必须原样保留
    assert.equal(settings.state.digestProvider, 'prov-a')
    assert.equal(settings.state.digestModel, 'model-1')
    assert.equal(result.json?.data.digestSettings.digestProvider, 'prov-a')
    assert.equal(result.json?.data.digestSettings.digestModel, 'model-1')

    const reEnabled = await call(
      routes,
      ROUTE_PATHS.settings,
      mockReq({ method: 'PUT', headers: TRUSTED_HEADERS, body: JSON.stringify({ enabled: true }) }),
    )
    assert.equal(reEnabled.status, 200, reEnabled.raw)
    assert.equal(reEnabled.json?.data.enabled, true)
    assert.equal(settings.state.enabled, true)
  })

  it('PUT settings 可同时写 enabled 与模型两键', async () => {
    const settings = makeSettingsFake()
    const { ctx, routes } = makeCtx()
    installRoutes(
      ctx,
      makeDeps({ settings: settings.api, isEnabled: () => settings.state.enabled !== false }),
    )
    const result = await call(
      routes,
      ROUTE_PATHS.settings,
      mockReq({
        method: 'PUT',
        headers: TRUSTED_HEADERS,
        body: JSON.stringify({ enabled: false, digestProvider: 'prov-b', digestModel: 'model-2' }),
      }),
    )
    assert.equal(result.status, 200, result.raw)
    assert.deepEqual(settings.state, { enabled: false, digestProvider: 'prov-b', digestModel: 'model-2' })
    assert.deepEqual(result.json?.data.digestSettings, { enabled: false, digestProvider: 'prov-b', digestModel: 'model-2' })
  })

  it('PUT settings 的 enabled 非布尔 → 400 且不改动存储', async () => {
    const settings = makeSettingsFake()
    const { ctx, routes } = makeCtx()
    installRoutes(ctx, makeDeps({ settings: settings.api }))
    for (const bad of ['false', 0, 1, 'true', null, { value: false }]) {
      const result = await call(
        routes,
        ROUTE_PATHS.settings,
        mockReq({ method: 'PUT', headers: TRUSTED_HEADERS, body: JSON.stringify({ enabled: bad }) }),
      )
      assert.equal(result.status, 400, `enabled=${JSON.stringify(bad)} 必须 400`)
      assert.equal(result.json?.code, 'BAD_INPUT')
    }
    assert.equal(settings.state.enabled, true, '非法值不得落盘')
    assert.deepEqual(settings.state, { enabled: true, digestProvider: '', digestModel: '' })
  })

  it('存储层没落地 enabled 时，响应回带真实状态而不是客户端传的值', async () => {
    // 模拟尚未支持 enabled 的旧 store：write 忽略该键，read 恒为 true，
    // 装配层的 isEnabled 因此也恒为 true——此时绝不能假装关闭。
    const state = { enabled: true, digestProvider: '', digestModel: '' }
    const api = {
      read: () => ({ ...state }),
      write: async (patch) => {
        if (typeof patch?.digestProvider === 'string') state.digestProvider = patch.digestProvider
        if (typeof patch?.digestModel === 'string') state.digestModel = patch.digestModel
        return { ok: true, settings: { ...state } }
      },
    }
    const { ctx, routes } = makeCtx()
    installRoutes(ctx, makeDeps({ settings: api, isEnabled: () => state.enabled !== false }))
    const result = await call(
      routes,
      ROUTE_PATHS.settings,
      mockReq({ method: 'PUT', headers: TRUSTED_HEADERS, body: JSON.stringify({ enabled: false }) }),
    )
    assert.equal(result.status, 200, result.raw)
    assert.equal(result.json?.data.enabled, true, '没写进去就不能假装关闭')
  })

  it('关闭时 POST digest → 409 PLUGIN_DISABLED，且不调用 runDigest', async () => {
    let called = 0
    const { ctx, routes } = makeCtx()
    installRoutes(
      ctx,
      disabledDeps({
        runDigest: async () => {
          called += 1
          return { at: new Date().toISOString(), ok: true }
        },
      }),
    )
    const result = await call(
      routes,
      ROUTE_PATHS.digest,
      mockReq({ method: 'POST', headers: TRUSTED_HEADERS, body: JSON.stringify({ persona: 'default', projectRoot: workDir }) }),
    )
    assert.equal(result.status, 409, result.raw)
    assert.equal(result.json?.ok, false)
    assert.equal(result.json?.code, 'PLUGIN_DISABLED')
    assert.equal(called, 0)
  })

  it('关闭时信任栅栏仍然优先：非 loopback 的 digest 仍是 403 而不是 409', async () => {
    const { ctx, routes } = makeCtx()
    installRoutes(ctx, disabledDeps())
    const result = await call(
      routes,
      ROUTE_PATHS.digest,
      mockReq({ method: 'POST', headers: TRUSTED_HEADERS, remoteAddress: '10.1.2.3', body: '{}' }),
    )
    assert.equal(result.status, 403)
  })

  it('关闭时 doc 读写仍返回 200（面板还能改记忆内容）', async () => {
    const { ctx, routes } = makeCtx()
    installRoutes(ctx, disabledDeps())
    const read = await call(
      routes,
      ROUTE_PATHS.doc,
      mockReq({
        headers: TRUSTED_HEADERS,
        url: `/api/dsh-supermemory/doc?scope=global&persona=${encodeURIComponent('t:off')}`,
      }),
    )
    assert.equal(read.status, 200, read.raw)
    assert.equal(typeof read.json?.data.content, 'string')

    const write = await call(
      routes,
      ROUTE_PATHS.doc,
      mockReq({
        method: 'PUT',
        headers: TRUSTED_HEADERS,
        body: JSON.stringify({ scope: 'global', persona: 't:off', content: '# 全局长期记忆\n\n## 条目\n\n- 关闭态写入\n' }),
      }),
    )
    assert.equal(write.status, 200, write.raw)

    const again = await call(
      routes,
      ROUTE_PATHS.doc,
      mockReq({
        headers: TRUSTED_HEADERS,
        url: `/api/dsh-supermemory/doc?scope=global&persona=${encodeURIComponent('t:off')}`,
      }),
    )
    assert.equal(again.status, 200)
    assert.match(again.json?.data.content, /关闭态写入/u)
  })

  it('关闭时其余 GET/PUT 一律不被拒：面板必须永远进得去', async () => {
    const settings = makeSettingsFake()
    const personas = makePersonasFake()
    const { ctx, routes } = makeCtx()
    installRoutes(ctx, disabledDeps({ settings: settings.api, personas: personas.api }))
    const checks = [
      [ROUTE_PATHS.bootstrap, mockReq({ headers: TRUSTED_HEADERS })],
      [ROUTE_PATHS.runs, mockReq({ headers: TRUSTED_HEADERS })],
      [ROUTE_PATHS.models, mockReq({ headers: TRUSTED_HEADERS })],
      [ROUTE_PATHS.personas, mockReq({ headers: TRUSTED_HEADERS })],
      [
        ROUTE_PATHS.personas,
        mockReq({ method: 'PUT', headers: TRUSTED_HEADERS, body: JSON.stringify({ slug: 'default' }) }),
      ],
      [
        ROUTE_PATHS.settings,
        mockReq({ method: 'PUT', headers: TRUSTED_HEADERS, body: JSON.stringify({ digestProvider: '', digestModel: '' }) }),
      ],
    ]
    for (const [path, req] of checks) {
      const result = await call(routes, path, req)
      assert.equal(result.status, 200, `${path} (${req.method}) 关闭态也必须 200，实际 ${result.status} ${result.raw}`)
    }
  })
})

// ---------------------------------------------------------------- personas

describe('personas 路由', () => {
  it('GET 返回列表与 current', async () => {
    const personas = makePersonasFake([
      { slug: 'default', name: '默认', createdAt: '2026-11-01T00:00:00.000Z' },
      { slug: 'work', name: '工作', createdAt: '2026-11-02T00:00:00.000Z' },
    ])
    const { ctx, routes } = makeCtx()
    installRoutes(ctx, makeDeps({ personas: personas.api }))
    const result = await call(routes, ROUTE_PATHS.personas, mockReq({ headers: TRUSTED_HEADERS }))
    assert.equal(result.status, 200, result.raw)
    assert.equal(result.json?.data.personas.length, 2)
    assert.deepEqual(result.json?.data.current, { slug: 'default', name: '默认' })
  })

  it('POST 创建人设并自动切换为 current', async () => {
    const personas = makePersonasFake()
    const { ctx, routes } = makeCtx()
    installRoutes(ctx, makeDeps({ personas: personas.api }))
    const result = await call(
      routes,
      ROUTE_PATHS.personas,
      mockReq({ method: 'POST', headers: TRUSTED_HEADERS, body: JSON.stringify({ name: '研究' }) }),
    )
    assert.equal(result.status, 200, result.raw)
    assert.equal(result.json?.data.personas.length, 2)
    assert.equal(result.json?.data.current.name, '研究')
    assert.equal(personas.currentSlug(), result.json?.data.current.slug)
    // 响应体与 GET 同构
    assert.ok(Array.isArray(result.json?.data.personas))
  })

  it('POST 空名称 / 超 60 字符 → 400', async () => {
    const { ctx, routes } = makeCtx()
    installRoutes(ctx, makeDeps())
    const blank = await call(
      routes,
      ROUTE_PATHS.personas,
      mockReq({ method: 'POST', headers: TRUSTED_HEADERS, body: JSON.stringify({ name: '   ' }) }),
    )
    assert.equal(blank.status, 400)
    const tooLong = await call(
      routes,
      ROUTE_PATHS.personas,
      mockReq({ method: 'POST', headers: TRUSTED_HEADERS, body: JSON.stringify({ name: 'x'.repeat(61) }) }),
    )
    assert.equal(tooLong.status, 400)
  })

  it('POST 恰好 60 字符可以创建', async () => {
    const { ctx, routes } = makeCtx()
    installRoutes(ctx, makeDeps())
    const result = await call(
      routes,
      ROUTE_PATHS.personas,
      mockReq({ method: 'POST', headers: TRUSTED_HEADERS, body: JSON.stringify({ name: 'x'.repeat(60) }) }),
    )
    assert.equal(result.status, 200, result.raw)
  })

  it('POST 创建失败时按 store 的 code 返回错误', async () => {
    const { ctx, routes } = makeCtx()
    installRoutes(
      ctx,
      makeDeps({
        personas: {
          list: () => [],
          current: () => null,
          create: async () => ({ ok: false, code: 'PERSONA_EXISTS', message: 'already exists' }),
          select: async () => ({ ok: false }),
        },
      }),
    )
    const result = await call(
      routes,
      ROUTE_PATHS.personas,
      mockReq({ method: 'POST', headers: TRUSTED_HEADERS, body: JSON.stringify({ name: '重复' }) }),
    )
    assert.equal(result.status, 409)
    assert.equal(result.json?.code, 'PERSONA_EXISTS')
  })

  it('PUT 切换 current；未知 slug → 404；缺 slug → 400', async () => {
    const personas = makePersonasFake([
      { slug: 'default', name: '默认', createdAt: '2026-11-01T00:00:00.000Z' },
      { slug: 'work', name: '工作', createdAt: '2026-11-02T00:00:00.000Z' },
    ])
    const { ctx, routes } = makeCtx()
    installRoutes(ctx, makeDeps({ personas: personas.api }))
    const switched = await call(
      routes,
      ROUTE_PATHS.personas,
      mockReq({ method: 'PUT', headers: TRUSTED_HEADERS, body: JSON.stringify({ slug: 'work' }) }),
    )
    assert.equal(switched.status, 200, switched.raw)
    assert.deepEqual(switched.json?.data.current, { slug: 'work', name: '工作' })
    assert.deepEqual(switched.json?.data.personas.length, 2)

    const missing = await call(
      routes,
      ROUTE_PATHS.personas,
      mockReq({ method: 'PUT', headers: TRUSTED_HEADERS, body: JSON.stringify({ slug: 'nope' }) }),
    )
    assert.equal(missing.status, 404)

    const noSlug = await call(
      routes,
      ROUTE_PATHS.personas,
      mockReq({ method: 'PUT', headers: TRUSTED_HEADERS, body: '{}' }),
    )
    assert.equal(noSlug.status, 400)
  })

  // ---------------------------------------------------------- v5：重命名与删除（契约 §V5.7）

  it('PATCH 改显示名，响应体与 GET 同构（personas + current）', async () => {
    const personas = makePersonasFake([
      { slug: 'default', name: '默认', createdAt: '2026-11-01T00:00:00.000Z' },
      { slug: 'work', name: '工作', createdAt: '2026-11-02T00:00:00.000Z' },
    ])
    const { ctx, routes } = makeCtx()
    installRoutes(ctx, makeDeps({ personas: personas.api }))
    const result = await call(
      routes,
      ROUTE_PATHS.personas,
      mockReq({ method: 'PATCH', headers: TRUSTED_HEADERS, body: JSON.stringify({ slug: 'work', name: '灰灰' }) }),
    )
    assert.equal(result.status, 200, result.raw)
    // 响应形状必须与 GET 一致：只有 personas / current 两键，不设专用形状。
    assert.deepEqual(Object.keys(result.json?.data ?? {}).sort(), ['current', 'personas'])
    assert.deepEqual(
      result.json?.data.personas.find((persona) => persona.slug === 'work'),
      { slug: 'work', name: '灰灰', createdAt: '2026-11-02T00:00:00.000Z' },
    )
    // slug 与 current 都不因重命名而改变（§V5.0：只改显示名）。
    assert.deepEqual(result.json?.data.current, { slug: 'default', name: '默认' })
    assert.equal(result.json?.data.personas.length, 2)
  })

  it('PATCH 空 name / 缺 slug / 超 60 字符 → 400；未知 slug → 404', async () => {
    const personas = makePersonasFake([
      { slug: 'default', name: '默认', createdAt: '2026-11-01T00:00:00.000Z' },
      { slug: 'work', name: '工作', createdAt: '2026-11-02T00:00:00.000Z' },
    ])
    const { ctx, routes } = makeCtx()
    installRoutes(ctx, makeDeps({ personas: personas.api }))
    const cases = [
      ['空 name', { slug: 'work', name: '   ' }, 400, 'BAD_INPUT'],
      ['缺 name', { slug: 'work' }, 400, 'BAD_INPUT'],
      ['缺 slug', { name: '灰灰' }, 400, 'BAD_INPUT'],
      ['超长 name', { slug: 'work', name: 'x'.repeat(61) }, 400, 'BAD_INPUT'],
      ['未知 slug', { slug: 'nope', name: '灰灰' }, 404, 'NOT_FOUND'],
    ]
    for (const [label, body, status, code] of cases) {
      const result = await call(
        routes,
        ROUTE_PATHS.personas,
        mockReq({ method: 'PATCH', headers: TRUSTED_HEADERS, body: JSON.stringify(body) }),
      )
      assert.equal(result.status, status, `${label} 应 ${status}，实际 ${result.status} ${result.raw}`)
      assert.equal(result.json?.ok, false, label)
      assert.equal(result.json?.code, code, label)
    }
    // 失败路径不得留下脏改名
    assert.equal(personas.api.list()[1].name, '工作')
  })

  it('PATCH 恰好 60 字符可以改', async () => {
    const personas = makePersonasFake([
      { slug: 'default', name: '默认', createdAt: '2026-11-01T00:00:00.000Z' },
      { slug: 'work', name: '工作', createdAt: '2026-11-02T00:00:00.000Z' },
    ])
    const { ctx, routes } = makeCtx()
    installRoutes(ctx, makeDeps({ personas: personas.api }))
    const result = await call(
      routes,
      ROUTE_PATHS.personas,
      mockReq({ method: 'PATCH', headers: TRUSTED_HEADERS, body: JSON.stringify({ slug: 'work', name: 'x'.repeat(60) }) }),
    )
    assert.equal(result.status, 200, result.raw)
    assert.equal(result.json?.data.personas.find((persona) => persona.slug === 'work').name.length, 60)
  })

  it('DELETE 删除人设：列表少一个、响应同构、被删的是 current 时 current 迁移', async () => {
    const personas = makePersonasFake([
      { slug: 'default', name: '默认', createdAt: '2026-11-01T00:00:00.000Z' },
      { slug: 'work', name: '工作', createdAt: '2026-11-02T00:00:00.000Z' },
    ])
    const { ctx, routes } = makeCtx()
    installRoutes(ctx, makeDeps({ personas: personas.api }))
    // 先把 current 切到 work，验证删除 current 之后 current 迁到 default
    const switched = await call(
      routes,
      ROUTE_PATHS.personas,
      mockReq({ method: 'PUT', headers: TRUSTED_HEADERS, body: JSON.stringify({ slug: 'work' }) }),
    )
    assert.equal(switched.status, 200, switched.raw)

    const result = await call(
      routes,
      ROUTE_PATHS.personas,
      mockReq({ method: 'DELETE', headers: TRUSTED_HEADERS, body: JSON.stringify({ slug: 'work' }) }),
    )
    assert.equal(result.status, 200, result.raw)
    assert.deepEqual(Object.keys(result.json?.data ?? {}).sort(), ['current', 'personas'])
    assert.deepEqual(result.json?.data.personas, [
      { slug: 'default', name: '默认', createdAt: '2026-11-01T00:00:00.000Z' },
    ])
    assert.deepEqual(result.json?.data.current, { slug: 'default', name: '默认' })
    assert.equal(personas.currentSlug(), 'default')
  })

  it('DELETE 支持纯 query 形态 ?slug=（空 body 也可用）', async () => {
    const personas = makePersonasFake([
      { slug: 'default', name: '默认', createdAt: '2026-11-01T00:00:00.000Z' },
      { slug: 'tmp', name: '临时', createdAt: '2026-11-03T00:00:00.000Z' },
    ])
    const { ctx, routes } = makeCtx()
    installRoutes(ctx, makeDeps({ personas: personas.api }))
    const result = await call(
      routes,
      ROUTE_PATHS.personas,
      mockReq({
        method: 'DELETE',
        headers: TRUSTED_HEADERS,
        url: `/api/dsh-supermemory/personas?slug=${encodeURIComponent('tmp')}`,
      }),
    )
    assert.equal(result.status, 200, result.raw)
    assert.equal(result.json?.data.personas.length, 1)
    assert.equal(result.json?.data.personas[0].slug, 'default')
  })

  it('DELETE 缺 slug → 400；default → 409 PERSONA_PROTECTED；未知 slug → 404', async () => {
    const personas = makePersonasFake([
      { slug: 'default', name: '默认', createdAt: '2026-11-01T00:00:00.000Z' },
      { slug: 'work', name: '工作', createdAt: '2026-11-02T00:00:00.000Z' },
    ])
    const { ctx, routes } = makeCtx()
    installRoutes(ctx, makeDeps({ personas: personas.api }))

    const noSlug = await call(
      routes,
      ROUTE_PATHS.personas,
      mockReq({ method: 'DELETE', headers: TRUSTED_HEADERS, body: '{}' }),
    )
    assert.equal(noSlug.status, 400, noSlug.raw)
    assert.equal(noSlug.json?.code, 'BAD_INPUT')

    const protectedOne = await call(
      routes,
      ROUTE_PATHS.personas,
      mockReq({ method: 'DELETE', headers: TRUSTED_HEADERS, body: JSON.stringify({ slug: 'default' }) }),
    )
    assert.equal(protectedOne.status, 409, protectedOne.raw)
    assert.equal(protectedOne.json?.code, 'PERSONA_PROTECTED')
    assert.equal(protectedOne.json?.ok, false)
    // Default 禁删：列表仍是两个
    assert.equal(protectedOne.json?.data, undefined, '失败响应不应带 data')
    assert.equal(personas.api.list().length, 2)

    const unknown = await call(
      routes,
      ROUTE_PATHS.personas,
      mockReq({ method: 'DELETE', headers: TRUSTED_HEADERS, body: JSON.stringify({ slug: 'nope' }) }),
    )
    assert.equal(unknown.status, 404, unknown.raw)
    assert.equal(unknown.json?.code, 'NOT_FOUND')
  })

  it('关闭态（enabled:false）下 PATCH / DELETE 仍然放行——v3 铁律', async () => {
    const personas = makePersonasFake([
      { slug: 'default', name: '默认', createdAt: '2026-11-01T00:00:00.000Z' },
      { slug: 'work', name: '工作', createdAt: '2026-11-02T00:00:00.000Z' },
    ])
    const { ctx, routes } = makeCtx()
    installRoutes(
      ctx,
      makeDeps({ isEnabled: () => false, personas: personas.api }),
    )
    const renamed = await call(
      routes,
      ROUTE_PATHS.personas,
      mockReq({ method: 'PATCH', headers: TRUSTED_HEADERS, body: JSON.stringify({ slug: 'work', name: '灰灰' }) }),
    )
    assert.equal(renamed.status, 200, `关闭态 PATCH 不得被拦，实际 ${renamed.status} ${renamed.raw}`)
    assert.equal(renamed.json?.code, undefined)
    assert.equal(renamed.json?.data.personas.find((persona) => persona.slug === 'work').name, '灰灰')

    const removed = await call(
      routes,
      ROUTE_PATHS.personas,
      mockReq({ method: 'DELETE', headers: TRUSTED_HEADERS, body: JSON.stringify({ slug: 'work' }) }),
    )
    assert.equal(removed.status, 200, `关闭态 DELETE 不得被拦，实际 ${removed.status} ${removed.raw}`)
    assert.equal(removed.json?.code, undefined)
    assert.equal(removed.json?.data.personas.length, 1)
  })

  it('关闭态下 PERSONA_PROTECTED 仍映射 409（不被 PLUGIN_DISABLED 抢先）', async () => {
    const { ctx, routes } = makeCtx()
    installRoutes(ctx, makeDeps({ isEnabled: () => false }))
    const result = await call(
      routes,
      ROUTE_PATHS.personas,
      mockReq({ method: 'DELETE', headers: TRUSTED_HEADERS, body: JSON.stringify({ slug: 'default' }) }),
    )
    assert.equal(result.status, 409, result.raw)
    assert.equal(result.json?.code, 'PERSONA_PROTECTED')
  })

  it('未知 method 仍走 405 兜底（v5 起 DELETE 已合法，改用 OPTIONS 守兜底）', async () => {
    const { ctx, routes } = makeCtx()
    installRoutes(ctx, makeDeps())
    const result = await call(routes, ROUTE_PATHS.personas, mockReq({ method: 'OPTIONS', headers: TRUSTED_HEADERS }))
    assert.equal(result.status, 405, result.raw)
    assert.equal(result.json?.code, 'METHOD_NOT_ALLOWED')
  })
})

// ---------------------------------------------------------------- doc

describe('doc 路由', () => {
  it('GET doc 用 persona 参数读取', async () => {
    const { ctx, routes } = makeCtx()
    installRoutes(ctx, makeDeps())
    const url = `/api/dsh-supermemory/doc?scope=global&persona=${encodeURIComponent('t:persona')}`
    const result = await call(routes, ROUTE_PATHS.doc, mockReq({ headers: TRUSTED_HEADERS, url }))
    assert.equal(result.status, 200, result.raw)
    assert.equal(typeof result.json?.data.content, 'string')
    assert.equal(typeof result.json?.data.mtimeMs, 'number')
    assert.equal(result.json?.data.title, '全局长期记忆')
    assert.ok(result.json?.data.path.endsWith('.md'))
  })

  it('GET doc 仍兼容 presetId 参数', async () => {
    const { ctx, routes } = makeCtx()
    installRoutes(ctx, makeDeps())
    const url = `/api/dsh-supermemory/doc?scope=global&presetId=${encodeURIComponent('t:legacy')}`
    const result = await call(routes, ROUTE_PATHS.doc, mockReq({ headers: TRUSTED_HEADERS, url }))
    assert.equal(result.status, 200, result.raw)
  })

  it('GET doc 拒绝含 ../ 的 persona（400 而非读任意文件）', async () => {
    const { ctx, routes } = makeCtx()
    installRoutes(ctx, makeDeps())
    const req = mockReq({
      headers: TRUSTED_HEADERS,
      url: `/api/dsh-supermemory/doc?scope=global&persona=${encodeURIComponent('../../etc')}`,
    })
    const result = await call(routes, ROUTE_PATHS.doc, req)
    assert.equal(result.status, 400)
    assert.equal(result.json?.ok, false)
  })

  it('GET doc 缺 persona / 非法 scope / 相对 projectRoot → 400', async () => {
    const { ctx, routes } = makeCtx()
    installRoutes(ctx, makeDeps())
    const missing = await call(
      routes,
      ROUTE_PATHS.doc,
      mockReq({ headers: TRUSTED_HEADERS, url: '/api/dsh-supermemory/doc?scope=global' }),
    )
    assert.equal(missing.status, 400)

    const relative = await call(
      routes,
      ROUTE_PATHS.doc,
      mockReq({ headers: TRUSTED_HEADERS, url: '/api/dsh-supermemory/doc?scope=project&projectRoot=relative/path' }),
    )
    assert.equal(relative.status, 400)

    const badScope = await call(
      routes,
      ROUTE_PATHS.doc,
      mockReq({ headers: TRUSTED_HEADERS, url: '/api/dsh-supermemory/doc?scope=secrets&persona=x' }),
    )
    assert.equal(badScope.status, 400)
  })

  it('PUT doc 用 persona 写入，带错误 expectedMtimeMs 返回 409', async () => {
    const { ctx, routes } = makeCtx()
    installRoutes(ctx, makeDeps())
    const first = await call(
      routes,
      ROUTE_PATHS.doc,
      mockReq({
        method: 'PUT',
        headers: TRUSTED_HEADERS,
        body: JSON.stringify({ scope: 'global', persona: 't:write', content: '# 全局长期记忆\n\n## 条目\n', expectedMtimeMs: 0 }),
      }),
    )
    assert.equal(first.status, 200, first.raw)

    const stale = await call(
      routes,
      ROUTE_PATHS.doc,
      mockReq({
        method: 'PUT',
        headers: TRUSTED_HEADERS,
        body: JSON.stringify({ scope: 'global', persona: 't:write', content: '# 全局长期记忆\n\n## 条目\n\n- x\n', expectedMtimeMs: 1 }),
      }),
    )
    assert.equal(stale.status, 409)
    assert.equal(stale.json?.code, 'STALE')
  })

  it('PUT doc 兼容 presetId 字段', async () => {
    const { ctx, routes } = makeCtx()
    installRoutes(ctx, makeDeps())
    const result = await call(
      routes,
      ROUTE_PATHS.doc,
      mockReq({
        method: 'PUT',
        headers: TRUSTED_HEADERS,
        body: JSON.stringify({ scope: 'global', presetId: 't:legacy-write', content: '# 全局长期记忆\n\n## 条目\n' }),
      }),
    )
    assert.equal(result.status, 200, result.raw)
  })

  it('PUT doc 请求体超 1 MiB 返回 413', async () => {
    const { ctx, routes } = makeCtx()
    installRoutes(ctx, makeDeps())
    const huge = 'x'.repeat(1024 * 1024 + 10)
    const result = await call(
      routes,
      ROUTE_PATHS.doc,
      mockReq({
        method: 'PUT',
        headers: TRUSTED_HEADERS,
        body: JSON.stringify({ scope: 'global', persona: 'big', content: huge }),
      }),
    )
    assert.equal(result.status, 413)
    assert.equal(result.json?.code, 'TOO_LARGE')
  })

  it('PUT doc 拒绝 projectRoot 含 .. 的路径', async () => {
    const { ctx, routes } = makeCtx()
    installRoutes(ctx, makeDeps())
    const result = await call(
      routes,
      ROUTE_PATHS.doc,
      mockReq({
        method: 'PUT',
        headers: TRUSTED_HEADERS,
        body: JSON.stringify({ scope: 'project', projectRoot: '/tmp/../etc', content: 'x' }),
      }),
    )
    assert.equal(result.status, 400)
  })
})

// ---------------------------------------------------------------- runs / digest

describe('runs 与 digest 路由', () => {
  it('runs 路由返回最近整理报告', async () => {
    const { ctx, routes } = makeCtx()
    installRoutes(ctx, makeDeps())
    const result = await call(routes, ROUTE_PATHS.runs, mockReq({ headers: TRUSTED_HEADERS }))
    assert.equal(result.status, 200)
    assert.ok(Array.isArray(result.json?.data.runs))
  })

  it('digest 路由把 persona 转发给 deps.runDigest', async () => {
    let seen
    const { ctx, routes } = makeCtx()
    installRoutes(
      ctx,
      makeDeps({
        runDigest: async (request) => {
          seen = request
          return { at: new Date().toISOString(), ok: true, counts: { soul: 0, user: 0, global: 0, project: 1 } }
        },
      }),
    )
    const result = await call(
      routes,
      ROUTE_PATHS.digest,
      mockReq({
        method: 'POST',
        headers: TRUSTED_HEADERS,
        body: JSON.stringify({ persona: 'work', projectRoot: workDir, sessionId: 's1' }),
      }),
    )
    assert.equal(result.status, 200, result.raw)
    assert.equal(result.json?.data.ok, true)
    assert.equal(seen.trigger, 'manual')
    assert.equal(seen.persona, 'work')
    assert.equal(seen.presetId, 'work', 'v1 兼容字段必须同步')
    assert.equal(seen.projectRoot, workDir)
    assert.equal(seen.sessionId, 's1')
  })

  it('digest 路由仍兼容 presetId，且拒绝非法 persona', async () => {
    let seen
    const { ctx, routes } = makeCtx()
    installRoutes(
      ctx,
      makeDeps({
        runDigest: async (request) => {
          seen = request
          return { at: new Date().toISOString(), ok: true }
        },
      }),
    )
    const legacy = await call(
      routes,
      ROUTE_PATHS.digest,
      mockReq({ method: 'POST', headers: TRUSTED_HEADERS, body: JSON.stringify({ presetId: 'old' }) }),
    )
    assert.equal(legacy.status, 200, legacy.raw)
    assert.equal(seen.persona, 'old')

    const bad = await call(
      routes,
      ROUTE_PATHS.digest,
      mockReq({ method: 'POST', headers: TRUSTED_HEADERS, body: JSON.stringify({ persona: '../etc' }) }),
    )
    assert.equal(bad.status, 400)
  })

  it('digest 路由在 runDigest 抛错时返回 500 而不崩', async () => {
    const { ctx, routes } = makeCtx()
    installRoutes(
      ctx,
      makeDeps({
        runDigest: async () => {
          throw new Error('runner broken')
        },
      }),
    )
    const result = await call(
      routes,
      ROUTE_PATHS.digest,
      mockReq({ method: 'POST', headers: TRUSTED_HEADERS, body: JSON.stringify({ persona: 'default' }) }),
    )
    assert.equal(result.status, 500)
    assert.match(result.json?.error, /runner broken/)
  })

  it('非 POST 的 digest 请求返回 405', async () => {
    const { ctx, routes } = makeCtx()
    installRoutes(ctx, makeDeps())
    const result = await call(routes, ROUTE_PATHS.digest, mockReq({ headers: TRUSTED_HEADERS }))
    assert.equal(result.status, 405)
  })
})

// ---------------------------------------------------------------- 真实 HTTP

describe('真实回环 HTTP', () => {
  it('GET bootstrap 走 node:http 返回 200 JSON', async () => {
    const { ctx, routes } = makeCtx()
    installRoutes(ctx, makeDeps())
    const handler = routes.get('/api/dsh-supermemory/bootstrap')
    const server = createServer((req, res) => {
      void handler(req, res)
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address()
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/dsh-supermemory/bootstrap`)
      assert.equal(response.status, 200)
      const json = await response.json()
      assert.equal(json.ok, true)
      assert.ok(Array.isArray(json.data.personas))
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })

  /**
   * 起一个真实的 node:http 服务，把已注册路由按精确路径分发（与宿主的 kind:'exact' 同构）。
   * @param {Map<string, Function>} routes - 路由表。
   * @param {string[]} hits - 出参：每进入一次 handler 追加一条 `METHOD url`，用于断言「有没有进 handler」。
   * @returns {Promise<{port: number, close: () => Promise<unknown>}>} 端口与关闭函数。
   */
  async function listen(routes, hits) {
    const server = createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`)
      const handler = routes.get(String(req.url).split('?')[0])
      if (handler === undefined) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end('{"ok":false,"error":"no route"}')
        return
      }
      void handler(req, res)
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    return {
      port: server.address().port,
      close: () => new Promise((resolve) => server.close(resolve)),
    }
  }

  /**
   * 用 node:net 手写请求行，把**未经 percent 编码的裸 UTF-8 字节**送上线路。
   *
   * 必须绕开 fetch 与 http.request：两者都会先把非 ASCII 字符百分号编码（实测 fetch 发裸中文，
   * 到达 handler 时已变成 `%E4%B8%B4...`），只有裸 socket 才复现得出 curl 那种「请求行里就是
   * UTF-8 字节」的形态——而这正是被 Node 的 HTTP parser（llhttp）拒绝的形态。
   * @param {number} port - 端口。
   * @param {string} target - 原样写进请求行的目标，可含裸中文。
   * @param {string} [method] - 请求方法。
   * @returns {Promise<{status: number, statusLine: string, body: string, bytes: number}>} 原始响应。
   */
  function sendRawRequestLine(port, target, method = 'DELETE') {
    return new Promise((resolve, reject) => {
      const socket = connect(port, '127.0.0.1')
      let buffer = Buffer.alloc(0)
      const finish = () => {
        socket.destroy()
        // 先按 latin1 取原文：任何解码都可能掩盖「parser 根本没生成响应」这个事实
        const text = buffer.toString('latin1')
        const split = text.indexOf('\r\n\r\n')
        const match = text.match(/^HTTP\/[\d.]+ (\d+)/u)
        resolve({
          status: match === null ? 0 : Number(match[1]),
          statusLine: (text.match(/^HTTP\/[\d.]+ \d+[^\r]*/u) ?? ['<无状态行：连接被直接掐断>'])[0],
          body: (() => {
            if (split < 0) return ''
            const tail = Buffer.from(text.slice(split + 4), 'latin1').toString('utf8')
            // 本用例只打「parser 层 400」，它不带 body；chunked 的空体形态也一并视作空
            return tail === '0\r\n\r\n' ? '' : tail
          })(),
          bytes: buffer.length,
        })
      }
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk])
      })
      socket.on('close', finish)
      socket.on('error', reject)
      socket.setTimeout(5000, finish)
      socket.write(`${method} ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAccept: */*\r\nConnection: close\r\n\r\n`)
    })
  }

  it('中文 slug 经百分号编码的 query 形态 DELETE：200 且磁盘目录真的消失（真实 store）', async () => {
    // 断言 ENOENT 必须真落盘，所以用独立临时 store，不碰文件级共享 store，避免污染其它用例。
    const dir = await mkdtemp(join(tmpdir(), 'dsh-sm-routes-cn-'))
    const root = join(dir, 'personas')
    const config = resolveConfig({ presetsRoot: root, personasRoot: root })
    const cnStore = createStore({ dshHome: dir, presetsRoot: root, personasRoot: root, config, logger: { warn() {}, info() {} } })
    try {
      if (cnStore?.ready !== undefined) await cnStore.ready
      await cnStore.createPersona('Default')
      const created = await cnStore.createPersona('临时验证改名后')
      assert.equal(created?.ok, true, `夹具建人设失败：${JSON.stringify(created)}`)
      const slug = created.persona.slug
      assert.ok(/[^\u0000-\u007F]/u.test(slug), `夹具要求 slug 含非 ASCII 字符，实际：${slug}`)
      const dirPath = join(root, slug)
      assert.ok((await stat(dirPath)).isDirectory(), '删除前该人设目录必须存在')

      const { ctx, routes } = makeCtx()
      installRoutes(
        ctx,
        makeDeps({
          store: cnStore,
          personasRoot: root,
          dshHome: dir,
          personas: {
            list: () => cnStore.listPersonas(),
            current: () => cnStore.currentPersona(),
            create: (name) => cnStore.createPersona(name),
            select: (personaSlug) => cnStore.setCurrentPersona(personaSlug),
            rename: (personaSlug, displayName) => cnStore.renamePersona(personaSlug, displayName),
            remove: (personaSlug) => cnStore.deletePersona(personaSlug),
          },
        }),
      )
      const hits = []
      const { port, close } = await listen(routes, hits)
      try {
        // 关键：encodeURIComponent 之后才是能在请求行里活下来的形态
        const response = await fetch(`http://127.0.0.1:${port}/api/dsh-supermemory/personas?slug=${encodeURIComponent(slug)}`, {
          method: 'DELETE',
        })
        const json = await response.json()
        assert.equal(response.status, 200, `编码 query 的中文 slug DELETE 必须 200，实际：${JSON.stringify(json)}`)
        assert.equal(json.ok, true)
        // 响应体仍与 GET 同构
        assert.deepEqual(Object.keys(json.data ?? {}).sort(), ['current', 'personas'])
        assert.equal(json.data.personas.some((persona) => persona.slug === slug), false, '列表里不应再有这个 slug')
        assert.equal(hits.length, 1, `应恰好进入一次 handler，实际：${JSON.stringify(hits)}`)
        // §V5.2 的删除要连目录一起消失
        await assert.rejects(
          async () => stat(dirPath),
          (error) => error?.code === 'ENOENT',
          '删除后人设目录必须 ENOENT（含 history/ 一并消失）',
        )
      } finally {
        await close()
      }
    } finally {
      await cnStore.dispose?.()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('含 % 的 slug 经编码 query 删除：删的是它自己，不是二次解码撞上的兄弟（§V5.4 不得再解一次）', async () => {
    // 夹具走 reconcileRegistry 的扫盘登记：personaSlug 会把 '%' 换成 '-'，所以 createPersona
    // 造不出含 % 的 slug；而手工建目录 / 从别处拷 personas/ 目录会被原样登记进注册表——
    // §V5.2「逐字匹配、不做归一化」要守的正是这一类 slug。
    const victim = '50%25测试' // 要被删除的
    const sibling = '50%测试' // 多解一次 percent 就会撞上的兄弟
    // 本用例的立论基础，先自证：对 victim 多解一次，结果正好等于 sibling。
    // 将来若有人改了这两个常量导致等式不成立，这句话会立刻说明「夹具失效」而不是让断言静默失去意义。
    assert.equal(
      decodeURIComponent(decodeURIComponent(encodeURIComponent(victim))),
      sibling,
      '夹具前提：二次解码 victim 必须正好得到 sibling，否则本用例测不到「删错人设」',
    )

    const dir = await mkdtemp(join(tmpdir(), 'dsh-sm-routes-pct-'))
    const root = join(dir, 'personas')
    const victimDir = join(root, victim)
    const siblingDir = join(root, sibling)
    await mkdir(victimDir, { recursive: true })
    await mkdir(siblingDir, { recursive: true })
    const config = resolveConfig({ presetsRoot: root, personasRoot: root })
    const pctStore = createStore({ dshHome: dir, presetsRoot: root, personasRoot: root, config, logger: { warn() {}, info() {} } })
    try {
      if (pctStore?.ready !== undefined) await pctStore.ready
      const registered = pctStore.listPersonas().map((persona) => persona.slug)
      assert.ok(
        registered.includes(victim) && registered.includes(sibling),
        `夹具：reconcile 必须原样登记两个含 % 的 slug（不归一化），实际：${JSON.stringify(registered)}`,
      )

      const { ctx, routes } = makeCtx()
      installRoutes(
        ctx,
        makeDeps({
          store: pctStore,
          personasRoot: root,
          dshHome: dir,
          personas: {
            list: () => pctStore.listPersonas(),
            current: () => pctStore.currentPersona(),
            create: (name) => pctStore.createPersona(name),
            select: (personaSlug) => pctStore.setCurrentPersona(personaSlug),
            rename: (personaSlug, displayName) => pctStore.renamePersona(personaSlug, displayName),
            remove: (personaSlug) => pctStore.deletePersona(personaSlug),
          },
        }),
      )
      const hits = []
      const { port, close } = await listen(routes, hits)
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/dsh-supermemory/personas?slug=${encodeURIComponent(victim)}`, {
          method: 'DELETE',
        })
        const json = await response.json()
        assert.equal(response.status, 200, `编码形态删除含 % 的 slug 必须 200，实际：${JSON.stringify(json)}`)
        assert.equal(json.ok, true)

        // ② 灵魂断言，放在最前：sibling 一个字节都不能少。多解一次 percent 就会让它变成被删的那个，
        //    而响应依然是 200 + 同构体——静默删错数据，比删不掉严重一个数量级。
        //    先探存在性再断言：直接 await stat 会让裸 ENOENT 抢在前面抛掉，盖掉这句要传达的因果。
        let siblingAlive = false
        try {
          siblingAlive = (await stat(siblingDir)).isDirectory()
        } catch {
          siblingAlive = false
        }
        assert.ok(
          siblingAlive,
          `${sibling} 的目录不见了——它被当成删除目标删掉了。原因只可能是 slug 被多解了一次 percent：` +
            `queryOf 已把 ${victim} 正确还原，若在其后再加一次 decodeURIComponent 就会得到 ${sibling}。`,
        )
        // ① victim 的目录真的没了
        await assert.rejects(
          async () => stat(victimDir),
          (error) => error?.code === 'ENOENT',
          '删除后 victim 目录必须 ENOENT',
        )
        // ③ 返回的列表里少的是 victim、留的是 sibling
        const remaining = json.data.personas.map((persona) => persona.slug)
        assert.equal(remaining.includes(victim), false, `响应列表里 victim 必须已被移除，实际：${JSON.stringify(remaining)}`)
        assert.ok(remaining.includes(sibling), `响应列表里 sibling 必须还在，实际：${JSON.stringify(remaining)}`)
        assert.equal(hits.length, 1, `应恰好进入一次 handler，实际：${JSON.stringify(hits)}`)
      } finally {
        await close()
      }
    } finally {
      await pctStore.dispose?.()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('裸 UTF-8 中文请求行：被 Node 的 HTTP parser 拒为 400 空响应且不进 handler（§V5.4 query 必须百分号编码）', async () => {
    const slug = '临时验证改名后'
    // 局部 personas 夹具：只额外记录 remove 收到的 slug，用来证明 percent-decode 逐字还原。
    // 断言不借用真实 store 的 error 文案——那是 store 的自由，不是路由层的契约。
    const removedWith = []
    const personas = {
      ...makePersonasFake().api,
      remove: async (personaSlug) => {
        removedWith.push(personaSlug)
        return { ok: false, code: 'NOT_FOUND', message: 'persona not found' }
      },
    }
    const { ctx, routes } = makeCtx()
    const hits = []
    installRoutes(ctx, makeDeps({ personas }))
    const { port, close } = await listen(routes, hits)
    try {
      const raw = await sendRawRequestLine(port, `/api/dsh-supermemory/personas?slug=${slug}`)
      assert.equal(raw.status, 400, `裸非 ASCII 请求行必须 400，实际状态行：${raw.statusLine}（${raw.bytes} 字节）`)
      // 空 body 是「parser 层拒绝」的唯一特征：插件自己的 400 一定带 {"ok":false,...,"code":"BAD_INPUT"}
      assert.equal(raw.body, '', `必须是空响应体（区别于插件的 400 JSON）——本断言的存在意义就是拦住「加 decodeURIComponent 去修」的改法，实际收到：${JSON.stringify(raw.body)}`)
      assert.deepEqual(hits, [], '裸非 ASCII 请求行不得进入插件 handler')
      assert.deepEqual(removedWith, [], '裸非 ASCII 请求行不得触发删除')

      // 对照组：同一个中文 slug 一经百分号编码，立刻正常送达 handler
      const encoded = await fetch(`http://127.0.0.1:${port}/api/dsh-supermemory/personas?slug=${encodeURIComponent(slug)}`, {
        method: 'DELETE',
      })
      const json = await encoded.json()
      assert.equal(encoded.status, 404, `编码形态应送达 handler 并因查表未命中而 404，实际：${JSON.stringify(json)}`)
      assert.equal(json.code, 'NOT_FOUND')
      assert.equal(hits.length, 1, `编码形态应恰好进入一次 handler，实际：${JSON.stringify(hits)}`)
      assert.match(hits[0], /slug=%E4%B8%B4/u, 'handler 收到的 req.url 里应是百分号编码形态')
      // 决定性一条：queryOf 那唯一一次 percent-decode 把中文逐字还原后才交给 store
      assert.deepEqual(removedWith, [slug], 'store 收到的 slug 必须与中文原文逐字相等（§V5.2 逐字匹配、不做归一化）')
    } finally {
      await close()
    }
  })
})

// ---------------------------------------------------------------- 整理器

/**
 * 假 LLM：捕获每次 stream 的 provider/model/system，并返回固定输出。
 * @param {object[]} captured - 捕获数组。
 * @param {string} [text] - text-delta 内容。
 * @returns {object} 假 llm 服务。
 */
function makeLlm(captured, text = '{"project":[]}') {
  return {
    stream(params) {
      captured.push({
        provider: params?.provider,
        model: params?.model,
        system: params?.system,
        input: params?.messages?.[0]?.content?.[0]?.text,
      })
      // 关键：必须同步返回 AsyncIterable（不是 Promise）。
      return (async function* () {
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

/**
 * 假整理 store：可控 readSettings，不落盘。
 * @param {object} [options]
 * @param {{digestProvider?:string,digestModel?:string}} [options.settings] - readSettings 返回值。
 * @param {boolean} [options.withReadSettings] - 是否实现 readSettings。
 * @returns {object} 假 store。
 */
function makeFakeDigestStore(options = {}) {
  const store = {
    reads: 0,
    appendRun: async () => {},
    readDoc: async () => {
      store.reads += 1
      return { content: '', mtimeMs: 0, bytes: 0, path: '/fake' }
    },
    writeDoc: async () => ({ ok: true, mtimeMs: 1, bytes: 0 }),
  }
  if (options.withReadSettings !== false) {
    store.readSettings = () => ({ digestProvider: '', digestModel: '', ...(options.settings ?? {}) })
  }
  return store
}

describe('createDigestRunner', () => {
  it('llm 服务缺失时返回失败 RunRecord 且不抛', async () => {
    const { ctx } = makeCtx()
    const runner = createDigestRunner(ctx, makeDeps())
    const record = await runner.runDigest({ trigger: 'manual', persona: 'default', projectRoot: workDir })
    assert.equal(record.ok, false)
    assert.equal(record.error, 'llm service unavailable')
    assert.equal(typeof record.at, 'string')
    runner.dispose()
  })

  it('同一 session 并发触发只跑一个，第二个返回「已在整理中」', async () => {
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const captured = []
    const llm = {
      stream() {
        captured.push(1)
        return (async function* () {
          await gate
          yield { type: 'text-delta', index: 0, text: '{"project":["并发整理只跑一次"]}' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    }
    const { ctx } = makeCtx({ llm })
    const runner = createDigestRunner(ctx, makeDeps())
    const first = runner.runDigest({ trigger: 'turns', sessionId: 'session-1', persona: 'default', projectRoot: workDir })
    const second = await runner.runDigest({ trigger: 'pressure', sessionId: 'session-1', persona: 'default', projectRoot: workDir })
    assert.equal(second.ok, false)
    assert.equal(second.skipped, true)
    assert.equal(second.error, '已在整理中')

    release()
    const firstRecord = await first
    assert.equal(firstRecord.ok, true, JSON.stringify(firstRecord))
    assert.equal(captured.length, 1)
    runner.dispose()
  })

  it('v2：只写 project —— soul/user/global 的模型输出全部丢弃，counts 非 project 恒 0', async () => {
    const captured = []
    const llm = makeLlm(
      captured,
      JSON.stringify({
        soul: ['这条人格必须被丢弃'],
        user: ['这条画像必须被丢弃'],
        global: ['这条全局记忆必须被丢弃'],
        project: ['这条项目事实必须写入'],
      }),
    )
    const { ctx } = makeCtx({ llm })
    const runner = createDigestRunner(ctx, makeDeps())
    const record = await runner.runDigest({
      trigger: 'tool',
      sessionId: 'session-scope',
      persona: 't:scope',
      projectRoot: workDir,
    })
    assert.equal(record.ok, true, JSON.stringify(record))
    assert.deepEqual(record.counts, { soul: 0, user: 0, global: 0, project: 1 })
    assert.equal(record.persona, 't:scope')
    assert.equal(record.presetId, 't:scope', '兼容字段仍要写')

    // system 提示必须只要求 project。
    assert.match(captured[0].system, /"project"/u)
    assert.match(captured[0].system, /不要输出 soul/u)
    assert.equal(captured[0].system.includes('{"user"'), false)
    assert.equal(captured[0].system.includes('"soul":["'), false)

    const projectDoc = await store.readDoc({ kind: 'project', projectRoot: workDir })
    assert.match(projectDoc.content, /这条项目事实必须写入/u)
    for (const kind of ['soul', 'user', 'global']) {
      const doc = await store.readDoc({ kind, persona: 't:scope', presetId: 't:scope' })
      assert.equal(doc.content.includes('必须被丢弃'), false, `${kind} 不得被自动整理写入`)
    }
  })

  it('模型优先级 1/4：settings 最高，压过 config / currentRoute / agentDefaultModel', async () => {
    const captured = []
    const { ctx } = makeCtx({
      llm: makeLlm(captured),
      agentDefaultModel: { currentSelection: () => ({ provider: 'default-p', model: 'default-m' }) },
    })
    const runner = createDigestRunner(ctx, {
      store: makeFakeDigestStore({ settings: { digestProvider: 'settings-p', digestModel: 'settings-m' } }),
      getConfig: () => resolveConfig({ digestProvider: 'config-p', digestModel: 'config-m' }),
      currentRoute: () => ({ provider: 'route-p', model: 'route-m' }),
      logger: { warn() {} },
    })
    const record = await runner.runDigest({ trigger: 'manual' })
    assert.equal(record.ok, true, JSON.stringify(record))
    assert.deepEqual({ provider: captured[0].provider, model: captured[0].model }, { provider: 'settings-p', model: 'settings-m' })
    runner.dispose()
  })

  it('模型优先级 2/4：settings 为空时用配置', async () => {
    const captured = []
    const { ctx } = makeCtx({
      llm: makeLlm(captured),
      agentDefaultModel: { currentSelection: () => ({ provider: 'default-p', model: 'default-m' }) },
    })
    const runner = createDigestRunner(ctx, {
      store: makeFakeDigestStore(),
      getConfig: () => resolveConfig({ digestProvider: 'config-p', digestModel: 'config-m' }),
      currentRoute: () => ({ provider: 'route-p', model: 'route-m' }),
      logger: { warn() {} },
    })
    const record = await runner.runDigest({ trigger: 'manual' })
    assert.equal(record.ok, true, JSON.stringify(record))
    assert.deepEqual({ provider: captured[0].provider, model: captured[0].model }, { provider: 'config-p', model: 'config-m' })
    runner.dispose()
  })

  it('模型优先级 3/4：settings 与配置都为空时用当前会话路由', async () => {
    const captured = []
    const { ctx } = makeCtx({
      llm: makeLlm(captured),
      agentDefaultModel: { currentSelection: () => ({ provider: 'default-p', model: 'default-m' }) },
    })
    const runner = createDigestRunner(ctx, {
      store: makeFakeDigestStore(),
      getConfig: () => resolveConfig({}),
      currentRoute: () => ({ provider: 'route-p', model: 'route-m' }),
      logger: { warn() {} },
    })
    const record = await runner.runDigest({ trigger: 'manual' })
    assert.equal(record.ok, true, JSON.stringify(record))
    assert.deepEqual({ provider: captured[0].provider, model: captured[0].model }, { provider: 'route-p', model: 'route-m' })
    runner.dispose()
  })

  it('模型优先级 4/4：前三层都没有时回退 agentDefaultModel', async () => {
    const captured = []
    const { ctx } = makeCtx({
      llm: makeLlm(captured),
      agentDefaultModel: { currentSelection: () => ({ provider: 'default-p', model: 'default-m' }) },
    })
    const runner = createDigestRunner(ctx, {
      store: makeFakeDigestStore(),
      getConfig: () => resolveConfig({}),
      currentRoute: () => undefined,
      logger: { warn() {} },
    })
    const record = await runner.runDigest({ trigger: 'manual' })
    assert.equal(record.ok, true, JSON.stringify(record))
    assert.deepEqual({ provider: captured[0].provider, model: captured[0].model }, { provider: 'default-p', model: 'default-m' })
    runner.dispose()
  })

  it('provider 与 model 必须同时非空：不完整层被跳过、不跨层拼装', async () => {
    const captured = []
    const { ctx } = makeCtx({ llm: makeLlm(captured) })
    const runner = createDigestRunner(ctx, {
      store: makeFakeDigestStore({ settings: { digestProvider: 'settings-p' } }),
      getConfig: () => resolveConfig({ digestProvider: 'config-p', digestModel: 'config-m' }),
      currentRoute: () => undefined,
      logger: { warn() {} },
    })
    const record = await runner.runDigest({ trigger: 'manual' })
    assert.equal(record.ok, true, JSON.stringify(record))
    assert.deepEqual({ provider: captured[0].provider, model: captured[0].model }, { provider: 'config-p', model: 'config-m' })
    runner.dispose()
  })

  it('四层都取不到路由 → 失败 RunRecord 且不调用 LLM', async () => {
    const captured = []
    const { ctx } = makeCtx({ llm: makeLlm(captured) })
    const runner = createDigestRunner(ctx, {
      store: makeFakeDigestStore(),
      getConfig: () => resolveConfig({}),
      currentRoute: () => undefined,
      logger: { warn() {} },
    })
    const record = await runner.runDigest({ trigger: 'manual' })
    assert.equal(record.ok, false)
    assert.equal(record.error, 'llm route unavailable')
    assert.equal(captured.length, 0)
    runner.dispose()
  })

  it('store 无 readSettings 时回退 deps.settings.read', async () => {
    const captured = []
    const { ctx } = makeCtx({ llm: makeLlm(captured) })
    const runner = createDigestRunner(ctx, {
      store: makeFakeDigestStore({ withReadSettings: false }),
      settings: { read: () => ({ digestProvider: 'deps-p', digestModel: 'deps-m' }) },
      getConfig: () => resolveConfig({}),
      currentRoute: () => undefined,
      logger: { warn() {} },
    })
    const record = await runner.runDigest({ trigger: 'manual' })
    assert.equal(record.ok, true, JSON.stringify(record))
    assert.deepEqual({ provider: captured[0].provider, model: captured[0].model }, { provider: 'deps-p', model: 'deps-m' })
    runner.dispose()
  })

  it('llm 直接抛错时返回失败记录而不抛', async () => {
    const llm = {
      stream() {
        throw new Error('provider exploded')
      },
    }
    const { ctx } = makeCtx({ llm })
    const runner = createDigestRunner(ctx, makeDeps())
    const record = await runner.runDigest({ trigger: 'manual', sessionId: 'session-boom', persona: 'default' })
    assert.equal(record.ok, false)
    assert.match(record.error, /provider exploded/u)
    runner.dispose()
  })

  it('install 在 session/event 上注册监听并返回 dispose', () => {
    const handlers = []
    const { ctx } = makeCtx()
    ctx.on = (event, listener) => {
      handlers.push({ event, listener })
      return () => {}
    }
    const runner = createDigestRunner(ctx, makeDeps())
    const dispose = runner.install()
    assert.equal(handlers.length, 1)
    assert.equal(handlers[0].event, 'session/event')
    assert.equal(typeof dispose, 'function')
    assert.doesNotThrow(() => dispose())
  })

  it('子智能体的 turn/end 不触发自动整理', async () => {
    const captured = []
    const handlers = []
    const { ctx } = makeCtx({ llm: makeLlm(captured) })
    ctx.on = (event, listener) => {
      handlers.push(listener)
      return () => {}
    }
    const session = { id: 'child-1', header: { parentSession: 'parent-1' } }
    const runner = createDigestRunner(ctx, { ...makeDeps(), isSubagent: () => true })
    runner.install()
    handlers[0](session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(captured.length, 0)
    runner.dispose()
  })
})
