/**
 * 工作目录树的双击口径（实测反馈：双击原先会把路径引用到输入框，和「打开文件」抢同一个动作）。
 *
 * 现在就两条：
 * - **双击文件 = 在右侧面板打开**（文本编辑 / 媒体预览），不再引用；
 * - **双击目录 = 切换展开**（不再引用整个选择集）。
 *
 * 引用仍然在右键菜单与拖拽到输入框上 —— 这里只保证双击不再走那条路。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

const { invokeMock, openFileSpy, attachSpy } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  openFileSpy: vi.fn(),
  attachSpy: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@/ui/store', () => ({
  chatState: { value: { currentSessionId: null, selectedWorkspace: 'E:/repo' } },
  sessionStore: { getSession: (): undefined => undefined },
  settingsState: { value: { defaultWorkspace: 'E:/repo' } },
}))
/** jsdom 没有布局：虚拟器给全量行，才有行可点 */
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 24,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        size: 24,
        start: index * 24,
      })),
    scrollToIndex: () => {},
  }),
}))

import WorkspaceTree from '@/ui/pages/chat/components/sidebar/workspace-tree'

;(globalThis as never as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
  NoopResizeObserver
;(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}

let root: ReturnType<typeof createRoot> | null = null

async function mount() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <WorkspaceTree
        onAttachPaths={attachSpy}
        onOpenFile={openFileSpy}
        searchQuery=""
        onSearchQueryChange={() => {}}
      />,
    )
  })
  // list_directory 的结果落进 state 需要再走一轮微任务
  await act(async () => {})
}

const fileMain = () =>
  document.querySelector<HTMLElement>('.tree-row.is-file .tree-main')
const dirMain = (name: string) =>
  [...document.querySelectorAll<HTMLElement>('.tree-row:not(.is-file)')].find(
    (row) => row.querySelector('.tree-name')?.textContent === name,
  )?.querySelector<HTMLElement>('.tree-main')

beforeEach(() => {
  document.body.innerHTML = ''
  invokeMock.mockReset()
  openFileSpy.mockReset()
  attachSpy.mockReset()
  invokeMock.mockResolvedValue([
    { name: 'a.txt', type: 'file', size: 3 },
    { name: 'src', type: 'dir', size: 0 },
  ])
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

it('双击文件 → 打开右侧面板，不再引用到输入框', async () => {
  await mount()

  act(() => {
    fileMain()!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  })

  expect(openFileSpy).toHaveBeenCalledWith('E:/repo/a.txt')
  expect(attachSpy).not.toHaveBeenCalled()
})

it('双击目录 → 展开（触发一次目录加载），不打开文件、也不引用', async () => {
  await mount()
  const callsBefore = invokeMock.mock.calls.length

  await act(async () => {
    dirMain('src')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  })

  expect(openFileSpy).not.toHaveBeenCalled()
  expect(attachSpy).not.toHaveBeenCalled()
  expect(invokeMock.mock.calls.length).toBeGreaterThan(callsBefore)
})

it('Enter 等价双击：文件打开', async () => {
  await mount()

  act(() => {
    fileMain()!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    )
  })

  expect(openFileSpy).toHaveBeenCalledWith('E:/repo/a.txt')
})
