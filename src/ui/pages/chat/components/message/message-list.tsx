/**
 * chat-message-list — 聊天消息列表组件
 *
 * 从 chat-view 分离，管理消息列表的渲染、滚动行为、暂停/错误提示。
 * 支持分页渲染（默认只显示最后 PAGE_SIZE 条），向上滚动自动加载更多。
 * 数据从 store 同步，通过回调与父组件通信。
 */
import {
  useEffect,
  useRef,
  useCallback,
  useState,
  useLayoutEffect,
} from 'react'
import type { Message } from '@/types'
import { chatState, sessionStore, getSessionRuntime } from '@/ui/store'
import {
  cancelPausedRun,
  resumePausedRun,
  deleteSessionMessage,
} from '@/services/chat-service'
import MessageBubble from './message-bubble'
import DropDownSvg from '@/ui/components/icons/DropDownSvg'
import Tooltip from '@/ui/components/shared/Tooltip'
import './message-list.scss'
import commentEvent from '@/events/commentEvent'
import { observer } from 'mobx-react-lite'

// ==================== 分页常量 ====================
const PAGE_SIZE = 35
const LOAD_MORE_STEP = PAGE_SIZE
const SCROLL_TOP_THRESHOLD = 200 // 距顶部多少 px 时触发加载更多

interface ChatMessageListProps {
  /** 当前所有消息 */
  messages: Message[]
  /** 更新消息（触发组件重渲染） */
  setMessages: (msgs: Message[]) => void
  /** 输入框设置文本回调 */
  setText: (text: string) => void
}

