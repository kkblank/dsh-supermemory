# dsh-supermemory

给 DeepSeek Harness 加上「人格 + 用户画像 + 全局长期记忆 + 项目记忆」的持久记忆插件。

每个会话自动带上四段记忆，可在 Web UI 里查看、编辑、手动整理；Agent 也能通过
`memory` 工具读写检索。人格/画像/全局记忆按 **agent 预设** 隔离，项目记忆按
**项目根目录** 隔离。

---

## 它做什么

| 能力 | 说明 |
|---|---|
| 自动注入 | 新建会话时，提示词里自动出现人格、用户画像、全局记忆、项目记忆 |
| 按预设隔离 | `soul.md` / `user.md` / `global-memory.md` 每个 agent 预设一份 |
| 按项目隔离 | `<项目根>/.dsh/memory/project-memory.md`，不同项目互不可见 |
| 单条快照 | 记忆内容变化后下一次请求即生效，历史里始终只有一条最新快照，不随轮次累积 |
| Web 面板 | 侧栏「记忆」图标 → 独立面板，分区切换、编辑保存、mtime 冲突检测 |
| 设置页 | 只读概览：目录、预算占用、触发阈值、最近整理 |
| 自动整理 | 每 N 轮 / 上下文压力超阈值 / 手动触发，把增量写进对应文件并出报告 |
| `memory` 工具 | Agent 可 list / read / search / append / replace / digest |
| 预算降级 | 记忆超预算时自动降级为「索引 + 摘要」，不会无限膨胀提示词 |

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
  presets/<presetSlug>/
    preset.json            # { id: 原始 preset id, updatedAt }
    soul.md                # 人格设定
    user.md                # 用户画像
    global-memory.md       # 跨项目长期记忆
  projects.json            # 已知项目索引 [{ path, root, name, lastSeenAt }]
  runs.jsonl               # 最近整理报告（最多保留 200 条）
```

```
<项目根>/.dsh/memory/
  project-memory.md        # 该项目专属记忆
```

- `presetSlug`：preset id 里 `[^a-zA-Z0-9._-]` 替换为 `-`，空则 `default`；
  原始 id 存在 `preset.json`，注入文件名不影响语义。
- 项目根：从会话 cwd 向上找 `.git`，找不到则用 cwd 本身。
- 文件不存在时按需创建（首次注入或首次写入），不预建所有项目目录。

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

## 配置

在 `cordis.patch.yml` 的 `supermemory` 行里改；全部字段 `.volatile()`，设置页改动即时生效。

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关（`false` 时不注入、不注册工具与面板） |
| `presetsRoot` | 空（= `$DSH_HOME/supermemory/presets`） | 记忆根目录 |
| `projectDirName` | `.dsh/memory` | 项目内目录 |
| `projectFileName` | `project-memory.md` | 项目记忆文件名 |
| `systemPromptMaxBytes` | `12000` | 人格+画像进系统提示的上限 |
| `injectMaxBytes` | `24000` | 全局+项目注入消息的上限 |
| `autoDigest` | `true` | 自动整理开关 |
| `digestEveryTurns` | `5` | 每 N 轮整理（0 关闭） |
| `digestPressureRatio` | `0.75` | 上下文压力阈值（0 关闭） |
| `digestMaxInputBytes` | `120000` | 整理请求输入上限 |
| `digestMaxOutputTokens` | `3000` | 整理输出上限 |
| `digestProvider` / `digestModel` | 空 | 空则沿用当前会话路由 |
| `injectIntoSubagents` | `true` | 子智能体是否带记忆 |

## `memory` 工具

| 参数 | 说明 |
|---|---|
| `action` | `list` / `read` / `search` / `append` / `replace` / `digest` |
| `scope` | `soul` / `user` / `global` / `project` |
| `query` | `search` 时必填，关键词或简单正则 |
| `content` | `append` / `replace` 时必填 |
| `reason` | 写入原因，写进条目元数据 |

`project` 作用域的项目根由会话 cwd 自动解析，**不接受模型传入任意路径**；
所有路径穿越都被拒绝。

## 斜杠命令

- `/remember [scope] <内容>` —— 等价 `memory append`，默认 `global`
- `/memory-digest` —— 立即整理一次

## 停用

把 `cordis.patch.yml` 里 `enabled` 改成 `false`，或在插件管理页禁用 `supermemory` 行。
停用后不注入、不注册工具与面板。

## 已知边界

- 不做向量/embedding 语义检索（纯 md + 关键词/全文）。
- 不做文件版本历史与回滚。
- 不做敏感信息过滤。
- 不跨机器同步，不做记忆导入导出。
- 不修改宿主 `dsh-system-prompt` / `dsh-agent-instructions` 或其它已装插件。

## 开发

```bash
node --test          # 全部单测（190 个用例）
```

`test/` 下按模块分组：

| 文件 | 覆盖 |
|---|---|
| `paths-document.test.js` | slug / 项目根 / 安全 join / md 文档格式 / 配置 |
| `store.test.js` | 原子写、mtime 冲突、并发写、runs.jsonl、projects.json |
| `render-digest.test.js` | 注入渲染、预算降级、转义、整理解析与合并 |
| `host-install.test.js` | 注入链路、memory 工具、斜杠命令 |
| `routes.test.js` | HTTP 路由、STALE 冲突、请求体上限、整理器 |
| `injection-trigger.test.js` | 自动整理触发（轮数 / 压力 / 负向拦截）+ 快照回归 |
| `trust-fence.test.js` | 信任栅栏五维矩阵（socket / 代理头 / Host / Origin / Sec-Fetch-Site） |

本地跑测试需要 `@deepseek-ai/schemastery`（唯一宿主依赖，仅 `lib/host/config.js` 使用）。
工作区的 `node_modules/@deepseek-ai/` 是开发时的副本，已由 `.gitignore` 排除；
插件安装到 profile 后从 profile 的 `node_modules` 解析，不依赖这份副本。

`docs/CONTRACT.md` 是模块契约，`docs/WORKER.md` 是协作须知。

## 浏览器验证说明

面板与设置页的**运行时 slot 注册**已通过 `cordis_inspect_query` 确认
（`sidebar.panellist` / `main` / `settings.section` 三处 occupant 均 active），
Client bundle 也已确认被宿主打包并进入页面加载清单。
但**视觉渲染未验证**：验证环境没有可用的 Chromium，无法截图。
如需确认外观，请刷新 Web GUI 后点侧栏「记忆」图标。

## License

MIT
