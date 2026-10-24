/**
 * 网页标签的**原生视图存活策略**：闲置休眠 + 同时存活上限（LRU）。
 *
 * 为什么单独立一份：视图的生命周期本来只归 `use-native-view.ts`，但两条策略都是**跨标签**的
 * （「超过 N 个就关最旧的」得看得见别的标签），所以在模块层放一张注册表，由 hook 把
 * 「我隐身了 / 我建好了 / 请把我销毁」这三件事报上来，这里按设置决定什么时候真的销毁。
 *
 * 两条口径：
 * 1. **只销毁、不导航**：休眠 = 关掉原生视图（`closeBrowserView`），面板自己那份 history /
 *    地址栏 state 不动 —— 切回来重建并重新加载当前地址。页面内状态（滚动、未提交的表单）会丢，
 *    这是「省内存」的代价，设置里写明；
 * 2. **在用的那个绝不动**：上限淘汰只挑 `inUse === false`（隐藏 / 被浮层盖住）的，用户正看着
 *    的视图永远不会被自己关掉；淘汰从 `lastActive` 最旧的开始。
 *
 * ⚠️ 判定用的是 hook 报上来的两个信号，语义不同，别合并：
 * - `inUse`：用户现在就在看这一页（可见、没被浮层盖住）—— 决定「能不能被淘汰」；
 * - `parked`：这块面板彻底不可见（切到别的标签 / 面板收起 / 窗口最小化）—— 决定「何时开始
 *   计时休闲眠」。被设置页的遮罩盖住时 `inUse=false` 但 `parked=false`：用户只是暂时被挡住了，
 *   不该在设置页开着的时候把页面清掉。
 */
import { settingsState } from '@/ui/store'

/** 一个视图（= 一个网页标签）的存活状态 */
interface ViewEntry {
  /** 用户正在看（决定能否被上限淘汰） */
  inUse: boolean
  /** 面板整体不可见（决定是否开始计闲置时间） */
  parked: boolean
  /** 原生视图还活着（open 落地过、还没被销毁） */
  awake: boolean
  /** 最后一次「在用」的时刻（LRU 排序键） */
  lastActive: number
  /** 真正销毁原生视图（由 hook 提供：关视图 + 记住地址，供可见时重建） */
  sleep: () => void
  /** 闲置计时器 */
  timer: ReturnType<typeof setTimeout> | null
}

const entries = new Map<string, ViewEntry>()

/** 设置页的取值范围（与策略同一个源：界面不自己另拧一套边界） */
export const BROWSER_SLEEP_MAX_SEC = 3600
export const BROWSER_MAX_VIEWS_MAX = 50

/** 两个策略参数的唯一读取点（0 = 关闭该策略） */
function policyOf(): { sleepAfterSec: number; maxViews: number } {
  const sleepAfterSec = Number(settingsState.value.browserSleepAfterSec)
  const maxViews = Number(settingsState.value.browserMaxViews)
  return {
    sleepAfterSec: Number.isFinite(sleepAfterSec) ? Math.max(0, sleepAfterSec) : 0,
    maxViews: Number.isFinite(maxViews) ? Math.max(0, maxViews) : 0,
  }
}

function clearTimer(entry: ViewEntry): void {
  if (entry.timer === null) return
  clearTimeout(entry.timer)
  entry.timer = null
}

/**
 * 按当前状态重排这个视图的闲置计时：只有在「活着 + 彻底不可见 + 没在用 + 策略开启」时才计时。
 * 三个条件少一个都说明它随时会被用上（或者在用），到点销毁反而是添乱。
 */
function reschedule(entry: ViewEntry): void {
  clearTimer(entry)
  const { sleepAfterSec } = policyOf()
  if (!entry.awake || entry.inUse || !entry.parked || sleepAfterSec <= 0) return
  entry.timer = setTimeout(() => {
    entry.timer = null
    // 到期时再确认一次：这段时间里可能又被切回来了
    if (!entry.awake || entry.inUse || !entry.parked) return
    entry.awake = false
    entry.sleep()
  }, sleepAfterSec * 1000)
}

/**
 * 上限淘汰：存活视图数超出设置时，关掉「最久没看」的隐藏视图。
 * 在用的视图不参与 —— 关掉用户正看着的那一页等于无端刷新。
 */
function enforceMaxViews(): void {
  const { maxViews } = policyOf()
  if (maxViews <= 0) return
  let over = [...entries.values()].filter((entry) => entry.awake).length - maxViews
  if (over <= 0) return
  const spare = [...entries.values()]
    .filter((entry) => entry.awake && !entry.inUse)
    .sort((a, b) => a.lastActive - b.lastActive)
  for (const entry of spare) {
    if (over <= 0) break
    entry.awake = false
    clearTimer(entry)
    entry.sleep()
    over -= 1
  }
}

/** 登记一个视图（返回注销函数：关标签 / 卸载时调，顺手把计时器收掉） */
export function trackBrowserView(label: string, sleep: () => void): () => void {
  entries.set(label, {
    inUse: false,
    parked: true,
    awake: false,
    lastActive: Date.now(),
    sleep,
    timer: null,
  })
  return () => {
    const entry = entries.get(label)
    if (entry) clearTimer(entry)
    entries.delete(label)
  }
}

/** 可见性 / 是否在用变了（hook 每帧比对后只在**翻转**时调，这里幂等） */
export function noteBrowserView(
  label: string,
  inUse: boolean,
  parked: boolean,
): void {
  const entry = entries.get(label)
  if (!entry) return
  const inUseChanged = entry.inUse !== inUse
  const parkedChanged = entry.parked !== parked
  if (!inUseChanged && !parkedChanged) return
  entry.inUse = inUse
  entry.parked = parked
  if (inUse) entry.lastActive = Date.now()
  reschedule(entry)
}

/** 原生视图建好 / 被销毁了（hook 报上来；`true` 时会立刻做一次上限淘汰） */
export function setBrowserViewAwake(label: string, awake: boolean): void {
  const entry = entries.get(label)
  if (!entry) return
  if (entry.awake === awake) {
    if (awake) enforceMaxViews()
    return
  }
  entry.awake = awake
  if (awake) {
    entry.lastActive = Date.now()
    clearTimer(entry)
    enforceMaxViews()
  } else {
    clearTimer(entry)
  }
}

/** 设置变了：重排所有计时器并重新淘汰一次（用户刚把上限调小，应当立刻生效） */
export function refreshBrowserViewPolicy(): void {
  for (const entry of entries.values()) reschedule(entry)
  enforceMaxViews()
}

/** 单测复位（模块级状态，用例之间必须清干净） */
export function resetBrowserViewPolicy(): void {
  for (const entry of entries.values()) clearTimer(entry)
  entries.clear()
}
