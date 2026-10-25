/**
 * 工作目录树 / 搜索的点项口径：**`. 开头的文件不隐藏**（实测反馈：`.env` / `.gitignore` 在树里看不见），
 * 但**系统隐藏项如 `.git` 仍然不显示**。
 *
 * 1. 树加载目录时 `list_directory` 必须传 `includeHidden: true`（Rust 侧 `include_hidden=false`
 *    会把所有 `.` 开头的条目录直接跳过 —— 前端没有第二道过滤，藏起来就是读盘时就没了）；
 * 2. 隐藏靠**系统隐藏属性**判定（Rust `search::is_hidden_by_attr`：Windows 隐藏位 / macOS
 *    UF_HIDDEN）—— `.git` 有隐藏位，`.env` / `.gitignore` 没有；
 * 3. 搜索：树上看得见的点项，搜索框也要搜得到；`.git` 内部另由 skipDirNames 剪掉（macOS /
 *    Linux 上 `.git` 不一定带隐藏位）。
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

/** 磁盘内容：点项与普通项混在一起（点文件要出现，系统隐藏项 `.git` 不出现） */
const LISTING: {
  name: string
  type: 'file' | 'dir'
  size: number
  /** 带系统隐藏属性（Rust 侧无论 includeHidden 都不返回） */
  osHidden?: boolean
}[] = [
  // Rust 侧按系统隐藏属性过滤：.git 带隐藏位，无论 includeHidden 都不返回
  { name: '.git', type: 'dir', size: 0, osHidden: true },
  { name: '.gitignore', type: 'file', size: 12 },
  { name: '.env', type: 'file', size: 34 },
  { name: 'src', type: 'dir', size: 0 },
  { name: 'a.txt', type: 'file', size: 3 },
]

let root: ReturnType<typeof createRoot> | null = null

async function mount(searchQuery = '') {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <WorkspaceTree
        onAttachPaths={() => {}}
        onOpenFile={() => {}}
        searchQuery={searchQuery}
        onSearchQueryChange={() => {}}
      />,
    )
  })
  await act(async () => {})
}

/** 某次 invoke 调用的入参（按命令名取最后一次） */
function lastArgs(command: string): Record<string, unknown> | undefined {
  const calls = invokeMock.mock.calls.filter(([cmd]) => cmd === command)
  return calls.length ? (calls[calls.length - 1][1] as Record<string, unknown>) : undefined
}

function rowNames(): string[] {
  return [...document.querySelectorAll<HTMLElement>('.tree-row .tree-name')].map(
    (el) => el.textContent || '',
  )
}

beforeEach(() => {
  document.body.innerHTML = ''
  invokeMock.mockReset()
  invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    // 按 Rust 的行为过滤：系统隐藏项（.git）先被剔除；include_hidden=false 再跳过 `.` 开头
    // （这样「点文件可见 / .git 不可见」的断言守得住口径，而不只是守参数）
    if (command === 'list_directory') {
      return LISTING.filter(
        (entry) =>
          !entry.osHidden &&
          (args?.includeHidden === true || !entry.name.startsWith('.')),
      )
    }
    if (command === 'search_files_by_name') return [{ path: 'E:/repo/.env' }]
    if (command === 'os_platform') return 'windows'
    return null
  })
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

it('加载目录时 includeHidden 为 true，点文件照常出现、系统隐藏项 .git 不出现', async () => {
  await mount()

  expect(lastArgs('list_directory')?.includeHidden).toBe(true)
  const names = rowNames()
  expect(names).toContain('.env')
  expect(names).toContain('.gitignore')
  expect(names).not.toContain('.git')
  // 普通项不受影响
  expect(names).toContain('a.txt')
})
