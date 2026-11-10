# dsh-supermemory 模块契约（实现唯一依据）

本文件定义各模块的**精确接口**。所有实现者必须严格按此契约编码，不得擅自改名或改签名。
`PLAN.md` 描述需求；本文件描述**怎么接**。二者冲突时以本文件为准，并在完成报告中指出冲突。

---

## 0. 硬约束（违反即返工）

### 0.1 禁止 import 任何 `@deepseek-ai/*` 宿主包

本工作区**无法解析** `@deepseek-ai/dsh-*`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-llm`
（已实测 `ERR_MODULE_NOT_FOUND`，profile 里只有 `schemastery` 和 `cosmokit`）。

因此：

- **唯一允许的裸包 import 是 `@deepseek-ai/schemastery`**（用于 `Config` 定义）。它解析到
  `~/.dsh/profiles/web/node_modules/@deepseek-ai/schemastery`。用 `import z from '@deepseek-ai/schemastery'`。
  该 import 必须是**静态顶层**，且只在 `lib/host/config.js` 里出现一次，其它文件从那里导入。
- 其余所有能力通过 `ctx.get('serviceName')` **可选**获取，缺失时静默降级，绝不抛错。
- 需要构造消息对象时，**手写普通对象**（见 §3.4），不要 import `createUserMessage`。
- 只用 `node:*` 内置模块（`node:fs/promises`、`node:path`、`node:crypto`、`node:os`、`node:util`、`node:http`）。

### 0.2 接口隔离，写入范围不重叠

每个模块只 `export` 本契约列出的符号。**不要修改别人负责的文件**。

### 0.3 代码风格

- ESM（`package.json` 已 `"type": "module"`）。
- 纯 JS，不用 TypeScript，不用构建步骤。
- 中文注释，JSDoc 用 `@param` / `@returns`。
- 所有用户可见文本走 locale 文件（Host 侧日志除外）。
- 单文件建议 ≤ 400 行；超了就拆，但拆出的文件必须在自己的 write scope 内。

---

## 1. 目录与清单

```
package.json            已完成（Lead）
cordis.patch.yml        已完成（Lead）
lib/index.js            Lead      —— 插件入口：读 config、建 store、装各能力
lib/host/config.js      A         —— Config schema（唯一 schemastery inline）
lib/core/paths.js       A         —— 纯函数：slug / 项目根 / 安全 join
lib/core/store.js       A         —— 文件读写、缓存、mtime 冲突、写队列、runs.jsonl
lib/core/document.js    A         —— md 文档格式：解析/追加条目/序列化
lib/core/render.js      A         —— 注入文本 / 人格 section / 预算裁剪 / 索引降级 / 指纹
lib/core/digest.js      A         —— 整理输出解析与条目合并（纯函数）
lib/host/inject.js      B         —— 系统提示 section + pre-step 快照注入
lib/host/tools.js       B         —— memory 工具
lib/host/commands.js    B         —— /remember、/memory-digest
lib/host/digest.js      C         —— 整理执行器（LLM 调用、串行队列、触发源）
lib/host/routes.js      C         —— HTTP 路由 + 信任栅栏
lib/client.js           D         —— Web UI（侧栏面板 + 设置页）
locale/en.json          D
locale/zh.json          D
icon.svg                D
test/paths-document.test.js  A1   —— paths / document / config
test/store.test.js      A1        —— store 读写、冲突、runs、projects
test/render-digest.test.js   A2   —— render / digest 纯函数
test/routes.test.js     C         —— 信任栅栏与路由
README.md               lead
```

其中 A 拆成两个并行档位：**A1 = 存储线与纯路径/文档**，**A2 = 渲染与整理纯函数**。
两者都只依赖彼此已冻结的函数签名（本契约 §3），不得互相修改对方文件。

---

## 2. 配置（`lib/host/config.js`，A 负责）

```js
import z from '@deepseek-ai/schemastery'

export const Config = z.object({ /* 见下表 */ })

/** 把 Config 实例读成普通对象；volatile 字段每次取最新值。 */
export function resolveConfig(config) -> ResolvedConfig
```

`Config` 字段（全部 `.volatile()`，供设置页热更新）：

| 字段 | 类型 | 默认 | ResolvedConfig 字段 |
|---|---|---|---|
| `enabled` | boolean | `true` | `enabled` |
| `presetsRoot` | string | `''` | `presetsRoot`（空 → `$DSH_HOME/supermemory/presets`） |
| `projectDirName` | string | `'.dsh/memory'` | `projectDirName` |
| `projectFileName` | string | `'project-memory.md'` | `projectFileName` |
| `systemPromptMaxBytes` | number | `12000` | `systemPromptMaxBytes` |
| `injectMaxBytes` | number | `24000` | `injectMaxBytes` |
| `autoDigest` | boolean | `true` | `autoDigest` |
| `digestEveryTurns` | number | `5` | `digestEveryTurns` |
| `digestPressureRatio` | number | `0.75` | `digestPressureRatio` |
| `digestMaxInputBytes` | number | `120000` | `digestMaxInputBytes` |
| `digestMaxOutputTokens` | number | `3000` | `digestMaxOutputTokens` |
| `digestProvider` | string | `''` | `digestProvider` |
| `digestModel` | string | `''` | `digestModel` |
| `injectIntoSubagents` | boolean | `true` | `injectIntoSubagents` |

`resolveConfig(config)` 必须：
- 接受 `undefined`/`null`/非对象，回退全默认值。
- 数值字段 `Number.isFinite` 校验，非法回退默认；`digestEveryTurns` 取整且 ≥ 0。
- `resolved.presetsRoot`：空串时由**调用方**用 `dshHome` 补全（见 §6），`resolveConfig` 本身返回空串。
  另提供 `export function resolvePresetsRoot(resolved, dshHome) -> string`。

---

## 3. 核心纯函数

### 3.1 `lib/core/paths.js`（A 负责）

```js
/** preset id → 安全目录名。非 [A-Za-z0-9._-] 替换为 '-'；空/全非法 → 'default'。 */
export function presetSlug(presetId) -> string

