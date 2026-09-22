/**
 * CodeBlock 内置「全屏」按钮测试
 *
 * 覆盖：
 * - 全屏按钮是内置的（与复制按钮同级，不依赖调用方 actions）
 * - 点击后通过 createPortal 把「铺满」形态的代码块挂到 body
 * - 原位代码块照常保留 —— 若把它搬走/卸载，虚拟列表条目高度会变，
 *   触发重测量并可能带偏滚动锚点
 * - 再点一次 / 按 Esc 均可退出
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import CodeBlock from '@/ui/pages/chat/components/message/code-block'

// Monaco 在 jsdom 里跑不起来：这里只验证全屏浮层的 DOM 结构，不测 Monaco 本身
vi.mock('@/ui/components/code-preview/CodePreview', () => ({
  default: ({ code }: any) => <pre className="mock-code-preview">{code}</pre>,
}))

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const CODE = 'const a = 1\nconst b = 2'

async function mount() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(<CodeBlock fileName="demo.ts">{CODE}</CodeBlock>)
  })
  return { host, root }
}

const fullscreenBtn = (host: HTMLElement) =>
  host.querySelector('.code-fullscreen-btn') as HTMLButtonElement
const layer = () =>
  document.querySelector('.code-block-fullscreen-layer') as HTMLElement | null

describe('CodeBlock 全屏', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('头部带内置全屏按钮（与复制按钮同级），默认不渲染浮层', async () => {
    const { host, root } = await mount()

    const btn = fullscreenBtn(host)
    expect(btn).toBeTruthy()
    expect(btn.parentElement?.querySelector('.code-copy-btn')).toBeTruthy()
    expect(layer()).toBeNull()

    await act(async () => root.unmount())
  })

  it('点击后把 .is-fullscreen 代码块挂到 body，原位代码块照常保留', async () => {
    const { host, root } = await mount()

    await act(async () => fullscreenBtn(host).click())

    const el = layer()
    expect(el).toBeTruthy()
    // 必须挂在 body 下（不受消息条目祖先的 transform/overflow 影响才能铺满）
    expect(el!.parentElement).toBe(document.body)
    // 浮层里是「铺满」形态，且内容与源码一致
    expect(el!.querySelector('.code-block-wrapper.is-fullscreen')).toBeTruthy()
    expect(el!.querySelector('.mock-code-preview')?.textContent).toBe(CODE)
    // 原位代码块仍在（没有被搬走），且不是全屏形态
    expect(host.querySelector('.code-block-wrapper')).toBeTruthy()
    expect(host.querySelector('.code-block-wrapper.is-fullscreen')).toBeNull()

    await act(async () => root.unmount())
  })

  it('再点一次退出，Esc 也能退出', async () => {
    const { host, root } = await mount()

    await act(async () => fullscreenBtn(host).click())
    expect(layer()).toBeTruthy()
    await act(async () => fullscreenBtn(host).click())
    expect(layer()).toBeNull()

    await act(async () => fullscreenBtn(host).click())
    expect(layer()).toBeTruthy()
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(layer()).toBeNull()

    await act(async () => root.unmount())
  })

  it('行内代码（无换行）不出现全屏按钮', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(<CodeBlock inlineCode>{'npm run dev'}</CodeBlock>)
    })

    expect(host.querySelector('.code-fullscreen-btn')).toBeNull()
    expect(host.querySelector('.inline-code')).toBeTruthy()

    await act(async () => root.unmount())
  })
})
