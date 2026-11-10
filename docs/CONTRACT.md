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
| `injectIntoSubagents` | boolean | `false` | `injectIntoSubagents` |
| `compactionRecall` | boolean | `true` | `compactionRecall` |

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
  （自 §V3.9 起该提示词同时携带记忆条目的事实性守则。）
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

---

# v3 变更：插件总开关（面板里的软开关）

用户要求「设置 → 记忆」里放一个开关，关掉之后插件才不生效。本节定义它的语义、
存储位置、接口与界面行为。**本节覆盖前文中「设置页只读」的表述**：设置页从此有一个
可写控件（总开关），其余概览项仍然只读。

## V3.1 两级开关是 AND 关系（最容易被误解的一点）

| | `enabled`（cordis.patch.yml） | `enabled`（settings.json，v3 新增） |
|---|---|---|
| 层级 | 硬开关：cordis 插件配置 | 软开关：插件自己的运行时设置 |
| 读取者 | `lib/index.js` 的 `apply(ctx, config)` | `deps.isEnabled()` → `store.readSettings().enabled` |
| 关掉的效果 | `apply()` 直接 return：**一个监听/工具/路由/客户端入口都不装配**，面板打不开 | 能力层停摆，**路由与面板照常装配**，页面能进、记忆能读能改 |
| 怎么改 | 改 yml + 重启/重载插件 | 设置页点一下即可，无需重启 |
| 判定 | `if (!resolved.enabled) return` | `deps?.isEnabled?.() === false` 才拦 |

**两者是 AND**：任一为 false，注入/工具/命令/自动整理都不工作；但只有软开关能保住面板
可用。界面文案必须写清这点（`settings.enableHint`），否则用户会以为面板上关掉就等于
插件已卸载。

## V3.2 语义：关闭时到底停掉什么

| 能力 | 关闭时行为 | 负责文件 |
|---|---|---|
| 系统提示 `supermemory:persona` section | `text()` 返回 `''`（不注入） | `lib/host/inject.js` |
| `agent/pre-step` 记忆快照 | 直接返回 decision，**不写任何快照**；历史里已有的旧快照原样保留，不替换也不清理 | `lib/host/inject.js` |
| `memory` 工具 | 返回 `{ ok:false, code:'PLUGIN_DISABLED' }`，不抛异常 | `lib/host/tools.js` |
| `/remember`、`/memory-digest` | 回一句「插件已关闭」提示 | `lib/host/commands.js` |
| 自动整理（轮次/压力触发） | `maybeTrigger` 直接跳过 | `lib/host/digest.js` |
| 手动整理 `POST digest` | **409 + `code:'PLUGIN_DISABLED'`** | `lib/host/routes.js` |
| 面板 HTTP（bootstrap/doc/runs/models/settings/personas） | **全部照常 200**，一个都不拦 | `lib/host/routes.js` |

铁律：**关闭状态下面板必须还能看、还能改记忆内容**。任何 GET/PUT 都不得因为关闭而返回
403/404——否则用户关掉之后再也打不开，只能去手改 `settings.json`。信任栅栏（403）与
关闭无关，仍然对所有路由生效且优先级更高。

## V3.3 存储

```
$DSH_HOME/supermemory/settings.json
{ "version": 1, "enabled": true, "digestProvider": "", "digestModel": "" }
```

- 默认 `true`；文件缺失 / JSON 非法 / 读取抛错 → **一律回退 `true`**（绝不因读盘失败把插件
  悄悄关掉，也不能把面板变成砖）。
- 由 `lib/core/store.js` 读写（`DEFAULT_SETTINGS` / `normalizeSettings` / `writeSettings` /
  `readSettings`），`lib/index.js` 以 `isEnabled: () => boolean` **同步**暴露给各能力层。
- 非布尔的 `patch.enabled` 被 store 忽略（沿用「非法值忽略」策略）；routes 层更早一步，
  直接 400 `BAD_INPUT`，让界面立刻看到原因。

## V3.4 判定写法（硬约束）

所有门控一律写成**只在明确 false 时拦截**：

```js
// routes 层
function pluginEnabled() {
  try {
    return deps?.isEnabled?.() !== false
  } catch {
    return true
  }
}

// 能力层等价写法
if (deps.isEnabled?.() === false) return decision
```

**不得写成 `!deps.isEnabled()`**：既有测试的 mock `deps` 里没有 `isEnabled`，那样会把一大批
既有用例整体弄挂。缺失、`undefined`、抛错，全部视为「开启」。

