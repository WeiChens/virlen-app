/**
 * Git 失败的**落点**契约：报错进持久弹窗（`gitStore.errorBox`），而不是几秒就消失的 toast。
 *
 * 两条分支必须分开：
 * - **面板里的动作**（暂存 / 提交 / 分支…）没有「原地」可展示错误 → 填 `errorBox`，由弹窗呈现；
 * - **同步浮层里的动作**（fetch / pull / push）自己会把 stderr 留在浮层里 → 只填 `error`，
 *   不再弹窗（否则两层信息重复，弹窗还会盖住那个浮层）。
 *
 * 这里只 mock 到 IPC 边界：`run()` / `syncAction()` 的分支判断是真的在跑。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runInAction } from 'mobx'

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
  pullRemote: vi.fn(),
  pushRemote: vi.fn(),
  remotes: vi.fn(),
  renameBranch: vi.fn(),
  repoInfo: vi.fn(),
  stage: vi.fn(),
  status: vi.fn(),
  stopTask: vi.fn(),
  switchBranch: vi.fn(),
  testRemote: vi.fn(),
  undoLastCommit: vi.fn(),
  unstage: vi.fn(),
}

vi.mock('@/infrastructure/git', () => ipc)
vi.mock('@/ui/components/shared/Toast', () => ({ showToast: vi.fn() }))
vi.mock('@/ui/components/shared/MessageBox', () => ({ MessageBox: { propt: vi.fn() } }))
vi.mock('@/utils/telemetry', () => ({ track: vi.fn() }))
vi.mock('@/ui/i18n', () => ({
  t: (s: string) => s,
  tpl: (s: string) => s,
}))

const { showToast } = await import('@/ui/components/shared/Toast')
const { gitStore } = await import('@/ui/store/gitStore')
const { stage, fetchRemote } = await import('@/services/git-service')

/** Rust 抛回来的错误已拼好 stderr（前缀是命令名，前端原样展示） */
const GIT_FAILURE = new Error(
  'fatal: pathspec \'a.txt\' did not match any files\nhint: 检查路径是否在工作区内',
)

beforeEach(() => {
  vi.clearAllMocks()
  runInAction(() => {
    gitStore.dir = '/tmp/repo'
    gitStore.repo = {
      root: '/tmp/repo',
      git_dir: '/tmp/repo/.git',
      bare: false,
      version: '2.51.2',
      caps: { porcelain_v2: true, switch: true, restore: true },
    }
    gitStore.snapshot = {
      head: {
        oid: 'abc',
        branch: 'main',
        upstream: 'origin/main',
        ahead: 1,
        behind: 0,
      },
      entries: [],
      truncated: false,
    }
    gitStore.remotes = [
      { name: 'origin', url: 'git@github.com:a/b.git', push_url: null, kind: 'ssh' },
    ]
    gitStore.busy = null
    gitStore.error = null
    gitStore.errorBox = null
  })
  ipc.status.mockResolvedValue({
    head: null,
    entries: [],
    truncated: false,
  })
})

describe('git 失败信息的落点', () => {
  it('写操作失败：填 errorBox（持久弹窗），不弹 toast', async () => {
    ipc.stage.mockRejectedValue(GIT_FAILURE)
    const ok = await stage(['a.txt'])

    expect(ok).toBe(false)
    expect(showToast).not.toHaveBeenCalled()
    expect(gitStore.errorBox).toEqual({ op: 'stage', text: GIT_FAILURE.message })
    // 面板顶部的「最近一次错误」照旧要填：关掉弹窗之后它还在
    expect(gitStore.error).toBe(GIT_FAILURE.message)
  })

  it('同步浮层的动作失败：不弹窗，错误留给浮层就地显示', async () => {
    ipc.fetchRemote.mockRejectedValue(GIT_FAILURE)
    const ok = await fetchRemote('origin')

    expect(ok).toBe(false)
    expect(showToast).not.toHaveBeenCalled()
    expect(gitStore.errorBox).toBeNull()
    expect(gitStore.error).toBe(GIT_FAILURE.message)
  })

  it('成功后清掉面板错误（弹窗内容不会被悄悄改写，只能由用户关）', async () => {
    runInAction(() => {
      gitStore.errorBox = { op: 'stage', text: '旧错误' }
    })
    ipc.stage.mockResolvedValue(gitStore.snapshot)
    expect(await stage(['a.txt'])).toBe(true)
    expect(gitStore.error).toBeNull()
    expect(gitStore.errorBox).toEqual({ op: 'stage', text: '旧错误' })
  })
})
