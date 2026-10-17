/**
 * VirtualList — 窗口化列表（面板的变更列表与差异弹窗的左清单共用）。
 *
 * 守四条「错了会很难受」的口径：
 * 1. **行数多就只渲染窗口**：5000 行不能真铺 5000 个 DOM（这正是本组件存在的理由）；
 * 2. **上下留白撑出滚动高度**：滚动条长度不能因为窗口化而变成「只有一屏」；
 * 3. **滚动窗口跟着走**：滚到中间时第一行不再是第 0 行；
 * 4. **量不到视口高度就全量渲染**：首帧 / jsdom 里 `clientHeight` 是 0，不能因此白屏。
 */
import { afterEach, beforeEach, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import VirtualList from '@/ui/pages/chat/components/git/VirtualList'

;(globalThis as never as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

let root: ReturnType<typeof createRoot> | null = null

const items = Array.from({ length: 5000 }, (_, i) => `row-${i}`)
const heights = items.map(() => 20)

function mount(count = items.length, withViewport = true): HTMLDivElement {
  // jsdom 没有布局：这里给一个「有高度」的视口，否则一律退化成全量渲染
  if (withViewport) {
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get: () => 300,
    })
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() =>
    root!.render(
      <VirtualList
        className="list"
        items={items.slice(0, count)}
        heights={heights.slice(0, count)}
        render={(item) => (
          <div className="row" key={item}>
            {item}
          </div>
        )}
      />,
    ),
  )
  return document.querySelector('.list') as HTMLDivElement
}

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => 0,
  })
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

it('行数多时只渲染窗口（不是 5000 行）', () => {
  const list = mount()
  const rows = list.querySelectorAll('.row')
  expect(list.dataset.virtualized).toBe('true')
  expect(rows.length).toBeGreaterThan(0)
  expect(rows.length).toBeLessThan(60)
  // 第一屏从第 0 行开始
  expect(rows[0].textContent).toBe('row-0')
})

it('上下留白撑出完整滚动高度', () => {
  const list = mount()
  const spacers = [...list.querySelectorAll(':scope > div[aria-hidden]')] as HTMLElement[]
  const rendered = list.querySelectorAll('.row').length
  const spacerHeight = spacers.reduce((sum, el) => sum + parseFloat(el.style.height), 0)
  // 视口 300 + 上下 overscan 的余量之外，其余高度都由留白补上
  expect(spacerHeight).toBeGreaterThan(5000 * 20 - 300 - 20 * 20)
  expect(rendered * 20 + spacerHeight).toBe(5000 * 20)
})

it('滚动后窗口跟着走（首行不再是第 0 行）', () => {
  const list = mount()
  act(() => {
    list.scrollTop = 20000
    list.dispatchEvent(new Event('scroll'))
  })
  const rows = [...list.querySelectorAll('.row')]
  expect(rows[0].textContent).not.toBe('row-0')
  // 滚动位置 ≈ 20000/20 = 1000 行，窗口第一行应在它之前一点（overscan）
  const first = Number(rows[0].textContent!.replace('row-', ''))
  expect(first).toBeGreaterThan(980)
  expect(first).toBeLessThanOrEqual(1000)
})

it('量不到视口高度就全量渲染（不白屏）', () => {
  const list = mount(200, false)
  expect(list.dataset.virtualized).toBeUndefined()
  expect(list.querySelectorAll('.row').length).toBe(200)
})

it('行数少于阈值就全量渲染', () => {
  const list = mount(20)
  expect(list.dataset.virtualized).toBeUndefined()
  expect(list.querySelectorAll('.row').length).toBe(20)
})
