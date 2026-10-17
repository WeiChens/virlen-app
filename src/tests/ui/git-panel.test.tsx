/**
 * GitPanel — 面板主体的界面行为（实测反馈里那几条，都是「看起来小事、错了很难受」的那种）。
 *
 * 1. **提交区只在暂存区非空时出现**：没有可提交的东西时，它是白占一行、还让人以为「该写点什么」；
 * 2. **提交按钮在行尾**：主操作落在右下（与全项目一致），左侧留给「已暂存 N 个文件」这类状态提示；
 * 3. **行内小按钮是图标按钮**：三个按钮都得有 `title` + `aria-label`（读屏别念出「＋」），
 *    「丢弃」用的是 `UndoSvg` 而不是字符 `↺`（后者与刷新图标同形，被读成「刷新一下」）；
 * 4. **段标题右侧的「全部暂存」一直存在**（它是批量入口，不能因为「没样式」而被当成裸文字）；
 * 5. **单击 = 选中、双击 = 打开差异**；Ctrl / Shift 多选后点行内按钮即作用于同侧选中的全部
 *    （按钮文案会写明「… N 个文件」，点之前就知道它带走几个）。
 *
 * 数据与写操作全部 mock：这里只验界面，git 语义由 Rust 用例（`cargo test -p virlen-core git`）守。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { runInAction } from 'mobx'

import GitPanel from '@/ui/pages/chat/components/git/GitPanel'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { gitStore } from '@/ui/store/gitStore'
import {
  commit,
  checkRefFormat,
  discard,
  initRepo,
  loadCommitDetail,
  loadDiffSides,
  refreshStatus,
  refreshRemotes,
  renameBranch,
  removeBranch,
  stage,
  switchBranch,
  unstage,
  undoLastCommit,
} from '@/services/git-service'
import type { GitBranchInfo, GitChangeEntry, GitStatusSnapshot } from '@/domain/git'

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
  // 本轮新增的四个入口（amend / 撤销 / 初始化 / 分支删改名）
  undoLastCommit: vi.fn(),
  initRepo: vi.fn(),
  loadCommitDetail: vi.fn(),
  removeBranch: vi.fn(),
  renameBranch: vi.fn(),
  // 远程（凭据策略 = SSH）：同步浮层用
  refreshRemotes: vi.fn(),
  fetchRemote: vi.fn(),
  pullRemote: vi.fn(),
  pushRemote: vi.fn(),
  testRemote: vi.fn(),
  cancelSync: vi.fn(),
}))

// 面板的引用链会经 store 桶文件拉到 markdown / code-block → monaco，而 monaco 在 jsdom 里
// 导入即崩（缺 `CSS.escape`）。本用例不看代码块，换结构等价的最小替身（与其它 UI 用例同款）。
vi.mock('@/monaco/setupMonaco', () => ({
  monaco: { editor: { tokenize: (): unknown[] => [] } },
  virlenDarkTheme: {},
}))

// 「在文件管理器中显示」只验「交给了正确的绝对路径」，不真去弹资源管理器
vi.mock('@tauri-apps/plugin-opener', () => ({
  openPath: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}))

;(globalThis as never as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

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

/** 一条已暂存（X 侧有改动）的变更 */
const stagedEntry = (path: string): GitChangeEntry => entry({ path, x: 'M' })
/** 一条工作区有改动（Y 侧有改动）的变更 */
const unstagedEntry = (path: string): GitChangeEntry => entry({ path, y: 'M' })
/** 一条未跟踪的变更（porcelain 的 `?` 记录：两侧都是 `?`） */
const untrackedEntry = (path: string): GitChangeEntry =>
  entry({ path, x: '?', y: '?', kind: 'untracked' })

let root: ReturnType<typeof createRoot> | null = null

function mount() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(<GitPanel onClose={() => {}} />))
}

function setStore(entries: GitChangeEntry[]) {
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
    gitStore.notRepo = false
    gitStore.error = null
    gitStore.busy = null
    gitStore.commitDraft = ''
    gitStore.hookOutput = null
    gitStore.branches = []
    gitStore.remotes = []
    gitStore.syncOutput = null
    gitStore.snapshot = snapshot(entries)
  })
}

