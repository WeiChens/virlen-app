// @vitest-environment node
/**
 * 右侧面板容器 · 样式契约（都是编译期不会报、只在界面上出问题的几条）。
 *
 * ① **非激活的标签内容必须真的不显示**：容器靠 `hidden` 属性切标签，一旦 `.side-panel-pane[hidden]`
 *    这条规则没了（或被 `display: flex` 压掉），所有打开的文件会同时挤在一块里 ——
 *    jsdom 不做布局，这个缺陷在 DOM 断言里看不见（元素在、hidden 也在，只是画出来了）。
 * ② **宽度归容器且不设固定上限**：`.workspace-file-panel` 曾经自带 `max-width: 72vw` 与左边框（单面板时代），
 *    挪进容器后如果再长回来，就会出现「两层宽度上限」，拖到一半被内层截住。
 *    容器自己的 72vw / 960 也已拿掉：拖宽的上限就是「聊天区 + 面板」的可用宽度。
 * ③ **主题令牌必须真实存在**：写错名字的 `var(--x)` 不报错，只是永远走 fallback，暗色主题下不走眼。
 * ④ **标签栏滚动条必须跟主题**：写了 `scrollbar-width` 就会让 `::-webkit-scrollbar-thumb` 失效，
 *    暗色主题下冒出浅色滚动条。
 * ⑤ **占满态的手柄要盖过左侧栏的拖拽条**：面板铺满时它的左缘正好压在 `.sidebar-resizer` 上，
 *    层级不够就收不到 mousedown —— 看着是「拖不动」，其实拖的是左侧栏（面板再也回不来）。
 * ⑥ **拖动期间 iframe 不能参与命中**：HTML 预览是独立文档，指针跨进去以后 document 上的
 *    mousemove / mouseup 就收不到了（向右拖 = 指针进面板），拖动会断在半路。
 * ⑦ **显隐过渡的时长就是 `PANEL_MOTION_MS = 200`**：短了面板会在半路被摘掉（跳一下），
 *    长了会让「关掉了却还在」的窗口变宽；拖动时又必须关掉过渡（否则手柄黏手）。
 *    容器现在**常驻挂载**（收起只是 `is-collapsed`），不再有「等过渡跑完再卸载」那套定时器，
 *    所以这个数只写在样式表里 —— 改它只影响观感，不影响任何卸载时机。
 * ⑧ **标签的强调层级：激活 > 悬停 > 常态**（两档主题都要成立）。这一条写在 CSS 里就守不住：
 *    旧写法（激活 `--bg-primary` / 悬停 `--hover-bg`）在亮色下两者都是 1.07:1（看不出选中），
 *    暗色下悬停 1.40:1 反而比激活的 1.07:1 更亮 —— 看上去「划过的像选中」。
 *    现在两者都是 theme-agnostic 的薄涂（悬停 = 文字色 7%，激活 = 品牌色 20%），
 *    这里把两档主题的实际对比度算出来钉住。
 * ⑨ **预览位标签的斜体要真的斜**：`font-style: italic` 在本项目完全无效（界面字体
 *    `AlimamaAgileVF-Thin` 没有 italic 字面，`App.css` 的 `:root { font-synthesis: none }
 *    又关掉了合成斜体；`font-synthesis-style: auto` 与 `@font-face { font-style: oblique … }`
 *    也都实测不出斜体）。字体自带的 `slnt` 轴能出**真斜体**，但只改拉丁字形 —— 中文文件名的
 *    标签一点不斜。所以这里用**几何倾斜**（`transform: skewX`），中英文与字体回退全都盖到。
 * ⑩ **过渡期的消息列表宽度钉在终值**（`chat-freeze.ts`）：变量名 / 读取点 / 摘锁时长是一对
 *    跨文件契约，对不上就是「钉不住」或「提前放开」，而两者都是零报错。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as sass from 'sass'

import { contrastRatio, normalizeHex } from '@/ui/theme/accentPalette'

const PANEL_SCSS = 'src/ui/pages/chat/components/side-panel/style.scss'
const FILE_PANEL_SCSS = 'src/ui/pages/chat/components/workspace-file/style.scss'
const BROWSER_SCSS = 'src/ui/pages/chat/components/side-panel/browser/style.scss'
const CONSOLE_SCSS = 'src/ui/pages/chat/components/service/style.scss'
const TABS_SCSS = 'src/ui/pages/chat/components/tabs/style.scss'
const CHAT_VIEW_SCSS = 'src/ui/pages/chat/chat-view.scss'
const MESSAGE_LIST_SCSS = 'src/ui/pages/chat/components/message/message-list.scss'
const THEME_SCSS = 'src/ui/styles/theme.scss'

function readProjectFile(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), 'utf8')
}

// 编译产物要去掉注释：dart-sass 保留 loud 注释，注释会粘在选择器前面
const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '')

const panelSrc = readProjectFile(PANEL_SCSS)
const panelCss = stripComments(sass.compileString(panelSrc).css)
const filePanelCss = stripComments(sass.compileString(readProjectFile(FILE_PANEL_SCSS)).css)
const browserCss = stripComments(sass.compileString(readProjectFile(BROWSER_SCSS)).css)
const consoleCss = stripComments(sass.compileString(readProjectFile(CONSOLE_SCSS)).css)
const tabsCss = stripComments(sass.compileString(readProjectFile(TABS_SCSS)).css)
const themeCss = stripComments(sass.compileString(readProjectFile(THEME_SCSS)).css)
const chatViewCss = stripComments(sass.compileString(readProjectFile(CHAT_VIEW_SCSS)).css)

/** `#rrggbb` → 对比度计算要的 RGB（与 `accent-color-contract` 同一口径） */
function rgbOf(hex: string) {
  const h = normalizeHex(hex)
  if (!h) throw new Error(`不是合法颜色：${hex}`)
  return {
    r: Number.parseInt(h.slice(1, 3), 16),
    g: Number.parseInt(h.slice(3, 5), 16),
    b: Number.parseInt(h.slice(5, 7), 16),
  }
}

