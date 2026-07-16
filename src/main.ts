import { initEvnService } from './services/env-service'
import { initI18n } from './ui/i18n'
import { initDefaultAgent } from '@/services/agent-service'
import { initDefaultWorkspace } from '@/ui/store/settingStore'
import { initSkillStore } from '@/skill/skillStore'
import { sessionStore } from '@/ui/store/sessionStore'
import { agentStore } from '@/ui/store/agentStore'
import { invoke } from '@tauri-apps/api/core'
import { render } from './ui/App'
import { providerService } from './services/provider-service'
import { searchProviderService } from './services/search-provider-service'
import { toolsInit } from './infrastructure/tools'
import { securityService } from './services/security-service'
import { checkUpdate } from './services/update-service'
import updateEvent from './events/updateEvent'

async function main() {
  await init()
  // 渲染页面
  render()
  //  待 React 渲染 + 首次绘制完成后显示窗口，消除白屏/卡顿感知
  requestAnimationFrame(() => {
    import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
      getCurrentWindow().show()
    })
  })
  // 窗口显示后检查更新（非阻塞）
  requestAnimationFrame(() => {
    checkForUpdates()
  })
}

/**
 * 检查更新
 */
async function checkForUpdates() {
  const result = await checkUpdate()
  if (result && result.has_update && result.latest_version) {
    // 有可用更新 → 触发更新弹窗
    updateEvent.emit('showUpdateModal', result)
  }
}

/**
 * 应用初始化
 */
async function init() {
  await toolsInit()
  initDefaultAgent()
  agentStore.reload()
  await Promise.all([
    sessionStore.loadFromDB(),
    securityService.initDefaultSecurity(),
    initDefaultWorkspace(),
    initSkillStore(),
    initEvnService(),
    initI18n(),
    (async () => {
      try {
        await invoke('grant_permissions')
      } catch (err) {
        console.warn(
          'grant_permissions failed (non-Windows or WebView not ready):',
          err,
        )
      }
    })(),
  ])

  providerService.initProviders()
  searchProviderService.initSearchProviders()
}

main()
