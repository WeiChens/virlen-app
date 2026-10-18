/**
 * git-service 的贮藏编排（只测**编排**，git 语义由 Rust 用例守）。
 *
 * 三条关键口径：
 * 1. **应用失败不等于什么都没发生**：内容冲突时 git 已经把冲突标记写进工作区 —— 错误里必须补一句，
 *    否则用户以为「没生效」，接着去提交就把标记一起提交了；
 * 2. **删除必须二次确认**（`stash drop` 是这条链上唯一不可逆的动作，界面只靠 `stash store` 兜底）；
 * 3. **写成功后列表跟着更新**：`push / apply / drop` 都回「快照 + 新列表」，不再多一次 IPC。
 */
import { beforeEach, expect, it, vi } from 'vitest'
import { runInAction } from 'mobx'

import * as infra from '@/infrastructure/git'
import { MessageBox } from '@/ui/components/shared/MessageBox'
import { showToast } from '@/ui/components/shared/Toast'
import { gitStore } from '@/ui/store/gitStore'
import {
  applyStash,
  createStash,
  dropStash,
  refreshStashes,
  undoDropStash,
} from '@/services/git-service'
import type { GitChangeEntry, GitStashEntry, GitStatusSnapshot } from '@/domain/git'

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
  numstat: vi.fn(),
  pullRemote: vi.fn(),
  pushRemote: vi.fn(),
  remotes: vi.fn(),
  renameBranch: vi.fn(),
  repoInfo: vi.fn(),
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

const OID = 'a'.repeat(40)
const STASH: GitStashEntry = { oid: OID, message: 'On main: 修登录', time: '2026-10-18T09:11:30+08:00' }

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

function setRepo(over: { stashes?: GitStashEntry[]; lastDropped?: { oid: string; message: string } | null } = {}) {
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
    gitStore.snapshot = snap([entry({ y: 'M' })])
    gitStore.stashes = over.stashes ?? []
    gitStore.lastDropped = over.lastDropped ?? null
    gitStore.open = false
    gitStore.error = null
    gitStore.errorBox = null
    gitStore.busy = null
  })
}

beforeEach(() => {
  setRepo()
  for (const fn of Object.values(infra)) {
    if (typeof fn === 'function' && 'mockClear' in fn) vi.mocked(fn).mockReset()
  }
  vi.mocked(showToast).mockClear()
  vi.mocked(MessageBox.propt).mockClear()
})

it('贮藏成功后落快照与新列表（写操作一次 IPC 拿全）', async () => {
  const after = snap([])
  vi.mocked(infra.stashPush).mockResolvedValue({ snapshot: after, stashes: [STASH] })

  expect(await createStash('修登录', true, false)).toBe(true)
  expect(infra.stashPush).toHaveBeenCalledWith('/tmp/repo', '修登录', true, false)
  expect(gitStore.snapshot).toEqual(after)
  expect(gitStore.stashes).toEqual([STASH])
  expect(showToast).toHaveBeenCalled()
})

it('应用失败且工作区出现冲突：错误里补一句「已留下冲突标记」', async () => {
  vi.mocked(infra.stashApply).mockRejectedValue(
    new Error('git stash pop 失败（退出码 1）\nCONFLICT (content): Merge conflict in a.txt'),
  )
  vi.mocked(infra.status).mockResolvedValue(
    snap([entry({ path: 'a.txt', x: 'U', y: 'U', kind: 'unmerged' })]),
  )

  expect(await applyStash(OID, false)).toBe(false)
  expect(gitStore.errorBox?.op).toBe('stash_apply')
  expect(gitStore.errorBox?.text).toContain('冲突标记')
  // 原文不能被吞掉（用户还得看 git 说了什么）
  expect(gitStore.errorBox?.text).toContain('CONFLICT')
})

it('应用失败但没有冲突（工作区被 Aborting 拒掉）：不补那句话', async () => {
  vi.mocked(infra.stashApply).mockRejectedValue(
    new Error('error: Your local changes would be overwritten by merge. Aborting'),
  )
  vi.mocked(infra.status).mockResolvedValue(snap([entry({ y: 'M' })]))

  expect(await applyStash(OID, false)).toBe(false)
  expect(gitStore.errorBox?.text).not.toContain('冲突标记')
})

it('应用并删除：成功后清掉对应条目的「撤销删除」', async () => {
  setRepo({ lastDropped: { oid: OID, message: STASH.message } })
  vi.mocked(infra.stashApply).mockResolvedValue({ snapshot: snap([]), stashes: [] })

  expect(await applyStash(OID, true)).toBe(true)
  expect(infra.stashApply).toHaveBeenCalledWith('/tmp/repo', OID, false, true)
  expect(gitStore.lastDropped).toBeNull()
})

it('删除前必须二次确认；取消则一个 git 调用都不发', async () => {
  setRepo({ stashes: [STASH] })
  vi.mocked(MessageBox.propt).mockResolvedValue(false)

  expect(await dropStash(OID)).toBe(false)
  expect(infra.stashDrop).not.toHaveBeenCalled()

  vi.mocked(MessageBox.propt).mockResolvedValue(true)
  vi.mocked(infra.stashDrop).mockResolvedValue({
    oid: OID,
    message: STASH.message,
    stashes: [],
  })

  expect(await dropStash(OID)).toBe(true)
  expect(infra.stashDrop).toHaveBeenCalledWith('/tmp/repo', OID)
  expect(gitStore.lastDropped).toEqual({ oid: OID, message: STASH.message })
})

it('撤销删除：把 oid 与消息交回 git（stash store），成功后清空撤销位', async () => {
  setRepo({ lastDropped: { oid: OID, message: STASH.message } })
  vi.mocked(infra.stashRestore).mockResolvedValue([STASH])

  await undoDropStash()

  expect(infra.stashRestore).toHaveBeenCalledWith('/tmp/repo', OID, STASH.message)
  expect(gitStore.stashes).toEqual([STASH])
  expect(gitStore.lastDropped).toBeNull()
})

it('取列表失败只落 error，不弹错误窗（打开浮层就弹窗太吵）', async () => {
  vi.mocked(infra.stashes).mockRejectedValue(new Error('git stash list 超时'))

  await refreshStashes()

  expect(gitStore.error).toContain('超时')
  expect(gitStore.errorBox).toBeNull()
})
