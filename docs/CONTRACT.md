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

---

# v5 变更：人设的重命名与删除

v2 起人设只能「切换」和「新增」。本节补上「重命名」与「删除」，并**逐项定义删除
要牵连什么**——人设的删除不是删一个目录那么简单，注册表、进程内缓存、正在运行的
会话注入都沾边，漏一项就会出现幽灵条目或旧记忆复活。

## V5.0 三条产品决策（已与用户确认，不再讨论）

| 决策 | 取定 | 理由 |
|---|---|---|
| 重命名是否改目录名（slug） | **只改显示名 `name`，slug 与磁盘目录不变** | 改 slug 会让在跑的会话注入路径突变、`history/` 快照错位、`runs.jsonl` 里记的旧 persona 对不上。收益只是「磁盘目录名好看」，不值。 |
| 删除下限 | **默认人设永久禁删，判定为大小写不敏感 `slug.toLowerCase() === 'default'`**，其余可删到只剩它一个 | 正确的理由是：它是 `index.js` 唯一自动创建的人设、面板下拉里唯一恒在的条目。**不要**写成「Default 是 `resolveScope` / `personaKey` 的兜底键」——那些兜底键是小写 `default`，`Default` 不是任何地方的兜底键，两者详见本节末「已知缺陷」。 |
| 删除可恢复性 | **直接 `rm -rf` 该人设目录**，不建回收目录 | 用户明确要求「都要删除」；界面用内联二次确认兜住误操作。 |

两个新按钮都作用于**面板下拉当前选中的那个人设**（要改/删别的先切过去），
不做多行管理列表——界面复杂度是本功能的第一约束。

**边界：注册表里可能压根没有 `default` 条目。** `deletePersona` 守的是「不许删 slug 为
`default` 的人设」，不是「列表里恒有 default」。真实运行下 `lib/index.js` 启动时会
`createPersona('Default')` + `setCurrentPersona`，所以条目通常恒在；但只把 `personas/`
目录拷到新机器、没有 `personas.json` 时，`reconcileRegistry` 只登记扫到的目录，
**不会凭空补一条 default**。此时删掉最后一个非 default 人设会得到 `personas: []` +
`current: null`——这不是 bug：注入回退 `'default'` 空模板，下一次启动 `index.js` 的初始化
发现列表为空会重新补建 Default，可自愈。禁止把它"修"成删除时报错或凭空造条目。

## V5.1 数据模型：不变

`personas.json` 与 `personas/<slug>/` 的结构与 v2 完全一致（§V2.1），本节不新增字段、
不改落盘形态。`name` 本来就只存在于注册表，重命名只是写它。

## V5.2 存储层新增 API（`lib/core/store.js`）

```js
renamePersona(slug, name)
  -> Promise<{ ok:true, persona:{ slug, name, createdAt, dir } }
            | { ok:false, code:'BAD_INPUT'|'NOT_FOUND'|'UNWRITABLE', message }>
deletePersona(slug)
  -> Promise<{ ok:true, deleted:{ slug, name }, current:{ slug, name }|null }
            | { ok:false, code:'BAD_INPUT'|'PERSONA_PROTECTED'|'NOT_FOUND'|'UNWRITABLE', message }>
```

两者都 `await ready`，都在 `enqueue(personasPath, ...)` 里跑，与 `createPersona` /
`setCurrentPersona` 共用同一条注册表串行队列。

**slug 一律「先查表，再拼路径」**：先在 `personasState.personas` 里**逐字**匹配，
匹配不到直接 `NOT_FOUND`，**不做 `personaSlug()` 归一化**。这是安全要点——归一化会把
`../../etc` 变成 `..-..-etc`，反而可能命中磁盘上真实存在的同名目录。查表匹配天然只
能命中注册表里的人设，越界无从发生。

### renamePersona 细则

1. `name` 去空白、`[...name].slice(0, MAX_PERSONA_NAME)`（60 码点）；空 → `BAD_INPUT`。
2. 只改 `entry.name`，`slug` / `createdAt` / 目录一概不动。
3. `persistRegistry` 失败 → 把 `name` 改回原值再返回 `UNWRITABLE`（内存不留脏值）。
4. **不写 `persona.json`**：`reconcileRegistry` 只在注册表缺该 slug 时才用目录元数据
   重建 name，注册表有条目时该文件里的 `name` 不参与显示。多写一个文件只会多一个失败面。
5. 返回的 `persona.dir` 仍是原目录（调用方据此知道「目录没动」）。

### deletePersona 细则

默认人设的禁删判定走 `isDefaultSlug(slug)`（`slug.toLowerCase() === 'default'`），
放在**任何 IO 之前，包括 `await ready`**——这条判定不吃任何磁盘状态，禁删不该被迁移
流程牵制（`ready` 里含迁移 IO）。之后按此顺序，
原则是**宁可残留目录，也绝不留幽灵条目**：

> **大小写铁律（一次真实事故换来的，勿退回逐字比较）**
> 禁止用 `slug === 'default'` 判定默认人设。`personaSlug()` 原样保留 Unicode 字母的
> 大小写，`createPersona('Default')` 产出的 slug 就是大写 `Default`；而 `personaKey()`
> 的兜底值是小写 `'default'`。**两者不是同一个字符串**，逐字比小写在真实宿主上
> 永远不命中——`DELETE /personas {"slug":"Default"}` 曾经真的删掉了默认人设。
> `pickSuccessorCurrent` 里挑接班人的比较同样必须大小写不敏感，否则删掉当前人设后
> 会跳过默认人设去选 `createdAt` 最早的那个。
> **测试必须用真实大写 `Default`**：只测小写 `'default'` 的用例全绿也挡不住这个事故，
> 这是本次缺陷活到真实验证阶段的直接原因。

1. 查表匹配，无 → `NOT_FOUND`。
2. 内存里摘条目 + 迁移 current → `persistRegistry`。写失败**立即返回 `UNWRITABLE`，
   此时磁盘尚未被动过**，状态完全自洽。
3. `rm(join(personasRoot, slug), { recursive:true, force:true })`。失败（`ENOENT` 除外）
   → 把条目插回**原位置**、`current` 复原、再 `persistRegistry` 一次、返回 `UNWRITABLE`。
4. `personasState` 指向新注册表。
5. **清进程内缓存**：遍历 `cache.keys()`，删掉所有以 `<dir>/` 为前缀的条目。
   **为什么必须清（实测结论，勿照抄成"重建同名 slug 的时序问题"）**：Store 有两条读路，
   危险程度不同。`readDoc` → `readInner` 会先 `stat`，文件没了就顺手丢缓存，**自愈**；
   而 `readDocSync` **压根不 stat，只读 cache**。人格与画像的 systemPrompt section
   （`lib/host/inject.js` 的 `readBodySync`）走的正是 `readDocSync`，而 section 读的
   `activeScope.persona` 在删除后到下一次 `loadScope` 之前仍是**已删的那个 slug**——
   不清缓存，已删人设的人格会继续往 system prompt 里灌。
   由此得到一条测试要求：**"漏清缓存"的回归用例必须打在 `readDocSync` 上**，
   用 `readDoc` 断言的用例是抓不到这个 bug 的（它会自愈，永远绿）。

**current 迁移顺序**（仅当被删的就是 current）：
`'default'`（若在剩余列表里）→ 剩余里 `createdAt` 最早的一个 → `''`（注入回退 default 空模板）。

### 删除的关联清理清单（逐项落实，这是本节的验收核心）

| 对象 | 处理 |
|---|---|
| `personas/<slug>/` 整个目录（`soul.md` / `user.md` / `global-memory.md` / `persona.json` / `preset.json` / `history/` 全部快照） | ✅ 删除 |
| `personas.json` | ✅ 移除条目；被删的是 current 时按上面的顺序迁移 |
| store 进程内 `cache` | ✅ 删掉该目录下所有路径的条目 |
| 正在运行会话的注入快照 | 🔄 **自动收敛，不写任何补偿代码**：下一轮 `agent/pre-step` 解析到新 persona，四段正文变 → `buildSnapshot` 的 digest 变 → `replace` 旧快照，surface 恒为一条。四段全空时走既有的 `EMPTY_DIGEST` 占位分支。 |
| `runs.jsonl` | ⏸ 不改写。历史整理报告里的 `persona` 是既成事实记录，抹掉等于伪造历史。 |
| `projects.json`、各项目 `.dsh/memory/project-memory.md` | ⏸ 不动。项目记忆跟人设无关（§V2.1）。 |
| `deps.readActiveContext()` | ⏸ 陈旧到下一次 pre-step。面板只读它的 `projectRoot`，不读 persona，无可见影响。 |

**已知边界（不是 bug，勿修）**：极端并发下（后台整理恰好正在写该目录），`rm` 之后
目录可能被 `writeAtomic` 的 `mkdir` 重建为孤儿目录。注册表已无条目 ⇒ 面板不显示、
注入不读取，只在下一次启动时被 `reconcileRegistry` 重新登记。为它加锁不划算。

## V5.3 装配与访问层

- `lib/index.js`：`deps.personas` 增加 `rename: (slug, name) => store.renamePersona(slug, name)`
  与 `remove: (slug) => store.deletePersona(slug)`。
- `lib/host/access.js`：`personaApi()` 用**同一个 `wrap` 工厂**加 `rename` / `remove` 两键，
  装配层优先、回退 `store.renamePersona` / `store.deletePersona`（§V2.2 的双通道口径不变）。

## V5.4 路由（`lib/host/routes-settings.js` 的 `handlePersonas`）

| 方法 | path | body / query | 说明 |
|---|---|---|---|
| **PATCH** | `api/dsh-supermemory/personas` | `{ slug, name }` | 改显示名。`name` 复用 POST 那套校验（非空、≤60） |
| **DELETE** | `api/dsh-supermemory/personas` | `{ slug }`，回退 `?slug=` | 删除人设及其全部记忆文件 |

1. **响应体与 GET/POST/PUT 完全同构**：一律 `sendOk(res, await personasData())`，
   即 `{ personas, current }`。客户端一处刷新逻辑通吃，不做专用响应形状。
2. 错误映射：`BAD_INPUT`→400、`NOT_FOUND`→404、`PERSONA_PROTECTED`→409、其它→500。
   `slug` 缺失 / 空白一律 400。取法上两者不同，是刻意的：`PATCH` 是「带正文的写」，
   **只从 body 取 `slug`**；`DELETE` 允许 `body.slug` 回退 `?slug=`（空 body 经
   `readJsonBody` 得到 `{}`，纯 query 形态因此可用）。不要把 PATCH 也放宽成读 query。
   store 返回 `ok:false` 却没带 `code` 时，兜底码用 `PERSONA_RENAME_FAILED` /
   `PERSONA_DELETE_FAILED`（照 POST 的 `PERSONA_CREATE_FAILED` 风格），状态 500。
   这两个码只面向日志与排查，**不进 locale**——界面展示的是 `error` 文本。

   **query 形态的 slug 必须百分号编码**（真实 node:http 实测，非推测）：请求行里出现
   非 ASCII 字节会被 HTTP parser（llhttp）直接判非法，返回 **`400 Bad Request` 且
   响应体为空，请求根本不进插件 handler**——curl 在这种情况下还是 `exit 0` + 空输出，
   是个排障陷阱。编码形态 `?slug=%E4%B8%B4...` 实测 200 且目录真删。
   `queryOf` 的 percent-decode 已验证逐字等值（中文码点原样传到 store 参与查表）。
   **禁止给 DELETE 分支加 `decodeURIComponent`「修」这个问题**：`queryOf` 已经做了唯一
   正确的一次解码，再解一次会让 slug 反向错配，直接破坏 §V5.2 的
   「逐字匹配、不做归一化」安全前提。**危害等级不是"删不掉"而是"删错人设"**：
   若注册表里同时存在 `50%25测试` 与 `50%测试`，加了 decode 之后删前者会**静默删掉后者**。
   纯中文 slug 二次解码后值不变，所以中文用例对这个错误免疫——守它必须用带 `%` 的 slug。
   客户端走 body（JSON UTF-8，中文实测无问题），不受影响。
   三种响应可精确区分现场，按它排障：

   | 响应 | 含义 |
   |---|---|
   | `400` + **空 body** | 裸非 ASCII 请求行，parser 拒绝，未进 handler |
   | `400` + `BAD_INPUT` | 进了 handler，但 slug 没取到（空值 / shell 变量为空） |
   | `404` + `NOT_FOUND` | 解码成功，逐字查表未命中 |
3. **不加 `pluginEnabled()` 拦截**。v3 铁律「关闭态 `personas` 一律不拦」（§V3.5）在这里
   格外重要：拦了就等于关掉插件后永远删不掉人设。
4. `webServer.register` 是 `kind:'exact'` + handler 内分派 method，**不需要新注册路由**；
   只需把末尾的 405 兜底保持为「其余 method 才 405」。信任栅栏与 method 无关，不改。
5. `DELETE` 走 `readJsonBody`（空 body 返回 `{}`，所以纯 query 形态也可用）。

## V5.5 客户端（`lib/client.js`、`locale/*.json`）

