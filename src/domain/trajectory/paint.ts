/**
 * 轨迹概览的 Canvas 绘制指令与命中判定（纯函数，可单测）。
 *
 * 为什么要 Canvas：概览条是「一根记录一个矩形」。长会话上千条记录，用 DOM 就是上千个节点 ——
 * 每次流式更新（每个 token 都会重建整份投影）都要重新 diff 一遍这些节点的样式，缩放后再叠加
 * 滚动重绘必然卡。Canvas 把「一根条」压成一次 `fillRect`：节点数不再参与布局与 diff。
 *
 * 分工（与 git 提交图 `GraphCanvas` 同一套约定）：
 * - **这里只算几何**（像素坐标 / 宽度 / 不透明度 / 颜色槽位）。颜色由视图从 CSS 变量解析 ——
 *   canvas 不认 `var()`，主题一换就得重读。
 * - 视图只把指令翻译成 canvas 调用；拿不到 `getContext('2d')`（jsdom / 极端环境）就静默跳过。
 *
 * ⚠️ 最小可见宽度（{@link MIN_BAR_PX}）必须是**像素**：按百分比给下限的话，下限会跟着缩放一起
 * 放大，几百条记录时相邻条子会互相压住（已踩过）。
 */
import type { TrajectoryTimelineModel, TrajectoryTimelineSpan } from './timeline'
import type { TrajectoryKind } from './types'

/** 泳道高度（px）：⚠️ 与样式里 `.trajectory-timeline__lanes` 的 16px 同一档 */
export const LANE_HEIGHT = 16
/** 轨道高度（px）= 三条泳道：⚠️ 与样式里的 48px 同一档 */
export const STRIP_HEIGHT = LANE_HEIGHT * 3
/** 条子高度（px）与它在泳道内的上边距 */
export const BAR_HEIGHT = 10
export const BAR_OFFSET = 3
/** 条子的最小可见宽度（px）：再窄也要画得出来、点得中 */
export const MIN_BAR_PX = 2
/** 相邻条子之间让出的缝（px）：等宽模式下条子首尾相接，不留缝会糊成一整条 */
export const BAR_GAP_PX = 1

/** 颜色槽位：具体色值由视图从 CSS 变量解析（canvas 读不到 `var()`） */
export type TimelineColorSlot =
  | 'boundary'
  | 'accent'
  | 'text'
  | 'warning'
  | 'violet'
  | 'muted'
  | 'danger'

export interface TimelineRectOp {
  kind: 'rect'
  x: number
  y: number
  w: number
  h: number
  /** 圆角半径（0 = 直角） */
  radius: number
  color: TimelineColorSlot
  alpha: number
}

export interface TimelineVLineOp {
  kind: 'vline'
  x: number
  y: number
  h: number
  color: TimelineColorSlot
  alpha: number
}

export interface TimelineRingOp {
  kind: 'ring'
  x: number
  y: number
  w: number
  h: number
  color: TimelineColorSlot
}

export type TimelinePaintOp = TimelineRectOp | TimelineVLineOp | TimelineRingOp

/** 每类记录的颜色与不透明度（取值等价于原 `.trajectory-span[data-kind]` 的那套） */
const KIND_STYLE: Record<TrajectoryKind, { color: TimelineColorSlot; alpha: number }> = {
  user: { color: 'accent', alpha: 0.7 },
  // 原先 = color-mix(正文色 65%, transparent) 再乘 opacity .55
  message: { color: 'text', alpha: 0.36 },
  tool: { color: 'warning', alpha: 0.7 },
  compacted: { color: 'violet', alpha: 0.6 },
  system: { color: 'muted', alpha: 0.4 },
  context: { color: 'muted', alpha: 0.4 },
}
/** 失败记录的配色压过类型色 */
const ERROR_STYLE = { color: 'danger' as TimelineColorSlot, alpha: 0.85 }
/** 选中 / 悬停时不透明的档位（对应 CSS 的 `opacity: 1`） */
const ACTIVE_ALPHA = 1

/** 绘制参数（全部是 CSS 像素；已减 `scrollLeft` 的坐标系） */
export interface TimelinePaintOptions {
  /** 视口宽（滚动层内容宽，不含滚动条） */
  viewWidth: number
  /** 视口高（= {@link STRIP_HEIGHT}） */
  viewHeight: number
  /** 内容层总宽 = 视口宽 × 缩放倍率（滚动的可滚范围由它决定） */
  contentWidth: number
  /** 横向滚动位置（px） */
  scrollLeft: number
  /** 选区（与 `model` 同一坐标系）；null = 没有 */
  range: { start: number; end: number } | null
  selectedKey: string | null
  hoveredKey: string | null
}

/**
 * 可视窗口的绘制指令。
 *
 * 只覆盖看得见的那一段：放大 32× 时内容层可能宽达几万像素，但一张画布始终只有视口那么大。
 */
