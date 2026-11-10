/**
 * `lib/host/routes.js` 与 `lib/host/digest.js` 的单元测试。
 *
 * 覆盖（契约 §10 routes 组 + §5.4）：
 *   - 信任栅栏：非 loopback socket / x-forwarded-for / cf-connecting-ip /
 *     cross-site / 异源 Origin / 非 loopback Host → 403。
 *   - 正常 loopback + 同源 → 200 且 `{ ok:true, data }`。
 *   - doc 路由的 presetId 含 `../`、projectRoot 非法 → 400。
 *   - PUT doc 带错误 expectedMtimeMs → 409；请求体超 1 MiB → 413。
 *   - 整理器：llm 缺失返回失败 RunRecord 且不抛；同一 session 并发只跑一个。
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

import { installRoutes } from '../lib/host/routes.js'
import { createDigestRunner } from '../lib/host/digest.js'
import { createStore } from '../lib/core/store.js'
import { resolveConfig } from '../lib/host/config.js'

// ---------------------------------------------------------------- 测试工具

/** 临时目录（整个文件共享）。 */
let workDir
let store

before(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'dsh-sm-routes-'))
  store = createStore({
    dshHome: workDir,
    presetsRoot: join(workDir, 'presets'),
    config: resolveConfig({ projectDirName: '.dsh/memory', projectFileName: 'project-memory.md' }),
    logger: { warn() {}, info() {} },
  })
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

/** 安装路由所需的 deps。 */
function makeDeps(overrides = {}) {
  return {
    store,
    getConfig: () => resolveConfig({ digestProvider: 'p', digestModel: 'm' }),
    readActiveContext: () => ({ presetId: 'default', projectRoot: workDir, projectName: 'ws' }),
    presetsRoot: join(workDir, 'presets'),
    dshHome: workDir,
    logger: { warn() {}, info() {} },
    runDigest: async () => ({ at: new Date().toISOString(), ok: true, counts: { soul: 0, user: 0, global: 1, project: 0 } }),
    ...overrides,
  }
}

// ---------------------------------------------------------------- 信任栅栏

/** 路由常量（与实现保持一致，用字符串写死以便测试独立验证契约）。 */
const ROUTE_PATHS = Object.freeze({
  bootstrap: 'api/dsh-supermemory/bootstrap',
  doc: 'api/dsh-supermemory/doc',
  digest: 'api/dsh-supermemory/digest',
  runs: 'api/dsh-supermemory/runs',
})

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
})

// ---------------------------------------------------------------- 路由