顶部工具栏人设组三态**互斥**，且与「+ 添加人设」的内联表单互斥：

```
idle   : 人设 [下拉 ▾] [✎] [🗑]  [+ 添加人设]
rename : 人设 [下拉 ▾] [输入框(预填当前显示名)] [保存] [取消]
delete : 人设 [下拉 ▾] 确定删除「灰灰」及其人格、画像与全局记忆？此操作不可撤销。 [删除] [取消]
```

- 状态两位：`personaAction: 'idle'|'rename'|'delete'`、`renameValue: string`。
  `selectPersona` / `createPersona` / 任一新表单打开时，其余表单一律复位 `idle`。
- **重命名不发文档重载**：人设名不参与任何路径计算，PATCH 成功后只需刷新 bootstrap
  拿新显示名。
- **删除成功必须**：刷 bootstrap → 把本地 `persona` 置为响应 `current.slug` → 清 `drafts`
  与 `docs`（让 `loadDocs` effect 重跑）→ 提示 `panel.personaDeleted`。
- 🗑 禁用条件：选中 slug 是默认人设（**大小写不敏感**，见 §V5.2 的大小写铁律；`title` 给
  原因）或 `busy`；✎ 仅 `busy` / 无人设时禁用。`lib/client.js` 不能 import store，所以
  这里与 `lib/core/store.js` 的 `isDefaultSlug` 是**刻意的重复实现，两边必须同口径**，
  改一边就要改另一边。只测小写 `default` 的用例挡不住这个缺陷。
- 新增两个内联 svg 组件 `PencilIcon` / `TrashIcon`（照 `MemoryIcon` 风格，size 14，
  `aria-hidden:"true"`，按钮另给 `aria-label`）。
- 新增 CSS 两条，只用 §9 白名单 token：`.sm-icon-btn`（紧凑内边距、与下拉同高）、
  `.sm-btn-danger`（`--dsw-alias-state-error-primary` 的描边与文字）。
- 禁止 `window.confirm` / `window.prompt`（v2 起既定约束），确认与输入一律自绘。

## V5.6 locale 新键（4 处逐键同步）

`lib/client.js` 的 `en` 与 `zh` 两个内嵌词典 + `locale/en.json` + `locale/zh.json`，
新增 8 键，**四处键集合必须完全相等**（§8 的既有要求，本次首次由测试守护）：

| key | zh |
|---|---|
| `panel.personaRename` | 重命名 |
| `panel.personaRenamed` | 已重命名人设。 |
| `panel.personaRenameFailed` | 重命名人设失败：{error} |
| `panel.personaDelete` | 删除人设 |
| `panel.personaDeleteConfirm` | 确定删除「{name}」及其人格、画像与全局记忆？此操作不可撤销。 |
| `panel.personaDeleted` | 已删除人设及其记忆文件。 |
| `panel.personaDeleteFailed` | 删除人设失败：{error} |
| `panel.personaDeleteLocked` | Default 人设不能删除。 |

复用既有键：`panel.save`、`panel.personaCancel`。

## V5.7 测试归属

- `test/store.test.js`：重命名只改 `name`（slug / `docPath` / 已写文档内容不变，`personas.json`
  落盘正确）；未知 slug → `NOT_FOUND`；空 / 非字符串 name → `BAD_INPUT`
  （**超长 name 不在 store 报错**——§V5.2 细则 1 规定按码点截断到 60，与 `createPersona`
  同口径；对 `> 60` 报 400 是 `handlePersonas` 自己的校验，见 §V5.4）；`deletePersona('default')`
  → `PERSONA_PROTECTED` 且目录仍在；删非 current → current 不变；删 current → current 迁到
  `default`；**注册表里没有 `default` 条目时删掉最后一个 → `current: null`**（对应 §V5.0 的
  边界，钉死"不许删时报错、也不许凭空造条目"）；删后 `listPersonas` 无它且 `stat(dir)` 抛
  `ENOENT`（含 `history/` 一并消失）；**删人设后 `readDocSync` 立即返回空模板**
  （这条才是"漏清缓存"的回归网，理由见 §V5.2 第 5 步；`readDoc` 那条可以照写但抓不到 bug）。
- `test/routes.test.js`：PATCH 200 且回带 `personas + current`；PATCH 空 name → 400、未知
  slug → 404；DELETE 200 且列表少一个；DELETE 缺 slug → 400；DELETE `default` → 409
  `PERSONA_PROTECTED`；未知 slug → 404；`enabled:false` 下 PATCH/DELETE 仍可（守 v3 铁律）。
  **v5 有意改动的一条既有断言**：原 `it('DELETE 方法返回 405')` 与 §V5.4 直接冲突
  （DELETE 从此是合法 method，缺 slug 时返回 400），405 兜底改由 `OPTIONS` 触发。
  这是设计意图，不是误删断言，将来别把它改回去。

  **`describe('真实回环 HTTP')` 下的 v5 新增用例**（不新增文件，走真实 `node:http` +
  独立 `mkdtemp` store；ASCII slug 那条 mock 用例保留，它守的是另一件事）：
  ① 中文 slug 经百分号编码的 query 形态 DELETE → 200 且 `stat(dir)` 抛 `ENOENT`；
  ② 裸 UTF-8 中文请求行 → `400` + **空 body** + handler 未被调用；
  ③ 含 `%` 的 slug（`50%25测试`）删除后它自己 ENOENT、`50%测试` 目录仍在、列表少的是前者
  ——这条是 §V5.4 decode 禁令唯一的守网。
  **测裸非 ASCII 请求行只能用 `node:net` 手写**：`fetch` 与 `http.request` 都会先把
  非 ASCII 百分号编码掉（实测发裸中文，到 handler 时已是 `%E4%B8%B4...`），根本发不出
  裸字节；curl 是外部二进制，不能进测试。响应按 latin1 取原文，避免解码掩盖
  「parser 压根没生成响应」。
  跨层失败特征区分：报「目录必须 ENOENT」= store 层问题；报状态码或响应形状 = 路由层问题。
- `test/client-persona-crud.test.js`（新建）：照 `test/client-toggle.test.js` 的
  「最小 react + 假 fetch 直接驱动 `lib/client.js`」模式，自带 mock，**不改已有测试文件**。
  覆盖：✎ 进入重命名态并预填当前名；保存发 PATCH 且 body 正确、成功后提示与下拉显示名更新；
  🗑 进入确认态、取消不发请求；确认后发 DELETE（body 带 slug）、成功后下拉切到响应
  `current.slug`；选中 `default` 时 🗑 `disabled`；`busy` 时按钮全 `disabled`。
  **外加词典一致性断言**：`client.js` 内嵌 `en` / `zh` 与 `locale/en.json`、`locale/zh.json`
  键集合完全相等。
- 验收：`node --test` 全绿（**不要 `node --test test/`**，本机 Node 24 会按模块解析它）；
  用例数不少于 v4 基线 521。

## V5.8 排查过程中确认存在的既有缺陷（v5 未修，如实登记）

这三条都不是 v5 引入的。**当前状态**：第 1 条已由 v6 的目录归一化（§V6.1）在真实环境消除；
第 2 条已由 v6 的补建条件（§V6.2）消除；第 3 条经 v6 复核裁定为按设计如此（§V6.3）。
下面保留三条的成因描述，供排查历史数据时回看，不要再当成待修项。

1. **同一个 Store 里存在两个「默认人设目录」。** `personaKey()` 的兜底值、`personaSlug()`
   的兜底值、`resolveScope` 的兜底 `persona`、`resolveTargets` 的兜底值全是**小写
   `default`**，指向 `personas/default/`；而注册表里的默认人设是 `index.js` 用
   `createPersona('Default')` 建的 `personas/Default/`。Linux 文件系统大小写敏感，
   **这是两个不同目录**。任何走兜底的读写（`resolveScope` 拿不到 session、整理器 scope
   缺失、参数未显式传 persona）写进 `default/`，而面板与注入读 `Default/` ⇒ 同一份记忆
   裂成两半，用户在面板上看不到工具或命令刚写进去的内容。这台机器上 `personas/` 下是
   `default` 与 `工作`（v6 归一化已在真实环境验证）；成因保留在此，供排查仍带大写变体的
   历史数据时对照。
2. **`reconcileRegistry` 在 legacy 迁移分支写 `current = 'default'` 会造成悬空 current。**
   触发条件：迁移已触发但一个可迁移人设都没有。此时 `currentPersona()` 靠悬空兜底返回
   `{slug:'default'}`，而 `listPersonas()` 里没有这一项 ⇒ 面板下拉选中项对不上任何一行；
   而 `index.js` 补建默认人设的条件是 `listPersonas().length === 0`，此时列表非空 ⇒
   不会补建 ⇒ current 永久悬空，注入一直回退空模板，用户表现为「迁移完记忆全空」。
3. **`setCurrentPersona` 的 NOT_FOUND 豁免只给小写 `default`。** 语义存在歧义：若本意是
   「默认人设允许还没有目录」，该用大小写不敏感判定；若本意是「`personaKey` 的小写兜底键
   特殊」，则现状正确。风险场景：`personas/Default/` 目录因故缺失时，面板切不回 Default，
   而 `index.js` 因列表非空不会重建，只能人工建目录。

另外两条与本节无关但同源的事实：`createPersona` / `setCurrentPersona` 在注册表写盘失败时
内存已经脏（原地改 registry 再落盘，失败不回滚）；`reconcileRegistry` 只在 ready 时跑一次，
所以 `rm` 后若目录被并发 `mkdir` 重建，会等到下次启动才被重新登记成条目。

---

# v6 变更：默认人设的 slug 统一为小写 `default`

主人对 §V5.8 第 1 条的裁决是「根治：都改成小写，默认也是小写」。本章是落地契约。
**它消除 §V5.8 的第 1、2、3 条**，落地后请把那一节据实改写，不要留着已修的事实继续挂账。

## V6.0 决策与一处必要的修正

| 项 | 决定 | 理由 |
|---|---|---|
| 默认人设 slug | 统一为**小写 `default`** | 与 `personaKey` / `personaSlug` / `resolveScope` / `resolveTargets` 的兜底键同名，裂口从根上消失 |
| 默认人设显示名 | 仍为 **`Default`** | 用户在面板上看到的字不变，零感知 |
| 存量大小写变体 | ready 时**自动归一**成小写目录 | 老环境（含主人这台）留有大写 `Default`，不归一就会同时出现两个默认人设 |
| 禁删判断 | **保持大小写不敏感 `isDefaultSlug`，不得退回逐字比小写** | 见下 |

> **为什么判断不能退回逐字比小写**：归一化之后新数据确实全是小写，但归一发生在 ready，
> 而存量数据在被归一之前是真实存在的大写 `Default`。判断退回逐字比小写，等于在归一完成前
> （以及任何归一被跳过 / 失败的环境里）默认人设重新变成可删除——正是 v5 那次真实误删的
> 成因。判断比目录宽松没有代价：目录只有小写一个，判断覆盖所有大小写写法。

## V6.1 归一化算法（`reconcileRegistry` 内，**在扫盘合并条目之前**）

1. 判定集合：`scanPersonaDirs()` 里满足 `isDefaultSlug(dir.slug)` 的目录。
2. 无需处理：只有 `slug === 'default'` 一个，或者一个都没有。
3. **冲突则放弃**：以下任一条成立 ⇒ 什么都不动，只 `warn`（warn 文本要把找到的所有相关
   slug 都列出来，含「注册表条目」标注，便于排障）。两个目录都可能有真实内容，自动合并
   等于赌哪个该留；这种情况交给人工。
   - 磁盘上小写 `default` 与任一大小写变体同时存在；
   - 磁盘上只有变体，但**注册表里已有小写 `default` 条目**（把变体条目改名过去会造出
     重复 slug，同样是二义）；
   - **同时存在两个以上变体**（例如 `Default` 与 `DEFAULT` 并存）。
4. 归一：变体目录改名为 `default`，复用现成的 `moveDir(from, to)`（已处理 `EXDEV`）。
   **改名必须走两步**（`Default` → `.default-migrating-<随机>` → `default`）：macOS APFS 默认
   大小写不敏感，直接 `rename('Default','default')` 在某些卷上会被判等而无效或直接报错。
   任一步失败 ⇒ 放弃并 `warn`，**绝不 `rm`**，宁可留着裂口也不能弄丢目录。
   第二跳失败要把临时名 `rename` 回原名——回滚是必要的：临时目录留在原地会被扫盘登记成
   一个凭空多出的人设。
4b. **改完必须复查磁盘实际目录名**（macOS 兜底）：APFS 默认大小写不敏感，
   `rename` 只差大小写时可能被判定为同名而**静默无效且不报错**。若此时注册表条目已改成
   `default`，下次 `scanPersonaDirs()` 扫到的 `Default` 会被当作一个新人设再登记一次
   ⇒ 面板下拉凭空多出一条重复。所以改名后要 readdir 复查 `personasRoot` 里是否存在
   **恰好等于** `default` 的名字；不存在 ⇒ 回滚注册表条目并 `warn`，**绝不留下
   「条目与目录不一致」的半截状态**。为这条允许给归一函数加一个可选的复查注入点
   （测试用它模拟「rename 声称成功但目录名仍是大写」），注释须写明它是为可测性开的，
   不是业务参数。
