// @vitest-environment node
/**
 * 「取消」不是错误：被取代 / 被用户叫停的那次 git 调用**不许**落到 `gitStore.error`。
 *
 * 链路：`refreshStatus` / `refreshStats` 起新的一次前会 `stopTask` 旧 task，`cancelSync()`
 * （同步浮层的「取消」）也会停 —— Rust 侧 `exec` 的取消分支回的是
 * 「git 操作已取消」。如果前端把它当普通失败写进 `error`，面板上就会长期挂着一行红字：
 * `refreshStatus` 成功时刻意**不清** `error`（那是有意的，见 service 里的注释），所以它不会
 * 自己消失，直到下一次写操作 / 同步 / 换工作目录。
 *
 * 三条要守的分支（第 4 条是反例，防止对账写宽了把真错误一起吞掉）：
 * 1. status 被下一次刷新取代 → 静默；
 * 2. numstat 被下一次取代 → 静默；
 * 3. 同步被 `cancelSync()` 取消 → 静默（也不弹 `errorBox`、不 toast 成功）；
 * 4. **真失败仍然照常落 `error`**。
 *
 * 另有一条反向约束：**收起气泡不得停任务**（`setPanelOpen(false)`）—— 用户点了提交 / 推送后
 * 随手点空白处是常态，那次操作必须跑完；停了就等于「点了但什么也没发生」。
 *
 * 只 mock 到 IPC 边界，`run()` / `syncAction()` 的分支判断是真在跑。
 */
import { beforeEach, expect, it, vi } from 'vitest'
import { runInAction } from 'mobx'
import type { GitStatReport, GitStatusSnapshot } from '@/domain/git'

const ipc = {
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
  isGitEnvAvailable: vi.fn(() => true),
  log: vi.fn(),
  merge: vi.fn(),
  mergeAbort: vi.fn(),
  mergeState: vi.fn(),
  numstat: vi.fn(),
  pullRemote: vi.fn(),
  pushRemote: vi.fn(),
  remotes: vi.fn(),
  renameBranch: vi.fn(),
  repoInfo: vi.fn(),
  stage: vi.fn(),
  stashApply: vi.fn(),
  stashDrop: vi.fn(),
  stashPush: vi.fn(),
  stashRestore: vi.fn(),
  stashes: vi.fn(),
  status: vi.fn(),
  stopTask: vi.fn(),
  switchBranch: vi.fn(),
  testRemote: vi.fn(),
  undoLastCommit: vi.fn(),
  unstage: vi.fn(),
}

vi.mock('@/infrastructure/git', () => ipc)
vi.mock('@/ui/components/shared/Toast', () => ({ showToast: vi.fn() }))
vi.mock('@/ui/components/shared/MessageBox', () => ({
  MessageBox: { propt: vi.fn(() => Promise.resolve(true)) },
}))
vi.mock('@/utils/telemetry', () => ({ track: vi.fn() }))
vi.mock('@/ui/i18n', () => ({
  t: (s: string) => s,
  tpl: (s: string) => s,
}))

const { showToast } = await import('@/ui/components/shared/Toast')
const { gitStore } = await import('@/ui/store/gitStore')
const { cancelSync, fetchRemote, refreshStats, refreshStatus, setPanelOpen } =
  await import('@/services/git-service')

const SNAP: GitStatusSnapshot = {
  head: { oid: 'aa', branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0 },
  entries: [],
  truncated: false,
}
const STATS: GitStatReport = { staged: [], worktree: [] }

/** Rust 侧取消分支的固定文案（`git/cli.rs`），前端原样收到 */
const CANCELLED = new Error('git 操作已取消')

/** 手动控制什么时候 reject：用它模拟「旧那次还在跑，新的已经把它停掉」 */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.clearAllMocks()
  ipc.stopTask.mockReset()
  ipc.status.mockReset()
  ipc.numstat.mockReset()
  ipc.fetchRemote.mockReset()
  ipc.status.mockResolvedValue(SNAP)
  ipc.numstat.mockResolvedValue(STATS)
  runInAction(() => {
    gitStore.dir = '/tmp/repo'
    gitStore.probed = true
    gitStore.repo = {
      root: '/tmp/repo',
      git_dir: '/tmp/repo/.git',
      bare: false,
      version: '2.51.2',
      caps: { porcelain_v2: true, switch: true, restore: true },
    }
    gitStore.snapshot = SNAP
    gitStore.stats = null
    gitStore.remotes = []
    gitStore.busy = null
    gitStore.error = null
    gitStore.errorBox = null
    gitStore.open = false
  })
})

it('状态刷新被下一次取代：旧那次的「已取消」不进面板错误', async () => {
  const first = deferred<typeof SNAP>()
  ipc.status.mockReturnValueOnce(first.promise)

  const stale = refreshStatus()
  const fresh = refreshStatus() // 起点：先 stopTask(旧 id)，再发新请求
  await fresh
  first.reject(CANCELLED)
  await stale

  expect(ipc.stopTask).toHaveBeenCalled()
  expect(gitStore.error).toBeNull()
  // 新那次的结果照常落地（对账不能顺手把有效结果也丢了）
  expect(gitStore.snapshot).toEqual(SNAP)
})

it('行数统计被取代：同样是静默的', async () => {
  runInAction(() => {
    gitStore.open = true
  })
  const first = deferred<typeof STATS>()
  ipc.numstat.mockReturnValueOnce(first.promise)

  const stale = refreshStats()
  const fresh = refreshStats()
  await fresh
  first.reject(CANCELLED)
  await stale

  expect(gitStore.error).toBeNull()
  expect(gitStore.stats).toEqual(STATS)
})

it('同步被用户取消（浮层的「取消」）：不写 error、不弹错误窗、不 toast 成功', async () => {
  const pending = deferred<never>()
  ipc.fetchRemote.mockReturnValueOnce(pending.promise)

  const running = fetchRemote('origin')
  cancelSync()
  pending.reject(CANCELLED)

  expect(await running).toBe(false)
  expect(ipc.stopTask).toHaveBeenCalled()
  expect(gitStore.error).toBeNull()
  expect(gitStore.errorBox).toBeNull()
  expect(showToast).not.toHaveBeenCalled()
})

it('收起气泡不中断进行中的操作（用户点了就一定跑完）', async () => {
  const pending = deferred<import('@/domain/git').GitSyncResult>()
  ipc.fetchRemote.mockReturnValueOnce(pending.promise)

  const running = fetchRemote('origin')
  setPanelOpen(false) // 用户随手点空白处把气泡收了
  pending.resolve({ remote: 'origin', url: 'git@x:y', branch: 'main', output: '' })

  expect(await running).toBe(true)
  expect(ipc.stopTask).not.toHaveBeenCalled()
  expect(showToast).toHaveBeenCalled()
  expect(gitStore.error).toBeNull()
})

it('状态刷新的真失败仍然落面板（对账不许把错误一起吞掉）', async () => {
  ipc.status.mockRejectedValue(new Error('fatal: not a git repository'))

  await refreshStatus()

  expect(gitStore.error).toBe('fatal: not a git repository')
})

it('同步的真失败仍然落面板（取消与失败是两条路）', async () => {
  ipc.fetchRemote.mockRejectedValue(new Error('fatal: could not read from remote'))

  expect(await fetchRemote('origin')).toBe(false)

  expect(gitStore.error).toBe('fatal: could not read from remote')
})
