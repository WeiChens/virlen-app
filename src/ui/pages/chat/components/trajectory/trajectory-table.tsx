/**
 * 轨迹表：一张虚拟化的「事件记录表」。
 *
 * 结构固定三列信息 + 四个数字（输入 / 输出 / 思考 / 时间），行高固定 —— 所以直接按
 * 行数组喂给虚拟列表，不做动态测量（内容都在检查器里看，表格只负责「一眼扫完」）。
 *
 * ⚠️ 行号 `#N` 是记录的**全局位置**，不随搜索 / 折叠重新编号：折叠一轮之后出现
 * `#3 → #9` 的跳号是正确的（中间那些记录还在会话里，只是收起来了）。
 */
import { useEffect, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { TrajectoryDisplayRow, TrajectoryRecord } from '@/domain/trajectory'
import { RECORD_ROW_HEIGHT, turnSummary } from '@/domain/trajectory'
import { formatDuration } from '@/utils/time'
import { t, tpl } from '@/ui/i18n'
import {
  attachmentLabel,
  groupTitle,
  kindLabel,
  recordText,
  toolResultText,
  turnTitle,
} from './labels'

export interface TrajectoryTableProps {
  rows: readonly TrajectoryDisplayRow[]
  /** `record.key` → `rows` 下标（定位用 key：前插历史后行号会重新编号） */
  recordRowIndexByKey: Map<string, number>
  /** 搜索命中的记录行号（null = 没有搜索） */
  matchIndexes: ReadonlySet<number> | null
  /** 时间轴选中的记录行号（null = 没有选区） */
  focusIndexes: ReadonlySet<number> | null
  /** 当前选中的记录 key（检查器打开的那条） */
  selectedKey: string | null
  onSelect: (record: TrajectoryRecord) => void
  onToggleTurn: (turnKey: string) => void
  /** 外部请求滚动到某条记录（时间轴点击 / 搜索跳转） */
  scrollTarget: { key: string; nonce: number } | null
  /**
   * 视口内第一条记录行的 key（父层回补更早历史后用它把视口锚回原处）。
   * 用 ref 而不是回调：这个值随滚动每帧都变，用 state 会让整个视图重渲染。
   */
  anchorKeyRef: { current: string | null }
  /**
   * 「滚到尾部」请求（每次递增）：首次打开 / 切会话时用 —— 用户看轨迹最先想看的是**最新**的记录，
   * 不是几十轮之前的开头。只在 nonce 变化或表从空变非空时生效，流式追加不会把视口抢回底部。
   */
  scrollToEndNonce: number
  /** 是否还有更早的消息可回补 */
  hasMoreOlder: boolean
  loadingOlder: boolean
  onLoadOlder: () => void
}

/** 滚到接近顶部时自动回补更早历史的阈值（px） */
const AUTO_LOAD_THRESHOLD_PX = 64

/** 固定的数字列：没有值一律显示破折号（不显示 0，0 是「测到了零」，不是「不知道」） */
function metric(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—'
  return String(value)
}

/** 耗时列：未知显示破折号，进行中显示省略号 */
function durationText(record: TrajectoryRecord): string {
  if (record.running) return t('进行中')
  if (record.durationMs === null) return '—'
  // 反推值不是实测：加 ≈ 让用户一眼看出这个数是估的（账本实测值不加）
  if (record.durationSource === 'derived') return `≈${formatDuration(record.durationMs)}`
  return formatDuration(record.durationMs)
}

/** 耗时列的悬停说明：三种来源的可信度不一样，不写清楚就会被当成同一个数 */
function durationHint(record: TrajectoryRecord): string {
  switch (record.durationSource) {
    case 'usage':
      return t('用量账本实测的请求耗时（含首字延迟与工具参数生成）')
    case 'derived':
      return t('反推值：请求发出 → 第一个工具开跑；账本里没有这次请求的耗时记录')
    case 'tool':
      return t('工具执行的实测耗时')
    default:
      return t('没有可用的耗时记录')
  }
}

export function TrajectoryTable({
  rows,
  recordRowIndexByKey,
  matchIndexes,
  focusIndexes,
  selectedKey,
  onSelect,
  onToggleTurn,
  scrollTarget,
  anchorKeyRef,
  scrollToEndNonce,
  hasMoreOlder,
  loadingOlder,
  onLoadOlder,
}: TrajectoryTableProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => containerRef.current,
    estimateSize: (index) => rows[index]?.height ?? RECORD_ROW_HEIGHT,
    getItemKey: (index) => rows[index]?.key ?? index,
    overscan: 12,
  })

  // 外部定位（时间轴点击 / 搜索跳转）：滚动到对应的虚拟行
  const scrollNonce = scrollTarget?.nonce ?? 0
  useEffect(() => {
    if (!scrollTarget) return
    const rowIndex = recordRowIndexByKey.get(scrollTarget.key)
    if (rowIndex === undefined) return
    virtualizer.scrollToIndex(rowIndex, { align: 'center' })
    // 只在 nonce 变化时滚动：同一个目标重复点击也要能重新对齐（nonce 每次 +1）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollNonce])

  // 首次打开 / 切会话：定位到尾部（最新的记录）
  const rowsEmpty = rows.length === 0
  useEffect(() => {
    if (rowsEmpty) return
    const frame = requestAnimationFrame(() => {
      virtualizer.scrollToIndex(rows.length - 1, { align: 'end' })
    })
    return () => cancelAnimationFrame(frame)
    // 依赖布尔值：流式追加（length 变但非空）不应把视口抢回底部
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollToEndNonce, rowsEmpty])

  // 滚到顶部附近自动回补一页更早的历史（加载中由父层去重）
  const handleScroll = () => {
    const el = containerRef.current
    if (!el || !hasMoreOlder || loadingOlder) return
    if (el.scrollTop < AUTO_LOAD_THRESHOLD_PX) onLoadOlder()
  }

  // 把「视口内第一条记录」的 key 上报给父层（回补历史后用它锚回原处）。
  // 渲染期间只写 ref，不触发任何状态更新。
  const virtualItems = virtualizer.getVirtualItems()
  for (const item of virtualItems) {
    const row = rows[item.index]
    if (row?.kind === 'record') {
      anchorKeyRef.current = row.record.key
      break
    }
  }

  return (
    <div className="trajectory-table">
      <div className="trajectory-table__head" role="row">
        <span className="col-index">#</span>
        <span className="col-kind">{t('类型')}</span>
        <span className="col-text">{t('内容')}</span>
        <span className="col-num">{t('输入')}</span>
        <span className="col-num">{t('输出')}</span>
        <span className="col-num">{t('思考')}</span>
        <span className="col-time">{t('时间')}</span>
      </div>

      {hasMoreOlder && (
        <button
          type="button"
          className="trajectory-table__more"
          disabled={loadingOlder}
          onClick={onLoadOlder}>
          {loadingOlder ? t('正在加载更早的记录…') : t('↑ 加载更早的记录')}
        </button>
      )}

      <div
        className="trajectory-table__scroll"
        ref={containerRef}
        onScroll={handleScroll}
        role="rowgroup">
        {rows.length === 0 ? (
          <div className="trajectory-table__empty">{t('这段会话还没有可显示的记录')}</div>
        ) : (
          <div
            className="trajectory-table__body"
            style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index]
              if (!row) return null
              return (
                <div
                  key={item.key}
                  className="trajectory-row-wrap"
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: item.size,
                    transform: `translateY(${item.start}px)`,
                  }}>
                  {row.kind === 'turn' ? (
                    <TurnRow row={row} onToggle={onToggleTurn} />
                  ) : row.kind === 'group' ? (
                    <GroupRow row={row} />
                  ) : (
                    <RecordRow
                      row={row}
                      selected={row.record.key === selectedKey}
                      matched={matchIndexes?.has(row.record.index) === true}
                      dimmed={
                        focusIndexes !== null && !focusIndexes.has(row.record.index)
                      }
                      onSelect={onSelect}
                    />
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

/** 轮头行：折叠开关 + 轮次标题 + 轮内合计 */
function TurnRow({
  row,
  onToggle,
}: {
  row: Extract<TrajectoryDisplayRow, { kind: 'turn' }>
  onToggle: (turnKey: string) => void
}) {
  const summary = turnSummary(row.turn)
  const totals = [
    row.turn.input !== null ? `${t('输入')} ${row.turn.input}` : null,
    row.turn.output !== null ? `${t('输出')} ${row.turn.output}` : null,
    row.turn.knownMs !== null && row.turn.knownMs > 0
      ? `${t('已知耗时')} ${formatDuration(row.turn.knownMs)}`
      : null,
  ].filter((part): part is string => part !== null)
  return (
    <button
      type="button"
      className="trajectory-turn"
      aria-expanded={!row.collapsed}
      onClick={() => onToggle(row.turn.key)}>
      <span className={`trajectory-turn__caret${row.collapsed ? '' : ' is-open'}`}>▸</span>
      <span className="trajectory-turn__title">{turnTitle(row.turn.title)}</span>
      <span className="trajectory-turn__summary">
        {row.collapsed
          ? tpl('$__groups__ 组 · $__records__ 条记录', {
            groups: summary.groups,
            records: summary.records,
          })
          : totals.join(' · ')}
      </span>
    </button>
  )
}

/** 组头行：`消息` / `第 N 步` + 组内已知耗时 */
function GroupRow({
  row,
}: {
  row: Extract<TrajectoryDisplayRow, { kind: 'group' }>
}) {
  return (
    <div className="trajectory-group">
      <span className="trajectory-group__title">{groupTitle(row.group.title)}</span>
      {row.group.knownMs !== null && row.group.knownMs > 0 && (
        <span className="trajectory-group__meta">{formatDuration(row.group.knownMs)}</span>
      )}
    </div>
  )
}

/** 一条记录行 */
function RecordRow({
  row,
  selected,
  matched,
  dimmed,
  onSelect,
}: {
  row: Extract<TrajectoryDisplayRow, { kind: 'record' }>
  selected: boolean
  matched: boolean
  dimmed: boolean
  onSelect: (record: TrajectoryRecord) => void
}) {
  const { record } = row
  const className = [
    'trajectory-record',
    `is-${record.kind}`,
    selected ? 'is-selected' : '',
    matched ? 'is-match' : '',
    dimmed ? 'is-dimmed' : '',
    record.isError ? 'is-error' : '',
    record.running ? 'is-running' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <button
      type="button"
      className={className}
      title={recordText(record)}
      onClick={() => onSelect(record)}>
      <span className="col-index">#{record.index}</span>
      <span className="col-kind">
        <span className="trajectory-kind" data-kind={record.kind}>
          {kindLabel(record.kind)}
        </span>
      </span>
      <span className="col-text">
        {record.request?.modelShift && record.request.model && (
          <span
            className="trajectory-record__model"
            title={t('本次请求使用的模型（与上一次请求不同）')}>
            {record.request.model}
          </span>
        )}
        {record.kind === 'tool' ? (
          <>
            <span className="trajectory-tool__name">{record.toolName ?? t('工具调用')}</span>
            {record.argsText && (
              <span className="trajectory-tool__args">{record.argsText}</span>
            )}
            {toolResultText(record) && (
              <>
                <span className="trajectory-tool__arrow">→</span>
                <span className="trajectory-tool__result">{toolResultText(record)}</span>
              </>
            )}
          </>
        ) : (
          <>
            <span className="trajectory-record__text">{recordText(record)}</span>
            {attachmentLabel(record) && (
              <span className="trajectory-record__attachments">
                {attachmentLabel(record)}
              </span>
            )}
          </>
        )}
        {record.isError && <span className="trajectory-record__badge">{t('失败')}</span>}
        {record.running && <span className="trajectory-record__pulse" />}
      </span>
      <span className="col-num">{metric(record.input)}</span>
      <span className="col-num">{metric(record.output)}</span>
      <span className="col-num">
        {record.thinkingMs !== undefined && record.thinkingMs > 0
          ? formatDuration(record.thinkingMs)
          : '—'}
      </span>
      <span className="col-time" title={durationHint(record)}>
        {durationText(record)}
      </span>
    </button>
  )
}