4c. `scanPersonaDirs()` **跳过前缀恰好为 `.default-migrating-` 的目录**（防止两跳都失败
   且回滚也失败时留下幽灵人设）。**豁免范围就是这一个前缀**：不许扩大成「跳过所有点号
   开头的目录」——`personaSlug('../../etc')` 产出的 `..-..-etc` 以点开头却是合法 slug，
   且有存量用例专门守它，扩大豁免会让这类人设从面板凭空消失。
5. 同步注册表：条目 `slug` 由变体改为 `default`（`name` / `createdAt` 原样保留，显示名因此
   不变）；`current` 若等于旧变体也改为 `default`。目录改名后**不要**再依赖扫盘重新登记
   出新条目——归一必须在扫盘合并之前完成，否则会先塞进一个大写条目再改名，留下重复。
   **还要把 `options.defaultCurrent` 一起映射**：legacy 迁移传进来的首选 slug 若正是刚被
   归一掉的变体，不映射就会 miss，`current` 随之漂到 `sortPersonas()[0]` 那个别的人设上。
   因此归一函数要把被归一的旧 slug 回传给调用方做映射。
6. 全程在 `ready` 的串行队列里，失败只 `warn` 不抛（铁律：宿主服务异常必须静默降级）。

## V6.2 默认人设初始化条件变更（`lib/index.js`）

现状是 `listPersonas().length === 0` 才建，改为**「列表里没有 `isDefaultSlug` 的条目就建」**，
并用 `createPersona('default')` + `renamePersona('default', 'Default')` 两步得到
「slug 小写、显示名 `Default`」。这一条同时消除 §V5.8 第 2 条的悬空 current：
legacy 迁移后列表非空但没有默认人设时，现在也会补建，不再让 current 指向一个不存在的 slug。
第二步 `renamePersona` 失败只 `warn`，不回滚——slug 已经对了，显示名是次要的。

> **补建时绝对不许动 current（v6 最要紧的一条）**
> 既有代码的形状是 `createPersona` 完紧接着 `setCurrentPersona`。照抄进补建路径的后果：
> 存量用户打开面板发现自己的当前人设从 `工作` 变成了 `default` —— 那个人正在用原人格干活，
> 后台换掉等于人格被劫持，且没有任何提示。规则：**只有 `current` 为空，或 `current` 指向
> 注册表里不存在的 slug 时，才设成 default**；否则补建完就结束，current 一个字节都不碰。
> 归一化路径同理：`current` 只有在等于被归一的旧变体时才改写，指向别人设时不动。

**可测性**：初始化逻辑从 `void (async () => {...})()` 抽出为导出的
`ensureDefaultPersona(store, logger)`，`apply` 内部继续 `void ensureDefaultPersona(...)`，
行为不变。理由是 fire-and-forget 让「不发生」类断言只能靠轮询 + 静置固定窗口，慢且脆。
**不要**改用「`apply` 返回句柄 / 挂 `ctx.supermemory`」的做法：cordis 如何对待 `apply`
的返回值没有证据，为测试改插件入口的返回约定不划算，且有让宿主 await 住插件加载的风险。

## V6.3 明确不动的东西

- **默认人设判定共有三份逐字实现，不许漂移，也不许当成重复代码删掉**：
  `lib/core/store.js` 的 `isDefaultSlug`、`lib/client.js` 的 `isDefaultSlug`、
  `lib/index.js` 的 `isDefaultPersonaSlug`。三者必须逐字一致且大小写不敏感；注释要互相
  指认另外两份所在文件。理由：`lib/client.js` 天生不能 import store，而 `lib/index.js`
  为一份判定扩 store 的导出面不值得，宁可三份逐字实现并用注释钉住。
  **只读契约就以为只有一份、顺手删掉"多余"的那份，是要防的事故。**
- `lib/client.js` 里三处 `persona || 'default'` 空值兜底**不用改**——统一小写之后它们正好
  与真实 slug 相等，这就是本次根治的红利。
- 目录内的 `persona.json` meta 只有 `name` / `createdAt`，不含 slug，归一化不需要改写它。
- `reconcileRegistry` 里 `defaultCurrent` 的逐字比较保持现状（入参与 `item.slug` 同源于磁盘
  目录名，见 §V5.8）。
- **`setCurrentPersona` 的 NOT_FOUND 豁免只给小写 `default`，v6 裁定为「按设计如此」，
  不许顺手放宽**（§V5.8 第 3 条到此关闭）。归一之后条目 slug 恒为小写、`personaKey` 兜底
  目录也是小写，豁免给小写正好对齐。放宽到大小写不敏感有害：入参 `key` 是
  `personaSlug(slug.trim())` 算出来的，大写法会**静默放行一个既无目录也无注册表条目的
  slug 成为 current**（store 层不做条目存在性校验），等于把刚消掉的悬空 current 又请回来。
  残留风险只有「有人手工传 `Default` 得到 NOT_FOUND」，而面板传的一直是 slug（小写）。
  真要放宽，必须连「current 必须命中注册表条目」一起加，那是独立决策。

## V6.4 测试归属

- **store-impl**（`lib/core/store.js` + `lib/index.js` + `test/store.test.js`）：
  ① 变体目录 + 变体条目 + current 指向变体 → ready 之后目录是小写、条目 slug 是小写、
  `name` 仍是 `Default`、current 是小写；② 小写与变体并存 → 两个目录都还在、只 warn、
  注册表不变；③ 只有小写 → 不发生任何 rename（用 rename 计数或 spy 断言零次）；
  ④ 改名失败（把 `rename` 打成抛错）→ 目录不丢、不 `rm`、不抛、只 warn；
  ⑤ 归一后 `deletePersona('Default')` 仍 409（跨版本守网：判断宽松 + 目录小写时禁删照样生效）；
  ⑥ 归一发生在扫盘合并之前（断言归一后注册表里没有大写字母开头的重复条目）；
  ⑥b **current 不变**：`current==='工作'` 时，归一与补建两条路径跑完 current 仍是 `工作`
  （§V6.2 的 current 铁律，主人这台机器就是该形态）。
- **client-impl**（新建 `test/index-init.test.js`；**全仓此前没有任何测试 import 过
  `lib/index.js`**，入口层由这几条补上。不跨测试文件 import，自带精简 makeCtx——
  `logger.warn`→warnings[]、`get`、`on`、`effect` 十余行即可，宿主服务全返回 `undefined`
  就够：入口只注册三个事件监听，测试不触发事件就永远碰不到它们）：
  ⑦ 空环境 → `slug==='default'` **且** `name==='Default'` 同时断言，只断言 slug 会放过
  「用户看到的名字变了」；⑧ 列表非空（真造一个 `工作`）但没有默认人设 → 补建发生
  **且 `current` 仍是 `工作`**（同时守 §V5.8 第 2 条与 §V6.2 的 current 铁律）；
  ⑨ 已有默认人设 → 不重复建，拆两个子场景：小写 `default` 已在 / 只有大写 `Default`
  已在（后者从入口角度守「判断比目录宽松没有代价」，与 store 内部的归一是两个角度）；
  ⑩ 真跑一次 `apply(ctx,{})` → 不抛、零 `warn`、空环境最终出现默认人设条目（允许轮询，
  超时 3s；它守装配链路本身，与 await `ensureDefaultPersona` 的精确断言互补）。
  夹具两条硬要求：**必须设 `process.env.DSH_HOME`**（`store.js` 的 `stateDir` 由它派生，
  只传 `config.personasRoot` 挡不住，漏设就会写真实的 `~/.dsh`；恢复时 previous 为
  `undefined` 要 `delete`）；预置数据走完 `store.dispose()` 之后才 `apply`
  （入口在 store 构造期同步读注册表，顺序反了读不到）。
- **夹具必须反映当前版本的真实形态**（v5 用一次真实误删换来的守则）：mock 里默认人设
  长什么样，就要跟当前版本真实会建出来的一模一样。v5 是 `{slug:'Default'}`，v6 落地后是
  `{slug:'default', name:'Default'}`——`test/client-persona-crud.test.js` 届时一并换回，
  大写变体只保留在专门测大小写的那条用例里。
- 全量 `node --test` 不得少于本章开工前的 566 条。

## V6.5 存量环境的实际效果（主人这台机器）

人设目录 `Default/` 会在下次启动时改名为 `default/`，注册表条目 `slug` 跟着变小写、
`name` 保持 `Default`，面板下拉里那一行**看起来完全没变**；当前人设是 `工作`，不受影响。
`工作` 等非默认人设一律不碰。

---

# V7 两处真实事故的契约固化（优先于前文，冲突时以本节为准）

两处都不是「代码写错了」，而是「对宿主时序的假设错了」，所以都记成契约而不是补丁说明。

## V7.1 `webServer` 是入口唯一的 inject 硬依赖（`lib/index.js`）

`inject = ['webServer']`，**不许改回 `ctx.get` 现场捞**。

cordis 的 `ctx.get(name)` 只返回 provider fiber 当前 active 的实现；没声明的服务捞得到
捞不到，取决于 bundle 激活顺序。一旦捞空，`installRoutes` 一条路由都不注册且永不重试，
而插件 fiber 仍显示 active——面板全部 HTTP 404，宿主日志零线索，只能从 404 反推。

其余宿主服务（llm / tools / session / workspaceRegistry）仍全部经 `ctx.get` 可选获取，
缺失时照常降级。代价：没有 webServer 的 profile 里整个插件不再激活。

`installRoutes` 拿不到 webServer 时必须留一条 warn。**降级只意味着「不抛错」，不意味着
「不吭声」**——静默正是这次事故藏了一整天的地方。

## V7.2 快照必须经宿主的 `decision.messages` 落盘（`lib/host/inject.js`）

宿主 v4 日志的硬不变量（`dsh-session-format-v3-to-v4` 的 `foldSurface`）：**surface 的第一
条记录必须是 `system/message`**，它被登记为「受保护头部」，其后任何 replace 都不许遮蔽它。
违反的代价不是当轮报错，而是这个会话**此后每次加载都报**
`system/message requires a protected first surface head`，无法自愈——一次真实环境里 40 个
会话中招 16 个。

抢跑不是运气，是必然：`dsh-agent-loop` 里 `agent/pre-step` 在 685 行，`step/start` 757 行，
`system/message` 854 行。插件挂在 pre-step 上自己 `session.append`，天生比宿主早两道工序
（实测约 5 毫秒）。

**首次注入不许自己 append**：把快照放进 pre-step 返回值的 `messages` 里交给宿主。loop 在
append 完 `system/message` 之后、构造请求之前，会把其中非 `runtime-context` 的消息逐条
`session.append('user/message', message, { surfaceOp: 'append' })`——时序由宿主保证，本轮
就可见；后续更新仍用 `surfaceOp: replace` 维持「历史里恒为一条」。追加只能加在尾部，不得
覆盖或重排上游已放进 `messages` 的消息。

**不要退回「头部没落地就整轮不写」的门控**：那样单轮短会话（用户问一句就走）整轮都在让路，
结果是完全拿不到记忆——这条路实测已经废掉过一条真实会话的注入。`replaceSnapshot` 里保留
`hasSystemHead` 只作兜底：判据用 append-only 的 `snapshotEvents()`，不能用 `surface.nodes`
（压缩会把整段区间从 surface 上抹掉，用后者会在压缩之后把注入永久卡死）；真走到兜底说明
历史形态已超出假设，这一轮宁可不更新并留一条 warn，也绝不碰 surface 的第一个位置。

## V7.3 测试归属

- 三个夹具（`injection-trigger` / `host-install` / `compaction-recall`）**必须复刻宿主的提交
  动作**：拿到 pre-step 的 decision 后，把 `decision.messages` 逐条
  `session.append('user/message', ..., { surfaceOp: 'append' })`。不模拟这一步，快照就永远
  落不到 surface 上，测试等于在一个宿主不存在的形态里跑。
- `host-install.test.js` 原先守的是「监听器绝不修改 `decision.messages`」，v7 把这条通道改成
  注入的正道之后断言随之反转（恰好追加一条 `dsh-supermemory`），并另加一条守「只能追加、
  不得覆盖别人的消息」。这是契约变了，不是放宽守网。
- `runPreStep({ commit: false })` 只看插件返回了什么、不落盘，用来证明插件没有自己 append。
- session 桩默认预置一条 `system/message` 占 `events[0]`（宿主在第一个 step 就写它，桩不带
  就是假形态）；`makeSession(id, { systemHead: false })` 只给测 `replaceSnapshot` 兜底那条用。
- `hasSystemHead` 的四种读不到日志的入口一律判 false。
- `routes.test.js`：webServer 缺失必须「不抛错 + 恰好一条 warn」；走注入（`ctx.webServer`
  而非 `ctx.get`）也要能注册满 7 条。
- 序号一律取 `append` 的返回值，不硬编码数字：夹具预置事件会让 seq 位移，写死只会在夹具
  变动时误报成回归。

---

# v8 变更：分层记忆（core / index / cold）