function click(el: Element | null | undefined) {
  if (!el) throw new Error('要点的元素不存在')
  act(() => (el as HTMLElement).click())
}

/** 带修饰键的点击（Ctrl / Shift 多选）—— 原生 click() 没法带 modifier */
function clickWith(el: Element, init: MouseEventInit) {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, ...init }))
  })
}

/** 当前选中的行（DOM 上就是 .git-row.selected），按列表顺序给出去重的路径 */
function selectedPaths(): string[] {
  return [
    ...document.querySelectorAll('.git-row.selected .git-row-name'),
  ].map((el) => el.textContent ?? '')
}

/** 第 n 行的两个行内按钮（顺序：[丢弃/取消暂存, 暂存]） */
function rowButtons(row: Element): HTMLButtonElement[] {
  return [...row.querySelectorAll('.git-row-actions button')] as HTMLButtonElement[]
}

beforeEach(() => {
  document.body.innerHTML = ''
  for (const fn of [
    stage,
    unstage,
    discard,
    commit,
    refreshStatus,
    loadDiffSides,
    undoLastCommit,
    initRepo,
    removeBranch,
    renameBranch,
    checkRefFormat,
    loadCommitDetail,
  ]) {
    vi.mocked(fn).mockReset()
  }
  vi.mocked(revealItemInDir).mockClear()
  vi.mocked(loadDiffSides).mockResolvedValue({
    old_text: 'a',
    new_text: 'b',
    old_label: 'index',
    new_label: 'worktree',
    binary: false,
    truncated: false,
  })
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
})

it('暂存区为空：不渲染提交区（也没有可提交的东西），但批量入口仍在', () => {
  setStore([unstagedEntry('work.txt'), unstagedEntry('b.txt')])
  mount()

  expect(document.querySelector('.git-commit')).toBeNull()
  expect(document.querySelector('.git-primary-btn')).toBeNull()
  // 「更改」段与它的「全部暂存」都还在 —— 提交区消失不等于没有出路
  expect(
    document.querySelector('.git-section-title .git-row-btn')?.textContent,
  ).toBe('全部暂存')
  expect(document.querySelectorAll('.git-row').length).toBe(2)
})

it('暂存区非空：提交区出现，提示在左、提交按钮在行尾', () => {
  setStore([stagedEntry('staged.txt'), unstagedEntry('work.txt')])
  mount()

  const row = document.querySelector('.git-commit-row')
  expect(row).not.toBeNull()
  // 第一个子元素是状态提示，最后一个才是主按钮（.git-spacer 把按钮顶到右侧）
  expect(row!.firstElementChild?.className).toBe('git-hint')
  expect(row!.firstElementChild?.textContent).toBe('已暂存 1 个文件')
  expect(row!.lastElementChild?.className).toBe('git-primary-btn')
  expect(row!.lastElementChild?.textContent).toBe('提交')
})

it('提交按钮：草稿为空时禁用，写入草稿后可点，并把草稿交给 commit()', () => {
  setStore([stagedEntry('staged.txt')])
  mount()

  const btn = () => document.querySelector('.git-primary-btn') as HTMLButtonElement
  expect(btn().disabled).toBe(true)

  const box = document.querySelector('.git-commit textarea') as HTMLTextAreaElement
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )?.set
    setter?.call(box, 'feat: 面板')
    box.dispatchEvent(new Event('input', { bubbles: true }))
  })

  expect(btn().disabled).toBe(false)
  click(btn())
  expect(commit).toHaveBeenCalledWith('feat: 面板', false)
})

