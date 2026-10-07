/**
 * keyboardNav — 弹窗「只用键盘也能完成操作」的统一按键约定，全应用共用一套
 * （当前：授权确认弹窗 `modals/authorization`、AI 选择弹窗 `modals/user-choice`；新增弹窗照办）：
 *
 *   Enter            → 确定（默认焦点即在「确定/允许执行」上）
 *   Esc              → 取消
 *   Tab / Shift+Tab  → 环形切换项，不跑出弹窗
 *   ↑ ↓ ← →          → 环形切换项，与 Tab 等价
 *
 * 这里只收「按了哪个键 → 往第几项走」的**纯计算**：不碰 DOM、不持状态，可脱离 React 单测
 * （真实焦点流转见 modal-keyboard.test.tsx）。
 */

/**
 * 按键对应的移动意图：+1 下一项、-1 上一项、0 与「切换项」无关。
 * Tab 与方向键刻意等价（「按 Tab 和按 ↓ 行为一致」），不要拆开。
 * 注意：调用方若已把 Tab 交给别处（如共享 Modal 自带的焦点圈定），需先自行排除。
 */
export function navDelta(key: string, shiftKey = false): number {
  switch (key) {
    case 'Tab':
      return shiftKey ? -1 : 1
    case 'ArrowDown':
    case 'ArrowRight':
      return 1
    case 'ArrowUp':
    case 'ArrowLeft':
      return -1
    default:
      return 0
  }
}

/**
 * 环形移动：首尾相接，避免在首项按 ↑ / 末项按 ↓ 卡住。
 * `current = -1`（焦点不在列表内：停在弹窗容器上、或原项被移除）时前进取首项、后退取末项，
 * 保证「按一下一定落到某个项上」；空列表返回 -1，调用方据此跳过 focus。
 */
export function wrapIndex(
  current: number,
  delta: number,
  length: number,
): number {
  if (length <= 0) return -1
  if (current < 0 || current >= length) {
    return delta >= 0 ? 0 : length - 1
  }
  return (current + delta + length) % length
}
