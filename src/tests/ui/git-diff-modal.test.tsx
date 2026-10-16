/**
 * GitDiffModal — 差异弹窗的五条界面口径（都是 P1.3 / P1.4 实测反馈里点出来的）。
 *
 * 1. **左侧清单**：列出全部更改文件、当前文件高亮，点一下即切换（↑↓ 也能切）；同一个文件可以同时
 *    出现在两段（git 的真实语义），所以「当前行」按 **侧 + 路径** 认，不只看路径；
 * 2. **路径只出现一次**：路径已在弹窗头，正文的文件头整块不画 —— 连带内置的「全屏」按钮一起
 *    消失（弹窗本身就是放大形态）；
 * 3. **弹窗里能暂存 / 取消暂存**：成功后视图翻到另一侧（暂存 → 看 index↔HEAD；取消暂存 → 看工作区↔index），
 *    失败则留在原地；
 * 4. **弹窗内的 mousedown 不冒泡到 document**：入口的「点浮层外关闭」按 DOM 包含关系判定，而弹窗
 *    portal 到 body —— 不拦住就是「点一下弹窗，连面板一起关掉」。
 * 5. **空的那一侧整栏不画**（实测反馈：被删除的文件不必再显示「新文件」）：判定按**内容**
 *    （`domain/git::singleSideOf`），而不是列表上的状态字母；正文一律走 `MonacoDiffView`，
 *    单侧时交给它的就是那一份单栏形态（`singleSide`）—— 空侧那栏连列头一起不画。
 *
 * 正文一律走 Monaco（`MonacoDiffView`，§11.53 ㉖ / ㉙）：本用例把它换成本文件关心的最小替身
 * —— 只验「弹窗把两侧全文与单侧判定交下去了」与「没有再去跑一遍差异算法」，Monaco 那份契约由
 * `monaco-diff-view.test.tsx` 守（两栏 / 单栏 / 右键菜单），DOM 版正文由 `side-by-side-diff.test.tsx` 守。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import GitDiffModal from '@/ui/pages/chat/components/git/GitDiffModal'
import {
  changeSections,
  rowKey,
  type GitChangeSection,
} from '@/ui/pages/chat/components/git/sections'
import { groupChanges, gitDiffRows } from '@/domain/git'
import type { GitChangeEntry, GitStatusSnapshot } from '@/domain/git'
import { loadDiffSides, stage, unstage } from '@/services/git-service'

vi.mock('@/services/git-service', () => ({
  loadDiffSides: vi.fn(),
  stage: vi.fn(),
  unstage: vi.fn(),
}))

// 正文走 Monaco（MonacoDiffView）：它内部要真的起 Monaco（jsdom 里导入即崩），
// 这里只留「弹窗交了什么下去」这个接口（两栏 = 两侧全文，单栏 = `singleSide`）。
vi.mock('@/ui/pages/chat/components/message/MonacoDiffView', () => {
  function MonacoDiffView({
    oldText,
    newText,
    fileName,
    singleSide,
  }: {
    oldText: string
    newText: string
    fileName: string
    singleSide?: 'old' | 'new'
  }) {
    return (
      <div
        className="mono-diff-stub"
        data-old={oldText}
        data-new={newText}
        data-file={fileName}
        data-side={singleSide ?? ''}
      />
    )
  }
  return { MonacoDiffView, default: MonacoDiffView }
})

// 「正文里不再跑一遍差异算法」是本轮的口径（切文件要省掉的那一段），把 gitDiffRows 换成间谍；
// 正文换成 Monaco 后单侧也不再调它（DOM 版双栏已退出 git 弹窗）。
vi.mock('@/domain/git', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/domain/git')>()
  return { ...actual, gitDiffRows: vi.fn(actual.gitDiffRows) }
})

// 正文已被替身顶掉，本用例的引用链今天不拉 monaco；留着这条 mock 防引用链变化
//（monaco 在 jsdom 里导入即崩，缺 `CSS.escape`）。
vi.mock('@/monaco/setupMonaco', () => ({
  monaco: { editor: { tokenize: (): unknown[] => [] } },
  virlenDarkTheme: {},
}))

;(globalThis as never as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

function entry(over: Partial<GitChangeEntry>): GitChangeEntry {
  return {
    path: 'a.txt',
    orig_path: null,
    x: '.',
    y: '.',
    kind: 'ordinary',
    ...over,
  }
}

/** 一条已暂存（X 侧有改动）的变更 */
const stagedEntry = (path: string): GitChangeEntry => entry({ path, x: 'M' })
/** 一条工作区有改动（Y 侧有改动）的变更 */
const unstagedEntry = (path: string): GitChangeEntry => entry({ path, y: 'M' })
/** 一条未跟踪的变更（porcelain 的 `?` 记录：两侧都是 `?`） */
const untrackedEntry = (path: string): GitChangeEntry =>
  entry({ path, x: '?', y: '?', kind: 'untracked' })