it('未跟踪就在「更改」段里（不再单列），行内排布 = 图标在左、状态字母在最右', () => {
  setStore([unstagedEntry('a.txt'), untrackedEntry('new.ts')])
  mount()

  // 只有「更改」一段（未跟踪不另起一段）；已跟踪的改动在前、未跟踪在后
  const titles = [...document.querySelectorAll('.git-section-title')].map(
    (el) => el.firstElementChild?.textContent,
  )
  expect(titles).toEqual(['更改'])
  const rows = [...document.querySelectorAll('.git-row')]
  expect(rows.length).toBe(2)
  expect(
    rows.map((r) => r.querySelector('.git-row-letter')?.textContent),
  ).toEqual(['M', '?'])

  // DOM 顺序 = 文件类型图标 → 文件名 → 目录 → 动作排 → **状态字母**（字母贴左会抢文件名的位置，
  // 所以它贴最右；动作排在其**左**，平时 `opacity: 0` 不显形 —— 位置不随 hover 变）
  expect(
    [...rows[0].children].map((el) => el.getAttribute('class')?.split(' ')[0]),
  ).toEqual(
    ['git-row-icon', 'git-row-name', 'git-row-dir', 'git-row-actions', 'git-row-letter'],
  )
  // 图标按扩展名分档（FileTypeIcon 的默认档也不为空 = 这一列不会时有时无）
  expect(rows[0].querySelector('.git-row-icon')).not.toBeNull()
  expect(rows[1].querySelector('.git-row-icon')).not.toBeNull()

  // 合并后的「全部暂存」仍然是「没暂存的全暂存」（未跟踪不能因为换了个位置就被漏掉）
  click(document.querySelector('.git-section-title .git-row-btn'))
  expect(stage).toHaveBeenCalledWith(['a.txt', 'new.ts'])
})

it('未跟踪也能选中并批量暂存（它就是普通的一行）', () => {
  setStore([unstagedEntry('a.txt'), untrackedEntry('new.ts')])
  mount()

  const rows = [...document.querySelectorAll('.git-row')]
  click(rows[0])
  clickWith(rows[1], { ctrlKey: true })

  const stageBtn = rowButtons(rows[1])[1]
  expect(stageBtn.getAttribute('aria-label')).toBe('暂存 2 个文件')
  click(stageBtn)
  expect(stage).toHaveBeenCalledWith(['a.txt', 'new.ts'])
})

it('行内按钮：丢弃用 undo 图标（不再是像刷新的 ↺），三个按钮都有 title + aria-label', () => {
  setStore([unstagedEntry('work.txt')])
  mount()

  const actions = document.querySelector('.git-row-actions')!
  const buttons = [...actions.querySelectorAll('button')]

  // 顺序：先「丢弃」后「暂存」（与 VS Code 的 hover 工具条一致）
  expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
    '丢弃更改',
    '暂存更改',
  ])
  for (const b of buttons) {
    expect(b.getAttribute('title')).toBe(b.getAttribute('aria-label'))
  }
  // 丢弃那颗有 SVG 图标；整个面板里不再出现 ↺ 这个字符
  expect(buttons[0].classList.contains('danger')).toBe(true)
  expect(buttons[0].querySelector('svg')).not.toBeNull()
  expect(document.body.textContent).not.toContain('↺')

  click(buttons[1])
  expect(stage).toHaveBeenCalledWith(['work.txt'])
  click(buttons[0])
  expect(discard).toHaveBeenCalledWith(['work.txt'])
})

it('已暂存的行：只给「取消暂存」，且没有丢弃入口', () => {
  setStore([stagedEntry('staged.txt')])
  mount()

  const buttons = [...document.querySelectorAll('.git-row-actions button')]
  expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(['取消暂存'])
  expect(document.querySelector('.git-row-btn.danger')).toBeNull()

  click(buttons[0])
  expect(unstage).toHaveBeenCalledWith(['staged.txt'])
})

