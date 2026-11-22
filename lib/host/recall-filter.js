/**
 * 记忆召回筛选器的**宿主层**：调模型、超时控制、结果缓存、降级判定。
 *
 * 为什么单独成模块：`core/` 是纯函数层，不碰磁盘、宿主与网络；调 LLM、超时、缓存这三件事
 * 都有状态且可能失败，放进去会污染它的可测性（`core/recall-select.js` 只负责拼提示词与
 * 解析输出，恰好就是那条边界）。塞进 `inject.js` 更糟——那里已背着快照注入的全部时序判据，
 * 再叠一层模型调用，任何改动都要在「注入对不对」与「筛选对不对」之间反复确认。
 *
 * 缓存必须**跨轮常驻**：实例在 `installInjection` 里建一次，每轮重建等于命中率恒为 0。
 *
 * 降级策略（设计文档 §7）：pre-step 是阻塞的，筛选器在这里是旁路。任何异常——超时、网络
 * 错误、输出乱码、id 全是幻觉——都必须变成「回退字面检索」这个返回值，绝不抛出。反过来，
 * 模型明确说「都不相关」（`NONE`）是**有效结论**，必须原样透出（`ids: []` + `source: 'model'`）；
 * 若降级成字面检索，等于用噪音推翻模型唯一一次正确判断。两类空结果语义相反，所以
 * `source` 与 `reason` 必须能自证是哪一种。
 *
 * 硬约束：不 import 任何 `@deepseek-ai/*` 宿主包，`llm` 一律经 `ctx.get('llm')` 可选获取。
 *
 * @module dsh-supermemory/host/recall-filter
 */

import { createHash } from 'node:crypto'

import {
  DEFAULT_MAX_PICK,
  SELECT_SYSTEM_PROMPT,
  buildSelectPrompt,
  parseSelectOutput,
} from '../core/recall-select.js'

/** 缓存容量与超时的缺省值（与 `config` 里同名键的默认值一致）。 */
const DEFAULT_CACHE_SIZE = 32
/**
 * 缺省超时。与 `config.recallFilterTimeoutMs` 的默认值保持一致（30000）。
 *
 * 30 秒而不是 5 秒：筛选器是旁路优化，误判超时的代价是整轮降级字面检索、召回直接失效；
 * 而多等几秒只是慢一点。宁可多等，也不要白降级。
 */
const DEFAULT_TIMEOUT_MS = 30000

/**
 * 输出 token 预算。给足 2000 而不是「够用就好」：推理模型的思考 tokens 与正文共享这份
 * 预算，给小了会「思考没写完就被截断、正文一个字都没产出」，表现为筛选器每轮都判空降级，
 * 日志里只剩一句「输出为空」——`digest.js` 的 finish reason 'length' 处理是同一个坑。
 */
const MAX_OUTPUT_TOKENS = 2000

/**
 * 安全获取一个可选宿主服务。与 `digest.js` 同一口径：`ctx.get` 在服务不存在时返回
 * undefined，但某些实现会抛错，统一吞掉——宿主服务缺失必须静默降级。
 *
 * @param {object} ctx - cordis Context。
 * @param {string} name - 服务名。
 * @returns {unknown} 服务实例或 undefined。
 */
function optionalService(ctx, name) {
  try {
    return ctx?.get?.(name)
  } catch {
    return undefined
  }
}

/**
 * 判断一条路由是否「provider 与 model 同时非空」。只给了一半的路由拿去调必然失败，不如让
 * 下一层接手；也不跨层拼装——拼出来的组合不存在，失败信息会误导排查方向。
 *
 * @param {unknown} route - 候选路由。
 * @returns {{ provider: string, model: string }|undefined} 合法路由。
 */
function completeRoute(route) {
  if (route === null || typeof route !== 'object') return undefined
  const provider = typeof route.provider === 'string' ? route.provider.trim() : ''
  const model = typeof route.model === 'string' ? route.model.trim() : ''
  if (provider === '' || model === '') return undefined
  return { provider, model }
}

/**
 * 取条目正文：优先 `body`，其次 `text`（候选池两种来源各用其一）。
 * @param {object} entry - 条目。
 * @returns {string} 正文（未转义）。
 */
