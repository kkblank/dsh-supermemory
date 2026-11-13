/**
 * dsh-supermemory 配置 schema 与解析。
 *
 * 本文件是全插件**唯一**允许 `import '@deepseek-ai/schemastery'` 的位置（见契约 §0.1）。
 * 其它模块只从本文件导入 `Config` / `resolveConfig` / `resolvePresetsRoot`。
 *
 * v2：记忆隔离单位改为「人设」，配置字段 `presetsRoot` 改名 `personasRoot`
 * （默认空 → `$DSH_HOME/supermemory/personas`）；`presetsRoot` 作为废弃别名仍接受。
 *
 * v4：新增整编模式（consolidate）的 6 个配置项（契约 §V4.0.4）。它们只从配置文件读，
 * 面板与 `settings.json` 都不提供——既有的 `enabled` / `digestProvider` / `digestModel`
 * 是面板可写的用户设置，两套键互不影响。
 *
 * @module dsh-supermemory/host/config
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

import z from '@deepseek-ai/schemastery'

/**
 * 契约 §2 / §V2.2 的字段表。全部 `.volatile()`，以便设置页热更新时读到最新值。
 * 注意：schemastery 不允许 volatile 字段嵌套在 volatile 字段内；本 schema 是扁平结构。
 *
 * `presetsRoot` 仅为兼容 v1 配置保留；新配置请用 `personasRoot`。
 */
