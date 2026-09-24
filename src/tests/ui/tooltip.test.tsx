/**
 * Tooltip — 气泡提示
 *
 * 重点覆盖 `disabled` 这个开关：右键菜单弹出时鼠标还停在元素上（不会触发
 * mouseleave），若不禁用，气泡会以 z-index 9999 盖在菜单（600）上面。
 */
import { expect, it } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import Tooltip from '@/ui/components/shared/Tooltip'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

async function render(node: React.ReactNode) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(node)
  })
  return { host, root }
}

const bubble = (): HTMLElement | null =>
  document.querySelector('.tooltip-bubble')

/**
 * 触发 React 的 `onMouseEnter`。
 *
 * React 17+ 不再监听 `mouseenter`，而是由 `mouseover`/`mouseout` 合成 enter/leave，
 * 所以必须派发 `mouseover`（`relatedTarget` 为 null = 从元素外进入）。
 */
async function hover(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  })
}

it('hover 显示气泡，多行按行拆开', async () => {
  const { root } = await render(
    <Tooltip content={'第一行\n第二行'}>
      <button>hover me</button>
    </Tooltip>,
  )

  expect(bubble()).toBeNull()
  await hover(document.querySelector('.tooltip-wrapper')!)
  expect(bubble()!.textContent).toBe('第一行第二行')
  expect(bubble()!.querySelectorAll('div')).toHaveLength(2)

  await act(async () => root.unmount())
})

it('disabled：hover 也不显示（气泡不会先冒出来再被盖住）', async () => {
  const { root } = await render(
    <Tooltip content="提示" disabled>
      <button>hover me</button>
    </Tooltip>,
  )

  await hover(document.querySelector('.tooltip-wrapper')!)
  expect(bubble()).toBeNull()

  await act(async () => root.unmount())
})

it('disabled 从 false 变 true：已显示的气泡立刻收掉（右键菜单弹出的那一刻）', async () => {
  const node = (disabled: boolean) => (
    <Tooltip content="提示" disabled={disabled}>
      <button>hover me</button>
    </Tooltip>
  )
  const { root } = await render(node(false))

  await hover(document.querySelector('.tooltip-wrapper')!)
  expect(bubble()).not.toBeNull()

  // 相当于「右键菜单打开」：鼠标没离开元素，靠事件收不掉，只能靠 disabled
  await act(async () => {
    root.render(node(true))
  })
  expect(bubble()).toBeNull()

  // 菜单关闭 → 恢复可提示
  await act(async () => {
    root.render(node(false))
  })
  expect(bubble()).not.toBeNull()

  await act(async () => root.unmount())
})