const ENTRIES: GitChangeEntry[] = [
  stagedEntry('s.txt'),
  unstagedEntry('a.txt'),
  unstagedEntry('b.txt'),
  untrackedEntry('n.ts'),
]

function sections(): GitChangeSection[] {
  const snapshot: GitStatusSnapshot = {
    head: { oid: 'abc', branch: 'main', upstream: null, ahead: 0, behind: 0 },
    entries: ENTRIES,
    truncated: false,
  }
  return changeSections(groupChanges(snapshot), {
    stage: () => {},
    unstage: () => {},
  })
}

let root: ReturnType<typeof createRoot> | null = null
let closed = 0

async function mount(targetPath = 'a.txt', side: 'staged' | 'unstaged' = 'unstaged') {
  const target = {
    entry: ENTRIES.find((e) => e.path === targetPath)!,
    side,
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <GitDiffModal
        target={target}
        sections={sections()}
        disabled={false}
        onClose={() => {
          closed += 1
        }}
      />,
    )
  })
}

const pathLabel = () => document.querySelector('.git-diff-path')?.textContent
/** 弹窗头**没有**「基准」胶囊（口径 6）：在看哪一侧由那颗动作按钮说 —— `暂存更改` = 工作区侧、`取消暂存` = index 侧 */
const actionBtn = () =>
  document.querySelector('.git-diff-action') as HTMLButtonElement | null
const sideRow = (path: string) =>
  [...document.querySelectorAll<HTMLElement>('.git-diff-side-row')].find(
    (el) => el.title === path,
  )
/** 高亮那一行（当前在看哪个文件） */
const activeRow = () =>
  document.querySelector<HTMLElement>('.git-diff-side-row.active')

