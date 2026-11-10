/**
 * dsh-supermemory 信任栅栏（loopback / DNS rebinding / Fetch Metadata）。
 *
 * 从 lib/host/routes.js 拆出：这里只回答「这个请求能不能受理」一个问题，
 * 全部是纯函数——不读 store、不写响应、不依赖装配层 deps，所以能被 http.js 的
 * guard 与 routes.js 的 re-export 复用同一份判定，避免两处规则漂移。
 *
 * 判定顺序与原实现完全一致（契约 §5.5）：socket 回环 → 反向代理标记 →
 * Host authority → sec-fetch-site → Origin 同源，任何一步不过即不可信。
 *
 * routes.js 会 re-export isTrustedRequest，测试与外部调用方仍从原路径导入。
 *
 * @module dsh-supermemory/host/trust
 */

/**
 * 读取请求头（小写键，兼容 Node 的 headers 对象）。
 * @param {object} req - IncomingMessage 或 mock。
 * @param {string} name - 头名。
 * @returns {string|undefined} 头值。
 */
export function header(req, name) {
  const headers = req?.headers
  if (headers === undefined || headers === null) return undefined
  const value = headers[name]
  if (Array.isArray(value)) return value.length === 0 ? undefined : String(value[0])
  if (value === undefined || value === null) return undefined
  return String(value)
}

/**
 * 判断一个 hostname 是否是 loopback（127/8、::1、localhost、IPv4-mapped 回环）。
 * @param {string} hostname - 不带端口与方括号的 host。
 * @returns {boolean} 是否 loopback。
 */
function isLoopbackHostname(hostname) {
  if (typeof hostname !== 'string' || hostname === '') return false
  const name = hostname.toLowerCase()
  if (name === 'localhost') return true
  if (name === '::1') return true
  if (name === '::ffff:7f00:1') return true
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/u.exec(name)
  if (mapped !== null) return isLoopbackHostname(mapped[1])
  const parts = name.split('.')
  if (parts.length !== 4 || parts[0] !== '127') return false
  return parts.every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255)
}

/**
 * 判断 socket 远端地址是否是 loopback。
 * @param {string|undefined} address - `req.socket.remoteAddress`。
 * @returns {boolean} 是否 loopback。
 */
function isLoopbackAddress(address) {
  if (typeof address !== 'string' || address === '') return false
  const value = address.toLowerCase()
  if (value === '::1' || value === '::ffff:7f00:1') return true
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/u.exec(value)
  if (mapped !== null) return isLoopbackHostname(mapped[1])
  return isLoopbackHostname(value)
}

/**
 * 解析 Host / Origin 的 authority。
 * @param {string} value - 头值。
 * @param {string} [scheme] - 默认协议。
 * @returns {{host:string, hostname:string, protocol:string}|undefined} 解析结果。
 */
function parseAuthority(value, scheme = 'http:') {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const text = value.trim()
  try {
    // Origin 是完整 URL（带 scheme://），Host 是裸 authority；两种都接受。
    const url = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(text) ? new URL(text) : new URL(`${scheme}//${text}`)
    if (url.hostname === '' || url.host === '') return undefined
    return { host: url.host, hostname: url.hostname.replace(/^\[|\]$/gu, ''), protocol: url.protocol }
  } catch {
    return undefined
  }
}

/**
 * 信任栅栏：非 loopback 或带浏览器代理标记或跨源，一律拒绝。
 *
 * 导出以便测试直接断言信任矩阵（契约 §10 要求）；纯函数，无副作用。
 * @param {object} req - IncomingMessage 或 mock。
 * @returns {boolean} 是否可信。
 */
export function isTrustedRequest(req) {
  if (req === undefined || req === null) return false

  // 1) socket 必须是回环。
  if (!isLoopbackAddress(req.socket?.remoteAddress)) return false

  // 2) 任何反向代理标记都视为不可信（本地同源请求不会带）。
  if (header(req, 'cf-connecting-ip') !== undefined) return false
  if (header(req, 'x-forwarded-for') !== undefined) return false
  if (header(req, 'x-real-ip') !== undefined) return false
  if (header(req, 'forwarded') !== undefined) return false

  // 3) Host 必须是回环 authority（防 DNS rebinding）。
  const hostHeader = header(req, 'host')
  const host = parseAuthority(hostHeader)
  if (host === undefined || !isLoopbackHostname(host.hostname)) return false

  // 4) Fetch Metadata 明确跨站 → 拒绝。
  const site = header(req, 'sec-fetch-site')
  if (typeof site === 'string' && site.toLowerCase() === 'cross-site') return false

  // 5) Origin 缺失可接受（同源读请求不带）；带则必须与 Host 同源。
  const origin = header(req, 'origin')
  if (origin !== undefined) {
    const parsed = parseAuthority(origin)
    if (parsed === undefined || parsed.host !== host.host) return false
  }
  return true
}
