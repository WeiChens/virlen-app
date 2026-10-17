/**
 * GitSyncMenu — 远程浮层的界面行为。
 *
 * 守的是「凭据策略 = SSH」落到界面上的四件事，外加设计评审后定下的两条交互契约：
 * 1. 远程地址**必须看得见**（含类型徽标）；没有远程时给可复制的下一步，而不是一排死按钮；
 * 2. 动作按钮把**选中的那个远程**显式传下去（不靠 Rust 去猜，否则会出现「界面说 origin、实际跑了别人」）；
 * 3. 游离 HEAD 上拉取 / 推送禁用（按分支名操作的前提不成立），获取仍可用；
 * 4. 「测试连接」是 SSH 出问题时唯一的就地诊断入口 —— 成功 / 失败都要在原地给结果；
 * 5. **成功即关、失败留下**：成功由面板的「操作输出」块承接，失败要能就着浮层读并重试；
 * 6. 进行中要看得见且能取消，键盘焦点要能进出浮层。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { runInAction } from 'mobx'

import GitSyncMenu from '@/ui/pages/chat/components/git/GitSyncMenu'
import { gitStore } from '@/ui/store/gitStore'
import {
  cancelSync,
  fetchRemote,
  pullRemote,
  pushRemote,
  testRemote,
} from '@/services/git-service'
import type { GitRemoteInfo, GitStatusSnapshot } from '@/domain/git'

vi.mock('@/services/git-service', () => ({
  fetchRemote: vi.fn(),
  pullRemote: vi.fn(),
  pushRemote: vi.fn(),
  testRemote: vi.fn(),
  cancelSync: vi.fn(),
}))

;(globalThis as never as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

const ssh: GitRemoteInfo = {
  name: 'origin',
  url: 'git@github.com:a/b.git',
  push_url: 'git@github.com:a/b.git',
  kind: 'ssh',
}
const backup: GitRemoteInfo = {
  name: 'backup',
  url: 'https://host/b.git',
  push_url: 'https://host/b.git',
  kind: 'https',
}

function snap(
  branch: string | null,
  ahead = 0,
  behind = 0,
): GitStatusSnapshot {
  return {
    head: { oid: 'abc', branch, upstream: 'origin/main', ahead, behind },
    entries: [],
    truncated: false,
  }
}

let root: ReturnType<typeof createRoot> | null = null
let closed = 0

function mount() {
  closed = 0
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() =>
    root!.render(<GitSyncMenu readonly={false} onClose={() => (closed += 1)} />),
  )
}

function setStore(
  remotes: GitRemoteInfo[],
  branch: string | null = 'main',
  opts: { ahead?: number; behind?: number; busy?: string | null } = {},
) {
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
    gitStore.remotes = remotes
    gitStore.snapshot = snap(branch, opts.ahead ?? 0, opts.behind ?? 0)
    gitStore.busy = opts.busy ?? null
    gitStore.error = null
  })
}

function buttons(): HTMLButtonElement[] {
  return [...document.querySelectorAll('.git-sync-btn')] as HTMLButtonElement[]
}

beforeEach(() => {
  vi.mocked(fetchRemote).mockResolvedValue(true)
  vi.mocked(pullRemote).mockResolvedValue(true)
  vi.mocked(pushRemote).mockResolvedValue(true)
  vi.mocked(testRemote).mockResolvedValue(undefined)
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

it('没有远程时给出可复制的下一步，不给一排按不动的按钮', () => {
  setStore([])
  mount()

  expect(document.querySelector('.git-sync-empty')?.textContent).toContain(
    '这个仓库还没有配置远程仓库',
  )
  // 空态要有出路：终端命令原样摆出来（应用里不做 remote add）
  expect(document.querySelector('.git-sync-empty code')?.textContent).toBe(
    'git remote add origin git@github.com:owner/repo.git',
  )
  expect(buttons().length).toBe(0)
  expect(document.querySelector('.git-sync-test')).toBeNull()
})

it('远程地址与类型都看得见，三个动作把选中的远程显式传下去', async () => {
  setStore([ssh])
  mount()

  expect(document.querySelector('.git-sync-remote')?.textContent).toBe('origin')
  expect(document.querySelector('.git-sync-kind')?.textContent).toBe('SSH')
  expect(document.querySelector('.git-sync-url')?.textContent).toBe(
    'git@github.com:a/b.git',
  )

  await act(async () => {
    buttons()[0].click()
  })
  expect(fetchRemote).toHaveBeenCalledWith('origin')

  await act(async () => {
    buttons()[1].click()
  })
  expect(pullRemote).toHaveBeenCalledWith('origin')

  await act(async () => {
    buttons()[2].click()
  })
  expect(pushRemote).toHaveBeenCalledWith('origin')
})

/** 成功即关：结果由面板的「操作输出」块与 toast 承接，浮层压着它们反而看不见 */
it('动作成功 → 关掉浮层（不在这里重复一遍结果）', async () => {
  setStore([ssh])
  mount()
  await act(async () => {
    buttons()[2].click()
  })
  expect(pushRemote).toHaveBeenCalled()
  expect(closed).toBe(1)
})