> 本节优先于前文全部版本，冲突处以本节为准。目标是**让注入量与记忆总量解耦**：
> 项目记忆可以无上限增长，而每轮常驻上下文成本近似常数，冷层信息仍然查得到。

## V8.0 三条产品决策（已与用户确认，不再讨论）

1. **单文件 + 字段扩展**：冷层不拆新文件，条目头新增可选 `tier` / `topic` 段，沿用 v4 加
   `id` 的兼容路径。理由：store / 面板 / 整编器全部只是扩展，存量文件照读。
2. **动态预取要做，带冷却与变化阈值**：pre-step 用本轮用户输入检索冷层，命中的条目临时进快照。
   只做目录不做预取等于半截子工程——**模型不会主动去查它不知道自己存在的东西**。
3. **检索用词法 + 整理器生成的 aliases，不引入 embedding**：不新增任何依赖，不走模型调用，
   结果可解释。别名（中英关键词）是"穷人版 embedding"。

### 三条贯穿全局的不变量（实现时反复回来对照）

- **渲染期裁剪，存储期只表意图。** 盘上的 `tier` 只表达"这条该常驻"。预算真不够时由渲染层按
  热度把最不该常驻的条目临时折进目录，**绝不回写文件**。否则一次预算抖动就会反复改写记忆文件。
- **段级独立降级。** 任何一段超预算只降它自己。今天"project 太长导致人格一起被降级成索引行"
  是本版要根除的第一个缺陷。
- **缺省 = 旧行为。** 缺 `tier` 视为 `core`，缺 `topic` 视为未分类。存量记忆在升级瞬间
  一条都不会从上下文消失。**升级后首次注入的 project 正文必须与升级前逐字节一致。**

### 三层定义

| 层 | 内容 | 是否进上下文 | 预算键 |
|---|---|---|---|
| L0 core | 每轮都必须为真的事实：硬约束、技术栈、测试基线 | 是，正文 | `projectCoreMaxBytes` |
| L1 index | 主题目录，每主题一行 | 是，一行摘要 + 别名 | `projectIndexMaxBytes` |
| L2 cold | 全量条目，只被 search / 预取命中 | 否 | — |

## V8.1 阶段一：止血（不依赖分层，先独立交付）

### V8.1.1 人格与画像不再注入两遍（`lib/host/inject.js`）

实测 soul + user ≈ 5 KB，现在**同时**在 `systemPrompt` 的 `supermemory:persona` 和快照里各存
一份，每轮白烧 5 KB。

- pre-step 不再读 soul / user，只读 `global` 与 `project`。
- soul / user 的**唯一出口**是 `systemPrompt.section`；超预算由 `buildPersonaSection` 现有的
  「先保 soul 再截 user」负责，`systemPromptMaxBytes`（12000）不变。
- 快照的 `source.sections` / `byteSections` 随之只含 `global` / `project`。**面板按 `sections`
  渲染的分支要跟着验一遍**（`lib/client.js`，D 负责）。
- `buildEmptySnapshotMessage` 的 `byteSections` 同步成两键。

### V8.1.2 降级从全量改为段级（`lib/core/render.js`）

`buildSnapshot` 今天超限就把所有段换成索引（`truncated: true`）。改成按序收敛：

1. 全量；
2. 装不下 → project 段收缩（v8.2 后 = core 正文 + 目录；v8.1 阶段 = 直接走目录），
   **`global` 仍逐字全量**；
3. 仍装不下 → 砍目录条数，保住固定提示行与合法包裹（复用 `fitWrappedIndex` 的优先级）。

`soul` / `user` / `global` **永不被降级**。`fingerprint` 仍对原始正文取哈希（v3 注释里
"降级后索引相同会误判没变"的理由继续成立）。

## V8.2 条目格式：`tier` 与 `topic`（`lib/core/document.js`，A 负责）

条目头从最多三段扩到最多五段，**全部可选、旧文件照读**：

```md
- 2026-11-10T10:00:00.000Z · source:user-request · id:a3f2c · tier:cold · topic:注入机制
```

- `ENTRY_HEAD` 扩为命名捕获组，段顺序固定 `time · source: · id: · tier: · topic:`；
  缺段但写了后面的段 → 整行不认作条目头（宁可退回正文，也不要错位解析）。
- `tier` 合法值只有 `core` 与 `cold`，**非法值视同没写**（同"不合法 `id:` 段退回派生"的哲学）。
  **缺省 = `core`**。
- `topic`：1–24 字符，原样保留（含中文与空格）；超长或空视同没写。
- `parseEntries` 每项新增**不可枚举**属性 `tier`、`explicitTier`、`topic`、`explicitTopic`
  （理由与 `defineEntryId` 完全相同：`test/paths-document.test.js` 的
  `deepEqual(entry, { time, source, body })` 不能被新字段打红）。`entry.tier` 照读无误，
  `{ ...entry }` 与 `JSON.stringify(entry)` 会静默丢掉它——和 `id` 同一套下游注意。
- `renderEntry` 的写盘规则（**方向别写反**）：
  - `tier === 'cold'` 且 `explicitTier !== false` → 输出 ` · tier:cold`；
  - `tier === 'core'`（缺省态）→ **不输出**该段。因为存量条目全是 core，全写一遍会把整篇
    变成 diff 噪音；
  - `topic` 非空且 `explicitTopic !== false` → 输出 ` · topic:<topic>`；
  - 输出顺序恒为 `id` → `tier` → `topic`。
- 派生的缺省值（`explicitTier === false`）不落盘，与派生 id 完全同构。
- `rebuildDocument` / `appendEntries` 自动透传，**禁止用字符串替换改条目**（v1 起的理由不变：
  正文里一个 `- 2026…` 就能把改写带偏）。

## V8.3 主题索引（`lib/core/topics.js` 新增，A 负责）

主题级的摘要与别名存在 **project 记忆文档的 preamble**，用受控注释围栏承载：

```md
# 项目记忆

<!-- 由 dsh-supermemory 维护；可直接编辑。 -->

<!-- supermemory:topics:start -->
- 注入机制 · 快照如何落盘与压缩补偿 · aliases: snapshot, inject, 快照
- 整编模式 · consolidate 的栅栏与对账 · aliases: consolidate, 合并
<!-- supermemory:topics:end -->

## 条目
```

为什么放 preamble：`rebuildDocument` 保证**第一个条目头之前的 preamble 逐字保留**，条目区
整体重写——这是现成的安全边界。不新增文件、不新增故障点，`memory read project` 顺带可见。

三个导出（纯函数，无 IO）：

- `parseTopicIndex(text)` → `Array<{ name, summary, aliases: string[] }>`；围栏缺失/畸形返回 `[]`，
  单行畸形只丢那一行。
- `renderTopicIndex(topics)` → 含围栏的文本块；空数组返回 `''`。
- `upsertTopicIndex(text, topics)` → 替换围栏内内容；围栏不存在时插到**第一个条目头之前**
  （无条目头则追加到末尾），preamble 其余内容一字不动；`topics` 为空时删除围栏。

**必须点明的坑**：`inject.js` 的 `docBody` 会 `stripComments`，主题围栏在注入前就被剥掉了。
这是**正确的**——目录由渲染层生成，不让原文透传，否则主题表会在快照里出现两遍。所以
`buildProjectSection` 必须自己拿**原始文档文本**解析，不能拿 `docBody` 之后的正文。

**一致性栅栏**：目录以**条目上实际写的 `topic` 为准**，主题表只提供摘要与别名。
条目写了表里没有的 topic → 摘要用该条目正文首句兜底、别名留空；表里有但没条目用 → 该主题
不出现（不显示空壳）。

## V8.4 分层渲染（`lib/core/render.js`，A 负责）

`buildSnapshot` **旧签名与旧行为一律不变**，继续服务 `tieredInjection: false` 的回滚通道和全部
既有测试。分层走新函数：

```js
buildProjectSection({ text, projectName, usage, coreMaxBytes, indexMaxBytes })
// → { text, coreCount, coldCount, topics, overflow, bytes }
buildTieredSnapshot({ global, projectText, projectName, usage, recall,
                      injectMaxBytes, coreMaxBytes, indexMaxBytes, recallMaxBytes })
// → { text, digest, truncated, sections, stats }
```

`buildProjectSection` 的算法（顺序固定）：

1. `parseEntries(text)` + `parseTopicIndex(text)`；按 `tier` 分组。
2. core 组按 `score = w1 * log(1 + hits) + w2 * recency` 排序（`usage` 缺失 → 全 0 → 退回时间
   倒序，**没有统计文件也必须能跑**）。
3. core 累加到 `coreMaxBytes` 为止，溢出条目进 `overflow` 并**折进目录，不写文件**（不变量一）。
4. 目录段：每主题一行 `- 主题（N条）：摘要 → 别名`，累加到 `indexMaxBytes` 为止，溢出砍主题数。
5. 结尾固定一行：`冷层条目用 memory 工具按需检索（action=search, scope=project）。`

`buildTieredSnapshot` 的 `digest` 必须覆盖**原始 global 正文 + project 原文 + projectName +
truncated + 预取命中 id 集合**。预取 id 集合不进 digest 的后果：预取换了条目但快照不重写，
本轮检索白做。

`sections` 字节口径保持"每段渲染后字节数"。

## V8.5 配置（`lib/host/config.js`，Lead 负责）

全部 `.volatile()`，走现有 `readBoolean` / `readNumber`，非法值回退默认、越界钳制，
同步补进 `DEFAULTS` 与 `resolveConfig` 返回集：

| 键 | 默认 | 下限 | 说明 |
|---|---|---|---|
| `tieredInjection` | `true` | — | 分层总开关；`false` **逐字**退回 v7 渲染路径 |
| `projectCoreMaxBytes` | `16384` | 1024 | core 段硬预算，见下方「默认值为何留宽」 |
| `projectIndexMaxBytes` | `3072` | 512 | 目录段硬预算 |
| `projectRecallMaxBytes` | `2048` | 512 | 预取段硬预算 |
| `projectRecallTopK` | `5` | 1 | 预取条数 |
| `projectRecallMinRounds` | `3` | 0 | 预取换血最小间隔（轮） |

**`projectCoreMaxBytes` 默认值为何是 16384 而不是 8192（实测纠正，别再改回去）**：
真实项目记忆 9 KB / 25 条时，8192 的预算会在 `injectMaxBytes: 24000` 只用了一半的情况下
把 4 条挤进目录，而目录里只剩「未分类（4条）」一行——**升级当天就净丢信息**。实测数据：

| coreMaxBytes | 正文条目 | 折进目录 | 结论 |
|---|---|---|---|
| 8192 | 21 | 4 | ❌ 总预算宽裕却丢信息 |
| ≥12288 | 25 | 0 | ✅ 零折叠 |

core 段该收缩的时机是「总量逼近 `injectMaxBytes`」，不是「超过一个凭空的软上限」。

这 6 项与 v4 的整编阈值同性质（运维旋钮，不进面板 / `settings.json`），只从 `cordis.patch.yml` 读。

## V8.6 存储层：项目记忆目录的多文档枚举（`lib/core/store.js`，C 负责）

今天检索只覆盖四个记忆文件，**`pitfalls.md` 查不到**——最该被检索的东西恰好不可查。

新增 `listProjectDocs({ projectRoot })` → `{ ok, docs: Array<{ name, bytes }> }`：

- 只列 `<projectRoot>/<projectDirName>/*.md`，**排除 `history/` 子目录**；
- 排序稳定（按 `name` 字典序）；目录不存在 → `{ ok: true, docs: [] }`，**不报错**。

命中项的 `file` 字段由工具层填。

## V8.7 工具层（`lib/host/tools.js`，B 负责）

- `search` 命中项新增 `tier`、`topic`、`file`；**必须同步 `MATCH_SCHEMA`**——
  `OUTPUT_SCHEMA` 未声明的返回键会让整个调用被判 invalid output，一条命中都拿不回来（踩坑第 4 节）。
- project scope 检索目标从单文件扩为 `listProjectDocs` 的全部 md，排除 `history/`。
  排序沿用"全局排序后截 40 条"。
- `append` 新增可选 `tier`（enum `core` / `cold`），**默认 `cold`**。`PARAMETERS` 与 `DESCRIPTION`
  同步：模型主动 append 默认落冷层，只有主人明确要求"必须始终知道"才写 `core`。
- `list` 增加 core / cold 条数、主题数、各段字节。

## V8.8 整编输出三键（`lib/core/consolidate.js`、`lib/host/digest-input.js`、`lib/host/digest.js`，C 负责）

```json
{"entries":[{"text":"…","from":["a3f2c"],"tier":"cold","topic":"注入机制"}],
 "drop":[{"id":"b8e01","reason":"…"}],
 "topics":[{"name":"注入机制","summary":"…","aliases":["snapshot","快照"]}]}
```

- `parseConsolidateOutput` 增加 `topics` 解析与非法值丢弃；`applyConsolidation` 对 `tier` /
  `topic` 按 `from` 继承旧值，模型未写 → **保持原条目不动**（延续"没写不等于删除"）。
- 新增两类对账计数：非法 `tier` 值 → 视同没写并记入 `suspects`；`topics` 里出现没有条目使用的
  名字 → 记 `orphanTopics`。既有 `ghosts` / `duplicates` / `kept` 语义不变。
