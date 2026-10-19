/**
 * 差异底色的两条不变式（实测反馈：「在改动行里选中文本，看不到选中效果」）。
 *
 * ⚠️ 这里守的不是配色好看，是**层序上的硬约束**：Monaco 把选区画在改动底色**下面**
 * （0.56 `view.js`：`.lines-content` 先 append 选区所在的 `contentViewOverlays`、再 append 承载改动
 * 底色的 `viewLines`，两者都 z-auto → DOM 序就是绘制序），所以**改动底色一旦回到不透明，选区就会被
 * 整个盖住** —— 而这一点只会在「在改动行里选中文本」这一步被看见：编译期、tsc、别的用例都发现不了。
 *
 * 因此：六个差异底色必须是**半透明源色**（`#RRGGBBAA`），且「源色 over 底下那层」要仍等于设计色
 * —— 也就是**观感没变**，变的只是「底下那一层能透出来」。
 *
 * 改造后色源搬到 `src/domain/code-display`（纯 TS，不引 monaco 运行时），所以这里可以直接 import
 * 主题数据，不再靠读 `setupMonaco.ts` 的源码文本。
 */
import { describe, expect, it } from 'vitest'
import {
  CODE_FONT_STACKS,
  CODE_THEMES,
  buildCodeCssVars,
  buildMonacoThemeData,
} from '@/domain/code-display'

/** 默认主题（Monaco 与 DOM 两套界面的共同基准） */
const PALETTE = CODE_THEMES['virlen-dark']
const THEME = buildMonacoThemeData(PALETTE)

/** 设计色（不透明）——「源色 + 底下那层」合成后应当得到的那一档 */
const DESIGN = {
  oldLine: '#2a1515',
  newLine: '#152a15',
  oldNum: '#3a2020',
  newNum: '#203a20',
  oldChar: '#5c2626',
  // 字符级绿底比原设计（#265c2a）更暗：那个亮度上注释只有 1.31:1（实测反馈「完全看不出字」）
  newChar: '#1c3d20',
} as const

type Rgb = [number, number, number]
type Rgba = [number, number, number, number]

function parseColor(hex: string): Rgba {
  const h = hex.slice(1)
  const at = (i: number): number =>
    Number.parseInt(h.slice(i * 2, i * 2 + 2), 16)
  return [at(0), at(1), at(2), h.length === 8 ? at(3) / 255 : 1]
}

/** CSS 的合成口径：out = α × 上层 + (1 − α) × 底下那层 */
function over([r, g, b, a]: Rgba, [br, bg, bb]: Rgb): Rgb {
  return [
    Math.round(a * r + (1 - a) * br),
    Math.round(a * g + (1 - a) * bg),
    Math.round(a * b + (1 - a) * bb),
  ]
}

/** 主题里的一个色值（用例与主题漂了就给可读错误，而不是 undefined 引发的玄学失败） */
function colorOf(key: string): string {
  const value = THEME.colors[key]
  if (!value) throw new Error(`主题里找不到 '${key}'（先看 domain/code-display/themes.ts）`)
  return value
}

/** 主题 rules 里某个 token 的前景色（rules 里的值**不带** `#`，取出来补上） */
function tokenColorOf(token: string): string {
  const rule = THEME.rules.find((r) => r.token === token)
  if (!rule?.foreground) {
    throw new Error(`主题 rules 里找不到 token '${token}'`)
  }
  return `#${rule.foreground}`
}

/** WCAG 相对亮度（对比度用） */
function luminance(hex: string): number {
  const [r, g, b] = parseColor(hex)
    .slice(0, 3)
    .map((v) => v / 255)
  const lin = (c: number): number =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** WCAG 对比度 */
function contrast(fg: string, bg: string): number {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a)
  return (hi + 0.05) / (lo + 0.05)
}

const rgb = (hex: string): Rgb => parseColor(hex).slice(0, 3) as Rgb
/** 正文底 / 行号栏底：差异底色就叠在它们上面（改它们就必须重算源色） */
const editorBg = rgb(colorOf('editor.background'))
const gutterBg = rgb(colorOf('editorGutter.background'))

