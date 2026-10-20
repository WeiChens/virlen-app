/**
 * 界面缩放（webview zoom）的解析层。
 *
 * 职责边界：本文件**纯函数**，不碰 DOM、不碰 Tauri —— 设置页（滑杆 / 百分比）
 * 与 `ui/hooks/useZoom.ts`（真正调 `setZoom`）都从这里取同一套口径。
 *
 * 为什么不走 CSS（`html { zoom }` / `transform: scale`）：CSS 缩放只改绘制结果，
 * 不动 webview 的 CSS 像素比 —— Monaco 的 canvas、fixed 定位的浮层、以及依赖
 * `getBoundingClientRect` 的拖拽 / 侧边栏命中区都会各算一套，越放越错位。
 * 原生 `setZoom` 是真正的页面缩放（等价浏览器 Ctrl +/-），全应用一致。
 */

/** 缩放下限：再小正文就掉到 7px 以下，读不了 */
export const ZOOM_MIN = 0.5
/** 缩放上限：再大布局（侧栏 + 内容区）就挤成一条 */
export const ZOOM_MAX = 2
/** 滑杆步长 5%：够细，又不会让一次拖动产生上百次落库 */
export const ZOOM_STEP = 0.05
/** 快捷键步长 10%：跟浏览器一档的量级（5% 要按太多次，20% 一跳太粗） */
export const ZOOM_KEY_STEP = 0.1
/** 默认 100% */
export const DEFAULT_ZOOM = 1

/**
 * 把任意来源的值规整成可用的缩放值：越界夹紧、脏数据回落默认。
 *
 * 保留两位小数是必须的：滑杆的 step=0.05 累加 / `String(1.05)` 都可能带出
 * `1.0500000000000003` 这种尾巴，直接存进去会被 `settings.change` 埋点放大成噪音。
 */
export function normalizeZoom(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_ZOOM
  const rounded = Math.round(n * 100) / 100
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, rounded))
}

/** 百分比展示值（设置页滑杆右侧的「125%」） */
export function zoomPercent(value: unknown): number {
  return Math.round(normalizeZoom(value) * 100)
}

/** 快捷键动作：放大 / 缩小 / 回到 100% */
export type ZoomCommand = 'in' | 'out' | 'reset'

/**
 * 在当前值上执行一次快捷键动作。
 *
 * 一律走 `normalizeZoom`：快捷键永远碰不到 ZOOM_MIN / ZOOM_MAX 之外 ——
 * 「缩太大、滑杆够不着、调不回来」的第一道防线在这里（第二道是 Ctrl+0）。
 */
export function applyZoomCommand(
  current: unknown,
  command: ZoomCommand,
): number {
  if (command === 'reset') return DEFAULT_ZOOM
  const step = command === 'in' ? ZOOM_KEY_STEP : -ZOOM_KEY_STEP
  return normalizeZoom(normalizeZoom(current) + step)
}

/**
 * 从键盘事件里认出缩放指令（不是缩放键则返回 null）。
 *
 * 只收 Ctrl（Windows/Linux）与 Cmd（macOS）：Alt / 无修饰键留给别的功能。
 * 同一条「放大」认三个来源 —— `+`（Shift+= / 小键盘）、`=`（Ctrl+= 是最顺手的按法，
 * 用户不会先按住 Shift）、以及 `code` —— 非拉丁键盘布局下 `key` 可能是别的字符，
 * 但物理键位仍是 Equal / Minus。
 */
export function zoomCommandOf(e: {
  key?: string
  code?: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
}): ZoomCommand | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null
  const key = e.key ?? ''
  const code = e.code ?? ''
  if (key === '+' || key === '=' || code === 'Equal' || code === 'NumpadAdd') {
    return 'in'
  }
  if (key === '-' || key === '_' || code === 'Minus' || code === 'NumpadSubtract') {
    return 'out'
  }
  if (key === '0' || code === 'Digit0' || code === 'Numpad0') return 'reset'
  return null
}
