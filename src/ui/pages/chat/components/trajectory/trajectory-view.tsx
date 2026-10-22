/**
 * 轨迹视图（容器）：工具栏 + 概览条 + 记录表 + 检查器。
 *
 * 只读地看待一段会话：**不改任何消息、不写库**，与聊天视图共享同一份 `messages`
 * （因此流式回答在轨迹里也会实时长出来）。
 *
 * 状态都是「视图自己的」：折叠了哪些轮、是否藏工具行、概览模式、选区、选中记录、抽屉宽度。
 * 切会话时全部重置 —— 这些状态语义上都属于「正在看的这段会话」。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Message } from '@/types'
import {
  buildTimeline,
  buildTrajectory,
  flattenTrajectory,
  hasTimelineTime,
  searchRecords,
  summarizeTrajectory,
  timelineFocusIndexes,
  type TrajectoryRecord,
  type TrajectoryTimelineMode,
} from '@/domain/trajectory'
import { t } from '@/ui/i18n'
import { TrajectoryInspector } from './trajectory-inspector'
import { groupTitle } from './labels'
import { TrajectoryStats } from './trajectory-stats'
import { TrajectoryTable } from './trajectory-table'
import { TrajectoryTimeline } from './trajectory-timeline'
import { TrajectoryToolbar } from './trajectory-toolbar'
import { useSessionUsage } from './use-session-usage'
import './style.scss'

export interface TrajectoryViewProps {
  /** 当前会话 id（切会话时重置视图状态） */
  sessionId: string
  /** 会话系统提示词（顶部那条 `系统` 行） */
  systemPrompt?: string | null
  /** 已加载的消息（会话顺序，与聊天视图同一份） */
  messages: Message[]
  /** 是否还有更早的历史可回补 */
  hasMoreOlder: boolean
  /** 回补一页更早的历史 */
  onLoadOlder: () => Promise<void> | void
  /** 跳回聊天并定位到某条消息 */
  onJumpToMessage: (messageId: string) => void
  /** 退出轨迹视图 */
  onClose: () => void
}

/** 检查器宽度范围（与 CSS 的 min/max 对齐） */
const INSPECTOR_MIN_WIDTH = 320
const INSPECTOR_MAX_WIDTH = 720
const INSPECTOR_DEFAULT_WIDTH = 400
const INSPECTOR_STORAGE_KEY = 'virlen.trajectory.inspectorWidth'

function storedInspectorWidth(): number {
  try {
    const raw = localStorage.getItem(INSPECTOR_STORAGE_KEY)
    const value = raw === null ? NaN : Number(raw)
    if (Number.isFinite(value)) {
      return Math.min(INSPECTOR_MAX_WIDTH, Math.max(INSPECTOR_MIN_WIDTH, value))
    }
  } catch {
    // 隐私模式 / 无 localStorage：用默认值
  }
  return INSPECTOR_DEFAULT_WIDTH
}

/** 在轨迹里定位一条记录（时间轴 / 搜索跳转要拿它所属的轮与分组） */
function locateByIndex(
  turns: ReturnType<typeof buildTrajectory>,
  index: number,
): { turnKey: string; groupLabel: string; record: TrajectoryRecord } | null {
  for (const turn of turns) {
    for (const group of turn.groups) {
      for (const record of group.records) {
        if (record.index === index) {
          return { turnKey: turn.key, groupLabel: groupTitle(group.title), record }
        }
      }
    }
  }
  return null
}

/** 按稳定 key 定位记录（选中 / 待滚到目标的唯一口径） */
function locateByKey(
  turns: ReturnType<typeof buildTrajectory>,
  key: string,
): { turnKey: string; groupLabel: string; record: TrajectoryRecord } | null {
  for (const turn of turns) {
    for (const group of turn.groups) {
      for (const record of group.records) {
        if (record.key === key) {
          return { turnKey: turn.key, groupLabel: groupTitle(group.title), record }
        }
      }
    }
  }
  return null
}

