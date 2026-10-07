/**
 * accentPalette —— 主题色（品牌色）的**运行期**派生。
 *
 * 为什么运行期还需要这一层：用户在「设置 → 通用 → 主题色」里用取色器选的是**任意颜色**，
 * 只有运行期才知道；`ui/styles/theme.scss` 的 SCSS 函数只能在**构建期**算预设色板。
 * 两条路必须算出**同一套值** —— `src/tests/ui/accent-color-contract.test.ts` 会把
 * theme.scss 编译出来，与本模块逐令牌对拍，漂了就是红的。
 *
 * ⚠️ 改这里 = 改观感：ACCENT_MIX 与 theme.scss 的 `$accent-mix-*` **一一对应**，
 *    派生关系（亮色压暗 / 暗色提亮 / 大色块再压暗 / 前景自动黑或白）的说明见 theme.scss 文件头。
 */

/** 亮 / 暗两档（与 <html data-theme> 的取值一致） */
export type AccentTheme = 'light' | 'dark'

/** 品牌令牌名（顺序与 theme.scss 的 accent-tokens() 返回的 map 一致，方便对拍与 diff） */
export const ACCENT_TOKEN_NAMES = [
  '--primary',
  '--primary-hover',
  '--primary-soft',
  '--primary-bar',
  '--primary-bar-fg',
  '--primary-fill',
  '--primary-fg',
  '--usermsg-selected-bg',
] as const

export type AccentTokenName = (typeof ACCENT_TOKEN_NAMES)[number]

export type AccentTokens = Record<AccentTokenName, string>

/**
 * 派生系数（权重 = `mix(前者, 后者, 权重)` 里前者的占比）。
 * 与 theme.scss 的 `$accent-mix-*` 一一对应 —— 两边同时改才是改，改一边由用例拦下。
 */
export const ACCENT_MIX = {
  /** 亮色：--primary-hover = mix(brand, #000, 87%) —— 压暗一档 */
  lightHoverBrand: 0.87,
  /** 亮色：--primary-soft = mix(brand, #fff, 8%) —— 8% 品牌色薄涂 */
  lightSoftBrand: 0.08,
  /** 暗色：--primary = mix(brand, #fff, 82%) —— 提亮一档（白底挑的深色在深底上不够跳） */
  darkPrimaryBrand: 0.82,
  /** 暗色：--primary-hover = mix(brand, #fff, 66%) */
  darkHoverBrand: 0.66,
  /** 暗色：--primary-soft = mix(--primary, --bg-primary, 21%) */
  darkSoftPrimary: 0.21,
  /** 暗色：--primary-bar = mix(--primary, #000, 45%) */
  darkBarPrimary: 0.45,
  /** 暗色：--primary-fill = mix(--primary, #000, 62%) */
  darkFillPrimary: 0.62,
  /** 亮色：--usermsg-selected-bg = mix(brand, #000, 55%)（用户气泡里的选中高亮） */
  usermsgLightBrand: 0.55,
  /** 暗色：--usermsg-selected-bg = mix(brand, #fff, 45%) */
  usermsgDarkBrand: 0.45,
} as const

/** 暗色档 --bg-primary：--primary-soft 往这个底上薄涂（同 theme.scss 的 $dark-bg-primary） */
export const DARK_BG_PRIMARY = '#1e1e2e'

/** 默认品牌基色（同 theme.scss 的 $brand-default）；设置为空串 = 用它，不注入任何覆盖 */
export const DEFAULT_ACCENT = '#4f46e5'

/**
 * 预设色板（同 theme.scss 的 `$accent-presets`，含顺序）。
 * 全部是中深色 —— 前景判定后都是白字，观感统一；用户想要浅色可以自己取色（前景自动转黑）。
 */
export const ACCENT_PRESETS: ReadonlyArray<{ name: string; label: string; color: string }> = [
  { name: 'indigo', label: '靛蓝', color: '#4f46e5' },
  { name: 'blue', label: '蓝', color: '#2563eb' },
  { name: 'cyan', label: '青', color: '#0e7490' },
  { name: 'teal', label: '蓝绿', color: '#0f766e' },
  { name: 'green', label: '绿', color: '#15803d' },
  { name: 'orange', label: '橙', color: '#c2410c' },
  { name: 'purple', label: '紫', color: '#9333ea' },
  { name: 'pink', label: '粉', color: '#db2777' },
  { name: 'graphite', label: '石墨', color: '#475569' },
]

/** 品牌底上两个前景候选（同 theme.scss 的 -on-color） */
const FG_ON_LIGHT = '#ffffff'
const FG_ON_DARK = '#1a1a1a'

interface Rgb {
  r: number
  g: number
  b: number
}

const WHITE: Rgb = { r: 255, g: 255, b: 255 }
const BLACK: Rgb = { r: 0, g: 0, b: 0 }

/**
 * 规范化用户输入的颜色：支持 `#rgb` / `#rrggbb`（`#` 可省），大小写不敏感。
 * 不是合法颜色时返回 `null`（调用方据此回落到默认档，而不是把非法值写进 CSS）。
 */