/** 项目根名（用于注入标题展示）。取 root 的 basename。 */
export function projectDisplayName(root) -> string

/**
 * 从 cwd 向上找含 .git 的目录。
 * @param cwd 绝对路径
 * @param probe (dir) => Promise<boolean>，默认用 node:fs 判断 dir/.git 是否存在
 * @returns { root, reason }  reason: 'marker' | 'fallback' | 'error'
 * 任何 IO/权限异常 → { root: cwd, reason: 'error' }，绝不抛错。
 */
export async function resolveProjectRoot(cwd, probe?) -> { root, reason }

/**
 * 把 relPath 安全拼到 root 下。
 * 拒绝：非字符串、绝对路径、含 '..' 段、空段（除尾随）、解析后越界。
 * @returns 绝对路径
 * @throws {SafeJoinError} code = 'PATH_TRAVERSAL' | 'BAD_INPUT'
 */
export function safeJoin(root, relPath) -> string

export class SafeJoinError extends Error { code }
```

### 3.2 `lib/core/document.js`（A 负责）

四个记忆文件统一格式：

```md
# 全局长期记忆

<!-- 由 dsh-supermemory 维护；可直接编辑。 -->

## 条目

- 2026-11-10T10:00:00.000Z · source:user-request
  内容第一行
  内容第二行

- 2026-11-09T08:00:00.000Z · source:digest
  另一个条目
```

```js
/** 空文档模板。title 是一级标题文本。 */
export function emptyDocument(title) -> string   // 必须以 '\n' 结尾

/** 从文件文本取一级标题；没有则返回 undefined。 */
export function documentTitle(text) -> string | undefined

/** 把文本切成条目数组。items: { time, source, body }（body 已 trim）。 */
export function parseEntries(text) -> Array<{ time: string, source: string, body: string }>

/** 追加若干条目，返回新文本（保持尾部换行）。entries: { time, source, body }。 */
export function appendEntries(text, entries) -> string

/** 把条目渲染成 md 片段（不含前导空行）。 */
export function renderEntry(entry) -> string

/** 字节数（UTF-8）。 */
export function byteLength(text) -> number
```

### 3.3 `lib/core/render.js`（A 负责）

```js
/** 转义内容里的闭合标签，避免提前闭合包裹。内部把 '</supermemory>' → '<\\/supermemory>'。 */
export function escapeFrame(text, tag = 'supermemory') -> string

/** 人格 + 画像 → 系统提示 section 文本。soul 优先，超预算时截断画像并加提示行。 */
export function buildPersonaSection({ soul, user, maxBytes }) -> string

/**
 * 构建注入快照。
 * @param input { soul, user, global, project, projectName, maxBytes }
 * @returns { text, digest, truncated, sections }
 *   text: '<supermemory>…</supermemory>'；四段全空时 text === ''
 *   digest: sha1 十六进制（对 text + truncated 状态取指纹）
 *   truncated: boolean（是否降级为索引）
 *   sections: { soul:number, user:number, global:number, project:number }（各段字节数）
 */
export function buildSnapshot(input) -> { text, digest, truncated, sections }

/**
 * 索引降级文本（四段合并超预算时使用）。
 * @param files [{ label, title, headings, updatedAt, bytes, error? }]
 */
export function buildIndex(files, { projectName, reason }) -> string
```

**渲染规则**（必须逐条实现）：

1. 段标题固定：
   - `## 人格 (soul)`
   - `## 用户画像 (user)`
   - `## 全局长期记忆 (global)`
   - `## 项目记忆 (project: <projectName>)`
2. 段内容为空 → 该段整体省略。
3. 四段都空 → `text` 返回 `''`（调用方不注入）。
4. 合并字节（含 `<supermemory>` 包裹）> `maxBytes` → 改输出索引（`truncated: true`），
   索引里逐文件给：标题、一级小节标题列表、更新时间、字节数，并附一行
   `完整内容可用 memory 工具按需读取。`
5. 内容中出现 `</supermemory>` 必须转义（用 `escapeFrame`）。
6. **不 interpolate**：`{{...}}` 按字面量原样保留（render 层不做任何替换）。
7. `buildPersonaSection`：soul 与 user 拼接；若超 `maxBytes`，先完整保留 soul，
   再截断 user 到剩余预算，末尾追加 `\n[画像已截断]`。soul 单独就超预算时截断 soul
   并追加 `\n[人格已截断]`，不再输出 user。
8. 时间线统一用 ISO 8601 UTC（`new Date().toISOString()`）。

### 3.4 `lib/core/digest.js`（A 负责）

```js
/**
 * 解析整理器输出的 JSON。
 * 输入可能是 ```json 围栏、纯 JSON、或带前后说明文字。
 * @returns { ok: true, entries: { soul:[], user:[], global:[], project:[] } }
 *        | { ok: false, error: string }
 * 规则：只接受字符串数组；忽略未知字段；数组内非字符串项丢弃；
 *       全空数组视为 ok 且 entries 全空（调用方据此判定"无新增"）。
 */
export function parseDigestOutput(raw) -> ...

/** 合并模式：把 entries 追加到四个文件文本上。docs: { soul, user, global, project }。 */
export function mergeDigest(docs, entries, { time, source }) -> {
  soul, user, global, project, counts: { soul, user, global, project }
}
```

---

## 4. 存储层 `lib/core/store.js`（A 负责）

```js
/**
 * @param options {
 *   dshHome: string,            // 绝对路径
 *   presetsRoot: string,        // 绝对路径（presets 目录）
 *   config: ResolvedConfig,
 *   logger?: { warn(...), info(...) },
 *   now?: () => number          // 便于测试
 * }
 */
