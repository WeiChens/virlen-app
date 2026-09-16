/**
 * a11y — 无障碍小工具
 *
 * 背景：设置页的列表行/卡片为了点击手感是用 <div onClick> 实现的，
 * 但 <div> 不可聚焦、也不响应键盘 → 键盘用户完全无法操作。
 *
 * 这些行里往往又含有操作按钮（如「删除」），因此**不能**给整行加
 * role="button"（ARIA 不允许按钮嵌套按钮）。做法是把可聚焦的
 * 「主体」子元素标成按钮，操作按钮作为它的兄弟节点：
 *
 *   <div className="row">
 *     <div className="row-main" role="button" tabIndex={0}
 *          onClick={open}
 *          onKeyDown={rowKeyHandler(open)} />
 *     <button className="row-delete" onClick={del}>删除</button>
 *   </div>
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
