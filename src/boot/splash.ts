/**
 * boot/splash.ts — 入场启动屏的唯一操作者（纯 DOM；只依赖一个纯函数模块 `ui/theme/accentPalette`）。
 *
 * 启动屏本体在 `index.html` 里**内联**（HTML + CSS 动画）：窗口由 Rust 的 setup 立刻 show，
 * 而首帧要等 JS bundle 解析 + `init()` 那串 IPC 跑完，中间是纯白 —— 内联的那块是唯一能在
 * 「JS 还没执行」时就已经画出来的东西。
 *
 * 结构分两块（见 index.html）：
 * - `#boot-cover`    —— 整块遮罩（淡出 / 移除的单元）；
 * - `#boot-titlebar` —— 同款自绘标题栏，加载期间窗口照样能拖 / 最小化 / 关闭；
 * - `#boot-splash`   —— 内容区（logo + 进度 + 文案），**从标题栏下方开始**绝不压住它。
 * 所以 `done()` 作用于 cover，`fail()` 只作用于内容区（失败时标题栏必须还能用）。
 *
 * ⚠️ 约定：这些节点不存在时（浏览器 dev、单测、旧 index.html）全部静默 no-op ——
 *    启动屏是增强项，任何一步都不许抛错把启动流程带崩。
 */

// 主题色的派生系数只此一份（theme.scss / accentPalette 对拍过），启动屏不能另算一遍
import { accentTokens, DEFAULT_ACCENT, normalizeHex } from '@/ui/theme/accentPalette'

const COVER_ID = 'boot-cover'
const SPLASH_ID = 'boot-splash'
const TEXT_ID = 'boot-splash-text'
const BAR_ID = 'boot-splash-bar'
const ERROR_ID = 'boot-splash-error'
const ERROR_TEXT_ID = 'boot-splash-error-text'
const RETRY_ID = 'boot-splash-retry'
const MIN_ID = 'boot-min'
const MAX_ID = 'boot-max'
const CLOSE_ID = 'boot-close'

/**
 * 进度条的绘制区间：8% – 92%。
 * 头留 8% 是为了「一启动就有进展」的观感，尾留 8% 是因为最后几步（默认 Agent、托盘）
 * 的耗时完全不可控 —— 早早到 100% 却还停在那里，比慢一点更让人焦躁。
 */
const PROGRESS_FLOOR = 0.08
const PROGRESS_CEILING = 0.92

/** 淡出兜底时长（transition 被「减弱动态效果」关掉时 transitionend 不触发） */
const LEAVE_FALLBACK_MS = 400

/** 失败态文案由调用方注入：本模块不 import i18n，保证它在启动最早期也不带依赖 */
export interface SplashFailLabels {
  /** 一句总述（如「启动没有完成，请重试」） */
  message: string
  /** 重试按钮文案 */
  retry: string
}

function byId<T extends HTMLElement>(id: string): T | null {
  if (typeof document === 'undefined') return null
  return document.getElementById(id) as T | null
}

function splashNode(): HTMLElement | null {
  return byId<HTMLElement>(SPLASH_ID)
}

function coverNode(): HTMLElement | null {
  return byId<HTMLElement>(COVER_ID)
}

/** 直接画绝对百分比（0–1），不做区间映射 */
function paint(pct: number): void {
  const bar = byId(BAR_ID)
  if (!bar) return
  const safe = Number.isFinite(pct) ? Math.min(1, Math.max(0, pct)) : 0
  bar.style.width = `${(safe * 100).toFixed(1)}%`
}

/** 写一行状态文案（空串 = 清空，回到「只有动画」的状态） */
function setText(text: string): void {
  const node = byId(TEXT_ID)
  if (node) node.textContent = text
}

/**
 * 推进进度。`ratio` 是「已完成比例」（0–1，可超过 1 也不会溢出）：
 * 内部映射到 8%–92%，所以调用方不必知道最终会画多宽。
 */
function setProgress(ratio: number): void {
  const safe = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0
  paint(PROGRESS_FLOOR + (PROGRESS_CEILING - PROGRESS_FLOOR) * safe)
}

/** 收尾：补满进度条 → 淡出 → 从 DOM 移除（幂等，重复调用无副作用） */
function done(): void {
  // 作用于整块遮罩：标题栏与内容区一起淡出，交给 App 自己的标题栏接手
  const node = coverNode() ?? splashNode()
  if (!node) return
  paint(1)
  if (node.dataset.leaving === 'true') return
  node.dataset.leaving = 'true'
  const remove = () => node.remove()
  node.addEventListener('transitionend', remove, { once: true })
  // 兜底：动画/过渡被系统设置禁用时 transitionend 永远不来
  setTimeout(remove, LEAVE_FALLBACK_MS)
}