export function createStore(options) -> Store
```

`Store` 方法（全部 async，除非标注 sync）：

```js
// —— 文档 ——
readDoc(ref) -> { content, mtimeMs, bytes, path }      // 文件不存在返回空模板，mtimeMs: 0
readDocSync(ref) -> { content, mtimeMs, bytes, path }  // 只读进程内缓存，绝不抛错；未缓存返回空模板
writeDoc(ref, content, { expectedMtimeMs }) -> 
    { ok: true, mtimeMs, bytes } |
    { ok: false, code: 'STALE', mtimeMs, bytes } |     // expectedMtimeMs 与磁盘不符
    { ok: false, code: 'UNWRITABLE', message } |
    { ok: false, code: 'BAD_INPUT', message }

appendEntries(ref, entries, { expectedMtimeMs? }) -> 同 writeDoc，返回 { ok, ... , bytes }

// —— 项目 ——
touchProject(root, displayName?) -> Promise<void>     // 写 projects.json，去重更新 lastSeenAt
listProjects() -> Array<{ path, root, name, lastSeenAt }>   // 读 projects.json
addProjectPath(path) -> Promise<{ ok, root, name } | { ok:false, error }>

// —— 预设 ——
listPresets() -> Array<{ slug, id, updatedAt, dir }>   // 扫 presetsRoot
ensurePreset(presetId) -> Promise<{ slug, id, dir }>   // 建目录 + preset.json

// —— 整理报告 ——
readRuns(limit = 20) -> Array<RunRecord>              // 尾部最多 200 条读最近 limit 条
appendRun(record) -> Promise<void>                   // 追加 JSONL，超过 200 条裁剪

// —— 辅助 ——
docPath(ref) -> string                               // 纯计算，不读盘
stats(ref) -> { exists, bytes, mtimeMs }
dispose() -> Promise<void>
```

`ref` 形态（**唯一合法形态**，不接受任意路径）：

```js
{ kind: 'soul'   | 'user' | 'global', presetId }
{ kind: 'project', projectRoot }
```

**存储规则**：

1. `soul`/`user`/`global` → `<presetsRoot>/<presetSlug(presetId)>/<kind>.md`
2. `project` → `<projectRoot>/<projectDirName>/<projectFileName>`，
   路径必须由 `safeJoin` 生成；`projectRoot` 必须是绝对路径。
3. 写盘一律「临时文件 + `rename`」原子替换；临时文件放在同目录，名字带 pid+随机后缀。
4. 进程内缓存 `Map<path, { content, mtimeMs, bytes }>`；`readDoc` 每次 `stat` 比对
   `mtimeMs`，不同才重读，保证外部编辑器改动可见。
5. 写队列：同一路径的写操作串行（`Map<path, Promise>`），避免并发半写。
6. 首次读不存在的文件 → 返回 `emptyDocument(title)`，**不落盘**；首次写才创建目录与文件。
7. `appendEntries` 内部：先重读（拿最新 mtime），若调用方给了 `expectedMtimeMs` 且不符 → `STALE`。
8. 所有 IO 错误被捕获并转成 `{ ok: false, code: 'UNWRITABLE' }`，**绝不抛**。
9. `runs.jsonl` 每行一个 JSON 对象；读取时跳过坏行并告警。
10. `projects.json` 结构 `{ version: 1, projects: [...] }`。

`RunRecord`：

```js
{
  at: string,            // ISO
  sessionId?: string,
  trigger: 'turns' | 'pressure' | 'manual' | 'tool',
  ok: boolean,
  error?: string,        // 失败原因
  counts?: { soul, user, global, project },
  bytesBefore?: { soul, user, global, project },
  bytesAfter?: { soul, user, global, project },
  presetId?: string,
  projectRoot?: string
}
```

---

## 5. Host 能力

### 5.1 `lib/host/inject.js`（B 负责）

```js
/**
 * 安装人格 section 与记忆快照注入。
 * @param ctx cordis Context
 * @param deps { store, getConfig(), dshHome, logger, resolveScope(agent) , isSubagent(agent) }
 * @returns dispose: () => void
 */