export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  personasRoot: z.string().default('').volatile(),
  /** @deprecated v2 起改用 `personasRoot`；仍接受。 */
  presetsRoot: z.string().default('').volatile(),
  projectDirName: z.string().default('.dsh/memory').volatile(),
  projectFileName: z.string().default('project-memory.md').volatile(),
  systemPromptMaxBytes: z.number().default(12000).volatile(),
  injectMaxBytes: z.number().default(24000).volatile(),
  autoDigest: z.boolean().default(true).volatile(),
  digestEveryTurns: z.number().default(5).volatile(),
  digestPressureRatio: z.number().default(0.75).volatile(),
  digestMaxInputBytes: z.number().default(120000).volatile(),
  digestMaxOutputTokens: z.number().default(3000).volatile(),
  /** 自动整理允许写入的 scope（v2 默认只有 project）。 */
  digestWritableScopes: z.array(z.string()).default(['project']).volatile(),
  digestProvider: z.string().default('').volatile(),
  digestModel: z.string().default('').volatile(),
  /**
   * 子智能体是否注入记忆快照。默认 **false**：子智能体只做一件小事，
   * 不必每轮都背着主人格与长期记忆（与压缩补偿同属「注入范围最小化」策略）。
   * 需要子智能体带记忆时显式配 true。
   */
  injectIntoSubagents: z.boolean().default(false).volatile(),
  /**
   * 上下文压缩后的快照自愈与补偿重写。默认 true。
   * 详见 `lib/host/inject.js` 的压缩补偿说明；置 false 退回「仅内容变化才重写」。
   */
  compactionRecall: z.boolean().default(true).volatile(),
  // ——— 整理器整编模式（契约 §V4.0.4）———
  // 这 6 项刻意**不进 settings.json / 面板**：整编会重写整份 project 记忆，
  // 阈值属于运维旋钮而非用户偏好，只从 cordis.patch.yml 读。
  /** 整编模式总开关。 */
  digestConsolidate: z.boolean().default(true).volatile(),
  /** 触发整编的条目数阈值。 */
  digestConsolidateMinEntries: z.number().default(20).volatile(),
  /** 触发整编的体积阈值（字节）。 */
  digestConsolidateMinBytes: z.number().default(12288).volatile(),
  /** 两次整编的最小间隔（毫秒，默认 6 小时）。 */
  digestConsolidateCooldownMs: z.number().default(21600000).volatile(),
  /**
   * 整编调用的输出 token 上限（整篇重写比追加吃输出）。
   *
   * 默认值按「本地推理模型必须按 reasoning tokens 计」推出来，别按正文长度估：
   * 实测两键整编正文 ≈1683 字节（约 400~600 token），而 reasoning 就要 ≈5942 token，
   * 合计 ≈6.4k——**三键之前 6000 就已经被吃穿**，症状正是 pitfalls §5 记的
   * 「正文写完了却因 `finish_reason=length` 拒绝落盘」。三键的主题表最坏约 24 条
   * ×72 字 ≈ 1.2~1.7k token，合计 ≈8.2k，故取 12000 留约 1.45× 余量。
   */
  digestConsolidateMaxOutputTokens: z.number().default(12000).volatile(),
  /** 落盘前快照保留份数。 */
  digestSnapshotKeep: z.number().default(3).volatile(),
  // ——— 整编分批降精（契约 §V11.0.3）———
  // 同性质：运维旋钮，只从 cordis.patch.yml 读，不进 settings.json / 面板。
  //
  // 为什么需要分档：整编一次要重述整份 project 记忆，思考量与**待重述规模成正比**。
  // 实测 32 条 / 12KB 时 reasoning 已吃掉约 49k tokens，把 16000（当时值）吃穿、
  // 正文零产出；靠调大输出预算只是把悬崖往后推。分批把单轮规模钉进安全区。
  /** 分批降精总开关；false 退回 v11 之前「每次都整份重写」的行为（回滚通道）。 */
  digestTieredConsolidate: z.boolean().default(true).volatile(),
  /**
   * 进入分批的条目数阈值。
   *
   * 取 30 是有依据的：整编触发阈值是 20 条，而实测踩坑的起点是 32 条——20~29 条
   * 整份重写仍然安全，30 条起改分批，把单次规模压在已验证的安全区内。
   */
  digestTier2MinEntries: z.number().default(30).volatile(),
  /** 提高到更大的批的条目数阈值；必须严格大于 `digestTier2MinEntries`。 */
  digestTier3MinEntries: z.number().default(60).volatile(),
  /** 每批最多处理多少个主题（T2 档）。 */
  digestTier2BatchTopics: z.number().default(5).volatile(),
  /** 每批最多处理多少个主题（T3 档）。 */
  digestTier3BatchTopics: z.number().default(8).volatile(),
  // ——— 分层记忆（契约 §V8.5）———
  // 与整编阈值同性质：属于运维旋钮而非用户偏好，只从 cordis.patch.yml 读，
  // 不进 settings.json / 面板。
  /** 分层注入总开关；false 逐字退回 v7 的「全量或全索引」渲染路径（回滚通道）。 */
  tieredInjection: z.boolean().default(true).volatile(),
  /**
   * L0 core 段的常驻字节预算。默认取 `injectMaxBytes` 的约 2/3，**刻意留宽**。
   * 定太小的后果实测过：真实项目记忆 9 KB / 25 条时，8192 的预算会在总预算 24000 只用了一半
   * 的情况下就把 4 条挤进目录，目录里只剩「未分类（4条）」一行——**升级当天就净丢信息**。
   * core 段该收缩的时机是「总量逼近 injectMaxBytes」，不是「超过一个凭空的软上限」。
   */
  projectCoreMaxBytes: z.number().default(16384).volatile(),
  /** L1 主题目录段的常驻字节预算。 */
  projectIndexMaxBytes: z.number().default(3072).volatile(),
  /** 动态预取段的常驻字节预算。 */
  projectRecallMaxBytes: z.number().default(2048).volatile(),
  /** 动态预取每次最多带几条。 */
  projectRecallTopK: z.number().default(5).volatile(),
  /** 预取换血的最小间隔（轮），压住 prompt cache 抖动。 */
  projectRecallMinRounds: z.number().default(3).volatile(),
})

/** 四个记忆类别（用于过滤 digestWritableScopes）。 */
const SCOPES = Object.freeze(['soul', 'user', 'global', 'project'])

