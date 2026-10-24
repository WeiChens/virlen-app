/**
 * 轨迹投影层（纯函数，可单测）：消息 → 轮次/组/记录 + 概览时间轴 + 扁平行 + 搜索。
 *
 * UI 只消费这里的结果，不自己算「哪条消息属于第几步」这类规则 —— 规则只有一份。
 */
export type {
  TrajectoryAttachments,
  TrajectoryBuildInput,
  TrajectoryDurationSource,
  TrajectoryEmptyReason,
  TrajectoryGroup,
  TrajectoryGroupTitle,
  TrajectoryKind,
  TrajectoryLane,
  TrajectoryLedgerStats,
  TrajectoryRecord,
  TrajectoryRequestFacts,
  TrajectoryRequestInfo,
  TrajectoryRequestTotals,
  TrajectoryToolResult,
  TrajectoryTurn,
  TrajectoryTurnTitle,
  TrajectoryWindowStats,
} from './types'
export { RECORD_TEXT_MAX, laneOf } from './types'
export {
  buildTrajectory,
  requestStatsFromTotals,
  summarizeTrajectory,
} from './build'
export { argumentsBrief, contentText, singleLine } from './text'
export {
  buildTimeline,
  hasTimelineTime,
  timelineFocusIndexes,
  type TrajectoryTimelineMode,
  type TrajectoryTimelineModel,
  type TrajectoryTimelineSpan,
  type TrajectoryTurnBoundary,
} from './timeline'
export {
  flattenTrajectory,
  turnSummary,
  GROUP_ROW_HEIGHT,
  RECORD_ROW_HEIGHT,
  TURN_ROW_HEIGHT,
  type TrajectoryDisplayRow,
  type TrajectoryFlatOptions,
  type TrajectoryFlatResult,
} from './rows'
export {
  BAR_GAP_PX,
  BAR_HEIGHT,
  BAR_OFFSET,
  LANE_HEIGHT,
  MIN_BAR_PX,
  STRIP_HEIGHT,
  timelineHitTest,
  timelinePaintOps,
  timelineSpanPx,
  type TimelineColorSlot,
  type TimelinePaintOp,
  type TimelinePaintOptions,
  type TimelineRectOp,
  type TimelineRingOp,
  type TimelineVLineOp,
} from './paint'
export { searchRecords } from './search'