export function normalizeHex(input: string): string | null {
  const raw = input.trim().replace(/^#/, '').toLowerCase()
  if (/^[0-9a-f]{3}$/.test(raw)) {
    return `#${raw[0]}${raw[0]}${raw[1]}${raw[1]}${raw[2]}${raw[2]}`
  }
  if (/^[0-9a-f]{6}$/.test(raw)) return `#${raw}`
  return null
}

/** 解析成 RGB（调用方保证已过 normalizeHex；解析不了返回 null） */
function parseRgb(hex: string): Rgb | null {
  const normalized = normalizeHex(hex)
  if (!normalized) return null
  return {
    r: Number.parseInt(normalized.slice(1, 3), 16),
    g: Number.parseInt(normalized.slice(3, 5), 16),
    b: Number.parseInt(normalized.slice(5, 7), 16),
  }
}

/** RGB → `#rrggbb` 小写（与 SCSS 侧 -hex() 一致：先取整再转） */
function toHex(c: Rgb): string {
  const pair = (n: number) => Math.round(n).toString(16).padStart(2, '0')
  return `#${pair(c.r)}${pair(c.g)}${pair(c.b)}`
}

/**
 * sRGB 空间线性混合（= SCSS 的 `color.mix(a, b, w)` / CSS 的 `color-mix(in srgb, a w%, b)`）：
 * 逐通道加权。
 *
 * ⚠️ 通道**不取整**（与 sass 的 color.mix 一致，它保留 68.73 这种小数）：
 *   中间值一旦取整，下一级派生（暗色档的 fill / bar / soft 都基于 --primary）就会把误差放大一档；
 *   取整只发生在 toHex() 输出那一步。
 */
function mixSrgb(a: Rgb, b: Rgb, weightOfA: number): Rgb {
  const w = weightOfA
  return {
    r: a.r * w + b.r * (1 - w),
    g: a.g * w + b.g * (1 - w),
    b: a.b * w + b.b * (1 - w),
  }
}

/** sRGB 单通道 → 线性值（WCAG 2.x 相对亮度的一步） */
function linearChannel(v: number): number {
  const s = v / 255
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
}

/** 相对亮度（WCAG 2.x） */
export function relativeLuminance(c: Rgb): number {
  return 0.2126 * linearChannel(c.r) + 0.7152 * linearChannel(c.g) + 0.0722 * linearChannel(c.b)
}

/** 对比度（WCAG 2.x；恒 ≥ 1） */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const hi = Math.max(la, lb)
  const lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * 底色 → 前景色：黑 / 白里对比度**更高**的那一档（同 SCSS 的 -on-color）。
 * 判"哪个更高"而不是按亮度阈值：阈值在某一段颜色上必然选错，比对比度则恒 ≥ 4.58:1。
 */
export function onColor(bg: Rgb): string {
  const white = contrastRatio(bg, WHITE)
  const black = contrastRatio(bg, { r: 26, g: 26, b: 26 })
  return white >= black ? FG_ON_LIGHT : FG_ON_DARK
}

/**
 * 派生整套品牌令牌（与 theme.scss 的 `accent-tokens()` 逐值等价）。
 * @param baseHex 品牌基色（`#rrggbb`）；@param theme light / dark
 */
export function accentTokens(baseHex: string, theme: AccentTheme): AccentTokens {
  const base = parseRgb(baseHex)
  if (!base) throw new Error(`accentTokens: 非法颜色 ${baseHex}`)
  const dark = parseRgb(DARK_BG_PRIMARY)
  if (!dark) throw new Error('accentTokens: DARK_BG_PRIMARY 不是合法颜色')

  let primary = base
  let hover = mixSrgb(base, BLACK, ACCENT_MIX.lightHoverBrand)
  let soft = mixSrgb(base, WHITE, ACCENT_MIX.lightSoftBrand)
  let bar = base
  let fill = base
  let usermsg = mixSrgb(base, BLACK, ACCENT_MIX.usermsgLightBrand)

  if (theme === 'dark') {
    primary = mixSrgb(base, WHITE, ACCENT_MIX.darkPrimaryBrand)
    hover = mixSrgb(base, WHITE, ACCENT_MIX.darkHoverBrand)
    soft = mixSrgb(primary, dark, ACCENT_MIX.darkSoftPrimary)
    bar = mixSrgb(primary, BLACK, ACCENT_MIX.darkBarPrimary)
    fill = mixSrgb(primary, BLACK, ACCENT_MIX.darkFillPrimary)
    usermsg = mixSrgb(base, WHITE, ACCENT_MIX.usermsgDarkBrand)
  }

  return {
    '--primary': toHex(primary),
    '--primary-hover': toHex(hover),
    '--primary-soft': toHex(soft),
    '--primary-bar': toHex(bar),
    '--primary-bar-fg': onColor(bar),
    '--primary-fill': toHex(fill),
    '--primary-fg': onColor(fill),
    '--usermsg-selected-bg': toHex(usermsg),
  }
}

/**
 * 生成注入用的样式文本：`--brand`（原始基色，便于排查/后续消费）+ 亮暗两档令牌。
 *
 * 选择器用 `:root[data-theme=…]`（特异性 0,2,0）而不是 `[data-theme=…]`（0,1,0）：
 * 这样既压过 theme.scss 里的默认块与 `[data-accent]` 预设块，也不受样表插入顺序影响
 * （dev 下 Vite 会在 HMR 时重插样式元素，靠顺序取胜的写法会被反超）。
 */
export function accentStyleText(baseHex: string): string {
  const hex = normalizeHex(baseHex)
  if (!hex) throw new Error(`accentStyleText: 非法颜色 ${baseHex}`)
  const decls = (theme: AccentTheme) =>
    ACCENT_TOKEN_NAMES.map((name) => `${name}: ${accentTokens(hex, theme)[name]};`).join(' ')
  return [
    `:root { --brand: ${hex}; }`,
    `:root[data-theme='light'] { ${decls('light')} }`,
    `:root[data-theme='dark'] { ${decls('dark')} }`,
  ].join('\n')
}
