/**
 * 右侧面板容器 · 样式契约（都是编译期不会报、只在界面上出问题的几条）。
 *
 * ① **非激活的标签内容必须真的不显示**：容器靠 `hidden` 属性切标签，一旦 `.side-panel-pane[hidden]`
 *    这条规则没了（或被 `display: flex` 压掉），所有打开的文件会同时挤在一块里 ——
 *    jsdom 不做布局，这个缺陷在 DOM 断言里看不见（元素在、hidden 也在，只是画出来了）。
 * ② **宽度 / 拖拽归容器**：`.workspace-file-panel` 曾经自带 `max-width: 72vw` 与左边框（单面板时代），
 *    挪进容器后如果再长回来，就会出现「两层宽度上限」，拖到一半被内层截住。
 * ③ **主题令牌必须真实存在**：写错名字的 `var(--x)` 不报错，只是永远走 fallback，暗色主题下不走眼。
 * ④ **标签栏滚动条必须跟主题**：写了 `scrollbar-width` 就会让 `::-webkit-scrollbar-thumb` 失效，
 *    暗色主题下冒出浅色滚动条。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as sass from 'sass'

const PANEL_SCSS = 'src/ui/pages/chat/components/side-panel/style.scss'
const FILE_PANEL_SCSS = 'src/ui/pages/chat/components/workspace-file/style.scss'
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

describe('右侧面板容器 · 样式契约', () => {
  it('非激活标签的内容真的不显示（切标签靠它，不靠卸载）', () => {
    const rule = /\.side-panel-pane\[hidden\]\s*\{([^}]*)\}/.exec(panelCss)?.[1]
    expect(rule).toBeTruthy()
    expect(rule).toContain('display: none')

    // 内容区本身是 flex 列（`[hidden]` 那条要靠它才压得住）
    const pane = /\.side-panel-pane\s*\{([^}]*)\}/.exec(panelCss)?.[1]
    expect(pane).toContain('display: flex')
  })

  it('宽度上限只留在容器上，文件面板自己不再带（否则两层上限互相截断）', () => {
    const container = /\.side-panel\s*\{([^}]*)\}/.exec(panelCss)?.[1]
    expect(container).toBeTruthy()
    expect(container).toContain('max-width: 72vw')

    const filePanel = /\.workspace-file-panel\s*\{([^}]*)\}/.exec(filePanelCss)?.[1]
    expect(filePanel).toBeTruthy()
    expect(filePanel).not.toContain('max-width')
    expect(filePanel).not.toContain('border-left')
    // 内容区要自己撑满容器给的那块
    expect(filePanel).toContain('height: 100%')
    expect(filePanel).toContain('width: 100%')
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
})
