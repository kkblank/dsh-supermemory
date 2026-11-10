/**
 * 信任栅栏 `isTrustedRequest` 的直接矩阵测试（补 CONTRACT §5.5 / §10）。
 *
 * `test/routes.test.js` 只通过路由间接断言 403/200；本文件直接调用导出的
 * `isTrustedRequest(req)`，把 socket / 代理头 / Host / Origin / sec-fetch-site
 * 五个维度的组合矩阵逐项锁死，防止后续重构把安全判定改宽松。
 *
 * 运行：node --test test/trust-fence.test.js
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { isTrustedRequest } from '../lib/host/routes.js'

/** 一组完全可信的 Host 头。 */
const TRUSTED_HOST = Object.freeze({ host: '127.0.0.1:3080' })

/**
 * 构造只含 socket.remoteAddress 与 headers 的 mock 请求。
 *
 * @param {object} [options] - 覆盖项。
 * @param {string|undefined} [options.remoteAddress] - 传 `undefined` 表示「有 socket 但没有地址」，不传则默认回环。
 * @param {object} [options.headers] - 请求头。
 * @returns {object} mock req。
 */
function makeReq(options = {}) {
  const req = { headers: options.headers ?? {} }
  if (Object.prototype.hasOwnProperty.call(options, 'remoteAddress')) {
    req.socket = options.remoteAddress === undefined ? {} : { remoteAddress: options.remoteAddress }
  } else {
    req.socket = { remoteAddress: '127.0.0.1' }
  }
  return req
}

// ——————————————————————————————————————————————
// socket 远端地址
// ——————————————————————————————————————————————

test('socket remoteAddress：127/8、::1、IPv4-mapped 回环可信；其余不可信', () => {
  const cases = [
    ['127.0.0.1', true],
    ['127.5.5.5', true],
    ['127.255.255.254', true],
    ['::1', true],
    ['::ffff:127.0.0.1', true],
    ['::ffff:7f00:1', true],
    ['10.0.0.7', false],
    ['192.168.1.1', false],
    ['::ffff:10.0.0.1', false],
    ['0.0.0.0', false],
    ['', false],
  ]
  for (const [address, expected] of cases) {
    assert.equal(
      isTrustedRequest(makeReq({ remoteAddress: address, headers: TRUSTED_HOST })),
      expected,
      `remoteAddress=${address} 期望 ${expected}`,
    )
  }
})

test('socket 缺失或 remoteAddress 缺失一律不可信', () => {
  assert.equal(isTrustedRequest({ headers: TRUSTED_HOST }), false, '没有 socket 必须拒')
  assert.equal(isTrustedRequest(makeReq({ remoteAddress: undefined, headers: TRUSTED_HOST })), false)
})

// ——————————————————————————————————————————————
// 反向代理头
// ——————————————————————————————————————————————

test('任一代理头存在即拒绝（即使其余事实完全可信）', () => {
  const proxyHeaders = ['x-forwarded-for', 'cf-connecting-ip', 'x-real-ip', 'forwarded']
  for (const name of proxyHeaders) {
    const headers = { ...TRUSTED_HOST, [name]: '1.2.3.4' }
    assert.equal(isTrustedRequest(makeReq({ headers })), false, `${name} 必须导致拒绝`)
  }
  // Node 对重复头可能给数组；出现过同样不可信。
  const duplicated = { ...TRUSTED_HOST, 'x-forwarded-for': ['1.2.3.4', '5.6.7.8'] }
  assert.equal(isTrustedRequest(makeReq({ headers: duplicated })), false, '重复代理头必须拒绝')
})

test('多个代理头同时存在也拒绝', () => {
  const headers = {
    ...TRUSTED_HOST,
    'x-forwarded-for': '1.2.3.4',
    'x-real-ip': '1.2.3.4',
    forwarded: 'for=1.2.3.4',
  }
  assert.equal(isTrustedRequest(makeReq({ headers })), false)
})

// ——————————————————————————————————————————————
// Host 头（防 DNS rebinding）
// ——————————————————————————————————————————————