beforeEach(() => {
  document.body.innerHTML = ''
  closed = 0
  vi.mocked(loadDiffSides).mockReset()
  vi.mocked(stage).mockReset()
  vi.mocked(unstage).mockReset()
  vi.mocked(gitDiffRows).mockClear()
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

it('左侧清单：列出各段文件、当前文件高亮，点另一个即切换并重取那一侧的差异', async () => {
  await mount()

  // 段标题 + 文件（未跟踪并进「更改」段，不另起一段；冲突为空则不画）
  const titles = [...document.querySelectorAll('.git-diff-side-title')].map(
    (el) => el.textContent,
  )
  expect(titles).toEqual(['暂存的更改1', '更改3'])
  expect(document.querySelectorAll('.git-diff-side-row').length).toBe(4)

  // 当前行高亮（打开时定位到双击的那一行）
  expect(activeRow()?.title).toBe('a.txt')
  expect(pathLabel()).toBe('a.txt')
  expect(actionBtn()?.textContent).toBe('暂存更改')

  await act(async () => sideRow('s.txt')!.click())

  expect(pathLabel()).toBe('s.txt')
  expect(actionBtn()?.textContent).toBe('取消暂存')
  expect(loadDiffSides).toHaveBeenLastCalledWith('s.txt', 'index', null)
  expect(activeRow()?.title).toBe('s.txt')
})

it('两侧都有内容时：正文走 Monaco 两栏（没传 singleSide），交下去的是两侧全文，且不再跑差异算法', async () => {
  await mount()

  const stub = document.querySelector('.mono-diff-stub') as HTMLElement
  expect(stub).not.toBeNull()
  // beforeEach 里 mock 的两侧是 'a' / 'b'：原样交下去（Monaco 自己算差异）
  expect(stub.dataset.old).toBe('a')
  expect(stub.dataset.new).toBe('b')
  expect(stub.dataset.file).toBe('a.txt')
  // 两栏形态：不传 singleSide
  expect(stub.dataset.side).toBe('')
  // 路径只在弹窗头：正文既没有文件头、也没有内置的全屏按钮，更不是 DOM 版双栏
  expect(pathLabel()).toBe('a.txt')
  expect(document.querySelector('.diff-header')).toBeNull()
  expect(document.querySelector('.diff-fullscreen-btn')).toBeNull()
  expect(document.querySelector('.diff-side-by-side')).toBeNull()
  // 切文件要省掉的那一段：jsdiff 不再跑
  expect(gitDiffRows).not.toHaveBeenCalled()
})

it('弹窗里能暂存：成功后翻到已暂存侧（scope 跟着换）；失败则留在原地', async () => {
  await mount()
  expect(actionBtn()?.textContent).toBe('暂存更改')

  vi.mocked(stage).mockResolvedValue(true)
  await act(async () => actionBtn()!.click())

  expect(stage).toHaveBeenCalledWith(['a.txt'])
  expect(actionBtn()?.textContent).toBe('取消暂存')
  expect(loadDiffSides).toHaveBeenLastCalledWith('a.txt', 'index', null)

  // 取消暂存：翻回工作区侧
  vi.mocked(unstage).mockResolvedValue(true)
  await act(async () => actionBtn()!.click())
  expect(unstage).toHaveBeenCalledWith(['a.txt'])
  expect(actionBtn()?.textContent).toBe('暂存更改')

  // 失败（只读沙盒 / 有操作在跑）不翻面：界面上写的仍然是「你正在看的这一侧」
  vi.mocked(stage).mockResolvedValue(false)
  await act(async () => actionBtn()!.click())
  expect(actionBtn()?.textContent).toBe('暂存更改')
})

it('截断提示在弹窗头（原来那颗「基准」胶囊的位置），不进正文', async () => {
  vi.mocked(loadDiffSides).mockResolvedValue({
    old_text: 'a',
    new_text: 'b',
    old_label: 'INDEX',
    new_label: '工作区',
    binary: false,
    truncated: true,
  })
  await mount()

  // ⚠️ 必须在头部：正文那条 `.git-mono-diff` 是 `height: 100%`，压在它上面的兄弟块会把内容
  //    顶出容器（实测反馈的「超出滚动」），所以这条提示占头部腾出来的位置
  const note = document.querySelector('.git-diff-note')
  expect(note?.textContent).toBe('文件过大，仅显示前 524288 个字符')
  expect(note?.closest('.git-diff-head')).not.toBeNull()
  expect(document.querySelector('.git-diff-body .git-diff-message')).toBeNull()
})

it('只读沙盒下写入口禁用（Rust 侧同样会拒，这里是体验层的双保险）', async () => {
  await mount()
  // 重新挂一个 disabled 的（mount 里默认 false）
  act(() => root!.unmount())
  document.body.innerHTML = ''
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <GitDiffModal
        target={{ entry: ENTRIES[1], side: 'unstaged' }}
        sections={sections()}
        disabled
        onClose={() => {}}
      />,
    )
  })
  expect(actionBtn()!.disabled).toBe(true)
})

it('弹窗内的 mousedown 不冒泡到 document（否则宿主浮层会被一起关掉）', async () => {
  await mount()

  const outside = vi.fn()
  document.addEventListener('mousedown', outside)

  // 清单 / 正文里的 mousedown：宿主（源代码管理面板）的「点浮层外关闭」不该看见它
  act(() => {
    sideRow('b.txt')!.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true }),
    )
  })
  expect(outside).not.toHaveBeenCalled()

  // 遮罩上的 mousedown 是明确的关闭意图（弹窗自己处理，不靠冒泡）
  act(() => {
    document
      .querySelector('.git-diff-backdrop')!
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  })
  expect(closed).toBe(1)

  document.removeEventListener('mousedown', outside)
})

