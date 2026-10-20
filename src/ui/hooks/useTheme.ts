import { useEffect } from 'react'
import { reaction } from 'mobx'
import { settingsState } from '@/ui/store/settingStore'
import {
  resolveThemeMode,
  saveBootAppearance,
  type SettingsTheme,
} from '@/ui/theme/bootAppearance'

type Theme = SettingsTheme

function applyTheme(theme: Theme) {
  document.documentElement.setAttribute('data-theme', resolveThemeMode(theme))
}

/**
 * 顺带刷新「启动期外观缓存」：下次启动屏要按同一档深浅画标题栏，
 * 否则深色用户每次都会先看到一帧亮色再跳（缓存说明见 ui/theme/bootAppearance.ts）。
 */
function persistBootAppearance(theme: Theme): void {
  saveBootAppearance(settingsState.value.accentColor, theme)
}

export function useTheme() {
  useEffect(() => {
    if (typeof window === 'undefined') return

    applyTheme(settingsState.value.theme)
    persistBootAppearance(settingsState.value.theme)

    const dispose = reaction(
      () => settingsState.value.theme,
      (theme: Theme) => {
        applyTheme(theme)
        persistBootAppearance(theme)
      }
    )

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = () => {
      if (settingsState.value.theme === 'system') {
        applyTheme('system')
        // system 档的解析结果变了 → 缓存也要跟着变，否则下次启动屏是反的
        persistBootAppearance('system')
      }
    }
    mediaQuery.addEventListener('change', handler)

    return () => {
      dispose()
      mediaQuery.removeEventListener('change', handler)
    }
  }, [])
}
