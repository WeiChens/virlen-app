import { useEffect } from 'react'
import { reaction } from 'mobx'
import { settingsState } from '@/ui/store/settingStore'

type Theme = 'light' | 'dark' | 'system'

function getSystemTheme(): 'light' | 'dark' {
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  return 'light'
}

function resolveTheme(theme: Theme): 'light' | 'dark' {
  if (theme === 'system') return getSystemTheme()
  return theme
}

function applyTheme(theme: Theme) {
  const resolved = resolveTheme(theme)
  document.documentElement.setAttribute('data-theme', resolved)
}

export function useTheme() {
  useEffect(() => {
    if (typeof window === 'undefined') return

    applyTheme(settingsState.value.theme)

    const dispose = reaction(
      () => settingsState.value.theme,
      (theme: Theme) => {
        applyTheme(theme)
      }
    )

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = () => {
      if (settingsState.value.theme === 'system') applyTheme('system')
    }
    mediaQuery.addEventListener('change', handler)

    return () => {
      dispose()
      mediaQuery.removeEventListener('change', handler)
    }
  }, [])
}
