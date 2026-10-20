/**
 * 代码显示（主题 / 字号 / 字族 / 行高 / 行号）的解析层。
 *
 * 职责边界：
 *   · 本文件**纯函数**，不碰 DOM、不引 monaco —— 三个消费面（CodePreview / CodeEditor /
 *     MonacoDiffView）与设置页都调它，跑在 jsdom 里也不会炸；
 *   · Monaco 选项与 CSS 变量都从 `ResolvedCodeDisplay` 取值，禁止各组件自己再换算一次
 *     （旧的 `CODE_FONT_PX` 12/13/14、diff 的 1.55 倍率、`--font-size-sm` 三套口径就是这么漂的）。
 */
import {
  CODE_THEMES,
  DEFAULT_CODE_THEME_ID,
  codeThemeOf,
  hasCodeTheme,
} from './themes'
import type { CodeDisplaySettings, ResolvedCodeDisplay } from './types'

export * from './types'
export {
  CODE_THEMES,
  DARK_DIFF,
  DARK_DIFF_HEADERS,
  DEFAULT_CODE_THEME_ID,
  LIGHT_DIFF,
  LIGHT_DIFF_HEADERS,
  buildCodeCssVars,
  buildMonacoThemeData,
  codeThemeLabel,
  codeThemeOf,
  diffHeadersOf,
  diffOf,
  hasCodeTheme,
} from './themes'

/** 字号范围（px）：11 起是等宽字体可读下限，20 以上单行就装不下几列了 */
export const CODE_FONT_SIZE_MIN = 11
export const CODE_FONT_SIZE_MAX = 20
/** 行高倍率范围 */
export const CODE_LINE_HEIGHT_MIN = 1.2
export const CODE_LINE_HEIGHT_MAX = 2

/**
 * 代码字体候选（id → 完整 font stack）。
 *
 * 顺序即回退顺序：项目没随包分发等宽字体，所以每个候选都以「本机大概率有」的字体打头，
 * 后面挂一串同类回退。默认 consolas —— 与改造前代码块的首选字体一致（Windows 必装）。
 */
export const CODE_FONT_STACKS: Record<string, string> = {
  consolas:
    "Consolas, 'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'SF Mono', 'Courier New', monospace",
  jetbrains:
    "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'SF Mono', Consolas, 'Courier New', monospace",
  fira: "'Fira Code', 'JetBrains Mono', 'Cascadia Code', Consolas, 'Courier New', monospace",
  cascadia:
    "'Cascadia Code', 'JetBrains Mono', 'Fira Code', Consolas, 'Courier New', monospace",
  system:
    "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
}

/** 默认字族（= 改造前代码块的首选字体） */
export const DEFAULT_CODE_FONT_FAMILY = 'consolas'

/** 设置页的字族选项（label 同时是 i18n key） */
export const CODE_FONT_OPTIONS: { id: string; label: string }[] = [
  { id: 'consolas', label: 'Consolas' },
  { id: 'jetbrains', label: 'JetBrains Mono' },
  { id: 'fira', label: 'Fira Code' },
  { id: 'cascadia', label: 'Cascadia Code' },
  { id: 'system', label: '系统等宽字体' },
]

