/**
 * 暂存 / 取消暂存 / 丢弃 / 撤销提交之后**行数统计必须重取**。
 *
 * 实测反馈：点「全部取消暂存」再切回「更改」tab，行内的 `+N −M` 全没了。
 * 根因不是数字丢了，而是没去重算 —— 行数按**段**存放（`staged` / `worktree`），`statOf` 只在自己
 * 那一段里找；快照变了（文件从 index 段跳到工作区段）而统计还是旧的，行就拿着旧的那一段去找 →
 * 找不到 → 不画数字。index 级动作原先只落快照、不重取统计，这一条线就是在这儿断的。
 *
 * 为什么在编排层验：面板用例（`git-panel.test.tsx`）把 `git-service` 整个 mock 掉，
 * 「动作之后有没有去重取 stats」在那儿是盲区；git 语义本身由 Rust 用例守。
 */
import { beforeEach, expect, it, vi } from 'vitest'
import { runInAction } from 'mobx'

import * as infra from '@/infrastructure/git'
import { MessageBox } from '@/ui/components/shared/MessageBox'
import { showToast } from '@/ui/components/shared/Toast'
import { gitStore } from '@/ui/store/gitStore'
import { discard, stage, undoLastCommit, unstage } from '@/services/git-service'
import type { GitChangeEntry, GitStatReport, GitStatusSnapshot } from '@/domain/git'

vi.mock('@/infrastructure/git', () => ({
  branches: vi.fn(),
  checkRefFormat: vi.fn(),
  commit: vi.fn(),
  commitAmend: vi.fn(),
  commitDetail: vi.fn(),
  commitFileSides: vi.fn(),
  deleteBranch: vi.fn(),
  diffSides: vi.fn(),
  discard: vi.fn(),
  fetchRemote: vi.fn(),
  initRepo: vi.fn(),
  isGitEnvAvailable: () => true,
  log: vi.fn(),
  merge: vi.fn(),
  mergeAbort: vi.fn(),
  mergeState: vi.fn(),
  numstat: vi.fn(),
  pick: vi.fn(),
  pickAbort: vi.fn(),
  pickResume: vi.fn(),
  pickState: vi.fn(),
  pullRemote: vi.fn(),
  pushRemote: vi.fn(),
  remotes: vi.fn(),
  renameBranch: vi.fn(),
  repoInfo: vi.fn(),
  resetPreview: vi.fn(),
  resetSoft: vi.fn(),
  stage: vi.fn(),
  status: vi.fn(),
  stashApply: vi.fn(),
  stashDrop: vi.fn(),
  stashPush: vi.fn(),
  stashRestore: vi.fn(),
  stashes: vi.fn(),
  stopTask: vi.fn(),
  switchBranch: vi.fn(),
  testRemote: vi.fn(),
  undoLastCommit: vi.fn(),
  unstage: vi.fn(),
}))

vi.mock('@/ui/components/shared/Toast', () => ({ showToast: vi.fn() }))
vi.mock('@/ui/components/shared/MessageBox', () => ({
  MessageBox: { propt: vi.fn(() => Promise.resolve(true)) },
}))
vi.mock('@/utils/telemetry', () => ({ track: vi.fn() }))

function entry(over: Partial<GitChangeEntry>): GitChangeEntry {
  return { path: 'a.txt', orig_path: null, x: '.', y: '.', kind: 'ordinary', ...over }
}

function snap(entries: GitChangeEntry[]): GitStatusSnapshot {
  return {
    head: { oid: 'c'.repeat(40), branch: 'main', upstream: null, ahead: 0, behind: 0 },
    entries,
    truncated: false,
  }
}

/** 取消暂存之后的统计：同一个文件现在落在 `worktree` 这一段 */
const REPORT_UNSTAGED: GitStatReport = {
  staged: [],
  worktree: [{ path: 'a.txt', orig_path: null, added: 3, deleted: 1 }],
}

/** 暂存之后的统计：同一个文件现在落在 `staged` 这一段 */
const REPORT_STAGED: GitStatReport = {
  staged: [{ path: 'a.txt', orig_path: null, added: 3, deleted: 1 }],
  worktree: [],
}

/** `void refreshStats()` 是异步的：等它把结果落进 store 再断言 */
async function settleStats(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
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
    // 面板开着，`refreshStats` 才会真的去取（关着它会自己跳过并清空）
    gitStore.open = true
    gitStore.snapshot = snap([entry({ x: 'M' })])
    gitStore.stats = REPORT_STAGED
    gitStore.error = null
    gitStore.errorBox = null
    gitStore.busy = null
  })
  for (const fn of Object.values(infra)) {
    if (typeof fn === 'function' && 'mockClear' in fn) vi.mocked(fn).mockReset()
  }
  vi.mocked(showToast).mockClear()
  vi.mocked(MessageBox.propt).mockClear()
})

it('取消暂存之后重取统计：文件已经跳到 worktree 段，行内才画得出 +N −M', async () => {
  vi.mocked(infra.unstage).mockResolvedValue(snap([entry({ y: 'M' })]))
  vi.mocked(infra.numstat).mockResolvedValue(REPORT_UNSTAGED)

  expect(await unstage(['a.txt'])).toBe(true)
  await settleStats()

  expect(infra.numstat).toHaveBeenCalledWith('/tmp/repo', expect.any(String))
  // 关键：stats 换成了**新的一段**（旧的那份里 worktree 是空的，行内就会不画数字）
  expect(gitStore.stats).toEqual(REPORT_UNSTAGED)
})

it('暂存之后同样重取（反方向：文件从 worktree 段跳到 staged 段）', async () => {
  runInAction(() => {
    gitStore.snapshot = snap([entry({ y: 'M' })])
    gitStore.stats = REPORT_UNSTAGED
  })
  vi.mocked(infra.stage).mockResolvedValue(snap([entry({ x: 'M' })]))
  vi.mocked(infra.numstat).mockResolvedValue(REPORT_STAGED)

  expect(await stage(['a.txt'])).toBe(true)
  await settleStats()

  expect(gitStore.stats).toEqual(REPORT_STAGED)
})

it('丢弃改动之后重取（丢完文件的行内数字也该跟着消失）', async () => {
  vi.mocked(infra.discard).mockResolvedValue(snap([]))
  vi.mocked(infra.numstat).mockResolvedValue({ staged: [], worktree: [] })

  expect(await discard(['a.txt'])).toBe(true)
  await settleStats()

  expect(infra.numstat).toHaveBeenCalled()
  expect(gitStore.stats).toEqual({ staged: [], worktree: [] })
})

it('撤销上次提交之后重取（撤掉的改动全进了暂存区，段归属整体换了）', async () => {
  vi.mocked(infra.undoLastCommit).mockResolvedValue(snap([entry({ x: 'M' })]))
  vi.mocked(infra.numstat).mockResolvedValue(REPORT_STAGED)

  expect(await undoLastCommit()).toBe(true)
  await settleStats()

  expect(gitStore.stats).toEqual(REPORT_STAGED)
})

it('重取失败不弹错误窗（行数是辅助信息，不该打断面板）', async () => {
  vi.mocked(infra.unstage).mockResolvedValue(snap([entry({ y: 'M' })]))
  vi.mocked(infra.numstat).mockRejectedValue(new Error('git diff --numstat 超时'))

  expect(await unstage(['a.txt'])).toBe(true)
  await settleStats()

  expect(gitStore.error).toContain('超时')
  expect(gitStore.errorBox).toBeNull()
})
