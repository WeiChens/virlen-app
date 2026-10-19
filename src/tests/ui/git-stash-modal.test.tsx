/**
 * GitStashModal — 贮藏浮层的界面口径（都是「错了会静默丢东西 / 让人以为成功了」的那一类）。
 *
 * 1. **能不能贮藏由快照说了算**：无改动 / 有冲突 / 没有提交时按钮禁用并写明原因 ——
 *    `git stash push` 在「没东西可贮藏」时退出码是 0，界面不能靠它判成功；
 * 2. **未跟踪默认不进**：勾选后才计入「将贮藏 N 个文件」，并提示其余未跟踪文件会留在工作区；
 * 3. **动作只传 oid**：应用 / 应用并删除 / 删除都按 oid 调（`stash@{n}` 的选择在 Rust 锁内完成）；
 * 4. **删完给「撤销」条**：`stash store` 能把同一个 oid 放回栈顶（本次会话内）；
 * 5. **Esc 只关弹窗**：宿主面板也挂着一颗 document 级 Esc，这里必须在捕获阶段 stopPropagation；
 * 6. **左侧文件列表决定贮藏范围**：默认全选，勾掉的路径不传给 git（`stash push -- <路径>`）；
 *    「一个都不选」必须禁用按钮 —— 空数组在 IPC 层是「全部」。
 *
 * 数据与写操作全部 mock：git 语义由 Rust 用例守（`cargo test -p virlen-core git::tests::stash`）。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { runInAction } from 'mobx'

import GitStashModal from '@/ui/pages/chat/components/git/GitStashModal'
import { gitStore } from '@/ui/store/gitStore'
import {
  applyStash,
  createStash,
  dropStash,
  refreshStashes,
  undoDropStash,
} from '@/services/git-service'
import type { GitChangeEntry, GitStashEntry } from '@/domain/git'

vi.mock('@/services/git-service', () => ({
  refreshStashes: vi.fn(() => Promise.resolve()),
  createStash: vi.fn(() => Promise.resolve(true)),
  applyStash: vi.fn(() => Promise.resolve(true)),
  dropStash: vi.fn(() => Promise.resolve(true)),
  undoDropStash: vi.fn(() => Promise.resolve()),
}))

;(globalThis as never as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

function entry(over: Partial<GitChangeEntry>): GitChangeEntry {
  return { path: 'a.txt', orig_path: null, x: '.', y: '.', kind: 'ordinary', ...over }
}

const unstagedEntry = (path: string): GitChangeEntry => entry({ path, y: 'M' })
const stagedEntry = (path: string): GitChangeEntry => entry({ path, x: 'M' })
const untrackedEntry = (path: string): GitChangeEntry =>
  entry({ path, x: '?', y: '?', kind: 'untracked' })

function stash(oid: string, message: string): GitStashEntry {
  return { oid, message, time: '2026-10-18T09:11:30+08:00' }
}

const STASH_A = stash('a'.repeat(40), 'On main: 修登录')
const STASH_B = stash('b'.repeat(40), 'WIP on feat/x: abc1234 初始提交')

let root: ReturnType<typeof createRoot> | null = null
let closed = 0

/** 重置 store：`entries` = 工作区快照，`stashes` = 列表，`oid = null` = 还没有提交 */
function setStore(opts: {
  entries?: GitChangeEntry[]
  stashes?: GitStashEntry[]
  oid?: string | null
  lastDropped?: { oid: string; message: string } | null
}) {
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
        oid: opts.oid === undefined ? 'c'.repeat(40) : opts.oid,
        branch: 'main',
        upstream: null,
        ahead: 0,
        behind: 0,
      },
      entries: opts.entries ?? [],
      truncated: false,
    }
    gitStore.stashes = opts.stashes ?? []
    gitStore.lastDropped = opts.lastDropped ?? null
    gitStore.error = null
    gitStore.errorBox = null
    gitStore.busy = null
  })
}

async function mount(readonly = false) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <GitStashModal
        readonly={readonly}
        onClose={() => {
          closed += 1
        }}
      />,
    )
  })
}

const stashBtn = () =>
  document.querySelector<HTMLButtonElement>('.git-stash-create .git-primary-btn')
const hint = () => document.querySelector('.git-stash-hint')?.textContent ?? ''
const rows = () => [...document.querySelectorAll<HTMLElement>('.git-stash-row')]
const rowButton = (row: HTMLElement, label: string) =>
  [...row.querySelectorAll<HTMLButtonElement>('.git-stash-act')].find(
    (btn) => btn.textContent === label,
  )
