/**
 * 工作区树的**监听门**：`active` 与 `sessionId`（右侧面板里那两棵树就是靠它们守规矩的）。
 *
 * 口径（配合 `use-dir-watch` / `workspace-tree` 头注释）：
 * 1. **只在「正在被看」时订目录**：`active === false`（不是当前标签 / 面板收起）时一个
 *    watcher 也不订 —— 右侧面板的每棵树都常驻挂载（切标签不卸载、切会话不清状态），
 *    谁都能订就是一次落盘换来十几次静默重读；
 * 2. **回来时静默重读**：不盯那段时间的增删不会再有事件送来，回到 `active` 就把正在看着的
 *    那几层重读一遍（不置 loading、不动展开 / 选中 / 滚动）；
 * 3. **树根按 `sessionId`（标签自己的会话）解析**：别的会话挂着的那棵树不能跟着当前会话跑，
 *    否则它会去当前会话的目录里订 watcher、把别人的文件树画出来。不传才是当前会话（左侧栏）。
 *
 * 监听「只盯展开的目录 / 折叠即退订」本身在 `sidebar-dir-watch` 用例里，这里只管这道门。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

const { invokeMock, watchMock, unwatchMock, watched } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  watchMock: vi.fn(),
  unwatchMock: vi.fn(),
  watched: [] as string[],
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/plugin-fs', () => ({ watch: watchMock }))
vi.mock('@/ui/store', () => ({
  chatState: { value: { currentSessionId: 'sess-1', selectedWorkspace: '' } },
  sessionStore: {
    // 两个会话各有自己的工作目录：树根读错一个就能被断言抓到
    getSession: (id: string) => ({
      workspace: id === 'sess-1' ? 'E:/one' : 'E:/two',
    }),
  },
  settingsState: { value: { defaultWorkspace: 'E:/one' } },
}))
/** jsdom 没有布局：虚拟器给全量行，才有行可断言 */
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

;(globalThis as never as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = NoopResizeObserver
;(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}

let root: ReturnType<typeof createRoot> | null = null

async function mount(props: { active?: boolean; sessionId?: string } = {}) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const render = (next: { active?: boolean; sessionId?: string } = {}) =>
    root!.render(
      <WorkspaceTree
        onAttachPaths={() => {}}
        onOpenFile={() => {}}
        searchQuery=""
        onSearchQueryChange={() => {}}
        {...next}
      />,
    )
  await act(async () => render(props))
  await act(async () => {})
  return { render }
}

/** 某次 invoke 调用的入参（按命令名取最后一次） */
function lastArgs(command: string): Record<string, unknown> | undefined {
  const calls = invokeMock.mock.calls.filter(([cmd]) => cmd === command)
  return calls.length ? (calls[calls.length - 1][1] as Record<string, unknown>) : undefined
}

function listCalls(): number {
  return invokeMock.mock.calls.filter(([cmd]) => cmd === 'list_directory').length
}

beforeEach(() => {
  document.body.innerHTML = ''
  watched.length = 0
  invokeMock.mockReset()
  unwatchMock.mockReset()
  watchMock.mockReset()
  invokeMock.mockImplementation(async (command: string) => {
    if (command === 'list_directory') return [{ name: 'a.txt', type: 'file', size: 3 }]
    if (command === 'os_platform') return 'windows'
    return null
  })
  watchMock.mockImplementation(async (dir: string) => {
    watched.push(dir)
    return unwatchMock
  })
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

it('默认（左侧栏那种一直看着的）：订根目录，delayMs 交给 Rust 侧去抖', async () => {
  await mount()

  expect(watched).toEqual(['E:/one'])
  expect(watchMock.mock.calls[0][2]).toEqual({ delayMs: 300 })
})

it('不看着（active=false）：一个目录也不订，但树照样加载出来', async () => {
  await mount({ active: false })

  expect(watched).toEqual([])
  expect(listCalls()).toBe(1)
  expect(
    [...document.querySelectorAll('.tree-row .tree-name')].map((el) => el.textContent),
  ).toEqual(['one', 'a.txt'])
})

it('回来（false → true）：重新订目录，并把正在看着的那几层静默重读一遍', async () => {
  const { render } = await mount({ active: false })
  expect(watched).toEqual([])
  const before = listCalls()

  await act(async () => render({ active: true }))
  await act(async () => {})

  expect(watched).toEqual(['E:/one'])
  // 不盯期间的增删不会再有事件送来：回来先补一次读盘
  expect(listCalls()).toBe(before + 1)

  // 卸载时退订（dev 的 StrictMode 也会走到这里）
  act(() => root!.unmount())
  root = null
  expect(unwatchMock).toHaveBeenCalledTimes(1)
})

it('树根按标签自己的会话解析（别的会话挂着的那棵树用别人的工作目录）', async () => {
  await mount({ sessionId: 'sess-2' })

  expect(lastArgs('list_directory')!.root).toBe('E:/two')
  expect(watched).toEqual(['E:/two'])
})