test('Host 必须是 loopback authority', () => {
  const cases = [
    ['127.0.0.1:3080', true],
    ['127.0.0.1', true],
    ['127.5.5.5:3080', true],
    ['localhost:3080', true],
    ['localhost', true],
    ['[::1]:3080', true],
    ['evil.example:3080', false],
    ['127.0.0.1.evil.com', false],
    ['127.0.0.1.evil.com:3080', false],
    ['10.0.0.7:3080', false],
    ['', false],
  ]
  for (const [host, expected] of cases) {
    assert.equal(
      isTrustedRequest(makeReq({ headers: { host } })),
      expected,
      `Host=${JSON.stringify(host)} 期望 ${expected}`,
    )
  }
})

test('缺少 Host 头不可信', () => {
  assert.equal(isTrustedRequest(makeReq({ headers: {} })), false)
  assert.equal(isTrustedRequest(makeReq({ headers: { 'sec-fetch-site': 'same-origin' } })), false)
})

// ——————————————————————————————————————————————
// Origin
// ——————————————————————————————————————————————

test('Origin 缺失可接受；带则必须与 Host 同源', () => {
  const cases = [
    [undefined, true],
    ['http://127.0.0.1:3080', true],
    // Host 是 127.0.0.1:3080，Origin 写成 localhost:3080 属于不同 authority。
    ['http://localhost:3080', false],
    ['http://evil.example', false],
    ['http://127.0.0.1:9999', false],
    ['http://127.0.0.1.evil.com:3080', false],
    ['null', false],
    ['', false],
  ]
  for (const [origin, expected] of cases) {
    const headers = origin === undefined ? { ...TRUSTED_HOST } : { ...TRUSTED_HOST, origin }
    assert.equal(
      isTrustedRequest(makeReq({ headers })),
      expected,
      `Origin=${JSON.stringify(origin)} 期望 ${expected}`,
    )
  }
})

test('Origin 与 Host 端口不同 / 协议不同均不同源', () => {
  assert.equal(isTrustedRequest(makeReq({ headers: { ...TRUSTED_HOST, origin: 'http://127.0.0.1' } })), false)
  // 同 authority、仅协议不同：契约按 origin.host === host.host 判定，仍可信。
  assert.equal(isTrustedRequest(makeReq({ headers: { ...TRUSTED_HOST, origin: 'https://127.0.0.1:3080' } })), true)
  // Host 与 Origin 都用 localhost 时是同源。
  assert.equal(
    isTrustedRequest(makeReq({ headers: { host: 'localhost:3080', origin: 'http://localhost:3080' } })),
    true,
  )
})

// ——————————————————————————————————————————————
// sec-fetch-site
// ——————————————————————————————————————————————

test('sec-fetch-site: cross-site 拒绝；same-origin / same-site / none 不因它而拒绝', () => {
  const crossSite = { ...TRUSTED_HOST, 'sec-fetch-site': 'cross-site' }
  assert.equal(isTrustedRequest(makeReq({ headers: crossSite })), false)
  const upper = { ...TRUSTED_HOST, 'sec-fetch-site': 'CROSS-SITE' }
  assert.equal(isTrustedRequest(makeReq({ headers: upper })), false, '大小写不应绕过')

  for (const site of ['same-origin', 'same-site', 'none']) {
    const headers = { ...TRUSTED_HOST, 'sec-fetch-site': site }
    assert.equal(isTrustedRequest(makeReq({ headers })), true, `sec-fetch-site=${site} 不应被拒`)
  }
})

// ——————————————————————————————————————————————
// 畸形输入
// ——————————————————————————————————————————————

test('null / undefined / 空对象等畸形请求一律不可信', () => {
  assert.equal(isTrustedRequest(undefined), false)
  assert.equal(isTrustedRequest(null), false)
  assert.equal(isTrustedRequest({}), false)
  assert.equal(isTrustedRequest({ headers: { host: '127.0.0.1:3080' }, socket: { remoteAddress: '127.0.0.1' } }), true)
})