const checkbox = (label: string) =>
  [...document.querySelectorAll<HTMLLabelElement>('.git-stash-opt')].find((el) =>
    el.textContent?.includes(label),
  )?.querySelector('input') as HTMLInputElement

beforeEach(() => {
  document.body.innerHTML = ''
  closed = 0
  vi.mocked(refreshStashes).mockClear()
  vi.mocked(createStash).mockClear()
  vi.mocked(applyStash).mockClear()
  vi.mocked(dropStash).mockClear()
  vi.mocked(undoDropStash).mockClear()
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

it('打开就取一次列表（不在面板里轮询）', async () => {
  setStore({})
  await mount()
  expect(refreshStashes).toHaveBeenCalledTimes(1)
})

it('有改动才能贮藏：写明将贮藏几个文件，并提示未跟踪会留下', async () => {
  setStore({ entries: [unstagedEntry('a.txt'), untrackedEntry('u.txt')] })
  await mount()

  expect(stashBtn()!.disabled).toBe(false)
  expect(hint()).toContain('将贮藏 1 个文件的更改')
  expect(hint()).toContain('另有 1 个未跟踪文件会留在工作区')
})

it('勾选「包含未跟踪文件」后把它算进数量', async () => {
  setStore({ entries: [unstagedEntry('a.txt'), untrackedEntry('u.txt')] })
  await mount()

  const box = checkbox('包含未跟踪文件')
  act(() => box.click())

  expect(hint()).toContain('将贮藏 2 个文件的更改')
  expect(hint()).not.toContain('会留在工作区')
})

it('没有改动：按钮禁用，说明「没有可贮藏的改动」', async () => {
  setStore({ entries: [] })
  await mount()
  expect(stashBtn()!.disabled).toBe(true)
  expect(hint()).toContain('没有可贮藏的改动')
})

it('只有未跟踪文件且没勾选：禁用并给出下一步', async () => {
  setStore({ entries: [untrackedEntry('u.txt')] })
  await mount()
  expect(stashBtn()!.disabled).toBe(true)
  expect(hint()).toContain('勾选「包含未跟踪文件」后才能贮藏')
})

it('有未解决的冲突：禁用（git 在这种状态下 push 会失败）', async () => {
  setStore({ entries: [entry({ path: 'c.txt', x: 'U', y: 'U', kind: 'unmerged' })] })
  await mount()
  expect(stashBtn()!.disabled).toBe(true)
  expect(hint()).toContain('有未解决的冲突')
})

it('还没有提交：禁用（git 会报 You do not have the initial commit yet）', async () => {
  setStore({ entries: [unstagedEntry('a.txt')], oid: null })
  await mount()
  expect(stashBtn()!.disabled).toBe(true)
  expect(hint()).toContain('仓库还没有提交')
})

it('贮藏：消息与两个开关原样交给 service，成功后清空输入', async () => {
  setStore({ entries: [stagedEntry('a.txt'), untrackedEntry('u.txt')] })
  await mount()

  const input = document.querySelector('.git-stash-msg') as HTMLInputElement
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set
    setter?.call(input, '修登录')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    checkbox('包含未跟踪文件').click()
    checkbox('保留已暂存的内容').click()
  })

  await act(async () => stashBtn()!.click())

  expect(createStash).toHaveBeenCalledWith('修登录', true, true, [])
  expect((document.querySelector('.git-stash-msg') as HTMLInputElement).value).toBe('')
})

it('左侧列出所有改动文件且默认全选；勾掉一个就只贮藏剩下的', async () => {
  setStore({
    entries: [stagedEntry('a.txt'), unstagedEntry('b.txt'), unstagedEntry('c.txt')],
  })
  await mount()

  const boxes = () => [
    ...document.querySelectorAll<HTMLInputElement>('.git-stash-file input'),
  ]
  expect(boxes().map((box) => box.checked)).toEqual([true, true, true])
  expect(hint()).toContain('将贮藏 3 个文件的更改')

  // 勾掉 b.txt：传给 git 的只有 a.txt / c.txt，提示也跟着变
  act(() => boxes()[1].click())
  expect(hint()).toContain('将贮藏 2 个文件的更改')
  expect(hint()).toContain('未勾选的 1 个文件会留在工作区')

  await act(async () => stashBtn()!.click())
  expect(createStash).toHaveBeenCalledWith('', false, false, ['a.txt', 'c.txt'])
})

