import { useEffect } from 'react'
import { reaction } from 'mobx'
import { settingsState } from '@/ui/store/settingStore'
import {
  ACCENT_PRESETS,
  accentStyleText,
  normalizeHex,
} from '@/ui/theme/accentPalette'

/**
 * 覆盖样式表的元素 id：同一个元素反复改内容，避免每次改色都往 <head> 里堆一份。
 * 只有「色板之外的任意色」才需要它 —— 预设与默认档都靠 theme.scss 的静态块。
 */
const STYLE_ID = 'virlen-accent-color'

/** 预设色走的那条路：theme.scss 里 `[data-accent='<name>']` 的整套令牌是构建期算死的 */
const ACCENT_ATTR = 'data-accent'

function ensureStyleElement(): HTMLStyleElement {
  const existing = document.getElementById(STYLE_ID)
  if (existing instanceof HTMLStyleElement) return existing
  const el = document.createElement('style')
  el.id = STYLE_ID
  document.head.appendChild(el)
  return el
}

/**
 * 把主题色落到页面上。两条路（对应 theme.scss 文件头的 ① 与 ③）：
 *
 *  · 默认档（`''`）与**预设色板** → 只切 `<html data-accent>`：整套令牌是构建期算好的静态块，
 *    零计算、零样式注入，首帧也不用等 JS；删掉属性即回落到内置靛蓝。
 *  · 色板之外的**任意色** → 只有运行期才知道：清掉 `data-accent`（否则静态块与注入值会打架）
 *    并注入一份覆盖样式（`--brand` + 亮 / 暗两档令牌）。
 *
 * 设置页的取色器**拖动预览**也直接调它（不等 store 落库），所以这个入口必须幂等、可重复调用。
 */
export function applyAccentColor(color: string): void {
  if (typeof document === 'undefined') return
  const hex = normalizeHex(color)
  const preset = hex ? ACCENT_PRESETS.find((p) => p.color === hex) : undefined

  const root = document.documentElement
  if (preset) root.setAttribute(ACCENT_ATTR, preset.name)
  else root.removeAttribute(ACCENT_ATTR)

  const existing = document.getElementById(STYLE_ID)
  if (!hex || preset) {
    existing?.remove()
    return
  }
  ensureStyleElement().textContent = accentStyleText(hex)
}

/**
 * 监听「设置 → 通用 → 主题色」并把它落到 `<html>`（与 useTheme / useFontSize 同一套写法）。
 *
 * 注入时亮 / 暗两档一起写：`<style>` 里是两条 `:root[data-theme=…]` 规则，
 * 所以切主题不需要重算，也不会有「先套旧色再纠正」的一帧闪烁。
 */
export function useAccentColor() {
  useEffect(() => {
    if (typeof window === 'undefined') return

    applyAccentColor(settingsState.value.accentColor)

    const dispose = reaction(
      () => settingsState.value.accentColor,
      (color: string) => {
        applyAccentColor(color)
      },
    )

    return () => {
      dispose()
    }
  }, [])
}
