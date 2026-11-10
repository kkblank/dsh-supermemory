# dsh-supermemory

给 DeepSeek Harness 加上「人格 + 用户画像 + 全局长期记忆 + 项目记忆」的持久记忆插件。

每个会话自动带上记忆，可在 Web UI 里查看、编辑、手动整理；Agent 也能通过
`memory` 工具读写检索。人格/画像/全局记忆按 **人设** 隔离，项目记忆按
**项目根** 隔离。

---

## 它做什么

| 能力 | 说明 |
|---|---|
| 自动注入 | 新建会话时，提示词里自动出现人格、用户画像、全局记忆、项目记忆 |
| 按人设隔离 | `soul.md` / `user.md` / `global-memory.md` 每个人设一份 |
| 按项目隔离 | `<项目根>/.dsh/memory/project-memory.md`，不同项目互不可见 |
| 单条快照 | 记忆内容变化后下一次请求即生效，历史里始终只有一条最新快照，不随轮次累积 |
| Web 面板 | 侧栏「记忆」图标 → 独立面板，切换人设/项目、编辑保存、mtime 冲突检测 |
| 设置页 | 只读概览：目录、预算占用、触发阈值、最近整理 |
| 手动整理 | 每 N 轮 / 上下文压力超阈值 / 手动按钮触发，**只写项目记忆** |
| 整理模型可选 | 面板里从已配置模型中选择整理用的模型，或跟随当前会话 |
| `memory` 工具 | Agent 可 list / read / search / append / replace / digest |
| 预算降级 | 记忆超预算时自动降级为「索引 + 摘要」，不会无限膨胀提示词 |
| 压缩补偿 | 上下文被压缩摘要覆盖后，下一轮自动重写完整记忆快照；digest 不变、不会多出第二条 |

## 写入策略（v2 起）

| 分区 | 自动整理 | Agent 工具 | 用户手动 |
|---|---|---|---|
| 人格 `soul` | ❌ 永不 | 仅当用户明确要求改人设，且带 `confirmSoul: true` | ✅ |
| 用户画像 `user` | ❌ 永不 | ✅ 但只写用户明确陈述的偏好/事实 | ✅ |
| 全局记忆 `global` | ❌ 永不 | ✅ 同上 | ✅ |
| 项目记忆 `project` | ✅ 唯一自动写入的分区 | ✅ | ✅ |

自动整理只在**项目记忆**上工作：它读最近对话，提炼与当前项目相关的新增约定/决策/坑，
追加写进 `<项目根>/.dsh/memory/project-memory.md`。

## 安装

在 DSH 的 `web` profile 里安装本目录（工作区绝对路径）：

```js
plugin_manager({ action: 'install_bundle',
                 target: '/home/fxy/data/workspace/dsh-plugin/dsh-supermemory' })
```

安装后确认返回 `application: applied`，然后刷新页面。

## 数据放在哪

```
$DSH_HOME/supermemory/
  personas.json                    # { version, current, personas:[{slug,name,createdAt}] }
  personas/<slug>/
    soul.md                        # 人格设定
    user.md                        # 用户画像
    global-memory.md               # 跨项目长期记忆
  settings.json                    # { digestProvider, digestModel }
  projects.json                    # 仅记录 lastSeenAt，不作为项目列表来源
  runs.jsonl                       # 最近整理报告（最多保留 200 条）
```

```
<项目根>/.dsh/memory/
  project-memory.md                # 该项目专属记忆
```

- **人设**：面板下拉里的条目，可新增。每个拥有独立的 soul/user/global。
  首次安装自动创建 `Default` 人设。
- `slug`：人设名里保留 Unicode 字母数字（含中文），其它字符折叠为 `-`，
  上限 48 字符；空/全非法回退 `default`。所以「工作助手」会得到
  `personas/工作助手/`。
- **项目列表自动同步宿主工作区**（`workspaceRegistry`），不需要手动添加；
  有几个工作区项目就有几份项目记忆。
- 项目根：从会话 cwd 向上找 `.git`，找不到则用 cwd 本身。

## 文件格式

四个文件统一格式：

```md
# 全局长期记忆

<!-- 由 dsh-supermemory 维护；可直接编辑。 -->

## 条目

- 2026-11-10T10:00:00.000Z · source:user-request
  内容第一行
  内容第二行
```

## 注入长什么样

系统提示里加一段人格 + 画像（`supermemory:persona` section），
对话里加一条可替换的快照消息：

```
<supermemory>
## 人格 (soul)
...
## 用户画像 (user)
...
## 全局长期记忆 (global)
...
## 项目记忆 (project: <项目根名>)
...
</supermemory>
```

- 内容里的 `</supermemory>` 会被转义，防止提前闭合。
- `{{...}}` 按字面量保留（section 用 `interpolate: false`）。
- 四段合并字节超 `injectMaxBytes` 时，改为输出索引（每文件标题、一级小节、
  更新时间、字节数）+ 一行「完整内容可用 memory 工具按需读取。」

**压缩之后**：宿主压缩会写一条 checkpoint，用 `surfaceOp: replace` 把整段
surface 区间换掉，本插件的快照可能被一起吞掉。因此每轮 pre-step 都做一次
重同步判定——快照已不在 surface 上，或最近一次压缩晚于快照，就重写一条。
重写后的正文与 digest **逐字节不变**，不往记忆里掺「上下文已压缩」这类提示；
收敛后不会反复重写。快照存活判定优先看 `session.surface.nodes`，拿不到时
按压缩事件的 `shadowedSeqs` 排除，两者都没有才退回日志顺序。

