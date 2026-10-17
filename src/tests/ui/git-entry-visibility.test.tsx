/**
 * GitEntry 的**显隐口径**：工具栏不主动摆一个用不上的图标。
 *
 * 只有工作目录里**已有仓库**（`.git`）时才出现；「不是仓库」与「没装 git」都不出现 ——
 * 两者在 store 里都是 `repo === null`（后者由 `probe` 失败 / 环境探测落到 `unavailable`）。
 *
 * 面板本身不在这里验（`git-panel.test.tsx` 直接挂 GitPanel）。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { runInAction } from 'mobx'

import GitEntry from '@/ui/pages/chat/components/git/GitEntry'
import { gitStore } from '@/ui/store/gitStore'

vi.mock('@/services/git-service', () => ({
  syncWorkspace: vi.fn(),
  refreshStatus: vi.fn(),
  refreshOnFocus: vi.fn(),
  setPanelOpen: vi.fn(),
}))

vi.mock('@/ui/store/chatState', () => ({
  chatState: { value: { selectedWorkspace: '/tmp/repo', currentSessionId: null } },
}))
vi.mock('@/ui/store/sessionStore', () => ({
  sessionStore: { getSession: (): null => null },
}))

// 入口 import 了面板 → 面板的引用链会拉到 monaco（jsdom 里导入即崩，缺 `CSS.escape`）
vi.mock('@/monaco/setupMonaco', () => ({
  monaco: { editor: { tokenize: (): unknown[] => [] } },
  virlenDarkTheme: {},
}))

;(globalThis as never as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

let root: ReturnType<typeof createRoot> | null = null

function mount() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(<GitEntry sessionId={null} />))
}

beforeEach(() => {
  runInAction(() => {
    gitStore.dir = '/tmp/repo'
    gitStore.probed = true
    gitStore.repo = null
    gitStore.unavailable = null
    gitStore.snapshot = null
  })
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

it('不是仓库：不渲染入口', () => {
  runInAction(() => {
    gitStore.unavailable = '当前工作目录不是 Git 仓库'
  })
  mount()
  expect(document.querySelector('.git-entry')).toBeNull()
})

it('没装 git / 探测失败：同样不渲染入口', () => {
  runInAction(() => {
    gitStore.unavailable = '当前环境不支持 Git 功能'
  })
  mount()
  expect(document.querySelector('.git-entry')).toBeNull()
})

it('已有仓库：入口与徽标出现', () => {
  runInAction(() => {
    gitStore.repo = {
      root: '/tmp/repo',
      git_dir: '/tmp/repo/.git',
      bare: false,
      version: '2.44.0',
      caps: { porcelain_v2: true, switch: true, restore: true },
    }
    gitStore.snapshot = {
      head: { oid: 'abc', branch: 'main', upstream: null, ahead: 0, behind: 0 },
      entries: [
        { path: 'a.txt', orig_path: null, x: '.', y: 'M', kind: 'ordinary' },
      ],
      truncated: false,
    }
  })
  mount()
  expect(document.querySelector('.git-entry')).toBeTruthy()
  expect(document.querySelector('.git-badge')?.textContent).toBe('1')
})
