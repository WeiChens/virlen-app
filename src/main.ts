import { initEvnService } from './services/env-service'
import { initI18n, t } from './ui/i18n'
// 入场启动屏（本体在 index.html 里内联，见 src/boot/splash.ts）
import { bootSplash } from './boot/splash'
import { initDefaultAgent, migrateLegacyMcpToolNames } from '@/services/agent-service'
import {
  initDefaultWorkspace,
  settingsState,
  hydrateSettings,
  migrateCodeDisplaySettings,
  flushSettingsPersist,
} from '@/ui/store/settingStore'
import { initSkillStore } from '@/skill/skillStore'
import { sessionStore } from '@/ui/store/sessionStore'
import { agentStore } from '@/ui/store/agentStore'
import { invoke } from '@tauri-apps/api/core'
import { render } from './ui/App'
import { providerService } from './services/provider-service'
import { searchProviderService } from './services/search-provider-service'
import { toolsInit } from './infrastructure/tools'
import { toolRegistry, setToolDefinitionsLoader } from '@/domain/tools'
import { loadToolDefinitions } from '@/infrastructure/tools/definitions-source'
// 提示词权威源（同工具定义）：文本本体在 `virlen-core/src/agent/prompts/*.md`，
// Tauri 走 `cmd_agent_prompts`、浏览器 dev / 测试读同一份 md。
import { setPromptTexts } from '@/domain/agent'
import { loadPromptTexts } from '@/infrastructure/prompts/prompt-source'
// 供应商目录权威源（与提示词同一模式）：模板表 / 推理强度档位表本体在
// `virlen-core/src/agent/provider/provider_catalog.json`，Tauri 走 `cmd_provider_catalog`、
// 浏览器 dev / 测试读同一份 json。
import { hydrateProviderCatalog } from '@/infrastructure/provider/catalog-source'
import { securityService } from './services/security-service'
import { applyWebviewZoom } from './ui/hooks/useZoom'
// 启动期外观缓存：只为 index.html 里那块启动屏服务（说明见该文件）
import { resolveThemeMode, saveBootAppearance } from './ui/theme/bootAppearance'
import { checkUpdate, shouldShowUpdate } from './services/update-service'
import updateEvent from './events/updateEvent'
import { ragService } from './services/rag-service'
import { installTelemetry, track, trackPerf, flushTelemetry } from '@/utils/telemetry'
import { installGlobalErrorHandlers } from '@/utils/telemetry/errorHandler'
import { bindUsageLedger } from '@/domain/usage'
import { tauriUsageLedger } from '@/infrastructure/usage-ledger'
import { initTrayService } from '@/services/tray-service'
// 后台服务「结束通知」：AI 空闲时服务结束了 → Rust 发 `agent:service-exit`，前端落进消息列表
import { initServiceNotice } from '@/services/service-notice'
// MCP：Rust 发 `mcp:changed` / `mcp:status` → 失效工具定义缓存 + 补默认 Agent 白名单
import { initMcpBridge } from '@/services/mcp'
// 闲置会话自动归档（设置项 sessionAutoArchive*）：应立即跑一次 + 定时检查，必须在 sessionLoad 之后接线
import { initSessionAutoArchive } from '@/services/chat/auto-archive'
// 安全配置：规则以 Rust 侧 `app_settings` 为唯一源（localStorage 不保存），
// 启动同步由 store 的 hydrate 负责（它同时刷新 observable，设置页立即展示表里的值）。
import { flushSecurityPersist } from '@/infrastructure/securityRepo'
import { securityStore } from '@/ui/store/securityStore'
// Agent 配置（D3 延伸）：以 `app_settings` 的 `agents` 键为唯一源，
// 启动水合 + 退出前补写（与 securityRepo 同款）；CLI `list-agent` 读的就是同一份。
import { flushAgentsPersist, hydrateAgents } from '@/infrastructure/agentRepo'

/** 性能计时（优先高精度） */
const perfNow = () =>
  typeof performance !== 'undefined' ? performance.now() : Date.now()

/** 距进程启动的近似时间戳（用于 app.window.show） */
const PROCESS_START_TS = Date.now()

