# 队员须知（先读我，再读 CONTRACT.md）

## 你是谁

你是 `dsh-supermemory` 插件实现团队的成员。工作目录：本仓库根目录。

Lead 已完成：`package.json`、`cordis.patch.yml`、`lib/index.js`、`docs/CONTRACT.md`。

## 唯一权威文档

**`docs/CONTRACT.md`** 是你的实现契约。开工前**完整读一遍**，
然后只做契约里分给你的那部分。需求背景 `PLAN.md` 不随仓库分发
（只读参考，冲突时以 CONTRACT.md 为准）。

## 三条铁律

### 1. 不要 import 任何 `@deepseek-ai/*` 宿主包

本工作区**解析不到** `@deepseek-ai/dsh-*` 和 `@deepseek-ai/cordis`。已实测：

```
$ node -e "import('@deepseek-ai/dsh-llm')"   → ERR_MODULE_NOT_FOUND
```

- 唯一例外：`@deepseek-ai/schemastery`，且**只在 `lib/host/config.js`** 里 import。
  Lead 已经把它和它的依赖 `@deepseek-ai/cosmokit` 复制到本包
  `node_modules/@deepseek-ai/` 下，所以本地 `node --test` 能解析。
  **不要**把 `node_modules` 加进 git / 打包 / `files`，那是本地自测用的。
- 宿主能力一律 `ctx.get('serviceName')` 可选获取。
- 构造消息对象手写普通对象，不要 import `createUserMessage`。
- 客户端 `lib/client.js` 只有 `require('react')`。

写代码时如果发现"必须 import 宿主包才能做"，**停下来，在完成报告里写明**，
不要自己想办法绕（比如写个假的 node_modules 或改 package.json 加依赖）。

### 2. 只改你负责的文件

契约 §1 有完整的文件归属表。改别人的文件会导致冲突。
需要别人改什么 → 在完成报告里提出来，不要自己动手。

### 3. 自检通过再交

```bash
cd /path/to/dsh-supermemory        # 本仓库根目录
node --check lib/你的文件.js          # 每个文件都要过
node --test test/你的测试.js          # 你负责的测试必须全绿
node --test --test-concurrency=1    # 交活前跑全量，串行口径，必须 0 fail
```

**测试的三条硬约定**（踩过，别再踩）：

- **全量必须串行 `--test-concurrency=1`**。默认并发下注入相关用例会互相干扰，抖出二十多条
  与改动无关的假红，而且同一份代码不同人看到的红名单还不一致——一份每人不同的红名单没有价值。
- **不要写 `node --test test/`**（目录形式），本机 Node 24 会把它当模块解析。
- **渲染层用例一律显式传预算**，不许吃配置默认值。这样调默认预算只需同步配置侧那几处断言，
  渲染用例不会被连带改红；反过来，渲染用例也不许改成吃默认预算来"少写几个参数"。

测试用 `node:test` + `node:assert/strict`，不装任何依赖。
测试涉及文件系统时用 `node:fs.mkdtemp` 建临时目录，`after` 里清理。

## 怎么干活

1. 在团队任务板上找到分给你的任务，`claim` 它。
2. 读 CONTRACT.md 对应章节。
3. 写代码 + 测试。
4. 自检（语法 + 测试）。
5. `complete` 任务，然后给 Lead 发一条 `send_message`，内容包含：
   - 你改了哪些文件（路径列表）
   - 测试跑了什么、结果如何（贴关键输出）
   - 契约里没写清、你自行决定的点
   - 你发现但没改的别人的问题
   - 已知限制 / 未验证的部分

## 代码风格

- ESM，纯 JS，不用 TypeScript，无构建步骤。
- 中文注释，JSDoc 用 `@param` / `@returns`。
- 单文件 ≤ 400 行，超了就拆（拆出的文件仍要在你的 scope 内）。
  - **但达标不是目的，清晰才是：不能拆的不要硬拆。** 两种情况按豁免处理，
    在汇报里说明理由即可，不要为了行数牺牲内聚：
    1. `lib/client.js` **永远保持单文件**，不在拆分范围内。宿主只按
       `package.json` 的 `exports["./client"]` 加载这一个文件，拆出去的模块
       宿主不会加载；官方同类客户端能多文件开发是因为它们有构建步骤把 `src/`
       打包成产物，而本项目「无构建步骤」是硬约束。参照：官方 client.js 产物
       动辄上万行，400 行规范对浏览器单文件包不适用。
    2. 拆分后需要把闭包状态当参数传来传去、或者反而降低可读性的，就地保留。
       例：`createStore` / `createDigestRunner` / `installRoutes` 这些持有闭包状态
       与装配职责的工厂本体，外拆属于重新设计而非搬运，不在行数重构范围内。
- 所有 IO 错误必须捕获并转成返回值里的错误码，**不要抛**到宿主。
- 时间统一 ISO 8601 UTC：`new Date().toISOString()`。

## 关于运行环境

- Node v24.22.2，`node --test` 可用。
- 不要 `npm install` / `pnpm add` 任何包。
- 不要修改 `~/.dsh` 下任何东西。
- 不要安装插件（那是 Lead 的活）。