/**
 * 失败收口：停在启动屏上，把错误与重试入口摆出来。
 * 只动内容区（`#boot-splash`），**不动标题栏** —— 走到这一步时用户最需要能把窗口关掉。
 * 「重试」用整页 reload —— 启动流程是一次性的组合根，局部重来没有意义。
 */
function fail(error: unknown, labels: SplashFailLabels): void {
  const node = splashNode()
  if (!node) return
  node.dataset.failed = 'true'

  const detail = error instanceof Error ? error.message : error ? String(error) : ''
  const box = byId(ERROR_ID)
  if (box) box.hidden = false
  const messageNode = byId(ERROR_TEXT_ID)
  if (messageNode) {
    messageNode.textContent = detail ? `${labels.message}\n${detail}` : labels.message
  }
  const retry = byId<HTMLButtonElement>(RETRY_ID)
  if (retry) {
    retry.textContent = labels.retry
    retry.onclick = () => window.location.reload()
  }
}

/** 启动屏（含标题栏）此刻是否还在 DOM 里（测试 / 诊断用） */
function isPresent(): boolean {
  return (coverNode() ?? splashNode()) !== null
}

/**
 * 把用户的主题色 / 深浅档涂到启动屏（index.html 的样式读这三个 CSS 变量）。
 *
 * 调用时机：`main.ts` 的 `settings` 步骤之后（那时 `app_settings` 才水合完）。上一步是
 * `index.html` 内联脚本按缓存涂的**近似值**（缓存说明见 `ui/theme/bootAppearance.ts`），
 * 这里用真值覆盖：令牌值来自 `accentTokens`，与 App 标题栏用的是同一套系数。
 *
 * 节点已经移除也照设不误（变量在 `:root` 上），所以不需要判存在性。
 */
function applyAppearance(accentColor: string, theme: 'light' | 'dark'): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  // 深浅档也要写：可能是用户强制档，与系统深浅不一致（CSS 靠这个属性选档）
  root.setAttribute('data-boot-theme', theme)
  try {
    const tokens = accentTokens(normalizeHex(accentColor) ?? DEFAULT_ACCENT, theme)
    root.style.setProperty('--boot-accent', tokens['--primary'])
    root.style.setProperty('--boot-bar', tokens['--primary-bar'])
    root.style.setProperty('--boot-bar-fg', tokens['--primary-bar-fg'])
  } catch {
    // 脏色不应该走到这里（normalizeHex 已兜底），真抛了就用 index.html 的内置靛蓝
  }
}

/** 窗口按钮需要的最小接口（由 `main.ts` 传 `getCurrentWindow()` 进来，本模块不 import Tauri） */
export interface SplashWindowControls {
  minimize(): Promise<void> | void
  toggleMaximize(): Promise<void> | void
  close(): Promise<void> | void
}

/**
 * 绑定标题栏上的三枚窗口按钮（幂等）。
 *
 * 为什么在这里绑而不在 HTML 里内联脚本：那需要碰 `__TAURI_INTERNALS__` 这类内部 API；
 * 拖拽不需要 —— `data-tauri-drag-region` 由 Tauri 自己处理，所以 bundle 解析期间
 * （几百毫秒）窗口已经能拖、只是按钮还没反应。
 *
 * 关闭按钮走 `Window.close()` 而不是直接退出：托盘开启时「关闭 ≠ 退出」的判定在 Rust 侧。
 * 幂等标记放在**节点**上而不是模块变量：模块变量一旦置位，DOM 被整体替换后（热重载 / 单测）
 * 就再也不会绑了。
 */
function bindWindowControls(win: SplashWindowControls): void {
  const root = coverNode() ?? splashNode()
  if (!root || root.dataset.controlsBound === '1') return
  const min = byId<HTMLButtonElement>(MIN_ID)
  const max = byId<HTMLButtonElement>(MAX_ID)
  const close = byId<HTMLButtonElement>(CLOSE_ID)
  if (!min && !max && !close) return
  root.dataset.controlsBound = '1'
  min?.addEventListener('click', () => void win.minimize())
  max?.addEventListener('click', () => void win.toggleMaximize())
  close?.addEventListener('click', () => void win.close())
}

export const bootSplash = {
  setText,
  setProgress,
  done,
  fail,
  isPresent,
  bindWindowControls,
  applyAppearance,
}
