/**
 * pending-switcher（待应答交互切换条）样式契约 —— 它是「弹窗之外、层级最高」的一层，
 * 四条约束里任何一条写错都很难在开发时发现（只有真机并发时才看得见）：
 *
 *  · 位置：必须让开自绘标题栏（拖拽区 / 窗口按钮会点不动），也得让开底部输入框；
 *  · 层级：低于弹窗（1000）就被弹窗盖住 —— 而它存在的唯一意义就是「别的弹窗还在等你」；
 *  · 配色：当前项写死白字 → 用户把主题色调浅后字就糊了（须走 `--primary-fg` 自动转黑）；
 *  · 摘要：不省略会把整条撑到屏幕外，把右侧的切换项挤没。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as sass from 'sass'

const SCSS =
  'src/ui/pages/chat/components/modals/pending-switcher.scss'

function readProjectFile(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), 'utf8')
}

const css = sass
  .compileString(readProjectFile(SCSS))
  // 去掉 @charset（不剥掉的话会被并进首条选择器，导致主规则匹配不上）与注释
  .css.replace(/@charset\s+"[^"]*";/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')

/** 取某条规则（完整选择器精确匹配）里的属性值；没有返回 undefined */
function decl(selector: string, prop: string): string | undefined {
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1]
      .split(',')
      .map((s) => s.replace(/\s+/g, ' ').trim())
    if (!selectors.includes(selector)) continue
    for (const part of m[2].split(';')) {
      const i = part.indexOf(':')
      if (i < 0) continue
      if (part.slice(0, i).trim() === prop) return part.slice(i + 1).trim()
    }
  }
  return undefined
}

describe('pending-switcher：位置与层级', () => {
  it('固定在自绘标题栏下方居中（不压标题栏 / 输入框）', () => {
    expect(decl('.pending-switcher', 'position')).toBe('fixed')
    expect(decl('.pending-switcher', 'top')).toBe(
      'calc(var(--window-top-bar-height, 30px) + 10px)',
    )
    expect(decl('.pending-switcher', 'left')).toBe('50%')
    expect(decl('.pending-switcher', 'transform')).toBe('translateX(-50%)')
  })

  it('z-index 高于弹窗（1000）—— 否则被弹窗盖住，等于没有提示', () => {
    const z = Number(decl('.pending-switcher', 'z-index'))
    expect(Number.isFinite(z)).toBe(true)
    expect(z).toBeGreaterThan(1000)
  })

  it('出现动画的 transform 带上居中位移（否则动画期间条会跑到屏幕右侧）', () => {
    const from = css.match(/@keyframes pendingSwitcherIn[\s\S]*?\{[\s\S]*?\}/)?.[0] ?? ''
    expect(from).toContain('translate(-50%,')
  })
})

describe('pending-switcher：配色与文字行为', () => {
  it('当前项用品牌底 + --primary-fg（浅色主题色下自动转黑字，不写死白字）', () => {
    const active = '.pending-switcher__item.is-active'
    expect(decl(active, 'background')).toContain('var(--accent-color')
    expect(decl(active, 'color')).toBe('var(--primary-fg)')
    // 条上任何地方都不准出现写死的白字
    expect(readProjectFile(SCSS)).not.toMatch(/color:\s*(#fff\b|#ffffff\b|white\b)/)
  })

  it('未读点用主题的告警色（不硬编码颜色）', () => {
    const dot = css.match(
      /\.pending-switcher__item\.is-unread::after\s*\{([^}]*)\}/,
    )
    expect(dot, '未读点规则没编译出来').not.toBeNull()
    expect(dot![1]).toContain('var(--accent-warn')
    expect(dot![1]).toContain('border-radius: 50%')
  })

  it('摘要只占一行、超出省略（否则长问题会把其它切换项挤出视野）', () => {
    const label = '.pending-switcher__label'
    expect(decl(label, 'white-space')).toBe('nowrap')
    expect(decl(label, 'text-overflow')).toBe('ellipsis')
    expect(decl(label, 'overflow')).toBe('hidden')
  })
})