it('多选：单击只选它、Ctrl 加 / 减、Shift 按列表顺序取一段范围', () => {
  setStore([
    unstagedEntry('a.txt'),
    unstagedEntry('b.txt'),
    unstagedEntry('c.txt'),
  ])
  mount()

  const rows = [...document.querySelectorAll('.git-row')]
  click(rows[1])
  expect(selectedPaths()).toEqual(['b.txt'])

  clickWith(rows[2], { ctrlKey: true })
  expect(selectedPaths()).toEqual(['b.txt', 'c.txt'])

  // 再 Ctrl 一次 = 从选中集里减掉
  clickWith(rows[2], { ctrlKey: true })
  expect(selectedPaths()).toEqual(['b.txt'])

  // Shift：从锚点扩一段（锚点 = **最后一次点击的那一行**，与资源管理器一致）；区间是闭合的
  click(rows[1])
  clickWith(rows[2], { shiftKey: true })
  expect(selectedPaths()).toEqual(['b.txt', 'c.txt'])

  // Ctrl+Shift：在已有选中集上追加这一段（带修饰键时 Ctrl 点击也会挪锚点）
  click(rows[0])
  clickWith(rows[2], { shiftKey: true, ctrlKey: true })
  expect(selectedPaths()).toEqual(['a.txt', 'b.txt', 'c.txt'])
})

it('批量：点选中行里的按钮作用于同侧选中的全部，文案写明作用范围', () => {
  setStore([
    stagedEntry('s.txt'),
    unstagedEntry('a.txt'),
    unstagedEntry('b.txt'),
  ])
  mount()

  // 列表顺序 = 段顺序：s.txt（暂存的更改）、a.txt、b.txt（更改）
  const rows = [...document.querySelectorAll('.git-row')]
  click(rows[1])
  clickWith(rows[2], { ctrlKey: true })

  const stageBtn = rowButtons(rows[2])[1]
  expect(stageBtn.getAttribute('aria-label')).toBe('暂存 2 个文件')
  click(stageBtn)
  expect(stage).toHaveBeenCalledWith(['a.txt', 'b.txt'])

  // 未选中的那一行：只作用于它自己（「取消暂存」不带数量）
  const unstageBtn = rowButtons(rows[0])[0]
  expect(unstageBtn.getAttribute('aria-label')).toBe('取消暂存')
  click(unstageBtn)
  expect(unstage).toHaveBeenCalledWith(['s.txt'])
})

it('批量只取同侧：选中集里混了已暂存的行，点「暂存更改」不会把它也走一遍', () => {
  setStore([stagedEntry('s.txt'), unstagedEntry('a.txt')])
  mount()

  const rows = [...document.querySelectorAll('.git-row')]
  click(rows[0])
  clickWith(rows[1], { ctrlKey: true })

  const stageBtn = rowButtons(rows[1])[1]
  // 同侧只有它自己 → 单数文案（不是「暂存 2 个文件」）
  expect(stageBtn.getAttribute('aria-label')).toBe('暂存更改')
  click(stageBtn)
  expect(stage).toHaveBeenCalledWith(['a.txt'])
})

it('双击才打开差异：单击只选中（多选几个一起处理是高频路径）', async () => {
  setStore([unstagedEntry('a.txt')])
  mount()

  const row = document.querySelector('.git-row')!
  expect(row.getAttribute('title')).toContain('双击查看差异')

  click(row)
  expect(document.querySelector('.git-diff-modal')).toBeNull()

  await act(async () => {
    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  })
  expect(document.querySelector('.git-diff-modal')).not.toBeNull()
  expect(loadDiffSides).toHaveBeenCalledWith('a.txt', 'worktree', null)
})

// ==================== 分支浮层：远程分支 ====================

/** 分支列表（浮层用它渲染；点远程分支必须走 detach） */
function setBranches(list: Partial<GitBranchInfo>[]): void {
  runInAction(() => {
    gitStore.branches = list.map(
      (b): GitBranchInfo => ({
        name: 'main',
        is_remote: false,
        is_head: false,
        upstream: null,
        ahead: 0,
        behind: 0,
        upstream_gone: false,
        subject: '',
        updated_at: null,
        ...b,
      }),
    )
  })
}

/** 点仓库栏左边那个入口（分支名按钮 / 游离 HEAD 徽标）打开浮层 */
function openBranchMenu(): void {
  click(
    document.querySelector('.git-branch-btn') ??
      document.querySelector('.git-detached'),
  )
}

function branchItem(name: string): Element {
  const el = [...document.querySelectorAll('.git-branch-item')].find((n) =>
    n.textContent?.includes(name),
  )
  if (!el) throw new Error(`分支浮层里没有 ${name}`)
  return el
}

