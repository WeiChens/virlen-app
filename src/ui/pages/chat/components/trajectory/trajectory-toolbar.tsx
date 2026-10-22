/**
 * 轨迹工具栏：折叠开关 + 概览模式 + 轨迹内搜索。
 *
 * 与 dsh 的轨迹工具栏一一对应（时长 / 轮次 / 调用 / 搜索），只是把「时长」收敛成
 * 两档（等宽 / 真实时间）—— 真实时间模式依赖记录自带的时间戳，没有就禁用。
 */
import type { TrajectoryTimelineMode } from '@/domain/trajectory'
import { t, tpl } from '@/ui/i18n'
import SearchSvg from '@/ui/components/icons/SearchSvg'

export interface TrajectoryToolbarProps {
  /** 所有可折叠的轮都已经收起 */
  allTurnsCollapsed: boolean
  onToggleAllTurns: () => void
  /** 工具行被折叠（只看「谁在什么时候说了什么」） */
  hideToolRecords: boolean
  onToggleToolRecords: () => void
  mode: TrajectoryTimelineMode
  onModeChange: (mode: TrajectoryTimelineMode) => void
  /** 会话里没有任何真实时间（时间轴只能等宽）→ 禁用真实时间开关 */
  timeDisabled: boolean
  query: string
  onQueryChange: (query: string) => void
  /** 命中条数（null = 没有搜索） */
  matchCount: number | null
  onPrevMatch: () => void
  onNextMatch: () => void
}

export function TrajectoryToolbar({
  allTurnsCollapsed,
  onToggleAllTurns,
  hideToolRecords,
  onToggleToolRecords,
  mode,
  onModeChange,
  timeDisabled,
  query,
  onQueryChange,
  matchCount,
  onPrevMatch,
  onNextMatch,
}: TrajectoryToolbarProps) {
  return (
    <div className="trajectory-toolbar" role="toolbar" aria-label={t('轨迹工具栏')}>
      <div className="trajectory-toolbar__actions">
        <button
          type="button"
          className={`trajectory-toggle${mode === 'time' ? ' is-on' : ''}`}
          aria-pressed={mode === 'time'}
          disabled={timeDisabled}
          title={
            timeDisabled
              ? t('这段会话没有可用的时间戳，只能按顺序等宽显示')
              : mode === 'time'
                ? t('切换为等宽显示')
                : t('按真实时间显示（条宽 = 实测耗时）')
          }
          onClick={() => onModeChange(mode === 'time' ? 'sequence' : 'time')}>
          <span className="trajectory-toggle__dot" />
          {t('真实时间')}
        </button>
        <button
          type="button"
          className={`trajectory-toggle${allTurnsCollapsed ? ' is-on' : ''}`}
          aria-pressed={allTurnsCollapsed}
          title={allTurnsCollapsed ? t('展开所有轮次') : t('收起所有轮次')}
          onClick={onToggleAllTurns}>
          {allTurnsCollapsed ? '⊞' : '⊟'} {t('轮次')}
        </button>
        <button
          type="button"
          className={`trajectory-toggle${hideToolRecords ? ' is-on' : ''}`}
          aria-pressed={hideToolRecords}
          title={hideToolRecords ? t('显示工具调用') : t('收起工具调用（只看对话本身）')}
          onClick={onToggleToolRecords}>
          {hideToolRecords ? '⊞' : '⊟'} {t('调用')}
        </button>
      </div>
      <div className="trajectory-toolbar__search">
        <SearchSvg />
        <input
          type="search"
          value={query}
          placeholder={t('在轨迹里搜索')}
          aria-label={t('在轨迹里搜索')}
          onChange={(event) => onQueryChange(event.currentTarget.value)}
        />
        {matchCount !== null && (
          <>
            <span className="trajectory-toolbar__count">
              {tpl('$__n__ 条命中', { n: matchCount })}
            </span>
            <button
              type="button"
              className="trajectory-toolbar__step"
              disabled={matchCount === 0}
              onClick={onPrevMatch}
              title={t('上一个')}>
              ↑
            </button>
            <button
              type="button"
              className="trajectory-toolbar__step"
              disabled={matchCount === 0}
              onClick={onNextMatch}
              title={t('下一个')}>
              ↓
            </button>
          </>
        )}
      </div>
    </div>
  )
}
