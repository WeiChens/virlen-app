/**
 * 概览条的 canvas 绘制指令与命中判定（纯函数口径）。
 *
 * 为什么这些口径必须有用例：jsdom 里没有 2D 上下文，界面用例只能证明「画了一次」，
 * 证明不了「画在哪、有多宽」。而这里踩过的坑全是几何错：
 * - 宽度下限按百分比给 → 放大后下限跟着放大，相邻条子互相压住（用户实测反馈）；
 * - 只画可视窗口 → 必须先按 scrollLeft 裁，否则放大 32× 时会把几千根条全画到视口外；
 * - 命中判定要带 1px 容差，否则最窄的 2px 条子点不中。
 */
import { describe, expect, it } from 'vitest'
import type { Message } from '@/types'
import {
  BAR_GAP_PX,
  BAR_HEIGHT,
  BAR_OFFSET,
  LANE_HEIGHT,
  MIN_BAR_PX,
  STRIP_HEIGHT,
  buildTimeline,
  buildTrajectory,
  timelineHitTest,
  timelinePaintOps,
  timelineSpanPx,
  type TimelinePaintOptions,
  type TimelineRectOp,
  type TrajectoryTimelineModel,
} from '@/domain/trajectory'

const T0 = 1_700_000_000_000

/** n 条连续的用户消息：等宽模式下正好是 n 根等宽的条 */
function users(n: number): Message[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `u${i}`,
    role: 'user' as const,
    content: `第 ${i} 问`,
    timestamp: T0 + i,
  }))
}

function sequenceModel(n: number): TrajectoryTimelineModel {
  const model = buildTimeline(buildTrajectory({ messages: users(n) }), 'sequence')
  if (!model) throw new Error('模型为空')
  return model
}

/** 视口口径：内容层宽 = 视口宽 × 缩放倍率 */
function view(contentWidth: number, scrollLeft = 0): TimelinePaintOptions {
  return {
    viewWidth: 900,
    viewHeight: STRIP_HEIGHT,
    contentWidth,
    scrollLeft,
    range: null,
    selectedKey: null,
    hoveredKey: null,
  }
}

const rects = (ops: ReturnType<typeof timelinePaintOps>): TimelineRectOp[] =>
  ops.filter((op): op is TimelineRectOp => op.kind === 'rect')

/** 记录条（去掉轨道底色那个圆角矩形） */
const bars = (ops: ReturnType<typeof timelinePaintOps>): TimelineRectOp[] =>
  rects(ops).filter((op) => op.radius === 2)

