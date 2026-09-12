import { initEvnService } from './services/env-service'
import { initI18n } from './ui/i18n'
import { initDefaultAgent } from '@/services/agent-service'
import { initDefaultWorkspace, settingsState } from '@/ui/store/settingStore'
import { initSkillStore } from '@/skill/skillStore'
import { sessionStore } from '@/ui/store/sessionStore'
import { agentStore } from '@/ui/store/agentStore'
import { invoke } from '@tauri-apps/api/core'
import { render } from './ui/App'
import { providerService } from './services/provider-service'
import { searchProviderService } from './services/search-provider-service'
import { toolsInit } from './infrastructure/tools'
import { securityService } from './services/security-service'
import { checkUpdate, shouldShowUpdate } from './services/update-service'
import updateEvent from './events/updateEvent'
import { ragService } from './services/rag-service'
import { installTelemetry, track, trackPerf, flushTelemetry } from '@/utils/telemetry'
import { installGlobalErrorHandlers } from '@/utils/telemetry/errorHandler'

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
  await step('toolsInit', () => toolsInit())
  initDefaultAgent()
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
  })
}

main()
