/**
 * 会话内待应答卡片（`inline-interactions/style.scss`）的**字号跟随**契约。
 *
 * 缺陷背景：「设置 → 字体大小」切小 / 中 / 大，靠的是 `<html data-font-size>` 覆盖
 * `ui/styles/theme.scss` 里的 `--font-size-*`（见 hooks/useFontSize.ts）。也就是说
 * **样式里只要写了 px 字号，那处就永远不跟着变** —— 卡片原来整份都是 11 / 12 / 11.5px，
 * 用户调到「大」时别的界面都变大了，只有这几张卡纹丝不动。
 *
 * 同类缺陷（`shared-font-size-contract.test.ts` 已记录）：`line-height` 写 px 会被继承成固定值、
 * 承字的盒子（折叠箭头方框 / 勾选圆点 / 按钮最小高）写死 px —— 字号一大就把字裁掉。
 *
 * jsdom 不加载 scss，组件测试看不见这些；所以用 `sass.compileString` 编译真实样式再断言
 * （口径同 `memory-settings-style-contract.test.ts`）。
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as sass from 'sass'

const STYLE = 'src/ui/pages/chat/components/inline-interactions/style.scss'

function readProjectFile(rel: string): string {
  const p = resolve(process.cwd(), rel)
  if (!existsSync(p)) {
    throw new Error(
      `本用例需要以 virlen-app 为工作目录运行：找不到 ${rel}（当前 cwd = ${process.cwd()}）`,
    )
  }
  return readFileSync(p, 'utf8')
}

/** 剥注释：文件头里引用了旧写法（`12px 字`），不剥会被下面的扫描当成违规 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const source = stripComments(readProjectFile(STYLE))
const css = sass.compileString(readProjectFile(STYLE)).css.replace(/@charset\s+"[^"]*";/g, '')
const themeTokens = new Set(
  [...stripComments(readProjectFile('src/ui/styles/theme.scss')).matchAll(/(--font-size-[\w-]+)\s*:/g)].map(
    (m) => m[1],
  ),
)

/** 取「选择器列表里恰好含有该选择器」的规则体里某声明的值（后写的覆盖先写的） */
function decl(selector: string, prop: string): string | undefined {
  let value: string | undefined
  for (const rule of stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = rule[1].split(',').map((s) => s.replace(/\s+/g, ' ').trim())
    if (!selectors.includes(selector)) continue
    for (const part of rule[2].split(';')) {
      const i = part.indexOf(':')
      if (i < 0) continue
      if (part.slice(0, i).trim() === prop) value = part.slice(i + 1).trim()
    }
  }
  return value
}

describe('会话内卡片 —— 字号跟随「设置 → 字体大小」', () => {
  it('前置：样式真的编译出来了（否则下面的断言会因「空产物」假通过）', () => {
    expect(css.length).toBeGreaterThan(500)
    expect(themeTokens.size).toBeGreaterThanOrEqual(10)
  })

  it('没有任何 px 字号，全部是 --font-size-* 令牌', () => {
    const offenders: string[] = []
    for (const m of source.matchAll(/font-size\s*:\s*([^;{}]+)/g)) {
      const value = m[1].trim()
      if (!/^var\(--font-size-[\w-]+\)$/.test(value)) offenders.push(`font-size: ${value}`)
    }
    expect(offenders).toEqual([])
  })

  it('`var(--font-size-*)` 不带 px 兜底（兜底值与令牌实际值早晚漂移）', () => {
    expect(source).not.toMatch(/var\(--font-size-[\w-]+\s*,/)
  })

  it('用到的令牌都在主题里定义（防幽灵令牌静默降级成继承字号）', () => {
    const used = new Set([...source.matchAll(/var\((--font-size-[\w-]+)/g)].map((m) => m[1]))
    expect(used.size).toBeGreaterThan(2)
    expect([...used].filter((v) => !themeTokens.has(v))).toEqual([])
  })

  it('行高用相对值（写 px 会被继承成固定值，大字号下裁字）', () => {
    const offenders: string[] = []
    for (const m of source.matchAll(/line-height\s*:\s*([^;{}]+)/g)) {
      const value = m[1].trim()
      if (!/^[\d.]+$/.test(value)) offenders.push(`line-height: ${value}`)
    }
    expect(offenders).toEqual([])
  })

  it('各段字号落到正确的档位（正文 sm / 辅助与徽标 xs / 图形记号 2xs）', () => {
    const expected: [string, string][] = [
      ['.inline-interactions-count', 'var(--font-size-xs)'],
      ['.inline-interaction-badge', 'var(--font-size-xs)'],
      ['.inline-interaction-summary', 'var(--font-size-sm)'],
      ['.inline-interaction-perm', 'var(--font-size-xs)'],
      ['.inline-interaction-toggle', 'var(--font-size-2xs)'],
      ['.inline-interaction-question', 'var(--font-size-sm)'],
      ['.inline-interaction-option', 'var(--font-size-sm)'],
      ['.inline-interaction-mark', 'var(--font-size-2xs)'],
      ['.inline-interaction-input', 'var(--font-size-sm)'],
      ['.inline-interaction-btn', 'var(--font-size-sm)'],
      ['.inline-auth-note', 'var(--font-size-sm)'],
      ['.inline-auth-hint', 'var(--font-size-xs)'],
      ['.inline-auth-code-head', 'var(--font-size-xs)'],
      ['.inline-auth-code-cmd', 'var(--font-size-xs)'],
    ]
    for (const [selector, value] of expected) {
      expect(decl(selector, 'font-size'), selector).toBe(value)
    }
  })

  it('承字的盒子用 em 挂在自身字号上（字号变大只撑高、不裁字）', () => {
    const expected: [string, string, string][] = [
      // 折叠箭头方框 = 1.8em × 2xs（medium 18px）
      ['.inline-interaction-toggle', 'width', '1.8em'],
      ['.inline-interaction-toggle', 'height', '1.8em'],
      // 勾选圆点 = 1.3em × 2xs（medium 13px）
      ['.inline-interaction-mark', 'width', '1.3em'],
      ['.inline-interaction-mark', 'height', '1.3em'],
      // 按钮最小高 = 1.85em × sm（medium ≈ 22px）
      ['.inline-interaction-btn', 'min-height', '1.85em'],
    ]
    for (const [selector, prop, value] of expected) {
      expect(decl(selector, prop), `${selector} { ${prop} }`).toBe(value)
    }
  })
})
