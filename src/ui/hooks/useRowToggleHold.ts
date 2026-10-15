/**
 * 「行内改高的开关」的公共动作 —— 用户气泡的「显示更多 / 收起」、工具组头、工具卡片……
 * 这些开关只改**自己这一行**的高度，而消息列表在贴底时有一套跟底语义
 * （`use-virtual-list` 的 `anchorTo: 'end'` + `scrollEndThreshold`）：条目尺寸一变，
 * 库就把「高度差」补偿进 scrollTop。展开一条超长内容时，那笔补偿正好等于被展开出来的整块高度
 * —— 用户看到的就是**阅读位置被甩到内容末尾**（贴住底部不动）。
 *
 * 两步（`hold` 是列表层给的「按住当前滚动偏移」，见 `message-list/scroll-hold.ts`）：
 *  1. 点击时先按住（`beforeToggle`）：补偿在同一个回调里被改写成「按住的偏移」，
 *     DOM 一次都不动 —— 连一帧的跳动都不会有；
 *  2. 收起方向（`willExpand === false`）：DOM 变矮之后把锚点拉回视野**并重新按住** ——
 *     行矮了一大截，视口很可能已不在这一行上；这一下滚动是我们自己发起的，不该又被补偿推走。
 *
 * 展开方向不用管：内容向下长，锚点原地不动，本来就不跳（偏移由第 1 步按住）。
 * `hold` 不传（单测 / 独立渲染这个组件）→ 两步都退化成「什么都不做」，组件照常工作。
 *
 * ⚠️ 只认**用户点击**这一条路：自动展开 / 自动收起（工具的 pending → done、默认态变化）
 * 不 caller 就不会动列表 —— 用户可能正在别处阅读。
 */
import { useCallback, useLayoutEffect, useRef } from 'react'

export function useRowToggleHold<T extends HTMLElement = HTMLElement>(
  /** 该开关**当前**是否展开（收起方向要靠它判断「真的收起来了」） */
  expanded: boolean,
  /** 列表层的「按住当前滚动偏移」（稳定引用）；不传 = 不按住 */
  hold?: () => void,
) {
  /** 挂到「收起后要保持可见」的节点上：开关自身 / 气泡根 */
  const anchorRef = useRef<T | null>(null)
  /** 这次点击是「收起」→ 等 DOM 变矮后再拉一把 */
  const collapsingRef = useRef(false)

  /**
   * 点击开关时**先**调它（在改状态之前）。
   * @param willExpand 这次点击**之后**的展开态（`false` = 收起）
   */
  const beforeToggle = useCallback(
    (willExpand: boolean) => {
      hold?.()
      collapsingRef.current = !willExpand
    },
    [hold],
  )

  useLayoutEffect(() => {
    if (!collapsingRef.current) return
    collapsingRef.current = false
    // 没收起来（例如运行中的工具组恒展开）→ 高度没变，别动列表
    if (expanded) return
    const el = anchorRef.current
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' })
    }
    hold?.()
  }, [expanded, hold])

  return { anchorRef, beforeToggle }
}