## V3.5 接口变更

| 方法 | path | v3 变更 |
|---|---|---|
| GET | `api/dsh-supermemory/bootstrap` | `data` 顶层新增 **`enabled: boolean`**，与 `data.digestSettings.enabled` 恒等 |
| — | — | `data.digestSettings` 从 `{digestProvider,digestModel}` 扩为 **`{enabled,digestProvider,digestModel}`** |
| PUT | `api/dsh-supermemory/settings` | body 可带 `enabled` 布尔并落盘；只带 `enabled` 也算合法请求；非布尔 → 400 `BAD_INPUT`；响应 `{ ok:true, data:{ enabled, digestSettings } }` |
| POST | `api/dsh-supermemory/digest` | 关闭 → **409 `{ ok:false, code:'PLUGIN_DISABLED' }`**（拦截点在 method 校验之后、读 body 之前） |

`digestProvider` / `digestModel` 的既有校验与行为**完全不变**（仍是「非字符串 → 400」，
空串表示「跟随当前会话」，三者全缺 → 400）。

`enabled` 对外呈现时**只取运行时权威判定**（`pluginEnabled()`），不回显客户端传来的值：
存储层没真正落地这一位时，响应必须回带 `true`，否则界面会出现「显示已关闭、其实还在
注入」的错觉——这是本次改动最不允许出现的状态。

## V3.6 客户端（`lib/client.js`、`locale/*.json`）

- **设置页**顶部新增总开关卡片：`sm-card` + 新增 `sm-switch` 滑块（`role="switch"` +
  `aria-checked`，只用 §9 白名单 token），当前状态用 `common.on` / `common.off` 显示，
  点击调 `PUT settings { enabled }`。
- **乐观更新 + 失败回滚**：点击即翻转界面 → 发请求 → 失败立即回滚到原值并显示
  `settings.enableFailed`；成功以服务端回带的布尔为准；服务端没回带布尔时再读一次
  `bootstrap` 确认，确认不到就退回原值并报 `settings.enableUnknown`。
- **面板**顶部：关闭态挂一条 `sm-notice sm-notice-warn`（`panel.disabledNotice`），
  并把「立即整理」按钮 `disabled`（`title` 用 `panel.digest.disabledHint`）；
  `runDigest` 内再挡一层，避免按钮刚失效时的竞态请求。
- 新增词典键（en/zh 与 `lib/client.js` 内嵌词典三方逐键一致，共 9 个）：
  `panel.disabledNotice`、`panel.digest.disabledHint`、`settings.enable`、
  `settings.enableRow`、`settings.enableHint`、`settings.enableAria`、`settings.enableBusy`、
  `settings.enableFailed`、`settings.enableUnknown`。

## V3.7 测试要求

`test/routes.test.js` 新增覆盖：bootstrap 回带 `enabled`（含 false）、`isEnabled` 缺失/抛错
视为开启、`PUT settings` 写 `enabled` 生效且不影响既有两键、`enabled` 非布尔 → 400 且
不落盘、存储层没落地时回带真实状态、关闭时 `POST digest` 409 `PLUGIN_DISABLED` 且
`runDigest` 未被调用、关闭时 `doc` 读写仍 200、关闭时其余 GET/PUT 一律不 403/404。

**基线**：v2 的 263 个既有用例一个都不许挂；因 `digestSettings` 扩了 `enabled` 而必须同步
更新的既有断言，只允许改 `test/routes.test.js` 内的期望值。

## V3.8 词法检索、压缩补偿与子代理默认值

### 检索：`lib/core/search.js`（新增纯函数模块）

`memory` 工具的 `search` 不再是整串子串匹配。三个导出，全部无 IO、无宿主依赖：

- `queryTerms(query)`：NFKC 折叠 → `[\p{L}\p{N}_-]+` 词元 → 连续汉字再补相邻
  二元组；长度 ≤ 1 的词元丢弃；总数截 64；非字符串返回 `[]`。
- `scoredLines(content, terms, limit)`：按**条目块**聚合打分。行角色权重
  标题 4 / 条目头 2 / 正文 1，乘以块内命中的去重词元数；多词元查询要求块内
  命中 ≥ 2 才入选，用来刷掉二元组的单点噪音。
- `literalLines(content, needle, limit)`：切不出词元时（单字、纯符号）的整串
  子串兜底，行为与升级前一致。