export function installInjection(ctx, deps) -> () => void
```

`deps.resolveScope(agent) -> Promise<{ presetId, projectRoot, projectName }>`（由 `lib/index.js` 提供，B 不要自己实现）。

**A) 系统提示 section**

```js
const prompt = ctx.get('systemPrompt')
if (prompt) prompt.section({ name: 'supermemory:persona', order: 100, interpolate: false, text: () => {...} })
```

- `text()` 必须是**同步**函数（section 的 `text` 支持 `(context) => string`，
  但 `AssembleContext` 只有 `{ scope, signal }`，**拿不到 agent**）。
  因此：section 内部读「最后一次 `resolveScope` 写入的 WeakMap<agent, scope>」不可行
  （无 agent 参数）→ **改用全局「当前活动 scope」缓存**：
  - `installInjection` 维护 `let activeScope = null`，由 `agent/pre-step` 与
    `agent/created` 更新。
  - section 的 `text()` 用 `activeScope` 同步读 `store.readDocSync({ kind:'soul'|'user', presetId })`。
  - 若 `activeScope` 为 null → 返回 `''`。
- 超 `systemPromptMaxBytes` 走 `buildPersonaSection` 的裁剪规则。
- 返回空串时不注入任何内容。

**B) 记忆快照注入（核心，必须严格按此实现）**

监听 `agent/pre-step`（waterfall）：

```js
ctx.on('agent/pre-step', async ({ agent, messages, step, signal }, next) => {
  const decision = await next()
  if (decision.kind === 'reject') return decision
  // 1. 解析 scope（await deps.resolveScope(agent)）
  // 2. 读四段内容（await store.readDoc × 4）
  // 3. snapshot = buildSnapshot({...})
  // 4. 若 snapshot.text === '' → 若历史里已有旧快照则删除它，返回 decision
  // 5. 从 session 日志找上一条本插件消息：扫描 session.snapshotEvents()，
  //    找 type === 'user/message' && data.source?.kind === 'dsh-supermemory' 的最后一条
  // 6. 三种情况：
  //    a) 不存在 → session.append('user/message', data, { surfaceOp: 'append' })
  //    b) 存在且 digest 相同 → 不动作
  //    c) 存在且 digest 不同 → session.append('user/message', data,
  //         { surfaceOp: { op:'replace', startSeq: oldSeq, endSeq: oldSeq } })
  // 7. 把新消息并入本步 messages：
  //    在 decision.messages 里，找到最后一个 messages.includes(m) 的索引，
  //    在其后插入新消息；返回 { ...decision, messages: 新数组 }
  //    （判定：若 decision.messages 已含同 digest 消息则不重复插入）
})
```

**消息对象（手写，严格照抄）**：

```js
{
  role: 'user',
  content: [{ type: 'text', text: bodyText }],
  source: {
    kind: 'dsh-supermemory',
    form: 'snapshot',
    digest,
    truncated,
    sections,
    sectionsDetail: [ { name: 'soul', text: '...' }, ... ]   // 可选，form:'snapshot' 需要
  }
}
```

> 注意：`form: 'snapshot'` 在宿主类型里要求带 `sections: Array<{name,text}>`。
> 为避免类型/校验冲突，**采用**：`source = { kind:'dsh-supermemory', form:'snapshot', digest, truncated, sections: [{name:'soul',text}, ...] }`，
> 把字节数放到额外字段 `byteSections`。`sections` 只放**非空段**。

`bodyText` 首行固定为：

```
本消息由 dsh-supermemory 插件自动维护的记忆快照，不是用户发言。
```

随后空行 + `snapshot.text`。

**其它要求**：

- 子智能体：`deps.isSubagent(agent)` 为 true 且 `config.injectIntoSubagents === false` → 跳过注入。
- 任何异常：`try/catch` 后 `logger.warn`，然后 `return decision`（绝不破坏 step）。
- `signal.aborted` 时直接返回 decision。

### 5.2 `lib/host/tools.js`（B 负责）

```js
export function installTools(ctx, deps) -> dispose
```

- 工具名 `memory`，参数：

```js
{
  action: 'list' | 'read' | 'search' | 'append' | 'replace' | 'digest',   // required
  scope: 'soul' | 'user' | 'global' | 'project',                          // optional
  query: string,        // search 必填
  content: string,      // append/replace 必填
  reason: string        // 写入原因
}
```

- 输出（返回普通对象，宿主会 JSON 序列化）：

```js
{ ok: true, action, scope?, text?, bytes?, entries?, matches?, report? }
{ ok: false, error: '...', code: '...' }
```

- `digest` 走 `deps.runDigest({ agent, trigger: 'tool' })`，返回其报告摘要。
- `project` scope 的根由 `deps.resolveScope(exec.agent)` 解析，**不接受模型传路径**。
- 工具描述必须写明：何时主动写记忆、何时先 search、快照不是用户发言、
  写入失败请如实报告而不是重试。
- 用 `ctx.get('tools')`；缺失则整个模块返回空 dispose（静默降级）。
- 注册用 `ctx.tools.register(definition, options?)`，definition 手写普通对象
  （宿主不强制 `defineTool`，`ToolDefinition` 是普通结构）：

```js
{
  name: 'memory',
  description: '...',
  parameters: { /* JSON Schema */ },
  output: { schema: { /* JSON Schema */ }, render: (args, value) => [{ type:'text', text: JSON.stringify(value) }] },
  execute: async (args, exec) => value,
  isConcurrencySafe: () => false
}
```

### 5.3 `lib/host/commands.js`（B 负责）

```js
export function installCommands(ctx, deps) -> dispose
```

- `/remember [scope] <内容>` → 调 store 追加，返回 `{ kind:'success', text }` 或 `{ kind:'error', text }`。
  scope 缺省 `global`；无法识别的 scope 名当作内容的一部分。
- `/memory-digest` → 调 `deps.runDigest({ agent, trigger:'manual' })`，返回文本结果。
- 用 `ctx.get('commands')`；缺失则返回空 dispose。

### 5.4 `lib/host/digest.js`（C 负责）

```js
/**
 * @param ctx cordis Context
 * @param deps { store, getConfig(), resolveScope(agent), logger, dshHome }
 * @returns { install(): dispose, runDigest({ agent, trigger, signal? }): Promise<RunRecord>, dispose() }
 */
