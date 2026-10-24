/**
 * GitPanel — 面板主体的界面行为（实测反馈里那几条，都是「看起来小事、错了很难受」的那种）。
 *
 * 1. **提交区只在暂存区非空时出现**（唯一例外：amend 模式下也出现 —— 只改提交信息也得有地方写）：
 *    没有可提交的东西时，它是白占一行、还让人以为「该写点什么」；
 * 2. **提交按钮在行尾**：主操作落在右下（与全项目一致），左侧留给「已暂存 N 个文件」这类状态提示；
 * 3. **行内小按钮是图标按钮**：三个按钮都得有 `title` + `aria-label`（读屏别念出「＋」），
 *    「丢弃」用的是 `UndoSvg` 而不是字符 `↺`（后者与刷新图标同形，被读成「刷新一下」）；
 * 4. **段标题右侧的「全部暂存」一直存在**（它是批量入口，不能因为「没样式」而被当成裸文字）；
 * 5. **单击 = 选中、双击 = 打开差异**；Ctrl / Shift 多选后点行内按钮即作用于同侧选中的全部
 *    （按钮文案会写明「… N 个文件」，点之前就知道它带走几个）；
 * 6. **不常用的三个动作收在「更多」里**（同步浮层 / 撤销上次提交 / 修改上一次提交），
 *    落差数字则是**按钮**（点它 = 先拉取再推送）—— 头部宽度只够一件事一个入口。
 * 7. **变更列表一次只看一段（顶部 tab 切换）+ 提交区只挂在「暂存区」tab 下**（实测反馈）：
 *    两段并排时每列只剩一半宽度，长路径与行内操作互相挤；段顺序仍是「更改 → 暂存区」
 *    （文件暂存后往下走，而不是跑到顶上），先看改了什么，再切到暂存区写提交信息。
 * 8. **批量动作成功后 tab 跟内容走**：「全部暂存」→「暂存区」，「全部取消暂存」→「更改」
 *    （失败 / 没做成就不动 tab，错误由 git-service 报）。
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
  abortPick,
  commit,
  checkRefFormat,
  discard,
  loadCommitDetail,
  loadDiffSides,
  refreshStatus,
  refreshRemotes,
  refreshBranches,
  refreshStashes,
  renameBranch,
  removeBranch,
  resumePick,
  stage,
  switchBranch,
  syncNow,
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
  loadCommitDetail: vi.fn(),
  removeBranch: vi.fn(),
  renameBranch: vi.fn(),
  // 远程（凭据策略 = SSH）：同步浮层用
  refreshRemotes: vi.fn(),
  fetchRemote: vi.fn(),
  pullRemote: vi.fn(),
  pushRemote: vi.fn(),
  syncNow: vi.fn(),
  testRemote: vi.fn(),
  cancelSync: vi.fn(),
  // 贮藏（stash）：入口在「更多」菜单，浮层打开时才取列表
  refreshStashes: vi.fn(() => Promise.resolve()),
  createStash: vi.fn(() => Promise.resolve(true)),
  applyStash: vi.fn(() => Promise.resolve(true)),
  dropStash: vi.fn(() => Promise.resolve(true)),
  undoDropStash: vi.fn(() => Promise.resolve()),
  // 合并（merge）：入口同样在「更多」菜单，浮层打开时才取分支列表与合并状态
  mergeBranch: vi.fn(() => Promise.resolve(true)),
  abortMerge: vi.fn(() => Promise.resolve(true)),
  loadMergeState: vi.fn(() => Promise.resolve(false)),
  // 挑选 / 还原（cherry-pick / revert）：进行中时面板顶部那两颗按钺
  resumePick: vi.fn(() => Promise.resolve(true)),
  abortPick: vi.fn(() => Promise.resolve(true)),
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

  ; (globalThis as never as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
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
  act(() => root!.render(<GitPanel onClose={() => { }} onAttachPaths={() => { }} />))
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
    gitStore.hookOutput = null
    gitStore.branches = []
    gitStore.remotes = []
    gitStore.stashes = []
    gitStore.lastDropped = null
    gitStore.syncOutput = null
    gitStore.stats = null
    // 进行中的挑选 / 还原：默认“没有”（个别用例单独置位）
    gitStore.pick = null
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

/** 变更 tab 上的文案（顺序即段顺序） */
function tabLabels(): string[] {
  return [...document.querySelectorAll('.git-tab-name')].map(
    (el) => el.textContent ?? '',
  )
}

