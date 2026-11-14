/**
 * dsh-supermemory — Web UI 客户端（侧栏记忆面板 + 设置页概览）。
 *
 * 约束（见 docs/CONTRACT.md §7、§9）：
 *   - 手写模块工厂，无编译步骤，因此不用 JSX，全部 React.createElement。
 *   - 只允许 require('react')：本工作区解析不到任何宿主 Client 包。
 *   - 数据全部走 document-relative 的 fetch('api/dsh-supermemory/...')。
 *   - 样式只用 §9 的 --dsw-alias-* token，类名统一 sm- 前缀。
 *   - 不读宿主 DOM，不向 document.body 追加节点。
 */
window.__ModuleLoader__.load({
  id: 'dsh-supermemory',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** 插件专用 locale 命名空间，同时是侧栏 id 与主面板 key。 */
    const NS = 'supermemory'
    /** HTTP 前缀：document-relative，不带前导斜杠。 */
    const API = 'api/dsh-supermemory'
    /** 四个记忆分区，顺序即左侧导航顺序。 */
    const SCOPES = ['soul', 'user', 'global', 'project']

    // —— 词典：与 locale/en.json、locale/zh.json 逐键一致 ——
    const en = /*__EN_START__*/{
        "common.off": "Off",
        "common.on": "On",
        "meta.description": "Persona, user profile, global memory and project memory, injected into every session and editable from the Web panel.",
        "meta.title": "Memory",
        "panel.bytes": "Bytes: {bytes}",
        "panel.conflict": "This file was modified outside the panel.",
        "panel.conflictHint": "Reload to read the latest disk content; copy your edits first if you want to keep them.",
        "panel.digest.consolidation": "consolidated: +{added} merged {merged} dropped {dropped} kept {kept}",
        "panel.digest.counts": "soul {soul} · user {user} · global {global} · project {project}",
        "panel.digest.disabledHint": "Digest is unavailable while the plugin is off.",
        "panel.digest.done": "Digest finished.",
        "panel.digest.failed": "Digest failed: {error}",
        "panel.digest.invalidTiers": "invalid tier values {count}",
        "panel.digest.model": "Digest model",
        "panel.digest.modelFollow": "Follow current session",
        "panel.digest.modelSaveFailed": "Could not save the digest model: {error}",
        "panel.digest.modelSaved": "Digest model saved.",
        "panel.digest.orphanTopics": "orphan topics {count}",
        "panel.digest.none": "No digest has run yet.",
        "panel.digest.now": "Digest now",
        "panel.digest.running": "Digesting…",
        "panel.digest.status.failed": "failed",
        "panel.digest.status.ok": "succeeded",
        "panel.digest.tiers": "tiers: core {core} · cold {cold} · topics {topics}",
        "panel.digest.title": "Latest digest",
        "panel.digest.trigger.manual": "manual",
        "panel.digest.trigger.pressure": "pressure",
        "panel.digest.trigger.tool": "tool",
        "panel.digest.trigger.turns": "turns",
        "panel.dirty": "Unsaved changes",
        "panel.disabledNotice": "Memory is turned off: nothing is injected and nothing is auto-digested. You can still read and edit every memory file here; switch it back on in Settings → Memory.",
        "panel.empty": "No content yet.",
        "panel.loadFailed": "Could not load the file: {error}",
        "panel.loading": "Loading…",
        "panel.modified": "Modified: {time}",
        "panel.modifiedNever": "never written",
        "panel.noPersona": "No personas",
        "panel.noProject": "No projects",
        "panel.persona": "Persona",
        "panel.personaAdd": "Add persona",
        "panel.personaAddPlaceholder": "New persona name",
        "panel.personaCancel": "Cancel",
        "panel.personaCreate": "Create",
        "panel.personaCreateFailed": "Could not create persona: {error}",
        "panel.personaDelete": "Delete persona",
        "panel.personaDeleteConfirm": "Delete “{name}” together with its soul, user profile and global memory? This cannot be undone.",
        "panel.personaDeleteFailed": "Could not delete persona: {error}",
        "panel.personaDeleteLocked": "The Default persona cannot be deleted.",
        "panel.personaDeleted": "The persona and its memory files are gone.",
        "panel.personaRename": "Rename",
        "panel.personaRenameFailed": "Could not rename persona: {error}",
        "panel.personaRenamed": "Persona renamed.",
        "panel.personaSwitched": "Persona switched.",
        "panel.project": "Project",
        "panel.projectAuto": "Synced from your workspace.",
        "panel.reload": "Reload",
        "panel.reloaded": "Reloaded from disk.",
        "panel.root": "Root: {path}",
        "panel.save": "Save",
        "panel.saveFailed": "Could not save the file: {error}",
        "panel.saved": "Saved.",
        "panel.saving": "Saving…",
        "panel.section.global": "Global memory",
        "panel.section.project": "Project memory",
        "panel.section.soul": "Persona",
        "panel.section.user": "User profile",
        "panel.tier.cold": "Cold entries",
        "panel.tier.core": "Core entries",
        "panel.tier.docBytes": "On disk",
        "panel.tier.hint": "Core entries stay in context; cold entries stay on disk and are fetched by the memory tool.",
        "panel.tier.mode": "Tiered injection",
        "panel.tier.modeUnknown": "not reported by the server",
        "panel.tier.offHint": "Tiered injection is off: the whole project memory is injected verbatim, so cold entries cost context every round.",
        "panel.tier.orphanTopics": "Orphan topics",
        "panel.tier.title": "Tiering",
        "panel.tier.topics": "Topics",
        "panel.tier.heat": "Memory heat (decayed)",
        "panel.tier.heatHint": "Heat only affects ordering and this display, never core/cold. Topics appear only after a digest has built the topic table; before that every row is an entry.",
        "panel.tier.heatHits": "Hits",
        "panel.tier.heatAge": "Last used",
        "panel.tier.heatScore": "Score",
        "panel.tier.heatEmpty": "No search hits recorded yet.",
        "panel.tier.entryPrefix": "entry",
        "panel.tier.heatItem": "Entry",
        "panel.tier.heatNoBody": "(no body text)",
        "panel.title": "Memory",
        "pill.bound": "Set for this session: {name}",
        "pill.close": "Close",
        "pill.followGlobal": "Follow global ({name})",
        "pill.label": "Session persona",
        "pill.loading": "Loading personas…",
        "pill.switched": "Switched to “{name}”; takes effect on your next message.",
        "pill.switchFailed": "Could not switch persona: {error}",
        "settings.budgets": "Budgets and thresholds",
        "settings.configExample": "Configuration example (cordis.patch.yml)",
        "settings.description": "Read-only overview of where dsh-supermemory stores memory, how it is resolved, and the budgets it applies.",
        "settings.enable": "Plugin master switch",
        "settings.enableAria": "Turn the memory plugin on or off",
        "settings.enableBusy": "Saving…",
        "settings.enableFailed": "Could not change the switch: {error}",
        "settings.enableHint": "When off: no persona or memory snapshot is injected, the memory tool and the /remember and /memory-digest commands refuse to run, and automatic digest stops. The panel stays available — you can still read and edit every memory file; only “Digest now” is blocked. The switch is stored in settings.json inside your memory home. It is not the same as “enabled” in cordis.patch.yml: that one is a hard switch that unmounts the panel as well, and both must be on.",
        "settings.enableRow": "Plugin state",
        "settings.enableUnknown": "the server did not confirm the new state",
        "settings.home": "Memory home",
        "settings.loadFailed": "Could not load the memory overview: {error}",
        "settings.loading": "Loading…",
        "settings.none": "None",
        "settings.openPanel": "Open memory panel",
        "settings.overview": "Overview",
        "settings.presetsRoot": "Presets directory",
        "settings.projectRule": "Project memory path",
        "settings.recentDigest": "Latest digest",
        "settings.row.autoDigest": "Automatic digest",
        "settings.row.digestEveryTurns": "Digest every N turns",
        "settings.row.digestModel": "Digest model",
        "settings.row.digestPressureRatio": "Context pressure threshold",
        "settings.row.digestProvider": "Digest provider",
        "settings.row.injectIntoSubagents": "Inject into subagents",
        "settings.row.injectMaxBytes": "Injection budget (bytes)",
        "settings.row.presets": "Presets",
        "settings.row.projectCoreMaxBytes": "Core section budget (bytes)",
        "settings.row.projectDirName": "Project directory name",
        "settings.row.projectFileName": "Project file name",
        "settings.row.projectIndexMaxBytes": "Topic index budget (bytes)",
        "settings.row.projects": "Known projects",
        "settings.row.systemPromptMaxBytes": "System prompt budget (bytes)",
        "settings.row.tieredInjection": "Tiered injection",
        "settings.title": "Memory",
        "settings.unavailable": "The memory panel is not available in this client.",
  }/*__EN_END__*/
    const zh = /*__ZH_START__*/{
        "common.off": "关闭",
        "common.on": "开启",
        "meta.description": "人格、用户画像、全局记忆与项目记忆：注入每个会话，并可在 Web 面板中直接编辑。",
        "meta.title": "记忆",
        "panel.bytes": "字节数：{bytes}",
        "panel.conflict": "文件已被外部修改。",
        "panel.conflictHint": "请重新载入以获取磁盘上的最新内容；如需保留当前修改，请先复制。",
        "panel.digest.consolidation": "整编：写入 {added} · 合并 {merged} · 移除 {dropped} · 保留 {kept}",
        "panel.digest.counts": "人格 {soul} · 画像 {user} · 全局 {global} · 项目 {project}",
        "panel.digest.disabledHint": "插件关闭时不能手动整理。",
        "panel.digest.done": "整理完成。",
        "panel.digest.failed": "整理失败：{error}",
        "panel.digest.invalidTiers": "非法 tier 值 {count}",
        "panel.digest.model": "整理模型",
        "panel.digest.modelFollow": "跟随当前会话",
        "panel.digest.modelSaveFailed": "保存整理模型失败：{error}",
        "panel.digest.modelSaved": "整理模型已保存。",
        "panel.digest.orphanTopics": "孤儿主题 {count}",
        "panel.digest.none": "还没有整理记录。",
        "panel.digest.now": "立即整理",
        "panel.digest.running": "整理中…",
        "panel.digest.status.failed": "失败",
        "panel.digest.status.ok": "成功",
        "panel.digest.tiers": "分层：core {core} · cold {cold} · 主题 {topics}",
        "panel.digest.title": "最近整理",
        "panel.digest.trigger.manual": "手动",
        "panel.digest.trigger.pressure": "上下文压力",
        "panel.digest.trigger.tool": "工具",
        "panel.digest.trigger.turns": "轮次触发",
        "panel.dirty": "有未保存的修改",
        "panel.disabledNotice": "记忆插件已关闭：不再注入人格与记忆快照，也不会自动整理。这里仍可阅读和编辑全部记忆文件；请到「设置 → 记忆」重新开启。",
        "panel.empty": "暂无内容。",
        "panel.loadFailed": "载入文件失败：{error}",
        "panel.loading": "载入中…",
        "panel.modified": "最后修改：{time}",
        "panel.modifiedNever": "尚未写入磁盘",
        "panel.noPersona": "没有人设",
        "panel.noProject": "无项目",
        "panel.persona": "人设",
        "panel.personaAdd": "+ 添加人设",
        "panel.personaAddPlaceholder": "新人设名称",
        "panel.personaCancel": "取消",
        "panel.personaCreate": "创建",
        "panel.personaCreateFailed": "创建人设失败：{error}",
        "panel.personaDelete": "删除人设",
        "panel.personaDeleteConfirm": "确定删除「{name}」及其人格、画像与全局记忆？此操作不可撤销。",
        "panel.personaDeleteFailed": "删除人设失败：{error}",
        "panel.personaDeleteLocked": "Default 人设不能删除。",
        "panel.personaDeleted": "已删除人设及其记忆文件。",
        "panel.personaRename": "重命名",
        "panel.personaRenameFailed": "重命名人设失败：{error}",
        "panel.personaRenamed": "已重命名人设。",
        "panel.personaSwitched": "已切换人设。",
        "panel.project": "项目",
        "panel.projectAuto": "已从工作区自动同步。",
        "panel.reload": "重新载入",
        "panel.reloaded": "已从磁盘重新载入。",
        "panel.root": "根路径：{path}",
        "panel.save": "保存",
        "panel.saveFailed": "保存文件失败：{error}",
        "panel.saved": "已保存。",
        "panel.saving": "保存中…",
        "panel.section.global": "全局记忆",
        "panel.section.project": "项目记忆",
        "panel.section.soul": "人格",
        "panel.section.user": "用户画像",
        "panel.tier.cold": "冷层条目",
        "panel.tier.core": "常驻条目",
        "panel.tier.docBytes": "盘上正文",
        "panel.tier.hint": "core 条目常驻上下文；冷层条目留在磁盘，由 memory 工具按需检索。",
        "panel.tier.mode": "分层注入",
        "panel.tier.modeUnknown": "后端未上报",
        "panel.tier.offHint": "分层注入已关闭：项目记忆整篇注入，冷层条目每轮都占用上下文。",
        "panel.tier.orphanTopics": "孤儿主题",
        "panel.tier.title": "分层概览",
        "panel.tier.topics": "主题",
        "panel.tier.heat": "记忆热度（含衰减）",
        "panel.tier.heatHint": "热度只参与排序与展示，不改变常驻/冷层。主题行要等整理器建出主题表才出现；在那之前每一行都是具体条目。",
        "panel.tier.heatHits": "命中",
        "panel.tier.heatAge": "最近使用",
        "panel.tier.heatScore": "衰减分",
        "panel.tier.heatEmpty": "还没有检索命中记录。",
        "panel.tier.entryPrefix": "条目",
        "panel.tier.heatItem": "条目",
        "panel.tier.heatNoBody": "（无正文）",
        "panel.title": "记忆",
        "pill.bound": "本会话单独指定：{name}",
        "pill.close": "收起",
        "pill.followGlobal": "跟随全局（{name}）",
        "pill.label": "会话人设",
        "pill.loading": "加载人设…",
        "pill.switched": "已切换为「{name}」，下一轮发言生效。",
        "pill.switchFailed": "切换人设失败：{error}",
        "settings.budgets": "预算与阈值",
        "settings.configExample": "配置示例（cordis.patch.yml）",
        "settings.description": "只读概览：dsh-supermemory 把记忆存在哪里、如何解析，以及生效的预算与阈值。",
        "settings.enable": "插件总开关",
        "settings.enableAria": "开启或关闭记忆插件",
        "settings.enableBusy": "保存中…",
        "settings.enableFailed": "切换失败：{error}",
        "settings.enableHint": "关闭后：不再注入人格与记忆快照，memory 工具与 /remember、/memory-digest 会拒绝执行，自动整理也会停止。面板保持可用——四个记忆文件仍可阅读和编辑，只有「立即整理」被禁用。开关存在记忆根目录下的 settings.json 里；它和 cordis.patch.yml 里的 enabled 不是一回事：那个是硬开关，关掉连面板都不会装配，两者必须同时为真插件才生效。",
        "settings.enableRow": "插件状态",
        "settings.enableUnknown": "服务端没有确认新状态",
        "settings.home": "记忆根目录",
        "settings.loadFailed": "载入记忆概览失败：{error}",
        "settings.loading": "载入中…",
        "settings.none": "无",
        "settings.openPanel": "打开记忆面板",
        "settings.overview": "概览",
        "settings.presetsRoot": "预设目录",
        "settings.projectRule": "项目记忆路径",
        "settings.recentDigest": "最近整理",
        "settings.row.autoDigest": "自动整理",
        "settings.row.digestEveryTurns": "每 N 轮整理",
        "settings.row.digestModel": "整理 model",
        "settings.row.digestPressureRatio": "上下文压力阈值",
        "settings.row.digestProvider": "整理 provider",
        "settings.row.injectIntoSubagents": "注入子智能体",
        "settings.row.injectMaxBytes": "注入预算（字节）",
        "settings.row.presets": "预设数",
        "settings.row.projectCoreMaxBytes": "core 段预算（字节）",
        "settings.row.projectDirName": "项目目录名",
        "settings.row.projectFileName": "项目文件名",
        "settings.row.projectIndexMaxBytes": "主题目录预算（字节）",
        "settings.row.projects": "已知项目数",
        "settings.row.systemPromptMaxBytes": "系统提示预算（字节）",
        "settings.row.tieredInjection": "分层注入",
        "settings.title": "记忆",
        "settings.unavailable": "当前客户端无法打开记忆面板。",
  }/*__ZH_END__*/

    /** 面板/设置页共享样式。只使用 §9 白名单 token。 */
    const CSS = [
      '.sm-root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;box-sizing:border-box}',
      '.sm-topbar{display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:10px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}',
      '.sm-field{display:flex;align-items:center;gap:6px}',
      '.sm-label{color:var(--dsw-alias-label-secondary);font-size:12px;white-space:nowrap}',
      '.sm-select{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:4px 8px;font:inherit;font-size:12px;min-width:150px;max-width:280px}',
      '.sm-body{display:flex;flex:1;min-height:0}',
      '@media (width<=760px){.sm-nav{width:150px}.sm-editor{padding:10px}.sm-topbar{gap:8px 12px}}',
      '.sm-nav{width:230px;flex:none;display:flex;flex-direction:column;gap:2px;padding:8px;overflow:auto;border-right:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}',
      '.sm-nav-item{display:flex;flex-direction:column;align-items:flex-start;gap:2px;width:100%;text-align:left;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-bg-layer-1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer}',
      '.sm-nav-item:hover{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1)}',
      '.sm-nav-item.is-active{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}',
      '.sm-nav-title{font-size:13px}',
      '.sm-nav-path{font-size:11px;color:var(--dsw-alias-label-secondary);word-break:break-all}',
      '.sm-editor{flex:1;min-width:0;display:flex;flex-direction:column;gap:10px;padding:12px 16px}',
      '.sm-textarea{flex:1;min-height:180px;width:100%;box-sizing:border-box;resize:none;padding:10px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12px;line-height:20px}',
      '.sm-textarea:disabled{color:var(--dsw-alias-state-idle-primary)}',
      '.sm-footer{display:flex;align-items:center;gap:12px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.sm-dirty{color:var(--dsw-alias-state-warn-primary)}',
      '.sm-btn{display:inline-flex;align-items:center;gap:6px;padding:5px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}',
      '.sm-btn:hover:enabled{border-color:var(--dsw-alias-border-l2)}',
      '.sm-btn:disabled{color:var(--dsw-alias-state-idle-primary);cursor:default}',
      '.sm-btn-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}',
      '.sm-notice{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);font-size:12px}',
      '.sm-notice-ok{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}',
      '.sm-notice-warn{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}',
      '.sm-notice-error{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}',
      '.sm-digest{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 16px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.sm-digest-title{color:var(--dsw-alias-label-primary)}',
      '.sm-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}',
      '.sm-spacer{flex:1}',
      '.sm-settings{display:flex;flex-direction:column;gap:16px;padding:4px 2px 24px;font-size:13px;color:var(--dsw-alias-label-primary)}',
      '.sm-card{display:flex;flex-direction:column;gap:8px;padding:12px 14px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}',
      '.sm-card-title{font-size:13px;color:var(--dsw-alias-label-primary)}',
      '.sm-row{display:flex;gap:12px;justify-content:space-between;align-items:baseline;flex-wrap:wrap}',
      '.sm-row-label{color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.sm-row-value{font-size:12px;word-break:break-all;text-align:right}',
      '.sm-code{margin:0;padding:10px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:11px;line-height:18px;overflow:auto;white-space:pre}',
      '.sm-input{padding:4px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12px;min-width:140px}',
      '.sm-persona-form{display:flex;align-items:center;gap:6px}',
      '.sm-model{min-width:180px}',
      // v3 总开关：沿用 .sm-btn / .sm-card 的圆角与 token，只用滑块表达状态。
      '.sm-enable-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}',
      '.sm-enable-state{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.sm-enable-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.sm-switch{position:relative;flex:none;width:40px;height:22px;padding:0;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);cursor:pointer}',
      '.sm-switch:hover:enabled{border-color:var(--dsw-alias-brand-primary)}',
      '.sm-switch:disabled{cursor:default;opacity:0.6}',
      '.sm-switch.is-on{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}',
      '.sm-switch-dot{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:999px;background:var(--dsw-alias-bg-base)}',
      '.sm-switch.is-on .sm-switch-dot{left:20px}',
      '.sm-banner{margin:8px 16px 0}',
      // v5 人设行：图标按钮挂在 .sm-btn 之后，只覆紧凑内边距与图标色；危险按钮同理只换描边与文字。
      '.sm-icon-btn{flex:none;padding:4px 7px;line-height:0;color:var(--dsw-alias-label-secondary)}',
      '.sm-btn-danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}',
      // v8 分层概览：紧凑统计条。只用 §9 token，色位靠既有的 state-* 表达开关状态。
      '.sm-tier{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}',
      '.sm-tier-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.sm-tier-title{color:var(--dsw-alias-label-primary)}',
      '.sm-tier-flag{display:inline-flex;align-items:center;gap:6px;padding:2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.sm-tier-flag.is-on{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}',
      '.sm-tier-flag.is-off{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}',
      '.sm-tier-grid{display:flex;align-items:baseline;gap:6px 18px;flex-wrap:wrap}',
      '.sm-tier-item{display:inline-flex;align-items:baseline;gap:6px}',
      '.sm-tier-label{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.sm-tier-value{font-size:12px;color:var(--dsw-alias-label-primary)}',
      '.sm-tier-hint{font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary)}',
      '.sm-tier-hint.is-warn{color:var(--dsw-alias-state-warn-primary)}',
      '.sm-tier-heat{display:flex;flex-direction:column;gap:6px;margin-top:2px}',
      '.sm-tier-table{width:100%;border-collapse:collapse;font-size:11px;max-height:132px;display:block;overflow-y:auto}',
      '.sm-tier-table thead th{position:sticky;top:0;background:var(--dsw-alias-bg-layer-1);text-align:left;font-weight:400;color:var(--dsw-alias-label-secondary);padding:2px 6px;border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap}',
      '.sm-tier-table td{padding:2px 6px;color:var(--dsw-alias-label-primary);vertical-align:top}',
      '.sm-tier-table td.is-name{max-width:0;width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.sm-tier-table td.is-num{font-variant-numeric:tabular-nums;white-space:nowrap;color:var(--dsw-alias-label-secondary)}',
      // v9 会话人设胶囊：输入框右侧的紧凑控件。胶囊本身、气泡、条目三层都只借 §9 token；
      // is-bound 只用「描边 + 主文字色」区分「本会话单独指定」，不引第三种颜色。
      '.sm-persona-pill{position:relative;display:inline-flex;align-items:center}',
      '.sm-persona-pill-btn{display:inline-flex;align-items:center;gap:6px;max-width:190px;padding:3px 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;cursor:pointer}',
      '.sm-persona-pill-btn:hover:enabled{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.sm-persona-pill-btn:disabled{cursor:default;color:var(--dsw-alias-state-idle-primary)}',
      '.sm-persona-pill-btn.is-bound{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.sm-persona-pill-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.sm-persona-pill-pop{position:absolute;right:0;bottom:calc(100% + 6px);z-index:20;display:flex;flex-direction:column;gap:2px;min-width:220px;max-width:300px;padding:6px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-overlay);box-sizing:border-box}',
      '.sm-persona-pill-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:2px 6px 4px;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.sm-persona-pill-close{padding:0 4px;border:1px solid var(--dsw-alias-bg-overlay);border-radius:6px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:16px;cursor:pointer}',
      '.sm-persona-pill-close:hover{color:var(--dsw-alias-label-primary)}',
      '.sm-persona-pill-item{display:flex;align-items:center;gap:8px;width:100%;padding:6px 8px;border-radius:8px;border:1px solid var(--dsw-alias-bg-overlay);background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;text-align:left;cursor:pointer}',
      '.sm-persona-pill-item:hover:enabled{background:var(--dsw-alias-bg-layer-2)}',
      '.sm-persona-pill-item:disabled{cursor:default;opacity:0.6}',
      '.sm-persona-pill-item.is-active{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}',
      '.sm-persona-pill-mark{flex:none;width:12px;color:var(--dsw-alias-brand-primary)}',
      '.sm-persona-pill-item-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.sm-persona-pill-error{position:absolute;right:0;top:calc(100% + 4px);z-index:21;max-width:260px;padding:4px 8px;border-radius:8px;border:1px solid var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-overlay);font-size:11px;line-height:16px;color:var(--dsw-alias-state-error-primary)}',
      '.sm-persona-pill-notice{position:absolute;right:0;top:calc(100% + 4px);z-index:20;max-width:260px;padding:4px 8px;border-radius:8px;border:1px solid var(--dsw-alias-state-success-primary);background:var(--dsw-alias-bg-overlay);font-size:11px;line-height:16px;color:var(--dsw-alias-state-success-primary)}',
    ].join('')

    /**
     * 把任意错误转成可读文本。
     * @param {unknown} error - 捕获到的异常。
     * @returns {string} 文本。
     */
    function describe(error) {
      if (error === undefined || error === null) return 'unknown error'
      return String(error.message ?? error)
    }

    /** 渲染进组件树的 <style>，随组件卸载自动移除（不碰 document.body）。 */
    function StyleSlot() {
      return h('style', { 'data-plugin-css': 'dsh-supermemory' }, CSS)
    }

    /**
     * 订阅 locale revision，让文案在切换语言后重新渲染。
     * @param {object} locale - ctx.locale 服务。
     * @returns {number} 当前 revision。
     */
    function useLocaleRevision(locale) {
      const subscribe = React.useCallback(
        (listener) => {
          try {
            const off = locale?.subscribe?.(listener)
            return typeof off === 'function' ? off : () => {}
          } catch {
            return () => {}
          }
        },
        [locale],
      )
      const getSnapshot = React.useCallback(() => {
        try {
          const snapshot = locale?.getSnapshot?.()
          return typeof snapshot?.revision === 'number' ? snapshot.revision : 0
        } catch {
          return 0
        }
      }, [locale])
      return React.useSyncExternalStore(subscribe, getSnapshot, () => 0)
    }

    /**
     * 调一次插件 HTTP 接口，统一成 { ok, status, data, error, code }。
     * @param {string} path - 相对 API 前缀的路径。
     * @param {{ method?: string, body?: object }} [options] - 请求选项。
     * @returns {Promise<object>} 结果。
     */
    async function callApi(path, options) {
      const hasBody = options?.body !== undefined
      let response
      try {
        response = await fetch(`${API}/${path}`, {
          method: options?.method ?? 'GET',
          credentials: 'same-origin',
          headers: hasBody ? { accept: 'application/json', 'content-type': 'application/json' } : { accept: 'application/json' },
          body: hasBody ? JSON.stringify(options.body) : undefined,
        })
      } catch (error) {
        return { ok: false, status: 0, code: 'NETWORK', error: describe(error) }
      }
      let payload
      try {
        payload = await response.json()
      } catch {
        payload = undefined
      }
      if (response.ok && payload?.ok === true) return { ok: true, status: response.status, data: payload.data }
      return {
        ok: false,
        status: response.status,
        code: payload?.code,
        error: payload?.error ?? `HTTP ${response.status}`,
      }
    }

    /**
     * 拼 doc 路由的查询串：人格/画像/全局按 persona，项目按 projectRoot。
     * @param {string} scope - soul|user|global|project。
     * @param {string} persona - 人设 slug。
     * @param {string} projectRoot - 项目根。
     * @returns {string} 查询串。
     */
    function docQuery(scope, persona, projectRoot) {
      const params = new URLSearchParams()
      params.set('scope', scope)
      if (scope === 'project') params.set('projectRoot', projectRoot ?? '')
      else params.set('persona', persona || 'default')
      return params.toString()
    }

    /** 显式 ref：只有项目用 projectRoot，其余用 persona，避免服务端误判。 */
    function docRef(scope, persona, projectRoot) {
      const ref = { scope }
      if (scope === 'project') ref.projectRoot = projectRoot ?? ''
      else ref.persona = persona || 'default'
      return ref
    }

    /**
     * 是否受保护的默认人设 slug（🗑 的禁用依据）。
     *
     * **三份逐字实现之一，必须同口径（大小写不敏感）：**
     *   - `lib/core/store.js` 的 `isDefaultSlug`（服务端 409 的依据）
     *   - `lib/index.js` 的 `isDefaultPersonaSlug`（启动时补建默认人设的依据）
     *   - 这里（面板 🗑 该不该灰的依据）
     * 三份是刻意的重复而非共享：本文件只允许 `require('react')`，天生 import 不到 store，
     * 也不值得为三个表达式的判定去扩 store 的导出面。**代价是它们会各自漂移**，所以
     * 三处注释互相指认，改动必须同步——只改一边就会出现「按钮是灰的但后端允许删」或
     * 「后端 409 但按钮亮着让用户白点一次」这类错位（契约 §V6.3 登记了同一风险）。
     *
     * 为什么 v6 把目录统一成小写 `default` 之后**仍不能**退回逐字比小写：v6 的归一化发生在
     * ready，存量数据在被归一之前是真实存在的大写 `Default`；归一被跳过或失败时它也一直
     * 是大写。判断退回逐字比小写，等于在这些环境里让默认人设重新可删——正是 v5 那次真实
     * 误删的成因（当时真实 slug 是大写，判定比的是小写，🗑 从不上岗）。
     * 判断比目录宽松没有代价：目录只有小写一个，判断覆盖所有大小写写法。
     * @param {unknown} slug - 人设 slug。
     * @returns {boolean} 是否禁删。
     */
    function isDefaultSlug(slug) {
      return typeof slug === 'string' && slug.toLowerCase() === 'default'
    }

    /** UTF-8 字节数，与服务端 byteLength 口径一致。 */
    function utf8Bytes(text) {
      try {
        return new TextEncoder().encode(String(text ?? '')).length
      } catch {
        return String(text ?? '').length
      }
    }

    /**
     * 「拿不到」的显示占位。它只出现在**整句要显示、句中个别数字缺席**的场合
     * （如整理报告的分层尾巴）；孤零零的一格数字拿不到时是整格不渲染，不用占位符。
     * 任何时候都不写成 0：0 是一个真实的数字，会被读成「一条都没有」。
     */
    const DASH = '—'

    /** 整理触发源的可读名称。 */
    const TRIGGERS = ['turns', 'pressure', 'manual', 'tool']
    function triggerLabel(t, trigger) {
      return TRIGGERS.includes(trigger) ? t(`panel.digest.trigger.${trigger}`) : String(trigger ?? '')
    }

    /**
     * 整理报告尾巴：整编明细 + v8 分层统计（契约 V8.11）。
     *
     * `consolidation` **只在整编（consolidate）轮存在**——追加模式的 run 压根没有这个键
     * （契约 V8.15 第 15 条），所以不许假设每条 run 都有；这里逐字段再判一遍，判不出可展示的
     * 内容就返回空串，由调用方整段不渲染。
     *
     * 两个刻意的取舍：
     *   - 整编明细四项（added/merged/dropped/kept）齐了才显示，缺任何一项就不显示：模板是
     *     一句话，半句话比没有更容易被读成「整理只做了这么多」。
     *   - `orphanTopics` / `invalidTiers` 只在**非零**时出现：0 是常态，天天挂着一条
     *     「孤儿主题 0」只会让用户怀疑面板坏了。非零才是需要人看一眼的信号。
     *
     * @param {Function} t - 词典函数。
     * @param {unknown} consolidation - run 记录里的 consolidation 对象（追加模式为 undefined）。
     * @returns {string} 尾巴文本；无可展示内容时为空串。
     */
    function consolidationText(t, consolidation) {
      if (consolidation === null || typeof consolidation !== 'object') return ''
      const parts = []
      const added = finiteNumber(consolidation.added)
      const merged = finiteNumber(consolidation.merged)
      const dropped = finiteNumber(consolidation.dropped)
      const kept = finiteNumber(consolidation.kept)
      if (added !== null && merged !== null && dropped !== null && kept !== null) {
        parts.push(t('panel.digest.consolidation', { added, merged, dropped, kept }))
      }
      const core = finiteNumber(consolidation.tiers?.core)
      const cold = finiteNumber(consolidation.tiers?.cold)
      const topics = finiteNumber(consolidation.topics)
      if (core !== null || cold !== null || topics !== null) {
        parts.push(
          t('panel.digest.tiers', {
            core: core === null ? DASH : String(core),
            cold: cold === null ? DASH : String(cold),
            topics: topics === null ? DASH : String(topics),
          }),
        )
      }
      const orphans = Array.isArray(consolidation.orphanTopics) ? consolidation.orphanTopics.length : null
      if (orphans !== null && orphans > 0) parts.push(t('panel.digest.orphanTopics', { count: orphans }))
      const invalidTiers = finiteNumber(consolidation.invalidTiers)
      if (invalidTiers !== null && invalidTiers > 0) parts.push(t('panel.digest.invalidTiers', { count: invalidTiers }))
      return parts.join(' · ')
    }

    /** 只读一行。 */
    function InfoRow({ label, value }) {
      return h(
        'div',
        { className: 'sm-row' },
        h('span', { className: 'sm-row-label' }, label),
        h('span', { className: 'sm-row-value sm-mono' }, value),
      )
    }

    // ——————————————————— v8 分层概览（契约 V8.11） ———————————————————
    //
    // 数据只有一个来源：GET /doc 在 scope=project 时带回的 `tiering`。面板**不自己数条目**
    // ——条目头格式（契约 V8.2）只住在 `lib/core/entry-format.js` 一处，抄一份解析必然漂移。
    //
    // **只显示盘上事实，不显示任何「注入侧」的估算值**（契约 V8.16 第 1 条）：
    // core / cold / topics / orphanTopics / docBytes 都是此刻从文件里直接数出来、量出来的真值。
    // 曾经的「注入 core / 未注入冷层 / 折进目录 / core 段 / 目录段 / 注入合计」是 `GET /doc`
    // 现场重算的估算——重算没传 usage（排序退化成纯时间倒序）也没传 injectMaxBytes（缺总预算
    // 降级），与那一轮真实注入可能对不上。一个对不上的数字比没有数字更糟：用户会拿它做决定。
    // 要观测真实注入了多少，唯一可信的途径是看注入文本本身。
    //
    // 降级纪律：
    //   - 盘上事实逐个判存在性，缺一个少画一格，**绝不算 0 顶替**；
    //   - `tiering` 整个缺席（旧服务端，或非 project scope）时，这一节由调用方直接不渲染，
    //     而不是留一个全是占位符的空壳。

    /**
     * 把「可能是 undefined / null / 字符串 / NaN」的数字收敛成有限数字或 null。
     * null 在下游的含义是「拿不到」，与 0 严格区分：TierStat 遇 null 整格不渲染。
     * @param {unknown} value - 原始值。
     * @returns {number|null} 有限数字，或 null（表示拿不到）。
     */
    function finiteNumber(value) {
      return typeof value === 'number' && Number.isFinite(value) ? value : null
    }

    /**
     * 字节的可读形式（1024 进制）。
     * @param {unknown} value - 字节数。
     * @returns {string} 文本；拿不到时返回空串，由 TierStat 决定整格不渲染。
     */
    function formatBytes(value) {
      const bytes = finiteNumber(value)
      if (bytes === null) return ''
      if (Math.abs(bytes) < 1024) return `${bytes} B`
      return `${(bytes / 1024).toFixed(1)} KB`
    }

    /** 分层概览里的一格统计；值拿不到就整格不渲染，绝不留空白占位。 */
    function TierStat({ label, value }) {
      if (value === null || value === undefined || value === '') return null
      return h(
        'div',
        { className: 'sm-tier-item' },
        h('span', { className: 'sm-tier-label' }, label),
        h('span', { className: 'sm-tier-value sm-mono' }, String(value)),
      )
    }

    /**
     * 项目记忆的分层概览。
     *
     * 为什么值得单独占一节：没有它，用户无法一眼看出「盘上有多少条常驻、多少条在冷层、
     * 有几个主题」。契约 V8.11 明确写了这一节不属于可裁剪范围。
     *
     * 只报盘上事实。注入侧的数字一个都不显示：那些值要么是现场重算的估算（与真实那一轮
     * 注入对不上），要么压根拿不到。**对不上的数字比没有数字更糟**——所以宁缺。
     *
     * @param {{ t: Function, tiering?: unknown, config?: unknown }} props - 数据与词典。
     * @returns {object} 渲染元素。
     */
    function TierOverview(props) {
      const { t, tiering, config } = props
      const tier = tiering !== null && typeof tiering === 'object' ? tiering : {}
      const cfg = config !== null && typeof config === 'object' ? config : {}
      // 开关三态：true / false / 「后端没这个键」。第三态不等于 false——旧服务端跑的一直是
      // 全量注入，把它显示成「关闭」会把「服务端版本旧」误读成「主人自己关的」。
      const mode = typeof cfg.tieredInjection === 'boolean' ? (cfg.tieredInjection ? 'on' : 'off') : 'unknown'
      const core = finiteNumber(tier.core)
      const cold = finiteNumber(tier.cold)
      const topics = finiteNumber(tier.topics)
      const docBytes = formatBytes(tier.docBytes)
      // 孤儿主题属盘上事实，但**缺席与空数组是两回事**：缺席＝盘上没主题表、没人查过；
      // `[]` ＝查过了，确实没有。所以判 Array.isArray 而不是判真假，空数组照实显示 0。
      const orphanTopics = Array.isArray(tier.orphanTopics) ? tier.orphanTopics.length : null
      const modeValue = mode === 'on' ? t('common.on') : mode === 'off' ? t('common.off') : t('panel.tier.modeUnknown')
      return h(
        'div',
        { className: 'sm-tier', role: 'group', 'aria-label': t('panel.tier.title') },
        h(
          'div',
          { className: 'sm-tier-head' },
          h('span', { className: 'sm-tier-title' }, t('panel.tier.title')),
          h('span', { className: `sm-tier-flag${mode === 'unknown' ? '' : ` is-${mode}`}` }, `${t('panel.tier.mode')}: ${modeValue}`),
        ),
        h(
          'div',
          { className: 'sm-tier-grid' },
          h(TierStat, { label: t('panel.tier.core'), value: core }),
          h(TierStat, { label: t('panel.tier.cold'), value: cold }),
          h(TierStat, { label: t('panel.tier.topics'), value: topics }),
          h(TierStat, { label: t('panel.tier.orphanTopics'), value: orphanTopics }),
          h(TierStat, { label: t('panel.tier.docBytes'), value: docBytes }),
        ),
        // 关闭态与开启态各说一句：关闭态要说清后果（冷层每轮照样占上下文），
        // 开启态说清三层语义，免得用户把「冷层条目」当成「记忆丢了」。
        mode === 'off' ? h('div', { className: 'sm-tier-hint is-warn' }, t('panel.tier.offHint')) : null,
        mode === 'on' ? h('div', { className: 'sm-tier-hint' }, t('panel.tier.hint')) : null,
        // v12：主题热度小节。`heat` 缺席时整节不渲染——「没读到统计」不是「热度过低」。
        Array.isArray(tier.heat) ? h(HeatTable, { t, rows: tier.heat }) : null,
      )
    }

    /**
     * 主题热度表（v12 新增，纯展示）。
     *
     * 为什么要有这一节：分层概览原本只有 core/cold 条数，主人看不出「为什么这条在冷层」。
     * 热度把依据摆出来——但它**只解释和排序，不决定分层**，所以提示语里把这句话明写。
     *
     * `ageDays` 由服务端算好（与整理器同一份数字）；缺席时该格显示 `—` 而不是 0，
     * 避免把「没算过」显示成「刚刚用过」。
     *
     * @param {{ t: Function, rows: Array<object> }} props - 数据与词典。
     * @returns {object} 渲染元素。
     */
    function HeatTable(props) {
      const { t, rows } = props
      if (rows.length === 0) {
        return h('div', { className: 'sm-tier-hint' }, t('panel.tier.heatEmpty'))
      }
      const head = h(
        'tr',
        null,
        h('th', null, t('panel.tier.heatItem')),
        h('th', null, t('panel.tier.heatHits')),
        h('th', null, t('panel.tier.heatAge')),
        h('th', null, t('panel.tier.heatScore')),
      )
      const body = rows.map((row, index) => {
        // 主题级带 `name`；条目级带 `preview`（正文首行截断）。两者都没有时才退回编号——
        // 一串十六进制 id 对主人毫无意义，宁可显示「（无正文）」也不显示编号。
        const hasName = typeof row?.name === 'string' && row.name !== ''
        const hasPreview = typeof row?.preview === 'string' && row.preview !== ''
        const label = hasName
          ? row.name
          : (hasPreview ? row.preview : t('panel.tier.heatNoBody'))
        const name = label
        // 悬停看全文：条目级把完整正文塞进 title，主题级塞主题名。
        const full = typeof row?.full === 'string' && row.full !== '' ? row.full : (hasName ? row.name : '')
        const hits = finiteNumber(row?.hits)
        const age = finiteNumber(row?.ageDays)
        const score = finiteNumber(row?.score)
        return h(
          'tr',
          { key: `${String(row?.id ?? name)}-${String(index)}` },
          h('td', { className: 'is-name', title: full === '' ? undefined : full }, name),
          h('td', { className: 'is-num' }, hits === null ? '—' : String(hits)),
          h('td', { className: 'is-num' }, age === null ? '—' : `${age.toFixed(1)}d`),
          h('td', { className: 'is-num' }, score === null ? '—' : score.toFixed(2)),
        )
      })
      return h(
        'div',
        { className: 'sm-tier-heat' },
        h('div', { className: 'sm-tier-title' }, t('panel.tier.heat')),
        h('div', { className: 'sm-tier-hint' }, t('panel.tier.heatHint')),
        h('table', { className: 'sm-tier-table' }, h('thead', null, head), h('tbody', null, body)),
      )
    }

    /**
     * 从 bootstrap / PUT 响应里取插件总开关。
     * 缺失一律按「开启」处理：与服务端 `deps?.isEnabled?.() === false` 的判定口径一致，
     * 也避免旧服务端把面板误判成关闭态。
     * @param {object} data - 响应 data。
     * @returns {boolean} 是否开启。
     */
    function enabledFrom(data) {
      if (typeof data?.enabled === 'boolean') return data.enabled
      if (typeof data?.digestSettings?.enabled === 'boolean') return data.digestSettings.enabled
      return true
    }

    /** 总开关滑块：状态只由服务端确认值驱动，本组件不持有状态。 */
    function EnabledSwitch(props) {
      const { on, busy, label, onToggle } = props
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': on,
          'aria-label': label,
          className: `sm-switch${on ? ' is-on' : ''}`,
          disabled: busy,
          onClick: () => void onToggle(),
        },
        h('span', { className: 'sm-switch-dot' }),
      )
    }

    /** 侧栏图标：书本 + 记忆点。 */
    function MemoryIcon({ size }) {
      const edge = typeof size === 'number' ? size : 16
      return h(
        'svg',
        {
          width: edge,
          height: edge,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('path', { d: 'M6.2 3.6h10.6a1.6 1.6 0 0 1 1.6 1.6v13.6a1.6 1.6 0 0 1-1.6 1.6H6.2a1.6 1.6 0 0 1-1.6-1.6V5.2a1.6 1.6 0 0 1 1.6-1.6Z' }),
        h('path', { d: 'M8.1 3.6v16.8' }),
        h('circle', { cx: 12.6, cy: 8.6, r: 0.95 }),
        h('circle', { cx: 15.2, cy: 11.9, r: 0.95 }),
        h('circle', { cx: 12.6, cy: 15.2, r: 0.95 }),
      )
    }

    /** 人设重命名图标：铅笔。可访问名由外层按钮的 aria-label 提供。 */
    function PencilIcon({ size }) {
      const edge = typeof size === 'number' ? size : 14
      return h(
        'svg',
        {
          width: edge,
          height: edge,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('path', { d: 'M16.4 4.1a2.1 2.1 0 0 1 3 3L8.3 18.2l-4.1 1.2 1.2-4.1Z' }),
        h('path', { d: 'M14.3 6.2l3 3' }),
      )
    }

    /** 人设删除图标：垃圾桶。可访问名由外层按钮的 aria-label 提供。 */
    function TrashIcon({ size }) {
      const edge = typeof size === 'number' ? size : 14
      return h(
        'svg',
        {
          width: edge,
          height: edge,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('path', { d: 'M4.2 6.4h15.6' }),
        h('path', { d: 'M9.4 6.4V4.9a1.1 1.1 0 0 1 1.1-1.1h3a1.1 1.1 0 0 1 1.1 1.1v1.5' }),
        h('path', { d: 'M6.4 6.4l.9 12.5a1.6 1.6 0 0 0 1.6 1.5h6.2a1.6 1.6 0 0 0 1.6-1.5l.9-12.5' }),
        h('path', { d: 'M10.4 10.2v6.4' }),
        h('path', { d: 'M13.6 10.2v6.4' }),
      )
    }

    /** 记忆主面板。 */
    function PanelPage(props) {
      const { ctx, locale, t } = props
      useLocaleRevision(locale)

      const [boot, setBoot] = React.useState(null)
      const [bootError, setBootError] = React.useState(null)
      const [ready, setReady] = React.useState(false)
      const [persona, setPersona] = React.useState('')
      const [projectRoot, setProjectRoot] = React.useState('')
      const [scope, setScope] = React.useState('soul')
      const [docs, setDocs] = React.useState({})
      const [drafts, setDrafts] = React.useState({})
      const [runs, setRuns] = React.useState([])
      const [notice, setNotice] = React.useState(null)
      const [conflict, setConflict] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      // 人设创建表单（内联，不用 window.prompt）。
      const [personaFormOpen, setPersonaFormOpen] = React.useState(false)
      const [personaName, setPersonaName] = React.useState('')
      // v5 人设重命名 / 删除：三态互斥，同样自绘，不用 window.confirm / window.prompt。
      const [personaAction, setPersonaAction] = React.useState('idle')
      const [renameValue, setRenameValue] = React.useState('')
      // 整理模型选择。
      const [models, setModels] = React.useState([])
      const [digestModel, setDigestModel] = React.useState('')
      // v3 总开关（只读展示；切换入口在设置页，面板这里只呈现后果）。
      const [enabled, setEnabled] = React.useState(true)
      const epoch = React.useRef(0)

      const loadRuns = React.useCallback(async () => {
        const result = await callApi('runs')
        if (!result.ok) return
        const list = Array.isArray(result.data) ? result.data : result.data?.runs
        setRuns(Array.isArray(list) ? list : [])
      }, [])

      const loadDocs = React.useCallback(async (nextPersona, nextRoot, keepDrafts) => {
        const token = ++epoch.current
        const next = {}
        await Promise.all(
          SCOPES.map(async (name) => {
            if (name === 'project' && (nextRoot === undefined || nextRoot === '')) {
              next[name] = { skipped: true }
              return
            }
            const result = await callApi(`doc?${docQuery(name, nextPersona, nextRoot)}`)
            next[name] = result.ok ? result.data : { error: result.error ?? 'load failed' }
          }),
        )
        if (token !== epoch.current) return
        setDocs(next)
        setDrafts((previous) => {
          if (!keepDrafts) return {}
          const kept = {}
          for (const [name, draft] of Object.entries(previous)) if (draft?.dirty === true) kept[name] = draft
          return kept
        })
        if (!keepDrafts) setConflict(false)
      }, [])

      React.useEffect(() => {
        let alive = true
        void (async () => {
          const result = await callApi('bootstrap')
          if (!alive) return
          if (!result.ok) {
            setBootError(result.error)
            setReady(true)
            return
          }
          const data = result.data ?? {}
          setBoot(data)
          setEnabled(enabledFrom(data))
          setPersona((current) => current || data.currentPersona?.slug || data.personas?.[0]?.slug || '')
          setProjectRoot((current) => current || data.active?.projectRoot || data.projects?.[0]?.path || '')
          const settings = data.digestSettings ?? {}
          setDigestModel(
            typeof settings.digestProvider === 'string' && settings.digestProvider !== ''
              ? `${settings.digestProvider}::${settings.digestModel ?? ''}`
              : '',
          )
          setReady(true)
          void loadRuns()
          void loadModels()
        })()
        return () => {
          alive = false
        }
      }, [loadRuns])

      React.useEffect(() => {
        if (!ready || bootError !== null) return
        void loadDocs(persona, projectRoot, false)
      }, [ready, bootError, persona, projectRoot, loadDocs])

      const doc = docs[scope]
      const draft = drafts[scope]
      const writable = doc !== undefined && doc.error === undefined && doc.skipped !== true
      const content = draft?.text ?? (writable ? doc.content ?? '' : '')
      const dirty = draft?.dirty === true
      const mtimeMs = doc !== undefined && typeof doc.mtimeMs === 'number' ? doc.mtimeMs : 0

      const onEdit = (event) => {
        const text = event.target.value
        const base = writable ? doc.content ?? '' : ''
        setDrafts((previous) => ({ ...previous, [scope]: { text, dirty: text !== base } }))
      }

      const save = async () => {
        if (busy || !writable) return
        setBusy(true)
        setNotice(null)
        const result = await callApi('doc', {
          method: 'PUT',
          body: { ...docRef(scope, persona, projectRoot), content, expectedMtimeMs: mtimeMs },
        })
        setBusy(false)
        if (result.ok) {
          setDocs((previous) => ({
            ...previous,
            [scope]: { ...previous[scope], content, mtimeMs: result.data?.mtimeMs ?? mtimeMs, bytes: result.data?.bytes ?? utf8Bytes(content) },
          }))
          setDrafts((previous) => {
            const next = { ...previous }
            delete next[scope]
            return next
          })
          setConflict(false)
          setNotice({ kind: 'ok', text: t('panel.saved') })
          // 写完必须回读：tiering 的各档计数与 docBytes 都是盘上事实，本地推算等于把
          // 条目头解析器抄第二份。keepDrafts=true，别的一栏若有未保存草稿不受影响。
          void loadDocs(persona, projectRoot, true)
          return
        }
        if (result.status === 409 || result.code === 'STALE') {
          setConflict(true)
          setNotice({ kind: 'warn', text: t('panel.conflict') })
          return
        }
        setNotice({ kind: 'error', text: t('panel.saveFailed', { error: result.error }) })
      }

      const reload = async () => {
        if (!writable) return
        const result = await callApi(`doc?${docQuery(scope, persona, projectRoot)}`)
        if (!result.ok) {
          setNotice({ kind: 'error', text: t('panel.loadFailed', { error: result.error }) })
          return
        }
        setDocs((previous) => ({ ...previous, [scope]: result.data }))
        setDrafts((previous) => {
          const next = { ...previous }
          delete next[scope]
          return next
        })
        setConflict(false)
        setNotice({ kind: 'ok', text: t('panel.reloaded') })
      }

      const runDigest = async () => {
        // 关闭态服务端会 409，这里再挡一层，避免按钮刚失效时的竞态请求。
        if (busy || !enabled) return
        setBusy(true)
        setNotice(null)
        const result = await callApi('digest', {
          method: 'POST',
          body: { persona: persona || 'default', projectRoot: projectRoot || undefined },
        })
        setBusy(false)
        void loadRuns()
        if (!result.ok) {
          setNotice({ kind: 'error', text: t('panel.digest.failed', { error: result.error }) })
          return
        }
        const record = result.data?.record ?? result.data
        if (record?.ok === false) {
          setNotice({ kind: 'error', text: t('panel.digest.failed', { error: record.error ?? 'unknown' }) })
          return
        }
        void loadDocs(persona, projectRoot, true)
        setNotice({ kind: 'ok', text: t('panel.digest.done') })
      }

      /** 拉可用模型列表（整理器模型选择器）。 */
      const loadModels = React.useCallback(async () => {
        const result = await callApi('models')
        if (!result.ok) return
        const list = Array.isArray(result.data?.models) ? result.data.models : []
        setModels(list)
      }, [])

      /** 保存整理模型选择（空 = 跟随当前会话）。 */
      const saveDigestModel = async (value) => {
        setDigestModel(value)
        const separator = value.indexOf('::')
        const provider = separator === -1 ? '' : value.slice(0, separator)
        const model = separator === -1 ? '' : value.slice(separator + 2)
        setBusy(true)
        const result = await callApi('settings', { method: 'PUT', body: { digestProvider: provider, digestModel: model } })
        setBusy(false)
        if (!result.ok) setNotice({ kind: 'error', text: t('panel.digest.modelSaveFailed', { error: result.error }) })
        else setNotice({ kind: 'ok', text: t('panel.digest.modelSaved') })
      }

      /** 切换当前人设（全局）。 */
      const selectPersona = async (slug) => {
        // 任何切换动作都先收起重命名 / 删除表单：它们只针对切换前选中的那个人设。
        setPersonaAction('idle')
        setRenameValue('')
        setPersonaFormOpen(false)
        setPersonaName('')
        if (slug === '' || slug === persona) return
        setBusy(true)
        const result = await callApi('personas', { method: 'PUT', body: { slug } })
        const refreshed = await callApi('bootstrap')
        setBusy(false)
        if (!result.ok) {
          setNotice({ kind: 'error', text: t('panel.personaCreateFailed', { error: result.error }) })
          return
        }
        if (refreshed.ok) {
          setBoot(refreshed.data ?? {})
          setEnabled(enabledFrom(refreshed.data))
        }
        setPersona(slug)
        setNotice({ kind: 'ok', text: t('panel.personaSwitched') })
      }

      /** 创建人设并切过去。 */
      const createPersona = async () => {
        const name = personaName.trim()
        if (name === '') return
        setBusy(true)
        const result = await callApi('personas', { method: 'POST', body: { name } })
        setBusy(false)
        if (!result.ok) {
          setNotice({ kind: 'error', text: t('panel.personaCreateFailed', { error: result.error }) })
          return
        }
        const created = result.data?.current ?? result.data?.persona
        const refreshed = await callApi('bootstrap')
        if (refreshed.ok) {
          setBoot(refreshed.data ?? {})
          setEnabled(enabledFrom(refreshed.data))
        }
        if (typeof created?.slug === 'string') setPersona(created.slug)
        setPersonaFormOpen(false)
        setPersonaName('')
        setPersonaAction('idle')
        setRenameValue('')
        setNotice({ kind: 'ok', text: t('panel.personaSwitched') })
      }

      /** 收起重命名 / 删除表单，回到 idle（同时清掉草稿输入）。 */
      const closePersonaAction = () => {
        setPersonaAction('idle')
        setRenameValue('')
      }

      /** 进入重命名态：预填当前选中人设的显示名，并收起「+ 添加人设」。 */
      const openPersonaRename = (name) => {
        setPersonaFormOpen(false)
        setPersonaName('')
        setNotice(null)
        setRenameValue(name)
        setPersonaAction('rename')
      }

      /** 进入删除确认态：同样与「+ 添加人设」互斥。 */
      const openPersonaDelete = () => {
        setPersonaFormOpen(false)
        setPersonaName('')
        setNotice(null)
        setPersonaAction('delete')
      }

      /**
       * 重命名当前选中人设的显示名（契约 §V5.0：slug 与磁盘目录都不动）。
       * 人设名不参与任何路径计算，所以成功后只刷 bootstrap 拿新显示名，不重载四个文档。
       */
      const submitPersonaRename = async () => {
        const name = renameValue.trim()
        if (busy || persona === '' || name === '') return
        setBusy(true)
        setNotice(null)
        const result = await callApi('personas', { method: 'PATCH', body: { slug: persona, name } })
        const refreshed = result.ok ? await callApi('bootstrap') : null
        setBusy(false)
        if (!result.ok) {
          // 失败留在表单里，让用户改完再试；服务端没落地，本地显示名不动。
          setNotice({ kind: 'error', text: t('panel.personaRenameFailed', { error: result.error }) })
          return
        }
        if (refreshed?.ok) {
          setBoot(refreshed.data ?? {})
          setEnabled(enabledFrom(refreshed.data))
        }
        closePersonaAction()
        setNotice({ kind: 'ok', text: t('panel.personaRenamed') })
      }

      /**
       * 删除当前选中人设及其人格 / 画像 / 全局记忆（服务端 rm -rf，不可撤销）。
       * 成功后必须把本地缓存里属于旧人设的一切抹掉，否则用户会把已删人设的草稿写进新人设文件。
       */
      const submitPersonaDelete = async () => {
        // 内层防护（与 runDigest 的双层写法一致）：按钮的 disabled 被绕过时也不许把 DELETE 发出去。
        // 判定与 deleteLocked 同源走 isDefaultSlug——真实 slug 是 'Default'，逐字比小写这层就是死码。
        if (busy || persona === '' || isDefaultSlug(persona)) return
        setBusy(true)
        setNotice(null)
        const result = await callApi('personas', { method: 'DELETE', body: { slug: persona } })
        const refreshed = result.ok ? await callApi('bootstrap') : null
        setBusy(false)
        if (!result.ok) {
          closePersonaAction()
          setNotice({
            kind: 'error',
            text: result.code === 'PERSONA_PROTECTED'
              ? t('panel.personaDeleteLocked')
              : t('panel.personaDeleteFailed', { error: result.error }),
          })
          return
        }
        if (refreshed?.ok) {
          setBoot(refreshed.data ?? {})
          setEnabled(enabledFrom(refreshed.data))
        }
        // current 可能是 null（注册表里没有 default 条目的迁移场景，删掉最后一个就发生）：
        // 逐级兜底到剩余人设，再兜不住就保留本地值。绝不把 persona 置空——空值会让 doc
        // 请求经 `persona || 'default'` 落到 Default 文件，与下拉当前显示的那一项错位。
        const responseSlug = typeof result.data?.current?.slug === 'string' ? result.data.current.slug : ''
        const remaining = Array.isArray(result.data?.personas) ? result.data.personas : []
        const fallbackSlug = remaining.length > 0 && typeof remaining[0]?.slug === 'string' ? remaining[0].slug : ''
        const nextSlug = responseSlug !== '' ? responseSlug : fallbackSlug !== '' ? fallbackSlug : persona
        closePersonaAction()
        // persona 变化会让既有的 loadDocs effect 重跑；docs / drafts 必须先清空，
        // 否则编辑器会在重载期间继续显示已删人设的正文与未保存草稿。
        setDocs({})
        setDrafts({})
        setConflict(false)
        setPersona(nextSlug)
        setNotice({ kind: 'ok', text: t('panel.personaDeleted') })
      }

      if (bootError !== null) {
        return h(
          'div',
          { className: 'sm-root' },
          h(StyleSlot),
          h('div', { className: 'sm-editor' }, h('div', { className: 'sm-notice sm-notice-error' }, t('panel.loadFailed', { error: bootError }))),
        )
      }

      const personas = Array.isArray(boot?.personas) ? boot.personas : []
      // v5：✎ / 🗑 只作用于下拉当前选中的人设；Default 由服务端永久保护，客户端先挡住。
      // 走 isDefaultSlug 而不是逐字比 'default'——真实 slug 是 'Default'（大写 D）。
      const selectedEntry = personas.find((entry) => entry.slug === persona) ?? null
      const selectedName = selectedEntry?.name || persona
      const canRename = persona !== '' && personas.length > 0
      const deleteLocked = isDefaultSlug(persona)
      // 项目列表由宿主动态提供（工作区自动同步），面板只读。
      const projects = Array.isArray(boot?.projects) ? boot.projects : []
      const config = boot?.config ?? {}
      // 面板顶部不再有预算占用条（契约 V8.16 第 3 条）：曾经的「注入」条把四个文件字节
      // 相加再除以 injectMaxBytes，可 soul/user 吃的是 systemPromptMaxBytes、global/project
      // 吃的是 injectMaxBytes，两个预算不能相加相除；「人格」条只数 soul.md，漏掉整个画像段
      // 与两个段标题。口径对不上的数字一律不显示，配置预算值仍可在设置页阅读。
      const latest = runs[0]
      const counts = latest?.counts
      // 整编明细是 v4 新增字段：老记录没有它，卡片照旧只显示四域计数。
      const consolidation = latest?.consolidation === null || latest?.consolidation === undefined ? null : latest.consolidation
      // v8 尾巴（整编明细 + 分层统计）。追加模式的 run 没有 consolidation，算出来就是空串，
      // 由渲染处整段跳过——面板不猜「没有」是什么意思（契约 V8.15 第 15 条）。
      const digestTail = consolidationText(t, consolidation)

      // 人设控件三态互斥（契约 §V5.5）：重命名输入 / 删除内联确认 / 既有「+ 添加人设」，
      // 同一时刻只渲染一个。确认与输入全部自绘，不用 window.confirm / window.prompt。
      const personaActionSlot = personaAction === 'rename'
        ? h(
            'div',
            { className: 'sm-field sm-persona-form', key: 'rename' },
            h('input', {
              className: 'sm-input',
              type: 'text',
              value: renameValue,
              maxLength: 60,
              'aria-label': t('panel.personaRename'),
              onChange: (event) => setRenameValue(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') void submitPersonaRename()
                if (event.key === 'Escape') closePersonaAction()
              },
            }),
            h(
              'button',
              {
                type: 'button',
                className: 'sm-btn sm-btn-primary',
                onClick: () => void submitPersonaRename(),
                disabled: busy || renameValue.trim() === '',
              },
              t('panel.save'),
            ),
            h(
              'button',
              { type: 'button', className: 'sm-btn', onClick: () => closePersonaAction(), disabled: busy },
              t('panel.personaCancel'),
            ),
          )
        : personaAction === 'delete'
          ? h(
              'div',
              { className: 'sm-field', key: 'delete', role: 'alert' },
              h('span', null, t('panel.personaDeleteConfirm', { name: selectedName })),
              h(
                'button',
                {
                  type: 'button',
                  className: 'sm-btn sm-btn-danger',
                  onClick: () => void submitPersonaDelete(),
                  disabled: busy,
                },
                t('panel.personaDelete'),
              ),
              h(
                'button',
                { type: 'button', className: 'sm-btn', onClick: () => closePersonaAction(), disabled: busy },
                t('panel.personaCancel'),
              ),
            )
          : personaFormOpen
            ? h(
                'div',
                { className: 'sm-field sm-persona-form', key: 'add' },
                h('input', {
                  className: 'sm-input',
                  type: 'text',
                  value: personaName,
                  placeholder: t('panel.personaAddPlaceholder'),
                  maxLength: 60,
                  'aria-label': t('panel.personaAdd'),
                  onChange: (event) => setPersonaName(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') void createPersona()
                    if (event.key === 'Escape') {
                      setPersonaFormOpen(false)
                      setPersonaName('')
                    }
                  },
                }),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'sm-btn sm-btn-primary',
                    onClick: () => void createPersona(),
                    disabled: busy || personaName.trim() === '',
                  },
                  t('panel.personaCreate'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'sm-btn',
                    onClick: () => {
                      setPersonaFormOpen(false)
                      setPersonaName('')
                    },
                    disabled: busy,
                  },
                  t('panel.personaCancel'),
                ),
              )
            : h(
                'button',
                {
                  key: 'add-trigger',
                  type: 'button',
                  className: 'sm-btn',
                  onClick: () => {
                    setPersonaAction('idle')
                    setRenameValue('')
                    setPersonaFormOpen(true)
                  },
                  disabled: busy,
                },
                t('panel.personaAdd'),
              )

      return h(
        'div',
        { className: 'sm-root' },
        h(StyleSlot),
        h(
          'div',
          { className: 'sm-topbar' },
          h(
            'div',
            { className: 'sm-field' },
            h('span', { className: 'sm-label' }, t('panel.persona')),
            h(
              'select',
              {
                className: 'sm-select',
                value: persona,
                onChange: (event) => void selectPersona(event.target.value),
                'aria-label': t('panel.persona'),
                disabled: busy,
              },
              personas.length === 0
                ? h('option', { value: persona }, persona || t('panel.noPersona'))
                : personas.map((entry) =>
                    h('option', { key: entry.slug, value: entry.slug }, entry.name || entry.slug),
                  ),
            ),
            // ✎ / 🗑 只在 idle 出现：进入重命名或删除确认后，由各自控件取代这一对按钮。
            personaAction === 'idle' &&
              h(
                'button',
                {
                  key: 'persona-rename',
                  type: 'button',
                  className: 'sm-btn sm-icon-btn',
                  onClick: () => openPersonaRename(selectedName),
                  disabled: busy || !canRename,
                  'aria-label': t('panel.personaRename'),
                  title: t('panel.personaRename'),
                },
                h(PencilIcon, { size: 14 }),
              ),
            personaAction === 'idle' &&
              h(
                'button',
                {
                  key: 'persona-delete',
                  type: 'button',
                  className: 'sm-btn sm-icon-btn',
                  onClick: () => openPersonaDelete(),
                  disabled: busy || deleteLocked,
                  'aria-label': t('panel.personaDelete'),
                  // 选中 Default 时按钮仍在（可解释），禁用原因写进 title 而不是弹层。
                  title: deleteLocked ? t('panel.personaDeleteLocked') : t('panel.personaDelete'),
                },
                h(TrashIcon, { size: 14 }),
              ),
          ),
          personaActionSlot,
          h(
            'div',
            { className: 'sm-field' },
            h('span', { className: 'sm-label' }, t('panel.project')),
            h(
              'select',
              {
                className: 'sm-select',
                value: projectRoot,
                onChange: (event) => setProjectRoot(event.target.value),
                'aria-label': t('panel.project'),
              },
              projects.length === 0
                ? h('option', { value: projectRoot }, projectRoot || t('panel.noProject'))
                : projects.map((project) => h('option', { key: project.path, value: project.path }, project.name || project.path)),
            ),
          ),
        ),
        // v3：关闭态在面板顶部挂一条常驻警示（复用 .sm-notice-warn），说明后果与恢复入口。
        enabled === false &&
          h(
            'div',
            { className: 'sm-notice sm-notice-warn sm-banner', role: 'status' },
            h('span', null, t('panel.disabledNotice')),
          ),
        h(
          'div',
          { className: 'sm-body' },
          h(
            'div',
            { className: 'sm-nav' },
            SCOPES.map((name) =>
              h(
                'button',
                {
                  key: name,
                  type: 'button',
                  className: `sm-nav-item${name === scope ? ' is-active' : ''}`,
                  onClick: () => setScope(name),
                  title: docs[name]?.path ?? (name === 'project' ? projectRoot : undefined),
                },
                h('span', { className: 'sm-nav-title' }, t(`panel.section.${name}`)),
                name === 'project'
                  ? h('span', { className: 'sm-nav-path' }, t('panel.root', { path: projectRoot || t('panel.noProject') }))
                  : h(
                      'span',
                      { className: 'sm-nav-path' },
                      typeof docs[name]?.bytes === 'number' ? t('panel.bytes', { bytes: docs[name].bytes }) : t('panel.empty'),
                    ),
              ),
            ),
          ),
          h(
            'div',
            { className: 'sm-editor' },
            notice !== null &&
              h(
                'div',
                { className: `sm-notice sm-notice-${notice.kind}`, role: 'status' },
                h('span', null, notice.text),
                conflict && h('span', null, t('panel.conflictHint')),
                conflict && h('button', { type: 'button', className: 'sm-btn', onClick: reload, disabled: busy }, t('panel.reload')),
              ),
            doc?.error !== undefined &&
              h('div', { className: 'sm-notice sm-notice-error' }, t('panel.loadFailed', { error: doc.error })),
            doc?.skipped === true && h('div', { className: 'sm-notice' }, t('panel.root', { path: projectRoot || t('panel.noProject') })),
            // v8 分层概览：只有项目记忆的 doc 带 tiering。字段整个缺席（旧服务端、未选项目、
            // 载入失败）时这一节**不渲染**——一屏占位符不是优雅降级，是噪音（契约 V8.15 第 15 条）。
            scope === 'project' && docs.project?.tiering !== undefined &&
              h(TierOverview, { t, tiering: docs.project.tiering, config }),
            h('textarea', {
              className: 'sm-textarea sm-mono',
              value: content,
              spellCheck: false,
              disabled: !writable,
              placeholder: ready ? t('panel.empty') : t('panel.loading'),
              onChange: onEdit,
              'aria-label': t(`panel.section.${scope}`),
            }),
            h(
              'div',
              { className: 'sm-footer' },
              h('span', null, t('panel.bytes', { bytes: utf8Bytes(content) })),
              h('span', null, mtimeMs > 0 ? t('panel.modified', { time: new Date(mtimeMs).toLocaleString() }) : t('panel.modifiedNever')),
              dirty && h('span', { className: 'sm-dirty' }, t('panel.dirty')),
              h('span', { className: 'sm-spacer' }),
              h('button', { type: 'button', className: 'sm-btn', onClick: reload, disabled: busy || !writable }, t('panel.reload')),
              h(
                'button',
                { type: 'button', className: 'sm-btn sm-btn-primary', onClick: save, disabled: busy || !dirty || !writable },
                busy ? t('panel.saving') : t('panel.save'),
              ),
            ),
          ),
        ),
        h(
          'div',
          { className: 'sm-digest' },
          h('span', { className: 'sm-digest-title' }, t('panel.digest.title')),
          latest === undefined
            ? h('span', null, t('panel.digest.none'))
            : h(
                'span',
                null,
                `${latest.at ?? ''} · ${latest.ok ? t('panel.digest.status.ok') : t('panel.digest.status.failed')} · ${triggerLabel(t, latest.trigger)}` +
                  (counts !== undefined
                    ? ` · ${t('panel.digest.counts', {
                        soul: counts.soul ?? 0,
                        user: counts.user ?? 0,
                        global: counts.global ?? 0,
                        project: counts.project ?? 0,
                      })}`
                    : '') +
                  (latest.ok ? '' : ` · ${latest.error ?? ''}`),
              ),
          digestTail !== '' && h('span', { className: 'sm-label' }, digestTail),
          h('span', { className: 'sm-spacer' }),
          h(
            'label',
            { className: 'sm-field' },
            h('span', { className: 'sm-label' }, t('panel.digest.model')),
            h(
              'select',
              {
                className: 'sm-select sm-model',
                value: digestModel,
                onChange: (event) => void saveDigestModel(event.target.value),
                'aria-label': t('panel.digest.model'),
                disabled: busy,
              },
              h('option', { value: '' }, t('panel.digest.modelFollow')),
              models.map((entry) =>
                h('option', { key: `${entry.provider}::${entry.id}`, value: `${entry.provider}::${entry.id}` }, entry.label || `${entry.provider} / ${entry.id}`),
              ),
              digestModel !== '' && !models.some((entry) => `${entry.provider}::${entry.id}` === digestModel)
                ? h('option', { value: digestModel }, digestModel.replace('::', ' / '))
                : null,
            ),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'sm-btn sm-btn-primary',
              onClick: runDigest,
              // v3：关闭态禁用手动整理（服务端也会回 409 PLUGIN_DISABLED，双保险）。
              disabled: busy || !enabled,
              title: enabled ? undefined : t('panel.digest.disabledHint'),
            },
            busy ? t('panel.digest.running') : t('panel.digest.now'),
          ),
        ),
      )
    }

    /** 配置示例（与 cordis.patch.yml 的字段一一对应）。 */
    const CONFIG_EXAMPLE = [
      'supermemory:',
      '  enabled: true',
      // personasRoot 是 v2 起的正名；示例写废弃别名会让人照着抄一个"能跑但方向错"的键。
      '  # 留空即 $DSH_HOME/supermemory/personas；旧名 presetsRoot 仍可用。',
      '  personasRoot: ""',
      '  projectDirName: ".dsh/memory"',
      '  projectFileName: "project-memory.md"',
      '  systemPromptMaxBytes: 12000',
      '  injectMaxBytes: 24000',
      '  autoDigest: true',
      '  digestEveryTurns: 5',
      '  digestPressureRatio: 0.75',
      '  digestMaxInputBytes: 120000',
      '  digestMaxOutputTokens: 3000',
      '  digestProvider: ""',
      '  digestModel: ""',
      // v4 整编模式阈值（契约 §V4.0.4）与 v8 分层旋钮（§V8.5）。数字与 lib/host/config.js 的
      // DEFAULTS 同源，改默认值时这一处要跟着改——示例是用户唯一会照抄的东西。
      '  injectIntoSubagents: false',
      // compactionRecall 与 projectRecall* 只是撞名，B 读代码时就被绊过一分钟，注释写在这里
      // 比写在代码里有效——示例是用户和下一个读代码的人唯一会看的地方。
      '  # 压缩之后要不要重新召回完整记忆（v7）。与下面 projectRecall* 的「本轮按话题预取冷层」无关。',
      '  compactionRecall: true',
      '  digestConsolidate: true',
      '  digestConsolidateMinEntries: 20',
      '  digestConsolidateMinBytes: 12288',
      '  digestConsolidateCooldownMs: 21600000',
      // 这行必须是 YAML 注释：示例渲染在面板的 <pre> 里，JS 注释用户根本看不见。
      '  # 推理模型的 reasoning tokens 也吃输出预算：实测整编正文仅 ≈1.7 KB 而 reasoning ≈5.9k token，',
      '  # 配 6000 会被吃穿，症状是「正文写完了却因 finish_reason=length 拒绝落盘」。别把 12000 调小。',
      '  digestConsolidateMaxOutputTokens: 12000',
      '  digestSnapshotKeep: 3',
      '  tieredInjection: true',
      '  projectCoreMaxBytes: 16384',
      '  projectIndexMaxBytes: 3072',
      '  projectRecallMaxBytes: 2048',
      '  projectRecallTopK: 5',
      '  projectRecallMinRounds: 3',
    ].join('\n')

    /** 设置页：只读概览 + 打开记忆面板 + 配置示例。 */
    function SettingsSection(props) {
      const { ctx, locale, t } = props
      useLocaleRevision(locale)
      const [boot, setBoot] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [runs, setRuns] = React.useState([])
      const [noPanel, setNoPanel] = React.useState(false)
      // v3 总开关：本地态只承载乐观展示与错误提示，真实状态一律以服务端回带为准。
      const [enabled, setEnabled] = React.useState(true)
      const [switching, setSwitching] = React.useState(false)
      const [switchError, setSwitchError] = React.useState(null)

      React.useEffect(() => {
        let alive = true
        void (async () => {
          const [bootResult, runsResult] = await Promise.all([callApi('bootstrap'), callApi('runs')])
          if (!alive) return
          if (!bootResult.ok) setError(bootResult.error)
          else {
            setBoot(bootResult.data ?? {})
            setEnabled(enabledFrom(bootResult.data))
          }
          if (runsResult.ok) {
            const list = Array.isArray(runsResult.data) ? runsResult.data : runsResult.data?.runs
            setRuns(Array.isArray(list) ? list : [])
          }
        })()
        return () => {
          alive = false
        }
      }, [])

      /**
       * 切换插件总开关（v3）。
       *
       * 顺序：先乐观翻转界面 → PUT settings → 失败立刻回滚并显示错误；
       * 成功则以服务端回带的布尔为准；万一服务端没回带布尔，就再读一次 bootstrap 确认，
       * 确认不到就退回原值并报错——宁可显示「切换失败」，也绝不显示一个没生效的状态。
       * @returns {Promise<void>}
       */
      const toggleEnabled = async () => {
        if (switching) return
        const previous = enabled
        const next = !previous
        setSwitching(true)
        setSwitchError(null)
        setEnabled(next)
        const result = await callApi('settings', { method: 'PUT', body: { enabled: next } })
        if (result.ok !== true) {
          setEnabled(previous)
          setSwitching(false)
          setSwitchError(t('settings.enableFailed', { error: result.error }))
          return
        }
        const echoed =
          typeof result.data?.enabled === 'boolean' || typeof result.data?.digestSettings?.enabled === 'boolean'
        if (echoed) {
          setEnabled(enabledFrom(result.data))
          setSwitching(false)
          if (enabledFrom(result.data) !== next) {
            setSwitchError(t('settings.enableFailed', { error: t('settings.enableUnknown') }))
          }
          return
        }
        const refreshed = await callApi('bootstrap')
        setSwitching(false)
        if (refreshed.ok !== true) {
          setEnabled(previous)
          setSwitchError(t('settings.enableFailed', { error: t('settings.enableUnknown') }))
          return
        }
        setBoot(refreshed.data ?? {})
        setEnabled(enabledFrom(refreshed.data))
        if (enabledFrom(refreshed.data) !== next) {
          setSwitchError(t('settings.enableFailed', { error: t('settings.enableUnknown') }))
        }
      }

      const openPanel = () => {
        let layout
        try {
          layout = ctx.get?.('layout')
        } catch {
          layout = undefined
        }
        if (typeof layout?.selectPanel !== 'function') {
          setNoPanel(true)
          return
        }
        layout.selectPanel('supermemory')
        if (typeof props.close === 'function') {
          try {
            props.close()
          } catch {
            /* 面板已切换，关闭设置失败不影响结果 */
          }
        }
      }

      if (error !== null) {
        return h('div', { className: 'sm-settings' }, h(StyleSlot), h('div', { className: 'sm-notice sm-notice-error' }, t('settings.loadFailed', { error })))
      }
      if (boot === null) {
        return h('div', { className: 'sm-settings' }, h(StyleSlot), h('div', { className: 'sm-notice' }, t('settings.loading')))
      }

      const config = boot.config ?? {}
      const presets = Array.isArray(boot.presets) ? boot.presets : []
      const projects = Array.isArray(boot.projects) ? boot.projects : []
      const none = t('settings.none')
      const value = (input) => (input === undefined || input === null || input === '' ? none : String(input))
      const onOff = (input) => (input === true ? t('common.on') : input === false ? t('common.off') : none)
      const latest = runs[0]

      return h(
        'div',
        { className: 'sm-settings' },
        h(StyleSlot),
        // v3：总开关卡片置顶——它是这一页唯一可写的控件，其余概览都是只读的。
        h(
          'div',
          { className: 'sm-card' },
          h('div', { className: 'sm-card-title' }, t('settings.enable')),
          h(
            'div',
            { className: 'sm-enable-head' },
            h(
              'span',
              { className: 'sm-enable-state' },
              `${t('settings.enableRow')}: ${enabled ? t('common.on') : t('common.off')}`,
            ),
            h(EnabledSwitch, {
              on: enabled,
              busy: switching,
              label: t('settings.enableAria'),
              onToggle: toggleEnabled,
            }),
          ),
          h('div', { className: 'sm-enable-hint' }, t('settings.enableHint')),
          switching && h('div', { className: 'sm-row-label' }, t('settings.enableBusy')),
          switchError !== null && h('div', { className: 'sm-notice sm-notice-error', role: 'alert' }, switchError),
        ),
        h('div', { className: 'sm-row' }, h('span', { className: 'sm-label' }, t('settings.description'))),
        h(
          'div',
          { className: 'sm-row' },
          h('button', { type: 'button', className: 'sm-btn sm-btn-primary', onClick: openPanel }, t('settings.openPanel')),
          noPanel && h('span', { className: 'sm-notice sm-notice-warn' }, t('settings.unavailable')),
        ),
        h(
          'div',
          { className: 'sm-card' },
          h('div', { className: 'sm-card-title' }, t('settings.overview')),
          h(InfoRow, { key: 'home', label: t('settings.home'), value: value(boot.dshHome) }),
          h(InfoRow, { key: 'presets', label: t('settings.presetsRoot'), value: value(boot.presetsRoot) }),
          h(InfoRow, {
            key: 'rule',
            label: t('settings.projectRule'),
            value: `${value(config.projectDirName)}/${value(config.projectFileName)}`,
          }),
          h(InfoRow, { key: 'presetCount', label: t('settings.row.presets'), value: String(presets.length) }),
          h(InfoRow, { key: 'projectCount', label: t('settings.row.projects'), value: String(projects.length) }),
        ),
        h(
          'div',
          { className: 'sm-card' },
          h('div', { className: 'sm-card-title' }, t('settings.budgets')),
          h(InfoRow, { key: 'prompt', label: t('settings.row.systemPromptMaxBytes'), value: value(config.systemPromptMaxBytes) }),
          h(InfoRow, { key: 'inject', label: t('settings.row.injectMaxBytes'), value: value(config.injectMaxBytes) }),
          // v8（契约 V8.11）：分层开关与两段预算。三键都走 value()/onOff() 的既有降级——
          // 旧服务端没有这些键时显示 settings.none，而不是 false / 0。
          h(InfoRow, { key: 'tiered', label: t('settings.row.tieredInjection'), value: onOff(config.tieredInjection) }),
          h(InfoRow, { key: 'coreMax', label: t('settings.row.projectCoreMaxBytes'), value: value(config.projectCoreMaxBytes) }),
          h(InfoRow, { key: 'indexMax', label: t('settings.row.projectIndexMaxBytes'), value: value(config.projectIndexMaxBytes) }),
          h(InfoRow, { key: 'auto', label: t('settings.row.autoDigest'), value: onOff(config.autoDigest) }),
          h(InfoRow, { key: 'turns', label: t('settings.row.digestEveryTurns'), value: value(config.digestEveryTurns) }),
          h(InfoRow, { key: 'pressure', label: t('settings.row.digestPressureRatio'), value: value(config.digestPressureRatio) }),
          h(InfoRow, { key: 'provider', label: t('settings.row.digestProvider'), value: value(config.digestProvider) }),
          h(InfoRow, { key: 'model', label: t('settings.row.digestModel'), value: value(config.digestModel) }),
          h(InfoRow, { key: 'subagents', label: t('settings.row.injectIntoSubagents'), value: onOff(config.injectIntoSubagents) }),
        ),
        h(
          'div',
          { className: 'sm-card' },
          h('div', { className: 'sm-card-title' }, t('settings.recentDigest')),
          latest === undefined
            ? h('div', { className: 'sm-row-label' }, t('panel.digest.none'))
            : h(InfoRow, {
                key: 'latest',
                label: `${latest.at ?? ''} · ${triggerLabel(t, latest.trigger)}`,
                // 尾巴（整编明细 + v8 分层统计）算不出内容时不拼分隔符，空串不进 join。
                value: [
                  latest.ok ? t('panel.digest.status.ok') : `${t('panel.digest.status.failed')} · ${latest.error ?? ''}`,
                  consolidationText(t, latest.consolidation),
                ]
                  .filter(Boolean)
                  .join(' · '),
              }),
        ),
        h(
          'div',
          { className: 'sm-card' },
          h('div', { className: 'sm-card-title' }, t('settings.configExample')),
          h('pre', { className: 'sm-code sm-mono' }, CONFIG_EXAMPLE),
        ),
      )
    }

    // ——————————————————— v9 会话人设胶囊（契约 §V9.5） ———————————————————
    //
    // 位置：`conversation.input.right`（输入框右侧、模型选择器左边）。宿主只在
    // `sessionId !== undefined` 时渲染这个槽位，组件仍防御性地判空。
    //
    // 数据只有一个来源：GET/PUT `session-persona`。本地**不维护「我猜现在是谁」的第二份
    // 真相**——切换成功后一律用响应回带的 data 替换本地态（契约 V9.4 保证 GET/PUT 同构），
    // 失败则把乐观改过的本地态整体回滚到操作前，再留一句错话。这样界面上的名字永远等于
    // 服务端确认过的值，不会出现「看着切过去了、下一轮人格没变」的静默错位。
    //
    // 只读注册表：这里只有「切换到某个人设」，不提供新建 / 重命名 / 删除入口——那是
    // 记忆面板的职责，两个入口同时能写会让冲突处理散在两处。

    /** 人设小图标：抽象人形轮廓。图标 SVG 不受 §9 颜色白名单限制。 */
    function PersonaGlyph({ size }) {
      const edge = typeof size === 'number' ? size : 13
      return h(
        'svg',
        {
          width: edge,
          height: edge,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('circle', { cx: 12, cy: 8.4, r: 3.5 }),
        h('path', { d: 'M5.2 20.2a6.8 6.8 0 0 1 13.6 0' }),
      )
    }

    /**
     * 从 GET/PUT 回带的 data 里取「要显示的生效人设名」。
     *
     * 逐级兜底：persona.name → persona.slug → globalPersona.name → globalPersona.slug。
     * 全都拿不到时返回空串，由调用方决定不渲染——**绝不拿人设图标或键名冒充一个名字**。
     * @param {object|null} data - session-persona 响应 data。
     * @returns {string} 人设显示名；拿不到为空串。
     */
    function personaPillName(data) {
      if (data === null || typeof data !== 'object') return ''
      const persona = data.persona
      if (typeof persona?.name === 'string' && persona.name !== '') return persona.name
      if (typeof persona?.slug === 'string' && persona.slug !== '') return persona.slug
      const globalPersona = data.globalPersona
      if (typeof globalPersona?.name === 'string' && globalPersona.name !== '') return globalPersona.name
      if (typeof globalPersona?.slug === 'string' && globalPersona.slug !== '') return globalPersona.slug
      return ''
    }

    /**
     * 会话人设快速切换胶囊。
     *
     * props 由三处合并而来：宿主标准 props（含 sessionId、t）、注册时
     * `inject: (sessionId) => ({ sessionId })` 的返回值、以及 wire 注入的 ctx/locale/t。
     * 三处都同源，组件只按「有没有一个非空字符串 sessionId」工作。
     *
     * @param {object} props - 组件 props。
     * @returns {object|null} 渲染元素；没有会话 ID 或加载失败时返回 null（安全降级）。
     */
    function PersonaPill(props) {
      const { locale, t } = props
      useLocaleRevision(locale)
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
      // phase: loading（首屏）/ ready（有 data）/ failed（GET 失败，整颗隐藏）。
      // GET 失败时选择**隐藏**而不是显示一个空壳「跟随全局」：拿不到真实来源时，
      // 显示任何名字都可能与实际注入的人格不一致，而不一致的显示比不显示更糟。
      const [view, setView] = React.useState({ phase: 'loading', data: null })
      const [open, setOpen] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const rootRef = React.useRef(null)
      // 同一 tick 内连点两下时 `busy` 还是旧闭包值，故再压一个同步闸门：
      // 两次 PUT 的响应可能乱序回来，晚到的旧响应会用错数据覆盖刚切换好的人设。
      const busyRef = React.useRef(false)

      React.useEffect(() => {
        if (sessionId === '') return undefined
        let alive = true
        setView({ phase: 'loading', data: null })
        void (async () => {
          const result = await callApi(`session-persona?sessionId=${encodeURIComponent(sessionId)}`)
          if (!alive) return
          if (result.ok !== true || result.data === undefined || result.data === null) {
            setView({ phase: 'failed', data: null })
            return
          }
          setView({ phase: 'ready', data: result.data })
        })()
        return () => {
          alive = false
        }
      }, [sessionId])

      // 关闭：点击外部 / Escape。document 监听只在展开时挂，收起即摘。
      // 组件不读宿主 DOM、不向 document.body 追加节点，这里只是监听两个全局事件；
      // 根节点的 onKeyDown 是同一行为的 React 侧兜底（焦点在内部按钮上时不必等 document）。
      // 在无 document 的环境（单测）里整段跳过，组件照常渲染。
      React.useEffect(() => {
        if (!open) return undefined
        const doc = typeof document === 'undefined' ? undefined : document
        if (doc === undefined || typeof doc.addEventListener !== 'function') return undefined
        const onPointer = (event) => {
          const root = rootRef.current
          const target = event?.target
          if (root !== null && root !== undefined && typeof root.contains === 'function' && target) {
            if (root.contains(target)) return
          }
          setOpen(false)
        }
        const onKey = (event) => {
          if (event?.key === 'Escape') setOpen(false)
        }
        doc.addEventListener('mousedown', onPointer)
        doc.addEventListener('keydown', onKey)
        return () => {
          if (typeof doc.removeEventListener !== 'function') return
          doc.removeEventListener('mousedown', onPointer)
          doc.removeEventListener('keydown', onKey)
        }
      }, [open])

      if (sessionId === '') return null
      if (view.phase === 'failed') return null

      if (view.phase === 'loading') {
        return h(
          'div',
          { className: 'sm-persona-pill' },
          h(StyleSlot),
          h(
            'button',
            {
              type: 'button',
              className: 'sm-persona-pill-btn',
              disabled: true,
              'aria-label': t('pill.label'),
              title: t('pill.loading'),
            },
            h(PersonaGlyph, { size: 13 }),
            h('span', { className: 'sm-persona-pill-name' }, t('pill.loading')),
          ),
        )
      }

      const data = view.data
      const personas = Array.isArray(data?.personas) ? data.personas.filter((item) => item !== null && typeof item === 'object') : []
      const bound = data?.source === 'session'
      const currentSlug = typeof data?.persona?.slug === 'string' ? data.persona.slug : ''
      const globalName =
        typeof data?.globalPersona?.name === 'string' && data.globalPersona.name !== ''
          ? data.globalPersona.name
          : typeof data?.globalPersona?.slug === 'string' && data.globalPersona.slug !== ''
            ? data.globalPersona.slug
            : t('pill.label')
      const name = personaPillName(data) || globalName
      const ariaLabel = bound ? t('pill.bound', { name }) : t('pill.followGlobal', { name: globalName })

      /**
       * 选中即 PUT；成功用回带 data 刷新，失败整体回滚并提示。
       * @param {string} slug - 目标人设 slug；空串表示恢复跟随全局。
       * @returns {Promise<void>} 无。
       */
      const choose = async (slug) => {
        if (busyRef.current) return
        busyRef.current = true
        const previous = view
        const optimisticPersona =
          slug === ''
            ? data?.globalPersona ?? { slug: '', name: globalName }
            : personas.find((item) => item.slug === slug) ?? { slug, name: slug }
        const optimistic = {
          ...data,
          persona: optimisticPersona,
          source: slug === '' ? 'global' : 'session',
        }
        setBusy(true)
        setError(null)
        setNotice(null)
        setOpen(false)
        // 乐观更新只活到响应回来为止：失败时 setView(previous) 是唯一回滚路径。
        setView({ phase: 'ready', data: optimistic })
        const result = await callApi('session-persona', {
          method: 'PUT',
          body: { sessionId, slug },
        })
        busyRef.current = false
        setBusy(false)
        if (result.ok !== true) {
          setView(previous)
          setError(t('pill.switchFailed', { error: result.error }))
          return
        }
        const next = result.data !== undefined && result.data !== null ? result.data : optimistic
        setView({ phase: 'ready', data: next })
        setNotice(t('pill.switched', { name: personaPillName(next) || name }))
      }

      return h(
        'div',
        {
          className: 'sm-persona-pill',
          ref: rootRef,
          onKeyDown: (event) => {
            if (event?.key === 'Escape') setOpen(false)
          },
        },
        h(StyleSlot),
        h(
          'button',
          {
            type: 'button',
            className: `sm-persona-pill-btn${bound ? ' is-bound' : ''}`,
            'aria-label': ariaLabel,
            'aria-expanded': open,
            'aria-haspopup': 'menu',
            title: ariaLabel,
            disabled: busy,
            onClick: () => {
              // 展开即意味着用户又开始操作了，上一轮的成功提示不必再占屏。
              setNotice(null)
              setOpen((current) => !current)
            },
            // 键盘用户聚焦在胶囊按钮上时，Escape 直接收起，不必等 document 通道。
            onKeyDown: (event) => {
              if (event?.key === 'Escape') setOpen(false)
            },
          },
          h(PersonaGlyph, { size: 13 }),
          h('span', { className: 'sm-persona-pill-name' }, name),
        ),
        open &&
          h(
            'div',
            { className: 'sm-persona-pill-pop', role: 'menu', 'aria-label': t('pill.label') },
            h(
              'div',
              { className: 'sm-persona-pill-head' },
              h('span', null, t('pill.label')),
              h(
                'button',
                {
                  type: 'button',
                  className: 'sm-persona-pill-close',
                  'aria-label': t('pill.close'),
                  title: t('pill.close'),
                  onClick: () => setOpen(false),
                },
                '×',
              ),
            ),
            h(
              'button',
              {
                key: 'follow-global',
                type: 'button',
                role: 'menuitemradio',
                'aria-checked': bound !== true,
                className: `sm-persona-pill-item${bound ? '' : ' is-active'}`,
                disabled: busy,
                onClick: () => void choose(''),
              },
              h('span', { className: 'sm-persona-pill-mark', 'aria-hidden': 'true' }, bound ? '' : '✓'),
              h('span', { className: 'sm-persona-pill-item-name' }, t('pill.followGlobal', { name: globalName })),
            ),
            personas.map((item) => {
              const active = bound && item.slug === currentSlug
              return h(
                'button',
                {
                  key: `persona:${String(item.slug)}`,
                  type: 'button',
                  role: 'menuitemradio',
                  'aria-checked': active,
                  className: `sm-persona-pill-item${active ? ' is-active' : ''}`,
                  disabled: busy,
                  onClick: () => void choose(item.slug),
                },
                h('span', { className: 'sm-persona-pill-mark', 'aria-hidden': 'true' }, active ? '✓' : ''),
                h('span', { className: 'sm-persona-pill-item-name' }, item.name || item.slug),
              )
            }),
          ),
        error !== null && h('span', { className: 'sm-persona-pill-error', role: 'alert' }, error),
        notice !== null && h('span', { className: 'sm-persona-pill-notice', role: 'status' }, notice),
      )
    }

    /** 需要宿主提供的服务：槽位、本地化、布局（打开面板）。 */
    const inject = ['slots', 'locale', 'layout']

    /**
     * 客户端插件入口：注册词典、侧栏图标、主面板与设置页。
     * @param {object} ctx - 浏览器插件上下文。
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'supermemory: dictionaries')
      const t = ctx.locale.bind(NS)
      const locale = ctx.locale

      const wire = (page) => (props) => h(page, { ...props, ctx, locale, t })

      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          { name: 'sidebar.panellist', id: NS, order: 40, locale: NS, label: () => t('panel.title') },
          MemoryIcon,
        ),
      )
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: NS, locale: NS }, wire(PanelPage)))
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          { name: 'settings.section', id: NS, order: 130, locale: NS, label: () => t('settings.title') },
          wire(SettingsSection),
        ),
      )
      // v9（契约 §V9.5）：输入框右侧的会话人设胶囊。
      // `inject` 的实参是会话 scope 的 key（sessionId），返回值直接成为组件 props；
      // 组件因此不必依赖宿主标准 props 的命名，也不读 DOM。order 10 让它靠近模型选择器
      // （模型席位在 input.model，input.right 在它之前）。
      ctx.slots.inject('conversation.input.right', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.right',
            id: 'supermemory-persona',
            order: 10,
            locale: NS,
            inject: (sessionId) => ({ sessionId }),
          },
          wire(PersonaPill),
        ),
      )
    }

    return { inject, apply }
  },
})
