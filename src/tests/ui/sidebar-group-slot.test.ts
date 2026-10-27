// @vitest-environment node
/**
 * 分组头左侧那 14px 是**一格两用**：平时画分组类型图标（文件夹 / 智能体），
 * hover 分组头时换成折叠箭头。
 *
 * 为什么值得单独钉一条：这是「省宽度」的常见手法，但三个地方改回去就静默失效——
 *  1. **必须真的共用一格**：两枚都留在平级 + `gap: 6px`，宽度就一分没省
 *     （14 + 6 + 14 = 34px → 一个 14px 槽位）；
 *  2. **叠放不能靠 `display` 切换**：`display: none ↔ block` 会把过渡整段跳过，看起来是硬闪；
 *     只能同格叠两层（`grid-area: 1 / 1`）+ 各自的 `opacity`；
 *  3. **归档降调要加在那一格上**：`archived` 原本写的是 `.group-icon, .group-toggle { opacity: .55 }`，
 *     叠放规则（更具体）会把它整条盖掉 —— 表现是「归档的分组跟别的一样亮」。
 *
 * 口径同 `sidebar-panel-badge.test.ts`：源码断言 + 编译后的样式断言，不拖起整个侧栏。
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as sass from 'sass'

function readProjectFile(rel: string): string {
  const p = resolve(process.cwd(), rel)
  if (!existsSync(p)) {
    throw new Error(
      `本用例需要以 virlen-app 为工作目录运行：找不到 ${rel}（当前 cwd = ${process.cwd()}）`,
    )
  }
  return readFileSync(p, 'utf8')
}

const SIDEBAR = 'src/ui/pages/chat/components/sidebar/index.tsx'
const STYLE = 'src/ui/pages/chat/components/sidebar/style.scss'

const src = readProjectFile(SIDEBAR)
const css = sass.compileString(readProjectFile(STYLE)).css

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 取「选择器以 suffix 结尾」的那条规则的声明体（Sass 展开输出：选择器一行 + 声明逐行） */
function declOf(suffix: string): string {
  return new RegExp(`[^\\n{}]*${escapeRe(suffix)} \\{([^}]*)\\}`).exec(css)?.[1] ?? ''
}

/** 取所有以 suffix 结尾且选择器**不含** exclude 的规则（用于躲开 `.group-slot .group-toggle` 这类同名尾巴） */
function declsOf(suffix: string, exclude: string): string[] {
  const re = new RegExp(`[^\\n{}]*${escapeRe(suffix)} \\{([^}]*)\\}`, 'g')
  return [...css.matchAll(re)]
    .filter((m) => !m[0].slice(0, m[0].lastIndexOf(' {')).includes(exclude))
    .map((m) => m[1])
}

describe('分组头图标 / 折叠箭头共用一格', () => {
  it('两枚都在同一个 `.group-slot` 里（不是平级 + gap）', () => {
    const slot = src.indexOf('<span className="group-slot">')
    const toggle = src.indexOf('className={`group-toggle ${isCollapsed')
    const icon = src.indexOf('<FolderSvg className="group-icon" />')
    const slotClose = src.indexOf('</span>', icon)
    expect(slot).toBeGreaterThan(-1)
    expect(toggle).toBeGreaterThan(slot)
    expect(icon).toBeGreaterThan(toggle)
    expect(slotClose).toBeGreaterThan(icon)
    // 箭头不能落在槽位外面（平级写法就是「宽度没省」）
    expect(src.indexOf('<DropDownSvg')).toBeGreaterThan(slot)
  })

  it('槽位：14px 见方 + 居中，两个子元素落在同一网格格', () => {
    const slot = declOf('.group-slot')
    expect(slot).toContain('display: grid')
    expect(slot).toContain('place-items: center')
    expect(slot).toContain('width: 14px')
    expect(slot).toContain('height: 14px')
    expect(declOf('.group-slot > *')).toMatch(/grid-area: 1\s*\/\s*1/)
  })

  it('默认画图标、hover 换箭头（靠 opacity，不用 display 切换）', () => {
    expect(declOf('.group-slot .group-icon')).toContain('opacity: 1')
    expect(declOf('.group-slot .group-toggle')).toContain('opacity: 0')

    expect(declOf(':hover .group-slot .group-icon')).toContain('opacity: 0')
    expect(declOf(':hover .group-slot .group-toggle')).toContain('opacity: 1')

    // 反向断言：`display` 切换会把透明度过渡整段跳过
    expect(css).not.toMatch(/\.group-slot[^{]*\{[^}]*display: none/)
  })

  it('展开的分组常显箭头（收起的分组才回落到类型图标）', () => {
    // 类由状态驱动：展开 = `is-expanded`，不是另存一份 state
    expect(src).toContain("${isCollapsed ? '' : ' is-expanded'}")
    expect(declOf('.is-expanded .group-slot .group-icon')).toContain('opacity: 0')
    expect(declOf('.is-expanded .group-slot .group-toggle')).toContain('opacity: 1')
  })

  it('折叠态方向仍由 `.group-toggle.collapsed` 旋转表达', () => {
    expect(declOf('.group-toggle.collapsed')).toContain('rotate(-90deg)')
    // 基规则里旋转与透明度各一份时长：只写 `transform` 会让 hover 淡入淡出变成硬闪
    const [base = ''] = declsOf('.group-toggle', 'group-slot')
    expect(base).toContain('transform 0.2s ease')
    expect(base).toContain('opacity 0.12s ease')
  })

  it('归档降调加在槽位上（加在子元素上会被叠放规则盖掉）', () => {
    expect(declOf('.archived .group-slot')).toContain('opacity: 0.55')
    expect(css).not.toMatch(/\.session-group-header\.archived \.group-(icon|toggle)/)
  })
})