/** 默认设置（同时作为 settingStore 的默认值与迁移基线） */
export const DEFAULT_CODE_DISPLAY_SETTINGS: CodeDisplaySettings = {
  codeThemeMode: 'fixed',
  codeThemeId: DEFAULT_CODE_THEME_ID,
  codeFontSize: 13,
  codeFontFamily: DEFAULT_CODE_FONT_FAMILY,
  codeLineHeight: 1.5,
  codeFontLigatures: false,
  codeShowLineNumbers: true,
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** 字族 id → font stack（未知 id 回落默认，绝不返回空串 —— Monaco 拿到空串会退回浏览器默认衬线体） */
export function fontStackOf(id: string | undefined): string {
  return CODE_FONT_STACKS[id ?? ''] ?? CODE_FONT_STACKS[DEFAULT_CODE_FONT_FAMILY]
}

/**
 * 行高像素值。
 *
 * Monaco 的 `lineHeight` 必须 ≥ `fontSize`，否则字被上下裁掉；再加 2px 呼吸量。
 * ⚠️ 高度估算（code-block 的容器高度、MonacoDiffView 的 autoHeight）必须用**这同一个函数**，
 *    否则行高设置一改，算出来的高度就与真实排版对不上，内容会被裁。
 */
export function codeLineHeightPx(
  fontSize: number,
  lineHeight: number = DEFAULT_CODE_DISPLAY_SETTINGS.codeLineHeight,
): number {
  return Math.max(fontSize + 2, Math.round(fontSize * lineHeight))
}

/**
 * 代码预览（`CodePreview`）的上下内边距（px）。
 *
 * ⚠️ 只有一份：Monaco 的 `padding` 选项与「代码块容器高度」都取这里 —— 容器的目标值就是
 *    Monaco 的内容高度（行数 × 行高 + 上下 padding），两处各写一个数就必然错开。
 */
export const CODE_PREVIEW_PADDING = { top: 12, bottom: 12 } as const

/**
 * 代码预览容器应有的高度（px）= Monaco 的内容高度，不多不少。
 *
 * 这是「没超过代码区上限」时的高度：此时 CodePreview 不开纵向滚动条，所以**容器不能比内容矮** ——
 * 矮 1px 就把最后一行裁掉（按设计没有滚动条可拖），高出来则是一截多余底色。
 * 超过上限（`CodeBlock` 的 maxHeight / 全屏可用高度）时高度钉在上限，多出的内容由
 * Monaco 内置滚动条承担（`scrollbar.vertical: 'auto'`）。
 *
 * ⚠️ 横向滚动条那 10px 不算在这里：`CodePreview` 把 `ignoreHorizontalScrollbarInContentHeight`
 *    置成了 true（内容高度里不再叠它），否则每块代码都会凭空多出 10px 可滚范围。
 */
export function codePreviewHeight(
  lines: number,
  lineHeightPx: number,
): number {
  return (
    lines * lineHeightPx + CODE_PREVIEW_PADDING.top + CODE_PREVIEW_PADDING.bottom
  )
}

/**
 * 解析当前应使用的主题 id。
 *
 * `follow` 只认亮 / 暗两档（不跟随用户挑的深色主题变体）：跟随模式下代码区要跟界面同明暗，
 * 具体是 One 系还是 GitHub 系没有意义，固定一对一最可预期。
 */
export function resolveCodeThemeId(
  settings: Partial<CodeDisplaySettings>,
  appTheme: 'light' | 'dark',
): string {
  if (settings.codeThemeMode === 'follow') {
    return appTheme === 'light' ? 'virlen-light' : DEFAULT_CODE_THEME_ID
  }
  const id = settings.codeThemeId ?? DEFAULT_CODE_THEME_ID
  return hasCodeTheme(id) ? id : DEFAULT_CODE_THEME_ID
}

/**
 * 设置 + 当前应用明暗 → 解析后的完整参数。
 *
 * 容错口径：任何字段缺失 / 越界 / 是脏数据都回落到默认值，绝不把 NaN 递给 Monaco
 * （Monaco 收到 NaN 的 fontSize 会静默不渲染）。
 */
export function resolveCodeDisplay(
  settings: Partial<CodeDisplaySettings>,
  appTheme: 'light' | 'dark',
): ResolvedCodeDisplay {
  const rawSize = Number(settings.codeFontSize)
  const fontSize = clamp(
    Number.isFinite(rawSize) && rawSize > 0
      ? Math.round(rawSize)
      : DEFAULT_CODE_DISPLAY_SETTINGS.codeFontSize,
    CODE_FONT_SIZE_MIN,
    CODE_FONT_SIZE_MAX,
  )
  const rawLineHeight = Number(settings.codeLineHeight)
  const lineHeight = clamp(
    Number.isFinite(rawLineHeight) && rawLineHeight > 0
      ? rawLineHeight
      : DEFAULT_CODE_DISPLAY_SETTINGS.codeLineHeight,
    CODE_LINE_HEIGHT_MIN,
    CODE_LINE_HEIGHT_MAX,
  )

  return {
    themeId: resolveCodeThemeId(settings, appTheme),
    fontSize,
    lineHeight,
    lineHeightPx: codeLineHeightPx(fontSize, lineHeight),
    fontFamily: fontStackOf(settings.codeFontFamily),
    ligatures: settings.codeFontLigatures === true,
    showLineNumbers: settings.codeShowLineNumbers !== false,
  }
}

/** 主题展示名（供 Monaco `defineTheme` 之外的地方取 label，如设置页卡片） */
export function codeThemeDisplayName(id: string): string {
  return codeThemeOf(id).label
}

/** 主题清单（设置页按表渲染，顺序 = 对象字面量顺序） */
export function listCodeThemes(): { id: string; label: string; kind: 'dark' | 'light' }[] {
  return Object.entries(CODE_THEMES).map(([id, palette]) => ({
    id,
    label: palette.label,
    kind: palette.kind,
  }))
}
