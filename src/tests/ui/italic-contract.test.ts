// @vitest-environment node
/**
 * 「斜体」契约：本项目里最容易静默失效的一条样式。
 *
 * 背景（实测，无头 Chrome 截图逐条比对过）：界面字体 `AlimamaAgileVF-Thin` **没有 italic
 * 字面**，而 `src/ui/App.css` 的 `:root { font-synthesis: none }` 又把浏览器的合成斜体关了 ——
 * 于是 `font-style: italic` 在本项目里**一点变化都没有**（编译通过、类也挂上了，纯静默）。
 * markdown 的 `*斜体*` / `_斜体_` 就这样一直没斜。
 *
 * 能真的斜起来要三条一起写（少一条都会在某些字形上看不出变化）：
 * 1. `font-style: italic` —— 有真 italic 字面的字体（Consolas 等）靠它选字面；
 * 2. `font-synthesis-style: auto` —— 只在这一层把合成开回来（中文走系统回退字体，靠它合成）；
 * 3. `font-variation-settings: 'slnt' N` —— 这款变量字体自带 slnt 轴（0→12），给轴值才是
 *    **真斜体字形**（单层 a、更窄）；只写这条的话中文不斜，只写前两条的话拉丁是合成斜体。
 *
 * ⚠️ 这三条同时写不会叠成双重斜体（实测）。所以别把其中任何一条当“兜底”删掉。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as sass from 'sass'

const read = (rel: string): string => readFileSync(resolve(process.cwd(), rel), 'utf8')
/** 编译产物里的注释会粘在选择器前面：比对前先去掉 */
const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '')

const appCss = stripComments(read('src/ui/App.css'))
const markdownCss = stripComments(
  sass.compileString(read('src/ui/pages/chat/components/message/markdown-renderer.scss')).css,
)

/** 一段规则体里必须同时有那三条（`slnt` 的值不写死具体角度，0~12 之间都算） */
function expectRealItalic(rule: string | undefined, label: string): void {
  expect(rule, `${label}：规则不存在`).toBeTruthy()
  expect(rule, `${label}：要有 font-style: italic（选真字面）`).toContain('font-style: italic')
  expect(rule, `${label}：要把合成斜体只在这一层开回来`).toContain(
    'font-synthesis-style: auto',
  )
  expect(
    rule,
    `${label}：要有 font-variation-settings 的 slnt 轴（这款字体唯一的真斜体入口）`,
  ).toMatch(/font-variation-settings:\s*['"]slnt['"]\s*(?:1[0-2]|[1-9])(?:\.\d+)?/)
}

describe('斜体契约', () => {
  it('全局语义标签 em / i / cite 三条齐全', () => {
    expectRealItalic(/em,\s*i,\s*cite\s*\{([^}]*)\}/.exec(appCss)?.[1], 'App.css 的 em/i/cite')
  })

  it('markdown 引用块（整块斜体）三条齐全', () => {
    expectRealItalic(
      /\.markdown-renderer \.md-blockquote\s*\{([^}]*)\}/.exec(markdownCss)?.[1],
      'markdown 的 .md-blockquote',
    )
  })

  it('markdown 的 em 不自己再写一份斜体（口径只在 App.css 那一处）', () => {
    // 重复两处迟早会漏改一处：markdown 里只留注释指向 App.css
    expect(markdownCss).not.toMatch(/\.markdown-renderer em\s*\{[^}]*font-style/)
  })
})
