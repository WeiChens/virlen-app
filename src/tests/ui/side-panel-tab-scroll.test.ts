// @vitest-environment node
/**
 * 标签栏「滚轮 → 横向」换算（`tab-scroll.ts`）的口径。
 *
 * 钉住四条：
 * 1. 溢出时纵向滚轮落到横向 `scrollLeft`，且夹在 `[0, max]`；
 * 2. 不溢出（含还没布局，量到 0）返回 `null` —— 不拦，滚轮该继续去滚外层；
 * 3. 已经是横向手势（`deltaX` 占优）返回 `null` —— 浏览器自己会滚，别加双倍速；
 * 4. `deltaMode` 1（行）/ 2（页）要按行高 / 可视宽折算，不能当像素用。
 */
import { expect, it } from 'vitest'
import { wheelScrollLeft } from '@/ui/pages/chat/components/side-panel/tab-scroll'

const box = (scrollLeft = 0, clientWidth = 200, scrollWidth = 600) => ({
  scrollLeft,
  clientWidth,
  scrollWidth,
})

it('溢出时：纵向滚轮推横向滚动', () => {
  expect(wheelScrollLeft(box(100), { deltaX: 0, deltaY: 60, deltaMode: 0 })).toBe(160)
  expect(wheelScrollLeft(box(100), { deltaX: 0, deltaY: -40, deltaMode: 0 })).toBe(60)
})

it('夹在两端：滚过头就停在 0 / max', () => {
  expect(wheelScrollLeft(box(10), { deltaX: 0, deltaY: -100, deltaMode: 0 })).toBe(0)
  expect(wheelScrollLeft(box(390), { deltaX: 0, deltaY: 100, deltaMode: 0 })).toBe(400)
})

/** 这一条是「滚到两端时滚轮不能穿透去滚聊天区」的靠山：到头了也照样返回目标值 */
it('已经到头仍然返回目标值（拦不拦与滚没滚动无关）', () => {
  expect(wheelScrollLeft(box(0), { deltaX: 0, deltaY: -100, deltaMode: 0 })).toBe(0)
  expect(wheelScrollLeft(box(400), { deltaX: 0, deltaY: 100, deltaMode: 0 })).toBe(400)
})

it('标签都放得下：不拦（返回 null）', () => {
  expect(wheelScrollLeft(box(0, 200, 200), { deltaX: 0, deltaY: 100, deltaMode: 0 })).toBeNull()
  // jsdom / 还没布局：量到 0
  expect(wheelScrollLeft(box(0, 0, 0), { deltaX: 0, deltaY: 100, deltaMode: 0 })).toBeNull()
})

it('横向手势（触控板横滑 / Shift+滚轮）：不拦，交给浏览器', () => {
  expect(wheelScrollLeft(box(100), { deltaX: 40, deltaY: 0, deltaMode: 0 })).toBeNull()
  expect(wheelScrollLeft(box(100), { deltaX: -40, deltaY: 10, deltaMode: 0 })).toBeNull()
})

it('deltaMode 1 按行高、2 按可视宽折算', () => {
  // 3 行 × 30px
  expect(wheelScrollLeft(box(0), { deltaX: 0, deltaY: 3, deltaMode: 1 })).toBe(90)
  // 1 页 = 可视宽 200
  expect(wheelScrollLeft(box(0), { deltaX: 0, deltaY: 1, deltaMode: 2 })).toBe(200)
})
