/**
 * 「滚动位置被浏览器挪走之后该回哪去」的纯逻辑（不碰 DOM / 虚拟库，便于单测）。
 *
 * 为什么需要：窗口最小化 / 恢复、聊天区被 `display:none` 藏起来又放回来时，浏览器会把 `scrollTop`
 * 夹掉（无头 Chromium 实测：内容塌到 0、视口一度高过内容这两种**不会**自己恢复），而夹的结果未必
 * 是 0 —— 中段也可能被夹成某个小偏移。所以判据不能只看「是不是 0」，得记住**读到哪一行**：
 * 像素偏移会随行重测 / 估算改值漂移，行下标 + 行内偏移才是稳定的内容锚点。
 *
 * 这里只回答两个问题：**此刻的意图是什么**（贴着底部 / 停在某行某处继续读）、
 * **现在的位置算不算丢了**；真正的写入（`scrollTop` / `scrollToIndex`）留给控制器。
 */
import { AT_BOTTOM_THRESHOLD, RESTORE_TOLERANCE } from './constants'

/** 视口顶端压在哪一行、离行首多少像素（内容锚点） */
export interface RowAnchor {
  index: number
  delta: number
}

/** 离开这一屏时的意图：贴着底部，还是停在某行某处继续读 */
export interface ScrollIntent {
  atEnd: boolean
  offset: number
  /** 离开底部时的内容锚点（贴底时为 null：底部只认「贴底」这条意图） */
  anchor: RowAnchor | null
}

/** 滚动容器此刻的几何（`scrollTop` / `scrollHeight` / `clientHeight` 三件套） */
export interface ScrollView {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

/** 可滚动的最大偏移（内容不足一屏时为 0） */
export function maxScrollTopOf(view: ScrollView): number {
  return Math.max(0, view.scrollHeight - view.clientHeight)
}

/**
 * 视口顶端压在哪个条目上（`items` 按 `start` 升序，即虚拟库的 `measurementsCache`）。
 * 滚动事件每帧都会调一次，故二分。
 */
export function anchorAt(
  items: readonly { index: number; start: number }[],
  scrollTop: number,
): RowAnchor | null {
  if (items.length === 0) return null
  let lo = 0
  let hi = items.length - 1
  let hit = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (items[mid].start <= scrollTop) {
      hit = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  const item = items[hit]
  return { index: item.index, delta: scrollTop - item.start }
}

/**
 * 由这一帧的几何算出意图（每次滚动事件调一次）。
 *
 * ⚠️ 几何**不可信**时保留上一次的意图：视口被夹到 0（最小化那一拍）、内容比视口还矮
 * （塌陷 / 空列表）。那时的「贴底」是塌陷的假象，拿它覆盖会正好把「用户本来贴在底部」
 * 这条信息抹掉 —— 而塌陷正是要救回来的场景。
 */
export function nextIntent(
  prev: ScrollIntent,
  view: ScrollView,
  anchor: RowAnchor | null = null,
): ScrollIntent {
  // 视口被夹到 0（最小化那一拍）/ 内容比视口还矮（塌陷、空列表）：这一拍的几何不可信
  if (view.clientHeight <= 0 || view.scrollHeight <= view.clientHeight) return prev
  const dist = view.scrollHeight - view.clientHeight - view.scrollTop
  const atEnd = dist <= AT_BOTTOM_THRESHOLD
  return { atEnd, offset: view.scrollTop, anchor: atEnd ? null : anchor }
}

/**
 * 现在的位置明显不是意图所在 → 返回要去的偏移（`'end'` = 贴底）；没丢 → `null`。
 *
 * 判据按锚点算（总高变了也回同一处内容），**不做「只有 0 才算丢」的假设**：浏览器夹出来的
 * 中段偏移同样是丢了。容差 `RESTORE_TOLERANCE` 之内不写，免得与虚拟库自己的补偿打架。
 */
export function restoreTargetOf(
  intent: ScrollIntent,
  view: ScrollView,
  startOfRow?: (index: number) => number | undefined,
): number | 'end' | null {
  // 视口 0（最小化那一拍）无法判断位置，也不能写
  if (view.clientHeight <= 0) return null
  const max = maxScrollTopOf(view)
  // 内容不足一屏：无处可滚，也就无所谓位置
  if (max <= AT_BOTTOM_THRESHOLD) return null
  if (intent.atEnd) {
    return max - view.scrollTop > AT_BOTTOM_THRESHOLD ? 'end' : null
  }
  const want = intentOffset(intent, startOfRow)
  const target = Math.min(Math.max(0, want), max)
  return Math.abs(view.scrollTop - target) > RESTORE_TOLERANCE ? target : null
}

/** 意图对应的内容偏移：优先用锚点所在行现算（行高重测过也不跑偏），退化用记下的像素偏移 */
function intentOffset(
  intent: ScrollIntent,
  startOfRow?: (index: number) => number | undefined,
): number {
  const anchor = intent.anchor
  if (anchor && startOfRow) {
    const start = startOfRow(anchor.index)
    if (start !== undefined) return start + anchor.delta
  }
  return intent.offset
}