/**
 * 埋点安装（务必在任何业务逻辑前调用）
 * - 默认关：仅当 settingsState.telemetryEnabled=true 才采集
 * - 运行时上下文实时读取设置，避免 utils → ui 的耦合
 */
installTelemetry({
  isEnabled: () => settingsState.value.telemetryEnabled,
  runtimeContext: () => ({
    // 引擎恒为 Rust（TS 引擎已移除）；保留字段只为埋点历史数据可区分（旧值可能是 'ts'）
    engine: 'rust',
    theme: settingsState.value.theme,
    font_size: settingsState.value.fontSize,
    locale: settingsState.value.language,
    is_dev: import.meta.env.DEV,
  }),
})
installGlobalErrorHandlers()

track('app.start', { cold_start: true, boot_stage: 'entry' })

/**
 * 初始化步骤数的**估算值**：只影响启动屏进度条走位，不影响任何逻辑。
 * 增删 `step()` 时顺手改它 —— 写小了会提前停在 92%（`bootSplash` 的封顶），写大了只是走不满。
 */
const INIT_STEP_ESTIMATE = 19
/** 已完成的 step 数（进度条分子） */
let completedSteps = 0

/** 记录一个初始化子步骤的耗时与结果（§5.1 app.init.step） */
async function step(name: string, fn: () => any | Promise<any>): Promise<void> {
  const start = perfNow()
  try {
    await fn()
    track('app.init.step', {
      step_name: name,
      duration_ms: Math.round(perfNow() - start),
      status: 'success',
    })
  } catch (e: any) {
    track('app.init.step', {
      step_name: name,
      duration_ms: Math.round(perfNow() - start),
      status: 'fail',
      error: e?.message || String(e),
    })
    throw e
  } finally {
    // 失败也推进：失败会立刻切到错误态（进度条被隐藏），这里保持计数简单
    completedSteps += 1
    bootSplash.setProgress(completedSteps / INIT_STEP_ESTIMATE)
  }
}

/**
 * 启动失败收口：把错误摆到启动屏上。
 * 不抛给顶层的 unhandledrejection 就只剩一块白屏 / 一个永不结束的动画。
 */
function failBoot(e: unknown): void {
  console.error('[boot] 应用初始化失败:', e)
  bootSplash.fail(e, {
    message: t('启动没有完成，请重试；若反复失败请重启应用。'),
    retry: t('重试'),
  })
}

async function main() {
  // 启动屏本体已在内联 HTML 里画好（无文字，只有 logo + 动画）：这里补第一句文案。
  // ⚠️ 此刻 i18n 还没水合，`t()` 对 en-US 只能返回中文 key —— init 里 `i18n` 步骤
  //    完成后会重设一次（见 init()），那段窗口只有几十毫秒。
  bootSplash.setText(t('正在启动…'))

  // 启动屏标题栏的窗口按钮：bundle 一就绪就绑上。
  // 拖拽不需要 JS（`data-tauri-drag-region` 由 Tauri 自己处理）—— 解析 bundle 的这几百毫秒里
  // 窗口已经能拖，只是按钮还没反应。
  void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
    bootSplash.bindWindowControls(getCurrentWindow())
  })

  const initStart = perfNow()
  try {
    await init()
  } catch (e) {
    failBoot(e)
    return
  }
  const initDuration = Math.round(perfNow() - initStart)
  // 渲染页面
  bootSplash.setText(t('正在准备界面…'))
  render()
  //  待 React 渲染 + 首次绘制完成后显示窗口、淡出启动屏
  //  两次 rAF：第一次是 React 提交，第二次样式/绘制才落地 —— 只等一层会露出半张脸
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      bootSplash.done()
      import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
        getCurrentWindow().show()
        track('app.window.show', {
          time_since_start_ms: Date.now() - PROCESS_START_TS,
        })
        trackPerf('perf.window.first_paint', { ms: Math.round(perfNow()) })
      })
    })
  })
  // 窗口显示后检查更新（非阻塞）
  requestAnimationFrame(() => {
    checkForUpdates()
  })
  // 应用就绪（§5.1 app.ready）
  track('app.ready', {
    init_duration_ms: initDuration,
    status: 'success',
  })
  // 冷启动耗时（§12.10 perf.app.cold_start，10% 采样）
  trackPerf('perf.app.cold_start', { ms: Date.now() - PROCESS_START_TS })
}