const CASES: { key: string; design: string; backdrop: Rgb; where: string }[] = [
  { key: 'diffEditor.insertedLineBackground', design: DESIGN.newLine, backdrop: editorBg, where: '正文底' },
  { key: 'diffEditor.removedLineBackground', design: DESIGN.oldLine, backdrop: editorBg, where: '正文底' },
  {
    key: 'diffEditor.insertedTextBackground',
    design: DESIGN.newChar,
    backdrop: rgb(DESIGN.newLine),
    where: '自己那一行的行底色',
  },
  {
    key: 'diffEditor.removedTextBackground',
    design: DESIGN.oldChar,
    backdrop: rgb(DESIGN.oldLine),
    where: '自己那一行的行底色',
  },
  {
    key: 'diffEditorGutter.insertedLineBackground',
    design: DESIGN.newNum,
    backdrop: gutterBg,
    where: '行号栏底',
  },
  {
    key: 'diffEditorGutter.removedLineBackground',
    design: DESIGN.oldNum,
    backdrop: gutterBg,
    where: '行号栏底',
  },
]

describe('Monaco 差异底色', () => {
  it.each(CASES)(
    '$key 是半透明源色，且合成后仍等于设计色（叠在$where上）',
    ({ key, design, backdrop }) => {
      const source = colorOf(key)
      const rgba = parseColor(source)
      const target = rgb(design)
      const composed = over(rgba, backdrop)

      // ⚠️ 必须带 alpha：不透明就会把选区整个盖掉（见文件头）
      expect({ key, alpha: rgba[3], opaque: rgba[3] === 1 }).toMatchObject({
        opaque: false,
      })

      // 合成后 ≈ 设计色（容差 6：半透明带来的最小可见偏差，如蓝色通道触底）
      const withinTolerance = composed.every(
        (v, i) => Math.abs(v - target[i]) <= 6,
      )
      expect({ source, backdrop, composed, target, withinTolerance }).toMatchObject(
        { withinTolerance: true },
      )
    },
  )

  it('注释色在每一档改动底色上都还看得见（≥ 3:1）', () => {
    // 实测反馈：新增行的绿底上，注释（原 #5c6370）与底色只有 1.31:1 —— 完全看不出字。
    // 底线是「底色可以亮，但主题里最暗的 token（注释）必须还读得出来」；
    // 目标取 3:1（图形 / 高亮的最低线）而不是正文的 4.5:1：再压暗底色，改动高亮本身就看不见了。
    const comment = tokenColorOf('comment')
    const textBackdrops = {
      oldLine: DESIGN.oldLine,
      newLine: DESIGN.newLine,
      oldChar: DESIGN.oldChar,
      newChar: DESIGN.newChar,
    }
    for (const [name, bg] of Object.entries(textBackdrops)) {
      const ratio = Number(contrast(comment, bg).toFixed(2))
      expect({ name, bg, ratio, ok: ratio >= 3 }).toMatchObject({ ok: true })
    }
  })

  it('DOM 侧 --diff-* 与 Monaco 的六个差异色同源（两套界面不许分叉）', () => {
    const vars = buildCodeCssVars(PALETTE, {
      fontSize: 13,
      lineHeight: 1.5,
      fontFamily: CODE_FONT_STACKS.consolas,
    })
    expect({
      oldLine: vars['--diff-old-line-bg'],
      newLine: vars['--diff-new-line-bg'],
      oldNum: vars['--diff-old-linenum-bg'],
      newNum: vars['--diff-new-linenum-bg'],
    }).toEqual({
      oldLine: colorOf('diffEditor.removedLineBackground'),
      newLine: colorOf('diffEditor.insertedLineBackground'),
      oldNum: colorOf('diffEditorGutter.removedLineBackground'),
      newNum: colorOf('diffEditorGutter.insertedLineBackground'),
    })
  })
})