- 落盘顺序固定：**先 `rebuildDocument` 重建条目区，再 `upsertTopicIndex` 写主题围栏**，两步都
  成功才写盘；任一失败整轮放弃（保护快照回滚语义）。
- **提示词三处同步**（漏一处必漂移，当初事实性守则就是三处）：`DIGEST_SYSTEM_PROMPT`（整编）、
  追加模式提示、`tools.js` 的 `DESCRIPTION`。要点：常驻预算有限，只有"每轮都必须为真"的硬
  约束/技术栈/基线才配 `core`；`topic` 用名词短语、≤12 字、**同义主题必须归并到已有名字**
  （整编器看得见全量条目，归并由它负责）；不确定就别写 `tier`。
- 整编输入里带上 topic 热度摘要，提示词要求"长期零命中且非硬约束的 core 条目降到 cold，反复
  被检索的 cold 主题提升到 core"。
- 本地 qwen 是推理模型：三键比两键长，复核 `digestConsolidateMaxOutputTokens`（6000）是否覆盖
  reasoning tokens，不足则上调（踩坑第 5 节）。

## V8.9 动态预取（`lib/host/inject.js`，B 负责）

- pre-step 从 `agent.session` 取最近一条 user 消息（读不到、或那正是插件自己的快照 →
  **跳过预取**，静默降级不报错）。
- `queryTerms` → `scoredLines` 跑 project 全部 md → top-K，**剔除 core 段已在场的条目**。
  分数下限沿用 `MIN_BLOCK_HITS` 思路；无命中 → 预取段为空，**不发空标题**。
- 渲染为快照内独立小节 `## 本轮相关记忆`，带一行「按本轮输入检索，可能不完整」。

**预取内容并入既有快照消息，不新开一条。** 代价是重写频率上升；收益是 surface 上**恒为一条**，
`replace` / 压缩补偿 / `hasSystemHead` 兜底逻辑一行都不用改。这块踩过写坏 16 个真实会话的事故
（V7.2），不碰它是刻意的。

**变化阈值 + 冷却**（压住 prompt cache 抖动）：

- 命中 id 集合与上轮**完全一致 → 不重写**；
- 集合变了但距上次换血 `< projectRecallMinRounds` 轮 → 本轮不换；
- 轮数与 id 集合记在快照自己的 `source.recall = { ids: [], round: n }` 里，**不新增外部状态**。

**轮数计数器的判据（实测钉死，别自作聪明放宽）**：只数
`type === 'user/message' && source.kind === 'user'`。

- 宿主每轮都会额外写若干条**同样是 `user/message`** 的事件：`runtime-context`、`time-context`、
  `tool-jobs`、`skill-catalog`。真实日志实测：真用户发言 1–3 条的会话里，这些注入类事件有
  **3–10 条**。所以用「`user/message` 且不是本插件」当轮数，**一轮之内就能凑满
  `projectRecallMinRounds=3`，冷却直接失效、预取每轮换血**——这不是理论风险，是实测结果。
- `source.kind === 'user'` 才是真实轮次。实测样本里它与快照条数一一对应。

**`source` 可以携带自定义键（已实测确认）**：真实日志里本插件事件的 `source` 落盘后完整保留
`kind / form / digest / truncated / sections / byteSections`，宿主**不做未知键剥离**，自定义
`kind` 也不受枚举限制。所以 `source.recall` 同样能落盘读回，无需额外存储。

## V8.10 热度统计（`lib/core/usage.js` + `lib/host/usage.js` 新增，B 负责）

落盘在 `<projectRoot>/<projectDirName>/usage.json`：

```json
{ "topics": { "注入机制": { "hits": 12, "last": "2026-11-10T…" } },
  "entries": { "a3f2c": { "hits": 3, "last": "…" } } }
```

- **主键是 `topic`，条目 id 只作辅助。** 条目 id 由 `sha1(time + body)` 派生，整编改写正文后
  id 就变，靠它做热度必然丢历史；topic 才是稳定锚点。
- 记录点：`memory search` 命中 + 预取命中。
- 文件缺失 / 损坏 / 缺字段 → **一律当空统计继续，只 warn 不抛**；热度缺失时排序退回时间倒序。
- 写失败只 warn。写入防抖：进程内累计，整编时或每 N 次命中才落盘一次。
- 热度**只影响渲染期排序**，不改盘上 `tier`；真正的 `tier` 变更只在整编时发生（不变量一）。

## V8.11 可观测（`lib/host/routes.js` 归 C，`lib/client.js` / `locale/*.json` 归 D）

`memory` 的 `list`、`GET /doc`、整理报告 `runs.jsonl` 各补：core / cold 条数、主题数、
盘上字节。面板加一节分层概览，只用 `--dsw-alias-*` token，无 JSX，`lib/client.js` 保持单文件。

**没有这一节，用户无法一眼看出盘上有多少常驻、多少冷层、几个主题。** 不属于可裁剪范围。

**只报盘上事实，不报注入侧估算**（见 V8.16 第 1 条）：`GET /doc` 的 `tiering` 只含
`core` / `cold` / `topics` / `orphanTopics` / `docBytes`；`injectedCore` / `hiddenCold` /
`overflowIds` / `coreBytes` / `indexBytes` / `totalBytes` 全部撤除，面板对应六格与两条预算条一并删除。

## V8.12 文件归属表（v8，覆盖 §1 的归属冲突）

| 成员 | 独占写作用域 |
|---|---|
| Lead | `docs/CONTRACT.md`、`lib/host/config.js`、跨域裁决与最终验收 |
| A core-format | `lib/core/document.js`、`lib/core/render.js`、**`lib/core/entry-format.js`**、**`lib/core/topics.js`**、**`lib/core/render-common.js`**、**`lib/core/render-tiered.js`**、**`lib/core/snapshot-tiered.js`**、**`lib/core/tier-index.js`**（后六个为 v8 新建；拆分的直接原因是 WORKER.md 的 400 行上限：`document.js` 拆前 483 行、`render-tiered.js` 拆前 546 行） |
| B host-inject | `lib/host/inject.js`、`lib/host/tools.js`、**`lib/host/tools-search.js`**、**`lib/host/inject-recall.js`**、`lib/host/usage.js`、`lib/core/usage.js`（v8 新建） |
| C digest-store | `lib/core/store.js`、`lib/core/consolidate.js`、**`lib/core/consolidate-plan.js`**、`lib/host/digest-input.js`、`lib/host/digest.js`、**`lib/host/digest-prompt.js`**、`lib/host/routes.js`、`lib/host/routes-digest.js`、`lib/host/routes-settings.js` |
| D client | `lib/client.js`、`locale/en.json`、`locale/zh.json` |
| B（授权例外） | `test/host-install.test.js` **只限** V8.1.1 的 `byteSections` 键数断言与 V8.15 第 7 条的降级提示行断言，其余一律不许碰 |

### 单一来源纪律（防静默失效，违反不会被测试抓住）

- 主题表围栏字面量**只许出现在 `lib/core/topics.js`**；读写只许走 `parseTopicIndex` /
  `upsertTopicIndex`，**不许出现第二套解析路径**。成对围栏缺一侧一律当空表，**不猜结尾**。
  （实测已核：当前 `lib/` 下字面量仅一份，`tools-search.js` 与 `digest.js` 均 import 权威实现。）
- 条目头正则**只许出现在 `lib/core/entry-format.js`**。
- 降级提示行按路径各自单一：v7 回滚通道的 `INDEX_HINT` 只在 `render.js`，
  分层路径的 `COLD_HINT` 只在 `render-tiered.js`。

跨域需求（如 B 要 A 改 `buildProjectSection` 签名）→ 写在完成报告里交 Lead 裁决，**不许自己动手**。

## V8.13 测试归属（v8）

**验收口径统一为 `node --test --test-concurrency=1`**（串行）。原因实测过：默认并发下注入类
用例会因负载抖动造出 **20+ 条假红**，同一条用例单独跑必绿——各人看到的红名单都不一样，
无法作为交接依据。加 `duration_ms` 约 6.5 秒，代价可接受。

从仓库根跑，**不要用 `node --test test/`**（本机 Node 24 会把它当模块解析）。
`test/digest-prompt.test.js` 的红是设计意图，不是误报（踩坑第 6 节）。

**默认值不许在测试里硬编码第三遍。** `resolveConfig` 的默认值已经有 `zod .default()` +
`DEFAULTS` + `paths-document.test.js` 全默认断言 + 本文件 `*_DEFAULTS` 四处，坑位测试守总数；
用例内部一律引用 `*_DEFAULTS` 常量，不要再抄数字（v8 改 `projectCoreMaxBytes` 与
`digestConsolidateMaxOutputTokens` 时，硬编码那处重复红了两次）。

| 测试文件 | 归属 | 守什么 |
|---|---|---|
| `document-tier.test.js` | A | 五段头解析、缺省 core、非法值退回、派生 tier 不落盘、往返幂等、`{...entry}` 丢 id/tier 的既有约定不破 |
| `topics-index.test.js` | A | 围栏解析/生成/插入，preamble 其余内容逐字不变，用户手删围栏后不炸 |
| `render-tiered.test.js` | A | core/目录预算分配、core 溢出折进目录、`tieredInjection:false` 逐字节退回旧输出、**段级独立降级：project 超预算时 global 正文必须逐字在场** |
| `search-extended.test.js` | B | 跨 md 检索命中 pitfalls、排除 `history/`、中文长尾召回、**输出 schema 覆盖每一个返回键** |
| `recall-prefetch.test.js` | B | 无输入跳过、空命中不发标题、id 集合不变不重写、冷却期内不换血、快照仍经 `decision.messages` 由宿主提交 |
| `usage.test.js` | B | 损坏/缺失当空、topic 计数在条目 id 变更后仍延续、写失败只 warn |
| `store-project-docs.test.js` | C | 枚举排除 `history/`、目录不存在返回空、排序稳定 |
| `consolidate-tier.test.js` | C | 三键解析、缺省不动、非法 tier 进 suspects、orphanTopics、落盘顺序 |
| `client-tier.test.js` | D | 分层概览渲染、`sections` 只剩两键时不崩 |

夹具三条铁律（V7.3 + 踩坑第 8 节，v8 继续适用）：必须复刻宿主的 `decision.messages` 提交动作；
session 桩必须预置 `system/message` 占 `events[0]`；假数据必须与真实落盘结构完全一致。

## V8.14 边界与失败模式（逐条已定处理方式）

| 情况 | 处理 |
|---|---|
| 旧文件无 tier/topic | 视为 core / 未分类，升级后首次注入正文与升级前逐字节一致 |
| 条目 topic 写了主题表没有的名字 | 摘要用正文首句兜底，别名留空，记 `orphanTopics` |
| 主题表围栏被用户手删 | 当空表，目录退回条目首句摘要；下次整编自动补回 |
| core 段超预算 | 渲染期按热度临时折进目录，**不写文件** |
| 预算小到放不下一行目录 | 保住固定提示行与合法包裹（复用 `fitWrappedIndex` 优先级） |
| 只有 cold 没有 core | 只出目录 + 提示行，不出空标题 |
| 段顺序错位（写了 `tier:` 却没写 `id:`） | 整行不认作条目头，退回正文，不错位解析 |
| `usage.json` 损坏 / 缺失 | 当空统计，warn 一次，排序退回时间倒序 |
| 读不到用户输入 | 跳过预取，快照其余部分照常 |
| 预取无命中 | 预取段为空，不发空标题 |
| 整编模型漏输出 tier/topics | 视为"不动"，条目保持原 tier，主题表不更新 |
| 整编模型输出非法 tier | 视同没写 + 记 `suspects` |
| 压缩吞掉快照 | `compactionRecall` 现有重同步不变；预取小节随快照一起重写 |
| 插件软开关关闭 | 不注入、不预取、不写 usage；旧快照原样保留（v3 语义不变） |
| `tieredInjection: false` | 逐字退回 v7 渲染路径（回滚通道，必须留） |
| `docBody` 剥掉主题围栏 | 预期行为：目录由渲染层生成，不让原文透传，否则出现两遍 |

## V8.15 Lead 裁决记录（实现过程中的接口空白，逐条已拍板）

### 1. `recall` 入参形状（补 V8.4 的空白）

```js
recall: { ids: string[], items: Array<{ id, topic, tier, text, score }> }
usage:  { topics: {…}, entries: {…} }   // 直接传 usage.json 那个对象
```

`digest` 只取 `ids`；渲染层只负责把 `items` 画成 `## 本轮相关记忆`。**两条硬要求**：

- `items[].text` 必须走 `escapeFrame` 再拼进快照——预取来的条目正文里只要出现
  `</supermemory>` 就会提前闭合整个包裹。这是 `escapeFrame` 存在的唯一理由，新路径不许绕过。
- 条数与总字节由渲染层按 `projectRecallTopK` / `projectRecallMaxBytes` 裁，注入层不预裁。

### 2. 渲染层能力探测（允许，但必须吭声）

