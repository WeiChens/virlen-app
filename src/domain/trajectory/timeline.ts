/**
 * 轨迹概览（Overview）的水平投影。
 *
 * 概览条是「整段会话的时间/顺序地图」：每条记录一根细条，按三条泳道排开
 * （输入 / 助手 / 工具），一眼看出这段会话在哪一段最密、哪一段卡了很久。
 *
 * 两种模式：
 * - `sequence`：**等宽**。每条记录一格，与真实时间无关 —— 永远可用，适合看「发生了什么、
 *   顺序怎么排」。这是默认模式。
 * - `time`：**真实时间轴**。按 `startedAt` / `durationMs` 投影；不知道起点的记录不画（不猜），
 *   没有耗时的记录画成一根最小刻度（否则零宽看不见）。整段会话一条可用时间都没有时，
 *   调用方应禁用这个模式（见 `hasTimelineTime`）。
 *
 * ⚠️ 折叠状态**不参与**投影：概览永远是整段会话的地图，收起某一轮不该让地图缩水。
 */
import type { TrajectoryKind, TrajectoryTurn } from './types'
import { laneOf } from './types'

/** 概览投影模式 */
export type TrajectoryTimelineMode = 'sequence' | 'time'

/** 概览里的一根细条（对应一条记录） */
export interface TrajectoryTimelineSpan {
  /** 记录的 1 基行号（悬浮标签 / 回查用） */
  index: number
  /** 记录的稳定 key（前插历史后行号会变，定位只能靠 key） */
  recordKey: string
  kind: TrajectoryKind
  /** 0 = 输入/上下文，1 = 助手，2 = 工具 */
  lane: 0 | 1 | 2
  /** 投影区间（`sequence` = 序号；`time` = Unix ms） */
  start: number
  end: number
  isError: boolean
  /** 悬浮提示用的摘要 */
  label: string
}

/** 轮次分隔线（概览里那条竖直虚线） */
export interface TrajectoryTurnBoundary {
  turn: number
  at: number
}

/** 完整投影（`start`/`end` 是整段会话的域） */
export interface TrajectoryTimelineModel {
  start: number
  end: number
  spans: TrajectoryTimelineSpan[]
  boundaries: TrajectoryTurnBoundary[]
}

const LANE_ORDER: Record<ReturnType<typeof laneOf>, 0 | 1 | 2> = {
  input: 0,
  assistant: 1,
  tool: 2,
}

/** 真实时间轴下「零耗时」记录的最小可见宽度（ms）：取整段跨度的 1/600，最少 1ms */
const MIN_TIME_WIDTH_RATIO = 1 / 600

/** 展平所有轮次里的记录（保持展示顺序） */
function allRecords(turns: readonly TrajectoryTurn[]) {
  const records = []
  for (const turn of turns) {
    for (const group of turn.groups) {
      for (const record of group.records) records.push({ turn, record })
    }
  }
  return records
}

/** 这段会话里是否存在任何一条带真实开始时刻的记录（决定 `time` 模式可不可点） */
export function hasTimelineTime(turns: readonly TrajectoryTurn[]): boolean {
  for (const turn of turns) {
    for (const group of turn.groups) {
      for (const record of group.records) {
        if (record.startedAt !== undefined) return true
      }
    }
  }
  return false
}

/**
 * 投影成概览模型。
 * @param turns 完整的（未折叠的）轨迹
 * @param mode 等宽 / 真实时间
 * @returns 模型；没有任何记录时返回 null（调用方不渲染概览条）
 */
export function buildTimeline(
  turns: readonly TrajectoryTurn[],
  mode: TrajectoryTimelineMode = 'sequence',
): TrajectoryTimelineModel | null {
  const items = allRecords(turns)
  if (items.length === 0) return null

  if (mode === 'time') return buildTimeModel(items)
  return buildSequenceModel(items)
}

function buildSequenceModel(
  items: ReturnType<typeof allRecords>,
): TrajectoryTimelineModel | null {
  const spans: TrajectoryTimelineSpan[] = []
  const boundaries: TrajectoryTurnBoundary[] = []
  for (const { turn, record } of items) {
    if (turn.turn !== null && boundaries[boundaries.length - 1]?.turn !== turn.turn) {
      boundaries.push({ turn: turn.turn, at: spans.length })
    }
    spans.push({
      index: record.index,
      recordKey: record.key,
      kind: record.kind,
      lane: LANE_ORDER[laneOf(record.kind)],
      start: spans.length,
      end: spans.length + 1,
      isError: record.isError === true,
      label: record.text || record.toolName || '',
    })
  }
  if (spans.length === 0) return null
  return { start: 0, end: spans.length, spans, boundaries }
}

function buildTimeModel(
  items: ReturnType<typeof allRecords>,
): TrajectoryTimelineModel | null {
  /** 只保留「知道起点」的记录：不知道起点的记录画上去只能是假的 */
  const timed = items.flatMap(({ turn, record }) => {
    const startedAt = record.startedAt
    if (startedAt === undefined || !Number.isFinite(startedAt)) return []
    const duration = record.durationMs ?? 0
    return [{
      turn,
      record,
      start: startedAt,
      end: startedAt + Math.max(0, duration),
    }]
  })
  if (timed.length === 0) return null

  const domainStart = Math.min(...timed.map((item) => item.start))
  const domainEnd = Math.max(...timed.map((item) => item.end))
  // 跨度为零（只有一条瞬时记录）时给一个最小窗口，避免除零
  const span = domainEnd - domainStart || 1
  const minWidth = Math.max(1, span * MIN_TIME_WIDTH_RATIO)

  const spans: TrajectoryTimelineSpan[] = []
  const boundaries: TrajectoryTurnBoundary[] = []
  for (const item of timed) {
    if (item.turn.turn !== null && boundaries[boundaries.length - 1]?.turn !== item.turn.turn) {
      boundaries.push({ turn: item.turn.turn, at: item.start })
    }
    spans.push({
      index: item.record.index,
      recordKey: item.record.key,
      kind: item.record.kind,
      lane: LANE_ORDER[laneOf(item.record.kind)],
      start: item.start,
      end: Math.max(item.end, item.start + minWidth),
      isError: item.record.isError === true,
      label: item.record.text || item.record.toolName || '',
    })
  }
  return { start: domainStart, end: domainStart + span, spans, boundaries }
}

/**
 * 选区命中的记录行号集合（区间用**闭区间**语义：任何时刻与选区相交即命中）。
 * @param model 概览模型
 * @param range 选中的区间（`sequence` 下是序号，`time` 下是 ms）
 */
export function timelineFocusIndexes(
  model: TrajectoryTimelineModel | null,
  range: { start: number; end: number } | null,
): ReadonlySet<number> | null {
  if (!model || !range) return null
  const low = Math.min(range.start, range.end)
  const high = Math.max(range.start, range.end)
  const indexes = new Set<number>()
  for (const span of model.spans) {
    if (span.start <= high && span.end >= low) indexes.add(span.index)
  }
  return indexes
}
