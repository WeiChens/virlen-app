/**
 * 侧边栏会话项 / 折叠分组头的「在忙 · 等你回答」状态槽。
 *
 * 守两条用户可见的承诺：
 *  1. 两枚提示**不会同时亮**：引擎等你作答时 run 仍算在忙，并排既挤又互相拆台
 *     （一枚说「在跑」、一枚说「卡住」）。槽里只放一枚，**等你回答优先**；
 *  2. 分组折叠时也能看见「等你回答」：否则组里挂着的交互完全隐形（会话内卡片不弹窗，
 *     这是别的会话唯一的提示）。
 *
 * 优先级判定抽成纯函数 `statusFlagKind` 单测；「哪里渲染」用源码断言（jsdom 里挂整个侧边栏
 * 要拖起工作目录树 / 技能列表，成本远大于收益，口径同 `inline-interactions-placement.test.ts`）。
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as sass from 'sass'
import { statusFlagKind } from '@/ui/pages/chat/components/sidebar/session-status'

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

describe('侧边栏状态槽：同一时刻只亮一枚，等你回答优先', () => {
  it('两枚都不成立时才不显示；同时在忙又在等 → 只显示「等你回答」', () => {
    expect(statusFlagKind(false, false)).toBeNull()
    expect(statusFlagKind(false, true)).toBe('busy')
    expect(statusFlagKind(true, false)).toBe('waiting')
    expect(statusFlagKind(true, true)).toBe('waiting')
  })

  it('会话项只挂一个状态槽组件（不再并排渲染两枚点）', () => {
    expect(src).toContain('<SessionStatusFlag sessionId={session.id} />')
    // 反向断言：会话项里不该再有裸的 working-indicator / waiting-interaction-indicator
    const titleWrapper = /<div className="session-title-wrapper">[\s\S]*?<\/div>\s*\)/.exec(src)?.[0]
    expect(titleWrapper).toBeTruthy()
    expect(titleWrapper).not.toContain('working-indicator')
    expect(titleWrapper).not.toContain('waiting-interaction-indicator')
  })

  it('折叠分组头也挂状态槽（折叠时组内的「等你回答」才看得见）', () => {
    expect(src).toContain('{isCollapsed && <GroupStatusFlag sessions={group.sessions} />}')
  })

  it('两枚点与固定槽宽定义在 `.session-list` 级：会话项与分组头共用一份', () => {
    // 固定 14px 槽：两枚宽度不同（7px / 14px），不固定会把标题 / 组名推来推去
    expect(css).toMatch(/\.chat-sidebar \.session-list \.session-flag \{[^}]*width: 14px/)
    for (const cls of ['waiting-interaction-indicator', 'working-indicator']) {
      expect(css, `${cls} 不在 .session-list 级，分组头吃不到`).toContain(
        `.chat-sidebar .session-list .${cls} {`,
      )
    }
    // 动画仍在（删掉会变成两个静止的点，反而看不出「在忙」）
    expect(css).toContain('@keyframes dotPulse')
    expect(css).toContain('@keyframes ringRipple')
  })
})