describe('timelinePaintOps', () => {
  it('几何常量自洽：三条泳道铺满轨道，条子在自己那条泳道里', () => {
    expect(STRIP_HEIGHT).toBe(LANE_HEIGHT * 3)
    expect(BAR_OFFSET + BAR_HEIGHT).toBeLessThanOrEqual(LANE_HEIGHT)
  })

  it('等宽模式：一根记录一根条，宽度 = 一格 − 缝，相邻不重叠', () => {
    const model = sequenceModel(100)
    const ops = timelinePaintOps(model, view(900))
    const items = bars(ops)
    expect(items).toHaveLength(100)
    const slot = 900 / 100
    for (const [index, item] of items.entries()) {
      expect(item.x).toBeCloseTo(index * slot, 6)
      expect(item.w).toBeCloseTo(slot - BAR_GAP_PX, 6)
      // 泳道 = 记录所属的那条（用户消息 → lane 0）
      expect(item.y).toBe(BAR_OFFSET)
    }
  })

  it('放大后宽度按倍率跟着长（下限是像素，不是百分比）', () => {
    const model = sequenceModel(100)
    // 20× = 内容层 18000px，一屏只看得到 6 格
    const zoomed = bars(timelinePaintOps(model, view(900 * 20)))
    expect(zoomed.length).toBeGreaterThan(1)
    for (const [index, item] of zoomed.entries()) {
      // 一格 = 18000/100 = 180px，减掉 1px 缝；早先按百分比给下限时这里会被撑到几十像素
      expect(item.x).toBeCloseTo(index * 180, 6)
      expect(item.w).toBeCloseTo(180 - BAR_GAP_PX, 6)
    }
  })

  it('几万条也只画可视窗口：放大后条数被裁到一屏', () => {
    const model = sequenceModel(4000)
    const contentWidth = 900 * 10
    const visible = 900 / contentWidth
    const ops = timelinePaintOps(model, view(contentWidth, contentWidth / 2))
    const items = bars(ops)
    // 一屏大约覆盖 4000 × (1/10) 条；合并后只会更少
    expect(items.length).toBeLessThan(4000 * visible + 2)
    for (const item of items) {
      expect(item.x + item.w).toBeGreaterThan(0)
      expect(item.x).toBeLessThan(900)
    }
  })

  it('同色相邻条子合并成一个矩形（几千条压到几十次 fillRect）', () => {
    const model = sequenceModel(4000)
    const items = bars(timelinePaintOps(model, view(900)))
    // 缝已经看不见了（一格 < 2px）→ 整条泳道并成一根
    expect(items.length).toBeLessThanOrEqual(3)
  })

  it('选区滚到窗口外时夹到视口边缘（不能凭空消失）', () => {
    const model = sequenceModel(100)
    const ops = timelinePaintOps(model, {
      ...view(3600, 1800),
      range: { start: 0, end: 1 },
    })
    const fill = rects(ops).filter((op) => op.color === 'accent' && op.alpha === 0.14)
    expect(fill).toHaveLength(1)
    expect(fill[0].x).toBe(0)
    expect(fill[0].w).toBeGreaterThanOrEqual(MIN_BAR_PX)
  })

  it('选中的条最后画一圈外框，并压过相邻条子', () => {
    const model = sequenceModel(100)
    const selected = model.spans[5].recordKey
    const ops = timelinePaintOps(model, { ...view(900), selectedKey: selected })
    expect(ops[ops.length - 1].kind).toBe('ring')
    const selectedBar = bars(ops)[5]
    expect(selectedBar.alpha).toBe(1)
  })

  it('视口宽为 0（还没测量）时什么都不画', () => {
    const model = sequenceModel(10)
    expect(timelinePaintOps(model, { ...view(0), viewWidth: 0 })).toHaveLength(0)
  })
})

describe('timelineHitTest', () => {
  it('按泳道 + 横向位置命中；空泳道返回 null', () => {
    const model = sequenceModel(4)
    const screen = { contentWidth: 400, scrollLeft: 0 }
    // 4 条记录铺在 400px 上：每格 100px
    expect(timelineHitTest(model, { x: 50, y: 5 }, screen)?.index).toBe(1)
    expect(timelineHitTest(model, { x: 350, y: 5 }, screen)?.index).toBe(4)
    // 助手泳道（lane 1）没有记录
    expect(timelineHitTest(model, { x: 50, y: LANE_HEIGHT + 5 }, screen)).toBeNull()
  })

  it('滚动之后命中跟着偏移', () => {
    const model = sequenceModel(4)
    const screen = { contentWidth: 400, scrollLeft: 200 }
    expect(timelineHitTest(model, { x: 50, y: 5 }, screen)?.index).toBe(3)
  })

  it('最窄的条子也点得中（容差按像素换算）', () => {
    const model = sequenceModel(4000)
    const screen = { contentWidth: 900, scrollLeft: 0 }
    // 一格 0.225px：落点只可能压着某一条，不应返回 null
    expect(timelineHitTest(model, { x: 450, y: 5 }, screen)).not.toBeNull()
  })
})

describe('timelineSpanPx', () => {
  it('给出记录在内容层里的像素区间（视图用它把选中的条滚回可视区）', () => {
    const model = sequenceModel(4)
    expect(timelineSpanPx(model, model.spans[1], 400)).toEqual({ left: 100, right: 200 })
    // 零宽记录也要留出最小可见宽度
    const collapsed = { ...model.spans[1], start: 1, end: 1 }
    expect(timelineSpanPx(model, collapsed, 400)).toEqual({ left: 100, right: 102 })
  })
})