function entryBody(entry) {
  if (typeof entry?.body === 'string') return entry.body
  return typeof entry?.text === 'string' ? entry.text : ''
}

/**
 * 算候选条目指纹：按 id 排序后把 `id:正文` 逐条拼接。**必须含正文**——只用 id 列表的话，
 * 条目内容被整编改写、id 却没变时，缓存会继续返回同一批 id 而正文已是旧的，表现为
 * 「记忆更新了但模型一直看到旧内容」，无任何报错。
 *
 * @param {Array<{ id?: string, body?: string, text?: string }>} entries - 候选池。
 * @returns {string} 指纹文本。
 */
function fingerprintOf(entries) {
  const rows = []
  for (const entry of entries) {
    const id = typeof entry?.id === 'string' ? entry.id : ''
    // 没有 id 的条目不会被模型选中（`buildSelectPrompt` 也会跳过），不进指纹。
    if (id === '') continue
    rows.push({ id, text: `${id}:${entryBody(entry)}` })
  }
  rows.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  return rows.map((row) => row.text).join('\n')
}

/**
 * 归一化「最多选几条」：非有限值或非正数回落到缺省值。
 * @param {unknown} value - 调用方传入的上限。
 * @returns {number} 正整数上限。
 */
function normalizeMaxPick(value) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_MAX_PICK
}

/**
 * 归一化超时毫秒数。`AbortSignal.timeout` 要求非负整数；0 会让每次调用立即超时（筛选器
 * 永远不工作，且表现为「每轮都降级」这种不报错的哑故障），所以非正数回落默认值。
 * @param {unknown} value - 配置值。
 * @returns {number} 正整数毫秒。
 */
function normalizeTimeout(value) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_TIMEOUT_MS
}

/**
 * 归一化缓存容量。0 是**合法值**（不缓存），负数是非法值（回落默认）——两者必须分开，
 * 把 0 也当非法会让「关掉缓存」这个配置项永远不生效。
 * @param {unknown} value - 配置值。
 * @returns {number} 非负整数容量。
 */
function normalizeCapacity(value) {
  if (!Number.isFinite(value)) return DEFAULT_CACHE_SIZE
  return value > 0 ? Math.floor(value) : 0
}

/**
 * 创建召回筛选器。
 *
 * @param {object} ctx - cordis Context。
 * @param {object} deps - 装配层依赖。
 * @param {{ warn?: Function, info?: Function }} [deps.logger] - 日志。
 * @param {() => object} [deps.getConfig] - 读取最新配置（`options.config` 缺失时的回退）。
 * @param {{ readSettings?: () => object }} [deps.store] - 存储层；只用它的**同步**
 *   `readSettings()` 读面板配置的路由（v19 路由第 1 层）。
 * @returns {{ select: Function, dispose: () => void, stats: () => object|null }}
 *   `select` 绝不抛错；`dispose` 同步、不抛；`stats` 返回最近一次筛选证据的副本（没跑过为 null）。
 */