export function timelinePaintOps(
  model: TrajectoryTimelineModel,
  view: TimelinePaintOptions,
): TimelinePaintOp[] {
  const ops: TimelinePaintOp[] = []
  const width = view.viewWidth
  const height = view.viewHeight
  const domain = model.end - model.start
  if (width <= 0 || height <= 0 || view.contentWidth <= 0 || domain <= 0) return ops
  /** 域值 → 视口内像素（已减 scrollLeft） */
  const at = (value: number): number =>
    ((value - model.start) / domain) * view.contentWidth - view.scrollLeft

  // 轨道底色不在这里画：那是视口自己的 CSS 背景（这样放大后滚动条也在底色里）

  // 轮次分隔线
  for (const boundary of model.boundaries) {
    const x = at(boundary.at)
    if (x < 0 || x > width) continue
    ops.push({ kind: 'vline', x, y: 0, h: height, color: 'boundary', alpha: 1 })
  }

  // 选区：画在条子下面（与原先 DOM 的叠放顺序一致）
  if (view.range) {
    const from = at(Math.min(view.range.start, view.range.end))
    const to = at(Math.max(view.range.start, view.range.end))
    const left = Math.max(0, Math.min(width, from))
    const right = Math.max(0, Math.min(width, to))
    // 滚动到选区中段时两端都在窗口外 —— 夹到视口内，否则整段选区会消失
    const spanned = Math.max(MIN_BAR_PX, right - left)
    ops.push({
      kind: 'rect',
      x: left,
      y: 0,
      w: spanned,
      h: height,
      radius: 0,
      color: 'accent',
      alpha: 0.14,
    })
    ops.push({ kind: 'vline', x: left, y: 0, h: height, color: 'accent', alpha: 1 })
    ops.push({
      kind: 'vline',
      x: left + spanned - 1,
      y: 0,
      h: height,
      color: 'accent',
      alpha: 1,
    })
  }

  // 记录条：同色且缝已经看不见的相邻条子并进同一个矩形（几千条能压到几十次 fillRect）
  const open: Array<{ op: TimelineRectOp; right: number } | null> = [null, null, null]
  let selectedRect: TimelineRectOp | null = null
  for (const span of model.spans) {
    const left = at(span.start)
    const right = at(span.end)
    if (right < 0 || left > width) continue
    const style = span.isError ? ERROR_STYLE : KIND_STYLE[span.kind]
    const active = span.recordKey === view.selectedKey || span.recordKey === view.hoveredKey
    const alpha = active ? ACTIVE_ALPHA : style.alpha
    const barWidth = Math.max(MIN_BAR_PX, right - left - BAR_GAP_PX)
    const run = open[span.lane]
    if (
      run &&
      !active &&
      run.op.color === style.color &&
      run.op.alpha === alpha &&
      left - run.right < BAR_GAP_PX
    ) {
      run.op.w = left + barWidth - run.op.x
      run.right = left + barWidth
      continue
    }
    const op: TimelineRectOp = {
      kind: 'rect',
      x: left,
      y: span.lane * LANE_HEIGHT + BAR_OFFSET,
      w: barWidth,
      h: BAR_HEIGHT,
      radius: 2,
      color: style.color,
      alpha,
    }
    ops.push(op)
    open[span.lane] = { op, right: left + barWidth }
    if (span.recordKey === view.selectedKey) selectedRect = op
  }

  // 选中环最后画：它要压在相邻条子上面（对应 CSS 的 box-shadow）
  if (selectedRect) {
    ops.push({
      kind: 'ring',
      x: selectedRect.x - 1,
      y: selectedRect.y - 1,
      w: selectedRect.w + 2,
      h: selectedRect.h + 2,
      color: 'accent',
    })
  }
  return ops
}

/**
 * 命中判定：视口坐标 → 落在哪根条子上（点选 / 悬停提示用）。
 *
 * `point` 是相对视口左上角的 CSS 像素；重叠时取**后画的那根**（与视觉上的上下关系一致）。
 */
export function timelineHitTest(
  model: TrajectoryTimelineModel,
  point: { x: number; y: number },
  view: { contentWidth: number; scrollLeft: number },
): TrajectoryTimelineSpan | null {
  const domain = model.end - model.start
  if (domain <= 0 || view.contentWidth <= 0) return null
  const lane = Math.floor(point.y / LANE_HEIGHT)
  if (lane < 0 || lane >= 3) return null
  const value =
    model.start + ((view.scrollLeft + point.x) / view.contentWidth) * domain
  // 容差 = 1px 折算成域值：最窄的条子（MIN_BAR_PX）也要点得中
  const tolerance = domain / view.contentWidth
  let hit: TrajectoryTimelineSpan | null = null
  for (const span of model.spans) {
    if (span.lane !== lane) continue
    if (value < span.start - tolerance || value > span.end + tolerance) continue
    hit = span
  }
  return hit
}

/** 一根条子在内容层里的像素区间（不含滚动偏移）：视图用它把选中的条滚回可视区 */
export function timelineSpanPx(
  model: TrajectoryTimelineModel,
  span: TrajectoryTimelineSpan,
  contentWidth: number,
): { left: number; right: number } {
  const domain = model.end - model.start
  if (domain <= 0) return { left: 0, right: 0 }
  const left = ((span.start - model.start) / domain) * contentWidth
  return {
    left,
    right: Math.max(left + MIN_BAR_PX, ((span.end - model.start) / domain) * contentWidth),
  }
}
