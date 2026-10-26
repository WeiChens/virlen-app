/**
 * popoverFit — 把「挂在标题栏按钮上的定宽浮层」夹进窗口可视区。
 *
 * 适用对象：任务清单浮层（`.todo-popover`，680px）、源代码管理浮层（`.git-popover`，420px）——
 * 它们都是 `position: absolute; right: 0` 定位在工具栏图标上的**定宽**气泡，两个方向都会越界：
 * - **横向**：`right: 0` 只保证右缘贴住触发按钮，而按钮右边还有别的图标（后台服务 / 工作目录 / 面板），
 *   所以左缘 = 按钮右缘 − 680；窗口一窄（未最大化、分屏）左缘就跑出窗口，内容被窗口裁掉；
 * - **纵向**：高度随内容涨（清单行数、变更数、hooks / 网络输出块），窗口一矮底缘就跑出窗口，
 *   底部那几个「应用变更 / 提交」按钮直接看不到。
 *
 * 口径与 `ContextMenu`（右键菜单）/ `Select`（下拉）一致：打开时与窗口 resize 时**实测**一次，
 * 把溢出量算成位移；区别只在纵向 —— 这几个气泡贴着标题栏往下展开，**上面没有空间可翻**，
 * 所以不给「翻到上面」那一档，改成压 `max-height` 让它自己滚（够不着底部按钮比多一条滚动条更糟）。
 */
import { useCallback, useLayoutEffect, useRef, useState } from 'react'

/** 气泡与窗口边缘的安全距离（px） */
export const POPOVER_VIEWPORT_MARGIN = 8

export interface PopoverRect {
  left: number
  right: number
  top: number
  height: number
}

export interface PopoverFit {
  /** 向右的位移（px）；负数 = 往左。0 = 原位不动 */
  shiftRight: number
  /** 高度上限（px）；`null` = 量不到视口 / 没有布局引擎，不设 */
  maxHeight: number | null
}

export const POPOVER_FIT_NONE: PopoverFit = { shiftRight: 0, maxHeight: null }

/**
 * 溢出 → 位移。纯函数，不碰 DOM（用例直接喂矩形）。
 *
 * 横向只判一次：左缘溢出优先（`right: 0` 的气泡只可能往左越界），右缘那一支兜住
 * 「触发器自己就贴在窗口右边外」的极端情形（拖动窗口时可能出现一帧）。
 */
export function fitPopoverInViewport(
  rect: PopoverRect,
  viewport: { width: number; height: number },
  margin = POPOVER_VIEWPORT_MARGIN,
): PopoverFit {
  // 视口量不到（jsdom / SSR）：别拿 0 当真值算出一堆位移
  if (!viewport.width || !viewport.height) return POPOVER_FIT_NONE
  // 元素自己没尺寸（jsdom 的假 rect 全是 0）：同样视为「没有布局」，原样返回
  if (!rect.height) return POPOVER_FIT_NONE

  let shiftRight = 0
  if (rect.left < margin) shiftRight = margin - rect.left
  else if (rect.right > viewport.width - margin) {
    shiftRight = viewport.width - margin - rect.right
  }

  /* 高度上限只由「气泡顶边到窗口底边」决定，**与当前高度无关** —— 这条让夹紧是幂等的：
     量一次、改一次、再量还是同一个值，窗口来回 resize 不会反复松紧。 */
  const maxHeight = Math.max(0, viewport.height - margin - rect.top)

  return { shiftRight, maxHeight }
}

export interface PopoverFitBinding {
  /** 挂到气泡容器上（量的是它自己的矩形） */
  ref: React.RefObject<HTMLDivElement | null>
  /** 摊到气泡容器上 */
  style: React.CSSProperties
}

/**
 * 气泡的「不出窗」绑定：返回 `ref` + 内联样式。
 *
 * ⚠️ 位移写成 `right` 的**相对偏移**（CSS 里是 `right: 0`，见两份 style.scss）：换锚点
 * （比如改成 `left: 0` 或居中对齐）必须同步这里，否则位移方向反了。
 */
export function usePopoverViewportFit(open: boolean): PopoverFitBinding {
  const ref = useRef<HTMLDivElement | null>(null)
  const [fit, setFit] = useState<PopoverFit>(POPOVER_FIT_NONE)
  /** 已经施加到 DOM 上的位移：再量时要把这部分加回去，否则「量到的是夹过的位置」，一次 resize 就把位移清零 */
  const appliedRef = useRef(0)

  const measure = useCallback(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const applied = appliedRef.current
    const next = fitPopoverInViewport(
      {
        left: rect.left - applied,
        right: rect.right - applied,
        top: rect.top,
        height: rect.height,
      },
      { width: window.innerWidth, height: window.innerHeight },
    )
    appliedRef.current = next.shiftRight
    // 值没变就不要 setState：resize 连续触发时没必要每帧重渲染
    setFit((prev) =>
      prev.shiftRight === next.shiftRight && prev.maxHeight === next.maxHeight
        ? prev
        : next,
    )
  }, [])

  // 打开的第一帧就量（DOM 已提交、还没绘制），否则用户能看见一帧越界
  useLayoutEffect(() => {
    if (!open) {
      appliedRef.current = 0
      setFit(POPOVER_FIT_NONE)
      return undefined
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [open, measure])

  const style: React.CSSProperties = {}
  if (fit.shiftRight) style.right = -fit.shiftRight
  if (fit.maxHeight !== null) {
    style.maxHeight = fit.maxHeight
    style.overflowY = 'auto'
    /* ⚠️ 一个轴不是 `visible` 时另一轴会被算成 `auto`（横向因此可能冒出滚动条）——
       横向已由气泡自己的 `max-width: calc(100vw - 32px)` + 上面的位移兜住，显式关掉。 */
    style.overflowX = 'hidden'
  }

  return { ref, style }
}
