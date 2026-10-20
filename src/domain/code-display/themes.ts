/**
 * 代码主题调色板 + 两个构建器（Monaco 主题对象 / CSS 变量）。
 *
 * ⚠️ 本文件是代码配色的**唯一源**：`buildMonacoThemeData()` 与 `buildCodeCssVars()` 都从
 *    同一份 `CODE_THEMES` 算出来。Monaco 只能吃 JS 对象，而流式 `<pre>`、代码块外壳、行内代码
 *    只能吃 CSS 变量 —— 两边若各写一份，暗色档就会重演「流式底色 #11111b / 终态 #282c34」那种跳变。
 *
 * 新增主题 = 往 `CODE_THEMES` 里加一个对象（约 30 行）；边框 / 空白字符这类派生色由构建器算。
 */
import type {
  CodeThemeDiff,
  CodeThemeDiffHeaders,
  CodeThemePalette,
  MonacoThemeData,
} from './types'

/** 列头色的类型跟调色板一起对外导出（消费方只认这个入口） */
export type { CodeThemeDiffHeaders } from './types'

/** `#rrggbb` → `rrggbb`（Monaco 的 rules 里前景色不带 `#`） */
function bare(color: string): string {
  return color.replace(/^#/, '')
}

/** `#rrggbb` 的通道值 */
function channels(color: string): [number, number, number] {
  const h = bare(color)
  return [
    Number.parseInt(h.slice(0, 2), 16),
    Number.parseInt(h.slice(2, 4), 16),
    Number.parseInt(h.slice(4, 6), 16),
  ]
}

function toHex(n: number): string {
  return Math.round(Math.max(0, Math.min(255, n)))
    .toString(16)
    .padStart(2, '0')
}

/**
 * 按权重混色：`weight` = 前者占比（0–1），与 SCSS `color.mix(a, b, weight)` 同义。
 * 只用于派生「表面色」（边框 / 头栏 / 浮层），语法色一律显式挑 —— 算出来的语法色不好看也没法解释。
 */
function mix(a: string, b: string, weight: number): string {
  const [ar, ag, ab] = channels(a)
  const [br, bg, bb] = channels(b)
  return (
    '#' +
    toHex(ar * weight + br * (1 - weight)) +
    toHex(ag * weight + bg * (1 - weight)) +
    toHex(ab * weight + bb * (1 - weight))
  )
}

/**
 * 暗色主题共用的一组改动底色（实测调过，见 src/tests/ui/monaco-diff-theme.test.ts 的来历）。
 *
 * ⚠️ 六个值都是半透明（A=0x80），理由见 types.ts 的 CodeThemeDiff：不半透明就会盖住选区。
 * 暗色底上的合成结果彼此接近，所以暗色主题共用这一组；某主题想特调就在自己的 `diff` 里覆盖。
 */
export const DARK_DIFF: CodeThemeDiff = {
  oldLine: '#2c000080', // 合成后 ≈ #2a1515
  newLine: '#02280080', // 合成后 ≈ #152a15
  oldNum: '#531b1580', // 合成后 ≈ #3a2020
  newNum: '#1f4f1580', // 合成后 ≈ #203a20
  oldChar: '#8e373280', // 合成后 ≈ #5c2626
  newChar: '#23502b80', // 合成后 ≈ #1c3d20
}

/**
 * 亮色主题共用的一组改动底色。
 * 亮底上要的是「薄薄一层红 / 绿」，所以源色偏白、饱和度低；同样 A=0x80。
 */
export const LIGHT_DIFF: CodeThemeDiff = {
  oldLine: '#ffd7d580',
  newLine: '#ccffd880',
  oldNum: '#ffc0ba80',
  newNum: '#a8ecb680',
  oldChar: '#ff9d9480',
  newChar: '#7fe08e80',
}

/**
 * 列头（原文件 / 新文件那两行）的底色与文字色。
 *
 * 与 diff 源色同一套思路：暗色共用一组、亮色共用一组（这两组都是改造前在用的成品色，
 * 已在真实界面上验过对比度）。某主题想特调就在自己的 `diffHeaders` 里覆盖。
 */
export const DARK_DIFF_HEADERS: CodeThemeDiffHeaders = {
  oldBg: '#3a2020',
  oldFg: '#f38ba8',
  newBg: '#1a3a1a',
  newFg: '#a6e3a1',
}

export const LIGHT_DIFF_HEADERS: CodeThemeDiffHeaders = {
  oldBg: '#fef2f2',
  oldFg: '#991b1b',
  newBg: '#f0fdf4',
  newFg: '#166534',
}

/**
 * 「其余命中」的底色（当前命中另算，见 buildMonacoThemeData）。
 *
 * 固定值而不是从调色板派生：它是**功能色**（橙 = 搜索命中，与语法色无关），六套主题应该长一样。
 * ⚠️ 必须半透明：Monaco 把命中底色画在选区**之上**（inline 装饰在 `viewLines` 里，选区在
 *    `contentViewOverlays` 里，后者先 append），不透明就会把选区整个盖住 —— 与差异底色同一条约束
 *    （见 types.ts 的 CodeThemeDiff）。
 */
const FIND_MATCH_HIGHLIGHT = '#ea5c0055'

/**
 * 主题表：键就是 `<html data-code-theme>` 与设置项 `codeThemeId` 的取值
 */
export const CODE_THEMES: Record<string, CodeThemePalette> = {
  /**
   * 默认主题（= 改造前写死的 `virlen-dark`）。
   * 所有可见色都逐值照抄旧实现，升级后观感不变；改这里等于改默认外观，别顺手调。
   */
  'virlen-dark': {
    label: 'Virlen Dark',
    kind: 'dark',
    bg: '#282c34',
    fg: '#abb2bf',
    gutterBg: '#21252b',
    gutterFg: '#495162',
    comment: '#7f848e',
    string: '#98c379',
    number: '#d19a66',
    keyword: '#c678dd',
    type: '#e5c07b',
    func: '#61afef',
    variable: '#e06c75',
    tag: '#e06c75',
    operator: '#56b6c2',
    selection: '#3e4451',
    lineHighlight: '#2c313a',
    cursor: '#528bff',
    ui: {
      lineNumberActive: '#c8ccd4',
      indentActive: '#3a3f4b',
      whitespace: '#4b5263',
      slider: '#4b5263',
      sliderHover: '#5a6274',
      sliderActive: '#6a7286',
    },
    diff: DARK_DIFF,
  },

  'virlen-light': {
    label: 'Virlen Light',
    kind: 'light',
    bg: '#fafafa',
    fg: '#383a42',
    gutterBg: '#f0f0f0',
    gutterFg: '#9d9d9f',
    // 官方 One Light 是 #a0a1a7：在 #fafafa 上只有 2.4:1，这里压暗到 3.9:1（见契约用例）
    comment: '#7d7d85',
    string: '#50a14f',
    number: '#986801',
    keyword: '#a626a4',
    type: '#c18401',
    func: '#4078f2',
    variable: '#e45649',
    tag: '#e45649',
    operator: '#0184bc',
    selection: '#e5e5e6',
    lineHighlight: '#f2f2f2',
    cursor: '#526fff',
    ui: {
      lineNumberActive: '#383a42',
      indentActive: '#d0d0d0',
      whitespace: '#c9c9ca',
      slider: '#c2c2c3',
      sliderHover: '#b0b0b1',
      sliderActive: '#9d9d9e',
    },
  },

  'github-dark': {
    label: 'GitHub Dark',
    kind: 'dark',
    bg: '#0d1117',
    fg: '#c9d1d9',
    gutterBg: '#010409',
    gutterFg: '#6e7681',
    comment: '#8b949e',
    string: '#a5d6ff',
    number: '#79c0ff',
    keyword: '#ff7b72',
    type: '#ffa657',
    func: '#d2a8ff',
    variable: '#ffa657',
    tag: '#7ee787',
    operator: '#ff7b72',
    selection: '#264f78',
    lineHighlight: '#161b22',
    cursor: '#58a6ff',
    ui: {
      lineNumberActive: '#c9d1d9',
      indentActive: '#21262d',
      whitespace: '#484f58',
      slider: '#484f58',
      sliderHover: '#5c6570',
      sliderActive: '#6e7681',
    },
  },

  'github-light': {
    label: 'GitHub Light',
    kind: 'light',
    bg: '#ffffff',
    fg: '#24292f',
    gutterBg: '#f6f8fa',
    gutterFg: '#8c959f',
    comment: '#6e7781',
    string: '#0a3069',
    number: '#0550ae',
    keyword: '#cf222e',
    type: '#953800',
    func: '#8250df',
    variable: '#953800',
    tag: '#116329',
    operator: '#cf222e',
    selection: '#b6d7ff',
    lineHighlight: '#f6f8fa',
    cursor: '#0969da',
    ui: {
      lineNumberActive: '#24292f',
      indentActive: '#d0d7de',
      whitespace: '#afb8c1',
      slider: '#d0d7de',
      sliderHover: '#afb8c1',
      sliderActive: '#8c959f',
    },
  },

  monokai: {
    label: 'Monokai',
    kind: 'dark',
    bg: '#272822',
    fg: '#f8f8f2',
    gutterBg: '#1e1f1c',
    gutterFg: '#90908a',
    // 官方 #75715e 在深底上仅 3.0:1 左右，压亮的这一档留足余量
    comment: '#8b8770',
    string: '#e6db74',
    number: '#ae81ff',
    keyword: '#f92672',
    type: '#66d9ef',
    func: '#a6e22e',
    variable: '#f8f8f2',
    tag: '#f92672',
    operator: '#f92672',
    selection: '#49483e',
    lineHighlight: '#3e3d32',
    cursor: '#f8f8f0',
    ui: {
      lineNumberActive: '#f8f8f2',
      indentActive: '#3e3d32',
      whitespace: '#49483e',
      slider: '#49483e',
      sliderHover: '#5b5a4e',
      sliderActive: '#75715e',
    },
  },

  'solarized-dark': {
    label: 'Solarized Dark',
    kind: 'dark',
    bg: '#002b36',
    fg: '#93a1a1',
    gutterBg: '#00252e',
    gutterFg: '#586e75',
    // 官方注释 #586e75 只有 2.6:1，取 base0（#657b83）压到 3.4:1
    comment: '#657b83',
    string: '#2aa198',
    number: '#d33682',
    keyword: '#859900',
    type: '#b58900',
    func: '#268bd2',
    variable: '#b58900',
    tag: '#268bd2',
    operator: '#859900',
    selection: '#073642',
    lineHighlight: '#073642',
    cursor: '#93a1a1',
    ui: {
      lineNumberActive: '#93a1a1',
      indentActive: '#0a4a5a',
      whitespace: '#0f4b5c',
      slider: '#0f4b5c',
      sliderHover: '#1a5a6c',
      sliderActive: '#586e75',
    },
    /**
     * 底色是深藏青（#002b36），套通用的那组红 / 绿会在字符级上偏亮：
     * 字符底色合成后注释只剩 2.75:1（实测，见 code-theme-contract 用例）。
     * 行级底色沿用通用那组（对比度 4.1 / 3.4 都够），只把字符级压暗一档。
     */
    diff: {
      ...DARK_DIFF,
      oldChar: '#4a1a1880',
      newChar: '#12401f80',
    },
  },
}

/** 默认主题 id（= 改造前的固定外观） */
export const DEFAULT_CODE_THEME_ID = 'virlen-dark'

/** 主题是否存在（设置里存了旧 id / 手改坏了都回落到默认） */
export function hasCodeTheme(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(CODE_THEMES, id)
}

/** 主题调色板（未知 id 回落默认，绝不返回 undefined） */
export function codeThemeOf(id: string): CodeThemePalette {
  return CODE_THEMES[id] ?? CODE_THEMES[DEFAULT_CODE_THEME_ID]
}

/** 主题的展示名（i18n key） */
export function codeThemeLabel(id: string): string {
  return codeThemeOf(id).label
}

/** 某个主题设的差异底色（没覆盖就用按 kind 的那一组） */
export function diffOf(palette: CodeThemePalette): CodeThemeDiff {
  return palette.diff ?? (palette.kind === 'dark' ? DARK_DIFF : LIGHT_DIFF)
}

/** 某个主题的列头色（没覆盖就用按 kind 的那一组） */
export function diffHeadersOf(palette: CodeThemePalette): CodeThemeDiffHeaders {
  return (
    palette.diffHeaders ??
    (palette.kind === 'dark' ? DARK_DIFF_HEADERS : LIGHT_DIFF_HEADERS)
  )
}

/**
 * 调色板 → Monaco 主题对象（`monaco.editor.defineTheme` 的入参）。
 *
 * 规则集与旧的写死实现一一对应（delimiter 取正文色、attribute.name 取字符串色、
 * 属性取 variable 色…），改映射等于改所有主题的着色，先看契约用例。
 */
export function buildMonacoThemeData(
  palette: CodeThemePalette,
): MonacoThemeData {
  const fg = bare(palette.fg)
  const diff = diffOf(palette)
  const widgetBg = palette.ui.widgetBg ?? palette.gutterBg
  /** 浮层描边：暗色往黑压、亮色往白提 */
  const widgetBorder = mix(
    palette.bg,
    palette.kind === 'dark' ? '#000000' : '#ffffff',
    0.55,
  )
  /**
   * 输入框面（查找浮层的搜索框）：在编辑器底色上抬一档才看得出是个输入框。
   * 权重分两档是量出来的：暗色抬 6%（再多会把 solarized 的正文色压到 AA 以下 ——
   * 它的底色本就深，提亮空间全给了正文对比度），亮色压 10%（6% 时与浮层底座只差 5，看不见）。
   */
  const inputBg = mix(
    palette.kind === 'dark' ? '#ffffff' : '#000000',
    palette.bg,
    palette.kind === 'dark' ? 0.06 : 0.1,
  )

  return {
    base: palette.kind === 'dark' ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [
      { token: '', foreground: fg, background: bare(palette.bg) },
      // 对比度：注释在各主题的改动底色上仍要读得出来（亮色档另有自己的底线，见契约用例）
      { token: 'comment', foreground: bare(palette.comment), fontStyle: 'italic' },
      { token: 'string', foreground: bare(palette.string) },
      { token: 'string.escape', foreground: bare(palette.string) },
      { token: 'regexp', foreground: bare(palette.string) },
      { token: 'number', foreground: bare(palette.number) },
      { token: 'keyword', foreground: bare(palette.keyword) },
      { token: 'keyword.control', foreground: bare(palette.keyword) },
      { token: 'keyword.operator', foreground: bare(palette.operator) },
      { token: 'operator', foreground: bare(palette.operator) },
      { token: 'delimiter', foreground: fg },
      { token: 'delimiter.bracket', foreground: fg },
      { token: 'delimiter.curly', foreground: fg },
      { token: 'delimiter.square', foreground: fg },
      { token: 'delimiter.parenthesis', foreground: fg },
      { token: 'punctuation', foreground: fg },
      { token: 'punctuation.definition', foreground: fg },
      { token: 'type', foreground: bare(palette.type) },
      { token: 'type.identifier', foreground: bare(palette.type) },
      { token: 'class', foreground: bare(palette.type) },
      { token: 'class.name', foreground: bare(palette.type) },
      { token: 'entity.name.type', foreground: bare(palette.type) },
      { token: 'annotation', foreground: bare(palette.type) },
      { token: 'function', foreground: bare(palette.func) },
      { token: 'entity.name.function', foreground: bare(palette.func) },
      { token: 'tag', foreground: bare(palette.tag) },
      { token: 'attribute.name', foreground: bare(palette.string) },
      { token: 'attribute.value', foreground: bare(palette.func) },
      { token: 'variable', foreground: bare(palette.variable) },
      { token: 'variable.name', foreground: bare(palette.variable) },
      { token: 'property', foreground: bare(palette.variable) },
      { token: 'constant', foreground: bare(palette.number) },
      { token: 'constant.language', foreground: bare(palette.number) },
      { token: 'parameter', foreground: fg },
      { token: 'meta', foreground: fg },
      { token: 'string.key.json', foreground: bare(palette.variable) },
      { token: 'diff.header', foreground: bare(palette.func) },
      { token: 'diff.hunk', foreground: bare(palette.operator) },
      { token: 'diff.inserted', foreground: bare(palette.string) },
      { token: 'diff.deleted', foreground: bare(palette.variable) },
      { token: 'diff.context', foreground: fg },
    ],
    colors: {
      'editor.background': palette.bg,
      'editor.foreground': palette.fg,
      'editorLineNumber.foreground': palette.gutterFg,
      'editorLineNumber.activeForeground': palette.ui.lineNumberActive,
      'editorGutter.background': palette.gutterBg,
      'editorCursor.foreground': palette.cursor,
      'editor.selectionBackground': palette.selection,
      'editor.inactiveSelectionBackground': `${palette.selection}66`,
      'editor.lineHighlightBackground': palette.lineHighlight,
      'editorIndentGuide.background1': palette.lineHighlight,
      'editorIndentGuide.activeBackground1': palette.ui.indentActive,
      'editorWhitespace.foreground': palette.ui.whitespace,
      'editorWidget.background': widgetBg,
      'editorWidget.border': widgetBorder,
      /*
       * 查找控件（Ctrl/Cmd+F 的右上角浮层，见 ui/components/code-editor）：
       * 底座 / 描边走 editorWidget.*，输入框与命中高亮必须自己给 —— 不给就落回 base 主题
       *（vs / vs-dark）的通用灰蓝：六套主题里各显各的色，暗色主题里甚至会跳出一块
       * #3C3C3C 的中灰输入框。
       */
      'editorWidget.foreground': palette.fg,
      'input.background': inputBg,
      'input.foreground': palette.fg,
      'input.border': widgetBorder,
      // 当前命中：不透明块（34% 正文字色 + 66% 底色），与 VS Code 的 #515C6A 同一观感
      'editor.findMatchBackground': mix(palette.fg, palette.bg, 0.34),
      // 其余命中：半透明淡橙，压得住字也遮不住选区
      'editor.findMatchHighlightBackground': FIND_MATCH_HIGHLIGHT,
      'scrollbarSlider.background': `${palette.ui.slider}66`,
      'scrollbarSlider.hoverBackground': `${palette.ui.sliderHover}aa`,
      'scrollbarSlider.activeBackground': `${palette.ui.sliderActive}aa`,
      'scrollbar.shadow': '#00000000',
      'minimap.background': widgetBg,
      'editorOverviewRuler.border': '#00000000',
      focusBorder: '#00000000',
      // 片段代码常有多余的右括号，保持与正文同色，避免「红色报错感」
      'editorBracketHighlight.unexpectedBracket.foreground': palette.fg,
      'editorBracketHighlight.foreground1': palette.fg,
      'editorBracketHighlight.foreground2': palette.fg,
      'editorBracketHighlight.foreground3': palette.fg,
      'editorBracketHighlight.foreground4': palette.fg,
      'editorBracketHighlight.foreground5': palette.fg,
      'editorBracketHighlight.foreground6': palette.fg,
      'editorBracketHighlight.background1': '#00000000',
      'editorBracketHighlight.background2': '#00000000',
      'editorBracketHighlight.background3': '#00000000',
      'editorBracketHighlight.background4': '#00000000',
      'editorBracketHighlight.background5': '#00000000',
      'editorBracketHighlight.background6': '#00000000',
      // 差异配色：这六个半透明源色与下面 --diff-* 是同一份（选区必须能透出来）
      'diffEditor.removedLineBackground': diff.oldLine,
      'diffEditor.insertedLineBackground': diff.newLine,
      'diffEditor.removedTextBackground': diff.oldChar,
      'diffEditor.insertedTextBackground': diff.newChar,
      'diffEditorGutter.removedLineBackground': diff.oldNum,
      'diffEditorGutter.insertedLineBackground': diff.newNum,
      'diffEditor.border': widgetBorder,
    },
  }
}

/**
 * 调色板 + 字体参数 → CSS 变量。
 *
 * 覆盖面 = DOM 侧全部代码外观：代码块外壳（头栏 / 正文底色）、流式 `<pre>` 回退、
 * 行内代码、以及 DOM 版差异视图仍在用的 `--diff-*`。
 * 运行期由 src/monaco/applyCodeTheme.ts 注入 `:root[data-code-theme='<id>']`，
 * theme.scss 里只留一份首帧兜底。
 */
export function buildCodeCssVars(
  palette: CodeThemePalette,
  font: { fontSize: number; lineHeight: number; fontFamily: string },
): Record<string, string> {
  const diff = diffOf(palette)
  const headers = diffHeadersOf(palette)
  return {
    '--code-body-bg': palette.bg,
    '--code-body-color': palette.fg,
    // 头栏比正文面亮一档（暗色档提亮 / 亮色档压灰），保证「头栏是另一个面」读得出来
    // 注：mix 的第三个参数是**前者**的占比，所以是「10% 正文色 + 90% 底色」
    '--code-header-bg': mix(palette.fg, palette.bg, 0.1),
    '--code-header-color': palette.fg,
    '--code-selection-bg': palette.selection,
    '--code-font-size': `${font.fontSize}px`,
    '--code-line-height': String(font.lineHeight),
    '--code-font-family': font.fontFamily,
    '--diff-old-line-bg': diff.oldLine,
    '--diff-new-line-bg': diff.newLine,
    '--diff-old-linenum-bg': diff.oldNum,
    '--diff-new-linenum-bg': diff.newNum,
    '--diff-linenum-color': palette.gutterFg,
    // 列头（原文件 / 新文件）：跟主题走，不再写死在 SCSS 里
    '--diff-old-header-bg': headers.oldBg,
    '--diff-old-header-color': headers.oldFg,
    '--diff-new-header-bg': headers.newBg,
    '--diff-new-header-color': headers.newFg,
    /*
     * 差异视图里「选中文本」的底色：Monaco 把选区画在改动底色**下面**，直接用手上那支
     * --code-selection-bg 会被半透明底色再叠一层、几乎看不出来 —— 所以往「远离底色」的方向推一档，
     * 但**只推一档**：它必须仍然是选区色，不是正文色。
     * ⚠️ `mix` 的权重是**选区色的占比**，别写成“推的那部分”：写成 0.22 时选区等于 78% 正文字色，
     *    深色主题变成一片浅灰、浅色主题变成一块近黑（正文压在上面根本读不出来）。
     * 深浅两档方向相反，所以按 kind 分开：深色底往亮处提，浅色底只轻轻压一点（压多了就是深斑）。
     */
    '--code-selection-strong':
      palette.kind === 'dark'
        ? mix(palette.selection, palette.fg, 0.8)
        : mix(palette.selection, palette.fg, 0.9),
  }
}
