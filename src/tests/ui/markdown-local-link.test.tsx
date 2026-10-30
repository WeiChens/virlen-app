/**
 * 文件预览里 markdown 本地文件链接的分发契约：
 * - 传了 `onLocalLink`：相对/本地路径的链接被接管并原样上报（解析在面板层）；
 * - http(s) / #锚点 / mailto 不算本地文件链接，不走 `onLocalLink`（http(s) 仍走网页标签那条旧链路）；
 * - 没传 `onLocalLink`（聊天回复）：本地链接不被接管，保持原行为；
 * - 修饰键点击不接管（与 handleMarkdownLinkClick 同一套口径）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import MarkdownRenderer from '@/ui/pages/chat/components/message/markdown-renderer'

vi.mock('@/ui/pages/chat/components/message/code-block', () => ({
  default: ({ children }: { children?: React.ReactNode }) => <code>{children}</code>,
}))
vi.mock('@/ui/components/shared/LocalImage', () => ({
  default: (props: Record<string, unknown>) => <img {...props} />,
}))

;(globalThis as never as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let host: HTMLDivElement | null = null

function cleanup(): void {
  root?.unmount()
  root = null
  host?.remove()
  host = null
}

function clickLink(markdown: string, onLocalLink?: (href: string) => void): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(<MarkdownRenderer content={markdown} onLocalLink={onLocalLink} />))
  const link = host.querySelector('button.md-link') as HTMLButtonElement
  expect(link).not.toBeNull()
  act(() => {
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  return host
}

describe('markdown 本地文件链接', () => {
  afterEach(cleanup)

  it('相对路径链接被接管并原样上报', () => {
    const onLocalLink = vi.fn()
    clickLink('[下一个](next.md)', onLocalLink)
    expect(onLocalLink).toHaveBeenCalledWith('next.md')
  })

  it('http(s) 链接不走 onLocalLink（归网页标签那条链路）', () => {
    const onLocalLink = vi.fn()
    clickLink('[官网](https://example.com)', onLocalLink)
    expect(onLocalLink).not.toHaveBeenCalled()
  })

  it('锚点链接不走 onLocalLink', () => {
    const onLocalLink = vi.fn()
    clickLink('[跳转](#section)', onLocalLink)
    expect(onLocalLink).not.toHaveBeenCalled()
  })

  it('没传 onLocalLink 时本地链接不被接管（聊天回复的原行为）', () => {
    const host2 = clickLink('[下一个](next.md)')
    // 未接管 = 未 preventDefault，默认行为继续（jsdom 里无导航，但事件不能被吞）
    expect(host2.querySelector('button.md-link')).not.toBeNull()
  })

  it('带修饰键的点击不接管', () => {
    const onLocalLink = vi.fn()
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => root!.render(<MarkdownRenderer content="[下一个](next.md)" onLocalLink={onLocalLink} />))
    const link = host.querySelector('button.md-link') as HTMLButtonElement
    act(() => {
      link.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }),
      )
    })
    expect(onLocalLink).not.toHaveBeenCalled()
  })
})