`lib/host/tools.js` 只有 `doSearch` 与顶部 import 变动；输出形态不变
（`- [scope:line] text`），`matches` 多一个 `score` 字段。四个分区改为**全局按
分数排序后再截 `MAX_MATCHES = 40`**，否则先扫的分区会被噪音占满名额。

### 压缩补偿：`lib/host/inject.js`

宿主一次成功压缩连写三条事件：`compaction/start`、`compaction/summary`（携带
`shadowedRange` / `shadowedSeqs`）、以及一条 `source.kind === 'compact-checkpoint'`
的 `user/message`，用 `surfaceOp: replace` 替换整段区间。被吞节点从
`surface.nodes` 彻底消失，但事件仍留在 append-only 日志里——**判存活看 surface，
判发生过压缩看日志，缺一不可**。

- 新增导出 `compactionState(session) => { seq: number, shadowed: Set<number> }`：
  `seq` 是最后一条 `compaction/summary` 的 seq（从未压缩过为 `-1`），`shadowed`
  是全部 `compaction/*` 的 `shadowedSeqs` 并集；整体 try/catch，读盘失败降级为
  `{ seq: -1, shadowed: ∅ }`。
- `lastSnapshotEvent(session, shadowed?)` 新增**可选**第二参，旧调用零影响。
  surface 可用时行为完全不变；surface 不可用时改用遮蔽集排除，替掉原先
  「一律返回 true」的退路。**不收紧这一条会造成永久失忆**：被压缩吞掉的旧快照
  被当作存活，digest 又与本轮一致，于是永远命中「内容未变不重复写入」。
- `needsResync = recallEnabled && (old === undefined ? compaction.seq >= 0
  : compaction.seq > old.seq)`；命中时即使 digest 相同也重写。重写产生的新 seq
  必然大于压缩 seq，判定自动收敛，**无新压缩时只写一次**。
- 补偿只重写既有快照：正文与 digest 逐字节不变，**不往记忆里掺「上下文已压缩」
  这类提示**（进了正文要么污染 digest 造成抖动，要么让正文与 digest 语义分叉）。
- 已知残留风险（改动前后同级）：surface 不可用时 `replaceSnapshot` 传的
  `old.seq` 可能已不在 surface 上，会被宿主拒并降级为一条 warn，那一轮不注入。
  不用 append 兜底是刻意的——那会让 surface 上出现两条快照，违背「恒一条」。

### 子代理默认值反转：`injectIntoSubagents` true → `false`

**两处门控，缺一不可**（实测踩过：只改 pre-step 会留下半开状态）：

- 记忆快照：`agent/pre-step` 里 `config.injectIntoSubagents === false &&
  deps.isSubagent(agent)` → 跳过写入。（这条早就存在，只是默认值是 true。）
- 人格 section：`prompt.section({ text })` 的回调此前写成 `text: () => {...}`，
  把入参整个丢掉了，于是**人格与画像对所有 agent 一视同仁**，子代理照样带着
  人格跑。现改为 `text: (assembly) => {...}`，用 `assembly?.agent` 走与 pre-step
  **完全相同**的判定条件。`assembly?.agent` 为空（非 agent 触发的组装，如会话
  标题生成）时保守视为非子智能体，保持注入。
  ⚠️ `AssembleContext` 的类型声明只列了 `scope` / `signal`，**不要据此断定
  回调拿不到 agent** —— 运行时带，参照实现就是读 `assembly?.agent`。

默认值本身要**四处一起改**，漏任何一处都不生效或测试挂：

1. `lib/host/config.js` 的 zod `.default()` 与 DEFAULTS 冻结常量（**两处必须一致**）。
2. `cordis.patch.yml` 写**显式 `injectIntoSubagents: false`**。实测本机 web profile 的
   配置树里从未落过 supermemory 的 config 段（`grep 'id: supermemory'
   ~/.dsh/profiles/web/cordis.patch.yml` 无命中；安装走 profile `package.json` 的
   `link:` + include 列表，配置每次从**包内** patch 读取）。所以删掉这行同样会走
   新默认值，并不会被残留的 `true` 压住——「patch insert 语义会残留旧值」这个推断在
   本机的 link 安装方式下**不成立**。保留显式 `false` 的真正理由是：让默认值反转在
   配置文件里可见，不要求读者去翻 zod 默认；若日后改成复制到 profile 的安装方式，
   显式 `false` 也依然是更安全的那一侧。
