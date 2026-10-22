/**
 * 轨迹概览条：整段会话的「地图」。
 *
 * 三条泳道（输入 / 助手 / 工具）从左到右铺开，每条记录一根细条。点一根条 → 表格滚过去；
 * 在空白处拖出一个区间 → 表格里只提亮那个时间段的记录（其余淡化，但不隐藏 ——
 * 隐藏会让人瞬间失去上下文，而且行号会跳）。
 *
 * 两种模式由工具栏切换：
 * - `sequence` 等宽：每条记录一格，永远可用
 * - `time` 真实时间：按记录的实际起止投影；不知道起点的记录**不画**（不猜位置）
 */
import { useRef, useState, type PointerEvent } from 'react'
import type {
  TrajectoryTimelineMode,
  TrajectoryTimelineModel,
} from '@/domain/trajectory'
import { t, tpl } from '@/ui/i18n'

export interface TrajectoryTimelineProps {
  model: TrajectoryTimelineModel | null
  mode: TrajectoryTimelineMode
  /** 当前选区（同一模式的坐标系）；null = 没有选区 */
  range: { start: number; end: number } | null
  /** 当前选中的记录 key（高亮它那根条） */
  selectedKey: string | null
  /** 点击某根条：表格定位到那条记录（传 key：前插历史后行号会变） */
  onSelectRecord: (recordKey: string) => void
  /** 拖选 / 清除选区 */
  onRangeChange: (range: { start: number; end: number } | null) => void
}

/** 泳道高度（与样式里的 16px 对齐） */
const LANE_HEIGHT = 16
/** 拖动超过这个距离才算「拉选区」，否则当点击 */
const DRAG_THRESHOLD_PX = 3

interface DragState {
  pointerId: number
  startX: number
  /** 起点换算成域值 */
  from: number
  moved: boolean
}

export function TrajectoryTimeline({
  model,
  mode,
  range,
  selectedKey,
  onSelectRecord,
  onRangeChange,
}: TrajectoryTimelineProps) {
  const trackRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<DragState | null>(null)

  if (!model || model.end <= model.start) {
    return (
      <div className="trajectory-timeline is-empty">
        <span>{t('这段会话还没有可投影的记录')}</span>
      </div>
    )
  }

  const domain = model.end - model.start
  /** 域值 → 百分比 */
  const pct = (value: number) => ((value - model.start) / domain) * 100
  /** 客户端坐标 → 域值 */
  const domainAt = (clientX: number): number => {
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0) return model.start
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    return model.start + ratio * domain
  }

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const from = domainAt(event.clientX)
    setDrag({ pointerId: event.pointerId, startX: event.clientX, from, moved: false })
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag || drag.pointerId !== event.pointerId) return
    if (!drag.moved && Math.abs(event.clientX - drag.startX) < DRAG_THRESHOLD_PX) {
      return
    }
    const to = domainAt(event.clientX)
    setDrag({ ...drag, moved: true })
    onRangeChange({
      start: Math.min(drag.from, to),
      end: Math.max(drag.from, to),
    })
  }

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag || drag.pointerId !== event.pointerId) return
    // 没拖动 = 点空白：清掉选区
    if (!drag.moved) onRangeChange(null)
    setDrag(null)
    event.currentTarget.releasePointerCapture?.(event.pointerId)
  }

  return (
    <div className="trajectory-timeline">
      <div className="trajectory-timeline__lanes" aria-hidden="true">
        <span>{t('输入')}</span>
        <span>{t('助手')}</span>
        <span>{t('工具')}</span>
      </div>
      <div
        className="trajectory-timeline__track"
        ref={trackRef}
        role="presentation"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => setDrag(null)}
        onContextMenu={(event) => {
          // 右键 = 清除选区（与「在放大的视口上拖动」区分：这里没有缩放，只清选区）
          event.preventDefault()
          onRangeChange(null)
        }}>
        {/* 轮次分隔线 */}
        {model.boundaries.map((boundary) => (
          <span
            key={`b:${boundary.turn}`}
            className="trajectory-timeline__boundary"
            style={{ left: `${pct(boundary.at)}%` }}
            title={tpl('第 $__turn__ 轮', { turn: boundary.turn })}
          />
        ))}
        {/* 选区 */}
        {range && (
          <span
            className="trajectory-timeline__range"
            style={{
              left: `${pct(Math.min(range.start, range.end))}%`,
              width: `${Math.max(0.4, pct(Math.max(range.start, range.end)) - pct(Math.min(range.start, range.end)))}%`,
            }}
          />
        )}
        {/* 记录条 */}
        {model.spans.map((span) => {
          const left = pct(span.start)
          const width = Math.max(0.35, pct(span.end) - left)
          return (
            <button
              key={`s:${span.index}`}
              type="button"
              className={`trajectory-span${span.recordKey === selectedKey ? ' is-selected' : ''}${span.isError ? ' is-error' : ''}`}
              data-kind={span.kind}
              style={{
                left: `${left}%`,
                width: `${width}%`,
                top: span.lane * LANE_HEIGHT,
              }}
              title={span.label}
              // 点条子只做定位：不启动拖选
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation()
                onSelectRecord(span.recordKey)
              }}
            />
          )
        })}
      </div>
      <span className="trajectory-timeline__mode">
        {mode === 'time' ? t('真实时间') : t('等宽')}
      </span>
    </div>
  )
}