it('↑↓ 在弹窗里上下切文件（打开即接管焦点）', async () => {
  await mount()
  expect(document.activeElement?.className).toBe('git-diff-modal')

  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
  })
  expect(pathLabel()).toBe('b.txt')

  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }))
  })
  expect(pathLabel()).toBe('s.txt')
})

it('左侧清单的一行：图标在左、状态字母在最右（与面板同一套排布）', async () => {
  await mount()

  const row = sideRow('n.ts')!
  expect(
    [...row.children].map((el) => el.getAttribute('class')?.split(' ')[0]),
  ).toEqual([
    'git-diff-side-icon',
    'git-diff-side-name',
    'git-diff-side-dir',
    'git-row-letter',
  ])
  // 未跟踪的字母仍是 `?`（状态字母只按所在侧取字母）
  expect(row.querySelector('.git-row-letter')?.textContent).toBe('?')

  // 未跟踪就是普通的一行：差异基准同样是「工作区 ↔ index」（左空右全文）
  await act(async () => row.click())
  expect(loadDiffSides).toHaveBeenLastCalledWith('n.ts', 'worktree', null)
})

it('同一个文件在两段各有一行时，「当前行」按侧认（暂存段与更改段都能定位）', async () => {
  await mount('s.txt', 'staged')
  expect(activeRow()?.title).toBe('s.txt')
  expect(actionBtn()?.textContent).toBe('取消暂存')

  // 键也按侧拼：暂存段的 s.txt 与更改段若有同名文件不会互相点亮
  expect(rowKey('staged', 's.txt')).not.toBe(rowKey('unstaged', 's.txt'))
})

it('空的那一侧整栏不画：删除的文件只把旧侧交给 Monaco 的单栏形态，未跟踪反之', async () => {
  await mount()

  // 删除（未暂存侧：旧 = index 有内容、新 = 工作区里已经没了）
  vi.mocked(loadDiffSides).mockResolvedValue({
    old_text: 'a\nb\n',
    new_text: null,
    old_label: 'INDEX',
    new_label: '工作区',
    binary: false,
    truncated: false,
  })
  await act(async () => sideRow('b.txt')!.click())
  // 让「取两侧内容」的 promise 落地（上面的 click 只保证切了文件）
  await act(async () => {})

  const stub = document.querySelector('.mono-diff-stub') as HTMLElement
  // 交给正文的是「只留旧侧」的单栏形态：空侧那栏连列头一起不画（DOM 版双栏不再参与）
  expect(stub.dataset.side).toBe('old')
  expect(stub.dataset.old).toBe('a\nb\n')
  expect(stub.dataset.new).toBe('')
  expect(document.querySelector('.diff-side-by-side')).toBeNull()
  // 单侧也不再走 jsdiff：Monaco 那条整行装饰按「整份全删除」上色，不必先算出行
  expect(gitDiffRows).not.toHaveBeenCalled()

  // 未跟踪（旧侧为空）—— 反过来只留「新侧」
  vi.mocked(loadDiffSides).mockResolvedValue({
    old_text: null,
    new_text: 'c\n',
    old_label: 'INDEX',
    new_label: '工作区',
    binary: false,
    truncated: false,
  })
  await act(async () => sideRow('n.ts')!.click())
  await act(async () => {})

  // ⚠️ 必须重新取节点：`loading` 期间正文整块不渲染（`!loading && !error && sides` 那一段），
  // 所以上面那个 `.mono-diff-stub` 已经脱离文档（属性永远停在上一份）—— 切一次文件就是
  // 卸载再重建（与「切文件只 setValue」的口径相左，见 §11.53 ㉜ 的待定项）。
  const next = document.querySelector('.mono-diff-stub') as HTMLElement
  expect(stub.isConnected).toBe(false)
  expect(next.dataset.side).toBe('new')
  expect(next.dataset.old).toBe('')
  expect(next.dataset.new).toBe('c\n')
})