/** 失败留下：错误原文要能就着浮层读、就地再试 */
it('动作失败 → 浮层不关，错误原文留在原地', async () => {
  vi.mocked(pushRemote).mockImplementationOnce(async () => {
    runInAction(() => {
      gitStore.error = 'git push 失败（退出码 128）\n! [rejected] main -> main (non-fast-forward)'
    })
    return false
  })
  setStore([ssh])
  mount()

  await act(async () => {
    buttons()[2].click()
  })
  expect(closed).toBe(0)
  expect(document.querySelector('.git-sync-result.error')?.textContent).toContain(
    'non-fast-forward',
  )
})

it('多个远程时让用户选，动作跟着选中的那个走（推错仓库不可逆）', async () => {
  setStore([ssh, backup])
  mount()

  const chips = [...document.querySelectorAll('.git-sync-name')] as HTMLElement[]
  expect(chips.map((c) => c.textContent)).toEqual(['origin', 'backup'])
  expect(chips[0].classList.contains('current')).toBe(true)

  await act(async () => {
    chips[1].click()
  })
  expect(document.querySelector('.git-sync-kind')?.textContent).toBe('HTTPS')
  await act(async () => {
    buttons()[2].click()
  })
  expect(pushRemote).toHaveBeenCalledWith('backup')
})

it('游离 HEAD：拉取 / 推送禁用并说明原因，获取仍可用', () => {
  setStore([ssh], null)
  mount()

  expect(buttons().map((b) => b.disabled)).toEqual([false, true, true])
  expect(document.querySelector('.git-sync-hint')?.textContent).toContain('游离 HEAD')
})

/** 点之前先知道会拉到 / 推走什么 */
it('有落差时先给一句「会发生什么」', () => {
  setStore([ssh], 'main', { behind: 2 })
  mount()
  expect(document.querySelector('.git-sync-track')?.textContent).toContain(
    '落后 2 个提交',
  )

  act(() => root!.unmount())
  root = null
  document.body.innerHTML = ''

  setStore([ssh], 'main', { ahead: 3 })
  mount()
  expect(document.querySelector('.git-sync-track')?.textContent).toContain(
    '有 3 个提交未推送',
  )
})

it('进行中：状态可见且能取消（网络操作可能跑很久）', async () => {
  setStore([ssh], 'main', { busy: 'push' })
  mount()

  expect(document.querySelector('.git-sync-busy')?.textContent).toContain('正在推送…')
  expect(buttons().every((b) => b.disabled)).toBe(true)

  await act(async () => {
    ;(document.querySelector('.git-sync-cancel') as HTMLElement).click()
  })
  expect(cancelSync).toHaveBeenCalled()
})

it('测试连接成功 → 就地说「连接正常」', async () => {
  setStore([ssh])
  mount()

  await act(async () => {
    ;(document.querySelector('.git-sync-test') as HTMLElement).click()
  })
  expect(testRemote).toHaveBeenCalledWith('origin')
  expect(document.querySelector('.git-sync-result.ok')?.textContent).toBe('连接正常')
})

it('测试连接失败 → 把 git 的原文留在原地（SSH 的诊断就在这一行）', async () => {
  vi.mocked(testRemote).mockRejectedValueOnce(
    new Error('git ls-remote 失败（退出码 128）\ngit@github.com: Permission denied (publickey).'),
  )
  setStore([ssh])
  mount()

  await act(async () => {
    ;(document.querySelector('.git-sync-test') as HTMLElement).click()
  })
  const err = document.querySelector('.git-sync-result.error')
  expect(err?.textContent).toContain('Permission denied (publickey)')
})

/** 键盘用户要能「走进来」：打开即落焦点到第一个动作，关闭还给触发它的按钮 */
it('焦点：打开落在「获取」上，关闭后还给原来的元素', () => {
  const trigger = document.createElement('button')
  document.body.appendChild(trigger)
  trigger.focus()
  expect(document.activeElement).toBe(trigger)

  setStore([ssh])
  mount()
  expect(document.activeElement).toBe(buttons()[0])

  act(() => root!.unmount())
  root = null
  expect(document.activeElement).toBe(trigger)
})

it('Esc 关掉浮层', async () => {
  setStore([ssh])
  mount()

  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  })
  expect(closed).toBe(1)
})
