/**
 * GitGraphModal — 提交图弹窗的界面行为。
 *
 * ⚠️ 这一份**验不到图好不好看**：jsdom 里没有 2D 上下文（`getContext('2d')` 返回 null），
 * 所以「列怎么排、颜色怎么分、线画在哪」全部由 `tests/domain/git-graph.test.ts` 的纯函数用例守。
 * 这里只验四类**结构**口径（错了同样很难受、编译期也不报）：
 *
 * 1. **行里的空位宽 = 本行画到的列 × 整份布局的列宽**（`graphGeometry().rowGutters`，口径唯一实现在
 *    纯函数里，这里只对照它的输出）：不是「整窗口最宽那一行」（用户实测反馈的留白），也不是「按本行
 *    占几列反算列宽」（密集窗口里每行白空 60–85px）；少算一列，**线就压在字上**（canvas 在行之上）；
 * 2. **canvas 是列表上层的绝对定位层**（不在滚动容器里）、且真的被驱动去画（`getContext('2d')` + 点 / 线指令）——
 *    jsdom 里 `clientHeight` 是 0，能画出第 0 行就说明「可视区 → 指令」这条链是通的；
 * 3. **引用标签**（这条线是谁）：**每行只展示一个**（本地优先），其余收进 `+n` 徽标、悬停给详情；
 * 4. **分页口径与提交记录一致**：`scope = 'all'`、页大小 200、拿回整页才显示「加载更多」、
 *    追加页按 oid 去重（`skip` 仍按 git 侧已消费条数推进），
 *    以及弹窗与宿主面板的两条冲突（mousedown / Esc）都不能外泄。
 *
 * 数据全部 mock：git 语义由 Rust 用例（`cargo test -p virlen-core git`）守。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import GitGraphModal from '@/ui/pages/chat/components/git/GitGraphModal'
import { GRAPH_PAGE_SIZE, loadCommits } from '@/services/git-service'
import { copyText } from '@/utils/clipboard'
import { graphGeometry, layoutGraph } from '@/domain/git'
import type { GitCommitLogEntry } from '@/domain/git'

vi.mock('@/services/git-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/git-service')>()
  // 页大小用**真值**（判据是 `>= GRAPH_PAGE_SIZE`，写死数字只会让用例和实现慢慢脱节）
  return { ...actual, loadCommits: vi.fn() }
})

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

/** 假 2D 上下文：只记录「调用过哪些绘制 API」（几何由纯函数用例守） */
function fakeContext(): { calls: string[] } & Record<string, unknown> {
  const calls: string[] = []
  const record = (name: string) => (): void => {
    calls.push(name)
  }
  return {
    calls,
    beginPath: record('beginPath'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    bezierCurveTo: record('bezierCurveTo'),
    arc: record('arc'),
    stroke: record('stroke'),
    fill: record('fill'),
    clearRect: record('clearRect'),
    setTransform: record('setTransform'),
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 0,
    lineCap: '',
    lineJoin: '',
  }
}

let ctx: { calls: string[] } & Record<string, unknown>
const originalGetContext = HTMLCanvasElement.prototype.getContext

function commit(over: Partial<GitCommitLogEntry>): GitCommitLogEntry {
  return {
    oid: 'a'.repeat(40),
    short_oid: 'aaaaaaa',
    author_name: '张三',
    author_email: 'zhangsan@example.com',
    author_time: '2026-10-16T10:29:46+08:00',
    parents: [],
    refs: [],
    subject: 'fix: 优化 diff',
    ...over,
  }
}

/** 造一个合法 oid（40 位）—— ⚠️ 父提交必须写**真 oid**，写成 '2' / '3' 这类短字符串
    在窗口里找不到对应提交，于是每个父都会另开一列（用例里踩过：以为 2 列，实际 3 列） */
const oid = (n: number): string => n.toString(16).padStart(40, '0')

/** n 条线性历史（每条 oid 唯一 —— 它同时是 React 的 key） */
function chain(n: number, offset = 0): GitCommitLogEntry[] {
  return Array.from({ length: n }, (_, i) => {
    const last = i === n - 1
    return commit({
      oid: oid(offset + i),
      short_oid: `c${offset + i}`,
      parents: last ? [] : [oid(offset + i + 1)],
      subject: `feat: 第 ${offset + i} 次提交`,
    })
  })
}

let root: ReturnType<typeof createRoot> | null = null
let closed = 0

async function mount() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <GitGraphModal
        disabled={false}
        onClose={() => {
          closed += 1
        }}
      />,
    )
  })
}