/** 解析结果的默认值（同时作为非法值的回退目标）。 */
const DEFAULTS = Object.freeze({
  enabled: true,
  personasRoot: '',
  presetsRoot: '',
  projectDirName: '.dsh/memory',
  projectFileName: 'project-memory.md',
  systemPromptMaxBytes: 12000,
  injectMaxBytes: 24000,
  autoDigest: true,
  digestEveryTurns: 5,
  digestPressureRatio: 0.75,
  digestMaxInputBytes: 120000,
  digestMaxOutputTokens: 3000,
  digestWritableScopes: Object.freeze(['project']),
  digestProvider: '',
  digestModel: '',
  injectIntoSubagents: false,
  compactionRecall: true,
  digestConsolidate: true,
  digestConsolidateMinEntries: 20,
  digestConsolidateMinBytes: 12288,
  digestConsolidateCooldownMs: 21600000,
  digestConsolidateMaxOutputTokens: 12000,
  digestSnapshotKeep: 3,
  digestTieredConsolidate: true,
  digestTier2MinEntries: 30,
  digestTier3MinEntries: 60,
  digestTier2BatchTopics: 5,
  digestTier3BatchTopics: 8,
  tieredInjection: true,
  projectCoreMaxBytes: 16384,
  projectIndexMaxBytes: 3072,
  projectRecallMaxBytes: 2048,
  projectRecallTopK: 5,
  projectRecallMinRounds: 3,
})

/**
 * 从配置来源取一个原始字段值。
 *
 * 运行时 cordis 传进来的是 `Config` 实例，每个 .volatile() 字段被包装成 `{ get() }`；
 * 单元测试里通常直接传普通对象。两种形态都要支持，且任何读取异常都回退 undefined。
 *
 * @param {unknown} source - Config 实例或普通对象。
 * @param {string} key - 字段名。
 * @returns {unknown} 原始值。
 */
