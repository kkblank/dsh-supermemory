/**
 * dsh-supermemory 配置 schema 与解析。
 *
 * 本文件是全插件**唯一**允许 `import '@deepseek-ai/schemastery'` 的位置（见契约 §0.1）。
 * 其它模块只从本文件导入 `Config` / `resolveConfig` / `resolvePresetsRoot`。
 *
 * @module dsh-supermemory/host/config
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

import z from '@deepseek-ai/schemastery'

/**
 * 契约 §2 的字段表。全部 `.volatile()`，以便设置页热更新时读到最新值。
 * 注意：schemastery 不允许 volatile 字段嵌套在 volatile 字段内；本 schema 是扁平结构。
 */
export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
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
  digestProvider: z.string().default('').volatile(),
  digestModel: z.string().default('').volatile(),
  injectIntoSubagents: z.boolean().default(true).volatile(),
})

/** 解析结果的默认值（同时作为非法值的回退目标）。 */
const DEFAULTS = Object.freeze({
  enabled: true,
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
  digestProvider: '',
  digestModel: '',
  injectIntoSubagents: true,
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
 * 把 Config 实例（或普通对象）读成普通对象；每次调用都重新读取 volatile 字段的最新值。
 *
 * - `undefined` / `null` / 非对象 → 全默认值。
 * - 数值字段非法 → 回退默认；`digestEveryTurns` 取整且 ≥ 0。
 * - `presetsRoot` 为空串时**原样返回空串**，由调用方用 `resolvePresetsRoot` 补全。
 *
 * @param {unknown} config - Config 实例或普通对象。
 * @returns {{
 *   enabled: boolean, presetsRoot: string, projectDirName: string, projectFileName: string,
 *   systemPromptMaxBytes: number, injectMaxBytes: number,
 *   autoDigest: boolean, digestEveryTurns: number, digestPressureRatio: number,
 *   digestMaxInputBytes: number, digestMaxOutputTokens: number,
 *   digestProvider: string, digestModel: string, injectIntoSubagents: boolean
 * }} 普通对象形式的解析结果。
 */
export function resolveConfig(config) {
  const source = config !== null && typeof config === 'object' ? config : {}
  return {
    enabled: readBoolean(source, 'enabled'),
    presetsRoot: readString(source, 'presetsRoot'),
    projectDirName: readString(source, 'projectDirName'),
    projectFileName: readString(source, 'projectFileName'),
    systemPromptMaxBytes: readNumber(source, 'systemPromptMaxBytes'),
    injectMaxBytes: readNumber(source, 'injectMaxBytes'),
    autoDigest: readBoolean(source, 'autoDigest'),
    digestEveryTurns: readNumber(source, 'digestEveryTurns', { integer: true, min: 0 }),
    digestPressureRatio: readNumber(source, 'digestPressureRatio'),
    digestMaxInputBytes: readNumber(source, 'digestMaxInputBytes'),
    digestMaxOutputTokens: readNumber(source, 'digestMaxOutputTokens'),
    digestProvider: readString(source, 'digestProvider'),
    digestModel: readString(source, 'digestModel'),
    injectIntoSubagents: readBoolean(source, 'injectIntoSubagents'),
  }
}

/**
 * 计算预设目录的绝对路径。
 *
 * `resolved.presetsRoot` 非空时直接使用；否则回退 `$DSH_HOME/supermemory/presets`。
 * `dshHome` 缺失时再回退 `process.env.DSH_HOME` 与 `~/.dsh`。
 *
 * @param {{ presetsRoot?: string }} resolved - resolveConfig 的结果。
 * @param {string} [dshHome] - DSH 家目录绝对路径。
 * @returns {string} 预设目录绝对路径。
 */
export function resolvePresetsRoot(resolved, dshHome) {
  const configured = resolved?.presetsRoot
  if (typeof configured === 'string' && configured.trim() !== '') return configured

  let home = typeof dshHome === 'string' && dshHome.trim() !== '' ? dshHome.trim() : ''
  if (home === '') {
    const fromEnv = process.env.DSH_HOME
    home = typeof fromEnv === 'string' && fromEnv.trim() !== '' ? fromEnv.trim() : join(homedir(), '.dsh')
  }
  return join(home, 'supermemory', 'presets')
}