`lib/core/render.js` 用命名空间 import + `typeof buildTieredSnapshot === 'function'` 探测，
A 未就位时逐字退回 v7 `buildSnapshot`——**允许**，它能避免半集成态打爆全量测试。

但探测失败退回 v7 时**必须 `logger.warn` 一次**。理由见 V7.1 的教训：
**降级只意味着「不抛错」，不意味着「不吭声」**。配了 `tieredInjection: true` 却静默跑在 v7 上，
是最难排查的一类事故。

`deps.render`（测试注入假渲染层）**允许**：`deps` 是 `lib/index.js` 到装配函数的内部对象，
不是插件返回值，不违反「插件入口不为测试返回可访问句柄」。登记在此，免得后人当暗桩删掉。

### 3. 预取候选判据（采纳 B 的简化，但补一个洞）

判据定为 `entry.tier !== 'core' || overflowIds.has(entry.id)`。

- 采纳"不做动态剔除 core 已在场"：V8.0 三层定义本就写明 cold 只被 search/预取命中。
- **但不许写成只看 `tier`**：V8.4 规定 core 段超预算时溢出条目会**临时折进目录**，这些条目
  `tier` 仍是 `core` 却不在正文里。只按 `tier` 排除，它们就永远回不到正文。
- `overflowIds` 取自 `buildProjectSection` **已经要返回的 `overflow` 字段**（V8.4），
  所以**不需要 A 改签名**，零接口变更。

### 4. 轮数计数器判据

见 V8.9 的实测钉死：**只数 `source.kind === 'user'`**。用"非本插件的 user/message 条数"会让
冷却在一轮内失效。

### 5. 两处语义收口

- `append` 的 `tier` **只对 `scope: 'project'` 生效**，其它 scope 传了直接忽略且**不回错误**
  （soul/user/global 没有分层语义，收下反而是误导模型）。工具描述里要写明。
- `usage.json` 的落盘触发定为**两种**：每 N 次命中、以及 dispose。**取消「整编时落盘」**——
  那需要 C 反向持有 B 的 tracker 实例，跨域耦合换来的收益太小。N 取 8。

### 6. `test/host-install.test.js` 归属补登

V8.1.1 会把该文件里「占位快照 `byteSections` 为四键」的断言打红。该文件此前未登记归属，
现补登给 **B**：只有注入层最清楚正确形态。**允许 B 改这一处，且只许改这一处相关断言。**

### 7. 降级提示行按路径分断言（`test/host-install.test.js` 超预算那例）

v8.1.2 把降级形态从「全量索引」改成「core 正文 + 主题目录」，固定提示行随之分叉：

- 分层路径 → `COLD_HINT`：`冷层条目用 memory 工具按需检索（action=search, scope=project）。`
- v7 回滚通道（`tieredInjection: false`）→ `INDEX_HINT`：`完整内容可用 memory 工具按需读取。`

`test/host-install.test.js` 里守旧文案那例必须**按注入路径分别断言，两条覆盖都得留**。
**禁止用「让两个提示行同时出现」来糊过去**——那等于把回滚通道的文案污染进分层路径，
两条契约同时被稀释。

### 8. 条目头「缺段即整行不认」的收窄（批准，属契约内部冲突的修正）

契约 V8.2 与 V8.14 按字面执行会互相打架：`renderEntry` 最常见的输出正是
`- … · id:x · topic:主题`（core 条目带主题、而 core **按规则不写 tier 段**），
严格「缺段即整行不认」会让这行解析不回来——**整编器给条目打主题反而把条目抹掉**。

定稿：**`id` 是 `tier` / `topic` 的前提**（缺 `id` 却写这两段 → 整行不认，V8.14 举的例子照旧守住）；
**有 `id` 时 `tier` 与 `topic` 各自独立可选**。

### 9. `renderEntry` 补派生 id 的例外（批准）

要写 `tier` / `topic` 却没有可写 id 时，补一个派生 id——否则该行整行不认、条目凭空消失。
不写这两段的普通条目照旧一个 id 都不补，v4「派生 id 不落盘」的约定不变。
这条同时保护了 C 的落盘路径。

### 10. 极端预算下允许超出总预算（批准）

`global` 逐字在场、`</supermemory>` 包裹合法，两者都**优先于** `injectMaxBytes`。
因此 global 自己就超预算时快照会超出总额。收敛顺序固定为：
全量 → 重算 project 预算（core / 目录三七开）→ 逐条砍主题 → project 段只剩固定提示行。
**宁可整段超出，也不做会切断 `</supermemory>` 的字节截断。**

### 11. `buildProjectSection.text` 的返回口径（接线必读）

返回的 `text` 是**不含段标题的正文**，从第一条条目直接开始；段标题由快照装配层加。
`text === ''` 表示**该段什么都不注入**，下游按空串判，不要发空标题或空包裹。
分层结果里 core/cold/overflow 等统计一律在 `buildTieredSnapshot` 的 `stats` 里取。

### 12. 热度接线必须用 `load()`，不许用 `peek()`

`lib/index.js` 的 `deps.topicUsage` 已接上（形状 `({ projectRoot }) => Array<{ name, hits }>`）。

**必须 `load()`**：`peek()` 只看内存态，而整编很可能在插件刚启动、或由 `/memory-digest`
手动触发时跑——那时该项目的分片还没被 search / 预取加载过，`peek` 返回空统计，
**晋升降级回路静默失效且没有任何报错**。`load()` 走队列读盘，加载过一次即复用。

`options` 三处（index / inject / tools）必须一致（`{ docPathRef: store.docPath, logger }`），
共用 `getSharedUsageStore` 的同一单例；各自持有内存态会互相覆盖同一个 `usage.json`。

### 13. `digestConsolidateMaxOutputTokens` 6000 → 12000（批准 C 的实测推算）

按 pitfalls §5 实测：两键整编正文 ≈1683 字节（400~600 token）+ reasoning ≈5942 token
≈ **6.4k，三键之前 6000 就已经被吃穿**。症状正是「正文写完了却因 `finish_reason=length`
拒绝落盘」。三键的主题表最坏约 24 条 ×72 字 ≈ 1.2~1.7k，合计 ≈8.2k，取 12000 留 1.45× 余量。

**给本地推理模型配输出预算时一律按 reasoning tokens 计，不许按正文长度估。**

### 14. C 的自决点全部批准，其中两条升为契约要求

- **本轮没给出任何主题就完全不碰围栏**——因为 `upsertTopicIndex(text, [])` 会删围栏，
  照 V8.14「漏输出 topics 视为不动」的语义必须跳过写入。**这是整条链上最容易丢数据的一点。**
- **主题表硬上限 `TOPIC_LIST_MAX = 50`**——模型报 300 个主题会把下一轮输入吃成
  `INPUT_OVERFLOW`，盘上必须有闸门。
- `listProjectDocs` 每项带绝对 `path`：批准。让调用方自己拼路径等于把可配置的
  `projectDirName` 复制一遍。
- `parseConsolidateOutput` 多返回 `invalidTiers`：批准。非法 tier 在归整那刻就被丢掉，
  不透出就再也还原不出「模型写错了什么」。
- 主题名 / tier 判据一律复用 `entry-format.js`：批准，属单一来源纪律。
- `summary: 42` → `''`、`aliases: "a, b"` → `['a','b']`：批准。
- ~~**`GET /doc` 的注入口径拿不到就省略字段，不许报 0**~~：该组字段已按 V8.16 第 1 条整体撤除，
  这一条随之作废。「拿不到就省略、绝不用 0 顶替」仍是 `tiering` 全体字段的纪律。

### 15. 面板降级约定（D 必读）

- runs.jsonl 的 `consolidation`（含 `tiers` / `topics` / `orphanTopics` / `invalidTiers`）
  **只在 consolidate 轮存在**；追加模式的 run 没有分层统计，不许假设每条 run 都有。
- `tiering` 里盘上事实（`core` / `cold` / `topics` / `docBytes`）恒给；
  注入口径已按 V8.16 第 1 条整体撤除，**不存在「可能缺席」这一档了**——不要再往回接。

### 16. `recall` 的实际形状是**条目数组**，V8.15 第 1 条作废

第 1 条写的 `{ ids, items }` 与 `buildRecallSection` 的落地实现（`Array.isArray(recall) ? recall : []`）
不一致。**若按对象传，`Array.isArray` 为 false → 静默返回空数组 → 预取小节永远不出现且不报错**。
定稿以落地实现为准：

```js
recall: Array<{ id, topic, tier, body, score }>   // 条目数组；无候选传 []
```

- 渲染层需要 id 集合时从数组元素自取，注入层不再单独传 `ids`。
- 渲染层收到**非数组**时必须 `logger.warn` 一次（形状误用属编程错误，不许静默变空）。
- 新增用例：传对象 / 传 null 时不得静默产出空小节而不吭声。

### 17. `entryLocator` 登记（B 的新接口）

`lib/host/tools-search.js` 导出，形状 `entryLocator(text) → { entryAt(line), entries }`：

- `entries: Array<{ line, id, tier, topic, time, body }>`，顺序即文档顺序，`line` 是条目头
  在文档里的 1-based 行号。
- 头行数与 `parseEntries` 条数不等时**只取 `min(两者)`**——解析器与渲染器版本错配时宁可少给，
  不要错位返回。
- `entryAt(line)` 二分查「最后一个头行号 ≤ line」的条目；落在前言区（标题、主题围栏、
  `## 条目` 之前）返回 `undefined`。
- 唯一消费者是 `searchProjectDocs`：拿命中行号反查所在条目，补出 `file` / `id` / `tier` / `topic`。

归属 B，测试归 `test/search-extended.test.js`。

### 23. `append` 只提供 `tier`，**不提供 `topic` 参数**

主题表是目录，**目录的价值在于收敛**。让写入方自由命名主题，同一件事必然出现
「注入机制 / 快照注入 / inject 通道」三个名字，后果不是难看而是**可测量的功能损失**：
C 已查明「整编换了主题名」是**热度断链的唯一成因**（`entryHeat()` 靠 `max(entryHits, topicHits)`
经 topic 接续，名字一换旧热度全成孤儿），目录同时会爆炸式膨胀并吃掉整编输入。

只有整编器有归并所需的**全量视图**（盘上主题表已喂进它的输入），写入方没有。
所以 `memory append` 不收 `topic`；`DESCRIPTION` 里写明「条目可带 topic，主题表由整理器维护，
你不用传」是**正确措辞，不是遗漏**。

将来若真要开放给模型，必须先有闸门：只能匹配盘上已有主题名，匹配不上就归未分类，
不许凭空造名。

### 24. 面板不显示预取命中数与 recall 段字节（V8.11 该项作废）

D 提出面板拿不到 `recallCount` / `recallBytes`（渲染层 `stats` 里有，但既不进快照 `source`、
`GET /doc` 也没有）。**裁决：从面板要求里划掉，不补字段。**

理由不是"做不到"，是**这类字段的性质不对**：

- `recall` 是**瞬时状态**——它属于"某一次 pre-step 的那一轮"。用户点开面板时看到的数字属于哪一轮？
  无法回答。C 已经拒绝过把 runs 里的旧报告混进 `tiering`（会让两份不同时刻的数据看起来像同一时刻），
  往同一个对象里再塞一个每轮变化的值是同一个错误的更严重版本。
- 用户真正想知道的"本轮注入了哪些记忆"，**在注入文本里直接可见**——就是那个
  `## 本轮相关记忆` 小节本身。面板再显示一个数字是重复信息，还多一处会漂移的口径。
- 今天全队最贵的教训就是**同一件事有两套口径**。为一个排查便利的数字再加一处，不划算。

**要观测预取的正确途径**：读注入文本里的 `## 本轮相关记忆` 小节，或离线跑
`buildTieredSnapshot({ recall: pickRecallItems(...) })` 看 `stats`。将来若确有长期观测需求，
正确形态是独立的"最近一次注入"观测面（带轮次时间戳），**不要塞进 `tiering`**。

### 25. 快照落盘形态实测（读日志前必看，Lead 自己踩过误判）

实测自真实会话日志（`session.v4.jsonl.zstd`，只读解压）：

```
事件顶层 = { type, seq, time, data, sourceEventSeqs, surfaceOp }
data.source = { kind, form, digest, truncated, sections, byteSections, recall? }
                                        ↑ 数组          ↑ 对象
sections: [{ name: 'global', text: '…' }, { name: 'project', text: '…' }]
```

- `sections` 是**数组**，元素字段名是 `name`；取项目段要 `sections.find(s => s.name === 'project')`，
  **`sections.project` 是 `undefined`**。`byteSections` 才是对象，分层后只有 `global`/`project` 两键。
- replace 信息在**顶层 `surfaceOp`**，不在 `data` 里：`surfaceOp: { op: 'replace', startSeq, endSeq }`。
  **读错这一处会把完全正常的会话误判成「恒一条防线失效」**——Lead 按 `data.op` 读时，
  曾看到"7 条快照全 append、同 digest 写两次"并差点上报事故。
- `recall` 键在**没有预取候选时整个缺席**（不是空对象）。本项目记忆全是 core，
  判据 `tier !== 'core' || overflowIds.has(id)` 全不成立 → 无候选 → 省略键，
  这是**正确行为**，不要当成"预取坏了"。
