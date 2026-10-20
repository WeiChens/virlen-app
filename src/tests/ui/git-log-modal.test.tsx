/**
 * GitLogModal — 提交记录弹窗（本轮新增）。
 *
 * 六条口径（都是「错了很难受、编译期又不报」的那类）：
 * 1. **四样东西都要看得见**：提交时间 / 提交信息 / 提交用户 / 短 hash —— 完整的 oid 与原始时间戳
 *    进 `title`（悬停能看全，列表不被撑宽）；
 * 2. **时间走相对口径**（`formatCommitTime`，纯函数用例在 `tests/utils/time.test.ts`）：
 *    几分钟前 / 几小时前 / 昨天 / N 天前，超过一周才给 `YYYY-MM-DD HH:mm`；
 *    解析不出来的时间戳**照原样显示**（宁可是个怪字符串，也不能显示一个假时间）；
 * 3. **分页口径只有一处**：拿回**整页**才认为「可能还有」（显示「加载更多」），不足一页就是到底了；
 *    `skip` = 已经拿过的条数（列表长度本身，没有第二份要同步的计数）；
 * 4. **空态 / 错误各有其位**：没有提交记录时给空态；取失败给错误行（弹窗自己有位置说清原因）；
 * 5. **时间列定宽**（`--git-log-time-w`）：相对 / 绝对两种文案长短差很多（`刚刚` vs `2026-10-09 00:53`），
 *    不定宽会让行内右侧三列的左边界逐行浮动 —— 定宽 + 右对齐后用户名与 hash 上下对齐；
 * 6. **遮罩与 Esc 都不能把宿主面板带走**：弹窗 portal 到 body，面板的「点浮层外关闭」按 DOM 包含
 *    关系判定、面板的 Esc 监听挂在 document 上 —— 两条都得在这里拦住（§11.53 ⑱）。
 *
 * 数据全部 mock：git 语义由 Rust 用例（`cargo test -p virlen-core git`）守。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import GitLogModal from '@/ui/pages/chat/components/git/GitLogModal'
import { LOG_PAGE_SIZE, loadCommits } from '@/services/git-service'
import { copyText } from '@/utils/clipboard'
import type { GitCommitLogEntry } from '@/domain/git'

vi.mock('@/services/git-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/git-service')>()
  // 页面大小用**真值**（分页口径是 `>= LOG_PAGE_SIZE`，写死一个数字只会让用例慢慢和实现脱节）
  return { ...actual, loadCommits: vi.fn() }
})

// 行右键菜单的复制项（`commit-menu.ts`）：不 mock 就变「真去读 WebView 剪贴板」
vi.mock('@/utils/clipboard', () => ({ copyText: vi.fn(() => Promise.resolve(true)) }))
vi.mock('@/ui/components/shared/Toast', () => ({
  showToast: vi.fn(),
  useToast: (): unknown => ({ Toast: (): null => null, showToast: vi.fn() }),
}))

// 引用链可能经 store 桶文件拉到 markdown / code-block → monaco，而 monaco 在 jsdom 里导入即崩
// （缺 `CSS.escape`）。本用例不看代码块，换结构等价的最小替身（与其它 UI 用例同款）。
vi.mock('@/monaco/setupMonaco', () => ({
  monaco: { editor: { tokenize: (): unknown[] => [] } },
  virlenDarkTheme: {},
}))

;(globalThis as never as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

function entry(over: Partial<GitCommitLogEntry>): GitCommitLogEntry {
  return {
    oid: 'a'.repeat(40),
    short_oid: 'aaaaaaa',
    author_name: '张三',
    author_email: 'zhangsan@example.com',
    author_time: '2026-10-16T10:29:46+08:00',
    // 提交记录列表用不到这两个（提交图才用）—— 但类型是**必填**的（与 Rust 逐字对应）
    parents: [],
    refs: [],
    subject: 'fix: 优化 diff',
    ...over,
  }
}

/** n 条各不相同的提交（oid 唯一 —— 它同时是 React 的 key）
    ⚠️ 用 `padStart` 补零（`padEnd` 会让 `1` 与 `10` 补成同一串，React 当场报重复 key） */
function page(n: number, offset = 0): GitCommitLogEntry[] {
  return Array.from({ length: n }, (_, i) =>
    entry({
      oid: (offset + i).toString(16).padStart(40, '0'),
      short_oid: `c${offset + i}`,
      subject: `feat: 第 ${offset + i} 次提交`,
    }),
  )
}