it('全选又全不选：一个都不选时禁用按钮（空数组在 IPC 层是「全部」）', async () => {
  setStore({ entries: [unstagedEntry('a.txt'), unstagedEntry('b.txt')] })
  await mount()

  const selectAll = document.querySelector<HTMLInputElement>(
    '.git-stash-files-head input',
  )!
  expect(selectAll.checked).toBe(true)

  act(() => selectAll.click())
  expect(selectAll.checked).toBe(false)
  expect(stashBtn()!.disabled).toBe(true)
  expect(hint()).toContain('左侧没有勾选任何文件')

  act(() => selectAll.click())
  expect(stashBtn()!.disabled).toBe(false)
  expect(hint()).toContain('将贮藏 2 个文件的更改')
})

it('部分勾选时「全选」显示半选态', async () => {
  setStore({ entries: [unstagedEntry('a.txt'), unstagedEntry('b.txt')] })
  await mount()

  const selectAll = document.querySelector<HTMLInputElement>(
    '.git-stash-files-head input',
  )!
  act(() =>
    document
      .querySelectorAll<HTMLInputElement>('.git-stash-file input')[0]
      .click(),
  )
  expect(selectAll.indeterminate).toBe(true)
})

it('未跟踪文件行默认不可勾（要「包含未跟踪文件」先打开）', async () => {
  setStore({ entries: [unstagedEntry('a.txt'), untrackedEntry('u.txt')] })
  await mount()

  const boxes = [
    ...document.querySelectorAll<HTMLInputElement>('.git-stash-file input'),
  ]
  expect(boxes.map((box) => box.disabled)).toEqual([false, true])

  act(() => checkbox('包含未跟踪文件').click())
  const after = [
    ...document.querySelectorAll<HTMLInputElement>('.git-stash-file input'),
  ]
  expect(after.map((box) => box.disabled)).toEqual([false, false])
  expect(after.every((box) => box.checked)).toBe(true)
})

it('列表：自动生成的消息拆出标题与分支，动作按 oid 调', async () => {
  setStore({ stashes: [STASH_A, STASH_B] })
  await mount()

  const [first, second] = rows()
  expect(first.textContent).toContain('修登录')
  expect(second.textContent).toContain('初始提交')
  expect(second.querySelector('.git-stash-branch')?.textContent).toBe('feat/x')
  expect(second.querySelector('.git-stash-auto')).not.toBeNull()

  await act(async () => rowButton(second, '应用')!.click())
  expect(applyStash).toHaveBeenCalledWith(STASH_B.oid, false)

  await act(async () => rowButton(second, '应用并删除')!.click())
  expect(applyStash).toHaveBeenCalledWith(STASH_B.oid, true)

  await act(async () => rowButton(first, '删除')!.click())
  expect(dropStash).toHaveBeenCalledWith(STASH_A.oid)
})

it('删完出现撤销条，点撤销把「刚删的那条」放回去', async () => {
  setStore({
    stashes: [STASH_A],
    lastDropped: { oid: STASH_B.oid, message: STASH_B.message },
  })
  await mount()

  const undo = document.querySelector('.git-stash-undo')
  expect(undo?.textContent).toContain('已删除「初始提交」')

  const btn = [...undo!.querySelectorAll('button')].find(
    (el) => el.textContent === '撤销',
  )!
  await act(async () => btn.click())
  expect(undoDropStash).toHaveBeenCalled()
})

it('只读沙盒：新建与行内动作都禁用（Rust 侧同样会拒）', async () => {
  setStore({ entries: [unstagedEntry('a.txt')], stashes: [STASH_A] })
  await mount(true)

  expect(stashBtn()!.disabled).toBe(true)
  for (const btn of rows()[0].querySelectorAll('button')) {
    expect(btn.disabled).toBe(true)
  }
})

it('Esc 关闭弹窗且在捕获阶段拦住（不允许宿主面板跟着关）', async () => {
  setStore({})
  await mount()

  const bubbled = vi.fn()
  document.addEventListener('keydown', bubbled)
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  })
  document.removeEventListener('keydown', bubbled)

  expect(closed).toBe(1)
  expect(bubbled).not.toHaveBeenCalled()
})

/** 删除要过全局确认框：那时 Esc 归确认框，不能顺手把贮藏浮层关掉（否则「Esc 关掉两层」） */
it('有全局确认框时 Esc 归它，不关贮藏浮层', async () => {
  setStore({})
  await mount()

  // 模拟 MessageBox 打开：全局 Modal 的遮罩
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  document.body.appendChild(overlay)

  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  })

  expect(closed).toBe(0)
})
