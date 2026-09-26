/**
 * message-list 控制器 — 汇总状态 / 虚拟滚动 / 滚动行为 / 跳转行为
 *
 * 组件（message-list.tsx）只负责渲染；全部副作用、事件监听、定时器都在这里，
 * 并拆到三个子模块：
 *   - useVirtualList       虚拟滚动核心 + 派生数据
 *   - useScrollController  回补历史 / 贴底稳定 / 滚动监听
 *   - useJumpController    锚点定位 / 检索跳转高亮
 *
 * 三者通过本文件里创建的「共享 ref / state」协作，子模块自身不含跨模块私有状态。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Message } from '@/types'
import {
  chatState,
  getSessionRuntime,
  sessionStore,
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
  // ==================== 共享 ref / state ====================
  const containerRef = useRef<HTMLDivElement>(null)
  /** 供「只注册一次」的回调读取最新的 messages */
  const messagesRef = useRef(messages)
  messagesRef.current = messages

  /** 待执行的「锚点跳转」目标消息 id（滚动控制器消费，跳转控制器写入） */
  const pendingJumpIdRef = useRef<string | null>(null)
  /** 切会话后需要「先滚到底部 + 布局稳定后再显示」 */
  const needInitialBottomRef = useRef(false)
  /** 切会话/首开的「贴底稳定」轮询定时器 */
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

  // ==================== 会话派生 ====================
  const sessionId = chatState.value.currentSessionId
  const hasMoreInDb = sessionId
    ? sessionStore.hasMoreMessages(sessionId)
    : false
  const currentRt = sessionId ? getSessionRuntime(sessionId) : null
  const isCurrentPaused = currentRt?.paused ?? false
  const error = chatState.value.error

  // ==================== 虚拟滚动核心 ====================
  const virtual = useVirtualList({
    messages,
    messagesRef,
    sessionId,
    hasMoreInDb,
    containerRef,
    toolResultsCacheRef,
  })

  // ==================== 切会话：清缓存 + 标记「需要贴底」 ====================
  // 声明在滚动控制器之前：必须在「消息变化 effect」之前运行，
  // 以便后者读到最新的 needInitialBottomRef。
  useLayoutEffect(() => {
    if (!sessionId) return
    // 只有「高度静止」的会话才需要先隐藏、等布局稳定后再显示（避免估算高度→实测
    // 高度跳变）。正在流式回复的会话高度一直在变，永远达不到稳定条件，若照常隐藏
    // 会整片空白直到流式暂停（工具调用/结束）——此时直接显示，靠贴底跟随。
    setHide(!isStreamingSession(sessionId))
    needInitialBottomRef.current = true
    toolResultsCacheRef.current.clear()
    if (settleTimerRef.current) {
      clearInterval(settleTimerRef.current)
      settleTimerRef.current = null
    }
    // 切会话：清掉上一次检索跳转残留的命中高亮
    if (highlightTimerRef.current) {
      clearTimeout(highlightTimerRef.current)
      highlightTimerRef.current = null
    }
    setHighlightMsgId(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // ==================== 滚动行为 ====================
  const scroll = useScrollController({
    messages,
    messagesRef,
    sessionId,
    hasMoreInDb,
    setMessages,
    containerRef,
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

  // ==================== 跳转 / 锚点 ====================
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
    activeMsgIdRef,
    activeUserMsgId,
    setActiveUserMsgId,
    jumpTarget,
  })

  // ==================== 卸载时清理定时器 ====================
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

  // ==================== 消息气泡 / 暂停条回调 ====================
  /** 从 store 同步某会话的消息到 UI（用于删除消息 / 恢复 / 取消后的刷新） */
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
