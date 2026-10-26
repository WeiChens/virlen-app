// @vitest-environment jsdom
/**
 * GitGraphModal — 提交图要**跟着 HEAD 走**。
 *
 * 守的是一条实测反馈：在提交图上右键「切换到分支 x」之后，整张图看起来没变（HEAD 标记还停在
 * 旧分支）。两层原因，缺一都不行：
 * 1. 弹窗不是 observer → `gitStore.snapshot` 变了不重渲染（canvas 的 HEAD 圈、菜单里的「当前分支」）；
 * 2. 行上的引用标签来自**取数那一刻**的 `%D`（`HEAD -> x`）—— 不重取，标签永远停在旧分支上。
 *    最典型的是「切到同一个提交上的另一个分支」：oid 都没变，只重渲染看不出任何区别。
 *
 * canvas 换成只暴露 `headOid` 的替身（jsdom 没有 2d 上下文）；真实绘制由 `git-graph.test.ts`
 * 的布局纯函数与手工验收覆盖。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { runInAction } from 'mobx'

import GitGraphModal from '@/ui/pages/chat/components/git/GitGraphModal'
import { loadCommits } from '@/services/git-service'
import { gitStore } from '@/ui/store/gitStore'
import type { GitCommitLogEntry } from '@/domain/git'

vi.mock('@/services/git-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/git-service')>()
  return { ...actual, loadCommits: vi.fn() }
})

// canvas 在 jsdom 里拿不到 2d 上下文：换成把 `headOid` 摆到 DOM 上的替身
vi.mock('@/ui/pages/chat/components/git/GraphCanvas', () => ({
  default: ({ headOid }: { headOid: string | null }) => (
    <div data-testid="graph-canvas" data-head={headOid ?? ''} />
  ),
}))

// 行右键菜单的复制项（`commit-menu.ts`）：不 mock 就变「真去读 WebView 剪贴板」
vi.mock('@/utils/clipboard', () => ({ copyText: vi.fn(() => Promise.resolve(true)) }))
vi.mock('@/ui/components/shared/Toast', () => ({
  showToast: vi.fn(),
  useToast: (): unknown => ({ Toast: (): null => null, showToast: vi.fn() }),
}))

// 引用链可能经 store 桶文件拉到 markdown / code-block → monaco，而 monaco 在 jsdom 里导入即崩
vi.mock('@/monaco/setupMonaco', () => ({
  monaco: { editor: { tokenize: (): unknown[] => [] } },
  virlenDarkTheme: {},
}))

;(globalThis as never as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

const OID = 'a'.repeat(40)

/** 一条提交（`refs` 就是 Rust 侧 `%D` 的原样，`HEAD -> …` 也照抄） */
function commit(refs: string[]): GitCommitLogEntry {
  return {
    oid: OID,
    short_oid: 'aaaaaaa',
    author_name: '张三',
    author_email: 'zhangsan@example.com',
    author_time: '2026-10-16T10:29:46+08:00',
    parents: [],
    refs,
    subject: 'feat: 一条提交',
  }
}

/** 当前 HEAD：分支名与 oid 分开给 —— 切到同一个提交上的另一个分支是最容易漏的那种 */
function setHead(branch: string | null, oid: string): void {
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
    gitStore.snapshot = {
      head: { oid, branch, upstream: null, ahead: 0, behind: 0 },
      entries: [],
      truncated: false,
    }
  })
}

let root: ReturnType<typeof createRoot> | null = null

async function mount(): Promise<void> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<GitGraphModal disabled={false} onClose={() => {}} />)
  })
}

/** 行上的引用徽标（每行只摆一个，HEAD 优先，见 `pickRowRefs`） */
const badge = (): string | null =>
  document.querySelector('.git-log-ref')?.textContent ?? null
const canvasHead = (): string | null =>
  document
    .querySelector('[data-testid="graph-canvas"]')
    ?.getAttribute('data-head') ?? null

beforeEach(() => {
  document.body.innerHTML = ''
  vi.mocked(loadCommits).mockReset()
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  runInAction(() => {
    gitStore.dir = null
    gitStore.probed = false
    gitStore.repo = null
    gitStore.snapshot = null
  })
})

it('切到同一个提交上的另一个分支：列表整份重取，HEAD 标签跟着换（不能「切了像没切」）', async () => {
  setHead('main', OID)
  vi.mocked(loadCommits)
    .mockResolvedValueOnce([commit(['HEAD -> refs/heads/main', 'refs/heads/main'])])
    .mockResolvedValueOnce([
      commit(['HEAD -> refs/heads/feature', 'refs/heads/feature']),
    ])
  await mount()

  expect(badge()).toBe('main')

  // oid 故意不变：只有分支名换了 —— 只重渲染的话这里看不出任何区别
  await act(async () => {
    setHead('feature', OID)
  })

  // 重取了才拿得到新的 `%D`（`HEAD -> feature`）
  expect(vi.mocked(loadCommits).mock.calls).toEqual([
    [0, 'all'],
    [0, 'all'],
  ])
  expect(badge()).toBe('feature')
})

it('HEAD 换了提交：canvas 的 HEAD 标记跟着动（弹窗得订阅 snapshot）', async () => {
  const next = 'b'.repeat(40)
  setHead('main', OID)
  vi.mocked(loadCommits).mockResolvedValue([commit(['refs/heads/main'])])
  await mount()
  expect(canvasHead()).toBe(OID)

  await act(async () => {
    setHead('main', next)
  })
  expect(canvasHead()).toBe(next)
})