/**
 * ⚠️ 实测反馈：点远程分支报 `fatal: a branch is expected, got remote branch 'origin/master'`
 * —— `git switch` 只收本地分支名。所以远程行必须带 `detach: true`，本地行不能带。
 */
it('分支浮层：点本地分支 = switch，点远程分支 = detach', () => {
  setStore([unstagedEntry('a.txt')])
  setBranches([
    { name: 'main', is_head: true },
    { name: 'feature' },
    { name: 'origin/master', is_remote: true },
  ])
  mount()
  openBranchMenu()

  click(branchItem('feature'))
  expect(switchBranch).toHaveBeenCalledWith('feature', false, null, false)

  click(branchItem('origin/master'))
  expect(switchBranch).toHaveBeenCalledWith('origin/master', false, null, true)
})

/**
 * ⚠️ detach 之后 `head.branch` 就是 `null`，分支名按钮不再渲染 —— 那个「游离 HEAD」徽标
 * 必须是**可点的入口**，否则切到远程分支就是「一去不返」。
 */
it('游离 HEAD 徽标仍能点开分支浮层（detach 不是死路）', () => {
  setStore([unstagedEntry('a.txt')])
  runInAction(() => {
    if (gitStore.snapshot) gitStore.snapshot.head.branch = null
  })
  setBranches([{ name: 'main' }])
  mount()

  const badge = document.querySelector('.git-detached')
  expect(badge?.textContent).toBe('游离 HEAD')
  expect(badge?.tagName).toBe('BUTTON') // 不是 span：它得能点

  click(badge)
  expect(document.querySelector('.git-branch-menu')).not.toBeNull()
  // 浮层里能切回本地分支（回到分支的路）
  expect(branchItem('main')).not.toBeNull()
})

// ==================== 提交输出（hooks）/ 在文件管理器中显示 ====================

/**
 * 提交时 git 把 hooks 的输出 / 警告写在 **stderr**（正常提交为空）—— 那份内容以前直接丢了：
 * 用户只知道「提交成功了」，不知道 pre-commit 改过文件。
 */
it('提交输出块只在有 stderr 时出现，且能手动关掉', () => {
  setStore([stagedEntry('a.txt')])
  mount()
  // 正常提交（stderr 空）不占位 —— 否则每次提交都贴一段「1 file changed」噪声
  expect(document.querySelector('.git-hook-output')).toBeNull()

  act(() => {
    runInAction(() => {
      gitStore.hookOutput = 'pre-commit: prettier 已重写 2 个文件'
    })
  })
  expect(document.querySelector('.git-hook-output pre')?.textContent).toContain(
    'pre-commit',
  )

  click(document.querySelector('.git-hook-output .git-close'))
  expect(document.querySelector('.git-hook-output')).toBeNull()
  expect(gitStore.hookOutput).toBeNull()
})

/** 右键菜单里点开的必须是「仓库根 + 仓库根相对路径」的绝对路径（交相对路径会定位错目录） */
it('变更行右键：「在文件管理器中显示」给的是绝对路径', async () => {
  setStore([unstagedEntry('src/b.ts')])
  mount()
  const row = document.querySelector('.git-row')
  if (!row) throw new Error('变更行没渲染')
  await act(async () => {
    row.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, clientX: 8, clientY: 8 }),
    )
  })
  const item = [...document.querySelectorAll('.context-menu-item')].find(
    (el) => el.textContent === '在文件管理器中显示',
  )
  expect(item).toBeTruthy()
  await act(async () => {
    ;(item as HTMLElement).click()
  })
  expect(revealItemInDir).toHaveBeenCalledWith('/tmp/repo/src/b.ts')
})

