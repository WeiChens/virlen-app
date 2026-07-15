import { useEffect } from 'react'
import { reaction } from 'mobx'
import { settingsState } from '@/ui/store/settingStore'

type FontSize = 'small' | 'medium' | 'large'

function applyFontSize(fontSize: FontSize) {
  if (fontSize === 'medium') {
    document.documentElement.removeAttribute('data-font-size')
  } else {
    document.documentElement.setAttribute('data-font-size', fontSize)
  }
}

export function useFontSize() {
  useEffect(() => {
    if (typeof window === 'undefined') return

    applyFontSize(settingsState.value.fontSize)

    const dispose = reaction(
      () => settingsState.value.fontSize,
      (fontSize: FontSize) => {
        applyFontSize(fontSize)
      },
    )

    return () => {
      dispose()
    }
  }, [])
}