const rows = () => [...document.querySelectorAll<HTMLElement>('.git-log-row')]
const refs = () => [...document.querySelectorAll<HTMLElement>('.git-log-ref')]
/** 每行左侧空位的宽度（px）—— ⚠️ 逐行算，不是整窗口一个值 */
const gutterWidths = (): string[] =>
  [...document.querySelectorAll<HTMLElement>('.git-graph-gutter')].map((el) => el.style.width)
const moreBtn = () => document.querySelector<HTMLButtonElement>('.git-log-more')

/** 在某个行上模拟右键（菜单挂在 body 上，不跟着行走） */
async function rightClick(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 120,
        clientY: 90,
      }),
    )
  })
}
const menuLabels = (): (string | null)[] =>
  [...document.querySelectorAll('.context-menu-item')].map((el) => el.textContent)
const menuItem = (label: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll<HTMLButtonElement>('.context-menu-item')].find(
    (el) => el.textContent === label,
  )
  if (!found) throw new Error(`菜单里没有「${label}」`)
  return found
}

/** 期望的每行空位宽度 = 纯函数对**同一份提交**算出来的 `rowGutters`（口径只有一处） */
const expectGutters = (list: GitCommitLogEntry[]): string[] =>
  graphGeometry(
    layoutGraph(list.map((item) => ({ oid: item.oid, parents: item.parents }))),
  ).rowGutters.map((w) => `${w}px`)

beforeEach(() => {
  document.body.innerHTML = ''
  closed = 0
  ctx = fakeContext()
  HTMLCanvasElement.prototype.getContext = vi.fn(
    () => ctx,
  ) as unknown as HTMLCanvasElement['getContext']
  vi.mocked(loadCommits).mockReset()
  vi.mocked(loadCommits).mockResolvedValue(chain(3))
  vi.mocked(copyText).mockClear()
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  HTMLCanvasElement.prototype.getContext = originalGetContext
})

it('每行只按**本行**画到的列留空位（列宽取整份布局那一份）—— 否则每行都白白空出一大片', async () => {
  // 一条线性历史 → 三行都只用到第一列；每行同宽，且 = 两侧内边距 + **一列**（12 + 14 = 26）
  const linear = chain(3)
  await mount()
  expect(gutterWidths()).toEqual(expectGutters(linear))
  expect(gutterWidths()).toEqual(['26px', '26px', '26px'])

  // 换成「一个分叉 + 最后回到主干」的样本：前两行被第 2 列的线占着（含「穿过本行的竖线」）→ 两列宽；
  // 第 2 列 root 之后，最后那行只剩自己一列 → 缩回一列宽
  // （⚠️ 不能拿「节点自己就在第 2 列」的行当反例：它的点本来就画在第 2 列，那一行就是 2 列宽）
  act(() => root!.unmount())
  document.body.innerHTML = ''
  const fork = [
    // M 的第一个父是最后那行（第 0 列），第二个父开第 1 列
    commit({ oid: oid(1), short_oid: 'c1', parents: [oid(4), oid(2)] }),
    commit({ oid: oid(2), short_oid: 'c2', parents: [oid(3)] }),
    commit({ oid: oid(3), short_oid: 'c3', parents: [] }),
    commit({ oid: oid(4), short_oid: 'c4', parents: [] }),
  ]
  vi.mocked(loadCommits).mockResolvedValue(fork)
  await mount()
  expect(gutterWidths()).toEqual(expectGutters(fork))
  expect(gutterWidths()).toEqual(['40px', '40px', '40px', '26px'])
})

it('canvas 垫在列表上层（不在滚动容器里），并真的被驱动去画（点 + 线）', async () => {
  await mount()

  const canvas = document.querySelector('canvas.git-graph-canvas')
  expect(canvas).toBeTruthy()
  // canvas 里的东西读屏看不见 —— 必须有一句话说明它画的是什么
  expect(canvas!.getAttribute('role')).toBe('img')
  expect(canvas!.getAttribute('aria-label')).toContain('提交图')
  // 画布在滚动容器**之外**（行里只有空位），否则每行一个 canvas
  expect(canvas!.closest('.git-log-list')).toBeNull()

  expect(ctx.calls).toContain('clearRect')
  expect(ctx.calls).toContain('arc') // 提交节点
  expect(ctx.calls).toContain('moveTo') // 父子连线
})

