/**
 * SideBySideDiff 内置「全屏」按钮测试。
 *
 * 覆盖：
 * - 全屏按钮是内置的（文件头右侧，不依赖调用方 actions）
 * - 点击后通过 createPortal 把「铺满」形态挂到 body
 * - 原位 diff 照常保留（搬走/卸载会让虚拟列表条目高度变化、带偏滚动锚点）
 * - 再点一次 / 按 Esc 均可退出
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

// Monaco 在 jsdom 里跑不起来：只验证浮层的 DOM 结构，词法着色不在此测
vi.mock('@/monaco/setupMonaco', () => ({
  monaco: { editor: { tokenize: (): unknown[] => [] } },
  virlenDarkTheme: { rules: [] as unknown[] },
}))
// code-block 会连带引入 CodePreview(Monaco)：这里只用它的 toMonacoLang，换成最小替身
vi.mock('@/ui/pages/chat/components/message/code-block', () => ({
  toMonacoLang: (): string | undefined => undefined,
  default: (): null => null,
}))

import {
  SideBySideDiff,
  type SideBySideRow,
} from '@/ui/pages/chat/components/message/SideBySideDiff'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const ROWS: SideBySideRow[] = [
  {
    type: 'equal',
    oldLine: 'const a = 1',
    newLine: 'const a = 1',
    oldLineNum: 1,
    newLineNum: 1,
  },
  {
    type: 'delete',
    oldLine: 'const b = 2',
    newLine: null,
    oldLineNum: 2,
    newLineNum: null,
  },
  {
    type: 'insert',
    oldLine: null,
    newLine: 'const b = 3',
    oldLineNum: null,
    newLineNum: 2,
  },
]

async function mount(rows: SideBySideRow[] = ROWS) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(<SideBySideDiff diffRows={rows} fileName="demo.ts" />)
  })
  return { host, root }
}

const fullscreenBtn = (host: HTMLElement) =>
  host.querySelector('.diff-fullscreen-btn') as HTMLButtonElement
const layer = () =>
  document.querySelector('.diff-fullscreen-layer') as HTMLElement | null

describe('SideBySideDiff 全屏', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('文件头带内置全屏按钮，默认不渲染浮层', async () => {
    const { host, root } = await mount()

    expect(fullscreenBtn(host)).toBeTruthy()
    expect(layer()).toBeNull()

    await act(async () => root.unmount())
  })

  it('点击后把 .is-fullscreen 挂到 body，原位 diff 照常保留', async () => {
    const { host, root } = await mount()

    await act(async () => fullscreenBtn(host).click())

    const el = layer()
    expect(el).toBeTruthy()
    // 必须挂在 body 下（不受消息条目祖先的 transform/overflow 影响才能铺满）
    expect(el!.parentElement).toBe(document.body)
    expect(el!.querySelector('.diff-side-by-side.is-fullscreen')).toBeTruthy()
    // 双栏内容照常渲染
    expect(el!.querySelectorAll('.diff-panel').length).toBe(2)
    // 原位 diff 仍在，且不是全屏形态
    expect(host.querySelector('.diff-side-by-side')).toBeTruthy()
    expect(host.querySelector('.diff-side-by-side.is-fullscreen')).toBeNull()

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

  it('节点类名保留：变更行左右高亮、省略行渲染为 ⋯（双栏各一份）', async () => {
    const { host, root } = await mount([...ROWS, { type: 'gap' }])

    expect(host.querySelectorAll('.diff-line--highlight-old').length).toBe(1)
    expect(host.querySelectorAll('.diff-line--highlight-new').length).toBe(1)
    expect(host.querySelectorAll('.diff-line--gap').length).toBe(2)

    await act(async () => root.unmount())
  })
})
