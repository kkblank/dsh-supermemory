/**
 * `lib/host/routes.js` 与 `lib/host/digest.js` 的单元测试（v2）。
 *
 * 覆盖（契约 §10 routes 组 + §5.4 + v2 §V2.3/§V2.4/§V2.8）：
 *   - 信任栅栏：非 loopback socket / 代理头 / cross-site / 异源 Origin / 非 loopback Host → 403。
 *   - 正常 loopback + 同源 → 200 且 `{ ok:true, data }`。
 *   - bootstrap v2 新结构；models 路由；settings PUT；personas GET/POST/PUT 与名称校验。
 *   - doc 路由 persona 参数（兼容 presetId）、路径穿越 → 400；PUT 冲突 409；请求体超限 413。
 *   - 整理器：llm 缺失不抛；并发只跑一个；**只写 project（soul/user/global 输出被丢弃）**；
 *     模型选择四层回退（settings → config → currentRoute → agentDefaultModel）。
 *
 * 说明：403 用例需要伪造 socket / headers，因此既用 mock req/res 直连 handler，
 * 也用 node:http 起真实回环服务验证端到端行为。
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
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
  }
  return { api, personas, currentSlug: () => currentSlug }
}

/**
 * 内存版设置 API：模拟 store 的 readSettings / writeSettings。
 * @param {{digestProvider?:string, digestModel?:string}} [initial] - 初始设置。
 * @returns {{api:object, state:object}} 夹具。
 */
function makeSettingsFake(initial = {}) {
  const state = { digestProvider: '', digestModel: '', ...initial }
  const api = {
    read: () => ({ ...state }),
    write: async (patch) => {
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

  it('没有 webServer 服务时静默降级', () => {
    const ctx = { get: () => undefined, effect: (fn) => fn?.(), logger: { warn() {} } }
    const dispose = installRoutes(ctx, makeDeps())
    assert.equal(typeof dispose, 'function')
    assert.doesNotThrow(() => dispose())
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
    assert.deepEqual(data.digestSettings, { digestProvider: 'prov-a', digestModel: 'model-1' })
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
    assert.deepEqual(result.json?.data.digestSettings, { digestProvider: 'prov-a', digestModel: 'model-1' })
    assert.deepEqual(settings.state, { digestProvider: 'prov-a', digestModel: 'model-1' })
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
    assert.deepEqual(result.json?.data.digestSettings, { digestProvider: '', digestModel: '' })
    assert.deepEqual(settings.state, { digestProvider: '', digestModel: '' })
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

  it('DELETE 方法返回 405', async () => {
    const { ctx, routes } = makeCtx()
    installRoutes(ctx, makeDeps())
    const result = await call(routes, ROUTE_PATHS.personas, mockReq({ method: 'DELETE', headers: TRUSTED_HEADERS }))
    assert.equal(result.status, 405)
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