export function createDigestRunner(ctx, deps) -> { install, runDigest, dispose }
```

**执行逻辑**：

1. `ctx.get('llm')` 缺失 → 返回 `{ ok:false, error:'llm service unavailable' }` 的 RunRecord。
2. 路由：`config.digestProvider/digestModel` 非空则用之；否则用
   `deps.currentRoute(agent)`（由 index.js 提供，读 `agent` 的 model selection，
   取不到则用 `ctx.get('agentDefaultModel')?.currentSelection()`）。
3. 输入组装：
   - 从 `agent.session.snapshotEvents()` 取最近 40 条 `user/message` + `assistant/message` 的纯文本，
     **跳过** `source.kind === 'dsh-supermemory'` 的条目和 tool 结果。
   - 加上四个文件的现有内容。合并后超 `digestMaxInputBytes` → 按段落从旧到新截断。
4. system 提示要求**只输出 JSON**，格式固定：

```json
{"user":["..."],"global":["..."],"project":["..."],"soul":["..."]}
```

并在 system 里明确：只写**新增**事实；`soul` 仅在用户明确要求改人设时非空；不要重复已有内容。
5. 调 `llm.stream({ provider, model, messages:[{role:'user',content:[{type:'text',text}]}], system, maxTokens, signal, sessionId: agent.session.id })`，
   收集 `text-delta` 直到 `finish` 或流结束。
6. `parseDigestOutput` 解析；失败 → **重试一次**（同参数），再失败 → 记失败 RunRecord，不改文件。
7. 写文件前重新 `readDoc` 拿最新 mtime，用 `mergeDigest` 计算新文本，
   再 `writeDoc(ref, text, { expectedMtimeMs })`；`STALE` → 重试一次；
   仍失败 → 该文件跳过并记入 error。
8. 串行：同一 `agent.session.id` 同时只跑一个整理（`Map<sessionId, Promise>`），
   新的触发若已有在跑则直接返回「已在整理中」。
9. `AbortController`：`ctx.effect(() => () => controller.abort())`。
10. 结果写 `store.appendRun(record)`。

**触发源** `install()`：

- `ctx.on('session/event', (session, event) => ...)`：`event.type === 'turn/end'`
  且 `event.data.reason?.kind === 'completed'`：
  - 子智能体（`deps.isSubagent` 或 `session.header.parentSession` 存在）→ 不触发自动整理。
  - 计数（`Map<sessionId, number>`）达到 `digestEveryTurns` → 触发 `trigger:'turns'` 并清零。
  - `ctx.get('tokenMeter')` 存在时，`meter.contextPressure(session)` 返回
    `{ pressureTokens, contextWindow }`，`pressureTokens / contextWindow >= digestPressureRatio`
    且比例 > 0 → 触发 `trigger:'pressure'`。
  - 触发必须异步 fire-and-forget（不阻塞事件），用 `.catch(logger.warn)`。
  - 需要 agent：用 `ctx.get('agents')?.get(session.id)`，拿不到就跳过。

### 5.5 `lib/host/routes.js`（C 负责）

```js
export function installRoutes(ctx, deps) -> dispose
```

前缀 **document-relative**：`api/dsh-supermemory`（**不带前导 `/`**）。
`ctx.webServer.register({ kind: 'exact', path, handler })`。

| 方法 | path | 说明 |
|---|---|---|
| GET | `api/dsh-supermemory/bootstrap` | 见下 |
| GET | `api/dsh-supermemory/doc?scope=&presetId=&projectRoot=` | 读单个文件 |
| PUT | `api/dsh-supermemory/doc` | 写单个文件（body: `{scope,presetId,projectRoot,content,expectedMtimeMs}`） |
| POST | `api/dsh-supermemory/digest` | 手动整理（body: `{presetId,projectRoot,sessionId?}`） |
| GET | `api/dsh-supermemory/runs` | 最近整理报告 |

**信任栅栏**（每个路由第一行调用，不合规返回 403 `{ ok:false, error:'forbidden' }`）：

```js
function isLoopbackRequest(req) {
  // socket.remoteAddress 是 127/8 或 ::1（::ffff:127.x 也算）
  // 且无 cf-connecting-ip / x-forwarded-for
  // 且 host 头 hostname 是 loopback
  // 且 sec-fetch-site !== 'cross-site'
  // 且 origin 缺失或 origin.host === host.host
}
```

**响应格式**统一 JSON，`{ ok: true, data }` / `{ ok: false, error, code? }`。

`bootstrap` 返回：

```js
{
  ok: true,
  data: {
    presets: [{ slug, id, updatedAt }],
    projects: [{ root, name, lastSeenAt }],
    active: { presetId, projectRoot, projectName },   // 由 deps.activeContext() 提供
    config: { /* 预算与阈值摘要 */ },
    presetsRoot, dshHome
  }
}
```

`doc` GET 返回 `{ ok:true, data: { content, mtimeMs, bytes, path, title } }`；
PUT 返回 `{ ok:true, data:{ mtimeMs, bytes } }`，冲突返回 **409** `{ ok:false, code:'STALE' }`。
所有 `scope`/`presetId`/`projectRoot` 都经 `store.docPath` 的 ref 校验，禁止任意路径。

超时与体积：请求体上限 1 MiB，超限 413。

---

## 6. 插件入口 `lib/index.js`（Lead 负责）

```js
export const name = 'supermemory'
export const inject = []            // 全部能力可选，不硬依赖
export { Config }                   // 从 lib/host/config.js re-export
export function apply(ctx, config) { ... }
```

职责：

1. `const resolved = resolveConfig(config)`；`enabled === false` → 直接 return（不注册任何东西）。
2. 计算 `dshHome = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')`，
   `presetsRoot = resolvePresetsRoot(resolved, dshHome)`。
3. `createStore({ dshHome, presetsRoot, config: resolved, logger: ctx.logger })`。
4. `resolveScope(agent)`：`presetId = ctx.get('agentPresets')?.presetForSession(agent.session) ?? 'default'`；
   `cwd = ctx.get('workingDirectory')?.get(agent.session) ?? agent.session.header.cwd ?? process.cwd()`；
   `{ root: projectRoot, reason } = await resolveProjectRoot(cwd)`；
   `name = projectDisplayName(root)`；`await store.touchProject(root, name)`。
5. `isSubagent(agent)`：`agent.session.header.parentSession !== undefined || agent.session.header.origin === 'subagent'`。
6. `currentRoute(agent)`：读 agent 的 model selection，回退 `ctx.get('agentDefaultModel')?.currentSelection()`。
7. 依次 `installInjection` / `installTools` / `installCommands` / `digestRunner.install()` / `installRoutes`，
   每个都包在 `ctx.effect(() => dispose)` 里，单个失败不影响其它（`try/catch` + `logger.warn`）。
8. `activeContext()` 给 routes 用：当前活动 session 的 scope（由 `agent/pre-step` 更新），无则 `null`。

---

## 7. 客户端 `lib/client.js`（D 负责）

文件形态（**手写，不可编译**）：