3. `test/paths-document.test.js` 的 defaults 常量与「非布尔回退默认」期望值。
4. `lib/client.js` 设置页配置示例文案（仅那一行字符串）。

新增配置 `compactionRecall`（布尔，默认 `true`，`.volatile()`），门控写
`config.compactionRecall !== false`，缺失视为开启——沿用 §V3.4 的判定铁律。

**基线**：344 个用例全绿（v3 的 304 + `search.test.js` 23 + `compaction-recall.test.js`
10 + 子代理默认值 5）。既有用例只允许改期望值，不许删。

## V3.9 记忆条目的事实性守则

写入记忆的每条只描述**当前为真**的状态，像在写一份今天的说明书，不记录抵达这里的过程。

- **不记变更史**：不写「原先是 A，后改为 B」「已从 X 迁移到 Y」「v2 起…」，也不写数量前后对比——直接写当前结论（「测试基线是 344 个用例」）。
- **不记未来规划**：计划、待办、下一步、将来可以、尚未实现，一律不写。
- **允许因果，但仅限帮后来者避开现行陷阱的因果**：「不要用 `node --test test/`，本机 Node 24 会把它当模块解析」可写；「之所以拆成 7 个文件，是因为原先 `routes.js` 太长」这类修改动机不写。
- **与现有记忆冲突时输出当前结论本身**，不写成「X 已改为 Y」的对比句。
- **自测**：一年后读到这条，它还成立吗？不成立就别写。

守则有两个生效出口，语义同一套，文案各自语言：整理器的 system 提示词
`lib/host/digest-input.js` 的 `DIGEST_SYSTEM_PROMPT`（中文）与 `memory` 工具描述
`lib/host/tools.js` 的 `DESCRIPTION`（英文，`FACTUAL STYLE:` 那一项）。

既有约束不变：`soul`/`user`/`global` 永不自动写（§V2.3）、soul 手动写仍需 `confirmSoul: true`
（§V2.5）。整理器写回仍是追加（append-only），新条目与旧条目的冲突由后续整理收敛——本守则
只约束新写入，未引入改写或删除既有条目的能力。

**基线**：350 个用例全绿，其中 `test/digest-prompt.test.js` 6 例守护本节文案——断言取「包含关键
片段」式，改标点不红，删守则或弱化它必红；另有一例要求被禁措辞（计划、原先、后改为…）只能
出现在带否定线索的行里，防止提示词自相矛盾，**新增正面使用这些词的规则时需同步改该用例，这是
设计意图而非误报**。

**守则共用常量的准入规则**：整理器有两种模式（§V4.0），两种模式共用同一段守则常量，因此**每一句
必须同时是追加时的要求、也是整编时的要求**。描述系统能力或某个模式独有前提的句子（「系统当前只能
追加」「旧条目不会被清除」）属于该模式自己的规则区，写进共用常量就会在另一种模式里变成错误指令——
§V3.9 首版就犯过一次，第 5 条带着「只能追加」被照抄进整编提示词，等于命令整编不许删除。`test/
consolidate-input.test.js` 断言两个提示词的守则段逐字相等，防止两边各漂各的。

**当前文案规模**：追加模式 system 提示 902 字符（UTF-8 2220 字节），整编模式 1546 字符（UTF-8
3676 字节）。

## V4.0 整理器整编模式（consolidate）

整理器有两种模式，同一次调用只走一种：`append`（既有行为，追加新条目）与
`consolidate`（整编：合并重复、改写过时、删除失效，产物是 project 记忆的**目标态**）。
整编只作用于 `project`，`soul`/`user`/`global` 永不自动写的约束不变（§V2.3）。

### V4.0.1 条目 id（`lib/core/document.js`）

条目头行扩展为 `- <time> · source:<source> · id:<id>`，第三段**可选**，旧文件照读。

```js
ENTRY_HEAD = /^-\s+(\S+)\s+·\s+source:\s*(\S*)(?:\s+·\s+id:(\S+))?\s*$/
deriveEntryId(time, body) -> string          // sha1(time + '\n' + body) 的 hex 前 5 位
parseEntries(text) -> Array<{ id, time, source, body }>
renderEntry(entry) -> string                 // entry.id 形如 /^[0-9a-f]{5,9}$/ 时才输出 · id:
rebuildDocument(text, entries) -> string     // 整篇条目区替换，preamble 原样保留
```

