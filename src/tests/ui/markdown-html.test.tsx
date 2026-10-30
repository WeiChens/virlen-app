/**
 * Markdown 内穿插 HTML 的渲染契约（rehype-raw + rehype-sanitize）：
 * - 白名单内的 HTML（b / i / span / div / <img> 等）要被当成真实元素渲染，而不是原文输出；
 * - 危险内容（script / onclick / javascript:）必须被 sanitize 拦掉 —— fail-closed。
 */
import { describe, it, expect } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import MarkdownRenderer from '@/ui/pages/chat/components/message/markdown-renderer'

/** LocalImage 异步读盘（jsdom 跑不了），替身直出 img */
vi.mock('@/ui/components/shared/LocalImage', () => ({
  default: (props: Record<string, unknown>) => <img {...props} />,
}))
vi.mock('@/ui/pages/chat/components/message/code-block', () => ({
  default: ({ children }: { children?: React.ReactNode }) => <code>{children}</code>,
}))

;(globalThis as never as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let host: HTMLDivElement | null = null

function renderMd(content: string): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(<MarkdownRenderer content={content} />))
  return host
}

describe('markdown 内嵌 HTML', () => {
  it('白名单标签渲染为真实元素', () => {
    const el = renderMd('前文 <b>加粗</b> 后文')
    expect(el.querySelector('b')?.textContent).toBe('加粗')
  })

  it('内嵌 <img> 保留 src（与 allowImageSrc 同口径）', () => {
    const el = renderMd('<img src="hello.png" alt="图">')
    const img = el.querySelector('img')
    expect(img).not.toBeNull()
    expect(img!.getAttribute('src')).toBe('hello.png')
  })

  it('script 标签被移除', () => {
    const el = renderMd('<script>window.x=1</script>正文')
    expect(el.querySelector('script')).toBeNull()
    expect(el.textContent).toContain('正文')
  })

  it('事件属性被剥离', () => {
    const el = renderMd('<b onclick="alert(1)">x</b>')
    expect(el.querySelector('b')?.hasAttribute('onclick')).toBe(false)
  })

  it('javascript: 协议被拦截', () => {
    const el = renderMd('<a href="javascript:alert(1)">点</a>')
    // `a` 组件被 LinkRenderer 替换成 <button>，且 sanitize 已剥离 href —— 任何元素都不得携带 javascript: 链接
    const dangerous = el.querySelector('[href^="javascript:"]')
    expect(dangerous).toBeNull()
    expect(el.textContent).toContain('点')
  })
})
