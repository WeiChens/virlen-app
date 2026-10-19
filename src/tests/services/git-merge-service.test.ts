/**
 * git-service 的合并编排（只测**编排**，git 语义由 Rust 用例守）。
 *
 * 三条关键口径：
 * 1. **冲突不是「什么都没发生」**：`run()` 失败要落 errorBox（git 的 CONFLICT 原文在里面），
 *    并且不关浮层、不 toast 成功；
 * 2. **成功文案按 Rust 给的 oid 判定**（`up_to_date` / `fast_forward`）说清「到底做了什么」；
 * 3. **中止合并要二次确认**（会撤掉冲突解决到一半的编辑）。
 */
import { beforeEach, expect, it, vi } from 'vitest'
import { runInAction } from 'mobx'

import * as infra from '@/infrastructure/git'
import { MessageBox } from '@/ui/components/shared/MessageBox'
import { showToast } from '@/ui/components/shared/Toast'
import { gitStore } from '@/ui/store/gitStore'
import {
  abortMerge,
  loadMergeState,
  mergeBranch,
} from '@/services/git-service'
import type { GitStatusSnapshot } from '@/domain/git'

vi.mock('@/infrastructure/git', () => ({
  branches: vi.fn(),
  merge: vi.fn(),
  mergeAbort: vi.fn(),
  mergeState: vi.fn(),
  numstat: vi.fn(),
  status: vi.fn(),
  stopTask: vi.fn(),
}))

vi.mock('@/ui/components/shared/Toast', () => ({ showToast: vi.fn() }))
vi.mock('@/ui/components/shared/MessageBox', () => ({
  MessageBox: { propt: vi.fn(() => Promise.resolve(true)) },
}))
vi.mock('@/utils/telemetry', () => ({ track: vi.fn() }))

function snap(branch = 'main', oid = 'aa'): GitStatusSnapshot {
  return {
    head: { oid, branch, upstream: null, ahead: 0, behind: 0 },
    entries: [],
    truncated: false,
  }
}

const RESULT = {
  snapshot: snap('main', 'bb'),
  output: 'Fast-forward',
  up_to_date: false,
  fast_forward: true,
}

beforeEach(() => {
  for (const fn of Object.values(infra)) {
    if (typeof fn === 'function' && 'mockClear' in fn) vi.mocked(fn).mockReset()
  }
  vi.mocked(infra.branches).mockResolvedValue([])
  vi.mocked(showToast).mockClear()
  vi.mocked(MessageBox.propt).mockClear()
  vi.mocked(MessageBox.propt).mockResolvedValue(true)
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
    gitStore.snapshot = snap()
    gitStore.branches = []
    gitStore.busy = null
    gitStore.error = null
    gitStore.errorBox = null
  })
})

it('快进合并：落快照、toast 说清「快进」、并刷新分支列表', async () => {
  vi.mocked(infra.merge).mockResolvedValue(RESULT)

  expect(await mergeBranch('feat', false)).toBe(true)
  expect(infra.merge).toHaveBeenCalledWith('/tmp/repo', 'feat', false)
  expect(gitStore.snapshot).toEqual(RESULT.snapshot)
  expect(vi.mocked(showToast).mock.calls[0][0]).toContain('已快进合并')
  expect(infra.branches).toHaveBeenCalled()
})

it('已经合过了：toast 说「已经在当前分支里」，不假装做了什么', async () => {
  vi.mocked(infra.merge).mockResolvedValue({
    ...RESULT,
    snapshot: snap(),
    fast_forward: false,
    up_to_date: true,
  })

  expect(await mergeBranch('feat')).toBe(true)
  expect(vi.mocked(showToast).mock.calls[0][0]).toContain('已经在当前分支里')
})

it('非快进合并：toast 说「生成了合并提交」', async () => {
  vi.mocked(infra.merge).mockResolvedValue({ ...RESULT, fast_forward: false })

  expect(await mergeBranch('feat', true)).toBe(true)
  expect(infra.merge).toHaveBeenCalledWith('/tmp/repo', 'feat', true)
  expect(vi.mocked(showToast).mock.calls[0][0]).toContain('生成了合并提交')
})

it('冲突：错误原文进 errorBox（含 CONFLICT 清单），且不回读成「成功」', async () => {
  vi.mocked(infra.merge).mockRejectedValue(
    new Error(
      '合并产生冲突：解决冲突后提交，或中止这次合并（退出码 1）\nAuto-merging a.txt\nCONFLICT (content): Merge conflict in a.txt',
    ),
  )
  vi.mocked(infra.status).mockResolvedValue(
    snap('main', 'cc'),
  )

  expect(await mergeBranch('feat', false)).toBe(false)
  expect(gitStore.errorBox?.op).toBe('merge')
  expect(gitStore.errorBox?.text).toContain('CONFLICT')
  expect(showToast).not.toHaveBeenCalled()
  // 失败后 `run()` 会自己回读一次状态（面板的「冲突」段据此出现）
  expect(infra.status).toHaveBeenCalled()
})

it('中止合并：确认框取消 → 一个 git 调用都不发', async () => {
  vi.mocked(MessageBox.propt).mockResolvedValue(false)

  expect(await abortMerge()).toBe(false)
  expect(infra.mergeAbort).not.toHaveBeenCalled()
})

it('中止合并：确认后落新快照并提示', async () => {
  vi.mocked(infra.mergeAbort).mockResolvedValue(snap('main', 'dd'))

  expect(await abortMerge()).toBe(true)
  expect(infra.mergeAbort).toHaveBeenCalledWith('/tmp/repo')
  expect(gitStore.snapshot?.head.oid).toBe('dd')
  expect(vi.mocked(showToast).mock.calls[0][0]).toContain('已中止合并')
})

it('合并状态是读操作：不进 busy，没有仓库时直接 false', async () => {
  vi.mocked(infra.mergeState).mockResolvedValue(true)

  expect(await loadMergeState()).toBe(true)
  expect(gitStore.busy).toBeNull()

  runInAction(() => {
    gitStore.repo = null
  })
  expect(await loadMergeState()).toBe(false)
  expect(infra.mergeState).toHaveBeenCalledTimes(1)
})
