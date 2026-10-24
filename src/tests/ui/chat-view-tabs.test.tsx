/**
 * 对话 / 轨迹 tab（对齐 dsh 的 conversation tab）。
 *
 * 钉三件事：
 * 1. header 下方只有两枚 tab，顺序固定为「对话」→「轨迹」；
 * 2. 选中态走 `aria-selected` + `.is-active`（下划线由 CSS 的 ::after 画），默认是「对话」；
 * 3. 点击只上报目标视图，不自己改状态（状态归 ChatView 持有，按会话记）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  ChatViewTabs,
  type ChatViewTab,
} from '@/ui/pages/chat/components/tabs/chat-view-tabs'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

let root: Root | null = null
let container: HTMLDivElement | null = null

function render(value: ChatViewTab, onChange = vi.fn()): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(<ChatViewTabs value={value} onChange={onChange} />)
  })
  return container
}

function tabs(el: HTMLElement): HTMLButtonElement[] {
  return [...el.querySelectorAll<HTMLButtonElement>('.chat-view-tab')]
}

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  container?.remove()
  root = null
  container = null
})

describe('对话 / 轨迹 tab', () => {
  it('两枚 tab，顺序固定：对话、轨迹', () => {
    const el = render('chat')
    expect(el.querySelector('[role="tablist"]')).not.toBeNull()
    expect(tabs(el).map((tab) => tab.textContent)).toEqual(['对话', '轨迹'])
    expect(el.querySelectorAll('[role="tab"]')).toHaveLength(2)
  })

  it('默认选中「对话」：aria-selected 与 is-active 只落在它身上', () => {
    const el = render('chat')
    const [chat, trajectory] = tabs(el)
    expect(chat!.getAttribute('aria-selected')).toBe('true')
    expect(chat!.classList.contains('is-active')).toBe(true)
    expect(trajectory!.getAttribute('aria-selected')).toBe('false')
    expect(trajectory!.classList.contains('is-active')).toBe(false)
  })

  it('选中「轨迹」时高亮换过去', () => {
    const el = render('trajectory')
    const [chat, trajectory] = tabs(el)
    expect(chat!.getAttribute('aria-selected')).toBe('false')
    expect(trajectory!.getAttribute('aria-selected')).toBe('true')
    expect(trajectory!.classList.contains('is-active')).toBe(true)
  })

  it('点击只上报目标视图（对话 → chat，轨迹 → trajectory）', () => {
    const onChange = vi.fn()
    const el = render('chat', onChange)
    const [chat, trajectory] = tabs(el)

    act(() => {
      trajectory!.click()
    })
    expect(onChange).toHaveBeenLastCalledWith('trajectory')

    act(() => {
      chat!.click()
    })
    expect(onChange).toHaveBeenLastCalledWith('chat')
  })
})
