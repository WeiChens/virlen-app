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
