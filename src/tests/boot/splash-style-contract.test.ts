// @vitest-environment node
/**
 * 启动屏的**结构契约**（`index.html` 里那一段内联 HTML/CSS）。
 *
 * 守两件容易在后期被「顺手简化」掉的事：
 * ① 启动屏不许压住自绘标题栏 —— `#boot-splash` 必须从 `--window-top-bar-height` 下方开始。
 *    压住了 = 加载期间窗口既拖不动、也点不到最小化 / 关闭（项目里所有全屏遮罩都是这个口径）。
 * ② 标题栏与 `src/boot/splash.ts` 之间的 id / 属性约定不能断（断了按钮就静默失效）。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const HTML = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8')
const BOOT_APPEARANCE_TS = readFileSync(
  resolve(process.cwd(), 'src/ui/theme/bootAppearance.ts'),
  'utf8',
)

/** 取某个 id 选择器的样式块正文 */
function ruleBody(selector: string): string {
  const re = new RegExp(`${selector}\\s*\\{([\\s\\S]*?)\\}`)
  const m = HTML.match(re)
  return m ? m[1] : ''
}

const TOP_BAR = 'var(--window-top-bar-height, 30px)'

describe('启动屏结构契约', () => {
  it('标题栏与内容区都在 #boot-cover 里（淡出 / 移除是一个整体）', () => {
    const cover = HTML.indexOf('id="boot-cover"')
    const titlebar = HTML.indexOf('id="boot-titlebar"')
    const splash = HTML.indexOf('id="boot-splash"')
    expect(cover).toBeGreaterThan(-1)
    expect(titlebar).toBeGreaterThan(cover)
    expect(splash).toBeGreaterThan(titlebar)
  })

  it('内容区从标题栏下方开始，绝不覆盖它', () => {
    const body = ruleBody('#boot-splash')
    expect(body).toContain(`top: ${TOP_BAR}`)
    // 回归防线：inset: 0 / top: 0 会让标题栏重新被盖住
    expect(body).not.toMatch(/\binset:\s*0/)
    expect(body).not.toMatch(/\btop:\s*0\s*;/)
  })

  it('标题栏高度与 App 的 .window-top-bar 取同一个变量（否则首帧会跳一下）', () => {
    expect(ruleBody('#boot-titlebar')).toContain(`height: ${TOP_BAR}`)
  })

  it('标题栏是拖拽区，且三枚窗口按钮的 id 与 splash.ts 一致', () => {
    const titlebar = HTML.match(/<div id="boot-titlebar"[^>]*>/)?.[0] ?? ''
    expect(titlebar).toContain('data-tauri-drag-region')
    for (const id of ['boot-min', 'boot-max', 'boot-close']) {
      expect(HTML).toContain(`id="${id}"`)
    }
  })

  it('三枚按钮不参与拖拽（否则点击会被当成拖窗口）', () => {
    const controls = HTML.match(
      /<div class="boot-titlebar__controls">([\s\S]*?)<\/div>\s*<\/div>/,
    )?.[1] ?? ''
    expect(controls).not.toContain('data-tauri-drag-region')
    expect(controls).toContain('id="boot-close"')
  })
})

describe('启动屏主题色契约', () => {
  it('标题栏底色 / 前景走 CSS 变量（写死颜色 = 用户主题色到不了启动屏）', () => {
    const body = ruleBody('#boot-titlebar')
    expect(body).toContain('background: var(--boot-bar-bg)')
    expect(body).toContain('color: var(--boot-bar-fg)')
  })

  it('内联脚本读的键名与 bootAppearance.ts 的常量一字不差', () => {
    const accentKey = BOOT_APPEARANCE_TS.match(/BOOT_ACCENT_KEY = '([^']+)'/)?.[1]
    const themeKey = BOOT_APPEARANCE_TS.match(/BOOT_THEME_KEY = '([^']+)'/)?.[1]
    expect(accentKey).toBeTruthy()
    expect(themeKey).toBeTruthy()
    // 内联脚本不能 import，只能按字面量读 —— 改名漏同步会让缓存静默失效（启动屏退回默认色）
    expect(HTML).toContain(`localStorage.getItem('${accentKey}')`)
    expect(HTML).toContain(`localStorage.getItem('${themeKey}')`)
  })

  it('暗色档标题栏不直接拿品牌原色（系数同 theme.scss 的 $accent-mix-dark-bar-primary）', () => {
    expect(HTML).toContain('color-mix(in srgb, var(--boot-accent) 45%, #000)')
  })
})
