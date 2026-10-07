/**
 * message-list 控制器 — 汇总状态 / 虚拟滚动 / 滚动行为 / 跳转行为。
 *
 * 组件（message-list.tsx）只负责渲染，全部副作用、事件监听、定时器都在这里，拆到三个子模块：
 * useVirtualList（虚拟滚动 + 派生数据）/ useScrollController（回补历史 / 贴底稳定 / 滚动监听）/
 * useJumpController（锚点定位 / 检索跳转高亮）。三者靠本文件创建的「共享 ref / state」协作。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Message } from '@/types'
import {
  chatState,
  getSessionRuntime,
  sessionStore,
  settingsState,
  updateSessionRuntime,
} from '@/ui/store'
import {
  cancelPausedRun,
  deleteSessionMessage,
  resumePausedRun,
  transferSummaryToNewSession,
} from '@/services/chat-service'
import { showToast } from '@/ui/components/shared/Toast'
import { t } from '@/ui/i18n'
import { isStreamingSession } from './helpers'
import { useVirtualList } from './use-virtual-list'
import { useScrollController } from './use-scroll-controller'
import { useJumpController } from './use-jump-controller'
import type { ChatMessageListProps } from './types'

export function useChatMessageList({
  messages,
  setMessages,
  setText,
  onQuote,
  jumpTarget,
}: ChatMessageListProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  /** 供「只注册一次」的回调读取最新的 messages */
  const messagesRef = useRef(messages)
  messagesRef.current = messages

  /** 待执行的锚点跳转目标 id（跳转控制器写入，滚动控制器消费） */
  const pendingJumpIdRef = useRef<string | null>(null)
  /** 切会话后需「先滚到底 + 布局稳定后再显示」 */
  const needInitialBottomRef = useRef(false)
  /** 切会话 / 首开的「贴底稳定」轮询定时器 */
  const settleTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  /** 「定位中」提示的延迟显示定时器 */
  const jumpLoadingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 高亮自动清除定时器 */
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** message.id → toolCalls 结果数组的缓存（引用稳定，保证 memo 命中） */
  const toolResultsCacheRef = useRef(new Map<string, (Message | undefined)[]>())
  /** 活跃锚点消息 id（滚动控制器更新；跳转控制器读/写） */
  const activeMsgIdRef = useRef<string | null>(null)

  /** 切会话 / 首开时容器先隐藏（opacity:0），布局稳定后再显示，避免中间态闪动 */
  const [hide, setHide] = useState(false)
  /** 检索跳转后临时高亮的目标消息 id（到时自动清除） */
  const [highlightMsgId, setHighlightMsgId] = useState<string | null>(null)
  const [activeUserMsgId, setActiveUserMsgId] = useState<string | null>(null)
  /** 工具组折叠态（行 key → 是否展开）。⚠️ 必须住在列表层：组行随虚拟化卸载，存在行内会「滚回来就复原」 */
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({})

  const sessionId = chatState.value.currentSessionId
  const hasMoreInDb = sessionId
    ? sessionStore.hasMoreMessages(sessionId)
    : false
  const currentRt = sessionId ? getSessionRuntime(sessionId) : null
  const isCurrentPaused = currentRt?.paused ?? false
  const error = chatState.value.error
  // 是否启用工具组折叠（= 设置项 hideToolCallThink）；关闭时行模型退化为「一条消息 = 一行」
  const groupTools = settingsState.value.hideToolCallThink

  const virtual = useVirtualList({
    messages,
    messagesRef,
    sessionId,
    hasMoreInDb,
    groupTools,
    containerRef,
    toolResultsCacheRef,
  })

  // 命中工具组 → 自动展开（不自动收起，留给用户折）：检索 / 引用跳转会命中工具宿主
  // assistant，经 resolveJumpAnchorId 后置入 highlightMsgId；若它落在折叠组里，
  // 不展开就只看到一行折叠头、看不到内容。
  useEffect(() => {
    if (!highlightMsgId) return
    const row = virtual.rows.find(
      (r) =>
        r.kind === 'tools' &&
        r.messageIndexes.some((i) => messages[i]?.id === highlightMsgId),
    )
    if (!row) return
    const key = row.key
    setOpenGroups((prev) => (prev[key] ? prev : { ...prev, [key]: true }))
  }, [highlightMsgId, virtual.rows, messages])

  // 切会话：清缓存 + 标记「需要贴底」
  // 必须在下方「消息变化 effect」之前运行，后者要读到最新的 needInitialBottomRef。
  useLayoutEffect(() => {
    if (!sessionId) return
    // 只有高度静止的会话才需先隐藏、等布局稳定后再显示（避免估算→实测高度跳变）；
    // 流式回复中高度一直在变，永远达不到稳定条件，照常隐藏会整片空白到流式暂停 —— 直接显示。
    setHide(!isStreamingSession(sessionId))
    needInitialBottomRef.current = true
    toolResultsCacheRef.current.clear()
    if (settleTimerRef.current) {
      clearInterval(settleTimerRef.current)
      settleTimerRef.current = null
    }
    // 清掉上一次检索跳转残留的命中高亮
    if (highlightTimerRef.current) {
      clearTimeout(highlightTimerRef.current)
      highlightTimerRef.current = null
    }
    setHighlightMsgId(null)
    // 清掉组折叠态（新会话的组 key 与旧会话无关）
    setOpenGroups({})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  const scroll = useScrollController({
    messages,
    messagesRef,
    sessionId,
    hasMoreInDb,
    setMessages,
    containerRef,
    rowsRef: virtual.rowsRef,
    rowIndexOfMessageRef: virtual.rowIndexOfMessageRef,
    pendingJumpIdRef,
    needInitialBottomRef,
    settleTimerRef,
    setHide,
    rowVirtualizer: virtual.rowVirtualizer,
    jumpTo: virtual.jumpTo,
    refreshEstimatedItemHeight: virtual.refreshEstimatedItemHeight,
    activeMsgIdRef,
    setActiveUserMsgId,
  })

  const jump = useJumpController({
    messages,
    messagesRef,
    sessionId,
    setMessages,
    setIsLoadingOlder: scroll.setIsLoadingOlder,
    pendingJumpIdRef,
    needInitialBottomRef,
    settleTimerRef,
    setHide,
    setHighlightMsgId,
    highlightTimerRef,
    jumpLoadingTimerRef,
    userMessages: virtual.userMessages,
    rowVirtualizer: virtual.rowVirtualizer,
    jumpTo: virtual.jumpTo,
    rowIndexOfMessageRef: virtual.rowIndexOfMessageRef,
    activeMsgIdRef,
    activeUserMsgId,
    setActiveUserMsgId,
    jumpTarget,
  })

  useEffect(() => {
    return () => {
      if (settleTimerRef.current) {
        clearInterval(settleTimerRef.current)
        settleTimerRef.current = null
      }
      if (jumpLoadingTimerRef.current) {
        clearTimeout(jumpLoadingTimerRef.current)
        jumpLoadingTimerRef.current = null
      }
      if (highlightTimerRef.current) {
        clearTimeout(highlightTimerRef.current)
        highlightTimerRef.current = null
      }
    }
  }, [])

  /** 从 store 同步某会话的消息到 UI（删除 / 恢复 / 取消后刷新） */
  const syncMessagesToUI = useCallback(
    (sid: string) => {
      if (sid !== chatState.value.currentSessionId) return
      const s = sessionStore.getSession(sid)
      if (s) setMessages([...s.messages])
    },
    [setMessages],
  )

  // MessageBubble 已 memo，这里用稳定的回调避免每次重渲染都改变 props 引用
  const handleEditBubble = useCallback((msg: string) => setText(msg), [setText])
  const handleQuoteBubble = useCallback(
    (quote: { messageId: string; role: 'user' | 'assistant'; text: string }) =>
      onQuote?.(quote),
    [onQuote],
  )
  const handleDeleteBubble = useCallback(
    (messageId: string) => {
      const sid = chatState.value.currentSessionId
      if (!sid) return
      deleteSessionMessage(sid, messageId)
      syncMessagesToUI(sid)
    },
    [syncMessagesToUI],
  )

  /**
   * 右键摘要 →「转移到新对话」：以源会话为模板新建会话、把摘要作为其首条消息，
   * 然后切换过去。
   *
   * 这里只 `setValue('currentSessionId', newId)`：切会话的「装载消息 / 拉索引」由该值的
   * 变化兜底（chat-view 的会话切换 effect 会接管），因此无需在本层重写切换逻辑。
   * 回调刻意保持稳定引用（MessageBubble 已 memo，引用一变全部气泡重渲染）。
   */
  const handleTransferSummary = useCallback(async (messageId: string) => {
    const sid = chatState.value.currentSessionId
    if (!sid) return
    const newId = await transferSummaryToNewSession(sid, messageId)
    if (!newId) {
      showToast(t('转移失败：找不到该摘要'))
      return
    }
    chatState.setValue('currentSessionId', newId)
    chatState.setValue('error', null)
    showToast(t('已转移到新对话'))
  }, [])

  function handleResume() {
    const sid = chatState.value.currentSessionId
    if (!sid) return
    resumePausedRun(sid, {
      onWorkingChange: (_sid, working) => {
        chatState.setValue('loading', working)
      },
      onMessagesUpdate: (sid) => {
        syncMessagesToUI(sid)
      },
      onError: (sid, error) => {
        updateSessionRuntime(sid, { error })
        if (sid === chatState.value.currentSessionId) {
          chatState.setValue('error', error)
        }
      },
    })
  }

  function handleCancelPaused() {
    const sid = chatState.value.currentSessionId
    if (!sid) return
    cancelPausedRun(sid)
    const rt = getSessionRuntime(sid)
    rt.paused = false
    rt.working = false
    chatState.setValue('loading', false)
    syncMessagesToUI(sid)
  }

  const closeError = useCallback(() => {
    const sid = chatState.value.currentSessionId
    if (sid) updateSessionRuntime(sid, { error: null })
    chatState.setValue('error', null)
  }, [])

  /** 切换某个工具组的折叠态（按行 key 记账） */
  const toggleGroup = useCallback((key: string) => {
    setOpenGroups((prev) => ({ ...prev, [key]: !prev[key] }))
  }, [])

  return {
    // 容器 / 渲染控制
    containerRef,
    hide,
    highlightMsgId,
    error,
    closeError,
    // 会话
    sessionId,
    hasMoreInDb,
    isCurrentPaused,
    // 虚拟滚动
    rowVirtualizer: virtual.rowVirtualizer,
    virtualItems: virtual.virtualItems,
    rows: virtual.rows,
    openGroups,
    toggleGroup,
    toolResultsFor: virtual.toolResultsFor,
    anchorUsers: virtual.anchorUsers,
    // 滚动
    loadOlder: scroll.loadOlder,
    isLoadingOlder: scroll.isLoadingOlder,
    showScrollToBottomBtn: scroll.showScrollToBottomBtn,
    handleScrollToBottom: scroll.handleScrollToBottom,
    // 跳转 / 锚点
    activeUserMsgId,
    jumpLoadingId: jump.jumpLoadingId,
    scrollToMessage: jump.scrollToMessage,
    // 气泡 / 暂停条
    handleEditBubble,
    handleQuoteBubble,
    handleDeleteBubble,
    handleTransferSummary,
    handleResume,
    handleCancelPaused,
  }
}