- 压缩之后那条快照用 `append` 重建（原节点已被摘走、没有可 replace 的目标），
  所以**同一 digest 出现两条是预期**，不是"不变不写"失效。实测：seq 14 append →
  seq 454 `replace(14~14)` → 压缩遮蔽 12~271 → seq 763 `append`（digest 与 454 相同）→
  此后 4 条连续 `replace`，防线成立。

### 26. 过滤遮蔽事件只许按 `shadowedSeqs`，**`shadowedRange` 不是集合**

真实日志实测（29 个会话逐行核对）：

- 一条 summary 的 `shadowedRange = {start:10, end:217}`，而它的 `shadowedSeqs` **只有 80 个**
  ——range 是**包络**，中间 128 个事件从未被摘要。
- 另一条 `shadowedRange = {start:556, end:657}`，而 `shadowedSeqs` 里出现了 **220**，
  比它自己的 `range.start` 还小——**两个字段各说各话**。

**按 range 展开删除，会把从没被摘要过的真实对话踢出整编输入，而摘要里也没有它们——
这是唯一会造成不可逆丢失的写法。** 用例专门摆出「range 比 seqs 宽」的形状守住这条：
range 覆盖到、但不在 `seqs` 里的事件**必须保留**。

配套规则：`seq` 读不到时（旧宿主、测试替身）**一律保留**，判断不了就宁可多读；
`compaction/summary` 与 `compaction/prune` **两种都要收**，只认 summary 会漏掉 prune 遮蔽的那批。

### 27. 两条被实测推翻的假设（留此防止重复提出）

- **「整编输入会因遮蔽事件多读一到两个数量级」不成立。** `collectTranscript` 只取尾部 40 条，
  尾部被遮蔽的实测 **0 条**（窗口放宽到 60 也只有 1 条）。原因：压缩遮蔽的永远是窗口**头部**
  的旧内容，尾部正是压缩之后新产生的对话。
  **过滤仍然要做，但理由是质量**：已被摘要压过的旧原文再进整编，模型会把它当「现在的事实」
  重述一遍，落进过时条目。**注释里不许写「防膨胀」**——错误的理由会诱导下一个人关掉它。
- **「输入里同时有旧原文和它的摘要」不会出现。** `collectTranscript` 只收 `user/message` 与
  `assistant/message`，`compaction/summary` 不是消息类型，**摘要进不了 transcript**；
  所以也无法用摘要去重，只能靠 `shadowedSeqs` 集合。

### 18. `bytes` 口径：唯一形状 `bytes: { total, core, index }`

三个都是数字，口径由渲染层定义、消费方不得自行兼容：

| 键 | 含义 |
|---|---|
| `core` | core 条目正文部分的字节 |
| `index` | 主题目录段字节（含 `### 主题目录` 标题行与挤出组）；**无目录时为 0** |
| `total` | 整个 project 段正文 = core + 目录 + 冷层提示行 + 段间空行；**不含**段标题 `## …` 与 `<supermemory>` 包裹 |

恒有 `total >= core + index`，差值是空行与提示行，不是丢字节。由
`describe('bytes 口径')` 三档场景钉死，含 `total === byteLength(text)` 硬等式。

**消费方禁止写兼容读取**（`typeof b === 'number' ? b : b.core` 这类）——兼容读取会把口径分歧
永久藏起来，面板与 list 各猜一半，出错时无人知道哪边错。

### 18.1 一条被纠正的错误归因（留此防误导）

曾推测「把 `projectCoreMaxBytes` 从 8192 提到 16384 会打坏渲染夹具的期望」，**该结论不成立**：
渲染层测试一律**显式传预算**、不吃默认值，改默认值对其零影响。那两例红的真实原因是
改目录规则时留下的旧断言。

**由此定下的规矩**：调 `projectCoreMaxBytes` / `projectIndexMaxBytes` 默认值时，需要同步的只有
配置侧那四处断言（见 V8.13），**不需要**去改渲染层夹具；反过来，渲染层用例也不许改成吃默认预算，
否则这条规矩就失效了。

### 19. 预取的两处口径（批准 B）

- **`source.recall.ids` 为空时整个键省略**：否则首轮无命中的会话要白等 `projectRecallMinRounds`
  轮才出第一次预取。
- **冷却不换血时照常按旧 ids 回填正文**，不复用旧文本。否则只要别的段变化触发快照重写，
  预取小节就凭空消失，表现为「记忆每轮掉一截」。
- usage 只在**真换血**时记，冷却期内重复命中不重复计数。

### 20. 追认 v8 新增文件（均已在 V8.12 登记）

`lib/core/tier-index.js`（A，目录呈现改造）、`lib/host/inject-recall.js`（B，预取判据纯函数
247 行）、`lib/host/tools-search.js`（B，跨 md 检索 + 枚举 + `entryLocator` 368 行）。
拆分的共同理由是装配本体已 700+ 行且判据必须能单独测；**不合并回去**。

### 21. 整编 × 预取的已知交互（真机验收必查）

整编重写正文 → 条目 id 换代 → 快照里旧 `recall.ids` 整批失效 → **下一轮必然换血**。
热度账以 topic 为主键可缓解（id 会变、topic 稳定），但「整编后第一次注入把预取整批换掉」
尚无夹具覆盖。验收要确认它不会撞上 V8.14 的抖动防线，也不该被当成 bug 修掉。

**确切机制（C 从实现里核出，验收时照此判断，别凭直觉误判成 bug）**：

1. **换代是必然的，与正文有没有变无关**。`applyConsolidation` 造新条目时 `time` 取**整编时刻**，
   不继承被吸收条目的时间，也不带 `explicitId`；派生 id = `deriveEntryId(time, body)`。
   所以**模型把正文一字不改地重述，id 也一样换**。真机上最容易骗人的一条就是
   「正文没动，id 怎么变了」——这是设计行为，不是缺陷。
2. **换代是局部的**：只有被 `entries[].from` 提到的条目换 id，未提及的条目逐字节原样保留。
   而模型倾向合并内容扎实的事实，**恰好就是被检索得最多的那几条**，所以换血集中命中预取。
3. **热度断链的唯一情形是整编同时换了主题名**。`usage.json` 的 `entries` 键是条目 id，
   换代后旧键全成孤儿（不删，`usageSummary().entries` 只增不减）、新 id 从零起步；
   但 `entryHeat()` 取 `max(entryHits, topicHits)`，**只要主题名没变，热度就经 topic 接得回去**。
   风险集中在模型给同一件事起了第二个主题名。
4. **不用猜的信号：`runs.jsonl` 里该轮 `consolidation.orphanTopics` 非空 = 主题表里出现了
   没人用的名字**，配合该条目的 `topic` 新名即可确认热度断链确实发生，无需比对两份 usage.json。
   验收时每轮都该看一眼这个字段。

### 22. 整编输入的热度必须全量，不许只给前 10

`usageSummary().hottest` 是 `rows.slice(0, 10)`。盘上主题超过 10 个时，第 11 名往后的主题
在整编输入里「没有数字」，模型就有实锤机会把**还有热度、只是没进前 10** 的主题判成冷门
降进冷层——**而降级不可逆**：降下去之后它只出现在冷层检索里，用户更难发现。

定稿（区分用途，不让一个函数迁就两个消费者）：

- `usageSummary(usage)` 额外返回 **`topicRows`**：全部主题、按 hits 降序、元素 `{name, hits, last}`。
- **`hottest` 保持 top-10 不变**，它是面板用的热点视图。
- `deps.topicUsage`（`lib/index.js`）取 **`topicRows`**，不取 `hottest`。
- 体积无需担心：主题数已被 `TOPIC_LIST_MAX = 50` 闸住，50 行热度约 1.5 KB，
  而整编输入闸门是 120 000 字节且明令「不新增截断」。

整编输入里那一节的小标题措辞**必须说「没有数字表示这一轮没拿到它的命中数，不等于零命中」**，
不许简化回「没有数字表示还没有统计」（在前 10 截断下那句不成立，即便本条已修也留着当防线）。

## V8.16 撤除注入口径估算值（主人裁决，2026-11-11）

### 1. `GET /doc` 的 `tiering` 只报盘上事实

**背景**：v8.11 曾要求 `tiering` 同时给出注入口径（`injectedCore` / `hiddenCold` /
`overflowIds` / `coreBytes` / `indexBytes` / `totalBytes`）。那组值由 `tierOverview()` 现场
调一次 `buildProjectSection` 重算得到，而重算**没传 `usage`**（排序退化成纯时间倒序）、
**没传 `injectMaxBytes`**（缺总预算的第 2~5 级降级），所以它和那一轮真实注入可能对不上：
core 该留哪几条、有几条被折进目录、各段多少字节，全都可能不同。

**裁决**：估算不准就干脆不要。面板上对不上的数字比没有数字更糟——用户会拿它做决定。

- `tiering` 只保留 `core` / `cold` / `topics` / `orphanTopics` / `docBytes`，全部从磁盘现算；
- `tierOverview()` 里那段 `buildProjectSection` 重算整段删除，`projectName` 参数一并去掉；
- `lib/client.js` 的分层概览删掉「注入 core / 未注入冷层 / 折进目录 / core 段 / 目录段 /
  注入合计」六格与两条 core·目录预算条，只留盘上事实那一行；
- 对应九个词典键（`panel.tier.injectedCore` / `hiddenCold` / `overflow` / `coreBytes` /
  `indexBytes` / `totalBytes` / `budget.core` / `budget.index` / `injectUnknown`）四处全删。

**要观测真实注入了多少，唯一可信的途径是看那一轮的注入文本本身**（快照的
`byteSections.global` / `byteSections.project` 是落盘那一刻的真值，但它只有两段总计）。
不要再把「盘上文件多大」当成「上下文吃多少」——分层之后两者本来就不等。

### 2. 仍然保留的（同一裁决，明确不删）

- `tiering` 的盘上事实五项；
- `memory` 工具 `list` 的 `coreBytes` / `indexBytes`。

最后这条与本次撤除的东西**性质相同，都是重算值**，是否一并撤除尚未裁决；
在那之前保持现状，不许顺手改动。

（面板顶部两条预算条原本列在这里，已按下面第 3 条一并撤除。）

### 3. 面板顶部两条预算占用条一并撤除（同一裁决的延伸）

删掉的两条：

- **「注入」条**：`used = soul + user + global + project 四个文件字节之和`，`total = injectMaxBytes`。
  口径错误是结构性的——`soul`/`user` 走 systemPrompt 的 section、吃 `systemPromptMaxBytes`；
  `global`/`project` 走记忆快照、吃 `injectMaxBytes`。**两个预算下的内容不能相加再除以其中一个**。
  它同时也是「盘上文件大小」，而分层之后盘上大小 ≠ 注入量（冷层条目只进目录）。
- **「人格」条**：`used = soul.md 的文件字节`，`total = systemPromptMaxBytes`。真实的人格 section
  是 `buildPersonaSection({ soul, user })` 的输出，**含整个用户画像段和两个段标题**；
  只数 `soul.md` 会严重低估（实测 2018 vs 真实 5027 字节）。

配套删除：`BudgetBar` 组件、`.sm-budget` / `.sm-budget-head` / `.sm-bar` / `.sm-bar-fill*` 六条
样式、`panel.budget.inject` / `panel.budget.persona` 两个词典键、`injectBudget` / `personaBudget` /
`totalBytes` / `personaBytes` 四个局部变量。

**保留**：设置页的预算值本身（`injectMaxBytes` / `systemPromptMaxBytes` /
`projectCoreMaxBytes` / `projectIndexMaxBytes` 是真实的配置项，改它们有意义，值本身不是估算），
以及编辑器下方的「字节数：{bytes}」（那是文件真实大小，属盘上事实）。

**边界**：本次只动面板展示，`config` 里的预算字段与渲染层的裁剪逻辑一个字未改。

## V9.0 会话级人设（主人裁决，2026-11-11）

**产品决策（已确认，不再讨论）**：一个会话可单独指定人设；未指定则跟随全局 `currentPersona`。
分支会话**不继承**（普通 fork 的 header 不写 `parentSession`，只打 `isSeeded: true`，无法可靠上溯，
见 V9.1 第 4 条）。子智能体维持现状（`injectIntoSubagents: false` 本来就不注入）。

### V9.1 数据模型

文件：`<dshHome>/supermemory/session-personas.json`

```json
{ "version": 1, "sessions": { "session-0192...": "灰灰" } }
```

- **只记录被单独指定过的会话**。键缺席 = 跟随全局，绝不写「= 全局当前值」这类固化条目。
- 值是人设 slug（经 `personaSlug` 归一）。
- `version` 固定 `1`；非法/缺失一律按空表读取，**不猜、不迁移、不抛错**。
- 该文件不参与 `personas.json` 的迁移流程，两者彼此独立。

### V9.2 新模块 `lib/core/session-personas.js`（A 负责）

纯函数与一个轻量存储实例。**不 import 任何宿主包**，只依赖 `node:fs/promises`、`node:path`。