- `parseEntries` 在条目头没有 `id:` 段时**派生**一个 id（`deriveEntryId`），不落盘；同一份文本
  多次解析得到同一批 id。显式 id 优先于派生 id。
- 一份文档内 id 必须唯一：派生 id 与显式 id 相撞时，把派生 id 逐位延长（5 → 7 → 9）直到不撞。
- `appendEntries` 行为**完全不变**（不自动补 id），`renderEntry` 只在 `entry.id` 合法时输出该段。
- **`id` 与 `explicitId` 都是不可枚举自有属性**：`entry.id` 照常可读，但 `Object.keys(entry)` 只有
  `time` / `source` / `body`。这是刻意的，换来的性质更重要——`renderEntry` 见到不可枚举的
  `explicitId === false` 就不输出 id 段，于是**任何人把 `parseEntries` 的结果直接喂给
  `rebuildDocument` 都不会把派生 id 写进用户的记忆文件**，"派生 id 不落盘"由结构保证而不靠调用方
  自觉。代价也已钉进用例：`{ ...entry }.id === undefined`、`JSON.stringify(entry)` 不含 id——需要
  id 时必须读 `entry.id`，展开对象会静默丢掉它。手工构造 `{ id: 'a3f2c', ... }`（无 `explicitId`）
  视为显式 id，照常渲染。
- `rebuildDocument(text, entries)` 取原文本**第一个条目头之前**的全部内容（一级标题、维护注释、
  用户手写说明段）作为 preamble 原样保留，条目区由 `entries` 重新渲染。原文本没有条目头时
  整段视为 preamble，条目追加其后。
- **`rebuildDocument` 是整编唯一的落盘构造方式**；不许用字符串替换去改条目。

### V4.0.2 整编输出与对账（`lib/core/consolidate.js`）

整编模式的模型输出格式（单行 JSON，无围栏）：

```json
{"entries":[{"text":"…","from":["a3f2c"]}],"drop":[{"id":"b8e01","reason":"…"}]}
```

- `from` 为空数组 = 全新条目；`from` 列出的每个 id 都是被这条新条目吸收/取代的旧条目。
- `drop` 用于「事实已失效且无替代」的条目，`reason` 必填。

```js
extractJsonObject(text) -> object | null   // 唯一容错真源是 digest.js 的 pickJsonObject(text, prefer)
parseConsolidateOutput(raw) -> { ok:true, entries, drop } | { ok:false, error }
applyConsolidation(oldText, parsed, options) -> result
// options: { time?: string, source?: string, minKeepRatio?, maxDropRatio? }
//          time 缺省当前时间，source 缺省 'digest'
// result:  { ok:true, text, counts:{added,merged,dropped,kept}, absorbedIds, droppedDetail,
//            ghosts, duplicates, suspects }
//        | { ok:false, reason:'SHRINK_GUARD'|'DROP_GUARD'|'EMPTY', bytesBefore, bytesAfter }
shouldConsolidate({ enabled, entryCount, bytes, minEntries, minBytes, lastConsolidateAt, cooldownMs, now })
  -> { consolidate: boolean, reason: 'disabled'|'below-threshold'|'cooldown'|'entry-count'|'bytes' }
```

**counts 语义是对外契约**（面板与 `/memory-digest` 文案都依赖它）：`added` = 本次写入的新条目数，
**含合并与改写的产物**，所以结果条数恒等于 `kept + added`；`merged` = 被吸收的旧条目数。文案用
「写入」而不是「新增」，因为后者会被读成净增条数。

**容错 sanitize**：id 类字段（`from[]`、`drop[].id`）只接受字符串——把 `42` 变成 `'42'` 只会造出
指向虚无的引用；`text` / `reason` 容忍非字符串；`entries` 里写成纯字符串的项按「纯新增条目」收下；
`from` 转小写并去重。

对账规则（`applyConsolidation`，纯函数，不碰磁盘）：

1. 旧条目来自 `parseEntries(oldText)`，全部带 id。
2. `from` / `drop` 里引用不存在的 id → **忽略该引用**，id 收进返回值的 `ghosts`，不影响其余。
3. 被任一 `from` 吸收的旧条目：从结果中移除，由该条新条目替代。
4. 被 `drop` 命中的旧条目：移除，`droppedDetail` 记录 id 与 reason。
5. **既没被吸收也没被 drop 的旧条目：原文原时间戳原样保留**——这是"模型漏写不会丢记忆"的保证。
6. 顺序：按旧条目原顺序遍历，新条目插入在其吸收的第一条旧条目原位；`from` 为空的纯新条目
   追加到末尾。
