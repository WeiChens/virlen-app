/**
 * SideBySideDiff 测试。
 *
 * 覆盖：
 * - 全屏按钮是内置的（文件头右侧，不依赖调用方 actions）
 * - 点击后通过 createPortal 把「铺满」形态挂到 body
 * - 原位 diff 照常保留（搬走/卸载会让虚拟列表条目高度变化、带偏滚动锚点）
 * - 再点一次 / 按 Esc 均可退出
 * - 只有一个滚动容器（纵向）：双栏表头与每一行的左右两半都在 .diff-body 内
 * - 行结构是「每行左右两半共用一个 grid 行」→ 列宽恒为一半一半、行高左右一致
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
    // 双栏内容照常渲染（每一行各一个左半 + 右半）
    expect(el!.querySelectorAll('.diff-line--old').length).toBe(ROWS.length)
    expect(el!.querySelectorAll('.diff-line--new').length).toBe(ROWS.length)
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

describe('SideBySideDiff 单一滚动容器', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('双栏表头与每一行的左右两半都在 .diff-body 内，文件头留在滚动区外', async () => {
    const { host, root } = await mount()

    const body = host.querySelector('.diff-body') as HTMLElement
    expect(body).toBeTruthy()
    // 表头进了滚动区：纵向吸顶，且跨两列（内部两个标题各占一半）
    expect(body.querySelector('.diff-column-headers')).toBeTruthy()
    expect(body.querySelectorAll('.diff-col-header').length).toBe(2)
    // 内容都在同一个滚动容器里 → 滚动位置天然一致，不存在「另一半慢一帧」
    expect(body.querySelectorAll('.diff-line').length).toBe(ROWS.length * 2)
    // 文件头留在滚动区外：不随内容滚动
    expect(body.querySelector('.diff-header')).toBeNull()
    expect(host.querySelectorAll('.diff-header').length).toBe(1)

    await act(async () => root.unmount())
  })

  it('每行的左右两半是 .diff-body 的直接子节点且成对相邻（同一个 grid 行）', async () => {
    const { host, root } = await mount()

    // 同一 grid 行 = 两半同宽（各占一半）、行高一致（一侧折行另一侧跟着变高）
    const body = host.querySelector('.diff-body') as HTMLElement
    const halves = [...body.querySelectorAll('.diff-line')]
    expect(halves.length).toBe(ROWS.length * 2)
    halves.forEach((el, i) => {
      expect(el.parentElement).toBe(body)
      const expected = i % 2 === 0 ? 'diff-line--old' : 'diff-line--new'
      expect(el.classList.contains(expected)).toBe(true)
    })

    // 不再有独立的两栏容器，也不再有任何 JS 量宽（--diff-col-w 已删）：
    // 列宽由 CSS 的 1fr 1fr 给出，量错一次就会变成「左宽右窄」的那类 bug 不复存在
    expect(body.querySelector('.diff-panel')).toBeNull()
    const rootEl = host.querySelector('.diff-side-by-side') as HTMLElement
    expect(rootEl.style.getPropertyValue('--diff-col-w')).toBe('')

    await act(async () => root.unmount())
  })
})