export function createRecallFilter(ctx, deps) {
  const logger = deps?.logger ?? { warn() {}, info() {} }

  /**
   * 缓存：key → `{ ids, rejected }`。用 `Map` 而不是普通对象：Map 的迭代序就是插入序，
   * LRU 只需「命中时删了再插到末尾、超容量时删第一个键」两步，不需要额外维护链表。
   */
  const cache = new Map()

  /** 最近一次筛选的耗时证据（v19，面板据此提示「所选模型是否太慢」）。 */
  let lastRun = null

  /**
   * 取本次调用要用的配置：优先调用方传入的已解析配置（`composeSnapshot` 手里就有一份），
   * 其次问装配层，最后回落空对象。**不在这里再调 `resolveConfig`**：那会把已解析值重新过
   * 一遍归一化（例如把测试里刻意设的小超时钳到下限），也让配置解析出现第二个入口。
   *
   * @param {unknown} passed - `options.config`。
   * @returns {object} 配置对象（可能缺键，消费处各自兜底）。
   */
  function configOf(passed) {
    if (passed !== null && typeof passed === 'object') return passed
    try {
      const value = deps?.getConfig?.()
      return value !== null && typeof value === 'object' ? value : {}
    } catch (error) {
      logger.warn?.('supermemory: recallFilter getConfig failed: %o', error)
      return {}
    }
  }

  /**
   * 读面板设置的召回筛选器路由（v19 第 1 层）。
   *
   * 必须**同步**读：`select` 在 pre-step 的阻塞路径上，而 `store.readSettings()` 只读
   * 构造期已加载的进程内内存态，不碰磁盘，正是同步 API。任何异常都按「没有设置」处理——
   * 设置读不出来只该让路由降一层，不该让本轮筛选整轮降级。
   *
   * @returns {{ provider: unknown, model: unknown }} 两个原始值（可能都缺）。
   */
  function settingsRoute() {
    try {
      const settings = deps?.store?.readSettings?.()
      if (settings === null || typeof settings !== 'object') return { provider: undefined, model: undefined }
      return { provider: settings.recallFilterProvider, model: settings.recallFilterModel }
    } catch (error) {
      logger.warn?.('supermemory: recallFilter readSettings failed: %o', error)
      return { provider: undefined, model: undefined }
    }
  }

  /**
   * 解析筛选使用的 provider/model。**全局统一，不跟随会话**（v19）。
   *
   * 三层优先级：
   *   1. settings.json（面板选的，用户可见可改）
   *   2. config.recallFilterProvider/Model（cordis.patch.yml 的运维配置）
   *   3. 宿主默认模型（全局的，不是会话级的）
   *
   * 刻意**不做**「当前会话路由」那一层：召回筛选每轮都跑且阻塞 pre-step，
   * 让它的模型随会话漂移会让同一份记忆在不同会话里被不同模型筛选，
   * 行为无法复现、也无法解释。整理器保留会话路由是因为它低频且可异步。
   *
   * @param {object} config - 已解析配置。
   * @returns {Promise<{ provider: string, model: string }|undefined>} 路由。
   */
  async function resolveRoute(config) {
    const fromSettings = completeRoute(settingsRoute())
    if (fromSettings !== undefined) return fromSettings

    const fromConfig = completeRoute({ provider: config.recallFilterProvider, model: config.recallFilterModel })
    if (fromConfig !== undefined) return fromConfig

    try {
      const selection = await optionalService(ctx, 'agentDefaultModel')?.currentSelection?.()
      const fromDefault = completeRoute(selection)
      if (fromDefault !== undefined) return fromDefault
    } catch (error) {
      logger.warn?.('supermemory: recallFilter agentDefaultModel failed: %o', error)
    }
    return undefined
  }

  /** 读缓存（LRU：命中即移到末尾）。@param {string} key @returns {object|undefined} */
  function cacheGet(key) {
    if (!cache.has(key)) return undefined
    const value = cache.get(key)
    cache.delete(key)
    cache.set(key, value)
    return value
  }

  /**
   * 写缓存并淘汰最久未用的键。`capacity` 为 0 表示不缓存。
   * @param {string} key - 缓存键。
   * @param {{ ids: string[], rejected: string[] }} value - 只存成功结论。
   * @param {number} capacity - 容量。
   */
  function cacheSet(key, value, capacity) {
    if (capacity <= 0) return
    cache.set(key, value)
    while (cache.size > capacity) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      cache.delete(oldest)
    }
  }

  /**
   * 算缓存键：`sha1(query + '\n' + 条目指纹 + '\n' + maxPick)`。`maxPick` 也进 key——它是
   * 配置项，改了之后若仍命中旧缓存会拿到比新上限更多的 id，筛选器看起来「不听配置」。
   *
   * @param {unknown} query - 本轮用户原话。
   * @param {Array<object>} entries - 候选池。
   * @param {number} maxPick - 最多选几条。
   * @returns {string} 缓存键。
   */
  function cacheKey(query, entries, maxPick) {
    const payload = `${typeof query === 'string' ? query : ''}\n${fingerprintOf(entries)}\n${maxPick}`
    return createHash('sha1').update(payload, 'utf8').digest('hex')
  }

  /**
   * 调一次模型，把流收成文本。超时用 `AbortSignal.timeout`：到点后流会以异常或 `finish`
   * 的 `aborted` 收尾，两种形态都要认，否则「超时」会被归成「网络错误」，排查时找错方向。
   *
   * @param {object} params - 调用参数（llm / route / query / entries / maxPick / timeoutMs）。
   * @returns {Promise<{ text: string, failure?: string }>} 文本；`failure` 为降级原因
   *   （`timeout` / `error` / `bad-format`），缺省表示调用本身成功。
   */
  async function callModel(params) {
    const signal = AbortSignal.timeout(params.timeoutMs)
    let text = ''
    let failure
    try {
      const stream = params.llm.stream({
        provider: params.route.provider,
        model: params.route.model,
        system: SELECT_SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: [{
            type: 'text',
            text: buildSelectPrompt({ query: params.query, entries: params.entries, maxPick: params.maxPick }),
          }],
        }],
        // 温度 0：筛选要的是确定性结论，同一问题两次给出不同集合只会让快照抖动。
        temperature: 0,
        maxTokens: MAX_OUTPUT_TOKENS,
        signal,
      })
      for await (const chunk of stream) {
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
          text += chunk.text
        } else if (chunk?.type === 'finish') {
          const kind = chunk.reason?.kind
          if (kind === 'error' || kind === 'aborted') {
            failure = signal.aborted ? 'timeout' : 'error'
          } else if (kind === 'length') {
            if (text === '') {
              // 推理模型常见死法：输出预算全花在思考上，正文一个字都没有。不写清楚的话
              // 下游只能看到「输出不可信」，没人会想到其实是 maxTokens 给小了。
              logger.warn?.(
                'supermemory: 召回筛选输出被 maxTokens 截断（正文为空、思考未写完）：'
                + '请调大本插件调用的输出预算或关闭模型思考模式',
              )
              failure = 'bad-format'
            } else {
              logger.warn?.('supermemory: 召回筛选输出以 finish_reason=length 收尾，结果可能被截断')
            }
          }
          break
        }
      }
    } catch (error) {
      if (signal.aborted) {
        failure = 'timeout'
      } else {
        logger.warn?.('supermemory: 召回筛选调模型失败: %o', error)
        failure = 'error'
      }
    }
    // 流正常结束但信号已中止：模型侧可能没报 aborted，以 signal 为准。
    if (failure === undefined && signal.aborted) failure = 'timeout'
    return failure === undefined ? { text } : { text, failure }
  }

  /**
   * 跑一轮筛选，只负责算出结果，不记录证据（由 `select` 统一记录）。
   *
   * @param {string} query - 本轮用户原话。
   * @param {Array<object>} list - 候选条目池（已归一化为数组）。
   * @param {object} options - 选项。
   * @param {number} started - 起始时间戳（由 `select` 传入，保证 `ms` 覆盖整个调用）。
   * @returns {Promise<object>} 结果（见 `select` 的返回值说明）。
   */
  async function run(query, list, options, started) {
    const config = configOf(options?.config)

    // 1) 开关。关闭时按 fallback 返回：调用方据此走字面检索，与改动前逐字一致。
    //    这里**不能**返回 `source: 'model'` + 空 ids——那会被当成「模型判空」，
    //    把预取整段清空，等于关掉筛选器反而让记忆消失。
    if (config.recallFilterEnabled === false) {
      return { ids: [], source: 'fallback', ms: 0, reason: 'disabled' }
    }

    // 2) 空池：没有候选就是没有，不需要问模型，也不该降级（降级也没东西可检索）。
    if (list.length === 0) return { ids: [], source: 'model', ms: 0 }

    const maxPick = normalizeMaxPick(options?.maxPick)
    const capacity = normalizeCapacity(config.recallFilterCacheSize)
    const key = cacheKey(query, list, maxPick)

    // 3) 缓存
    const cached = cacheGet(key)
    if (cached !== undefined) {
      return { ids: cached.ids.slice(), source: 'cache', ms: 0, rejected: cached.rejected.slice() }
    }

    // 4) 路由（v19：全局统一，不跟随会话）
    const route = await resolveRoute(config)
    if (route === undefined) {
      return { ids: [], source: 'fallback', ms: Date.now() - started, reason: 'no-route' }
    }

    // 5) 调模型
    const llm = optionalService(ctx, 'llm')
    if (llm === undefined || llm === null || typeof llm.stream !== 'function') {
      return { ids: [], source: 'fallback', ms: Date.now() - started, reason: 'no-llm' }
    }
    const outcome = await callModel({
      llm,
      route,
      query,
      entries: list,
      maxPick,
      timeoutMs: normalizeTimeout(config.recallFilterTimeoutMs),
    })
    if (outcome.failure !== undefined) {
      return { ids: [], source: 'fallback', ms: Date.now() - started, reason: outcome.failure }
    }

    // 6) 解析与降级判定（本模块最关键的一步）
    const parsed = parseSelectOutput({ text: outcome.text, entries: list, maxPick })
    if (parsed.none === true) {
      // 模型明确说「都不相关」：有效结论，注入 0 条，**不回退**。
      cacheSet(key, { ids: [], rejected: parsed.rejected }, capacity)
      return { ids: [], source: 'model', ms: Date.now() - started, rejected: parsed.rejected }
    }
    // 没给出可信结论（空 / 乱码 / 全是幻觉 id）：降级字面检索。全幻觉也走这条——
    // `parseSelectOutput` 已经把不存在的 id 过滤成空数组了。
    if (parsed.ids.length === 0) {
      return { ids: [], source: 'fallback', ms: Date.now() - started, reason: 'bad-format' }
    }
    // 7) 只缓存成功结论（含 `NONE` 空结果——那也是结论，同样的问题不必再问）。
    cacheSet(key, { ids: parsed.ids, rejected: parsed.rejected }, capacity)
    return { ids: parsed.ids, source: 'model', ms: Date.now() - started, rejected: parsed.rejected }
  }

  /**
   * 从候选池里挑出本轮该注入的条目 id。`source` 决定调用方走哪条路：`model` / `cache` →
   * 按 `ids` 注入（为空表示模型明确判空，**不回退**）；`fallback` → 回退字面检索。
   *
   * v19：每次返回（**含全部降级路径**）都记一份 `lastRun` 供 `stats()` 读——面板靠它提示
   * 「所选模型是否太慢 / 是不是一直在降级」。记录点收在唯一出口，新增返回分支不会漏记。
   *
   * @param {string} query - 本轮用户原话。
   * @param {Array<{ id?: string, topic?: string, body?: string, tier?: string }>} entries
   *   候选条目池（已由调用方按分层判据过滤好）。
   * @param {object} [options] - 选项。
   * @param {number} [options.maxPick] - 最多选几条（缺省 8）。
   * @param {object} [options.config] - 已解析配置（缺省问 `deps.getConfig`）。
   * @param {unknown} [options.agent] - 宿主 Agent。**形参保留但已不使用**（v19 全局统一）：
   *   调用方 `inject.js` 仍在传，保留字段只是为了不改调用面，路由不再跟随会话。
   * @returns {Promise<{ ids: string[], source: 'model'|'cache'|'fallback', ms: number, reason?: string, rejected?: string[] }>}
   *   `ids` 按模型给出的顺序（顺序即重要性）；`reason` 只在 `fallback` 时出现。
   */
  async function select(query, entries, options = {}) {
    const started = Date.now()
    const list = Array.isArray(entries) ? entries : []
    let result
    try {
      result = await run(query, list, options, started)
    } catch (error) {
      // 8) 兜底：pre-step 绝不能被筛选器搞崩。
      logger.warn?.('supermemory: 召回筛选异常，本轮降级字面检索: %o', error)
      result = { ids: [], source: 'fallback', ms: Date.now() - started, reason: 'error' }
    }
    // 证据与返回值同源：`picked` 直接取最终 ids 的长度，降级时就是 0（用户能看出降级了）。
    lastRun = {
      source: result.source,
      ms: result.ms,
      picked: result.ids.length,
      at: Date.now(),
      ...(result.reason === undefined ? {} : { reason: result.reason }),
    }
    return result
  }

  /**
   * 最近一次筛选的耗时证据（v19，面板据此提示「所选模型是否太慢」）。
   *
   * 内存态，进程重启后为 null——面板显示「暂无数据」，不要伪造。
   * 返回副本：调用方改它不该影响下一轮。
   *
   * @returns {{ source: string, ms: number, picked: number, at: number, reason?: string }|null}
   *   没跑过时为 null。
   */
  function stats() {
    return lastRun === null ? null : { ...lastRun }
  }

  /** 清空缓存。必须同步且不抛——它挂在插件卸载路径上。 */
  function dispose() {
    try { cache.clear() } catch { /* 清理失败不影响卸载 */ }
  }

  return { select, dispose, stats }
}
