/**
 * GitMergeMenu — 合并浮层的界面口径（四条，都是「错了会让人以为合并成功 / 无路可走」的那类）。
 *
 * 1. **当前分支不列**（`is_head` 由 Rust 给出，前端不自己比名字）；
 * 2. **点击即合并**，`--no-ff` 开关原样传给 service；
 * 3. **「合并中」时行全禁用、只留「中止合并」**：冲突态下界面上必须有出路；
 * 4. **点浮层外关闭**（与项目其它下拉同一套 mousedown 判包含关系）。
 *
 * git 语义由 Rust 用例守（`cargo test -p virlen-core git::tests::merge`）。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { runInAction } from 'mobx'

import GitMergeMenu from '@/ui/pages/chat/components/git/GitMergeMenu'
import { gitStore } from '@/ui/store/gitStore'
import { abortMerge, loadMergeState, mergeBranch } from '@/services/git-service'
import type { GitBranchInfo } from '@/domain/git'

vi.mock('@/services/git-service', () => ({
  mergeBranch: vi.fn(() => Promise.resolve(true)),
  abortMerge: vi.fn(() => Promise.resolve(true)),
  loadMergeState: vi.fn(() => Promise.resolve(false)),
}))

;(globalThis as never as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

function branch(over: Partial<GitBranchInfo> & { name: string }): GitBranchInfo {
  return {
    is_remote: false,
    is_head: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    upstream_gone: false,
    subject: '',
    updated_at: null,
    ...over,
  }
}

let root: ReturnType<typeof createRoot> | null = null
let closed = 0

function setStore(opts: {
  branches: GitBranchInfo[]
  current?: string | null
}) {
  const current = opts.current === undefined ? 'main' : opts.current
  runInAction(() => {
    gitStore.dir = '/tmp/repo'
    gitStore.probed = true
    gitStore.repo = {
      root: '/tmp/repo',
      git_dir: '/tmp/repo/.git',
      bare: false,
      version: '2.51.0',
      caps: { porcelain_v2: true, switch: true, restore: true },
    }
    gitStore.snapshot = {
      head: {
        oid: 'c'.repeat(40),
        branch: current,
        upstream: null,
        ahead: 0,
        behind: 0,
      },
      entries: [],
      truncated: false,
    }
    gitStore.branches = opts.branches
    gitStore.busy = null
  })
}

async function mount(disabled = false) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <GitMergeMenu
        disabled={disabled}
        onClose={() => {
          closed += 1
        }}
      />,
    )
  })
}

const rows = () =>
  [...document.querySelectorAll<HTMLButtonElement>('.git-merge-menu .git-branch-item')]
const rowNames = () => rows().map((el) => el.querySelector('.git-branch-label')?.textContent)
const warn = () => document.querySelector('.git-merge-menu .git-merge-warn')
const abortBtn = () =>
  [...document.querySelectorAll<HTMLButtonElement>('.git-merge-menu button')].find(
    (el) => el.textContent === '中止合并',
  )

beforeEach(() => {
  document.body.innerHTML = ''
  closed = 0
  vi.mocked(mergeBranch).mockClear()
  vi.mocked(mergeBranch).mockResolvedValue(true)
  vi.mocked(abortMerge).mockClear()
  vi.mocked(abortMerge).mockResolvedValue(true)
  vi.mocked(loadMergeState).mockClear()
  vi.mocked(loadMergeState).mockResolvedValue(false)
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

it('列出可合并的分支，当前分支不出现', async () => {
  setStore({
    branches: [
      branch({ name: 'main', is_head: true }),
      branch({ name: 'feat/x', ahead: 2, behind: 1 }),
      branch({ name: 'origin/feat/x', is_remote: true }),
    ],
  })
  await mount()

  expect(rowNames()).toEqual(['feat/x', 'origin/feat/x'])
  // 落差与「远程」标签都要看得见（远程分支合并前必须知道自己选的是哪个）
  expect(rows()[0].textContent).toContain('↑2 ↓1')
  expect(rows()[1].textContent).toContain('远程')
  // 标题写明「合并到谁」
  expect(document.querySelector('.git-merge-title')?.textContent).toBe('合并到 main')
})

it('点击分支就合并，--no-ff 开关原样传下去', async () => {
  setStore({ branches: [branch({ name: 'main', is_head: true }), branch({ name: 'feat' })] })
  await mount()

  await act(async () => rows()[0].click())
  expect(mergeBranch).toHaveBeenCalledWith('feat', false)
  // 成功即关浮层
  expect(closed).toBe(1)
})

it('勾上「不使用快进」后合并带 --no-ff', async () => {
  setStore({ branches: [branch({ name: 'main', is_head: true }), branch({ name: 'feat' })] })
  await mount()

  const box = document.querySelector<HTMLInputElement>('.git-merge-opt input')!
  act(() => box.click())
  await act(async () => rows()[0].click())
  expect(mergeBranch).toHaveBeenCalledWith('feat', true)
})

it('合并失败（冲突）时不关浮层，并重新读合并状态', async () => {
  vi.mocked(mergeBranch).mockResolvedValue(false)
  vi.mocked(loadMergeState).mockResolvedValue(true)
  setStore({ branches: [branch({ name: 'main', is_head: true }), branch({ name: 'feat' })] })
  await mount()

  await act(async () => rows()[0].click())
  expect(closed).toBe(0)
  expect(warn()).toBeTruthy()
  // 合并中：行全禁用（git 会拒），只剩「中止合并」可点
  expect(rows().every((el) => el.disabled)).toBe(true)
  expect(abortBtn()!.disabled).toBe(false)
})

it('「合并中」时给中止入口：确认后撤掉并把提示收起来', async () => {
  vi.mocked(loadMergeState).mockResolvedValue(true)
  setStore({ branches: [branch({ name: 'main', is_head: true }), branch({ name: 'feat' })] })
  await mount()

  expect(warn()?.textContent).toContain('正在合并中')
  await act(async () => abortBtn()!.click())

  expect(abortMerge).toHaveBeenCalledTimes(1)
  expect(warn()).toBeNull()
})

it('搜索框过滤分支名（大小写不敏感）', async () => {
  setStore({
    branches: [
      branch({ name: 'main', is_head: true }),
      branch({ name: 'Feat/Login' }),
      branch({ name: 'fix/typo' }),
    ],
  })
  await mount()

  const input = document.querySelector<HTMLInputElement>('.git-merge-menu input')!
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set
    setter?.call(input, 'feat')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(rowNames()).toEqual(['Feat/Login'])
})

it('只读沙盒：行与中止都禁用（Rust 侧同样会拒）', async () => {
  vi.mocked(loadMergeState).mockResolvedValue(true)
  setStore({ branches: [branch({ name: 'main', is_head: true }), branch({ name: 'feat' })] })
  await mount(true)

  expect(rows().every((el) => el.disabled)).toBe(true)
  expect(abortBtn()!.disabled).toBe(true)
})

it('游离 HEAD：没有「当前分支」，标题改成合并到 HEAD，所有分支都可选', async () => {
  setStore({ branches: [branch({ name: 'feat' })], current: null })
  await mount()

  expect(document.querySelector('.git-merge-title')?.textContent).toBe('合并到当前 HEAD')
  expect(rowNames()).toEqual(['feat'])
})

it('点浮层外关闭', async () => {
  setStore({ branches: [branch({ name: 'feat' })] })
  await mount()

  act(() => {
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  })
  expect(closed).toBe(1)
})