```js
window.__ModuleLoader__.load({
  id: 'dsh-supermemory',
  factory(require) {
    const React = require('react')
    // ...
    return { inject: [...], apply(ctx) { ... } }
  },
})
```

- `inject: ['slots', 'locale', 'layout']`。
- 只用 `require('react')`（**不要** `react/jsx-runtime`，不要任何 `@deepseek-ai/*`）。
- 注册三处：

```js
// 1) 侧栏图标
ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
  { name: 'sidebar.panellist', id: 'supermemory', order: 40, locale: NS, label: () => t('panel.title') },
  Icon))

// 2) 主面板（key 必须与侧栏 id 一致：'supermemory'）
ctx.slots.inject('main', () => ctx.slots.register(
  { name: 'main', key: 'supermemory', locale: NS }, PanelPage))

// 3) 设置页
ctx.slots.inject('settings.section', () => ctx.slots.register(
  { name: 'settings.section', id: 'supermemory', order: 130, locale: NS, label: () => t('settings.title') },
  SettingsSection))
```

- 面板点击图标时切到该面板：宿主 sidebar 已用 `id` 驱动 `main` 的 key，**无需**手工调
  `layout.selectPanel`；仅在「设置页 → 打开记忆面板」按钮里调用
  `ctx.get('layout')?.selectPanel('supermemory')`。
- 数据全部走 `fetch('api/dsh-supermemory/...')`（document-relative，**不带前导斜杠**）。
- 面板布局：
  - 顶部：预设下拉 + 项目下拉 + 预算占用条。
  - 左侧：四个分区导航（人格/用户画像/全局记忆/项目记忆），项目区显示根路径。
  - 右侧：等宽 `textarea`，底部字节数、最后修改时间、保存/重新载入。
  - 底部：最近一次整理卡片 + 「立即整理」按钮。
  - 409 → 提示「文件已被外部修改」并提供重新载入。
- 设置页：只读展示记忆根目录、预设目录、项目目录规则、预算与阈值、最近整理，
  加「打开记忆面板」按钮与配置示例代码块。
- 样式：只允许 `--dsw-alias-*` token（列表见 §9），类名统一 `sm-` 前缀，
  用 `React.createElement` 内联 style 或组件内 `<style>` 元素（卸载自动移除）。
- 文案全部走 `ctx.locale.register(NS, { en: {...}, zh: {...} })` + `ctx.locale.bind(NS)`；
  locale 变更要能刷新（`ctx.locale.subscribe`）。
- **不要**读宿主 DOM、不要 append 到 `document.body`、不要 import 宿主 Client 包。

---

## 8. 本地化文件 `locale/en.json` / `locale/zh.json`（D 负责）

```json
{
  "meta": { "title": "Memory", "description": "Persona, user profile, global and project memory injected into every session." },
  "panel": { "title": "Memory" },
  "settings": { "title": "Memory" },
  "...": "..."
}
```

`meta.title` / `meta.description` 必填（插件管理页展示）。zh 版本给出对应中文。

## 9. 主题 token 白名单

`--dsw-alias-bg-base`、`--dsw-alias-bg-layer-1`、`--dsw-alias-bg-layer-2`、
`--dsw-alias-bg-overlay`、`--dsw-alias-border-l1`、`--dsw-alias-border-l2`、
`--dsw-alias-brand-primary`、`--dsw-alias-label-primary`、`--dsw-alias-label-secondary`、
`--dsw-alias-state-error-primary`、`--dsw-alias-state-idle-primary`、
`--dsw-alias-state-success-primary`、`--dsw-alias-state-warn-primary`、
`--dsw-specific-sidebar-fill`。

不得出现其它颜色字面量（图标 SVG 除外）。

---

## 10. 验收对照（PLAN.md §8.1 单测）

`test/paths-document.test.js` 必须覆盖：

- `presetSlug`：普通 id、含 `:`/`/`/`空格`、空串、全非法字符。
- `safeJoin`：正常、绝对路径、`..`、越界、非字符串。
- `resolveProjectRoot`：有 `.git`、无 `.git` 回退 cwd、probe 抛错回退。
- `document.js`：空模板、解析、追加、往返幂等。
- `resolveConfig`：全默认、部分覆盖、非法数值回退、`enabled:false`。

`test/render-digest.test.js` 必须覆盖：

- `render.js`：四段齐全、部分为空、全空、超预算降级索引、`</supermemory>` 转义、`{{x}}` 保持字面量。
- `buildPersonaSection`：两者都空、soul 超预算、user 被截断并带提示行。
- `digest.js`：合法 JSON、```json 围栏、非法 JSON、多余字段、非字符串项、全空。

`test/store.test.js` 必须覆盖：

- 首次读不存在 → 空模板且不落盘。
- 写入后读回、mtime 变化、`STALE` 冲突。
- 并发写同文件不半写。
- `runs.jsonl` 追加与裁剪。
- `projects.json` 去重更新。

`test/routes.test.js` 必须覆盖：

- 非 loopback socket / 带 `x-forwarded-for` / `cross-site` / 异源 origin → 403。
- 正常 loopback → 200。
- 路径穿越参数 → 400 而非读到任意文件。

---

# v2 变更（优先于前文，冲突时以本节为准）

用户提出的 5 条产品变更，属破坏性改动。本节**覆盖**前文的 `preset` 概念。

## V2.0 五条变更与决策

| # | 需求 | 决策 |
|---|---|---|
| 1 | 人格设定不参与记忆整理 | 整理器**永不写 soul**。soul 只能用户手动编辑，或用户提示词明确要求时 agent 经 `memory` 工具写 |
| 2 | 用户画像/全局记忆不可频繁自动修改 | **自动整理只写 project**。user/global 永不自动写；只能用户手动编辑或明确要求时 agent 通过 `memory` 写 |
| 3 | 自动整理可自选模型 | 新增模型选择器，数据源 `llm.listProviders()` + `llm.listModels(provider)`；选择存 `settings.json` |
| 4 | 项目不用手动添加，自动同步工作区 | 项目列表来自 `ctx.get('workspaceRegistry').list()`，面板只读；删除「添加项目」 |
| 5 | 新增「人设」层，独立 soul/user/global，项目记忆不跟人设 | **人设（persona）取代 agent preset 作为记忆隔离单位**；全局单一「当前人设」，面板切换 |

## V2.1 数据模型（替代 §3.1、§4 的 presets 部分）

```
$DSH_HOME/supermemory/
  personas.json                    # { version:1, current:<slug>, personas:[{slug,name,createdAt}] }
  personas/<slug>/
    soul.md
    user.md
    global-memory.md
  settings.json                    # { version:1, digestProvider, digestModel }
  projects.json                    # 保留：仅记录 lastSeenAt，不再作为项目列表来源
  runs.jsonl