```js
export const SESSION_PERSONAS_VERSION = 1
export const SESSION_MAP_FILE = 'session-personas.json'
export const SESSION_ID_MAX = 200

/** 校验 sessionId：非空、≤200、白名单 [A-Za-z0-9._:-]、不含 NUL。 */
export function checkSessionId(value) -> { ok:true, value } | { ok:false, error }

/** 把任意读到的 JSON 收敛成 { version:1, sessions:{} }。非对象/sessions 非对象 → 空表。 */
export function normalizeSessionMap(value) -> { version:1, sessions:Record<string,string> }

/** 纯函数：返回新 map，不改入参。slug 经 personaSlug 归一。 */
export function setPersonaInMap(map, sessionId, slug) -> map

/** 纯函数：返回新 map，删掉 sessions[sessionId]。 */
export function clearPersonaInMap(map, sessionId) -> map

/** 纯函数：清掉所有值等于 slug 的条目。返回 { map, cleared }。 */
export function removePersonaFromMap(map, slug) -> { map, cleared:number }

/** 纯函数：解析某会话生效的人设。未绑定返回 fallback。 */
export function resolvePersonaForSession(map, sessionId, fallback) -> { slug:string, source:'session'|'global' }

/**
 * 建实例。filePath 是该 json 的绝对路径。
 * @returns {{
 *   ready: Promise<void>,
 *   get(sessionId) -> string|undefined,          // 同步读内存态；ready 未完成时返回 undefined
 *   getWithSource(sessionId) -> {slug,source}|undefined, // 同步，source 恒为 'session'
 *   snapshot() -> {version,sessions},            // 深拷贝，调用方改不到内存态
 *   set(sessionId, slug) -> Promise<{ok:true,sessions:object}|{ok:false,code,message}>,
 *   clear(sessionId) -> Promise<{ok:true,removed:boolean}|{ok:false,code,message}>,
 *   removePersona(slug) -> Promise<{ok:true,cleared:number}|{ok:false,code,message}>,
 *   dispose() -> Promise<void>,
 * }}
 */
export function createSessionPersonas({ filePath, logger, now }) -> instance
```

**铁律**：

1. `get` 必须**同步**——`systemPrompt.section` 的 `text` 回调同步执行，不能 await。
2. 任何 IO 异常一律转成返回值里的 `code`（`UNWRITABLE` / `BAD_INPUT`），**绝不抛**。
3. 写盘走「同目录临时文件 + rename」，并串行化同路径写（照 `store.js` 的 `enqueue` / `writeJsonAtomic` 写法）。
4. `set` / `clear` / `removePersona` 成功后立刻更新内存态；失败**不改**内存态。
5. 构造时异步加载一次，`ready` 完成前 `get` 返回 `undefined`（等价于跟随全局，安全降级）。

### V9.3 装配层接入 `lib/index.js`（Lead 负责）

`resolveScope(agent)` 取值顺序：

1. `agent.session.id` 有绑定 → 用它，`personaSource = 'session'`
2. 绑定的人设已不在 `store.listPersonas()` 里（已删）→ 回退全局，并 fire-and-forget 调
   `sessionPersonas.removePersona(slug)` 清僵尸
3. 否则 → 全局 `currentPersona()`，`personaSource = 'global'`

`resolveScope` 返回值新增 `personaSource` 字段（`'session'|'global'`），并透传到 `activeContext`，
供 bootstrap 展示。

`deps.personas.remove` 包装层在人设删除成功后调用 `sessionPersonas.removePersona(slug)`，
**不改 `lib/core/store.js`**。

### V9.4 路由 `lib/host/routes-session-persona.js`（B 负责）

新文件，导出 `createSessionPersonaHandlers({ deps, access }) -> { handleSessionPersona }`。
`ROUTES.sessionPersona` = `api/dsh-supermemory/session-persona`，由 Lead 在 `routes.js` 注册。

**GET** `?sessionId=<id>`

```json
{ "ok": true, "data": {
  "sessionId": "session-...",
  "persona": { "slug": "灰灰", "name": "灰灰" },
  "source": "session",
  "globalPersona": { "slug": "default", "name": "Default" },
  "personas": [ { "slug": "...", "name": "..." } ]
} }
```

- `persona` 是**本会话实际生效**的人设；`source` 说明它从哪来。
- 人设列表缺失时 `personas` 返回 `[]`，`persona` 仍要给出（按 slug 兜底 name）。
- `sessionId` 非法 → 400 `BAD_INPUT`。

**PUT** body `{ sessionId, slug }`

- `slug` 非空 → 绑定。人设不存在 → 404 `PERSONA_NOT_FOUND`。
- `slug` 为空串 → 清除绑定，恢复跟随全局（幂等，未绑定时也返回 ok）。
- 成功回带与 GET 相同的 `data` 结构，前端可直接替换本地态。
- `sessionId` 非法 → 400 `BAD_INPUT`；body 不是对象 → 400（交给 `readJsonBody`）。

**总开关**：与 `personas` 系列同口径——**不做 `pluginEnabled()` 拦截**（关闭插件后仍可改绑，
与「人设三件套不被软开关锁死」保持一致）。

### V9.5 客户端 `lib/client.js` + `locale/*.json`（C 负责）

槽位：`conversation.input.right`（输入框右侧、模型选择器左边），`inject: (sessionId) => ({...})`。

```js
ctx.slots.inject('conversation.input.right', () => ctx.slots.register(
  { name: 'conversation.input.right', id: 'supermemory-persona', order: 10, locale: NS },
  wirePersonaPill,
))
```

**重要**：`conversation.input.right` 只在 `sessionId !== undefined` 时渲染（宿主 `client.js` 的
渲染条件），所以组件可以假定 `sessionId` 存在；但仍要防御性地判空并返回 `null`。

组件行为：

- 胶囊按钮显示当前生效人设名，前面带一个人设小图标；`aria-label` 给完整说明。
- 点击展开下拉：第一项「跟随全局（{全局人设名}）」，其后是人设列表，当前项打勾。
- 选中即 `PUT session-persona`，成功后用响应回带的数据刷新本地态；失败恢复原状并提示。
- 本会话被单独指定时，胶囊加 `is-bound` 类（细描边），一眼区分于「跟随全局」。
- 只读不写：不提供新建/重命名/删除人设的入口（那是面板的职责）。
- 关闭点击外部 / Escape 收起；不用 `window.confirm`。
- 样式只许用 §9 的 `--dsw-alias-*` token，类名 `sm-persona-pill*`。

新增 locale 键（4 处逐键同步：内嵌 `en`/`zh` + `locale/en.json` + `locale/zh.json`）：

| key | zh |
|---|---|
| `pill.label` | 会话人设 |
| `pill.followGlobal` | 跟随全局（{name}） |
| `pill.bound` | 本会话单独指定：{name} |
| `pill.switched` | 已切换为「{name}」，下一轮发言生效。 |
| `pill.switchFailed` | 切换人设失败：{error} |
| `pill.loading` | 加载人设… |
| `pill.close` | 收起 |

**测试影响（必须同步，不许删断言）**：`test/client-toggle.test.js` 的
`assert.deepEqual(client.injected, ['sidebar.panellist', 'main', 'settings.section'])`
要改成包含新槽位的有序数组；`test/client-persona-crud.test.js` 若对 `slots` 数量有断言，同样同步。
这是**契约要求的同步修改**，不是删断言。

### V9.6 文件归属（v9，仅列新增/变更）

| 成员 | 独占写作用域 |
|---|---|
| Lead | `docs/CONTRACT.md`、`lib/index.js`、`lib/host/routes.js`（`ROUTES` 与 `registrations` 两处） |
| A core-session | `lib/core/session-personas.js`、`test/session-personas.test.js` |
| B host-routes | `lib/host/routes-session-persona.js`、`test/routes-session-persona.test.js` |
| C client | `lib/client.js`、`locale/en.json`、`locale/zh.json`、`test/client-persona-pill.test.js`，以及 §V9.5 列明的既有客户端测试同步 |

### V9.7 验收

- 全量 `node --test --test-concurrency=1` **0 fail**（基线 816 例只增不减）。
- 每条新增模块都要有自己的测试文件，覆盖：正常路径、非法输入、IO 失败降级、僵尸清理。
- 客户端用例必须能证明：未绑定时显示全局人设名、绑定时加 `is-bound`、切「跟随全局」会发空 slug。

## V10.0 修复会话人设串台与冷启动人格丢失（主人裁决，2026-11-11）

**背景**：v9 上线后，主人报告「新会话里选的人格不生效」。实测核对真实会话日志，
问题比报告严重得多——**不是第一条不生效，而是整场对话用错人格**：

| 会话 | 绑定人设 | 实际注入 |
|---|---|---|
| `session-5d88…` | 旺财 | 佩玲 |
| `session-a3dd…` | 旺财 | 旺财 |
| `session-271c…` | 来福 | 旺财 |

### V10.1 根因一：人格 section 读了模块级缓存 `activeScope`

`lib/host/inject.js` 的 `systemPrompt.section` 回调原先读 `activeScope`——一个由
`agent/pre-step` 维护的模块级单变量。宿主 `dsh-agent-loop` 的顺序是：

```
preStep(): systemPrompt.assemble(...)   ← section 回调在这里执行（第 679 行）
           dispatch.waterfall('agent/pre-step', ...)  ← adoptScope 在这里才更新（第 685 行）
```

两个致命后果：

1. **慢一轮**：section 读到的永远是上一轮的值。新会话第一次发言时 `activeScope`
   里是任意其它会话的残留，因此「第一次发言必错」。
2. **跨会话串台**：单变量被所有会话共享，多会话交替时后处理的会话覆盖前一个。

**修法**：section 回调改为**按传入的 `assembly.agent` 现场同步解析**，绝不读模块级状态。

- `lib/index.js` 新增 `resolvePersonaSync(agent)`：同步、按 agent 现算，返回
  `{ persona, personaSource }`。只调同步 API（`currentPersona` / `listPersonas` /
  `sessionPersonas.get`），因此可在 section 回调里直接跑。
- `lib/index.js` 的 `resolveScope` 改为复用 `resolvePersonaSync`（单一来源）。
- `lib/host/inject.js` 新增 `resolvePersonaOf(agent)`：优先用 `deps.resolvePersonaSync`，
  缺失时退回只认全局 current 的最小实现。
- 快照侧同步清理：`composeSnapshot` 的 `projectName` 改为由调用方从本次 `scope` 传入，
  pre-step 内的 `persona` / `projectRoot` 一律用局部 `scope`，不再读 `activeScope`。

**保留**：`activeScope` 仍存在，但**只**服务快照侧的既有逻辑（`adoptScope` 的写入）
与 bootstrap 展示，**不得**再作为人格来源。

### V10.2 根因二：`readDocSync` 冷启动返回空模板

`store.readDocSync` **只读进程内缓存、不读盘**（这是它的既有契约，见 store.js 注释）。
进程刚启动时缓存为空，它返回空模板：

```
实测：首次同步读得到 57 字节的空模板（"# 人格 (soul)\n\n<!-- 由 … -->\n\n## 条目\n"），
      真实内容要等异步 readDoc 之后才进缓存。
```

于是即使人设解析正确，冷启动第一次注入也可能是空人格。

**修法**：`agent/created` 时按该 agent 实际生效的人设（会话绑定优先）异步预热
soul / user 进缓存。

**关键**：监听器必须 **`return` 那个 Promise**。`dsh-agent` 的 `announce()` 是
`await ctx.serial(..., "agent/created", ...)`，宿主会等监听器的返回值。早先写成
`Promise.resolve().then(...)` 且不 return，等于 fire-and-forget，宿主立刻往下走，
第一次 assemble 仍可能在预热完成前执行——这是最后一道口子。

### V10.3 测试（`test/session-persona-isolation.test.js`，8 例）

守护点：

1. 多会话交替（A→B→A→C→B→A）每次 section 都取到各自的人设，绝不串台；
2. **没跑过 pre-step** 也能拿到正确人设（旧实现的致命点）；
3. 切换绑定后下一次 section 立刻跟随；
4. 绑定的人设被删 → 回退全局，不注入空人格；
5. 全局 current 变更：未绑定会话跟随，已绑定会话不受影响；
6. 调用日志证明是「按 agent 现算」（每次渲染触发一次现算）；
7. pre-step 快照用本次 scope，不混入其它会话的记忆；
8. 冷启动空缓存：`agent/created` 的预热必须在宿主 await 结束前完成。

**夹具两条硬约定**（踩过）：

- 必须复刻宿主的 `decision.messages` 提交动作，否则首次快照永远落不到日志；
- session 桩必须预置 `system/message` 占 `events[0]`（受保护头部），否则注入整体让路。

**已反向验证**：把 section 改回读模块级缓存后，8 例中 6 例转红；把 `agent/created`
改回 fire-and-forget 后第 8 例转红。这两次反向验证证明了用例确实能抓住该缺陷。

### V10.4 明确不做（主人裁决）

- **空白会话 id 可能被 Host 更换**（`dsh-api-session-controller` 的
  `if (!reusable) return this.createMinted(...)`）：本次不修，先观察修完 V10.1/V10.2
  后的实际表现。若仍有「绑定丢失」，再单独处理。