function readField(source, key) {
  if (source === null || typeof source !== 'object') return undefined
  const direct = source[key]
  if (direct !== null && typeof direct === 'object' && typeof direct.get === 'function') {
    try {
      return direct.get()
    } catch {
      return undefined
    }
  }
  if (typeof direct === 'function') {
    try {
      return direct()
    } catch {
      return undefined
    }
  }
  if (direct !== undefined) return direct
  // 兜底：支持 Map 形态 / 自带 get(key) 的容器。
  if (typeof source.get === 'function') {
    try {
      return source.get(key)
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * 读取布尔字段，非布尔回退默认值。
 * @param {unknown} source - 配置来源。
 * @param {string} key - 字段名。
 * @returns {boolean} 解析值。
 */
function readBoolean(source, key) {
  const raw = readField(source, key)
  return typeof raw === 'boolean' ? raw : DEFAULTS[key]
}

/**
 * 读取字符串字段，非字符串回退默认值（空串是合法值）。
 * @param {unknown} source - 配置来源。
 * @param {string} key - 字段名。
 * @returns {string} 解析值。
 */
function readString(source, key) {
  const raw = readField(source, key)
  return typeof raw === 'string' ? raw : DEFAULTS[key]
}

/**
 * 读取数值字段：`Number.isFinite` 校验；可要求取整且不小于 0。
 * @param {unknown} source - 配置来源。
 * @param {string} key - 字段名。
 * @param {{ integer?: boolean, min?: number }} [rules] - 附加规则。
 * @returns {number} 解析值。
 */
function readNumber(source, key, rules = {}) {
  const raw = readField(source, key)
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULTS[key]
  let value = rules.integer === true ? Math.trunc(raw) : raw
  if (rules.min !== undefined && value < rules.min) value = rules.min
  return value
}

/**
 * 读取人设目录配置：优先 `personasRoot`，其次废弃别名 `presetsRoot`。
 *
 * 两者都为空/非法时返回空串，由调用方用 `resolvePresetsRoot` 补全默认目录。
 *
 * @param {unknown} source - 配置来源。
 * @returns {{ personasRoot: string, presetsRoot: string }} 两个键同值。
 */
function readPersonasRoot(source) {
  const primary = readField(source, 'personasRoot')
  const legacy = readField(source, 'presetsRoot')
  let value = ''
  if (typeof primary === 'string' && primary.trim() !== '') value = primary.trim()
  else if (typeof legacy === 'string' && legacy.trim() !== '') value = legacy.trim()
  return { personasRoot: value, presetsRoot: value }
}

/**
 * 读取自动整理的写入范围：只保留已知 scope，去重；非法/空回退 `['project']`。
 *
 * @param {unknown} source - 配置来源。
 * @returns {string[]} scope 列表（至少一项）。
 */
function readScopes(source) {
  const raw = readField(source, 'digestWritableScopes')
  if (!Array.isArray(raw)) return [...DEFAULTS.digestWritableScopes]
  const scopes = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const scope = item.trim().toLowerCase()
    if (SCOPES.includes(scope) && !scopes.includes(scope)) scopes.push(scope)
  }
  return scopes.length === 0 ? [...DEFAULTS.digestWritableScopes] : scopes
}

/**
 * 把 Config 实例（或普通对象）读成普通对象；每次调用都重新读取 volatile 字段的最新值。
 *
 * - `undefined` / `null` / 非对象 → 全默认值。
 * - 数值字段非法 → 回退默认；`digestEveryTurns` 与整编各阈值取整且不低于各自下限。
 * - `personasRoot` 为空串时**原样返回空串**，由调用方用 `resolvePresetsRoot` 补全；
 *   `presetsRoot` 作为废弃别名与 `personasRoot` 返回同一个值。
 *
 * @param {unknown} config - Config 实例或普通对象。
 * @returns {{
 *   enabled: boolean, personasRoot: string, presetsRoot: string,
 *   projectDirName: string, projectFileName: string,
 *   systemPromptMaxBytes: number, injectMaxBytes: number,
 *   autoDigest: boolean, digestEveryTurns: number, digestPressureRatio: number,
 *   digestMaxInputBytes: number, digestMaxOutputTokens: number, digestWritableScopes: string[],
 *   digestProvider: string, digestModel: string, injectIntoSubagents: boolean,
 *   compactionRecall: boolean,
 *   digestConsolidate: boolean, digestConsolidateMinEntries: number, digestConsolidateMinBytes: number,
 *   digestConsolidateCooldownMs: number, digestConsolidateMaxOutputTokens: number, digestSnapshotKeep: number,
 *   digestTieredConsolidate: boolean, digestTier2MinEntries: number, digestTier3MinEntries: number,
 *   digestTier2BatchTopics: number, digestTier3BatchTopics: number,
 *   tieredInjection: boolean, projectCoreMaxBytes: number, projectIndexMaxBytes: number,
 *   projectRecallMaxBytes: number, projectRecallTopK: number, projectRecallMinRounds: number
 * }} 普通对象形式的解析结果。
 */
export function resolveConfig(config) {
  const source = config !== null && typeof config === 'object' ? config : {}
  const root = readPersonasRoot(source)
  return {
    enabled: readBoolean(source, 'enabled'),
    personasRoot: root.personasRoot,
    presetsRoot: root.presetsRoot,
    projectDirName: readString(source, 'projectDirName'),
    projectFileName: readString(source, 'projectFileName'),
    systemPromptMaxBytes: readNumber(source, 'systemPromptMaxBytes'),
    injectMaxBytes: readNumber(source, 'injectMaxBytes'),
    autoDigest: readBoolean(source, 'autoDigest'),
    digestEveryTurns: readNumber(source, 'digestEveryTurns', { integer: true, min: 0 }),
    digestPressureRatio: readNumber(source, 'digestPressureRatio'),
    digestMaxInputBytes: readNumber(source, 'digestMaxInputBytes'),
    digestMaxOutputTokens: readNumber(source, 'digestMaxOutputTokens'),
    digestWritableScopes: readScopes(source),
    digestProvider: readString(source, 'digestProvider'),
    digestModel: readString(source, 'digestModel'),
    injectIntoSubagents: readBoolean(source, 'injectIntoSubagents'),
    compactionRecall: readBoolean(source, 'compactionRecall'),
    // 整编阈值（契约 §V4.0.4）：整数 + 各自下限，非法值回退默认、越界按下限钳制。
    digestConsolidate: readBoolean(source, 'digestConsolidate'),
    digestConsolidateMinEntries: readNumber(source, 'digestConsolidateMinEntries', { integer: true, min: 1 }),
    digestConsolidateMinBytes: readNumber(source, 'digestConsolidateMinBytes', { integer: true, min: 1024 }),
    digestConsolidateCooldownMs: readNumber(source, 'digestConsolidateCooldownMs', { integer: true, min: 0 }),
    digestConsolidateMaxOutputTokens: readNumber(source, 'digestConsolidateMaxOutputTokens', { integer: true, min: 256 }),
    digestSnapshotKeep: readNumber(source, 'digestSnapshotKeep', { integer: true, min: 1 }),
    // 整编分批降精（契约 §V11.0.3）：开关 + 两档阈值 + 两档批量。
    digestTieredConsolidate: readBoolean(source, 'digestTieredConsolidate'),
    digestTier2MinEntries: readNumber(source, 'digestTier2MinEntries', { integer: true, min: 1 }),
    digestTier3MinEntries: readNumber(source, 'digestTier3MinEntries', { integer: true, min: 2 }),
    digestTier2BatchTopics: readNumber(source, 'digestTier2BatchTopics', { integer: true, min: 1 }),
    digestTier3BatchTopics: readNumber(source, 'digestTier3BatchTopics', { integer: true, min: 1 }),
    // 分层记忆（契约 §V8.5）：整数 + 各自下限，非法值回退默认、越界按下限钳制。
    tieredInjection: readBoolean(source, 'tieredInjection'),
    projectCoreMaxBytes: readNumber(source, 'projectCoreMaxBytes', { integer: true, min: 1024 }),
    projectIndexMaxBytes: readNumber(source, 'projectIndexMaxBytes', { integer: true, min: 512 }),
    projectRecallMaxBytes: readNumber(source, 'projectRecallMaxBytes', { integer: true, min: 512 }),
    projectRecallTopK: readNumber(source, 'projectRecallTopK', { integer: true, min: 1 }),
    projectRecallMinRounds: readNumber(source, 'projectRecallMinRounds', { integer: true, min: 0 }),
  }
}

/**
 * 计算人设目录的绝对路径。
 *
 * `resolved.personasRoot`（或废弃别名 `resolved.presetsRoot`）非空时直接使用；
 * 否则回退 `$DSH_HOME/supermemory/personas`。
 * `dshHome` 缺失时再回退 `process.env.DSH_HOME` 与 `~/.dsh`。
 *
 * 导出名保持 `resolvePresetsRoot` 以兼容 v1 调用方（契约 §V2.2）。
 *
 * @param {{ personasRoot?: string, presetsRoot?: string }} resolved - resolveConfig 的结果。
 * @param {string} [dshHome] - DSH 家目录绝对路径。
 * @returns {string} 人设目录绝对路径。
 */
export function resolvePresetsRoot(resolved, dshHome) {
  const primary = resolved?.personasRoot
  if (typeof primary === 'string' && primary.trim() !== '') return primary.trim()
  const legacy = resolved?.presetsRoot
  if (typeof legacy === 'string' && legacy.trim() !== '') return legacy.trim()

  let home = typeof dshHome === 'string' && dshHome.trim() !== '' ? dshHome.trim() : ''
  if (home === '') {
    const fromEnv = process.env.DSH_HOME
    home = typeof fromEnv === 'string' && fromEnv.trim() !== '' ? fromEnv.trim() : join(homedir(), '.dsh')
  }
  return join(home, 'supermemory', 'personas')
}

/**
 * `resolvePresetsRoot` 的 v2 名字（同函数）。
 *
 * @type {(resolved: object, dshHome?: string) => string}
 */
export const resolvePersonasRoot = resolvePresetsRoot