export function TrajectoryView({
  sessionId,
  systemPrompt,
  messages,
  hasMoreOlder,
  onLoadOlder,
  onJumpToMessage,
  onClose,
}: TrajectoryViewProps) {
  const [collapsedTurns, setCollapsedTurns] = useState<ReadonlySet<string>>(
    () => new Set(),
  )
  const [hideToolRecords, setHideToolRecords] = useState(false)
  const [mode, setMode] = useState<TrajectoryTimelineMode>('sequence')
  const [range, setRange] = useState<{ start: number; end: number } | null>(null)
  /** 选中的记录 key（不是行号：向前回补历史后行号会重新编号） */
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [matchCursor, setMatchCursor] = useState(0)
  const [scrollTarget, setScrollTarget] = useState<{ key: string; nonce: number } | null>(
    null,
  )
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [inspectorWidth, setInspectorWidth] = useState(storedInspectorWidth)
  /** 拖拽时要拿最新的宽度（onUp 的闭包拿不到 setState 后的值） */
  const inspectorWidthRef = useRef(inspectorWidth)
  inspectorWidthRef.current = inspectorWidth
  const nonceRef = useRef(0)
  /** 视口内第一条记录（由表格上报，回补历史后用它把视口锚回原处） */
  const anchorKeyRef = useRef<string | null>(null)
  /** 「滚到尾部」请求序号：首次打开 / 切会话时 +1 */
  const [scrollToEndNonce, setScrollToEndNonce] = useState(0)

  // 切会话：视图状态全部回到默认（否则上一段会话的折叠/选区会像幽灵一样留着）
  useEffect(() => {
    setCollapsedTurns(new Set())
    setHideToolRecords(false)
    setMode('sequence')
    setRange(null)
    setSelectedKey(null)
    setQuery('')
    setScrollTarget(null)
    anchorKeyRef.current = null
    setScrollToEndNonce((nonce) => nonce + 1)
  }, [sessionId])

  // 请求事实的刷新指纹：一次请求完成时 assistant 占位消息的**长度与时间戳都不变**，
  // 只有 usage / streaming 会变 —— 而账本正是在那一刻写入的。
  const lastMessage = messages.length > 0 ? messages[messages.length - 1] : undefined
  const usageRevision = `${messages.length}:${lastMessage?.timestamp ?? 0}:${
    lastMessage?.usage?.totalTokens ?? 0
  }:${lastMessage?.streaming === true ? 1 : 0}`
  const usage = useSessionUsage(sessionId, usageRevision)

  const turns = useMemo(
    () => buildTrajectory({ messages, systemPrompt, usage: usage.facts }),
    [messages, systemPrompt, usage.facts],
  )
  const flat = useMemo(
    () => flattenTrajectory(turns, { collapsedTurns, hideToolRecords }),
    [turns, collapsedTurns, hideToolRecords],
  )
  const timelineModel = useMemo(() => buildTimeline(turns, mode), [turns, mode])
  const timelineAvailable = useMemo(() => hasTimelineTime(turns), [turns])
  const focusIndexes = useMemo(
    () => timelineFocusIndexes(timelineModel, range),
    [timelineModel, range],
  )
  const matchIndexes = useMemo(() => searchRecords(turns, query), [turns, query])
  const matchList = useMemo(
    () => (matchIndexes === null ? [] : [...matchIndexes].sort((a, b) => a - b)),
    [matchIndexes],
  )
  const windowStats = useMemo(() => summarizeTrajectory(turns), [turns])

  // 查询变化后命中游标归零（否则「下一个」会从上一次的旧位置继续）
  useEffect(() => {
    setMatchCursor(0)
  }, [query])

  const located = useMemo(
    () => (selectedKey === null ? null : locateByKey(turns, selectedKey)),
    [turns, selectedKey],
  )

  /** 滚动（并必要时展开轮次 / 取消隐藏工具行）到某条记录 */
  const focusRecord = useCallback(
    (key: string, options: { scroll?: boolean; select?: boolean } = {}) => {
      const { scroll = true, select = true } = options
      const found = locateByKey(turns, key)
      if (!found) return
      setCollapsedTurns((current) => {
        if (!current.has(found.turnKey)) return current
        const next = new Set(current)
        next.delete(found.turnKey)
        return next
      })
      if (found.record.kind === 'tool') setHideToolRecords(false)
      if (select) setSelectedKey(key)
      // 点击行本身不需要滚动（行就在眼前）；只有从概览跳过来才需要
      if (!scroll) return
      nonceRef.current += 1
      setScrollTarget({ key, nonce: nonceRef.current })
    },
    [turns],
  )

  const jumpToMatch = useCallback(
    (delta: number) => {
      if (matchList.length === 0) return
      const next = (matchCursor + delta + matchList.length) % matchList.length
      setMatchCursor(next)
      const found = locateByIndex(turns, matchList[next])
      if (!found) return
      // 搜索只负责「滚到哪里」：不弹检查器（否则每按一下都要关一次抽屉）
      focusRecord(found.record.key, { select: false })
    },
    [focusRecord, matchCursor, matchList, turns],
  )

  const allCollapsibleTurns = useMemo(
    () => turns.filter((turn) => turn.groups.length > 0).map((turn) => turn.key),
    [turns],
  )
  const allTurnsCollapsed =
    allCollapsibleTurns.length > 0 &&
    allCollapsibleTurns.every((key) => collapsedTurns.has(key))

  const toggleAllTurns = useCallback(() => {
    setCollapsedTurns(
      allTurnsCollapsed ? new Set() : new Set(allCollapsibleTurns),
    )
  }, [allTurnsCollapsed, allCollapsibleTurns])

  const toggleTurn = useCallback((turnKey: string) => {
    setCollapsedTurns((current) => {
      const next = new Set(current)
      if (next.has(turnKey)) next.delete(turnKey)
      else next.add(turnKey)
      return next
    })
  }, [])

  const loadOlder = useCallback(async () => {
    if (loadingOlder || !hasMoreOlder) return
    setLoadingOlder(true)
    // 先记住视口顶部那条记录：回补是**前插**，不锚定的话用户会莫名其妙被抬高几十行
    const anchor = anchorKeyRef.current
    try {
      await onLoadOlder()
    } finally {
      setLoadingOlder(false)
    }
    if (anchor) {
      nonceRef.current += 1
      setScrollTarget({ key: anchor, nonce: nonceRef.current })
    }
  }, [hasMoreOlder, loadingOlder, onLoadOlder])

  // Esc：先收检查器，再退出轨迹
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      const target = event.target as HTMLElement | null
      const typing =
        target !== null &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      if (typing && selectedKey !== null) {
        setSelectedKey(null)
        return
      }
      if (typing) return
      if (selectedKey !== null) setSelectedKey(null)
      else onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose, selectedKey])

  /** 拖拽检查器左边缘调宽（向右拖变宽，左侧才是内容区） */
  const startResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      const startX = event.clientX
      const startWidth = inspectorWidth
      const onMove = (moveEvent: MouseEvent) => {
        const next = Math.min(
          INSPECTOR_MAX_WIDTH,
          Math.max(INSPECTOR_MIN_WIDTH, startWidth + (startX - moveEvent.clientX)),
        )
        setInspectorWidth(next)
      }
      const onUp = () => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        // 只在松手时写一次：拖拽期间每帧写 localStorage 是同步 IO，会掉帧
        try {
          localStorage.setItem(
            INSPECTOR_STORAGE_KEY,
            String(Math.round(inspectorWidthRef.current)),
          )
        } catch {
          // 隐私模式下写不进去：宽度只在本次会话内有效
        }
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [],
  )

  return (
    <div className="trajectory-view">
      <TrajectoryToolbar
        allTurnsCollapsed={allTurnsCollapsed}
        onToggleAllTurns={toggleAllTurns}
        hideToolRecords={hideToolRecords}
        onToggleToolRecords={() => setHideToolRecords((value) => !value)}
        mode={mode}
        onModeChange={(next) => {
          setMode(next)
          // 两种模式的坐标系不同（序号 vs 毫秒），切模式必须丢掉旧选区
          setRange(null)
        }}
        timeDisabled={!timelineAvailable}
        query={query}
        onQueryChange={setQuery}
        matchCount={matchIndexes === null ? null : matchIndexes.size}
        onPrevMatch={() => jumpToMatch(-1)}
        onNextMatch={() => jumpToMatch(1)}
      />

      <TrajectoryStats
        // 切会话重置展开态（否则新会话一进来就是展开的，上一段的阅读位置也会带过来）
        key={sessionId}
        ledger={usage.ledger}
        window={windowStats}
        loading={usage.loading}
      />

      <TrajectoryTimeline
        model={timelineModel}
        mode={mode}
        range={range}
        selectedKey={selectedKey}
        onSelectRecord={focusRecord}
        onRangeChange={setRange}
      />

      <div className="trajectory-view__body">
        {turns.length === 0 ? (
          <div className="trajectory-view__empty">
            {t('这段会话还没有可显示的记录，先聊两句吧')}
          </div>
        ) : (
          <TrajectoryTable
            rows={flat.rows}
            recordRowIndexByKey={flat.recordRowIndexByKey}
            matchIndexes={matchIndexes}
            focusIndexes={focusIndexes}
            selectedKey={selectedKey}
            onSelect={(record) => focusRecord(record.key, { scroll: false })}
            onToggleTurn={toggleTurn}
            scrollTarget={scrollTarget}
            anchorKeyRef={anchorKeyRef}
            scrollToEndNonce={scrollToEndNonce}
            hasMoreOlder={hasMoreOlder}
            loadingOlder={loadingOlder}
            onLoadOlder={() => {
              void loadOlder()
            }}
          />
        )}

        <TrajectoryInspector
          record={located?.record ?? null}
          groupLabel={located?.groupLabel}
          width={inspectorWidth}
          onClose={() => setSelectedKey(null)}
          onResizeStart={startResize}
          onJumpToConversation={onJumpToMessage}
        />
      </div>
    </div>
  )
}