/** 与 `formatCommitTime` 的**绝对时间**分支同口径的本地时间（用来断言「显示的是本地时间、不是那串 ISO」） */
function localMinute(iso: string): string {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(
    d.getHours(),
  )}:${p(d.getMinutes())}`
}

let root: ReturnType<typeof createRoot> | null = null
let closed = 0

async function mount() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <GitLogModal
        disabled={false}
        onClose={() => {
          closed += 1
        }}
      />,
    )
  })
}

const rows = () => [...document.querySelectorAll<HTMLElement>('.git-log-row')]
const moreBtn = () =>
  document.querySelector<HTMLButtonElement>('.git-log-more')

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

beforeEach(() => {
  document.body.innerHTML = ''
  closed = 0
  vi.mocked(loadCommits).mockReset()
  vi.mocked(loadCommits).mockResolvedValue(page(2))
  vi.mocked(copyText).mockClear()
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
})

it('一行四样：提交信息在左，作者 / 本地时间 / 短 hash 在右，完整 oid 与原始时间在 title 里', async () => {
  // 超过一周的提交 → 固定给绝对时间（不随 wall clock 变，用例不会明天就红）
  const iso = '2000-01-02T03:04:05+08:00'
  vi.mocked(loadCommits).mockResolvedValue([
    entry({ subject: 'fix: 优化 diff', author_time: iso }),
  ])
  await mount()

  const row = rows()[0]
  expect(row.querySelector('.git-log-subject')?.textContent).toBe('fix: 优化 diff')
  expect(
    [...row.querySelectorAll('.git-log-meta > *')].map((el) =>
      el.getAttribute('class'),
    ),
  ).toEqual(['git-log-author', 'git-log-time', 'git-log-hash'])
  expect(row.querySelector('.git-log-author')?.textContent).toBe('张三')
  // 名字被定宽截断时还看得到全名与邮箱
  expect(row.querySelector('.git-log-author')?.getAttribute('title')).toBe(
    '张三 <zhangsan@example.com>',
  )

  // 超过一周：本地 `YYYY-MM-DD HH:mm`（不是原样的 ISO 串），悬停时给原始时间戳
  const time = row.querySelector('.git-log-time')!
  expect(time.textContent).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  expect(time.textContent).toBe(localMinute(iso))
  expect(time.textContent).not.toBe(iso)
  expect(time.getAttribute('title')).toBe(iso)

  // hash 是短 oid，完整 oid 在 title 里（列表不被 40 位撑宽）
  const hash = row.querySelector('.git-log-hash')!
  expect(hash.textContent).toBe('aaaaaaa')
  expect(hash.getAttribute('title')).toBe('a'.repeat(40))
})

it('时间是相对口径：半小时前 / 昨天 / 超过一周（口径由 tests/utils/time.test.ts 守边界）', async () => {
  // 用 wall clock **算出来的**相对时刻（而不是写死的日期）：用例放多久都成立
  const halfHourAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString()
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const old = '2000-01-02T03:04:05+08:00'
  vi.mocked(loadCommits).mockResolvedValue([
    entry({ oid: '1'.padStart(40, '0'), author_time: halfHourAgo }),
    entry({
      oid: '2'.padStart(40, '0'),
      author_time: new Date(
        yesterday.getFullYear(),
        yesterday.getMonth(),
        yesterday.getDate(),
        12,
        0,
      ).toISOString(),
    }),
    entry({ oid: '3'.padStart(40, '0'), author_time: old }),
  ])
  await mount()

  const times = [...document.querySelectorAll('.git-log-time')].map(
    (el) => el.textContent,
  )
  expect(times[0]).toBe('30分钟前')
  // 昨天按**日历日**算：哪怕只过去十几个小时也是「昨天」，不是「N小时前」
  expect(times[1]).toBe('昨天')
  expect(times[2]).toBe(localMinute(old))
})

it('取不到第一页就显示错误行；空仓库给空态（各有其位，不互相顶替）', async () => {
  vi.mocked(loadCommits).mockRejectedValueOnce(new Error('git log 失败'))
  await mount()
  expect(document.querySelector('.git-log-message.error')?.textContent).toBe(
    'git log 失败',
  )
  expect(rows().length).toBe(0)
  // 出错时不显示「加载更多」（再点也只会再错一次）
  expect(moreBtn()).toBeNull()

  act(() => root!.unmount())
  document.body.innerHTML = ''
  vi.mocked(loadCommits).mockResolvedValue([])
  await mount()
  expect(document.querySelector('.git-log-message')?.textContent).toBe(
    '没有提交记录',
  )
})

it('时间戳解析不出来时照原样显示（不编造时间，也不把数据藏起来）', async () => {
  vi.mocked(loadCommits).mockResolvedValue([
    entry({ author_time: 'not-a-date' }),
  ])
  await mount()
  expect(
    document.querySelector('.git-log-time')?.textContent,
  ).toBe('not-a-date')
})

it('拿回整页才显示「加载更多」；点了按 skip = 已加载条数追加，不足一页即收掉', async () => {
  vi.mocked(loadCommits).mockResolvedValueOnce(page(LOG_PAGE_SIZE))
  await mount()
  expect(rows().length).toBe(LOG_PAGE_SIZE)
  expect(moreBtn()?.textContent).toBe('加载更多')

  vi.mocked(loadCommits).mockResolvedValueOnce(page(3, LOG_PAGE_SIZE))
  await act(async () => moreBtn()!.click())

  // ⚠️ 第二个参数是范围：不带它时 `loadCommits` 默认 `head`，但弹窗是**显式**传 `'head'` 的
  //（页大小由它决定 —— 断言里不能只写 skip，否则「哪来的页大小」这件事没人守）
  expect(vi.mocked(loadCommits).mock.calls).toEqual([
    [0, 'head'],
    [LOG_PAGE_SIZE, 'head'],
  ])
  expect(rows().length).toBe(LOG_PAGE_SIZE + 3)
  // 不足一页 = 到底了：那颗按钮收掉（不给一个点下去没反应的入口）
  expect(moreBtn()).toBeNull()
  // 除了第一行以外都还在（追加而不是替换）
  expect(rows()[0].querySelector('.git-log-subject')?.textContent).toBe(
    'feat: 第 0 次提交',
  )
  expect(
    rows()[LOG_PAGE_SIZE].querySelector('.git-log-subject')?.textContent,
  ).toBe(`feat: 第 ${LOG_PAGE_SIZE} 次提交`)
})

it('弹窗内的 mousedown 不冒泡到 document（否则宿主浮层被一起关掉）；遮罩上的是关闭意图', async () => {
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

  // 面板的 Esc 监听挂在 document 的冒泡阶段（GitEntry）—— 它不该看见这次 Esc
  const panelListener = vi.fn()
  document.addEventListener('keydown', panelListener)

  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  })
  expect(closed).toBe(1)
  expect(panelListener).not.toHaveBeenCalled()

  document.removeEventListener('keydown', panelListener)
})

it('行右键：详情 / 历史三项 / 复制两项，复制拿的是**这一行**的完整 oid', async () => {
  await mount()
  await rightClick(rows()[1])

  // 这一份提交没有引用、也不是 HEAD（快照里没有 head）—— 分支类与「撤销上次提交」一个都不出现；
  // 「挑选」也不给：提交记录视图（scope = head）里每一行都是 HEAD 的祖先，挑了必是空提交
  expect(menuLabels()).toEqual([
    '查看提交详情',
    '在此提交上新建分支…',
    '还原这条提交（revert）',
    '重置当前分支到这笔提交（保留改动）',
    '复制提交 hash',
    '复制提交标题',
  ])

  await act(async () => menuItem('复制提交 hash').click())
  // 第二行（`page()` 的 oid = 下标补零到 40 位），不是第一行 —— 菜单认的是被点的那一行
  expect(copyText).toHaveBeenCalledWith('1'.padStart(40, '0'))
  // 动完就收起（菜单不留在屏上），弹窗也没被一起关掉
  expect(menuLabels()).toEqual([])
  expect(closed).toBe(0)
})

it('「在此提交上新建分支…」开输入框：Esc 先关输入框、再按一次才关弹窗', async () => {
  await mount()
  await rightClick(rows()[1])
  await act(async () => menuItem('在此提交上新建分支…').click())

  const input = document.querySelector<HTMLInputElement>('.git-new-branch-input')
  expect(input).not.toBeNull()
  // 说清「从哪一笔开始」：标题来自**被点那一行**
  expect(document.querySelector('.git-new-branch-hint')?.textContent).toBe(
    '新分支会从「feat: 第 1 次提交」开始，并立即切换过去。',
  )

  // 输入非法名字：合法性由 Rust 的 check-ref-format 回答（此处 dir 为空 → false），就地报错
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!
    setter.call(input, 'bad name')
    input!.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(document.querySelector('.git-new-branch-error')?.textContent).toBe(
    '不是合法的分支名',
  )

  // Esc 第一下只关输入框（内层弹窗让路，否则一次 Esc 关两层）
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  })
  expect(document.querySelector('.git-new-branch-input')).toBeNull()
  expect(closed).toBe(0)

  // 第二下才是关弹窗
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  })
  expect(closed).toBe(1)
})
