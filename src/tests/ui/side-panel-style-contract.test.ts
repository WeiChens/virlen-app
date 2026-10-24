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
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as sass from 'sass'

const PANEL_SCSS = 'src/ui/pages/chat/components/side-panel/style.scss'
const FILE_PANEL_SCSS = 'src/ui/pages/chat/components/workspace-file/style.scss'
const CHAT_VIEW_SCSS = 'src/ui/pages/chat/chat-view.scss'
const THEME_SCSS = 'src/ui/styles/theme.scss'

function readProjectFile(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), 'utf8')
}

// 编译产物要去掉注释：dart-sass 保留 loud 注释，注释会粘在选择器前面
const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '')

const panelSrc = readProjectFile(PANEL_SCSS)
const panelCss = stripComments(sass.compileString(panelSrc).css)
const filePanelCss = stripComments(sass.compileString(readProjectFile(FILE_PANEL_SCSS)).css)
const themeCss = stripComments(sass.compileString(readProjectFile(THEME_SCSS)).css)
const chatViewCss = stripComments(sass.compileString(readProjectFile(CHAT_VIEW_SCSS)).css)

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

  it('占满态的手柄盖过左侧栏拖拽条，且面板永远贴右（否则拖不回来）', () => {
    // 左侧栏拖拽条的层级与命中区（`::after` 左右各 3px）写在 chat-view.scss
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
})
