/**
 * 标签栏的「滚轮 → 横向」滚动换算。
 *
 * 为什么单独一份：`.side-panel-tabs` 只有横向溢出（`overflow-y: hidden`），普通鼠标滚轮的
 * `deltaY` 打上去什么也不会发生 —— 标签一多就只能去够底下那条 4px 的滚动条。
 * 换算逻辑抽成纯函数（不碰 DOM 布局），单测可以直接构造「宽 100 内容 300」的盒子；
 * 真正的监听挂在组件里（React 的 `onWheel` 在 root 上是 passive 的，`preventDefault()` 无效）。
 */

/** 判断是否溢出 / 该滚到哪，只需要这三项 */
export interface TabsScrollBox {
  scrollWidth: number
  clientWidth: number
  scrollLeft: number
}

/** 滚轮事件里用得上的三个量（原生 `WheelEvent` 直接能传） */
export interface WheelDelta {
  deltaX: number
  deltaY: number
  deltaMode: number
}

/** `deltaMode: 1`（按行）时的行高：与 `.side-panel-tab` 的 30px 同口径 */
const TAB_LINE_HEIGHT = 30

/**
 * 算出这次滚轮该把 `scrollLeft` 放到哪。
 *
 * 返回 `null` = **不拦这次滚轮**（让它继续冒泡去滚外层）：
 * - 标签都放得下（含 jsdom / 还没布局，量到 0）；
 * - 已经是横向手势（触控板横滑、Shift + 滚轮）—— 浏览器自己会滚，再加一遍就双倍速。
 *
 * 只要溢出且是纵向手势就一定返回目标值（哪怕已经到头）：拦截与否跟「滚没滚动」无关，
 * 否则滚到两端时滚轮会突然穿透去滚聊天区（鼠标停在标签栏上却让对话跳动）。
 */
export function wheelScrollLeft(box: TabsScrollBox, event: WheelDelta): number | null {
  const max = box.scrollWidth - box.clientWidth
  if (max <= 0) return null
  if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return null

  // deltaMode: 0 = 像素、1 = 行、2 = 页
  const unit =
    event.deltaMode === 1 ? TAB_LINE_HEIGHT : event.deltaMode === 2 ? box.clientWidth : 1
  const next = box.scrollLeft + event.deltaY * unit
  return Math.min(max, Math.max(0, next))
}
