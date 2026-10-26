// @vitest-environment jsdom
/**
 * 右侧面板 · 系统文件拖放（原生通道，§11.8）。
 *
 * 事件本身（`virlen:drag-drop`）只有 Rust 那边才有，这里不模拟 IPC，只钉住三件容器该做的事：
 * 1. **整块面板是一个落点**：落在面板矩形内命中，落在聊天区不命中；
 * 2. **指针进出手续给宿主开标签**：`onDrop(paths)` 上报一次，拖入期间铺一层提示
 *    （提示是 `pointer-events: none`，命中一直按坐标算 —— 见 `useNativeFileDrop`）；
 * 3. **收起 / 没有接收方时不接**：宽度 0 的面板不能悄悄吃掉拖放（否则文件既开不出标签，
 *    也拿不到「拖到哪儿都不接」的提示）。
 *
 * 面板里的内容（文件面板 / 终端 / 文件树）全换成桩：这里只验容器的命中与回调，
 * 文件语义在 `workspace-file-*` 用例里，标签语义在 `side-panel-tabs.test.ts` 里。
 */
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import SidePanel from '@/ui/pages/chat/components/side-panel'
import { nativeDropTargetAt } from '@/ui/hooks/useNativeFileDrop'

vi.mock('@/ui/pages/chat/components/workspace-file', () => ({
  default: () => <div className="stub-file" />,
}))
vi.mock('@/ui/pages/chat/components/sidebar/workspace-tree', () => ({
  default: () => <div className="stub-tree" />,
}))
vi.mock('@/ui/pages/chat/components/service/ServiceTerminal', () => ({
  default: () => <div className="stub-service" />,
}))
vi.mock('@/ui/pages/chat/components/terminal/UserTerminal', () => ({
  default: () => <div className="stub-terminal" />,
}))
vi.mock('@/ui/pages/chat/components/side-panel/guide', () => ({
  default: () => <div className="stub-guide" />,
}))
vi.mock('@/ui/pages/chat/components/side-panel/browser/BrowserPane', () => ({
  default: () => <div className="stub-browser" />,
}))

/** 面板矩形（jsdom 没有布局引擎：全靠 `getBoundingClientRect` 喂） */
const PANEL_RECT = { left: 600, top: 0, width: 600, height: 800 }

const realRect = Element.prototype.getBoundingClientRect

function fakeRect(
  left: number,
  top: number,
  width: number,
  height: number,
): DOMRect {
  return {
    left,
    right: left + width,
    width,
    top,
    bottom: top + height,
    height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect
}

beforeAll(() => {
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (this.classList.contains('side-panel')) {
      // 收起时真实宽度就是 0（`.is-collapsed { width: 0 !important }`）
      if (this.classList.contains('is-collapsed')) return fakeRect(0, 0, 0, 0)
      return fakeRect(PANEL_RECT.left, PANEL_RECT.top, PANEL_RECT.width, PANEL_RECT.height)
    }
    if (this.classList.contains('chat-main')) return fakeRect(0, 0, 600, 800)
    return realRect.call(this)
  }
})

;(globalThis as never as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

/** 面板上报的「拖进来的路径」（一次拖放一批） */
const dropped: string[][] = []

let root: ReturnType<typeof createRoot> | null = null

async function renderPanel(opts: { collapsed?: boolean; withDrop?: boolean } = {}) {
  if (!root) {
    const host = document.createElement('div')
    host.className = 'chat-view'
    document.body.appendChild(host)
    root = createRoot(host)
  }
  await act(async () => {
    root!.render(
      <>
        <div className="chat-main" />
        <SidePanel
          tabs={[]}
          activeId={null}
          collapsed={opts.collapsed}
          onActiveChange={() => {}}
          onCloseTab={() => {}}
          // 不传 = 面板不接拖放（宿主没给开标签的入口时不该悄悄吃掉拖放）
          onDropPaths={
            opts.withDrop === false ? undefined : (paths) => dropped.push(paths)
          }
        />
      </>,
    )
  })
}

beforeEach(() => {
  document.body.innerHTML = ''
  dropped.length = 0
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

it('拖进面板：矩形内命中，松手把路径交给宿主', async () => {
  await renderPanel()

  // 聊天区那一侧不命中（那个位置归输入框的落点）
  expect(nativeDropTargetAt(300, 100)).toBeNull()

  const target = nativeDropTargetAt(PANEL_RECT.left + 100, 100)
  expect(target, '面板整块都该是一个落点').toBeTruthy()

  act(() => target!.onDrop(['E:/repo/src/a.ts', 'E:/repo/README.md']))
  expect(dropped).toEqual([['E:/repo/src/a.ts', 'E:/repo/README.md']])
})

it('拖入期间铺一层提示，指针离开就收掉', async () => {
  await renderPanel()
  const target = nativeDropTargetAt(PANEL_RECT.left + 100, 100)!

  expect(document.querySelector('.side-panel-drop-hint')).toBeNull()
  act(() => target.onHover?.(true))
  const hint = document.querySelector<HTMLElement>('.side-panel-drop-hint')
  expect(hint).toBeTruthy()
  // 提示层不能吃指针：命中由坐标算，它只是给用户看的一句话
  expect(hint!.textContent).toBe('松开即可打开文件')

  act(() => target.onHover?.(false))
  expect(document.querySelector('.side-panel-drop-hint')).toBeNull()
})

it('收起的面板不接拖放（宽度 0 时连命中都不算）', async () => {
  await renderPanel({ collapsed: true })
  expect(nativeDropTargetAt(PANEL_RECT.left + 100, 100)).toBeNull()
})

it('宿主没给 onDropPaths 时不接，也不高亮', async () => {
  await renderPanel({ withDrop: false })
  expect(nativeDropTargetAt(PANEL_RECT.left + 100, 100)).toBeNull()
  expect(document.querySelector('.side-panel-drop-hint')).toBeNull()
})

it('卸载后落点跟着注销（不留一个再也送不到的接收方）', async () => {
  await renderPanel()
  expect(nativeDropTargetAt(PANEL_RECT.left + 100, 100)).toBeTruthy()

  act(() => root?.unmount())
  root = null
  expect(nativeDropTargetAt(PANEL_RECT.left + 100, 100)).toBeNull()
})
