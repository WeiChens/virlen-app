import { initEvnService } from './services/env-service'
import { initI18n } from './ui/i18n'
import { initDefaultAgent } from '@/services/agent-service'
import {
  initDefaultWorkspace,
  settingsState,
  hydrateSettings,
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
import { securityService } from './services/security-service'
import { checkUpdate, shouldShowUpdate } from './services/update-service'
import updateEvent from './events/updateEvent'
import { ragService } from './services/rag-service'
import { installTelemetry, track, trackPerf, flushTelemetry } from '@/utils/telemetry'
import { installGlobalErrorHandlers } from '@/utils/telemetry/errorHandler'
import { bindUsageLedger } from '@/domain/usage'
import { tauriUsageLedger } from '@/infrastructure/usage-ledger'
import { initTrayService } from '@/services/tray-service'
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
    engine:
      settingsState.value.useRustEngine &&
      typeof window !== 'undefined' &&
      '__TAURI_INTERNALS__' in window
        ? 'rust'
        : 'ts',
    theme: settingsState.value.theme,
    font_size: settingsState.value.fontSize,
    locale: settingsState.value.language,
    is_dev: import.meta.env.DEV,
  }),
})
installGlobalErrorHandlers()

track('app.start', { cold_start: true, boot_stage: 'entry' })

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
  }
}

async function main() {
  const initStart = perfNow()
  await init()
  const initDuration = Math.round(perfNow() - initStart)
  // 渲染页面
  render()
  //  待 React 渲染 + 首次绘制完成后显示窗口，消除白屏/卡顿感知
  requestAnimationFrame(() => {
    import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
      getCurrentWindow().show()
      track('app.window.show', {
        time_since_start_ms: Date.now() - PROCESS_START_TS,
      })
      trackPerf('perf.window.first_paint', { ms: Math.round(perfNow()) })
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
  // 「忽略沙盒命令」规则下沉（S7）：规则以 `app_settings` 为**唯一源**（localStorage 不保存）。
  // ⚠️ 走 store 的 hydrate（而非直接调 infra 的 hydrateSecurity）——它还会刷新 observable，
  //    否则设置页读到的仍是模块加载瞬间的快照（看起来「还是 localStorage」）。
  await step('securityConfig', () => securityStore.hydrate())
  // Agent 配置下沉（D3 延伸）：`agents` 以 `app_settings` 为唯一源（localStorage 只作迁移来源）。
  // ⚠️ 必须在 `initDefaultAgent()` / `agentStore.reload()` **之前**——否则默认 Agent 的补全
  //    会读到空列表、在本地重建并**覆盖**表里已有的 Agent。
  await step('agents', () => hydrateAgents())
  // 用量统计（token 账本）：把领域侧记账端口绑到 Tauri/SQLite 实现；
  // 未绑定时 recordUsage 是空操作，因此业务代码可以无条件调用。
  bindUsageLedger(tauriUsageLedger)
  await step('toolsInit', () => toolsInit())
  // 工具定义权威源接线（机制 C）：Tauri 走 Rust 命令 `cmd_list_tool_definitions`，
  // 浏览器 dev / 测试读内嵌的同一份契约 JSON；随后预热一次，
  // 让「契约与执行器不匹配」这类问题在启动阶段就暴露（而不是首次发消息才报）。
  setToolDefinitionsLoader(loadToolDefinitions)
  await step('toolDefinitions', () => toolRegistry.init())
  // 提示词权威源接线（与工具定义同一模式）：必须在任何组装系统提示词的路径之前完成 ——
  // `promptText()` 在未水合时直接抛错（宁可启动失败，也不要静默丢掉工具规范 / 验证要求）。
  await step('prompts', async () => setPromptTexts(await loadPromptTexts()))
  await step('defaultAgent', () => initDefaultAgent())
  agentStore.reload()
  await Promise.all([
    step('sessionLoad', () => sessionStore.loadFromDB()),
    step('security', () => securityService.initDefaultSecurity()),
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

  // 托盘/后台化集成：把「谁在工作」推给 Rust、接管托盘点击（非 Tauri 环境自动跳过）
  await step('tray', () => initTrayService())

  providerService.initProviders()
  searchProviderService.initSearchProviders()

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

main()