it('引用标签只显示一个（本地优先）：其余收进 `+n`，悬停给出被收起的那几个是谁', async () => {
  vi.mocked(loadCommits).mockResolvedValue([
    commit({
      refs: [
        'HEAD -> refs/heads/master',
        'refs/remotes/origin/master',
        'refs/heads/feat/x',
        'tag: refs/tags/v1.0',
        'refs/tags/v1.1',
      ],
    }),
  ])
  await mount()

  // 只两个标签：展示的那个（当前分支） + 徽标
  const labels = refs().map((el) => [el.className, el.textContent])
  expect(labels).toEqual([
    ['git-log-ref is-head', 'master'],
    ['git-log-ref is-more', '+4'],
  ])
  // 徽标的悬停详情：逐个列出被收起的那些（否则 `+4` 是个谜）
  expect(refs()[1].getAttribute('title')).toBe(
    '另有 4 个引用：远程分支：origin/master · 分支：feat/x · 标签：v1.0 · 标签：v1.1',
  )
  // 展示的那个也有种类提示（`origin/master` 光看名字分不出本地还是远程）
  expect(refs()[0].getAttribute('title')).toBe('当前分支：master')
})

it('有本地也有远程时显示本地（不拿远程分支占位置）；只有一个引用时不出现徽标', async () => {
  vi.mocked(loadCommits).mockResolvedValue([
    commit({ refs: ['refs/heads/master', 'refs/remotes/origin/master'] }),
  ])
  await mount()
  expect(refs().map((el) => el.textContent)).toEqual(['master', '+1'])

  act(() => root!.unmount())
  document.body.innerHTML = ''
  vi.mocked(loadCommits).mockResolvedValue([
    commit({ refs: ['refs/remotes/origin/only-remote'] }),
  ])
  await mount()
  // 只有远程时也要显示它（否则这一行只剩一个孤零零的 `+1`），且没有徽标
  expect(refs().map((el) => el.textContent)).toEqual(['origin/only-remote'])
})

it('首页按 GRAPH_PAGE_SIZE 取全部范围；够一页才显示「加载更多」，点了按 skip = 已加载条数', async () => {
  vi.mocked(loadCommits).mockResolvedValueOnce(chain(GRAPH_PAGE_SIZE))
  await mount()
  expect(rows().length).toBe(GRAPH_PAGE_SIZE)
  expect(moreBtn()?.textContent).toBe('加载更多')

  vi.mocked(loadCommits).mockResolvedValueOnce(chain(3, GRAPH_PAGE_SIZE))
  await act(async () => moreBtn()!.click())

  expect(vi.mocked(loadCommits).mock.calls).toEqual([
    [0, 'all'],
    [GRAPH_PAGE_SIZE, 'all'],
  ])
  expect(rows().length).toBe(GRAPH_PAGE_SIZE + 3)
  // 不足一页 = 到底了
  expect(moreBtn()).toBeNull()
})

it('追加页里有重复提交时按 oid 去重，但 skip 仍按 git 侧已消费的条数推进', async () => {
  vi.mocked(loadCommits).mockResolvedValueOnce(chain(GRAPH_PAGE_SIZE))
  await mount()

  // 第二页第一行与第一页最后一行是同一个 oid：`--skip` 是按条数算的，而仓库在这两次分页之间被提交过
  const page2 = chain(GRAPH_PAGE_SIZE, GRAPH_PAGE_SIZE)
  page2[0] = commit({ oid: oid(GRAPH_PAGE_SIZE - 1), short_oid: 'dup' })
  vi.mocked(loadCommits).mockResolvedValueOnce(page2)
  await act(async () => moreBtn()!.click())

  // 去重后少一条；重复的 oid 只出现一次（否则提交图会把同一次提交画成两条断开的列，行 key 也撞）
  expect(rows().length).toBe(GRAPH_PAGE_SIZE * 2 - 1)
  expect(
    document.querySelectorAll(`.git-log-row[data-oid="${oid(GRAPH_PAGE_SIZE - 1)}"]`),
  ).toHaveLength(1)

  // ⚠️ 下一页的 skip 必须是「已消费 200 + 200」，不是去重后的列表长度（否则会跳过一段）
  vi.mocked(loadCommits).mockResolvedValueOnce([])
  await act(async () => moreBtn()!.click())
  expect(vi.mocked(loadCommits).mock.calls).toEqual([
    [0, 'all'],
    [GRAPH_PAGE_SIZE, 'all'],
    [GRAPH_PAGE_SIZE * 2, 'all'],
  ])
})

