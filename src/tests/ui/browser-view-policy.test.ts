// @vitest-environment node
/**
 * 网页视图存活策略（`side-panel/browser/view-policy.ts`）：闲置休眠 + 上限 LRU。
 *
 * 两条策略都是**跨标签**的，所以从 hook 里抽成模块层注册表：这里直接驱动注册表，
 * 不挂 React（界面接线由 `browser-pane.test.tsx` 守）。
 *
 * 钉住的口径：
 * 1. 只有「活着 + 彻底不可见 + 没在用」才计闲置时间；切回来立刻取消计时；
 * 2. 值为 0 = 关掉该策略（不休眠 / 不限个数）；
 * 3. 上限淘汰只挑隐藏中的、从最久没看的开始 —— **正看着的那一页绝不被自己关掉**；
 * 4. 设置调小后立刻生效（`refreshBrowserViewPolicy`）。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { settingsState } from '@/ui/store'
import {
  noteBrowserView,
  refreshBrowserViewPolicy,
  resetBrowserViewPolicy,
  setBrowserViewAwake,
  trackBrowserView,
} from '@/ui/pages/chat/components/side-panel/browser/view-policy'

/** 默认值（每个用例前复位，避免互相污染） */
const DEFAULT_SLEEP = 20
const DEFAULT_MAX = 10

beforeEach(() => {
  vi.useFakeTimers()
  settingsState.value.browserSleepAfterSec = DEFAULT_SLEEP
  settingsState.value.browserMaxViews = DEFAULT_MAX
  resetBrowserViewPolicy()
})

afterEach(() => {
  resetBrowserViewPolicy()
  settingsState.value.browserSleepAfterSec = DEFAULT_SLEEP
  settingsState.value.browserMaxViews = DEFAULT_MAX
  vi.useRealTimers()
})

/** 登记一个视图并让它「已建成」 */
function live(label: string): ReturnType<typeof vi.fn> {
  const sleep = vi.fn()
  trackBrowserView(label, sleep)
  setBrowserViewAwake(label, true)
  return sleep
}

it('切走满 N 秒才释放；时间没到就切回来则不计时', () => {
  const sleep = live('a')

  noteBrowserView('a', false, true) // 切走 / 面板收起
  vi.advanceTimersByTime((DEFAULT_SLEEP - 1) * 1000)
  expect(sleep).not.toHaveBeenCalled()

  noteBrowserView('a', true, false) // 又切回来了
  vi.advanceTimersByTime(DEFAULT_SLEEP * 2 * 1000)
  expect(sleep).not.toHaveBeenCalled()

  noteBrowserView('a', false, true)
  vi.advanceTimersByTime(DEFAULT_SLEEP * 1000)
  expect(sleep).toHaveBeenCalledTimes(1)
})

it('设置为 0 = 不休眠', () => {
  settingsState.value.browserSleepAfterSec = 0
  const sleep = live('a')
  noteBrowserView('a', false, true)
  vi.advanceTimersByTime(10 * 60 * 1000)
  expect(sleep).not.toHaveBeenCalled()
})

it('被浮层盖住（不可见但没被挂起）不计闲置：设置页开一会儿不该把页面清掉', () => {
  const sleep = live('a')
  // 与窗口最小化 / 切标签的区别：`parked === false`
  noteBrowserView('a', false, false)
  vi.advanceTimersByTime(DEFAULT_SLEEP * 2 * 1000)
  expect(sleep).not.toHaveBeenCalled()
})

it('上限淘汰：超出时关掉最久没看的隐藏视图，在用的一页不动', () => {
  const a = live('a')
  vi.advanceTimersByTime(1000)
  const b = live('b')
  vi.advanceTimersByTime(1000)
  const c = live('c')

  // 三个都存活着，上限 10：一只都不关
  expect([a, b, c].map((fn) => fn.mock.calls.length)).toEqual([0, 0, 0])

  // 上限调小到 2 → 立刻生效，淘汰最旧的 a
  settingsState.value.browserMaxViews = 2
  refreshBrowserViewPolicy()
  expect(a).toHaveBeenCalledTimes(1)
  expect([b, c].map((fn) => fn.mock.calls.length)).toEqual([0, 0])

  // 用户正看着 b（最旧的那个在用）→ 此时刚好不超额；再新开一个时只能关 c，b 不动
  noteBrowserView('b', true, false)
  refreshBrowserViewPolicy()
  expect(b).not.toHaveBeenCalled()

  vi.advanceTimersByTime(1000)
  const d = live('d')
  expect(b).not.toHaveBeenCalled()
  expect(c).toHaveBeenCalledTimes(1)
  expect(d).not.toHaveBeenCalled()
})

it('上限为 0 = 不限个数', () => {
  settingsState.value.browserMaxViews = 0
  const sleeps = ['a', 'b', 'c', 'd'].map((label) => live(label))
  refreshBrowserViewPolicy()
  expect(sleeps.map((fn) => fn.mock.calls.length)).toEqual([0, 0, 0, 0])
})

it('没建成的视图（awake=false）不计入上限，也不会被休眠', () => {
  const a = live('a')
  vi.advanceTimersByTime(1000)
  const b = live('b')
  settingsState.value.browserMaxViews = 1
  refreshBrowserViewPolicy()
  // 只有两个活着 → 关掉最旧的 a，b 留着
  expect(a).toHaveBeenCalledTimes(1)
  expect(b).not.toHaveBeenCalled()
})

it('注销（关标签 / 卸载）后不再触发，也不占上限名额', () => {
  const sleep = vi.fn()
  const untrack = trackBrowserView('a', sleep)
  setBrowserViewAwake('a', true)
  noteBrowserView('a', false, true)
  untrack()

  vi.advanceTimersByTime(DEFAULT_SLEEP * 2 * 1000)
  expect(sleep).not.toHaveBeenCalled()

  // 名额已释放：上限 1 时再挂两个也不会互相淘汰
  settingsState.value.browserMaxViews = 1
  const b = live('b')
  vi.advanceTimersByTime(1000)
  const c = live('c')
  expect([b, c].map((fn) => fn.mock.calls.length)).toEqual([1, 0])
})
