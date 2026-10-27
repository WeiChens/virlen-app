// @vitest-environment node
/**
 * 会话列表「分组折叠 / 展开」的过渡动画。
 *
 * 守三条用户能直接看到 / 摸到的承诺：
 *  1. **收起也把内容挂着**：以前是 `{!isCollapsed && (…)}`，一收起 DOM 就没了 —— 没有高度
 *     就没有起点，任何动画都无从谈起；而且「展示全部」与滚动位置会跟着一起重来；
 *  2. **高度未知也要能过渡**：`height: auto` 不参与过渡，`max-height` 那套必须猜一个值
 *     （猜小了裁内容、猜大了先快后慢），所以走 `grid-template-rows: 1fr ↔ 0fr`
 *     （外层网格 + 内层 `min-height: 0` + `overflow: hidden`，缺一条 0fr 就收不成 0）；
 *  3. **收起的行不许还能被摸到**：内容既然挂着，收起态就必须 `inert` ——
 *     否则 Tab 键会走进看不见的会话行，「展示全部」也还能被键盘点到、被读屏念出来。
 *
 * 口径同 `sidebar-panel-badge.test.ts`：源码断言 + 编译后的样式断言，不在 jsdom 里拖起整个侧栏
 *（目录树 / 技能列表 / RAG 服务全要真后端）。动画本身（时长 / 中途高度）不在这里量。
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

/** 取编译后某条选择器的声明体（Sass 已把嵌套摊平，块里不会再有花括号） */
function blockOf(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`${escaped} \\{([^}]*)\\}`).exec(css)?.[1] ?? ''
}

describe('分组折叠 / 展开的过渡', () => {
  it('组内会话一直挂着（收起不再卸载 DOM）', () => {
    expect(src).toContain(
      "className={`session-group-body${isCollapsed ? ' is-collapsed' : ''}`}",
    )
    expect(src).toContain('<div className="session-group-items">')
    // 反向断言：内容不能再包回「没折叠才渲染」的条件里（那样就没有可过渡的高度）
    expect(src).not.toMatch(/\{!isCollapsed && \(\s*<div className="session-group-items">/)
  })

  it('收起态挂 inert：挂着但看不见的行不能进 Tab 序列 / 被读屏念', () => {
    expect(src).toMatch(
      /<div\s+className=\{`session-group-body[\s\S]{0,80}?inert=\{isCollapsed\}>/,
    )
  })

  it('外层是网格容器：`1fr` 起点 + 行轨过渡（250ms），收起收到 `0fr`', () => {
    const open = blockOf('.session-group-body')
    expect(open, '.session-group-body 缺 display: grid').toContain('display: grid')
    expect(open, '展开态必须是 grid-template-rows: 1fr（终点）').toContain(
      'grid-template-rows: 1fr',
    )
    expect(open, '没有过渡就只是瞬间跳变').toContain(
      'transition: grid-template-rows 0.25s',
    )
    // 被否决的那条路留在门内：猜一个 max-height 值，猜小了裁内容、猜大了先快后慢
    expect(open).not.toContain('max-height')

    const collapsed = blockOf('.session-group-body.is-collapsed')
    expect(collapsed, '收起态必须是 grid-template-rows: 0fr（起点）').toContain(
      'grid-template-rows: 0fr',
    )
  })

  it('内层 `min-height: 0` + 裁切：少一条 0fr 就收不成 0', () => {
    const inner = blockOf('.session-group-body > .session-group-items')
    expect(inner, '网格项默认 min-height: auto，不归零 0fr 收不到 0').toContain(
      'min-height: 0',
    )
    expect(inner, '不裁切的话 0 高度的轨道仍会把内容画在下面').toContain('overflow: hidden')
  })

  it('列表跟着淡入淡出（只收高度的话文字是被削掉一半的）', () => {
    const inner = blockOf('.session-group-body > .session-group-items')
    expect(inner, '展开态透明度是 1').toContain('opacity: 1')
    expect(inner, 'fade 要与高度同一个时长，否则两边错拍').toContain(
      'transition: opacity 0.25s',
    )

    const collapsedInner = blockOf('.session-group-body.is-collapsed > .session-group-items')
    expect(collapsedInner, '收起态透明度要到 0').toContain('opacity: 0')
  })
})
