/**
 * 代码显示（主题 / 字号 / 样式）的类型契约。
 *
 * 三个消费面共用这一份定义：
 *   · Monaco 主题 —— src/monaco/setupMonaco.ts 按 `CODE_THEMES` 逐个注册；
 *   · DOM 回退层 —— code-block.scss 的 `<pre>` 与代码块外壳只吃 `--code-*` 变量；
 *   · 设置页 —— src/ui/pages/Settings/code-display-settings.tsx 只读 `CODE_THEMES` 的键。
 *
 * ⚠️ 调色板是**唯一色源**：Monaco 主题对象与 CSS 变量都由它算出来（见 themes.ts 的两个 build），
 *    任何地方都不许再手写代码配色 —— 否则流式 `<pre>` 与终态 Monaco 会各用一套色。
 */

/** 主题外观档：决定 Monaco 的 base（vs / vs-dark）与派生色的混合方向 */
export type CodeThemeKind = 'dark' | 'light'

/**
 * 差异底色的 6 个源色。
 *
 * ⚠️ 必须是半透明（`#RRGGBBAA`，A≈0x80）：Monaco 把选区画在改动底色**下面**，
 *    底色一旦不透明，选区就被整个盖住（「在改动行里选中文本看不到效果」）。
 *    合成口径 out = α×上层 + (1−α)×底色，见 src/tests/ui/code-theme-contract.test.ts。
 */
export interface CodeThemeDiff {
  /** 删除行整行底色 */
  oldLine: string
  /** 新增行整行底色 */
  newLine: string
  /** 删除侧行号区底色 */
  oldNum: string
  /** 新增侧行号区底色 */
  newNum: string
  /** 删除侧字符级底色 */
  oldChar: string
  /** 新增侧字符级底色 */
  newChar: string
}

/**
 * 「表面色」补充项：这些是各主题有自己口味、又不值得放进语义字段的值。
 * 派生不出来的（滑块、缩进参考线）就显式写；能派生的（边框）由 themes.ts 用 mix 算。
 */
export interface CodeThemeUi {
  /** 当前行行号色（行号未命中时用 gutterFg） */
  lineNumberActive: string
  /** 活动缩进参考线 */
  indentActive: string
  /** 空白字符点（renderWhitespace 打开时才看得见） */
  whitespace: string
  /** 编辑器浮层（find widget / 滚动条槽）底色，默认取 gutterBg */
  widgetBg?: string
  /** 滚动条滑块三档 */
  slider: string
  sliderHover: string
  sliderActive: string
}

/**
 * 差异列头（原文件 / 新文件那两行）的底色与文字色。
 *
 * ⚠️ 这四个值是列头**唯一的色源**：以前写死在 SideBySideDiff.scss（#3a2020 / #f38ba8），
 *    于是「代码区切了浅色主题、列头还是深色」—— 跟主题不走了。
 */
export interface CodeThemeDiffHeaders {
  oldBg: string
  oldFg: string
  newBg: string
  newFg: string
}

/** 一个代码主题的全部输入（新增主题 = 加一个这样的对象） */
export interface CodeThemePalette {
  /** 展示名，同时是 i18n key（专有名词，中英一致） */
  label: string
  kind: CodeThemeKind
  /** 编辑器底色 / 正文 */
  bg: string
  fg: string
  /** 行号区 */
  gutterBg: string
  gutterFg: string
  /** 语法色 */
  comment: string
  string: string
  number: string
  keyword: string
  type: string
  func: string
  variable: string
  tag: string
  operator: string
  /** 交互色 */
  selection: string
  lineHighlight: string
  cursor: string
  ui: CodeThemeUi
  /** 差异底色；不给就按 kind 取 DARK_DIFF / LIGHT_DIFF（暗色主题那组是实测调过的） */
  diff?: CodeThemeDiff
  /** 差异列头色；不给就按 kind 取 DARK_DIFF_HEADERS / LIGHT_DIFF_HEADERS */
  diffHeaders?: CodeThemeDiffHeaders
}

/** Monaco 主题数据（本地结构类型：域层不引 monaco 运行时，`import type` 都不想依赖） */
export interface MonacoThemeData {
  base: 'vs' | 'vs-dark'
  inherit: boolean
  rules: {
    token: string
    foreground?: string
    background?: string
    fontStyle?: string
  }[]
  colors: Record<string, string>
}

/** 设置项里与代码显示有关的那几个字段（`SettingsStore` 的子集，域层不必依赖整个 store） */
export interface CodeDisplaySettings {
  /** 主题口径：fixed = 固定用 `codeThemeId`；follow = 跟随应用亮暗 */
  codeThemeMode: 'fixed' | 'follow'
  /** 固定主题 id（`CODE_THEMES` 的键） */
  codeThemeId: string
  /** 字号（px） */
  codeFontSize: number
  /** 字族 id（`CODE_FONT_STACKS` 的键） */
  codeFontFamily: string
  /** 行高倍率 */
  codeLineHeight: number
  /** 连字 */
  codeFontLigatures: boolean
  /** 代码块是否显示行号（作为各调用点未显式传值时的默认值） */
  codeShowLineNumbers: boolean
}

/** 解析后的代码显示参数：Monaco 选项与 DOM/CSS 都从这里取值，不再各自换算 */
export interface ResolvedCodeDisplay {
  /** Monaco 主题 id（已按 fixed / follow 解析） */
  themeId: string
  /** 字号（px，已钳制） */
  fontSize: number
  /** 行高倍率（已钳制） */
  lineHeight: number
  /** 行高（px，Monaco 只要像素值） */
  lineHeightPx: number
  /** 完整 font stack */
  fontFamily: string
  ligatures: boolean
  showLineNumbers: boolean
}