/**
 * 检查更新
 *
 * 检测到新版本后，先判断用户是否「忽略该版本」或「7日内不再提示」，
 * 若未设置偏好则触发更新弹窗。
 */
async function checkForUpdates() {
  const result = await checkUpdate()
  if (result && result.has_update && result.latest_version) {
    // 先检查用户偏好（忽略版本 / 7日免打扰）
    if (!shouldShowUpdate(result)) {
      return
    }
    // 有可用更新 → 触发更新弹窗
    updateEvent.emit('showUpdateModal', result)
  }
}

/**
 * 应用初始化
 */
async function init() {
  // 配置下沉（D3）：先把 Rust 侧 `app_settings` 水合进设置（幂等；非 Tauri 环境自动跳过）——
  // 必须在最前面：i18n / 工作目录 / 会话加载 / 权限都直接依赖设置值。
  await step('settings', () => hydrateSettings())
  // 启动屏外观：设置已水合 → 用真值覆盖 index.html 按缓存涂的近似值，并把真值写回缓存。
  // 同步、无 IPC，不单独占一个 step（缓存机制见 ui/theme/bootAppearance.ts）。
  bootSplash.applyAppearance(
    settingsState.value.accentColor,
    resolveThemeMode(settingsState.value.theme),
  )
  saveBootAppearance(settingsState.value.accentColor, settingsState.value.theme)
  // 代码显示：旧的「界面字号」三档 → 独立代码字号（一次性）。必须紧跟在设置水合之后：
  // 字号档位的权威值在 app_settings 表里，早于水合会把默认的 medium 折成 13px。
  await step('codeDisplay', () => migrateCodeDisplaySettings())
  // 界面缩放：必须在 render() 之前落地（窗口在首帧后 shown），否则会先按 100% 画一帧再跳。
  // 后续变更由 App.tsx 的 useZoom() 监听设置负责。
  await step('zoom', () => applyWebviewZoom(settingsState.value.zoomFactor))

  // 用量统计（token 账本）：把领域侧记账端口绑到 Tauri/SQLite 实现；
  // 未绑定时 recordUsage 是空操作，因此业务代码可以无条件调用。同步绑定，不产生 IPC。
  bindUsageLedger(tauriUsageLedger)
  // 工具定义权威源接线（机制 C）：先接上加载器，下面的 toolRegistry.init() 才有源可读。
  setToolDefinitionsLoader(loadToolDefinitions)

  bootSplash.setText(t('正在加载数据…'))

  // ── 阶段 1：互不依赖的水合 / 注册，一次并发 ──
  // 这里原先是一条串行链（securityConfig → agents → toolsInit → toolDefinitions → prompts →
  // providerCatalog），每一步都要等上一次 IPC 回来才发下一个 —— 首屏时长等于它们的**和**。
  // 真正有顺序关系的只有两处，且都已经挪到阶段 2：
  //   ① initDefaultAgent() 需要 agentRepo 已水合 + 工具定义已载入；
  //   ② initDefaultSecurity() 需要 securityStore 已水合（否则 load() 看到空表又写一遍默认值）。
  await Promise.all([
    // 「忽略沙盒命令」规则下沉（S7）：规则以 `app_settings` 为唯一源（localStorage 不保存）。
    // 走 store 的 hydrate 而非直接调 infra 的 hydrateSecurity —— 它还会刷新 observable，
    // 否则设置页读到的仍是模块加载瞬间的快照。
    step('securityConfig', () => securityStore.hydrate()),
    // Agent 配置下沉（D3 延伸）：`agents` 以 `app_settings` 为唯一源（localStorage 只作迁移来源）。
    step('agents', () => hydrateAgents()),
    step('toolsInit', () => toolsInit()),
    // 预热一次工具定义（Tauri 走 `cmd_list_tool_definitions`，浏览器 dev / 测试读内嵌的同一份
    // 契约 JSON）：让「契约与执行器不匹配」这类问题在启动阶段就暴露（而不是首次发消息才报）。
    step('toolDefinitions', () => toolRegistry.init()),
    // 提示词权威源接线（与工具定义同一模式）：必须在任何组装系统提示词的路径之前完成 ——
    // `promptText()` 在未水合时直接抛错（宁可启动失败，也不要静默丢掉工具规范 / 验证要求）。
    step('prompts', async () => setPromptTexts(await loadPromptTexts())),
    // 供应商目录（与提示词同一模式）：必须在任何渲染「添加服务商」入口之前完成 ——
    // `providerCatalog()` 未水合时直接抛错（宁可启动失败，也不要静默渲染出一张空模板网格）。
    step('providerCatalog', () => hydrateProviderCatalog()),
    step('sessionLoad', () => sessionStore.loadFromDB()),
    step('workspace', () => initDefaultWorkspace()),
    step('skills', () => initSkillStore()),
    step('env', () => initEvnService()),
    step('i18n', () => initI18n()),
    step('permissions', async () => {
      try {
        await invoke('grant_permissions')
      } catch (err) {
        console.warn(
          'grant_permissions failed (non-Windows or WebView not ready):',
          err,
        )
      }
    }),
  ])

  // i18n 已就绪：把启动屏文案换成当前语言（阶段 1 之前 `t()` 对 en-US 只能返回中文 key）
  bootSplash.setText(t('正在加载数据…'))

  // ── 阶段 2：依赖阶段 1 的结果 ──
  // 旧白名单里的 `mcp__<server>__<raw>` 剥成裸工具名：不剥就永远对不上现在的名字
  //（§11.69 的幽灵名）。必须在 initDefaultAgent 之前跑：默认 Agent 尚不存在时
  // 建出来的快照才是干净的。
  step('mcpLegacyNames', () => migrateLegacyMcpToolNames())
  await Promise.all([
    // ⚠️ 必须在 `hydrateAgents()` 之后：否则默认 Agent 的创建读到空列表，
    //    会在本地造一份并覆盖表里已有的 Agent。
    step('defaultAgent', () => initDefaultAgent()).then(() => agentStore.reload()),
    step('security', () => securityService.initDefaultSecurity()),
  ])

  // 托盘/后台化集成：把「谁在工作」推给 Rust、接管托盘点击（非 Tauri 环境自动跳过）
  await step('tray', () => initTrayService())

  // 后台服务结束通知（P5）：AI 空闲时服务结束 → 落一条 feedback 消息（用户可见，AI 下次请求带上）。
  // 必须在窗口显示前挂好：服务是应用运行中才有的东西，启动即挂最省心（AI 在跑时那条路不经过前端）。
  await step('serviceNotice', () => initServiceNotice())

  // MCP 事件桥：工具集合变化 → 失效定义缓存（下一次发送自然拿到新集合）。
  // 必须在 `defaultAgent` 之后：首次对齐会刷新状态与冲突名单，那时默认 Agent 应已就位。
  await step('mcp', () => initMcpBridge())

  providerService.initProviders()
  searchProviderService.initSearchProviders()

  // 闲置会话自动归档：必须在 sessionLoad（阶段 1）之后 —— 否则扫到的是空列表。
  // 非阻塞，不占启动关键路径里的 step。
  initSessionAutoArchive()

  // 初始化知识库（无知识库时自动创建默认知识库，非阻塞）
  ragService.initKnowledgeBases().catch((err) => {
    console.warn('[RAG] init knowledge bases failed:', err)
  })
}

// 退出前记录并落盘（§5.1 app.exit）
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    track('app.exit', {
      run_duration_ms: Date.now() - PROCESS_START_TS,
      exit_reason: 'normal',
    })
    flushTelemetry()
    // 设置落库是 debounce 的，退出前补一次（否则刚改的开关可能丢）
    flushSettingsPersist()
    // 「忽略沙盒命令」规则同样是 debounce 落库的，一并补一次
    flushSecurityPersist()
    // Agent 列表（debounce 落库）同上
    flushAgentsPersist()
  })
}

// 顶层兜底：init 之外（render / 首帧）的意外也不能变成白屏
main().catch(failBoot)