## 配置

在 `cordis.patch.yml` 的 `supermemory` 行里改；全部字段 `.volatile()`，设置页改动即时生效。

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关（`false` 时不注入、不注册工具与面板） |
| `personasRoot` | 空（= `$DSH_HOME/supermemory/personas`） | 人设根目录 |
| `projectDirName` | `.dsh/memory` | 项目内目录 |
| `projectFileName` | `project-memory.md` | 项目记忆文件名 |
| `systemPromptMaxBytes` | `12000` | 人格+画像进系统提示的上限 |
| `injectMaxBytes` | `24000` | 全局+项目注入消息的上限 |
| `autoDigest` | `true` | 自动整理开关 |
| `digestEveryTurns` | `5` | 每 N 轮整理（0 关闭） |
| `digestPressureRatio` | `0.75` | 上下文压力阈值（0 关闭） |
| `digestMaxInputBytes` | `120000` | 整理请求输入上限 |
| `digestMaxOutputTokens` | `3000` | 整理输出上限 |
| `digestProvider` / `digestModel` | 空 | 默认整理模型；面板里选的值优先 |
| `digestWritableScopes` | `['project']` | 整理可写的分区（v2 硬限制为 `project`） |
| `injectIntoSubagents` | `false` | 子智能体是否带记忆；默认**不带**，需要时显式配 `true` |
| `compactionRecall` | `true` | 压缩后快照自愈与补偿重写；`false` 退回「仅内容变化才重写」 |

> 旧字段名 `presetsRoot` 仍被接受，等价于 `personasRoot`。

**整理模型优先级**：面板选择（`settings.json`）→ 配置里的 `digestProvider/Model`
→ 当前会话路由 → 宿主默认模型。每层要求 provider 与 model 同时非空。

## `memory` 工具

| 参数 | 说明 |
|---|---|
| `action` | `list` / `read` / `search` / `append` / `replace` / `digest` |
| `scope` | `soul` / `user` / `global` / `project` |
| `query` | `search` 时必填，检索词；自动分词并补中文相邻二元组，按相关性排序。不支持正则 |
| `content` | `append` / `replace` 时必填 |
| `reason` | 写入原因，写进条目元数据 |
| `confirmSoul` | 写 `soul` 时必须为 `true`；否则返回 `SOUL_CONFIRM_REQUIRED` |

`project` 作用域的项目根由会话 cwd 自动解析，**不接受模型传入任意路径**；
所有路径穿越都被拒绝。

## 斜杠命令

- `/remember [scope] <内容>` —— 等价 `memory append`，默认 `global`
- `/remember soul --confirm <内容>` —— 改动人格需要 `--confirm`
- `/memory-digest` —— 立即整理一次（只写项目记忆）

## 停用

把 `cordis.patch.yml` 里 `enabled` 改成 `false`，或在插件管理页禁用 `supermemory` 行。
停用后不注入、不注册工具与面板。

## 已知边界

- 不做向量/embedding 语义检索（纯 md + 词法检索；中文按相邻二元组近似分词）。
- 压缩补偿只重发快照，不改写压缩摘要，也不保证摘要本身保留了记忆内容。
- 不做文件版本历史与回滚。
- 不做敏感信息过滤。
- 不跨机器同步，不做记忆导入导出。
- 不修改宿主 `dsh-system-prompt` / `dsh-agent-instructions` 或其它已装插件。

## 开发

```bash
node --test          # 全部单测（344 个用例）
```

`test/` 下按模块分组：

| 文件 | 覆盖 |
|---|---|
| `paths-document.test.js` | 人设 slug（含中文）、项目根、安全 join、md 文档格式、配置 |
| `store.test.js` | 原子写、mtime 冲突、并发写、人设注册表、settings、迁移、runs |
| `render-digest.test.js` | 注入渲染、预算降级、转义、整理解析与合并 |
| `host-install.test.js` | 注入链路、memory 工具、soul 写保护、斜杠命令 |
| `routes.test.js` | HTTP 路由、models/settings/personas、STALE 冲突、整理器 |
| `injection-trigger.test.js` | 自动整理触发（轮数 / 压力 / 负向拦截）+ 只写 project |
| `compaction-recall.test.js` | 压缩遮蔽识别、快照重建、防抖动、开关对照 |
| `search.test.js` | 分词与中文二元组、块聚合打分、排序截断、字面兜底 |
| `client-toggle.test.js` | 面板总开关前端态 |
| `trust-fence.test.js` | 信任栅栏五维矩阵 |

本地跑测试需要 `@deepseek-ai/schemastery`（唯一宿主依赖，仅 `lib/host/config.js` 使用）。
工作区的 `node_modules/@deepseek-ai/` 是开发时的副本，已由 `.gitignore` 排除；
插件安装到 profile 后从 profile 的 `node_modules` 解析，不依赖这份副本。

`docs/CONTRACT.md` 是模块契约（末尾「v2 变更」章节覆盖前文的 preset 概念），
`docs/WORKER.md` 是协作须知。

## 浏览器验证说明

面板与设置页的**运行时 slot 注册**已通过 `cordis_inspect_query` 确认
（`sidebar.panellist` / `main` / `settings.section` 三处 occupant 均 active），
Client bundle 也已确认被宿主打包并进入页面加载清单。
但**视觉渲染未验证**：验证环境没有可用的 Chromium，无法截图。
如需确认外观，请刷新 Web GUI 后点侧栏「记忆」图标。

## License

MIT
