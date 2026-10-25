// @vitest-environment node
/**
 * 后台服务徽标 · 深色终端头部配色契约。
 *
 * 这三条都是「编译不报错、只在界面上一眼才看出来」的：
 * ① `.service-status` 落在深色头部时必须走 `is-on-dark` 变体 —— 浅色面那套的描边是
 *    `--border-color`（浅色主题 #e5e5e5），压在深色头部上就是一圈发白描边，正是「配色很怪」的成因；
 * ② 变体要覆盖全部四种状态语义（running / exited·killed / failed / pending）：漏一个就退回浅色面配色，
 *    而「运行中」恰好是最常出现的那一个；
 * ③ `.terminal-sandbox-badge` 不能只嵌在 `.execute-command-wrapper` 下 —— 服务终端头部不在它里面，
 *    那一路会退化成裸文字（组件测试只断言 DOM，看不出有没有样式）。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as sass from 'sass'

const SCSS = 'src/ui/pages/chat/components/tool-call/style.scss'
// 编译产物要去掉注释：dart-sass 保留 loud 注释，注释会粘在选择器前面
const css = sass
  .compileString(readFileSync(resolve(process.cwd(), SCSS), 'utf8'))
  .css.replace(/\/\*[\s\S]*?\*\//g, '')

/** 编译产物是平铺的（嵌套已展开）：按选择器抠出同一个块 */
function blockOf(selector: string): string | undefined {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1]
}

describe('后台服务徽标 · 深色终端头部', () => {
  it('深色变体自带描边与底色，不走浅色主题的 --border-color', () => {
    const block = blockOf('.service-status.is-on-dark')
    expect(block).toBeTruthy()
    expect(block).not.toContain('var(--border-color')
    expect(block).toContain('rgba(255, 255, 255, 0.14)')
  })

  it('四种状态语义都有一套深色配色（漏一个就退回浅色面）', () => {
    for (const state of ['is-running', 'is-failed', 'is-pending']) {
      const block = blockOf(`.service-status.is-on-dark.${state}`)
      expect(block, state).toBeTruthy()
      expect(block).toContain('color:')
      expect(block).toContain('background:')
    }
    // exited / killed 共用一条选择器组
    expect(css).toContain('.service-status.is-on-dark.is-exited')
    expect(css).toContain('.service-status.is-on-dark.is-killed')
  })

  it('沙盒徽标在服务终端头部也有样式（不是裸文字）', () => {
    expect(css).toContain('.service-console-head .terminal-sandbox-badge')
  })
})
