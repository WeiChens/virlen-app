/**
 * 差异底色的两条不变式（实测反馈：「在改动行里选中文本，看不到选中效果」）。
 *
 * ⚠️ 这条用例守的不是配色好看，是**层序上的硬约束**：Monaco 把选区画在改动底色**下面**
 * （0.56 `view.js`：`.lines-content` 先 append 选区所在的 `contentViewOverlays`、再 append 承载改动
 * 底色的 `viewLines`，两者都 z-auto → DOM 序就是绘制序），所以**改动底色一旦回到不透明，选区就会被
 * 整个盖住** —— 而这一点只会在「在改动行里选中文本」这一步被看见：编译期、tsc、别的用例都发现不了。
 *
 * 因此：六个差异底色必须是**半透明源色**（`#RRGGBBAA`），且「源色 over 底下那层」要仍等于 DOM 版
 * 那套设计色（`theme.scss` **暗色块**的 `--diff-*` + 字符级那两个）—— 也就是**观感没变**，变的只是
 * 「底下那一层能透出来」。
 *
 * 主题不能在 jsdom 里 import（monaco 一进 jsdom 就崩），所以按源码文本断言。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const THEME_TS = 'src/monaco/setupMonaco.ts'
const THEME_SCSS = 'src/ui/styles/theme.scss'

/** 设计色（不透明）—— DOM 版那套（Monaco 侧只是换成「半透明源色 + 底下那层」的等价写法） */
const DESIGN = {
  oldLine: '#2a1515',
  newLine: '#152a15',
  oldNum: '#3a2020',
  newNum: '#203a20',
  oldChar: '#5c2626',
  newChar: '#265c2a',
} as const

type Rgb = [number, number, number]
type Rgba = [number, number, number, number]

function parseColor(hex: string): Rgba {
  const h = hex.slice(1)
  const at = (i: number): number => Number.parseInt(h.slice(i * 2, i * 2 + 2), 16)
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

/** 从主题源码里取一个字面量颜色（`'editor.background': '#282c34'`） */
function literalOf(source: string, key: string): string {
  const m = source.match(
    new RegExp(`'${key}':\\s*'(#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?)'`),
  )
  if (!m) throw new Error(`主题里找不到 '${key}'（用例与主题漂了，先看 ${THEME_TS}）`)
  return m[1]
}

const themeSource = readFileSync(THEME_TS, 'utf8')
const rgb = (hex: string): Rgb => parseColor(hex).slice(0, 3) as Rgb
/** 正文底 / 行号栏底：差异底色就叠在它们上面（改它们就必须重算源色） */
const editorBg = rgb(literalOf(themeSource, 'editor.background'))
const gutterBg = rgb(literalOf(themeSource, 'editorGutter.background'))

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
      const source = literalOf(themeSource, key)
      const rgba = parseColor(source)
      const target = rgb(design)
      const composed = over(rgba, backdrop)

      // ⚠️ 必须带 alpha：不透明就会把选区整个盖掉（见文件头）
      expect({ key, alpha: rgba[3], opaque: rgba[3] === 1 }).toMatchObject({ opaque: false })

      // 合成后 ≈ 设计色（容差 6：半透明带来的最小可见偏差，如蓝色通道触底）
      const withinTolerance = composed.every((v, i) => Math.abs(v - target[i]) <= 6)
      expect({ source, backdrop, composed, target, withinTolerance }).toMatchObject({
        withinTolerance: true,
      })
    },
  )

  it('设计色与 DOM 版的暗色那套变量一致（两套调色板不许分叉）', () => {
    const scss = readFileSync(THEME_SCSS, 'utf8')
    // ⚠️ 只对 `[data-theme='dark']` 那一块：Monaco 侧只注册了暗色主题（`virlen-dark`），
    // 而 theme.scss 里 `:root, [data-theme='light']` 是另一套亮色值（`#f0fdf4` 那种）。
    const start = scss.indexOf("[data-theme='dark']")
    const end = scss.indexOf('\n}', start)
    if (start < 0 || end < 0) throw new Error(`在 ${THEME_SCSS} 里找不到 [data-theme='dark'] 块`)
    const dark = scss.slice(start, end)
    const variableOf = (name: string): string => {
      const m = dark.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`))
      if (!m) throw new Error(`暗色块里找不到 --${name}`)
      return m[1]
    }
    expect({
      'diff-new-line-bg': variableOf('diff-new-line-bg'),
      'diff-old-line-bg': variableOf('diff-old-line-bg'),
      'diff-new-linenum-bg': variableOf('diff-new-linenum-bg'),
      'diff-old-linenum-bg': variableOf('diff-old-linenum-bg'),
    }).toEqual({
      'diff-new-line-bg': DESIGN.newLine,
      'diff-old-line-bg': DESIGN.oldLine,
      'diff-new-linenum-bg': DESIGN.newNum,
      'diff-old-linenum-bg': DESIGN.oldNum,
    })
  })
})
