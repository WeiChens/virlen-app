/**
 * 源代码管理面板 · 样式契约（两条都是**实测反馈**里暴露出来的，且编译期不会报）。
 *
 * ① **小按钮的样式必须挂在顶层**：变更行里的那颗在 `.git-row` 内，段标题里的「全部暂存」不在 ——
 *    把 `.git-row-btn` 写进 `.git-row` 作用域，段标题那颗就掉回浏览器默认按钮样式
 *    （方角、被系统主题撑大、hover 没反馈）。
 * ② **引用的主题令牌必须真实存在**：`var(--x, #fallback)` 在 `--x` 从未定义时 fallback 永远生效，
 *    暗色主题照的还是亮色档 —— 实测踩过：`--success-color` / `--warning-color` / `--danger-color`
 *    三个名字全项目都没有定义（亮色档的绿 #16a34a 在深底上几乎不可读）。
 *
 * 与 `scss-compile-contract.test.ts` 分工：那份保证「能编译」，这份保证「编译出来的东西真的落到元素上」。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as sass from 'sass'

const PANEL_SCSS = 'src/ui/pages/chat/components/git/style.scss'
const THEME_SCSS = 'src/ui/styles/theme.scss'

function readProjectFile(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), 'utf8')
}

// 编译产物要去掉注释：dart-sass 保留 loud 注释，而注释会粘在选择器前面，把选择器提取带歪
const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '')

const panelSrc = readProjectFile(PANEL_SCSS)
const panelCss = stripComments(sass.compileString(panelSrc).css)
const themeCss = stripComments(sass.compileString(readProjectFile(THEME_SCSS)).css)

/** 编译产物里的选择器清单（sass 把嵌套摊平，一条规则一个 `{`）；内部换行/缩进归一成单空格，
    否则多选择器规则（`.a,\n.b {`）对不上文本 */
function selectors(css: string): string[] {
  return [...css.matchAll(/([^{}]+)\{/g)].map((m) =>
    m[1].trim().replace(/\s+/g, ' '),
  )
}

describe('源代码管理 · 面板样式契约', () => {
  it('小按钮的样式挂在顶层 —— 段标题里的「全部…」也拿得到', () => {
    // 存在一条**选择器就是它自己**的规则；嵌在 .git-row 里就不可能有
    expect(selectors(panelCss)).toContain('.git-row-btn')
    // 段标题那颗另有文字形态（宽度自适应、hover 才显形）；虚拟列表后标题是扁平条目，hover 判定落在它自己身上
    expect(panelCss).toMatch(/\.git-section-title\s+\.git-row-btn\s*\{/)
    expect(panelCss).toMatch(/\.git-section-title:hover[^{]*\.git-row-btn/)
    // 状态字母同理：变更行与差异弹窗左侧清单共用一个顶层规则（写进 .git-row 弹窗那份就没色了）
    expect(selectors(panelCss)).toContain('.git-row-letter')
    expect(selectors(panelCss)).toContain('.git-row-letter.s-\\?')
    // 文件类型图标也共用一个顶层规则（列表行与弹窗清单两处渲染）
    expect(selectors(panelCss)).toContain('.git-row-icon, .git-diff-side-icon')
    // 主按钮同理：同一个类名会在不同语境下渲染（曾经是提交区 + 空态「初始化仓库」），
    // 写进 `.git-commit` 作用域里，另一处就掉回浏览器默认按钮（方角、系统色）—— 实测踩过
    expect(selectors(panelCss)).toContain('.git-primary-btn')
  })

  it('变更行的固定行高与 GitPanel 的 ROW_H 一致，且容得下行内按钮', () => {
    // 行高是虚拟列表的前缀和与「现在在第几行」的唯一依据；也靠它保证 22px 的行内按钮不被裁
    const panelSrc = readProjectFile('src/ui/pages/chat/components/git/GitPanel.tsx')
    const rowH = Number(/const ROW_H = (\d+)/.exec(panelSrc)?.[1])
    expect(rowH).toBeGreaterThanOrEqual(24)
    const rule = /\.git-list \.git-row\s*\{([^}]*)\}/.exec(panelCss)?.[1]
    expect(rule).toBeTruthy()
    expect(rule).toContain(`height: ${rowH}px`)
  })

  it('两段变更列表横着排（竖向空间不够就向横向要）', () => {
    const box = /\.git-list-box\s*\{([^}]*)\}/.exec(panelCss)?.[1]
    expect(box).toBeTruthy()
    expect(box).toContain('flex-direction: row')
    // 两列等宽：`min-width: 0` 防止长路径把某一列撑宽
    const section = /\.git-section\s*\{([^}]*)\}/.exec(panelCss)?.[1]
    expect(section).toBeTruthy()
    expect(section).toContain('min-width: 0')
  })

  it('差异弹窗的遮罩从自绘标题栏下方开始（不压住窗口状态栏）', () => {
    // 压住状态栏 = 拖窗口 / 点窗口按钮在弹窗开着时失效（与全局 Modal / 搜索弹窗同一口径）
    const backdrop = /\.git-diff-backdrop\s*\{([^}]*)\}/.exec(panelCss)?.[1]
    expect(backdrop).toBeTruthy()
    expect(backdrop).toContain('top: var(--window-top-bar-height')
    expect(backdrop).not.toContain('inset: 0')
  })

  it('git 弹窗的层级低于全局确认框（删除贮藏的确认框不能被盖住）', () => {
    // 实测反馈：点「删除」后确认框看不见 —— git 弹窗遮罩原先 1400，而全局 `.modal-overlay` 是 1300。
    // 确认框（MessageBox）用的是全局 Modal，所以 git 弹窗必须压在它下面。
    const backdrop = /\.git-diff-backdrop\s*\{([^}]*)\}/.exec(panelCss)?.[1]
    const z = Number(/z-index:\s*(\d+)/.exec(backdrop ?? '')?.[1])
    const modalScss = stripComments(
      readProjectFile('src/ui/components/shared/Modal/style.scss'),
    )
    const modalRule = /\.modal-overlay\s*\{([^}]*)\}/.exec(modalScss)?.[1]
    const modalZ = Number(/z-index:\s*(\d+)/.exec(modalRule ?? '')?.[1])
    expect(z).toBeGreaterThan(1200) // 高于用量抽屉（1200）：弹窗不能被抽屉压住
    expect(z).toBeLessThan(modalZ) // 低于全局 Modal：确认框必须压在上面
  })

  it('面板引用的每个主题令牌都在 theme.scss 里真实定义（否则 fallback 永远生效）', () => {
    const defined = new Set(
      [...themeCss.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]),
    )
    const used = [...panelSrc.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1])
    expect(used.length).toBeGreaterThan(0)
    expect([...new Set(used)].filter((name) => !defined.has(name))).toEqual([])
  })
})
