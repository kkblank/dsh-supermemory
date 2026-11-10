/**
 * dsh-supermemory HTTP 层的读写小工具。
 *
 * 从 lib/host/routes.js 拆出：只管「怎么把请求读进来、怎么把响应写出去」，
 * 不含任何业务判断——store / deps / ctx 一概不碰，所以 routes.js、routes-digest.js、
 * routes-settings.js 三条业务线能共用同一套响应格式
 * （契约 §5.5：`{ ok: true, data }` / `{ ok: false, error, code? }`）。
 *
 * guard 是信任栅栏与响应写出的唯一交汇点：判定本身在 trust.js，
 * 这里只负责「不过就 403」。
 *
 * @module dsh-supermemory/host/http
 */

import { header, isTrustedRequest } from './trust.js'

/** 请求体上限 1 MiB。 */
const MAX_BODY_BYTES = 1024 * 1024

/**
 * 写一个 JSON 响应。
 * @param {object} res - ServerResponse 或 mock。
 * @param {number} status - HTTP 状态码。
 * @param {object} payload - JSON 体。
 * @returns {void}
 */
export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  try {
    if (typeof res.writeHead === 'function') res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    else res.statusCode = status
  } catch {
    /* mock 可能只实现 end */
  }
  try {
    res.end?.(body)
  } catch {
    /* 连接已断开，忽略 */
  }
}

/** 统一失败响应。 */
export function sendError(res, status, error, code) {
  const payload = { ok: false, error }
  if (code !== undefined) payload.code = code
  sendJson(res, status, payload)
}

/** 统一成功响应。 */
export function sendOk(res, data) {
  sendJson(res, 200, { ok: true, data })
}

/**
 * 信任栅栏包装：不合规立即 403 并返回 false。
 * @param {object} req - 请求。
 * @param {object} res - 响应。
 * @returns {boolean} 是否继续处理。
 */
export function guard(req, res) {
  if (isTrustedRequest(req)) return true
  sendError(res, 403, 'forbidden')
  return false
}

/**
 * 读请求体（上限 1 MiB）。
 * @param {object} req - 请求。
 * @returns {Promise<{ok:true, text:string}|{ok:false, code:'TOO_LARGE'|'READ_FAILED', error:string}>} 结果。
 */
async function readBody(req) {
  const declared = Number(header(req, 'content-length'))
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { ok: false, code: 'TOO_LARGE', error: 'request body too large' }
  }
  const chunks = []
  let total = 0
  try {
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      total += buffer.length
      if (total > MAX_BODY_BYTES) return { ok: false, code: 'TOO_LARGE', error: 'request body too large' }
      chunks.push(buffer)
    }
  } catch (error) {
    return { ok: false, code: 'READ_FAILED', error: error instanceof Error ? error.message : String(error) }
  }
  return { ok: true, text: Buffer.concat(chunks).toString('utf8') }
}

/**
 * 读 JSON 请求体。
 * @param {object} req - 请求。
 * @param {object} res - 响应。
 * @returns {Promise<object|undefined>} 解析后的对象；已直接响应错误时返回 undefined。
 */
export async function readJsonBody(req, res) {
  const body = await readBody(req)
  if (body.ok !== true) {
    if (body.code === 'TOO_LARGE') sendError(res, 413, 'request body too large', 'TOO_LARGE')
    else sendError(res, 400, body.error, 'BAD_REQUEST')
    return undefined
  }
  if (body.text.trim() === '') return {}
  let parsed
  try {
    parsed = JSON.parse(body.text)
  } catch {
    sendError(res, 400, 'invalid JSON body', 'BAD_JSON')
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    sendError(res, 400, 'body must be a JSON object', 'BAD_INPUT')
    return undefined
  }
  return parsed
}

/**
 * 解析查询字符串（基于 req.url）。
 * @param {object} req - 请求。
 * @returns {URLSearchParams} 查询参数。
 */
export function queryOf(req) {
  const raw = typeof req?.url === 'string' ? req.url : '/'
  try {
    return new URL(raw, 'http://localhost').searchParams
  } catch {
    return new URLSearchParams()
  }
}

/**
 * 取一个参数：优先新名，回退旧名（v2 的 `persona` 兼容 v1 的 `presetId`）。
 * @param {URLSearchParams|object} source - 查询串或普通对象。
 * @param {string} primary - 新字段名。
 * @param {string} legacy - 旧字段名。
 * @returns {string|undefined} 非空字符串值。
 */
export function paramOf(source, primary, legacy) {
  const read = (name) => {
    const value = typeof source?.get === 'function' ? source.get(name) : source?.[name]
    return typeof value === 'string' && value.trim() !== '' ? value : undefined
  }
  return read(primary) ?? read(legacy)
}
