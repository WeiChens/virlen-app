/**
 * 行内改高时的「按住滚动偏移」状态机（与虚拟库解耦，便于单测）。
 *
 * 为什么需要：用户气泡的「显示更多 / 收起」会改**这一行的高度**，而本列表在贴底状态下有一套跟底语义
 * （`use-virtual-list` 的 `anchorTo: 'end'` + `scrollEndThreshold: AT_BOTTOM_THRESHOLD`）：
 * 任何条目尺寸变化都会把「高度差」补偿进 scrollTop。展开一条超长消息时，那笔补偿正好等于
 * 被展开出来的整块高度 —— 用户看到的就是**阅读位置被甩到消息底部**（贴住底部不动）。
 *
 * 按住 = 在这笔补偿写出去之前拦下来，改写成「按住的偏移」：
 *  · 拦下后 DOM 一次都不动，所以连一帧的跳动都不会有（补偿与改写发生在同一个回调里）；
 *  · 用户的滚动走 scroll 事件、不经过补偿这条路，因此不会被按住跟用户较劲；
 *  · 库随后会把内部偏移加上这笔补偿量（`applyScrollAdjustment` 在 `scrollToFn` 之后才改它），
 *    所以调用方还要在 `onChange` 里用 `consumeIntercepted()` 把内部偏移按回去 ——
 *    否则下一帧会按错的偏移算渲染范围（视口空一块 / 渲染错行）。
 *
 * 自愈：窗口到点自动失效（`SCROLL_HOLD_MS`），不依赖调用方记得松开。窗口定得短是因为它只覆盖
 * 「ResizeObserver → rAF」那两帧；而且拦下的只是**补偿类**写入，跳转 / 平滑滚动 / 贴底按钮都不受影响。
 */

/** 按住窗口（ms）：库的尺寸补偿走 RO → rAF（≤2 帧），200ms 足够覆盖又不至于按住太久 */
export const SCROLL_HOLD_MS = 200

export interface ScrollHold {
  /** 记住当前偏移（= 要按住的值）并开启一个窗口；重复调用 = 以最新偏移重新按住 */
  arm(scrollTop: number): void
  /** 当前按住的偏移（窗口外 → null） */
  held(): number | null
  /**
   * 库这次要写出的补偿量是否该被拦住。
   * 只认 `adjustments` 非 0 的写入 —— 那正是「尺寸补偿」这条路（跳转 / 平滑滚动 / 贴底都是 0 / 不带）。
   * 返回「要改写成的偏移」（不需要拦 → null），并记下「刚拦下一笔」供 `consumeIntercepted` 消费。
   */
  intercept(adjustments: number | undefined): number | null
  /** 取走「刚拦下一笔补偿」并把要按回的偏移交给调用方（没拦过 → null） */
  consumeIntercepted(): number | null
}

/**
 * @param now 取当前时间（默认 `Date.now`）；用例注入假时钟即可测「窗口到点自愈」
 */
export function createScrollHold(now: () => number = Date.now): ScrollHold {
  let offset: number | null = null
  let until = 0
  let intercepted = false

  const held = () => (offset !== null && now() < until ? offset : null)

  return {
    arm(scrollTop) {
      offset = scrollTop
      until = now() + SCROLL_HOLD_MS
    },
    held,
    intercept(adjustments) {
      const value = held()
      if (value === null || !adjustments) return null
      intercepted = true
      return value
    },
    consumeIntercepted() {
      if (!intercepted) return null
      intercepted = false
      return held()
    },
  }
}
