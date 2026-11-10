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
        "panel.budget.inject": "Injection",
        "panel.budget.persona": "Persona",
        "panel.bytes": "Bytes: {bytes}",
        "panel.conflict": "This file was modified outside the panel.",
        "panel.conflictHint": "Reload to read the latest disk content; copy your edits first if you want to keep them.",
        "panel.digest.counts": "soul {soul} · user {user} · global {global} · project {project}",
        "panel.digest.disabledHint": "Digest is unavailable while the plugin is off.",
        "panel.digest.done": "Digest finished.",
        "panel.digest.failed": "Digest failed: {error}",
        "panel.digest.model": "Digest model",
        "panel.digest.modelFollow": "Follow current session",
        "panel.digest.modelSaveFailed": "Could not save the digest model: {error}",
        "panel.digest.modelSaved": "Digest model saved.",
        "panel.digest.none": "No digest has run yet.",
        "panel.digest.now": "Digest now",
        "panel.digest.running": "Digesting…",
        "panel.digest.status.failed": "failed",
        "panel.digest.status.ok": "succeeded",
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
        "panel.title": "Memory",
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
        "settings.row.projectDirName": "Project directory name",
        "settings.row.projectFileName": "Project file name",
        "settings.row.projects": "Known projects",
        "settings.row.systemPromptMaxBytes": "System prompt budget (bytes)",
        "settings.title": "Memory",
        "settings.unavailable": "The memory panel is not available in this client.",
  }/*__EN_END__*/
    const zh = /*__ZH_START__*/{
        "common.off": "关闭",
        "common.on": "开启",
        "meta.description": "人格、用户画像、全局记忆与项目记忆：注入每个会话，并可在 Web 面板中直接编辑。",
        "meta.title": "记忆",
        "panel.budget.inject": "注入",
        "panel.budget.persona": "人格",
        "panel.bytes": "字节数：{bytes}",
        "panel.conflict": "文件已被外部修改。",
        "panel.conflictHint": "请重新载入以获取磁盘上的最新内容；如需保留当前修改，请先复制。",
        "panel.digest.counts": "人格 {soul} · 画像 {user} · 全局 {global} · 项目 {project}",
        "panel.digest.disabledHint": "插件关闭时不能手动整理。",
        "panel.digest.done": "整理完成。",
        "panel.digest.failed": "整理失败：{error}",
        "panel.digest.model": "整理模型",
        "panel.digest.modelFollow": "跟随当前会话",
        "panel.digest.modelSaveFailed": "保存整理模型失败：{error}",
        "panel.digest.modelSaved": "整理模型已保存。",
        "panel.digest.none": "还没有整理记录。",
        "panel.digest.now": "立即整理",
        "panel.digest.running": "整理中…",
        "panel.digest.status.failed": "失败",
        "panel.digest.status.ok": "成功",
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
        "panel.title": "记忆",
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
        "settings.row.projectDirName": "项目目录名",
        "settings.row.projectFileName": "项目文件名",
        "settings.row.projects": "已知项目数",
        "settings.row.systemPromptMaxBytes": "系统提示预算（字节）",
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
      '.sm-budget{display:flex;flex-direction:column;gap:4px;flex:1;min-width:170px;max-width:280px}',
      '.sm-budget-head{display:flex;justify-content:space-between;gap:8px;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.sm-bar{height:6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}',
      '.sm-bar-fill{height:100%;background:var(--dsw-alias-brand-primary)}',
      '.sm-bar-fill.is-warn{background:var(--dsw-alias-state-warn-primary)}',
      '.sm-bar-fill.is-error{background:var(--dsw-alias-state-error-primary)}',
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

    /** UTF-8 字节数，与服务端 byteLength 口径一致。 */
    function utf8Bytes(text) {
      try {
        return new TextEncoder().encode(String(text ?? '')).length
      } catch {
        return String(text ?? '').length
      }
    }

    /** 整理触发源的可读名称。 */
    const TRIGGERS = ['turns', 'pressure', 'manual', 'tool']
    function triggerLabel(t, trigger) {
      return TRIGGERS.includes(trigger) ? t(`panel.digest.trigger.${trigger}`) : String(trigger ?? '')
    }

    /** 预算占用条。 */
    function BudgetBar({ label, used, total }) {
      const ratio = total > 0 ? Math.min(used / total, 1) : 0
      const percent = Math.round(ratio * 100)
      const tone = ratio >= 0.95 ? ' is-error' : ratio >= 0.75 ? ' is-warn' : ''
      return h(
        'div',
        { className: 'sm-budget' },
        h(
          'div',
          { className: 'sm-budget-head' },
          h('span', null, label),
          h('span', { className: 'sm-mono' }, total > 0 ? `${percent}% · ${used} / ${total}` : String(used)),
        ),
        h('div', { className: 'sm-bar' }, h('div', { className: `sm-bar-fill${tone}`, style: { width: `${percent}%` } })),
      )
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
        setNotice({ kind: 'ok', text: t('panel.personaSwitched') })
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
      // 项目列表由宿主动态提供（工作区自动同步），面板只读。
      const projects = Array.isArray(boot?.projects) ? boot.projects : []
      const config = boot?.config ?? {}
      const injectBudget = Number(config.injectMaxBytes) || 0
      const personaBudget = Number(config.systemPromptMaxBytes) || 0
      const totalBytes = SCOPES.reduce((sum, name) => sum + (typeof docs[name]?.bytes === 'number' ? docs[name].bytes : 0), 0)
      const personaBytes = typeof docs.soul?.bytes === 'number' ? docs.soul.bytes : 0
      const latest = runs[0]
      const counts = latest?.counts

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
          ),
          personaFormOpen
            ? h(
                'div',
                { className: 'sm-field sm-persona-form' },
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
                h('button', { type: 'button', className: 'sm-btn sm-btn-primary', onClick: () => void createPersona(), disabled: busy || personaName.trim() === '' }, t('panel.personaCreate')),
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
                  type: 'button',
                  className: 'sm-btn',
                  onClick: () => setPersonaFormOpen(true),
                  disabled: busy,
                },
                t('panel.personaAdd'),
              ),
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
          h(BudgetBar, { label: t('panel.budget.inject'), used: totalBytes, total: injectBudget }),
          h(BudgetBar, { label: t('panel.budget.persona'), used: personaBytes, total: personaBudget }),
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
      '  presetsRoot: ""',
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
      '  injectIntoSubagents: false',
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
                value: latest.ok ? t('panel.digest.status.ok') : `${t('panel.digest.status.failed')} · ${latest.error ?? ''}`,
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
    }

    return { inject, apply }
  },
})