/** 取某一条选择器所在规则体里的全部令牌（sass 编译会把属性选择器的引号去掉，两边都去） */
function themeTokens(selector: string): Record<string, string> {
  const want = selector.replace(/['"]/g, '')
  const out: Record<string, string> = {}
  for (const rule of themeCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = rule[1]
      .split(',')
      .map((s) => s.replace(/\s+/g, ' ').trim().replace(/['"]/g, ''))
    if (!selectors.includes(want)) continue
    for (const part of rule[2].split(';')) {
      const i = part.indexOf(':')
      if (i < 0) continue
      out[part.slice(0, i).trim()] = part.slice(i + 1).trim()
    }
  }
  if (Object.keys(out).length === 0) throw new Error(`theme.scss 里找不到 ${selector}`)
  return out
}

/** theme.scss 里 `--x: <value>;` 的原始值 */
function tokenValue(name: string): string {
  const m = new RegExp(`\\n\\s*${name}\\s*:\\s*([^;]+);`).exec(themeCss)
  if (!m) throw new Error(`theme.scss 里找不到 ${name}`)
  return m[1].trim()
}

/**
 * `calc(var(--a) + var(--b))` → 像素数（只支持 `px` 与加法：布局尺寸令牌就这几种写法）。
 * 用它钉住「两侧算出来是同一个数」，而不是把 41 / 27 / 68 写死在断言里。
 */
function resolveLen(expr: string, depth = 0): number {
  if (depth > 4) throw new Error(`令牌循环引用：${expr}`)
  const expanded = expr.replace(/var\((--[a-z0-9-]+)\)/g, (_, name: string) =>
    `${resolveLen(tokenValue(name), depth + 1)}px`,
  )
  return expanded
    .replace(/calc\(/g, '')
    .replace(/\)/g, '')
    .split('+')
    .map((part) => {
      const px = /(-?\d+(?:\.\d+)?)px/.exec(part)
      if (!px) throw new Error(`不认识的尺寸：${part}`)
      return Number(px[1])
    })
    .reduce((a, b) => a + b, 0)
}

/** `color-mix(in srgb, <fg> p%, transparent)` 叠在 <bg> 上 = 逐通道线性混合（同浏览器） */
function over(fg: string, bg: string, p: number): string {
  const f = rgbOf(fg)
  const b = rgbOf(bg)
  const ch = (x: number, y: number) =>
    Math.round(x * p + y * (1 - p))
      .toString(16)
      .padStart(2, '0')
  return `#${ch(f.r, b.r)}${ch(f.g, b.g)}${ch(f.b, b.b)}`
}

describe('右侧面板容器 · 样式契约', () => {
  it('非激活标签的内容真的不显示（切标签靠它，不靠卸载）', () => {
    const rule = /\.side-panel-pane\[hidden\]\s*\{([^}]*)\}/.exec(panelCss)?.[1]
    expect(rule).toBeTruthy()
    expect(rule).toContain('display: none')

    // 内容区本身是 flex 列（`[hidden]` 那条要靠它才压得住）
    const pane = /\.side-panel-pane\s*\{([^}]*)\}/.exec(panelCss)?.[1]
    expect(pane).toContain('display: flex')
  })

  it('宽度只由容器决定，且不设固定上限（上限 = 「聊天区 + 面板」的可用宽度）', () => {
    const container = /\.side-panel\s*\{([^}]*)\}/.exec(panelCss)?.[1]
    expect(container).toBeTruthy()
    // 别把 72vw / 960 这类固定上限写回来：宽度的上限只在拖拽逻辑里（`maxDragWidth`）
    expect(container).not.toContain('max-width')
    expect(container).toContain('flex: none')

    const filePanel = /\.workspace-file-panel\s*\{([^}]*)\}/.exec(filePanelCss)?.[1]
    expect(filePanel).toBeTruthy()
    expect(filePanel).not.toContain('max-width')
    expect(filePanel).not.toContain('border-left')
    // 内容区要自己撑满容器给的那块
    expect(filePanel).toContain('height: 100%')
    expect(filePanel).toContain('width: 100%')
  })

  it('标签可拖拽：标签上不选中文字，被拖的那个有 is-dragging 态', () => {
    const tab = /\.side-panel-tab\s*\{([^}]*)\}/.exec(panelCss)?.[1]
    expect(tab).toBeTruthy()
    expect(tab).toContain('user-select: none')
    expect(panelCss).toMatch(/\.side-panel-tab\.is-dragging\s*\{/)
  })

  /**
   * 预览位（临时标签）靠斜体告知「下一个文件会顶掉我」。
   * ⚠️ 这里钉的是「斜体真的画得出来」：
   * - `font-style: italic` 在本项目完全无效（字体无 italic 字面 + `App.css` 关掉了合成斜体）；
   * - 字体自带的 `slnt` 轴只能斜拉丁字形，中文文件名（`说明.md`）一个像素都不斜；
   * 所以只能用几何倾斜，而且它必须同时中英文都盖到（不靠字体）。
   */
  it('预览位标签的斜体要真的斜（几何倾斜，不靠字体 / 不靠 font-style）', () => {
    const rule = /\.side-panel-tab\.is-preview \.side-panel-tab-name\s*\{([^}]*)\}/.exec(
      panelCss,
    )?.[1]
    expect(rule, '预览位斜体规则').toBeTruthy()
    expect(rule).toMatch(/transform:\s*skewX\(-\d+(?:\.\d+)?deg\)/)
    // flex 子项已经块级化，但这一步别被后人删掉（换回 inline 元素就没有 transform 了）
    expect(rule).toContain('display: inline-block')
    // `font-style: italic` / `font-variation-settings` 在这套字体下都不靠谱（见上），别再写回去
    expect(rule).not.toContain('font-style')
    expect(rule).not.toContain('font-variation-settings')
  })

  it('标签栏滚动条跟主题：走 --scrollbar-thumb，且不出现 scrollbar-width', () => {
    // ⚠️ 标准属性一出现，Chromium 就忽略下面的 ::-webkit-scrollbar-*，暗色主题下滚动条回退成浅色
    const tabs = /\.side-panel-tabs\s*\{([^}]*)\}/.exec(panelCss)?.[1]
    expect(tabs).toBeTruthy()
    expect(tabs).not.toContain('scrollbar-width')

    const thumb = /\.side-panel-tabs::-webkit-scrollbar-thumb\s*\{([^}]*)\}/.exec(panelCss)?.[1]
    expect(thumb).toBeTruthy()
    expect(thumb).toContain('var(--scrollbar-thumb')
    // 细条：与标签栏 30px 的高度相称
    const bar = /\.side-panel-tabs::-webkit-scrollbar\s*\{([^}]*)\}/.exec(panelCss)?.[1]
    expect(bar).toContain('height: 4px')
  })

  it('容器引用的每个主题令牌都在 theme.scss 里真实定义（否则 fallback 永远生效）', () => {
    const defined = new Set([...themeCss.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]))
    const used = [...panelSrc.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1])
    expect(used.length).toBeGreaterThan(0)
    expect([...new Set(used)].filter((name) => !defined.has(name))).toEqual([])
  })

  it('拖动期间 iframe 不参与命中（否则 HTML 预览里拖不动）', () => {
    const resizing = /\.side-panel\.is-resizing\s*\{([^}]*)\}/.exec(panelCss)?.[1]
    expect(resizing).toBeTruthy()
    expect(resizing).toContain('user-select: none')

    // 嵌套规则编译后展开成 `.side-panel.is-resizing iframe`
    const frame = /\.side-panel\.is-resizing iframe\s*\{([^}]*)\}/.exec(panelCss)?.[1]
    expect(frame).toBeTruthy()
    expect(frame).toContain('pointer-events: none')
  })

  it('占满态的手柄盖过左侧栏拖拽条，且面板永远贴右（否则拖不回来）', () => {    // 左侧栏拖拽条的层级与命中区（`::after` 左右各 3px）写在 chat-view.scss
    const sidebarRule = /\.sidebar-resizer\s*\{([^}]*)\}/.exec(chatViewCss)?.[1]
    expect(sidebarRule).toBeTruthy()
    const sidebarZ = Number(/z-index:\s*(\d+)/.exec(sidebarRule!)?.[1])
    expect(Number.isFinite(sidebarZ)).toBe(true)

    const fullHandle = /\.side-panel\.is-full\s+\.side-panel-resizer\s*\{([^}]*)\}/.exec(
      panelCss,
    )?.[1]
    expect(fullHandle).toBeTruthy()
    expect(Number(/z-index:\s*(\d+)/.exec(fullHandle!)?.[1])).toBeGreaterThan(sidebarZ)

    // 占满态下聊天区是 display:none：面板不贴右就会从左铺、往右缩，手柄停在原地
    expect(/\.side-panel\s*\{([^}]*)\}/.exec(panelCss)?.[1]).toContain('margin-left: auto')
  })

  it('标签栏 + 各页自己的 header = 聊天区 header 高度（两侧内容从同一条线开始）', () => {
    // 面板两行（标签栏 36 + 页头 37）= 73 = .chat-header（工具栏 40 + 视图 tab 条 32 + 底线 1）
    const panelRows = resolveLen(
      'calc(var(--side-panel-tabbar-h) + var(--side-panel-head-h))',
    )
    const chatHeader = resolveLen(
      'calc(var(--chat-toolbar-h) + var(--chat-view-tabs-h) + 1px)',
    )
    expect(panelRows).toBe(chatHeader)

    // 工具栏与标签栏引用同一份令牌，否则「同高」只是巧合
    expect(/\.chat-toolbar\s*\{([^}]*)\}/.exec(chatViewCss)?.[1]).toContain(
      'height: var(--chat-toolbar-h)',
    )

    // 每个标签页自己的 header 都必须吃 `--side-panel-head-h`：
    // 谁写死一套上下 padding，那个标签的底线就比聊天区错开。
    // （文件树那一行是个 28px 的搜索胶囊居中，所以它吃令牌的方式是外边距的 calc）
    for (const [label, css, selector, why] of [
      ['工作区文件', filePanelCss, '\\.wfp-head', 'height: var(--side-panel-head-h'],
      ['浏览器', browserCss, '\\.browser-bar', 'height: var(--side-panel-head-h'],
      [
        '终端（服务 / 用户）',
        consoleCss,
        '\\.service-console-head',
        'height: var(--side-panel-head-h',
      ],
      [
        '工作区文件树（搜索框）',
        panelCss,
        '\\.side-panel-files \\.sidebar-search',
        'margin: calc((var(--side-panel-head-h',
      ],
    ] as const) {
      const rule = new RegExp(`${selector}\\s*\\{([^}]*)\\}`).exec(css)?.[1]
      expect(rule, `${label} 的 header 规则`).toBeTruthy()
      expect(rule, `${label} 的 header 要占满两行算式里的那一行`).toContain(why)
    }
  })

  it('`.chat-view-tabs` 的实际高度 = `--chat-view-tabs-h`（否则上面那条等式只是纸上的）', () => {
    const wrap = /\.chat-view-tabs\s*\{([^}]*)\}/.exec(tabsCss)?.[1]
    const tab = /\.chat-view-tab\s*\{([^}]*)\}/.exec(tabsCss)?.[1]
    expect(wrap).toBeTruthy()
    expect(tab).toBeTruthy()

    const marginTop = Number(/(?:^|[;\s])margin-top:\s*(\d+(?:\.\d+)?)px/.exec(wrap!)?.[1])
    const lineHeight = Number(/line-height:\s*(\d+(?:\.\d+)?)px/.exec(tab!)?.[1])
    // 展开 padding 简写：`4px 15px 10px` = 上 / 左右 / 下；未写出的值按 CSS 规则回落
    const padShorthand = /(?:^|[;\s])padding:\s*([^;]+);/.exec(tab!)?.[1].trim().split(/\s+/)
    expect(padShorthand).toBeTruthy()
    const px = (v: string | undefined) => Number((v ?? '0').replace(/px$/, ''))
    const padTop = px(padShorthand![0])
    const padBottom = px(padShorthand![2] ?? padShorthand![0])
    expect(marginTop + padTop + lineHeight + padBottom).toBe(
      resolveLen('var(--chat-view-tabs-h)'),
    )
  })

  it('显隐过渡：收起时宽度归 0，时长 200ms，拖动时不过渡', () => {
    const container = /\.side-panel\s*\{([^}]*)\}/.exec(panelCss)?.[1]
    expect(container).toBeTruthy()
    expect(container).toContain('transition:')

    // 面板常驻挂载：收起 / 展开只靠这一个过渡，没有 JS 定时器陪着一起改
    const widthMs = Number(/width\s+(\d+)ms/.exec(container!)?.[1])
    expect(widthMs).toBe(200)

    // 收起：“!important” 压过内联宽度；裁剪 + 不接指针，内容不能溢出来抢聊天区
    const collapsed = /\.side-panel\.is-collapsed\s*\{([^}]*)\}/.exec(panelCss)?.[1]
    expect(collapsed).toBeTruthy()
    expect(collapsed).toContain('width: 0 !important')
    expect(collapsed).toContain('overflow: hidden')
    expect(collapsed).toContain('pointer-events: none')

    // 拖动时不能有过渡（拖一像素等 200ms，手柄会黏手）
    expect(/\.side-panel\.is-resizing\s*\{([^}]*)\}/.exec(panelCss)?.[1]).toContain(
      'transition: none',
    )
  })

  /**
   * ⑩ **过渡期钉宽是一对跨文件契约**：`chat-freeze.ts` 把消息列表宽度钉在终值（否则面板一动，
   *    消息列表每帧折行 = 抖 + 掉帧）。三处一旦对不上都是零报错、只在界面上出问题：
   *    变量名写错 → 读不到、钉不住；读取点丢了 `var()` → 白写；摘锁时长与样式表不一致 →
   *    提前放开（最后几帧又折行）或拖得太久（内容卡在固定宽度）。
   */
  it('过渡期钉宽：变量名 / 读取点 / 摘锁时长三处对得上', () => {
    const freezeSrc = readProjectFile('src/ui/pages/chat/components/side-panel/chat-freeze.ts')
    const listCss = stripComments(sass.compileString(readProjectFile(MESSAGE_LIST_SCSS)).css)

    const varName = /CHAT_FREEZE_VAR = '(--[a-z-]+)'/.exec(freezeSrc)?.[1]
    expect(varName, 'chat-freeze.ts 里的变量名').toBeTruthy()

    const container = /\.chat-messages-container\s*\{([^}]*)\}/.exec(listCss)?.[1]
    expect(container, '消息列表容器规则').toBeTruthy()
    expect(container, '宽度要读 chat-freeze.ts 写的那条变量，缺省回到自适应').toContain(
      `width: var(${varName}, auto)`,
    )

    // 挂在 `.chat-main` 上：变量只往下流进消息列表，面板里的树 / 终端不受牵连
    expect(freezeSrc).toContain('main.style.setProperty(CHAT_FREEZE_VAR')

    const freezeMs = Number(/PANEL_WIDTH_MOTION_MS = (\d+)/.exec(freezeSrc)?.[1])
    const panelWidthMs = Number(
      /width\s+(\d+)ms/.exec(/\.side-panel\s*\{([^}]*)\}/.exec(panelCss)?.[1] ?? '')?.[1],
    )
    expect(freezeMs).toBe(panelWidthMs)
  })

  it('标签的强调层级：激活 > 悬停 > 常态，两档主题都成立', () => {
    const hoverRule = /\.side-panel-tab:hover:not\(\.is-active\)\s*\{([^}]*)\}/.exec(panelCss)?.[1]
    const activeRule = /\.side-panel-tab\.is-active\s*\{([^}]*)\}/.exec(panelCss)?.[1]
    expect(hoverRule, '悬停态规则').toBeTruthy()
    expect(activeRule, '激活态规则').toBeTruthy()

    // 不要退回这两档：它们的对比度取决于标签栏底色（亮 #fff / #f7f7f8 拉不开＝看不出选中；
    // 暗 #313244 / #181825 亮过激活态＝悬停像选中）。见 style.scss 里那段注记。
    expect(hoverRule).not.toContain('var(--hover-bg')
    expect(activeRule).not.toContain('--bg-primary')

    /** 规则里那一行 `color-mix(in srgb, var(--x) N%, transparent)` 的 N% */
    const pct = (rule: string, token: string): number => {
      const re = new RegExp(`color-mix\\(in srgb, var\\(--${token}\\) (\\d+)%, transparent\\)`)
      const m = re.exec(rule)
      expect(m, `规则里要有 var(--${token}) 的薄涂`).toBeTruthy()
      return Number(m![1]) / 100
    }
    const hoverPct = pct(hoverRule!, 'text-primary')
    const activePct = pct(activeRule!, 'primary')

    const ratio = (a: string, b: string) => contrastRatio(rgbOf(a), rgbOf(b))
    for (const [theme, selector] of [
      ['亮色', '[data-theme=light]'],
      ['暗色', '[data-theme=dark]'],
    ] as const) {
      const tokens = themeTokens(selector)
      const bar = tokens['--bg-secondary']
      const text = tokens['--text-primary']
      const primary = tokens['--primary']

      const activeBg = over(primary, bar, activePct)
      const hoverBg = over(text, bar, hoverPct)
      const active = ratio(activeBg, bar)
      const hover = ratio(hoverBg, bar)

      expect(active, `${theme}：激活底 ${activeBg} 对标签栏底 ${bar}`).toBeGreaterThan(1.2)
      expect(hover, `${theme}：悬停底 ${hoverBg} 对标签栏底 ${bar}`).toBeGreaterThan(1.08)
      expect(active, `${theme}：激活必须比悬停更强（否则划过的像选中）`).toBeGreaterThan(hover)
      // 激活底上的字仍要过 AA（12px 小字）：所以文字用 --text-primary，不能用 --primary
      expect(
        ratio(text, activeBg),
        `${theme}：激活标签文字对薄涂底（不能用 --primary，暗色只有 3.75:1）`,
      ).toBeGreaterThanOrEqual(4.5)
    }
  })
})