```

```
<projectRoot>/.dsh/memory/project-memory.md     # 不变
```

- `slug`：`personaSlug(name)` = 非 `[A-Za-z0-9._-]` 替换为 `-`；空/`default` 保留；`..`/`.` → `default`。
- **迁移**：`createStore` 首次被调用时，若 `personas/` 不存在而旧 `presets/` 存在，
  把 `presets/<slug>/` 整体搬到 `personas/<slug>/` 并登记；`personas.json` 不存在则创建，
  `current` 取迁移到的第一个 slug，否则 `'default'`。迁移失败只告警，不阻断。
- `settings.json` 不存在 → 返回默认 `{ digestProvider:'', digestModel:'' }`。
- **迁移时机**：`createStore()` 返回对象上带一个 `ready: Promise<void>`，构造时立即启动迁移
  （`migrateLegacyPresets()` 的 Promise）。**所有异步方法内部先 `await ready`**，
  这样调用方不需要关心迁移。`ready` 永不 reject（失败只告警）。

## V2.2 存储层新增 API（A1 负责，`lib/core/store.js`）

以下**新增**，其余（readDoc/writeDoc/appendEntries/readRuns/appendRun/docPath/stats/dispose）不变：

```js
// —— 人设 ——
listPersonas() -> Array<{ slug, name, createdAt, dir }>          // 按 createdAt 升序
currentPersona() -> { slug, name } | null                        // 读 personas.json.current
setCurrentPersona(slug) -> Promise<{ ok:true, persona } | { ok:false, code, message }>
createPersona(name) -> Promise<{ ok:true, persona } | { ok:false, code, message }>
  // slug 冲突 → 追加 -2、-3；name 去空白、截 60 字符；createdAt = ISO
personaDir(slug) -> string                                        // 纯计算，不读盘
migrateLegacyPresets() -> Promise<{ migrated: string[] }>         // 幂等
```

**ref 形态变更**：`soul`/`user`/`global` 的隔离键从 `presetId` 改为 `persona`：

```js
{ kind: 'soul'   | 'user' | 'global', persona: slug }
{ kind: 'project', projectRoot }                                  // 不变
```

**过渡兼容**：若 ref 只有 `presetId` 没有 `persona`，按 `presetId` 当作 persona 处理
（现有测试大量使用 `presetId`，这样可平滑迁移）。两者都给时 `persona` 优先。

```js
// —— 插件设置 ——
readSettings() -> { digestProvider: string, digestModel: string }
writeSettings(patch) -> Promise<{ ok:true, settings } | { ok:false, code, message }>
  // 只接受 digestProvider / digestModel 两个字符串；其它键忽略
