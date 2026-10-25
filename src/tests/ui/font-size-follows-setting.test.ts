// @vitest-environment node
/**
 * 全 `src/ui` 的「字号跟随用户设置」契约（`<html data-font-size>` → `--font-size-*`）。
 *
 * `shared-font-size-contract.test.ts` 只守 `components/shared`，其余页面长期失守：
 * 本次收敛了 42 个文件里的 168 处 px 字号 + 205 处 `var(--font-size-x, Npx)` 兜底。
 * 这条用例把口径扩到整棵 `src/ui`，防止新代码再把 px 写回去。
 *
 * 只做文本扫描（不编译 sass）：结论与取值形态一一对应，跑得快，改样式即报。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const UI_DIR = 'src/ui'

/** 令牌定义处本身就是字面 px（`--font-size-*` 与 `--code-font-size`），不受本契约约束 */
const EXEMPT_FILES = new Set(['src/ui/styles/theme.scss'])

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (/\.(scss|css)$/.test(name)) out.push(relative(process.cwd(), p).replace(/\\/g, '/'))
  }
  return out
}

/** 去掉注释：文档里引用旧写法（`font-size: 12px`）不该算违规 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/** 从选择器首次出现处截到配对的 `}`，用于取整块规则（内含嵌套规则） */
function blockOf(src: string, idx: number): string {
  const start = src.indexOf('{', idx)
  if (start < 0) return ''
  let depth = 0
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(idx, i + 1)
  }
  return src.slice(idx)
}

const files = walk(UI_DIR)
const sources = new Map(
  files.map((f) => [f, stripComments(readFileSync(f, 'utf8'))] as const),
)

describe('全量 UI 样式 —— 字号必须跟随「设置 → 字体大小」', () => {
  it('前置：扫描确实覆盖到了样式文件（否则下面的空数组断言是假通过）', () => {
    expect(files.length).toBeGreaterThan(50)
  })

  it('没有硬编码 px / rem / pt 字号（em 与 % 相对父级字号，允许）', () => {
    const offenders: string[] = []
    for (const [file, src] of sources) {
      if (EXEMPT_FILES.has(file)) continue
      for (const m of src.matchAll(/font-size\s*:\s*([^;{}]+)/g)) {
        const value = m[1].trim()
        // 带绝对单位、且没有通过 var(--font-size-*) 接到令牌上（calc 里引用令牌是合法写法）
        if (/\d(px|rem|pt)\b/.test(value) && !/var\(--font-size-/.test(value)) {
          offenders.push(`${file}: font-size: ${value}`)
        }
        // 裸数字（无单位）同样是写死的
        else if (/^\d+(\.\d+)?$/.test(value)) {
          offenders.push(`${file}: font-size: ${value}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('`var(--font-size-*)` 不再带兜底（兜底不跟主题走，实际已漂移：xs 兜底写过 12/13px）', () => {
    const offenders: string[] = []
    for (const [file, src] of sources) {
      for (const m of src.matchAll(/var\(\s*--font-size-[\w-]+\s*,[^)]*\)/g)) {
        offenders.push(`${file}: ${m[0]}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('用到的字号令牌都在 theme.scss 里定义（防幽灵令牌静默降级成 16px 默认值）', () => {
    const theme = sources.get('src/ui/styles/theme.scss') ?? ''
    const defined = new Set([...theme.matchAll(/(--font-size-[\w-]+)\s*:/g)].map((m) => m[1]))
    expect(defined.size).toBeGreaterThanOrEqual(10)

    const used = new Set<string>()
    for (const src of sources.values()) {
      for (const m of src.matchAll(/var\(\s*(--font-size-[\w-]+)/g)) used.add(m[1])
    }
    expect(used.size).toBeGreaterThan(5)
    expect([...used].filter((name) => !defined.has(name))).toEqual([])
  })

  it('徽标（`*-badge` / `&__badge`）的尺寸挂在自身字号上，不写死 px', () => {
    // 角标写死高度后，字号调大一档就把数字裁了（git / service / todo / image / toolbar 五处曾如此）；
    // padding / 圆角同理：不跟随的话，字号变大时标签会显得又扁又挤。
    // `border` 与 `top/right` 偏移不在此列：1px 描边缩放会发虚，偏移是定位而非尺寸。
    const BANNED = ['height', 'min-height', 'min-width', 'line-height', 'padding']
    const offenders: string[] = []
    let blocks = 0
    for (const [file, src] of sources) {
      for (const m of src.matchAll(/^[^/\n]*[-_]badge\s*\{/gm)) {
        blocks++
        const line = src.slice(0, m.index).split('\n').length
        for (const decl of blockOf(src, m.index).matchAll(/(?:^|[;{\s])([a-z-]+)\s*:\s*([^;{}]+)/g)) {
          const [, prop, value] = decl
          if (!BANNED.some((p) => prop === p || prop.startsWith(`${p}-`))) continue
          if (/\d(px|rem|pt)\b/.test(value)) offenders.push(`${file}:${line} ${prop}: ${value.trim()}`)
        }
      }
    }
    // 前置：确实扫到了这么多徽标（否则「没违规」只是因为没扫到）
    expect(blocks).toBeGreaterThanOrEqual(20)
    expect(offenders).toEqual([])
  })
})