function ChatMessageList({
  messages,
  setMessages,
  setText,
}: ChatMessageListProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  // 用户主动滚动拦截标记
  const userScrollBlockUntilRef = useRef(0)
  const lastScrollTopRef = useRef(0)
  // 滚动到底部按钮的显隐
  const [showScrollToBottomBtn, setShowScrollToBottomBtn] = useState(false)
  const showScrollBtnRef = useRef(false)

  // ==================== 分页状态 ====================
  const [displayStart, setDisplayStart] = useState(() =>
    Math.max(0, messages.length - PAGE_SIZE),
  )
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const loadingMoreRef = useRef(false)
  // 加载更多时刻的快照：scrollTop 和 scrollHeight
  const loadMoreSnapshotRef = useRef({ scrollTop: 0, scrollHeight: 0 })
  const prevMessagesLenRef = useRef(messages.length)
  const displayStartRef = useRef(displayStart)
  displayStartRef.current = displayStart

  // 计算当前展示的消息
  const displayedMessages = messages.slice(displayStart)
  const hasMore = displayStart > 0

  // 当前会话运行时状态
  const sessionId = chatState.value.currentSessionId
  const currentRt = sessionId ? getSessionRuntime(sessionId) : null
  // const isCurrentWorking = currentRt?.working ?? false
  const isCurrentPaused = currentRt?.paused ?? false
  const bottomNear = useRef(false)

  // ==================== 重置分页（会话切换时） ====================
  useEffect(() => {
    const prevLen = prevMessagesLenRef.current
    const currLen = messages.length
    prevMessagesLenRef.current = currLen
    if (Math.abs(currLen - prevLen) > 1 || prevLen === 0) {
      displayStartRef.current = Math.max(0, currLen - PAGE_SIZE)
      setDisplayStart(displayStartRef.current)
      loadingMoreRef.current = false

      setIsLoadingMore(false)
      loadMoreSnapshotRef.current = { scrollTop: 0, scrollHeight: 0 }
      // 切换会话 → 清空滚动拦截，确保能滚动到底部
      // userScrollBlockUntilRef.current = 0
    }
    if (messages.length > 0 && messages[messages.length - 1].role === 'user') {
      userScrollBlockUntilRef.current = 0
    }
  }, [messages.length, sessionId])

  // ==================== ResizeObserver：加载更多后持续修正 scrollTop（防闪动） ====================
  // 即使 markdown / 代码块懒渲染导致高度逐步变化，也能将视口稳定在用户原本看的位置。
  // 注意：只负责滚动修正，不管理 loadingMoreRef 的复位（由下方 useEffect 单独处理）。
  useEffect(() => {
    const container = messagesContainerRef.current
    if (!container) {
      return
    }

    const observer = new ResizeObserver(() => {
      if (!loadingMoreRef.current) return

      const snapshot = loadMoreSnapshotRef.current
      if (snapshot.scrollHeight === 0) return

      const addedHeight = container.scrollHeight - snapshot.scrollHeight
      // 目标 scrollTop = 加载时的 scrollTop + 顶部总增加高度
      const targetScrollTop = snapshot.scrollTop + addedHeight
      const currentScrollTop = container.scrollTop

      // 如果用户主动滚走了（与目标值差距 > 200px），停止干预
      if (Math.abs(currentScrollTop - targetScrollTop) > 200) {
        loadingMoreRef.current = false
        setIsLoadingMore(false)
        return
      }

      if (Math.abs(currentScrollTop - targetScrollTop) > 1) {
        container.scrollTop = targetScrollTop
      }
    })

    observer.observe(container)
    return () => {
      observer.disconnect()
    }
  }, [])

  // ==================== 加载更多超时复位 ====================
  // displayStart 变化（加载更多触发）后，固定等待 1 秒，无论期间是否有懒渲染，
  // 到期后复位 loadingMoreRef，让用户能再次触发加载更多。
  useEffect(() => {
    if (!loadingMoreRef.current) return

    const timer = setTimeout(() => {
      loadingMoreRef.current = false
      setIsLoadingMore(false)
      loadMoreSnapshotRef.current = { scrollTop: 0, scrollHeight: 0 }
    }, 300)

    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayStart])

  // ==================== 滚动到底部（消息变化时） ====================
  // 用户发消息 → 无视拦截强制滚动；AI 回复 → 尊重拦截状态
  useEffect(() => {
    userScrollBlockUntilRef.current = 0
  }, [sessionId])
  const [hide, setHide] = useState(false)
  useLayoutEffect(() => {
    if (!sessionId) return
    setHide(true)
  }, [sessionId])
  useEffect(() => {
    const displayedMessages = messages.slice(displayStartRef.current)
    if (displayedMessages.length == 0) {
      return
    }
    const lastMsg = displayedMessages[displayedMessages.length - 1]
    if (lastMsg.role === 'user') {
      // 用户刚发送消息 → 清除拦截、恢复显示、立即滚动到底部
      userScrollBlockUntilRef.current = 0
      setHide(false)
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    } else if (
      (Date.now() >= userScrollBlockUntilRef.current && bottomNear.current) ||
      userScrollBlockUntilRef.current == 0
    ) {
      if (messagesContainerRef.current == null) {
        console.warn('messagesContainerRef.current is null')
        return
      }
      const { scrollHeight, clientHeight, scroll } =
        messagesContainerRef.current
      if (scrollHeight == clientHeight) {
        requestAnimationFrame(() => {
          messagesContainerRef.current.scroll({
            top: 3000000,
            behavior: 'instant',
          })
          requestAnimationFrame(() => setHide(false))
        })
      } else {
        messagesContainerRef.current.scroll({
          top: scrollHeight,
          behavior: 'instant',
        })
        setHide(false)
      }
    }
    // 只依赖 messages 引用变化，加载更多时不触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages])

  useEffect(() => {
    const uninstall = commentEvent.on('requestScrollToBottom', () => {
      if (bottomNear.current)
        messagesContainerRef.current?.scroll({
          top: messagesContainerRef.current?.scrollHeight,
          behavior: 'instant',
        })
    })
    return () => void uninstall()
  }, [])
  // ==================== 滚动事件：拦截 + 加载更多 + 活跃锚点 ====================
  const [activeUserMsgId, setActiveUserMsgId] = useState<string | null>(null)
  const activeMsgIdRef = useRef<string | null>(null)
  useEffect(() => {
    const container = messagesContainerRef.current
    if (!container) return

    function updateActiveDot() {
      const userMsgEls = container.querySelectorAll<HTMLElement>(
        '.message-item-wrap[data-msg-id]',
      )
      const scrollTop = container.scrollTop
      let closestId: string | null = null
      let closestDist = Infinity
      // 寻找最接近视口顶部（偏下 80px）的用户消息
      userMsgEls.forEach((el) => {
        const dist = Math.abs(el.offsetTop - scrollTop - 80)
        if (dist < closestDist) {
          closestDist = dist
          closestId = el.dataset.msgId || null
        }
      })
      if (closestId !== activeMsgIdRef.current) {
        activeMsgIdRef.current = closestId
        setActiveUserMsgId(closestId)
      }
    }

    function onScroll() {
      const { scrollTop, scrollHeight, clientHeight } = container
      const distFromBottom = scrollHeight - clientHeight - scrollTop
      const isScrollingDown = scrollTop > lastScrollTopRef.current

      // ---- 更新活跃锚点 ----
      updateActiveDot()

      // ---- 自动滚动拦截 ----
      // 用户往上滚动 → 屏蔽 3000ms
      if (scrollTop < lastScrollTopRef.current) {
        userScrollBlockUntilRef.current = Date.now() + 3000
      }
      // 距离底部超过一个视口高度 → 永久屏蔽
      if (distFromBottom > clientHeight) {
        userScrollBlockUntilRef.current = Infinity
      }

      // ---- 滚动到底部按钮显隐（距底部 > 80% 视口高度时显示）----
      const btnShouldShow = distFromBottom > clientHeight * 0.8
      if (btnShouldShow !== showScrollBtnRef.current) {
        showScrollBtnRef.current = btnShouldShow
        setShowScrollToBottomBtn(btnShouldShow)
      }
      bottomNear.current = distFromBottom <= clientHeight * 0.3
      // ---- 向下滚动到底部附近 → 吸附到底部 ----
      if (
        isScrollingDown &&
        bottomNear.current &&
        userScrollBlockUntilRef.current !== 0 &&
        currentRt.working
      ) {
        userScrollBlockUntilRef.current = 1
        messagesEndRef.current?.scrollIntoView({ behavior: 'instant' })
      }

      lastScrollTopRef.current = scrollTop

      // ---- 向上滚动加载更多 ----
      if (
        scrollTop < SCROLL_TOP_THRESHOLD &&
        displayStartRef.current > 0 &&
        !loadingMoreRef.current
      ) {
        loadMoreHandle()
      }
    }

    container.addEventListener('scroll', onScroll, { passive: true })
    return () => container.removeEventListener('scroll', onScroll)
  }, [])
  function loadMoreHandle() {
    loadingMoreRef.current = true
    setIsLoadingMore(true)
    const { scrollTop, scrollHeight } = messagesContainerRef.current
    loadMoreSnapshotRef.current = { scrollTop, scrollHeight }
    setDisplayStart((prev) => Math.max(0, prev - LOAD_MORE_STEP))
  }

  // ==================== 锚点点击：自动加载未分页的消息并跳转 ====================
  const pendingScrollRef = useRef<string | null>(null)

  const scrollToMessage = useCallback((msgId: string) => {
    const tryScroll = () => {
      const el = document.querySelector(`[data-msg-id="${msgId}"]`)
      if (el) {
        pendingScrollRef.current = null
        el.scrollIntoView({ behavior: 'smooth', block: 'start' })
        return
      }
      if (displayStartRef.current > 0) {
        loadMoreHandle()
        // 等待 React 渲染新加载的消息后重试
        setTimeout(tryScroll, 70)
      }
    }
    pendingScrollRef.current = msgId
    tryScroll()
  }, [])

  // 锚点列表滚动到底部 + active 指向最后一条用户消息
  const prevSessionRef = useRef<string | null>(null)
  useEffect(() => {
    const userMessages = messages.filter((m) => m.role === 'user')
    if (userMessages.length === 0) return
    const lastUserMsg = userMessages[userMessages.length - 1]

    const isNewSession = prevSessionRef.current !== sessionId
    prevSessionRef.current = sessionId

    // 切换会话 或 用户正在底部 → 跟随最新用户消息
    if (isNewSession || bottomNear.current) {
      activeMsgIdRef.current = lastUserMsg.id
      setActiveUserMsgId(lastUserMsg.id)
      requestAnimationFrame(() => {
        const anchorList = document.querySelector('.msg-anchor-list')
        if (anchorList) anchorList.scrollTop = anchorList.scrollHeight
      })
    }
  }, [messages, sessionId])

  // activeUserMsgId 变化时，如果对应点不在锚点列表可视区，自动滚过去
  useEffect(() => {
    if (!activeUserMsgId) return
    const anchorList = document.querySelector('.msg-anchor-list')
    if (!anchorList) return
    const activeDot = anchorList.querySelector(
      '.msg-anchor-dot.active',
    ) as HTMLElement | null
    if (!activeDot) return

    const listRect = anchorList.getBoundingClientRect()
    const dotRect = activeDot.getBoundingClientRect()
    if (dotRect.top < listRect.top || dotRect.bottom > listRect.bottom) {
      activeDot.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
  }, [activeUserMsgId])

  // ==================== 从 store 同步消息到 UI ====================
  const syncMessagesToUI = useCallback(
    (sessionId: string) => {
      if (sessionId !== chatState.value.currentSessionId) return
      const s = sessionStore.getSession(sessionId)
      if (s) setMessages([...s.messages])
    },
    [setMessages],
  )

  // 滚动到底部按钮点击
  const handleScrollToBottom = useCallback(() => {
    userScrollBlockUntilRef.current = 0
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
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

  return (
    <>
      {/* 错误提示 */}
      {chatState.value.error && (
        <div className="error-banner">
          <span>{chatState.value.error}</span>
          <button onClick={() => chatState.setValue('error', null)}>✕</button>
        </div>
      )}

      {/* 消息列表 */}
      <div
        className="chat-messages-container"
        style={{
          opacity: hide ? 0 : 1,
        }}
        ref={messagesContainerRef}>
        {displayedMessages.length === 0 && (
          <div style={{ marginTop: 'auto' }} />
        )}

        {/* 加载更多提示 */}
        {hasMore && (
          <div
            className="load-more-hint"
            onClick={() => {
              if (!isLoadingMore) {
                loadMoreHandle()
              }
            }}>
            {isLoadingMore ? '加载更多消息...' : '点击查看更多'}
          </div>
        )}

        {displayedMessages.map((msg) => (
          <div
            key={msg.id}
            className="message-item-wrap"
            data-msg-id={msg.role === 'user' ? msg.id : undefined}>
            <MessageBubble
              onEdit={(msg) => {
                setText(msg)
              }}
              onDelete={(messageId) => {
                const sessionId = chatState.value.currentSessionId
                if (!sessionId) return
                deleteSessionMessage(sessionId, messageId)
                syncMessagesToUI(sessionId)
              }}
              message={msg}
              allMessages={messages}
            />
          </div>
        ))}
        <div style={{ padding: '15px 0' }}></div>
        <div ref={messagesEndRef} />
      </div>

      {/* 用户消息锚点列表 — 全部消息，最多展示 12 个，超出可滚动 */}
      {messages.filter((m) => m.role === 'user').length > 1 && (
        <div className="msg-anchor-list">
          {messages
            .filter((m) => m.role === 'user')
            .map((msg) => {
              const msgText =
                typeof msg.content === 'string'
                  ? msg.content
                  : msg.content
                      .filter((b) => b.type === 'text')
                      .map((b) => ('text' in b ? b.text : ''))
                      .join('')
              return (
                <Tooltip
                  key={msg.id}
                  content={msgText.slice(0, 420) || ''}
                  direction="left">
                  <button
                    className={`msg-anchor-dot${activeUserMsgId === msg.id ? ' active' : ''}`}
                    onClick={() => scrollToMessage(msg.id)}
                    type="button"
                    aria-label="跳转到该消息"
                  />
                </Tooltip>
              )
            })}
        </div>
      )}

      {/* 滚动到底部按钮 */}
      {showScrollToBottomBtn && (
        <button className="scroll-to-bottom-btn" onClick={handleScrollToBottom}>
          <DropDownSvg />
        </button>
      )}

      {/* 工具调用暂停提示 */}
      {isCurrentPaused && (
        <div className="paused-run-banner">
          <div className="paused-info">
            <span className="paused-icon">⏸️</span>
            <span className="paused-text">会话已暂停，是否继续？</span>
          </div>
          <button className="paused-resume-btn" onClick={handleResume}>
            继续
          </button>
          <button className="paused-cancel-btn" onClick={handleCancelPaused}>
            取消
          </button>
        </div>
      )}
    </>
  )
}

export default observer(ChatMessageList)