/** 当前 tab 的名称 */
function activeTab(): string {
  return document.querySelector('.git-tab.is-active .git-tab-name')?.textContent ?? ''
}

/** 切到某个变更 tab（一次只看一段） */
function clickTab(label: string) {
  const tab = [...document.querySelectorAll<HTMLElement>('.git-tab')].find(
    (el) => el.querySelector('.git-tab-name')?.textContent === label,
  )
  if (!tab) throw new Error(`tab「${label}」不存在`)
  click(tab)
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
    removeBranch,
    renameBranch,
    checkRefFormat,
    loadCommitDetail,
    resumePick,
    abortPick,
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
  // 「更改」tab 与它的「全部暂存」都还在 —— 提交区消失不等于没有出路
  expect(activeTab()).toBe('更改')
  expect(document.querySelector('.git-bulk-btn')?.textContent).toBe('全部暂存')
  expect(document.querySelectorAll('.git-row').length).toBe(2)
})

it('暂存区非空：提交区出现在暂存 tab 下，提示在左、提交按钮在行尾', () => {
  setStore([stagedEntry('staged.txt'), unstagedEntry('work.txt')])
  mount()
  // 提交区只挂在「暂存区」这一 tab 下（提交只跟暂存区有关）
  expect(document.querySelector('.git-commit')).toBeNull()
  clickTab('暂存区')

  const row = document.querySelector('.git-commit-row')
  expect(row).not.toBeNull()
  // 第一个子元素是状态提示，最后一个才是主按钮（.git-spacer 把按钮顶到右侧）
  expect(row!.firstElementChild?.className).toBe('git-hint')
  expect(row!.firstElementChild?.textContent).toBe('已暂存 1 个文件')
  expect(row!.lastElementChild?.className).toBe('git-primary-btn')
  expect(row!.lastElementChild?.textContent).toBe('提交')
})

