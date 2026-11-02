/**
 * markdown 里 `<details>` 的开合过渡（聊天回复与文件预览共用一套 `MarkdownRenderer`）。
 *
 * 为什么用 JS 而不是纯 CSS：`::details-content` + `interpolate-size: allow-keywords` 目前只有新版
 * Chromium 认（Safari / Firefox 没有，Linux 的 WebKitGTK 更老），而 Tauri 各平台 WebView 版本不在我们
 * 手里 —— 纯 CSS 只能在 Windows 上生效，Mac / Linux 用户看到的是瞬间开合。改成接管 summary 的点击、
 * 用 Web Animations API 对 `height` 做插值，所有 WebView 表现一致。
 *
 * 三条口径：
 * 1. **先 preventDefault 再自己动**：不接管的话 UA 会立刻把内容 display:none（收起）或直接展开，
 *    既量不到高度也看不到过程；
 * 2. **动画期间 details 始终 open**：收起的动画要先把内容留在树上才看得见，`onfinish` 时再落到真正的
 *    open 状态；
 * 3. `prefers-reduced-motion: reduce` 时完全不接管，原样交给浏览器（瞬时开合）。
 *
 * 事件用委托（挂在 markdown 容器上）而不是逐个元素绑定：流式回复 / 虚拟列表里的块会反复重建，委托只挂一次。
 */

/** 动画时长：够看清过渡，又不拖沓（与全局其它过渡同一档） */
export const FOLD_MS = 180

/** 缓动：起手快、收尾稳（与项目里其它 0.2s 过渡同一手感） */
const EASING = 'cubic-bezier(0.2, 0, 0.2, 1)'

/** 动画期间挂在 details 上的类（样式只负责裁剪，见 markdown-renderer.scss） */
const FOLDING_CLASS = 'is-folding'

/** 每个 details 当前正在跑的动画：连点时先 cancel 上一段，否则两段动画会抢同一个 height */
const running = new WeakMap<HTMLDetailsElement, Animation>()

function prefersReducedMotion(): boolean {
  return (
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/** 事件目标 → 它所属的 `<details>`（点的是 summary 才算；点正文不接管） */
function detailsOf(target: EventTarget | null): HTMLDetailsElement | null {
  if (!(target instanceof Element)) return null
  // 用 tagName 而不是 `instanceof HTMLDetailsElement`：测试环境（happy-dom）不一定有那个构造函数
  const parent = target.closest('summary')?.parentElement
  return parent && parent.tagName === 'DETAILS' ? (parent as HTMLDetailsElement) : null
}

/** 目标状态（展开 / 收起）下的自然高度；量完把 open 置回 true（动画期间必须展开） */
function targetHeight(details: HTMLDetailsElement, opening: boolean): number {
  details.open = opening
  const height = details.getBoundingClientRect().height
  details.open = true
  return height
}

/**
 * 开合一个 `<details>`，带高度过渡。
 * @param opening true = 展开，false = 收起
 *
 * 没有 WAAPI（极老的 WebView）或高度没变化（空折叠块）时直接落到终态，不硬撑动画。
 */
export function foldDetails(details: HTMLDetailsElement, opening: boolean): void {
  // 上一段动画可能还在跑：先取消（oncancel 会摘掉裁剪类），再按当前真实高度重新起步
  running.get(details)?.cancel()
  const from = details.getBoundingClientRect().height

  const to = targetHeight(details, opening)
  // 高度没变化（空折叠块）或环境没有 WAAPI（极老 WebView）：直接落到终态，不硬撑动画
  if (Math.abs(from - to) < 1 || typeof details.animate !== 'function') {
    details.open = opening
    return
  }

  details.classList.add(FOLDING_CLASS)
  const anim = details.animate(
    [{ height: `${from}px` }, { height: `${to}px` }],
    { duration: FOLD_MS, easing: EASING },
  )
  running.set(details, anim)

  anim.onfinish = () => {
    details.open = opening
    details.classList.remove(FOLDING_CLASS)
    running.delete(details)
  }
  anim.oncancel = () => {
    // 只清理本段动画加上的裁剪类，终态交给新一局动画（或直接是用户自己改了 open）
    details.classList.remove(FOLDING_CLASS)
    running.delete(details)
  }
}

/** 点击目标是否落在「自己有交互」的元素上（链接 / 按钮） */
function hasInteractive(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('a, button') !== null
}

/**
 * 在容器上挂 `<details>` 折叠过渡（委托）。
 * @returns 卸载函数（`useEffect` 里直接 return）
 */
export function attachDetailsFold(root: HTMLElement): () => void {
  const onClick = (event: MouseEvent) => {
    // summary 里的链接 / 按钮有自己的事要做，不抢（否则链接点不动）
    if (hasInteractive(event.target)) return
    const details = detailsOf(event.target)
    if (!details || prefersReducedMotion()) return
    // 接管默认开合：不 preventDefault 就看不到过渡。
    // 监听在**捕获阶段**：要在任何人（含 UA / 测试环境）改动 `open` 之前读到点击前的真实状态。
    event.preventDefault()
    foldDetails(details, !details.open)
  }

  root.addEventListener('click', onClick, true)
  return () => root.removeEventListener('click', onClick, true)
}