it('头部显示已加载条数（线在底部断掉是「还没加载到」，不是「历史到此为止」）', async () => {
  await mount()
  expect(document.querySelector('.git-graph-count')?.textContent).toBe('已加载 3 条提交')

  // 空仓库：没有图可讲，头部也不留这个计数
  act(() => root!.unmount())
  document.body.innerHTML = ''
  vi.mocked(loadCommits).mockResolvedValue([])
  await mount()
  expect(document.querySelector('.git-graph-count')).toBeNull()
  expect(document.querySelector('.git-log-message')?.textContent).toBe('没有提交记录')
})

it('取不到第一页就给错误行，并收掉「加载更多」（再点只会再错一次）', async () => {
  vi.mocked(loadCommits).mockRejectedValueOnce(new Error('git log 失败'))
  await mount()
  expect(document.querySelector('.git-log-message.error')?.textContent).toBe(
    'git log 失败',
  )
  expect(rows().length).toBe(0)
  expect(moreBtn()).toBeNull()
})

it('弹窗内的 mousedown 不冒泡到 document；遮罩上的是关闭意图', async () => {
  await mount()

  const hostListener = vi.fn()
  document.addEventListener('mousedown', hostListener)

  act(() => {
    rows()[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  })
  expect(hostListener).not.toHaveBeenCalled()

  act(() => {
    document
      .querySelector('.git-diff-backdrop')!
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  })
  expect(closed).toBe(1)

  document.removeEventListener('mousedown', hostListener)
})

it('Esc 只关弹窗：捕获阶段拦住，宿主面板那颗「Esc 关面板」的监听收不到', async () => {
  await mount()

  const panelListener = vi.fn()
  document.addEventListener('keydown', panelListener)

  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  })
  expect(closed).toBe(1)
  expect(panelListener).not.toHaveBeenCalled()

  document.removeEventListener('keydown', panelListener)
})

it('行右键：菜单项按**这一行**的引用给（切到分支 / 合并到当前分支），复制拿它的完整 oid', async () => {
  // 第一行是当前分支头、第二行挂着一个本地分支 —— 右键第二行只能看到 feature 那两项
  vi.mocked(loadCommits).mockResolvedValue([
    commit({
      oid: oid(1),
      short_oid: 'c1',
      parents: [oid(2)],
      refs: ['HEAD -> refs/heads/master'],
      subject: 'one',
    }),
    commit({
      oid: oid(2),
      short_oid: 'c2',
      parents: [],
      refs: ['refs/heads/feature'],
      subject: 'two',
    }),
  ])
  await mount()
  await rightClick(rows()[1])

  expect(menuLabels()).toEqual([
    '查看提交详情',
    '在此提交上新建分支…',
    '挑选这条提交（cherry-pick）',
    '还原这条提交（revert）',
    '重置当前分支到这笔提交（保留改动）',
    '切换到分支 feature',
    '合并 feature 到当前分支',
    '复制提交 hash',
    '复制提交标题',
    // 行上挂着本地分支 → 多一条「复制分支名称」；这一行没有远程引用，所以只有一条
    '复制分支名称 feature',
  ])

  // 复制的就是这一行那个分支名（不是当前分支 master）
  await act(async () => menuItem('复制分支名称 feature').click())
  expect(copyText).toHaveBeenCalledWith('feature')
  // 点完一项菜单就关了：再开一次才能点下一项
  expect(menuLabels()).toEqual([])
  await rightClick(rows()[1])

  await act(async () => menuItem('复制提交 hash').click())
  expect(copyText).toHaveBeenCalledWith(oid(2))
  expect(menuLabels()).toEqual([])
  expect(closed).toBe(0)
})