/** 删除的文件在工作区里已不存在 —— 给了这一项也只是「点一下报错」 */
it('已删除的文件不给「在文件管理器中显示」', async () => {
  setStore([entry({ path: 'gone.txt', y: 'D' })])
  mount()
  const row = document.querySelector('.git-row')
  if (!row) throw new Error('变更行没渲染')
  await act(async () => {
    row.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, clientX: 8, clientY: 8 }),
    )
  })
  const labels = [...document.querySelectorAll('.context-menu-item')].map(
    (el) => el.textContent,
  )
  expect(labels).toContain('查看差异')
  expect(labels).not.toContain('在文件管理器中显示')
})

// ==================== amend / 撤销上次提交 / 初始化仓库 ====================

/** React 受控输入：得绕过 React 自己的 value 追踪才算真的「输入」 */
function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!
    .set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

/** 勾上 amend：草稿空时用上一条的**完整信息**回填（改信息是 amend 最常见的用途） */
it('「修改上一次提交」勾上后提交走 amend，并回填上一条的提交信息', async () => {
  setStore([stagedEntry('a.txt')])
  vi.mocked(loadCommitDetail).mockResolvedValue({
    oid: 'abc123',
    short_oid: 'abc123',
    author_name: 'tester',
    author_email: 't@example.com',
    author_time: '2026-10-16T10:00:00+08:00',
    message: '上一条提交\n\n正文',
    parents: [],
    files: [],
  })
  mount()

  const box = document.querySelector('.git-amend input') as HTMLInputElement
  expect(box).toBeTruthy()
  await act(async () => {
    box.click()
  })
  expect(gitStore.commitDraft).toBe('上一条提交\n\n正文')

  const primary = document.querySelector('.git-primary-btn') as HTMLElement
  expect(primary.textContent).toBe('修改提交')
  await act(async () => {
    primary.click()
  })
  expect(commit).toHaveBeenCalledWith('上一条提交\n\n正文', true)
})

/** 撤销入口只在**有提交**时出现（空仓库里它没有意义）。
    ⚠️ 它是图标按钮（头部已有一排图标，六字文字按钮会把分支名挤没），所以按 aria-label 找 */
const undoBtn = () =>
  [...document.querySelectorAll('.git-icon-btn')].find(
    (el) => el.getAttribute('aria-label') === '撤销上次提交',
  ) as HTMLElement | undefined

it('「撤销上次提交」只在有提交时出现', async () => {
  setStore([unstagedEntry('a.txt')])
  runInAction(() => {
    if (gitStore.snapshot) gitStore.snapshot.head.oid = null
  })
  mount()
  expect(undoBtn()).toBeUndefined()
  act(() => root!.unmount())
  root = null
  document.body.innerHTML = ''

  setStore([unstagedEntry('a.txt')])
  mount()
  const undo = undoBtn() as HTMLElement
  expect(undo.getAttribute('title')).toContain('改动保留在暂存区')
  await act(async () => {
    undo.click()
  })
  expect(undoLastCommit).toHaveBeenCalled()
})

/** 「不是仓库」是个可继续的状态：面板里必须有「初始化仓库」这个出口 */
it('不是仓库时给「初始化仓库」入口', async () => {
  setStore([])
  runInAction(() => {
    gitStore.repo = null
    gitStore.snapshot = null
    gitStore.notRepo = true
    gitStore.unavailable = '当前工作目录不是 Git 仓库'
  })
  mount()

  const btn = document.querySelector('.git-init-row button') as HTMLElement
  expect(btn.textContent).toBe('初始化仓库')
  await act(async () => {
    btn.click()
  })
  expect(initRepo).toHaveBeenCalled()
})

// ==================== 分支右键：重命名 / 删除 ====================

async function openRowMenu(name: string): Promise<string[]> {
  await act(async () => {
    branchItem(name).dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, clientX: 6, clientY: 6 }),
    )
  })
  return [...document.querySelectorAll('.context-menu-item')].map(
    (el) => el.textContent ?? '',
  )
}