7. 栅栏（两道，任一命中即 `{ok:false}`，调用方**不写盘**）：
   - `SHRINK_GUARD`：产物字节 < 原文字节 × `minKeepRatio`（默认 **0.15**）——防「20 条压成一句话」。
   - `DROP_GUARD`：`dropped` > 旧条目总数 × `maxDropRatio`（默认 **0.5**）且 `merged == 0`——
     纯删一半以上而没有任何合并动作，判为异常。
   - `EMPTY`：产物条目数为 0 而原文条目数 > 0。
   整编的正常缩水是**期望行为**，所以栅栏只兜极端退化，不设「不许变短」类阈值。
8. 同一个旧 id 被两条以上新条目的 `from` 认领 → 第一个吸收者生效，其余引用忽略并记入
   `duplicates`。它与 `ghosts` 分开是因为病因不同（查无此 id vs 重复认领），混进一个字段会让人
   误判模型输出质量；`merged` 只算一次，结果不会凭空多出替代品。
9. `drop` 认领一个已被 `from` 吸收的 id → 静默忽略，既不记 `droppedDetail` 也不记 `ghosts`
   （模型常先合并再顺手补一条 drop，这不算异常）。
10. `suspects` 是线索字段，不是栅栏：模型改写了某条却漏写 `from` 时，旧条目按规则 5 保留、新条目
    也在结果里，文档会出现内容重复的两条。这是**可接受的退化**（重复但不丢，下次整编还能收），但
    要把线索留下，让人发现「模型漏写 from 了」。判定：正文折叠空白与标点、转小写后前 40 字符指纹
    相同（折叠后不足 8 字符不参与，否则短正文满屏误报）；一条旧条目最多报一次，不参与栅栏、不影响
    `ok`。

`shouldConsolidate` 的判定顺序是 开关 → 规模（条目数或体积任一达标）→ 冷却；`minEntries` /
`minBytes` 缺省取 §V4.0.4 的 20 / 12288，这样 config 缺键也不会永久压制整编；`lastConsolidateAt`
是非法时间串时按「没整编过」放行。

### V4.0.3 整编提示与输入（`lib/host/digest-input.js`）

```js
export const CONSOLIDATE_SYSTEM_PROMPT: string
buildConsolidateInput(docs, transcriptLines, maxBytes)
  -> { ok:true, input: string } | { ok:false, reason:'INPUT_OVERFLOW'|'NO_PROJECT' }
```

- `CONSOLIDATE_SYSTEM_PROMPT` 只要求输出 V4.0.2 的 JSON，并**逐字沿用 §V3.9 的 6 条事实性守则**
  （整编是清洗变更史的主战场，两者必须同源；建议把守则文本抽成共用常量再由两个提示拼接）。
- 输入的「现有记忆」区把每条 project 条目渲染成 `[<id>] <body>`，供模型引用；**project 记忆
  正文一律不截断**——截断等于让模型照着残缺稿重写，会丢条目。
- 超预算时按**三级降级**，project 正文任何情况下都不截断：① 从对话尾部丢消息，可丢到 0 条；
  ② 仍超则压缩 soul/user/global 三份参考（各按 `max(1024, limit/12)` 截尾）；③ 仍超才返回
  `{ok:false, reason:'INPUT_OVERFLOW'}`，本次不整编。参考区只是去重与冲突上下文，压缩它们不损失
  任何要落盘的信息，多保住一次整编机会比保住参考原文更有价值。
- soul / user / global 三份在整编输入里只作为去重与冲突上下文，可截断。

### V4.0.4 配置（`lib/host/config.js`）

只读 `cordis.patch.yml`，**不进 `settings.json`**（面板不提供这些开关）：

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `digestConsolidate` | boolean | `true` | 整编模式总开关 |
| `digestConsolidateMinEntries` | integer ≥1 | `20` | 条目数阈值 |
| `digestConsolidateMinBytes` | integer ≥1024 | `12288` | 体积阈值 |
| `digestConsolidateCooldownMs` | integer ≥0 | `21600000` | 两次整编最小间隔（6 小时） |
| `digestConsolidateMaxOutputTokens` | integer ≥256 | `6000` | 整编调用输出上限 |
| `digestSnapshotKeep` | integer ≥1 | `3` | 落盘前快照保留份数 |

