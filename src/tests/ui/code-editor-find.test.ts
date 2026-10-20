/**
 * 代码编辑器的查找（Ctrl/Cmd+F：右上角搜索框 + 命中高亮）—— 守三件只在运行期才露的事。
 *
 * ① **必须自己引**：精简入口 `editor.api.js` 只导出 API、一个 contrib 都不带（完整入口
 *    `editor.main.js` 里那行 `import './contrib/find/…'` 才有它）。漏引不报错、不崩、构建还成功，
 *    表现只是「Ctrl+F 没反应」—— 与 codicon 字体同一类坑（§11.53 ㉞）。
 * ② **引了要生效**：contrib 是**构造编辑器时**按注册表取的，晚于构造引入无效；所以只允许在
 *    `CodeEditor` 模块顶层引（模块求值必然早于它自己的编辑器实例）。
 * ③ **浮层配色要跟主题走**：`input.*` / `editor.findMatch*` 不给自己给就落回 base 主题
 *   （vs / vs-dark）的通用灰蓝，六套主题各显各的色；且「其余命中」必须半透明 —— Monaco 把命中
 *    底色画在选区**之上**，不透明就把选区整个盖住（与差异底色同一条约束）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CODE_THEMES, buildMonacoThemeData } from '@/domain/code-display'

const EDITOR = 'src/ui/components/code-editor/CodeEditor.tsx'
const SETUP = 'src/monaco/setupMonaco.ts'
const PREVIEW = 'src/ui/components/code-preview/CodePreview.tsx'
const FIND_IMPORT = "import 'monaco-editor/editor/contrib/find/browser/findController.js'"
/** 包内真实路径（`exports` 把 `monaco-editor/editor/*.js` 重写成 `esm/vs/editor/*.js`） */
const FIND_SOURCE = 'node_modules/monaco-editor/esm/vs/editor/contrib/find/browser/findController.js'

const THEME_IDS = Object.keys(CODE_THEMES)

function parseColor(hex: string): [number, number, number, number] {
  const h = hex.slice(1)
  const at = (i: number): number => Number.parseInt(h.slice(i * 2, i * 2 + 2), 16)
  return [at(0), at(1), at(2), h.length === 8 ? at(3) : 255]
}

/** WCAG 相对亮度 */
function luminance(hex: string): number {
  const [r, g, b] = parseColor(hex)
    .slice(0, 3)
    .map((v) => v / 255)
  const lin = (c: number): number =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

function contrast(fg: string, bg: string): number {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a)
  return (hi + 0.05) / (lo + 0.05)
}

/** 两个色的单通道最大差值（「看不看得出来」的量级判断） */
function maxChannelDelta(a: string, b: string): number {
  const [ar, ag, ab] = parseColor(a)
  const [br, bg, bb] = parseColor(b)
  return Math.max(Math.abs(ar - br), Math.abs(ag - bg), Math.abs(ab - bb))
}

describe('查找控件的引入契约（精简构建不带 contrib）', () => {
  it('CodeEditor 顶层显式引了 findController（漏了 = Ctrl+F 没反应，且不报错）', () => {
    expect(readFileSync(EDITOR, 'utf8')).toContain(FIND_IMPORT)
  })

  it('这条路径在包里真实存在，且真的是「注册 FindController」的副作用模块', () => {
    expect(existsSync(FIND_SOURCE)).toBe(true)
    const src = readFileSync(FIND_SOURCE, 'utf8')
    expect(src).toContain(
      'registerEditorContribution(CommonFindController.ID',
    )
    // 无输入焦点时也要能用（Ctrl+F 落在编辑器上就开）；这两条 action 是快捷键的落点
    expect(src).toMatch(/actions\.find|StartFindAction/)
  })

  it('精简入口不带它、完整入口才有它 —— 这就是「必须自己引」的原因', () => {
    const api = readFileSync('node_modules/monaco-editor/esm/vs/editor/editor.api.js', 'utf8')
    const main = readFileSync('node_modules/monaco-editor/esm/vs/editor/editor.main.js', 'utf8')
    expect(api).not.toContain('contrib/find')
    expect(main).toContain("import './contrib/find/browser/findController.js';")
  })

  it('只在可编辑编辑器里按需引：不进 setupMonaco（否则只读预览也带上）', () => {
    expect(readFileSync(SETUP, 'utf8')).not.toContain('contrib/find')
    expect(readFileSync(PREVIEW, 'utf8')).not.toContain('contrib/find')
  })

  it('只读预览里关掉 addExtraSpaceOnTop：contrib 是全局注册的，预览也会开查找框', () => {
    // import 只在 CodeEditor 里，但 contrib 注册表不分实例 —— 预览 / 差异视图照样吃得到 Ctrl+F。
    // 它们的编辑器高度是「内容高度 / 行数 × 行高」，默认的 33px view zone 会把内容撑得比容器高。
    for (const file of [
      'src/ui/components/code-preview/CodePreview.tsx',
      'src/ui/pages/chat/components/message/MonacoDiffView.tsx',
    ]) {
      expect({ file, off: /find:\s*\{\s*addExtraSpaceOnTop:\s*false\s*\}/.test(readFileSync(file, 'utf8')) }).toMatchObject({ off: true })
    }
  })
})

