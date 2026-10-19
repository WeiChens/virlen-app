/**
 * 变更行「引用到输入框」—— 拖拽与右键两条入口。
 *
 * 1. **拖到输入框 = 挂附件**：走的是侧边栏目录树那套指针拖拽（`useTreeDrag`），路径必须换成
 *    **绝对路径**（输入框只认真实路径），口径与三个行内按钮一致（同侧选中的整批）；
 * 2. **拖拽松手后浏览器仍会补一次 click / dblclick**：必须吞掉 —— 否则「拖到输入框」会顺手
 *    把行选中、甚至弹出差异弹窗（双击）；
 * 3. **已删除的文件不给引用**：磁盘上已不存在，挂上去只会换来一句「无法访问该路径」，
 *    这里提前剔掉并说明原因（右键与拖拽共用同一个入口，同样会被剔掉）；
 * 4. **右键菜单也有入口**：拖拽没有可见提示，面板压住输入框时（小窗 / 竖屏）这是唯一出路。
 *
 * jsdom 没有布局：`document.elementFromPoint` 由用例指定落点，拖拽本身按真实事件序列派发。
 */
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { runInAction } from 'mobx'

import GitPanel from '@/ui/pages/chat/components/git/GitPanel'
import { gitStore } from '@/ui/store/gitStore'
import { showToast } from '@/ui/components/shared/Toast'
import type { GitChangeEntry, GitStatusSnapshot } from '@/domain/git'

vi.mock('@/services/git-service', () => ({
  syncWorkspace: vi.fn(),
  refreshStatus: vi.fn(),
  refreshBranches: vi.fn(),
  setPanelOpen: vi.fn(),
  refreshOnFocus: vi.fn(),
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
}))

// 面板引用链会经 store 桶文件拉到 monaco（jsdom 里导入即崩，缺 `CSS.escape`）
vi.mock('@/monaco/setupMonaco', () => ({
  monaco: { editor: { tokenize: (): unknown[] => [] } },
  virlenDarkTheme: {},
}))

// 「在文件管理器中显示」只验路径口径，不真去弹资源管理器
vi.mock('@tauri-apps/plugin-opener', () => ({
  openPath: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}))

// toast 只验「说了什么」，不挂真实 Toast 组件
vi.mock('@/ui/components/shared/Toast', () => ({ showToast: vi.fn() }))

;(globalThis as never as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

const REPO_ROOT = '/tmp/repo'

function entry(over: Partial<GitChangeEntry>): GitChangeEntry {
  return { path: 'a.txt', orig_path: null, x: '.', y: '.', kind: 'ordinary', ...over }
}

function snapshot(entries: GitChangeEntry[]): GitStatusSnapshot {
  return {
    head: { oid: 'abc123', branch: 'main', upstream: null, ahead: 0, behind: 0 },
    entries,
    truncated: false,
  }
}

let root: ReturnType<typeof createRoot> | null = null
/** 每次挂载新建：断言「挂到输入框的是哪几条绝对路径」 */
let attached: string[] | null = null
let onAttachPaths: Mock<(paths: string[]) => void>

/** 输入框的落点替身：带 `data-file-drop-zone` 即可被 hook 认出来 */
let dropZone: HTMLDivElement

function mount() {
  dropZone = document.createElement('div')
  dropZone.className = 'input-wrapper'
  dropZone.setAttribute('data-file-drop-zone', 'true')
  document.body.appendChild(dropZone)
  // jsdom 不实现布局：落点一律算在「输入框」上
  document.elementFromPoint = () => dropZone

  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  onAttachPaths = vi.fn<(paths: string[]) => void>((paths) => {
    attached = paths
  })
  act(() =>
    root!.render(<GitPanel onClose={() => { }} onAttachPaths={onAttachPaths} />),
  )
}

function setStore(entries: GitChangeEntry[]) {
  runInAction(() => {
    gitStore.dir = REPO_ROOT
    gitStore.probed = true
    gitStore.repo = {
      root: REPO_ROOT,
      git_dir: `${REPO_ROOT}/.git`,
      bare: false,
      version: '2.44.0',
      caps: { porcelain_v2: true, switch: true, restore: true },
    }
    gitStore.unavailable = null
    gitStore.error = null
    gitStore.busy = null
    gitStore.commitDraft = ''
    gitStore.hookOutput = null
    gitStore.branches = []
    gitStore.remotes = []
    gitStore.stashes = []
    gitStore.stats = null
    gitStore.snapshot = snapshot(entries)
  })
}

function rowAt(index: number): HTMLElement {
  const row = document.querySelectorAll('.git-row')[index] as HTMLElement | undefined
  if (!row) throw new Error(`第 ${index} 行没渲染`)
  return row
}

/** 行 → 输入框的一次完整拖拽（按下 / 移动过阈值 / 松手） */
async function dragRowToInput(row: HTMLElement): Promise<void> {
  await act(async () => {
    row.dispatchEvent(
      new MouseEvent('pointerdown', {
        bubbles: true,
        button: 0,
        clientX: 120,
        clientY: 80,
      }),
    )
  })
  await act(async () => {
    document.dispatchEvent(
      new MouseEvent('pointermove', {
        bubbles: true,
        clientX: 120,
        clientY: 500,
      }),
    )
  })
  await act(async () => {
    document.dispatchEvent(
      new MouseEvent('pointerup', { bubbles: true, clientX: 120, clientY: 500 }),
    )
  })
}

async function openRowMenu(row: HTMLElement): Promise<string[]> {
  await act(async () => {
    row.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, clientX: 8, clientY: 8 }),
    )
  })
  return [...document.querySelectorAll('.context-menu-item')].map(
    (el) => el.textContent ?? '',
  )
}

