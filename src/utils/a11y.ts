/**
 * a11y — 无障碍小工具。
 *
 * 背景：设置页列表行 / 卡片为了点击手感用 `<div onClick>` 实现，但 `<div>` 不可聚焦、也不响应键盘 →
 * 键盘用户无法操作。行里往往又含操作按钮，故**不能**给整行加 role="button"（ARIA 不允许按钮嵌套按钮）；
 * 做法：把可聚焦的「主体」子元素标成按钮，操作按钮作为它的兄弟节点。
 */
import type { KeyboardEvent } from 'react'

/** Enter / Space 触发回调，等价于鼠标点击 */
export function rowKeyHandler(activate: () => void) {
  return (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      activate()
    }
  }
}