describe('查找框上三个开关的悬浮气泡（被顶边切掉，直接关掉）', () => {
  const SCSS = readFileSync('src/ui/components/code-editor/style.scss', 'utf8')

  it('选择器取自 Monaco 自己的样式表（升级改名 → 这里当场红，而不是气泡又冒出来）', () => {
    const hoverCss = readFileSync(
      'node_modules/monaco-editor/esm/vs/platform/hover/browser/hover.css',
      'utf8',
    )
    expect(hoverCss).toContain('.monaco-hover.workbench-hover')
  })

  it('源头拦截：捕获阶段吞掉 .find-widget 里的 mouseover（hover 服务靠它创建气泡）', () => {
    // 气泡是从 `setupDelayedHover` 的 mouseover 里长出来的（findInputToggles → Toggle）
    expect(
      readFileSync(
        'node_modules/monaco-editor/esm/vs/base/browser/ui/toggle/toggle.js',
        'utf8',
      ),
    ).toContain('setupDelayedHover')
    const TAME = readFileSync('src/monaco/findWidget.ts', 'utf8')
    // 拦截必须：挂在编辑器容器上 + 捕获阶段 + 只吃 .find-widget 内部 + 可销毁
    expect(TAME).toMatch(
      /addEventListener\('mouseover', swallowHover, true\)/,
    )
    expect(TAME).toMatch(/closest\(WIDGET_SELECTOR\)/)
    expect(TAME).toMatch(
      /removeEventListener\('mouseover', swallowHover, true\)/,
    )
  })

  it('三处 Monaco 实例都接上：可编辑编辑器 / 只读预览 / 差异视图（contrib 是全局注册的）', () => {
    for (const file of [
      'src/ui/components/code-editor/CodeEditor.tsx',
      'src/ui/components/code-preview/CodePreview.tsx',
      'src/ui/pages/chat/components/message/MonacoDiffView.tsx',
    ]) {
      expect({ file, wired: readFileSync(file, 'utf8').includes('tameFindWidget(') }).toMatchObject({ wired: true })
    }
  })

  it('CSS 兜底：.code-editor 里的气泡一律不显示（不依赖气泡挂在哪个节点）', () => {
    expect(SCSS).toMatch(/^\.code-editor \.monaco-hover,/m)
    expect(SCSS).toMatch(/display:\s*none\s*!important/)
  })

  it('必须是**局部**关闭：全局关会把差异视图 / 其它浮层的气泡一起带走', () => {
    expect(SCSS).not.toMatch(/^\s*\.monaco-hover\s*[,{]|^\s*\.workbench-hover\s*[,{]/m)
  })
})

describe('查找浮层的主题令牌（六套主题都得跟色）', () => {
  it.each(THEME_IDS)('%s：当前命中与底色分得开（否则高亮等于没高亮）', (id) => {
    const p = CODE_THEMES[id]
    const colors = buildMonacoThemeData(p).colors
    const match = colors['editor.findMatchBackground']
    expect({ theme: id, match }).toMatchObject({
      match: expect.stringMatching(/^#[0-9a-f]{6}$/),
    })
    // 阈值 32：低于这个量级在 20px 行高里几乎看不出（实测 #515C6A 对 #282c34 差 ~44）
    expect(maxChannelDelta(match, p.bg)).toBeGreaterThanOrEqual(32)
  })

  it.each(THEME_IDS)('%s：其余命中是半透明淡橙（不盖住选区，也不等于当前命中）', (id) => {
    const colors = buildMonacoThemeData(CODE_THEMES[id]).colors
    const highlight = colors['editor.findMatchHighlightBackground']
    expect(highlight).toMatch(/^#[0-9a-f]{6}[0-9a-f]{2}$/)
    expect(parseColor(highlight)[3]).toBeLessThan(255)
    expect(highlight).not.toBe(colors['editor.findMatchBackground'])
  })

  it.each(THEME_IDS)('%s：输入框在浮层上看得出来，文字读得出来', (id) => {
    const p = CODE_THEMES[id]
    const colors = buildMonacoThemeData(p).colors
    const inputBg = colors['input.background']
    expect({ theme: id, inputBg }).toMatchObject({
      inputBg: expect.stringMatching(/^#[0-9a-f]{6}$/),
    })
    // 输入框面必须与浮层底座不同：同色时搜索框在视觉上就是一个没有边界的洞
    expect(maxChannelDelta(inputBg, colors['editorWidget.background'])).toBeGreaterThanOrEqual(8)
    expect(colors['input.foreground']).toBe(p.fg)
    expect(colors['editorWidget.foreground']).toBe(p.fg)
    // 「1 of 5」与输入内容都是正文色，压在输入框面上要过 AA
    expect({
      theme: id,
      ratio: Number(contrast(p.fg, inputBg).toFixed(2)),
      ok: contrast(p.fg, inputBg) >= 4.5,
    }).toMatchObject({ ok: true })
  })
})