非法值回退默认，规则与既有 `readNumber` / `readBoolean` 一致。§V3.8 的「四处一起改」对这 6 项的
适用情况：第 1、2、3 处照改（zod `.default()` + `DEFAULTS` / `cordis.patch.yml` 显式值 /
`test/paths-document.test.js` 的 defaults 常量）；**第 4 处 `lib/client.js` 豁免**——这些阈值不进
面板，设置页不放开关。

`writeDocSnapshot` 的两处语义补记：`keep` 非法回退 3、小于 1 钳到 1（否则会出现「刚写完就把自己
删掉」）；裁剪排序用**码点字典序**而非 `localeCompare`（后者按 locale 给连字符降权，会破坏「定长
时间戳 ⇒ 字典序即时间序」这个前提）。裁剪只处理符合快照命名的文件，快照目录里别人放的东西既不
保留计数也不删除。

### V4.0.5 落盘前快照（`lib/core/store.js`）

```js
writeDocSnapshot(ref, content, keep = 3) -> { ok:true, path, removed } | { ok:false, error }
```

- 位置：该文档同目录的 `history/` 子目录，文件名 `<原文件名去扩展>-<yyyyMMdd'T'HHmmss'Z'>-<4hex>.md`。
- 内容：本次整编**替换掉的那份原文**，逐字节。
- 裁剪：按文件名时间序保留最近 `keep` 份，多余删除。
- 只在整编真正要写盘之前调用；追加模式不产生快照。快照目录随文档走，`.dsh/` 已被 `.gitignore` 排除。
- 不提供回滚 API：恢复方式是人工从 `history/` 拷回，刻意不做自动回滚以免误覆盖新内容。

### V4.0.6 编排与运行报告（`lib/host/digest.js`）

`execute` 的分支：读 project → 数条目与字节 → `readRuns` 查最近一次成功的整编时间 →
`shouldConsolidate` 决定模式 → 走对应路径。

- 整编路径的**任一步失败**（`INPUT_OVERFLOW` / 解析失败 / `SHRINK_GUARD` / `DROP_GUARD` /
  `EMPTY` / STALE / 快照失败）都**不写盘、也不退回去跑一次追加调用**，只在 RunRecord 里记
  `ok:false` 与 `error`，等下一轮重新评估。整编的产物本身已含新增条目，失败即本轮不写。
- **快照失败同样拒绝覆盖**：快照是这条路径上唯一的安全网，网没张开就不做有丢数据风险的动作。
  所以 `writeDocSnapshot` 缺失或返回 `{ok:false}` 时结果是 `error: 'snapshot failed: …'`，
  而不是"跳过备份继续写"。
- **模式判定本身出错就走追加**（保守侧），不因 `parseEntries` / `readRuns` 抛异常而让整次整理失败。
- 落盘前重读一次文档：mtime 与本次开始读取时不一致 → 判 STALE 放弃，**不拿旧底稿覆盖新内容，
  也不半途重算一遍对账**（半途改判会让已算出的栅栏结论与待写内容来自两份不同的底稿）。
- `RunRecord.counts` 的四个 key（soul/user/global/project）与既有语义**完全不变**；
  整编模式 `counts.project` = 本次写入的新条目数（`added`，含合并产物，见 §V4.0.2）。
  整编细节写在**新增字段**：

```js
record.mode = 'append' | 'consolidate'
record.consolidation = {
  added, merged, dropped, kept,
  ghosts: [id], duplicates: [id], suspects: [id],
  snapshot: '快照绝对路径' | null,
}
```

  `suspects` 只存 id（明细可能很长，运行报告只留线索）；`snapshot` 存绝对路径，因为它是给主人
  手工恢复用的，路径可定位比好看重要。**没有 rollback API 是有意设计**：恢复方式就是把快照文件
  复制回 `.dsh/memory/project-memory.md`，插件不代做这个决定。

  既有面板、`/memory-digest` 文案、`runs` 接口对老记录的行为不变；新字段存在时才额外展示整合明细。

### V4.0.7 测试归属

`test/document-entry-id.test.js`、`test/consolidate-core.test.js`（id 往返与对账）、
`test/consolidate-input.test.js`（提示与输入预算）、`test/store-snapshot.test.js` 与
`test/config-consolidate.test.js`（快照与配置）、`test/injection-trigger.test.js` 内的整编编排用例。