```

配置字段：`presetsRoot` 改名 `personasRoot`（默认空 → `$DSH_HOME/supermemory/personas`）。
`resolvePresetsRoot(resolved, dshHome)` 保留导出名但按 `personasRoot` 解析，`presetsRoot` 作为废弃别名仍接受。

## V2.3 整理器（C 负责，`lib/host/digest.js`）

**输出与写入范围收窄**：

- `DIGEST_SYSTEM_PROMPT` 改为只要求输出 `{"project":["..."]}`，并明确：
  「不要输出 soul/user/global；人格与画像/全局记忆由用户手动维护。」
- 解析后**只写 project**。`soul`/`user`/`global` 无论模型输出什么都不写。
  用配置 `digestWritableScopes`（默认 `['project']`）表达，便于将来扩展，但默认只 project。
- `RunRecord.counts` 仍保留四个 key，非 project 恒为 0。

**模型选择优先级**（改 `resolveRoute`）：

1. `store.readSettings().digestProvider` + `.digestModel`（面板里选的）
2. `getConfig().digestProvider` + `.digestModel`（cordis.patch.yml）
3. `deps.currentRoute(agent)`（当前会话路由）
4. `agentDefaultModel.currentSelection()`

任一层 provider 与 model 必须同时非空才采用。

## V2.4 路由（C 负责，`lib/host/routes.js`）

新增/变更：

| 方法 | path | 说明 |
|---|---|---|
| GET | `api/dsh-supermemory/bootstrap` | **结构变更**，见下 |
| GET | `api/dsh-supermemory/doc` | query 参数 `persona`（兼容 `presetId`）+ `projectRoot` |
| PUT | `api/dsh-supermemory/doc` | body：`persona`（兼容 `presetId`） |
| POST | `api/dsh-supermemory/digest` | body：`persona`、`projectRoot` |
| GET | `api/dsh-supermemory/runs` | 不变 |
| **GET** | **`api/dsh-supermemory/models`** | 新增：可用模型列表 |
| **PUT** | **`api/dsh-supermemory/settings`** | 新增：保存整理模型 |
| **GET** | **`api/dsh-supermemory/personas`** | 新增：人设列表 + current |
| **POST** | **`api/dsh-supermemory/personas`** | 新增：`{name}` 创建人设，自动切换为 current |
| **PUT** | **`api/dsh-supermemory/personas`** | 新增：`{slug}` 切换 current |

**`bootstrap` 新结构**：

```js
{
  ok: true,
  data: {
    personas: [{ slug, name, createdAt }],
    currentPersona: { slug, name } | null,
    projects: [{ path, name }],          // 来自 workspaceRegistry.list()
    active: { persona, projectRoot, projectName } | null,   // 当前会话解析结果
    config: { systemPromptMaxBytes, injectMaxBytes, autoDigest, digestEveryTurns,
              digestPressureRatio, digestWritableScopes, projectDirName, projectFileName },
    digestSettings: { digestProvider, digestModel },
    presetsRoot: personasRoot,
    dshHome
  }
}
```

**`models` 响应**：

```js
{ ok:true, data:{ models:[{ provider, id, name, label }], current:{ provider, model } | null } }
```

由 `deps.listModels()` 提供（`lib/index.js` 实现：遍历 `llm.listProviders()` 再 `llm.listModels(p.id)`，
单个 provider 抛错则跳过；`label` = `providerName / modelName`）。
`current` 读 `store.readSettings()`，空则 null。

**`personas` 响应**：`{ ok:true, data:{ personas, current } }`。
创建/切换成功后返回同样的 `data`。名称非法（空、超 60）→ 400。

**项目列表**：不再接受客户端传任意项目路径作为「添加项目」。
`projects` 必须来自 `deps.listProjects()`（`lib/index.js` 用 `workspaceRegistry.list()` 实现）。

## V2.5 注入层（B 负责，`lib/host/tools.js`、`commands.js`；`inject.js` 仅小改）

`inject.js` 无需改逻辑：scope 由 `lib/index.js` 的 `resolveScope` 提供，
现在返回的 `presetId` 字段改名为 `persona`（同时保留 `presetId` 兼容字段一段时间）。

**`memory` 工具的写保护**（重要）：

| scope | append | replace | 允许条件 |
|---|---|---|---|
| `soul` | ❌ 拒绝 | ✅ 允许 | 必须带 `confirmSoul: true` 参数，且拒绝时返回 `code:'SOUL_CONFIRM_REQUIRED'` 并说明「人格只能用户手动改，或用户明确要求时带 confirmSoul 写入」 |
| `user` | ✅ | ✅ | 允许，但工具描述要求只在用户明确陈述偏好/事实时写 |
| `global` | ✅ | ✅ | 同上 |
| `project` | ✅ | ✅ | 无额外限制 |

参数新增：

```js
confirmSoul: { type: 'boolean', description: 'Set true only when the user explicitly asked to change the persona/soul. Required for any soul write.' }
```

输出 schema 加 `confirmSoul` 不需要，但错误要能区分（`code`）。

**命令**：`/remember` 默认写 `global` 不变；新增 `/remember soul ...` 需带 `--confirm`，
否则返回 error 提示人格只能用户手动改。

## V2.6 客户端（D 负责，`lib/client.js`、`locale/*.json`）

**顶部工具栏改为**（顺序固定）：

```
[人设 ▾]  [+ 添加人设]  [项目 ▾]        …右侧：预算占用条
```

- **人设下拉**：来自 `bootstrap.personas`，选中即 `PUT personas {slug}` 切换全局 current，
  然后重新加载四个分区。
- **「+ 添加人设」按钮**：点开内联输入框（用 `prompt` 是禁止的，要自绘 input），
  输入名称 → `POST personas {name}` → 成功后刷新列表并切换到新人设。
- **项目下拉**：来自 `bootstrap.projects`（工作区自动同步），**只读**，删除原有「添加项目」按钮与
  `uiWorkspace.pickDirectory` 逻辑。
- **整理卡片**增加模型选择：`select` 选项来自 `GET models`，默认为 `digestSettings` 或「跟随当前会话」，
  变更时 `PUT settings {digestProvider, digestModel}`（选「跟随当前会话」则传空串）。

**分区导航**：soul/user/global 读当前人设；project 读当前项目的记忆。项目区显示根路径。

**locale**：新增 key 至少包括
`panel.persona`、`panel.personaAdd`、`panel.personaAddPlaceholder`、`panel.personaCreateFailed`、
`panel.personaSwitched`、`panel.digest.model`、`panel.digest.modelFollow`、
`panel.projectAuto`；删除 `panel.addProject*`、`panel.noPicker`、`panel.pickFailed`。
en/zh 两套必须键完全一致。

**约束不变**：只 `require('react')`、无 JSX、只用 `--dsw-alias-*` token、fetch 用 document-relative。

## V2.7 `lib/index.js`（Lead 负责）

- `resolveScope(agent)`：
  - `persona = store.currentPersona()?.slug ?? 'default'`
  - `cwd` 解析与 `projectRoot` 逻辑不变
  - 返回 `{ persona, presetId: persona, projectRoot, projectName, reason }`
- 新增 `deps.listModels()`、`deps.listProjects()`（workspaceRegistry）、`deps.personasApi` 所需的 store 直通。
- `deps.currentRoute` 保持不变。

## V2.8 测试要求变更

- `test/paths-document.test.js`：`personaSlug` 用例（原 `presetSlug` 保留别名）。
- `test/store.test.js`：新增 personas 增删查切、`personas.json` 结构、迁移、settings 读写。
- `test/render-digest.test.js`：不变（纯函数层）。
- `test/host-install.test.js`：新增 soul 写保护（无 `confirmSoul` → 拒绝；有则允许）、
  user/global 无限制、注入 scope 字段变更。
- `test/routes.test.js`：bootstrap 新结构、models 路由、personas 增改查、doc 路由 `persona` 参数。
- `test/injection-trigger.test.js`：整理只写 project 的断言（user/global 输出被丢弃）。
- `test/trust-fence.test.js`：不变。

**验收基线**：全部测试通过；`node --test` 用例数不减少。
