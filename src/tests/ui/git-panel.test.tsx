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
import { gitStore } from '@/ui/store/gitStore'
import {
  commit,
  discard,
  loadDiffSides,
  refreshStatus,
  stage,
  unstage,
} from '@/services/git-service'
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
}))

// 面板的引用链会经 store 桶文件拉到 markdown / code-block → monaco，而 monaco 在 jsdom 里
// 导入即崩（缺 `CSS.escape`）。本用例不看代码块，换结构等价的最小替身（与其它 UI 用例同款）。
vi.mock('@/monaco/setupMonaco', () => ({
  monaco: { editor: { tokenize: (): unknown[] => [] } },
  virlenDarkTheme: {},
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
    gitStore.error = null
    gitStore.busy = null
    gitStore.commitDraft = ''
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
  for (const fn of [stage, unstage, discard, commit, refreshStatus, loadDiffSides]) {
    vi.mocked(fn).mockReset()
  }
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
  expect(commit).toHaveBeenCalledWith('feat: 面板')
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

  // DOM 顺序 = 文件类型图标 → 文件名 → 目录 → 状态字母 → 动作排（字母贴左会抢文件名的位置）
  expect(
    [...rows[0].children].map((el) => el.getAttribute('class')?.split(' ')[0]),
  ).toEqual(
    ['git-row-icon', 'git-row-name', 'git-row-dir', 'git-row-letter', 'git-row-actions'],
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