describe('installRoutes', () => {
  it('注册 document-relative 前缀对应的绝对 pathname', () => {
    const { ctx, routes } = makeCtx()
    installRoutes(ctx, makeDeps())
    assert.equal(ROUTE_PATHS.bootstrap, 'api/dsh-supermemory/bootstrap')
    assert.ok(routes.has('/api/dsh-supermemory/bootstrap'))
    assert.ok(routes.has('/api/dsh-supermemory/doc'))
    assert.ok(routes.has('/api/dsh-supermemory/digest'))
    assert.ok(routes.has('/api/dsh-supermemory/runs'))
    assert.equal(routes.has('api/dsh-supermemory/bootstrap'), false)
  })

  it('每个路由第一行都执行信任栅栏：非 loopback 一律 403', async () => {
    const { ctx, routes } = makeCtx()
    installRoutes(ctx, makeDeps())
    const untrusted = { headers: TRUSTED_HEADERS, remoteAddress: '192.168.1.5' }
    for (const path of Object.values(ROUTE_PATHS)) {
      const result = await call(routes, path, mockReq({ ...untrusted, method: path.endsWith('doc') ? 'PUT' : 'GET' }))
      assert.equal(result.status, 403, `${path} must be 403`)
      assert.equal(result.json?.ok, false)
      assert.equal(result.json?.error, 'forbidden')
    }
  })

  it('带 x-forwarded-for 的请求 403', async () => {
    const { ctx, routes } = makeCtx()
    installRoutes(ctx, makeDeps())
    const req = mockReq({ headers: { ...TRUSTED_HEADERS, 'x-forwarded-for': '1.2.3.4' } })
    const result = await call(routes, ROUTE_PATHS.bootstrap, req)
    assert.equal(result.status, 403)
    assert.equal(result.json?.error, 'forbidden')
  })

  it('bootstrap 正常返回 200 与 presets/projects/active/config', async () => {
    const { ctx, routes } = makeCtx()
    installRoutes(ctx, makeDeps())
    const result = await call(routes, ROUTE_PATHS.bootstrap, mockReq({ headers: TRUSTED_HEADERS }))
    assert.equal(result.status, 200)
    assert.equal(result.json?.ok, true)
    const data = result.json?.data
    assert.ok(Array.isArray(data.presets))
    assert.ok(Array.isArray(data.projects))
    assert.equal(data.active.presetId, 'default')
    assert.equal(typeof data.config.injectMaxBytes, 'number')
    assert.equal(data.presetsRoot, join(workDir, 'presets'))
  })

  it('GET doc 拒绝含 ../ 的 presetId（400 而非读任意文件）', async () => {
    const { ctx, routes } = makeCtx()
    installRoutes(ctx, makeDeps())
    const req = mockReq({
      headers: TRUSTED_HEADERS,
      url: `/api/dsh-supermemory/doc?scope=global&presetId=${encodeURIComponent('../../etc')}`,
    })
    const result = await call(routes, ROUTE_PATHS.doc, req)
    assert.equal(result.status, 400)
    assert.equal(result.json?.ok, false)
  })

  it('GET doc 拒绝相对 projectRoot 与 scope 非法', async () => {
    const { ctx, routes } = makeCtx()
    installRoutes(ctx, makeDeps())
    const relative = mockReq({
      headers: TRUSTED_HEADERS,
      url: '/api/dsh-supermemory/doc?scope=project&projectRoot=relative/path',
    })
    assert.equal((await call(routes, ROUTE_PATHS.doc, relative)).status, 400)

    const badScope = mockReq({ headers: TRUSTED_HEADERS, url: '/api/dsh-supermemory/doc?scope=secrets&presetId=x' })
    assert.equal((await call(routes, ROUTE_PATHS.doc, badScope)).status, 400)
  })

  it('GET doc 正常读取并返回 content/mtimeMs/bytes/title', async () => {
    const { ctx, routes } = makeCtx()
    installRoutes(ctx, makeDeps())
    const url = `/api/dsh-supermemory/doc?scope=global&presetId=${encodeURIComponent('t:read')}`
    const result = await call(routes, ROUTE_PATHS.doc, mockReq({ headers: TRUSTED_HEADERS, url }))
    assert.equal(result.status, 200)
    assert.equal(result.json?.ok, true)
    assert.equal(typeof result.json?.data.content, 'string')
    assert.equal(typeof result.json?.data.mtimeMs, 'number')
    assert.equal(result.json?.data.title, '全局长期记忆')
    assert.ok(result.json?.data.path.startsWith(join(workDir, 'presets')))
  })

  it('PUT doc 带错误 expectedMtimeMs 返回 409', async () => {
    const { ctx, routes } = makeCtx()
    installRoutes(ctx, makeDeps())
    const ref = { scope: 'global', presetId: 't:write' }
    const first = await call(
      routes,
      ROUTE_PATHS.doc,
      mockReq({
        method: 'PUT',
        headers: TRUSTED_HEADERS,
        body: JSON.stringify({ ...ref, content: '# 全局长期记忆\n\n## 条目\n', expectedMtimeMs: 0 }),
      }),
    )
    assert.equal(first.status, 200, first.raw)

    const stale = await call(
      routes,
      ROUTE_PATHS.doc,
      mockReq({
        method: 'PUT',
        headers: TRUSTED_HEADERS,
        body: JSON.stringify({ ...ref, content: '# 全局长期记忆\n\n## 条目\n\n- x\n', expectedMtimeMs: 1 }),
      }),
    )
    assert.equal(stale.status, 409)
    assert.equal(stale.json?.code, 'STALE')
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
        body: JSON.stringify({ scope: 'global', presetId: 'big', content: huge }),
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

  it('runs 路由返回最近整理报告', async () => {
    const { ctx, routes } = makeCtx()
    installRoutes(ctx, makeDeps())
    const result = await call(routes, ROUTE_PATHS.runs, mockReq({ headers: TRUSTED_HEADERS }))
    assert.equal(result.status, 200)
    assert.ok(Array.isArray(result.json?.data.runs))
  })

  it('digest 路由转发参数给 deps.runDigest', async () => {
    let seen
    const { ctx, routes } = makeCtx()
    installRoutes(
      ctx,
      makeDeps({
        runDigest: async (request) => {
          seen = request
          return { at: new Date().toISOString(), ok: true, counts: { soul: 0, user: 0, global: 1, project: 0 } }
        },
      }),
    )
    const result = await call(
      routes,
      ROUTE_PATHS.digest,
      mockReq({
        method: 'POST',
        headers: TRUSTED_HEADERS,
        body: JSON.stringify({ presetId: 'default', projectRoot: workDir, sessionId: 's1' }),
      }),
    )
    assert.equal(result.status, 200)
    assert.equal(result.json?.data.ok, true)
    assert.equal(seen.trigger, 'manual')
    assert.equal(seen.presetId, 'default')
    assert.equal(seen.projectRoot, workDir)
    assert.equal(seen.sessionId, 's1')
  })

  it('dispose 注销全部路由', () => {
    const { ctx, routes } = makeCtx()
    const dispose = installRoutes(ctx, makeDeps())
    assert.equal(routes.size, 4)
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
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
})

// ---------------------------------------------------------------- 整理器

describe('createDigestRunner', () => {
  it('llm 服务缺失时返回失败 RunRecord 且不抛', async () => {
    const { ctx } = makeCtx()
    const runner = createDigestRunner(ctx, makeDeps())
    const record = await runner.runDigest({ trigger: 'manual', presetId: 'default', projectRoot: workDir })
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
    let calls = 0
    const llm = {
      stream() {
        calls += 1
        return (async function* () {
          await gate
          yield { type: 'text-delta', index: 0, text: '{"global":["并发整理只跑一次"]}' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    }
    const { ctx } = makeCtx({ llm })
    const runner = createDigestRunner(ctx, makeDeps())
    const deps = { ...makeDeps(), currentRoute: () => ({ provider: 'p', model: 'm' }) }
    const realRunner = createDigestRunner(ctx, deps)

    const first = realRunner.runDigest({ trigger: 'turns', sessionId: 'session-1', presetId: 'default', projectRoot: workDir })
    const second = await realRunner.runDigest({ trigger: 'pressure', sessionId: 'session-1', presetId: 'default', projectRoot: workDir })
    assert.equal(second.ok, false)
    assert.equal(second.skipped, true)
    assert.equal(second.error, '已在整理中')

    release()
    const firstRecord = await first
    assert.equal(firstRecord.ok, true, JSON.stringify(firstRecord))
    assert.equal(calls, 1)
    realRunner.dispose()
    runner.dispose()
  })

  it('正常调用会写入条目并记录 counts', async () => {
    const llm = {
      stream() {
        return (async function* () {
          yield { type: 'text-delta', index: 0, text: '```json\n{"global":["项目用 pnpm"],"user":[],"project":[],"soul":[]}\n```' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    }
    const { ctx } = makeCtx({ llm })
    const runner = createDigestRunner(ctx, { ...makeDeps(), currentRoute: () => ({ provider: 'p', model: 'm' }) })
    const record = await runner.runDigest({
      trigger: 'tool',
      sessionId: 'session-write',
      presetId: 't:digest',
      projectRoot: workDir,
    })
    assert.equal(record.ok, true, JSON.stringify(record))
    assert.equal(record.counts.global, 1)
    const doc = await store.readDoc({ kind: 'global', presetId: 't:digest' })
    assert.match(doc.content, /项目用 pnpm/)
    runner.dispose()
  })

  it('llm 直接抛错时返回失败记录而不抛', async () => {
    const llm = {
      stream() {
        throw new Error('provider exploded')
      },
    }
    const { ctx } = makeCtx({ llm })
    const runner = createDigestRunner(ctx, { ...makeDeps(), currentRoute: () => ({ provider: 'p', model: 'm' }) })
    const record = await runner.runDigest({ trigger: 'manual', sessionId: 'session-boom', presetId: 'default' })
    assert.equal(record.ok, false)
    assert.match(record.error, /provider exploded/)
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
    let streamCalls = 0
    const llm = {
      stream() {
        streamCalls += 1
        return (async function* () {
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    }
    const handlers = []
    const { ctx } = makeCtx({ llm })
    ctx.on = (event, listener) => {
      handlers.push(listener)
      return () => {}
    }
    const session = { id: 'child-1', header: { parentSession: 'parent-1' } }
    const runner = createDigestRunner(ctx, {
      ...makeDeps(),
      currentRoute: () => ({ provider: 'p', model: 'm' }),
      isSubagent: () => true,
    })
    runner.install()
    handlers[0](session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(streamCalls, 0)
    runner.dispose()
  })
})