/** tab 顺序与提交区位置（实测反馈）：两段并排挤掉一半宽度，改成 tab 切换；提交区归暂存区 */
it('tab 顺序是「更改 → 暂存区」，提交区只在暂存那个 tab 下', () => {
  setStore([stagedEntry('s.txt'), unstagedEntry('a.txt')])
  mount()

  expect(tabLabels()).toEqual(['更改', '暂存区'])
  // 默认停在「更改」：先看改了什么，再切到暂存区写提交信息
  expect(activeTab()).toBe('更改')

  clickTab('暂存区')
  expect(activeTab()).toBe('暂存区')
  // 提交区在暂存列表**之后**：先看改了哪些文件，再写提交信息
  const list = document.querySelector('.git-list') as HTMLElement
  const commitBox = document.querySelector('.git-commit') as HTMLElement
  expect(commitBox).not.toBeNull()
  expect(
    list.compareDocumentPosition(commitBox) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy()
})

/**
 * 实测反馈：批量动作把整段内容搬到了另一侧 —— 全部暂存后文件都在暂存区，留在「更改」只能
 * 看到空列表；全部取消暂存同理该回「更改」。成败以 git-service 的返回值为准。
 */
it('「全部暂存」成功后 tab 跟到「暂存区」', async () => {
  vi.mocked(stage).mockResolvedValue(true)
  setStore([unstagedEntry('a.txt'), untrackedEntry('new.ts')])
  mount()
  expect(activeTab()).toBe('更改')

  await act(async () => {
    document.querySelector<HTMLElement>('.git-bulk-btn')!.click()
  })

  expect(stage).toHaveBeenCalledWith(['a.txt', 'new.ts'])
  expect(activeTab()).toBe('暂存区')
})

it('「全部取消暂存」成功后 tab 回到「更改」', async () => {
  vi.mocked(unstage).mockResolvedValue(true)
  setStore([stagedEntry('a.txt'), stagedEntry('b.txt')])
  mount()
  // 没有未暂存的改动 → 初值落在「暂存区」
  expect(activeTab()).toBe('暂存区')

  await act(async () => {
    document.querySelector<HTMLElement>('.git-bulk-btn')!.click()
  })

  expect(unstage).toHaveBeenCalledWith(['a.txt', 'b.txt'])
  expect(activeTab()).toBe('更改')
})

it('批量动作失败（返回 false）时不动 tab', async () => {
  vi.mocked(stage).mockResolvedValue(false)
  setStore([unstagedEntry('a.txt'), unstagedEntry('b.txt')])
  mount()

  await act(async () => {
    document.querySelector<HTMLElement>('.git-bulk-btn')!.click()
  })

  expect(stage).toHaveBeenCalled()
  expect(activeTab()).toBe('更改')
})

/** 冲突段：处理掉之前一直在 tab 上，且是唯一带危险色的那一个（初值优先落到它） */
it('有冲突时多一个「冲突」tab（危险色），初值就落在那一段', () => {
  setStore([
    entry({ path: 'c.txt', x: 'U', y: 'U', kind: 'unmerged' }),
    unstagedEntry('a.txt'),
  ])
  mount()

  expect(tabLabels()).toEqual(['更改', '暂存区', '冲突'])
  expect(activeTab()).toBe('冲突')
  // 冲突是三段里唯一「必须处理」的：计数走危险色（样式契约里钉了选择器）
  expect(
    document.querySelector('.git-tab.is-danger .git-tab-name')?.textContent,
  ).toBe('冲突')
  // 冲突段没有批量入口（「暂存」对冲突文件是「标记已解决」，不能批量做）
  expect(document.querySelector('.git-bulk-btn')).toBeNull()
  expect(document.querySelectorAll('.git-row').length).toBe(1)
})

/** 空段不是白屏：各段说自己的话（否则切过去看不出是「空的」还是「没渲染」） */
it('切到空的那一段给一句空态文案', () => {
  setStore([unstagedEntry('a.txt')])
  mount()

  clickTab('暂存区')
  expect(document.querySelector('.git-list')).toBeNull()
  expect(document.querySelector('.git-empty')?.textContent).toBe('没有暂存的更改')
  // 提交区也不在（没有暂存的东西可提交）
  expect(document.querySelector('.git-commit')).toBeNull()
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

it('未跟踪就在「更改」tab 里（不再单列），行内排布 = 图标在左、状态字母在最右', () => {
  setStore([unstagedEntry('a.txt'), untrackedEntry('new.ts')])
  mount()

  // 只有「更改」一段（未跟踪不另起一段）；已跟踪的改动在前、未跟踪在后
  expect(tabLabels()).toEqual(['更改', '暂存区'])
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
  click(document.querySelector('.git-bulk-btn'))
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

  // 「更改」tab 里只有 a.txt、b.txt
  const rows = [...document.querySelectorAll('.git-row')]
  click(rows[0])
  clickWith(rows[1], { ctrlKey: true })

  const stageBtn = rowButtons(rows[1])[1]
  expect(stageBtn.getAttribute('aria-label')).toBe('暂存 2 个文件')
  click(stageBtn)
  expect(stage).toHaveBeenCalledWith(['a.txt', 'b.txt'])

  // 「暂存区」tab：未选中的那一行只作用于它自己（「取消暂存」不带数量）
  clickTab('暂存区')
  const stagedRow = document.querySelector('.git-row')!
  const unstageBtn = rowButtons(stagedRow)[0]
  expect(unstageBtn.getAttribute('aria-label')).toBe('取消暂存')
  click(unstageBtn)
  expect(unstage).toHaveBeenCalledWith(['s.txt'])
})

it('批量只取同侧：选中集里混了已暂存的行，点「暂存更改」不会把它也走一遍', () => {
  setStore([stagedEntry('s.txt'), unstagedEntry('a.txt')])
  mount()

  // 选中集是跨 tab 的（切 tab 不清选区）：先在「更改」里选 a.txt，再去暂存那边选 s.txt
  click(document.querySelector('.git-row')!)
  clickTab('暂存区')
  clickWith(document.querySelector('.git-row')!, { ctrlKey: true })
  clickTab('更改')

  const stageBtn = rowButtons(document.querySelector('.git-row')!)[1]
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
    ; (item as HTMLElement).click()
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

/** 头部「更多」菜单：点按钮展开，返回可见项文案（菜单 portal 到 body） */
async function openMoreMenu(): Promise<string[]> {
  const btn = [...document.querySelectorAll('.git-icon-btn')].find(
    (el) => el.getAttribute('aria-label') === '更多',
  ) as HTMLElement | undefined
  if (!btn) throw new Error('「更多」按钮不存在')
  await act(async () => {
    btn.click()
  })
  return [...document.querySelectorAll('.context-menu-item')].map(
    (el) => el.textContent ?? '',
  )
}

async function clickMoreItem(label: string): Promise<void> {
  const item = [...document.querySelectorAll('.context-menu-item')].find(
    (el) => el.textContent === label,
  ) as HTMLElement | undefined
  if (!item) throw new Error(`菜单项「${label}」不存在`)
  await act(async () => {
    item.click()
  })
}

/** amend 走更多菜单（勾选模式已不在提交区里）：草稿空时回填上一条的**完整信息** */
it('「修改上一次提交」在更多菜单里：提交走 amend，并回填上一条的提交信息', async () => {
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

  expect(await openMoreMenu()).toContain('修改上一次提交')
  await clickMoreItem('修改上一次提交')
  expect(gitStore.commitDraft).toBe('上一条提交\n\n正文')

  const primary = document.querySelector('.git-primary-btn') as HTMLElement
  expect(primary.textContent).toBe('修改提交')
  await act(async () => {
    primary.click()
  })
  expect(commit).toHaveBeenCalledWith('上一条提交\n\n正文', true)
})

/** amend 模式让提交区在暂存区为空时也出现 —— 只改提交信息不该被迫先暂存点东西 */
it('暂存区为空时 amend 模式仍给提交区', async () => {
  setStore([unstagedEntry('a.txt')])
  mount()

  await openMoreMenu()
  await clickMoreItem('修改上一次提交')
  // 提交区只挂在暂存 tab 下：此刻还在「更改」，amend 开着也不显示
  expect(document.querySelector('.git-commit')).toBeNull()
  // tab 本身可点，切过去就该看见它
  clickTab('暂存区')
  expect(document.querySelector('.git-commit')).toBeTruthy()
  expect(document.querySelector('.git-hint')?.textContent).toBe(
    '修改提交信息（不改动文件内容）',
  )
})

/** 撤销入口只在**有提交**时出现（空仓库里它没有意义）；它现在在更多菜单里 */
const undoItem = '撤销上次提交'

it('「撤销上次提交」只在有提交时出现在更多菜单里', async () => {
  setStore([unstagedEntry('a.txt')])
  runInAction(() => {
    if (gitStore.snapshot) gitStore.snapshot.head.oid = null
  })
  mount()
  expect(await openMoreMenu()).not.toContain(undoItem)
  act(() => root!.unmount())
  root = null
  document.body.innerHTML = ''

  setStore([unstagedEntry('a.txt')])
  mount()
  expect(await openMoreMenu()).toContain(undoItem)
  await clickMoreItem(undoItem)
  expect(undoLastCommit).toHaveBeenCalled()
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

/** 同步入口在更多菜单里：点它才刷新远程列表（远程是用户随时会用终端改的，不缓存） */
it('「同步远程」打开远程浮层：远程名 + 类型 + 三个动作', async () => {
  setStore([unstagedEntry('a.txt')])
  runInAction(() => {
    gitStore.remotes = [sshRemote]
  })
  mount()

  expect(await openMoreMenu()).toContain('同步远程（获取 / 拉取 / 推送）')
  await clickMoreItem('同步远程（获取 / 拉取 / 推送）')
  expect(refreshRemotes).toHaveBeenCalled()

  const menu = document.querySelector('.git-sync-menu') as HTMLElement
  expect(menu).toBeTruthy()
  expect(menu.querySelector('.git-sync-remote')?.textContent).toBe('origin')
  expect(menu.querySelector('.git-sync-kind')?.textContent).toBe('SSH')
  expect(menu.textContent).toContain('git@github.com:a/b.git')
  expect(
    [...menu.querySelectorAll('.git-sync-btn')].map((el) => el.textContent),
  ).toEqual(['获取', '拉取', '推送'])
})

/** 贮藏入口在更多菜单里：点开是独立浮层（面板已经两列 + 提交区，放不下第三块常驻区域） */
it('「更多」里有贮藏入口，点开才取列表', async () => {
  setStore([unstagedEntry('a.txt')])
  mount()

  expect(await openMoreMenu()).toContain('贮藏更改…')
  await clickMoreItem('贮藏更改…')

  expect(document.querySelector('.git-stash-modal')).not.toBeNull()
  // 列表只在浮层打开时取（面板刷新不轮询 stash list）
  expect(refreshStashes).toHaveBeenCalled()
})

/** 合并入口也在更多菜单里：点开才刷新分支列表（分支名是用户随时会在终端里改的） */
it('「更多」里有合并入口，点开才刷新分支列表', async () => {
  setStore([unstagedEntry('a.txt')])
  mount()

  expect(await openMoreMenu()).toContain('合并分支…')
  await clickMoreItem('合并分支…')

  expect(refreshBranches).toHaveBeenCalled()
  expect(document.querySelector('.git-merge-menu')).not.toBeNull()
})

/** 落差数字是**状态按钮**：它告诉用户「有事」，并把下一步做成同一个控件 */
it('落差数字是按钮：点它执行一次同步（先拉取再推送）', async () => {
  setStore([unstagedEntry('a.txt')])
  runInAction(() => {
    if (!gitStore.snapshot) return
    gitStore.snapshot.head.upstream = 'origin/main'
    gitStore.snapshot.head.ahead = 2
    gitStore.snapshot.head.behind = 1
  })
  mount()

  const track = document.querySelector('.git-track') as HTMLElement
  expect(track.tagName).toBe('BUTTON')
  expect(track.textContent).toBe('↑2 ↓1')
  expect(track.getAttribute('title')).toContain('origin/main')
  await act(async () => {
    track.click()
  })
  expect(syncNow).toHaveBeenCalled()
})

/** 没有落差就没有这一步动作 —— 一个 ↑0 ↓0 的按钮只是噪声 */
it('没有落差时不显示同步按钮', () => {
  setStore([unstagedEntry('a.txt')])
  mount()
  expect(document.querySelector('.git-track')).toBeNull()
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

/** 变更一多就必须走虚拟列表：几千个 `.git-row` 同时进 DOM 会直接卡在渲染上 */
it('变更很多时列表走虚拟化（不真的铺几千个 .git-row）', () => {
  // jsdom 不排版，clientHeight 恒为 0 —— 组件那时会退化成全量渲染（故意保留的兜底），
  // 所以这里先给它一个“视口高度”
  const desc = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'clientHeight',
  )
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => 400,
  })
  try {
    setStore(
      Array.from({ length: 1000 }, (_, i) => unstagedEntry(`f${i}.txt`)),
    )
    mount()
    const list = document.querySelector('.git-list') as HTMLElement
    expect(list.dataset.virtualized).toBe('true')
    expect(document.querySelectorAll('.git-row').length).toBeLessThan(80)
    // 滚动高度仍由留白撑起来（滚动条不会变成“只有一屏”）；顶部在 scrollTop=0 时不需要留白
    expect(
      list.querySelectorAll(':scope > div[aria-hidden]').length,
    ).toBeGreaterThanOrEqual(1)
  } finally {
    if (desc) Object.defineProperty(HTMLElement.prototype, 'clientHeight', desc)
  }
})

/** 一次只看一段：切 tab 换的是**同一个**滚动列表的内容（不再并排两个容器） */
it('切 tab 换列表内容：段标题不是单独一行，标题在 tab 上', () => {
  setStore([
    stagedEntry('s.txt'),
    unstagedEntry('a.txt'),
    unstagedEntry('b.txt'),
  ])
  mount()

  // 一次只渲染一个列表（46vh 的高度上限只由外层容器给）
  expect(document.querySelectorAll('.git-list-box').length).toBe(1)
  expect(document.querySelectorAll('.git-list').length).toBe(1)
  expect(document.querySelectorAll('.git-section').length).toBe(1)
  // 段标题（包括「全部暂存」那一行）不再占高度：信息全在 tab 栏上
  expect(document.querySelector('.git-section-title')).toBeNull()
  expect(activeTab()).toBe('更改')
  expect([...document.querySelectorAll('.git-row-name')].map((el) => el.textContent)).toEqual([
    'a.txt',
    'b.txt',
  ])

  clickTab('暂存区')
  expect([...document.querySelectorAll('.git-row-name')].map((el) => el.textContent)).toEqual([
    's.txt',
  ])
  // 计数跟当前 tab 对得上（s.txt 一个）
  expect(
    document.querySelector('.git-tab.is-active .git-tab-count')?.textContent,
  ).toBe('1')
})

// ==================== 行数统计（+增 −删） ====================
/**
 * 汇总**只描述当前这一段**（不再是跨段总和）：
 * - 挂在当前 tab 内容的**最下方**（列表之后）；
 * - 暂存那一段不占这一行 —— 它的数字落在提交区的 `.git-hint` 上。
 */
it('行数汇总只算当前段：更改在列表下方、暂存在提交区提示上', () => {
  setStore([stagedEntry('a.txt'), unstagedEntry('b.txt')])
  runInAction(() => {
    gitStore.stats = {
      staged: [{ path: 'a.txt', orig_path: null, added: 3, deleted: 1 }],
      worktree: [{ path: 'b.txt', orig_path: null, added: 10, deleted: 0 }],
    }
  })
  mount()

  // 「更改」tab：只有 b.txt 的行内数字
  const rowStats = () =>
    [...document.querySelectorAll('.git-row')].map(
      (r) => r.querySelector('.git-row-stat')?.textContent,
    )
  expect(rowStats()).toEqual(['+10−0'])

  const summary = document.querySelector('.git-stats-summary') as HTMLElement
  expect(summary.textContent).toContain('已编辑 1 个文件')
  // 只算这一段：a.txt（staged 那一侧）的 +3 −1 不能借进来
  expect(summary.querySelector('.git-stat-add')?.textContent).toBe('+10')
  expect(summary.querySelector('.git-stat-del')?.textContent).toBe('−0')
  expect(summary.textContent).not.toContain('…')
  // 位置：在 tab **内容区的最下方**（列表之后）
  const tabs = document.querySelector('.git-tabs') as HTMLElement
  const list = document.querySelector('.git-list') as HTMLElement
  expect(
    tabs.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy()
  expect(
    list.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy()

  // 「暂存区」tab：不占汇总行，数字落到提交区提示上
  clickTab('暂存区')
  expect(rowStats()).toEqual(['+3−1'])
  expect(document.querySelector('.git-stats-summary')).toBeNull()
  const hint = document.querySelector('.git-hint') as HTMLElement
  expect(hint.textContent).toContain('已暂存 1 个文件')
  expect(hint.querySelector('.git-stat-add')?.textContent?.trim()).toBe('+3')
  expect(hint.querySelector('.git-stat-del')?.textContent?.trim()).toBe('−1')
})

/** 二进制 / 冲突没有数字：行内不画（不写 0），合计加省略号说明「只是已知部分」 */
it('算不出行数的文件不画数字，合计加省略号', () => {
  setStore([unstagedEntry('bin.dat')])
  runInAction(() => {
    gitStore.stats = {
      staged: [],
      worktree: [{ path: 'bin.dat', orig_path: null, added: null, deleted: null }],
    }
  })
  mount()

  expect(document.querySelector('.git-row-stat')).toBeNull()
  const summary = document.querySelector('.git-stats-summary')?.textContent
  expect(summary).toContain('已编辑 1 个文件')
  expect(summary).toContain('…')
})

/** 统计还没回来（面板刚开）：不摆一排 +0 −0，只给文件数 */
it('统计未加载时不显示行数合计', () => {
  setStore([unstagedEntry('a.txt')])
  mount()

  const summary = document.querySelector('.git-stats-summary')?.textContent
  expect(summary).toContain('已编辑 1 个文件')
  expect(summary).not.toContain('+')

  // 暂存那边同理：提示只报个数，不编 +0 −0
  clickTab('暂存区')
  expect(document.querySelector('.git-stats-summary')).toBeNull()
  expect(document.querySelector('.git-hint')).toBeNull()
})

/**
 * 挑选 / 还原进行中：面板顶部要有那两颗按钺 —— 冲突解决到一半时，界面上没有终端可用，
 * 「继续」与「中止」就是全部出路（少一颗就是死路）。
 */
it('挑选进行中：顶部提示 + 「继续 / 中止」，kind 原样传下去', () => {
  setStore([entry({ path: 'c.txt', x: 'U', y: 'U', kind: 'unmerged' })])
  const PICK_OID = 'b'.repeat(40)
  runInAction(() => {
    gitStore.pick = { kind: 'cherry-pick', oid: PICK_OID }
  })
  mount()

  const warn = document.querySelector('.git-pick-warn')
  expect(warn).not.toBeNull()
  const text = warn!.querySelector('.git-pick-warn-text')
  expect(text?.textContent).toBe('正在挑选提交：解决冲突后暂存并继续')
  // 完整 oid 进 title（不把 40 位撑在面板上）
  expect(text?.getAttribute('title')).toBe(PICK_OID)

  const [resume, abort] = [...warn!.querySelectorAll('button')]
  expect(resume.textContent).toBe('继续')
  expect(abort.textContent).toBe('中止')

  click(resume)
  expect(resumePick).toHaveBeenCalledWith('cherry-pick')
  click(abort)
  expect(abortPick).toHaveBeenCalledWith('cherry-pick')
})

/** 还原中：文案说得清现在是哪个动作（两个动作的出路一样，但不能让人分不清在干什么） */
it('还原进行中：文案是「正在还原提交」', () => {
  setStore([entry({ path: 'c.txt', x: 'U', y: 'U', kind: 'unmerged' })])
  runInAction(() => {
    gitStore.pick = { kind: 'revert', oid: null }
  })
  mount()

  const text = document.querySelector('.git-pick-warn-text')
  expect(text?.textContent).toBe('正在还原提交：解决冲突后暂存并继续')
  // 拿不到 oid 就不给 title（不编一个）
  expect(text?.getAttribute('title')).toBeNull()
})

/** 没有进行中的动作：那条提示不占位 */
it('没有挑选 / 还原进行中：不出现提示条', () => {
  setStore([unstagedEntry('a.txt')])
  mount()
  expect(document.querySelector('.git-pick-warn')).toBeNull()
})
