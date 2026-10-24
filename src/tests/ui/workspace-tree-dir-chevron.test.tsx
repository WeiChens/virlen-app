/**
 * 工作目录树的目录行图标契约（实测反馈：目录行不要文件夹图标，改用 `>`，展开时顺时针转 90°）。
 *
 * 锁的是**结构**而不是像素：
 * - 目录行图标列只有一个展开开关（`.tree-arrow-btn`），文件夹图标已移除（行内不再有 `.tree-icon`）；
 * - 折叠时图标不带 `expanded`，点一下加上 —— 顺时针 90° 由样式挂在这个类上；
 * - 文件行仍保留类型图标，别把两类行的图标列一起删了。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@/ui/store', () => ({
  chatState: { value: { currentSessionId: null, selectedWorkspace: 'E:/repo' } },
  sessionStore: { getSession: (): undefined => undefined },
  settingsState: { value: { defaultWorkspace: 'E:/repo' } },
}))
/** jsdom 没有布局：虚拟器给全量行，才有行可查 */
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
        onAttachPaths={() => {}}
        onOpenFile={() => {}}
        searchQuery=""
        onSearchQueryChange={() => {}}
      />,
    )
  })
  await act(async () => {})
}

const rowOf = (name: string) =>
  [...document.querySelectorAll<HTMLElement>('.tree-row')].find(
    (row) => row.querySelector('.tree-name')?.textContent === name,
  )

beforeEach(() => {
  document.body.innerHTML = ''
  invokeMock.mockReset()
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

it('目录行图标列只有 `>` 开关，不再画文件夹图标', async () => {
  await mount()

  const dir = rowOf('src')!
  expect(dir.querySelector('.tree-arrow-btn')).not.toBeNull()
  expect(dir.querySelector('.tree-arrow-btn svg')).not.toBeNull()
  expect(dir.querySelector('.tree-icon')).toBeNull()
})

it('折叠不带 expanded，点开关后加上（顺时针 90° 的挂点）', async () => {
  await mount()

  const icon = () => rowOf('src')!.querySelector('.tree-arrow-icon')!
  expect(icon().classList.contains('expanded')).toBe(false)

  await act(async () => {
    rowOf('src')!
      .querySelector<HTMLElement>('.tree-arrow-btn')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })

  expect(icon().classList.contains('expanded')).toBe(true)
})

it('文件行仍保留类型图标', async () => {
  await mount()

  expect(rowOf('a.txt')!.querySelector('.tree-icon')).not.toBeNull()
})