async function clickMenuItem(label: string): Promise<void> {
  const item = [...document.querySelectorAll('.context-menu-item')].find(
    (el) => el.textContent === label,
  ) as HTMLElement | undefined
  if (!item) throw new Error(`菜单项「${label}」不存在`)
  await act(async () => {
    item.click()
  })
}

beforeEach(() => {
  document.body.innerHTML = ''
  attached = null
  vi.mocked(showToast).mockReset()
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  document.body.innerHTML = ''
})

it('拖到输入框：挂上「仓库根 + 仓库根相对路径」的绝对路径', async () => {
  setStore([entry({ path: 'src/b.ts', y: 'M' })])
  mount()
  await dragRowToInput(rowAt(0))

  expect(attached).toEqual([`${REPO_ROOT}/src/b.ts`])
})

it('拖选中集里的行：带走同侧选中的整批', async () => {
  setStore([entry({ path: 'src/a.ts', y: 'M' }), entry({ path: 'src/b.ts', y: 'M' })])
  mount()
  await act(async () => {
    rowAt(0).dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await act(async () => {
    rowAt(1).dispatchEvent(
      new MouseEvent('click', { bubbles: true, ctrlKey: true }),
    )
  })
  await dragRowToInput(rowAt(1))

  expect(attached).toEqual([`${REPO_ROOT}/src/a.ts`, `${REPO_ROOT}/src/b.ts`])
})

it('拖拽松手后的那次 click 被吞掉：不会顺手把行选中', async () => {
  setStore([entry({ path: 'a.txt', y: 'M' }), entry({ path: 'b.txt', y: 'M' })])
  mount()
  const row = rowAt(0)
  await dragRowToInput(row)

  // 浏览器在拖拽结束后补发的 click（同一轮交互）
  await act(async () => {
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  expect(row.className).not.toContain('selected')

  // 下一次正常的单击照旧生效（吞掉的只是拖拽后那一次）
  await act(async () => {
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  expect(row.className).toContain('selected')
})

it('已删除的文件不引用：不挂附件，并说明原因', async () => {
  setStore([entry({ path: 'gone.txt', y: 'D' })])
  mount()
  await dragRowToInput(rowAt(0))

  expect(onAttachPaths).not.toHaveBeenCalled()
  expect(vi.mocked(showToast)).toHaveBeenCalledWith('已删除的文件无法引用')
})

it('右键「引用到输入框」：同样走绝对路径（批量时文案写明范围）', async () => {
  setStore([entry({ path: 'src/a.ts', y: 'M' }), entry({ path: 'src/b.ts', y: 'M' })])
  mount()

  expect(await openRowMenu(rowAt(0))).toContain('引用到输入框')
  await clickMenuItem('引用到输入框')
  expect(attached).toEqual([`${REPO_ROOT}/src/a.ts`])

  // 选上两行后：文案与作用范围一致
  await act(async () => {
    rowAt(0).dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await act(async () => {
    rowAt(1).dispatchEvent(
      new MouseEvent('click', { bubbles: true, ctrlKey: true }),
    )
  })
  expect(await openRowMenu(rowAt(1))).toContain('引用 2 项到输入框')
})
