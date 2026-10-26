// @vitest-environment jsdom
/**
 * GitEntry — 「自己开着遮罩时，点面板外面不再关面板」。
 *
 * 用户报回：差异弹窗（`.git-diff-backdrop`，portal 到 body）开着的时候把窗口全屏，**弹窗被关掉**。
 * 根因不是弹窗自己的逻辑：入口的「点浮层外关闭」按 DOM 包含关系判 target，而遮罩**从自绘标题栏下方
 * 开始**（要留出拖窗口 / 点窗口按钮的地方，见 `GitDiffModal` 的固定定位），于是「点最大化」那一下
 * 的 target 既不在这套 DOM 里、也不是遮罩 —— 判定为「点了外面」→ `setOpen(false)` → `GitPanel` 卸载
 * → 门户到 body 的弹窗跟着消失（顺带面板也没了）。
 *
 * 口径：只要**面板自己**的遮罩还在（`.git-diff-backdrop` / 全局 `.modal-overlay`），这一下不算点外面；
 * 遮罩撤掉之后，点外面照旧关面板。
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
  stage: vi.fn(),
  unstage: vi.fn(),
  discard: vi.fn(),
  commit: vi.fn(),
  switchBranch: vi.fn(),
  checkRefFormat: vi.fn(),
  loadDiffSides: vi.fn(),
  undoLastCommit: vi.fn(),
  loadCommitDetail: vi.fn(),
  removeBranch: vi.fn(),
  renameBranch: vi.fn(),
  refreshRemotes: vi.fn(),
  fetchRemote: vi.fn(),
  pullRemote: vi.fn(),
  pushRemote: vi.fn(),
  syncNow: vi.fn(),
  testRemote: vi.fn(),
  cancelSync: vi.fn(),
  refreshStashes: vi.fn(() => Promise.resolve()),
  createStash: vi.fn(() => Promise.resolve(true)),
  applyStash: vi.fn(() => Promise.resolve(true)),
  dropStash: vi.fn(() => Promise.resolve(true)),
  undoDropStash: vi.fn(() => Promise.resolve()),
  mergeBranch: vi.fn(() => Promise.resolve(true)),
  abortMerge: vi.fn(() => Promise.resolve(true)),
  loadMergeState: vi.fn(() => Promise.resolve(false)),
  resumePick: vi.fn(() => Promise.resolve(true)),
  abortPick: vi.fn(() => Promise.resolve(true)),
}))

vi.mock('@/ui/store/chatState', () => ({
  chatState: { value: { selectedWorkspace: '/tmp/repo', currentSessionId: null } },
}))
vi.mock('@/ui/store/sessionStore', () => ({
  sessionStore: { getSession: (): null => null },
}))

// 面板的引用链会拉到 monaco（差异弹窗）—— 在 jsdom 里导入即崩（缺 `CSS.escape` / codicon.css）
vi.mock('@/monaco/setupMonaco', () => ({
  monaco: { editor: { tokenize: (): unknown[] => [] } },
  virlenDarkTheme: {},
}))

;(globalThis as never as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

let root: ReturnType<typeof createRoot> | null = null

/** 打开面板（点一下工具栏那颗图标） */
function openPanel(): void {
  act(() => (document.querySelector('.git-entry-btn') as HTMLElement).click())
}

/** 在面板外面按下鼠标（最大化按钮 / 双击标题栏都是这一下） */
function clickOutside(): void {
  act(() => {
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  })
}

const panelOpen = (): boolean => !!document.querySelector('.git-popover')

beforeEach(() => {
  runInAction(() => {
    gitStore.dir = '/tmp/repo'
    gitStore.probed = true
    gitStore.repo = {
      root: '/tmp/repo',
      git_dir: '/tmp/repo/.git',
      bare: false,
      version: '2.44.0',
      caps: { porcelain_v2: true, switch: true, restore: true },
    }
    gitStore.unavailable = null
    gitStore.snapshot = {
      head: { oid: 'abc', branch: 'main', upstream: null, ahead: 0, behind: 0 },
      entries: [
        { path: 'a.txt', orig_path: null, x: '.', y: 'M', kind: 'ordinary' },
      ],
      truncated: false,
    }
  })
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(<GitEntry sessionId={null} onAttachPaths={() => { }} />))
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

it('git 弹窗遮罩在（差异 / 日志 / 提交图 / 贮藏）：点面板外面不关面板', () => {
  openPanel()
  expect(panelOpen()).toBe(true)

  // 差异弹窗开着：遮罩从标题栏下方开始，「最大化」落在面板外面
  const backdrop = document.createElement('div')
  backdrop.className = 'git-diff-backdrop'
  document.body.appendChild(backdrop)

  clickOutside()
  expect(panelOpen()).toBe(true)
  expect(document.querySelector('.git-diff-backdrop')).toBeTruthy()

  // 弹窗关掉之后，点外面照旧收面板
  backdrop.remove()
  clickOutside()
  expect(panelOpen()).toBe(false)
})

it('全局 Modal 遮罩同理（错误弹窗 / 新建分支输入框）', () => {
  openPanel()
  expect(panelOpen()).toBe(true)

  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  document.body.appendChild(overlay)

  clickOutside()
  expect(panelOpen()).toBe(true)

  overlay.remove()
  clickOutside()
  expect(panelOpen()).toBe(false)
})

it('没有遮罩时：点外面就是关（这条不能被上一条顺手改坏）', () => {
  openPanel()
  expect(panelOpen()).toBe(true)
  clickOutside()
  expect(panelOpen()).toBe(false)
})
