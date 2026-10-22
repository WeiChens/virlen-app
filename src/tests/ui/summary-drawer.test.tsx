/**
 * 摘要详情抽屉（`summary-drawer`）自身的口径 —— 与「消息流里的提示条」分开验。
 *
 * 三条被钉住的：
 * 1. **三条关闭路径**：Esc / 点遮罩 / 右上角 ×，缺一条都会让人以为抽屉卡住了；
 * 2. **正文与副标题都来自那条 summary 消息**（抽屉只拿 message，不自己存副本）；
 * 3. **空正文给「（无内容）」占位**，不是一片空白。
 *
 * MarkdownRenderer 换成直出文本的替身（真实组件静态引 monaco，jsdom 起不来）。
 */
import { afterEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import SummaryDrawer from '@/ui/pages/chat/components/message/summary-drawer'
import type { Message } from '@/types'

vi.mock('@/ui/pages/chat/components/message/markdown-renderer', () => ({
  default: ({ content }: { content: string }) => (
    <div className="mock-markdown">{content}</div>
  ),
}))

;(globalThis as never as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

function makeSummary(overrides: Partial<Message> = {}): Message {
  return {
    id: 'summary-1',
    role: 'summary',
    content: 'COMPRESSED_HISTORY',
    timestamp: 1700000000000,
    uiData: { compressMode: 'raw', contextTokens: 12500 },
    ...overrides,
  }
}

let host: HTMLDivElement | null = null
let root: ReturnType<typeof createRoot> | null = null
let closed = 0

function onClose() {
  closed += 1
}

function mount(message: Message) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(<SummaryDrawer message={message} onClose={onClose} />))
}

const drawer = () => document.querySelector<HTMLElement>('.summary-drawer')
const mask = () => document.querySelector<HTMLElement>('.summary-drawer-mask')

afterEach(() => {
  act(() => root?.unmount())
  root = null
  host?.remove()
  host = null
  closed = 0
})

it('正文与副标题都来自那条 summary 消息', () => {
  mount(makeSummary())

  expect(drawer()!.textContent).toContain('COMPRESSED_HISTORY')
  expect(drawer()!.textContent).toContain('正文压缩')
  expect(drawer()!.textContent).toContain('12.5k')
  // 无障碍：抽屉是一个带名字的对话框
  expect(drawer()!.getAttribute('role')).toBe('dialog')
  expect(drawer()!.getAttribute('aria-label')).toBe('上下文压缩摘要')
})

it('Esc 关闭', () => {
  mount(makeSummary())

  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })

  expect(closed).toBe(1)
})

it('点遮罩关闭（点抽屉内部不算）', () => {
  mount(makeSummary())

  act(() => drawer()!.click())
  expect(closed).toBe(0)

  act(() => mask()!.click())
  expect(closed).toBe(1)
})

it('右上角 × 关闭', () => {
  mount(makeSummary())

  act(() => {
    document.querySelector<HTMLButtonElement>('.summary-drawer-close')!.click()
  })

  expect(closed).toBe(1)
})

it('空正文给「（无内容）」占位，不是一片空白', () => {
  mount(makeSummary({ content: '' }))

  expect(drawer()!.textContent).toContain('（无内容）')
  expect(document.querySelector('.mock-markdown')).toBeNull()
})

it('打开后焦点落在抽屉上（键盘用户不用从头 Tab）', () => {
  mount(makeSummary())
  expect(document.activeElement).toBe(drawer())
})