it('分支右键：当前分支只给重命名，其它本地分支多出两个删除项；远程分支不开菜单', async () => {
  setStore([unstagedEntry('a.txt')])
  setBranches([
    { name: 'main', is_head: true },
    { name: 'wip' },
    { name: 'origin/main', is_remote: true },
  ])
  mount()
  openBranchMenu()

  expect(await openRowMenu('main')).toEqual(['重命名分支'])
  // 关掉右键菜单：点在**浮层内、菜单外**的元素上（点 document 会把整个分支浮层也关掉）
  await act(async () => {
    branchItem('main').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  })

  expect(await openRowMenu('wip')).toEqual([
    '重命名分支',
    '删除分支',
    '强制删除分支',
  ])
  await act(async () => {
    branchItem('wip').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  })

  // 远程跟踪分支：删 / 改名对 refs/remotes/* 没有意义 —— 右键不开菜单
  await act(async () => {
    branchItem('origin/main').dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, clientX: 6, clientY: 6 }),
    )
  })
  expect(document.querySelectorAll('.context-menu-item').length).toBe(0)
})

it('分支重命名：右键进重命名模式，输入框带旧名字，回车调用 renameBranch', async () => {
  setStore([unstagedEntry('a.txt')])
  setBranches([{ name: 'wip' }])
  vi.mocked(checkRefFormat).mockResolvedValue(true)
  mount()
  openBranchMenu()

  await openRowMenu('wip')
  const renameItem = [...document.querySelectorAll('.context-menu-item')].find(
    (el) => el.textContent === '重命名分支',
  ) as HTMLElement
  await act(async () => {
    renameItem.click()
  })

  const input = document.querySelector('.git-branch-menu input') as HTMLInputElement
  // 改名模式：输入框带着旧名字，且不再渲染「新建分支」行（两个动作不抢同一个回车）
  expect(input.value).toBe('wip')
  expect(document.querySelector('.git-branch-item.create')).toBeNull()

  await act(async () => {
    typeInto(input, 'wip2')
  })
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  expect(renameBranch).toHaveBeenCalledWith('wip', 'wip2')
})

// ==================== 远程（凭据策略 = SSH） ====================

const sshRemote = {
  name: 'origin',
  url: 'git@github.com:a/b.git',
  push_url: 'git@github.com:a/b.git',
  kind: 'ssh' as const,
}

/** 同步入口在面板头上：点它才刷新远程列表（远程是用户随时会用终端改的，不缓存） */
it('「同步」打开远程浮层：远程名 + 类型 + 三个动作', async () => {
  setStore([unstagedEntry('a.txt')])
  runInAction(() => {
    gitStore.remotes = [sshRemote]
  })
  mount()

  const trigger = document.querySelector('.git-sync-trigger') as HTMLElement
  expect(trigger.textContent).toBe('同步')
  await act(async () => {
    trigger.click()
  })
  expect(refreshRemotes).toHaveBeenCalled()

  const menu = document.querySelector('.git-sync-menu') as HTMLElement
  expect(menu).toBeTruthy()
  expect(menu.querySelector('.git-sync-remote')?.textContent).toBe('origin')
  expect(menu.querySelector('.git-sync-kind')?.textContent).toBe('SSH')
  expect(menu.textContent).toContain('git@github.com:a/b.git')
  expect(
    [...menu.querySelectorAll('.git-sync-btn')].map((el) => el.textContent),
  ).toEqual(['获取', '拉取（仅快进）', '推送'])
})

/** 网络操作的输出进自己的块：它与「提交输出（hooks）」不是一回事，共用一块会互相覆盖 */
it('网络操作的输出落在「操作输出」块里，与提交输出来源分开', () => {
  setStore([unstagedEntry('a.txt')])
  runInAction(() => {
    gitStore.hookOutput = 'pre-commit: 格式化过 1 个文件'
    gitStore.syncOutput = 'To github.com:a/b.git\n   abc1234..def5678  main -> main'
  })
  mount()

  const blocks = [...document.querySelectorAll('.git-hook-output')]
  expect(blocks.length).toBe(2)
  expect(blocks[0].querySelector('.git-hook-head')?.textContent).toContain(
    '提交输出（hooks / 警告）',
  )
  expect(blocks[1].querySelector('.git-hook-head')?.textContent).toContain('操作输出')
  expect(blocks[1].querySelector('pre')?.textContent).toContain('main -> main')
})
