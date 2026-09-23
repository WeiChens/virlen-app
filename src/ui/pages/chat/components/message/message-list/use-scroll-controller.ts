/**
 * message-list「滚动行为」控制器
 *
 * 负责：回补更早历史（loadOlder）、切会话后的「贴底稳定」、滚动到底部按钮、
 * 内容不足一屏自动补足、滚动事件监听（活跃锚点 / 预取更早）。
 *
 * 与「跳转控制器」共享若干 ref / state（由 message-list 控制器创建后注入），
 * 因此这里的回调仍保持原有的依赖数组，只是把定义位置搬了出来。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import type { Message } from '@/types'
import { chatState, sessionStore } from '@/ui/store'
import commentEvent from '@/events/commentEvent'
import { isStreamingSession } from './helpers'
import {
  AT_BOTTOM_THRESHOLD,
  MAX_SETTLE_POLLS,
  SCROLL_TOP_THRESHOLD,
} from './constants'

interface Params {
  messages: Message[]
  messagesRef: { current: Message[] }
  sessionId: string | null
  hasMoreInDb: boolean
  setMessages: (msgs: Message[]) => void
  containerRef: { current: HTMLDivElement | null }
  /** 待执行的锚点跳转目标（由跳转控制器写入，这里提交后消费） */
  pendingJumpIdRef: { current: string | null }
  /** 切会话后需要「先滚到底部 + 布局稳定后再显示」 */
  needInitialBottomRef: { current: boolean }
  /** 切会话/首开的「贴底稳定」轮询定时器 */
  settleTimerRef: { current: ReturnType<typeof setInterval> | null }
  setHide: (v: boolean) => void
  rowVirtualizer: Virtualizer<HTMLDivElement, Element>
  jumpTo: (idx: number) => void
  refreshEstimatedItemHeight: () => void
  /** 活跃锚点消息 id（滚动事件更新；跳转控制器也会读/写） */
  activeMsgIdRef: { current: string | null }
  setActiveUserMsgId: (id: string | null) => void
}

export function useScrollController({
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
  rowVirtualizer,
  jumpTo,
  refreshEstimatedItemHeight,
  activeMsgIdRef,
  setActiveUserMsgId,
}: Params) {
  const [showScrollToBottomBtn, setShowScrollToBottomBtn] = useState(false)
  const [isLoadingOlder, setIsLoadingOlder] = useState(false)
  const lastScrollTopRef = useRef(0)
  const showScrollBtnRef = useRef(false)
  /** 正在从 SQLite 回补更早消息（防重入） */
  const loadingOlderRef = useRef(false)
  /** 上一次的条目数（用于判断「条目数变化」而非流式内容更新） */
  const lastMsgCountRef = useRef(0)

  // ==================== 回补更早历史（前插） ====================
  const loadOlder = useCallback(async () => {
    const sid = chatState.value.currentSessionId
    if (!sid || loadingOlderRef.current) return
    if (!sessionStore.hasMoreMessages(sid)) return
    loadingOlderRef.current = true
    setIsLoadingOlder(true)
    try {
      const ok = await sessionStore.loadOlderMessages(sid)
      if (ok && sid === chatState.value.currentSessionId) {
        const s = sessionStore.getSession(sid)
        if (s) setMessages([...s.messages])
      }
    } finally {
      loadingOlderRef.current = false
      setIsLoadingOlder(false)
    }
  }, [setMessages])

  /**
   * 滚到底部并等待布局稳定后显示。
   * markdown / canvas / 图片在首帧后仍可能异步改变高度（虚拟列表还会经历
   * 估算→实测），若立即显示会看到跳动。这里每 50ms 轮询 scrollHeight：
   *   - 高度还在变 → 继续计数
   *   - 连续 3 次（~150ms）无变化 → 视为稳定，滚到底部后 setHide(false) 显示
   *   - 目标会话正在流式回复 → 高度不可能稳定，直接显示（否则会一直空白）
   *   - 轮询超过 MAX_SETTLE_POLLS → 兜底显示，绝不无限隐藏
   */
  const settleToBottom = useCallback(() => {
    const el = containerRef.current
    if (!el) return

    if (settleTimerRef.current) clearInterval(settleTimerRef.current)
    settleTimerRef.current = null
    const scrollToEnd = () => {
      const count = messagesRef.current.length
      if (count > 0) rowVirtualizer.scrollToIndex(count - 1, { align: 'end' })
    }
    scrollToEnd()

    // 流式回复中：高度随 token 持续变化，「稳定」条件永远不成立 → 直接显示
    const sid = chatState.value.currentSessionId
    if (sid && isStreamingSession(sid)) {
      setHide(false)
      return
    }

    let lastH = el.scrollHeight
    let stableCount = 0
    let polls = 0

    settleTimerRef.current = setInterval(() => {
      const cur = containerRef.current
      if (!cur) {
        if (settleTimerRef.current) clearInterval(settleTimerRef.current)
        settleTimerRef.current = null
        return
      }
      // 兜底：异步高度变化（图片/markdown/字体）可能长期不收敛，到点强制显示
      if (++polls >= MAX_SETTLE_POLLS) {
        if (settleTimerRef.current) clearInterval(settleTimerRef.current)
        settleTimerRef.current = null
        scrollToEnd()
        setHide(false)
        return
      }
      if (Math.abs(cur.scrollHeight - lastH) > 1) {
        lastH = cur.scrollHeight
        stableCount = 0
      } else {
        stableCount++
        if (stableCount >= 3) {
          if (settleTimerRef.current) clearInterval(settleTimerRef.current)
          settleTimerRef.current = null
          scrollToEnd()
          setHide(false)
        }
      }
    }, 50)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowVirtualizer])

  // ==================== 消息变化：贴底 / 稳定显示 ====================
  useLayoutEffect(() => {
    const count = messages.length
    if (count === 0) return
    // 条目数变化（新消息 / 回补历史）→ 刷新估算高度，供新条目的测量使用
    if (count !== lastMsgCountRef.current) {
      lastMsgCountRef.current = count
      refreshEstimatedItemHeight()
    }
    // 优先消费「待跳转」目标：此时 messages 已提交，count 为最新值
    const pendingJumpId = pendingJumpIdRef.current
    if (pendingJumpId) {
      pendingJumpIdRef.current = null
      const idx = messagesRef.current.findIndex((m) => m.id === pendingJumpId)
      if (idx >= 0) {
        jumpTo(idx)
        return
      }
    }
    if (needInitialBottomRef.current) {
      // 切会话 / 首次打开：容器隐藏，等布局稳定后滚到底部再显示
      needInitialBottomRef.current = false
      settleToBottom()
      return
    }
    const last = messages[count - 1]
    if (last?.role === 'user') {
      // 用户刚发送消息 → 立即滚动到底部
      setHide(false)
      rowVirtualizer.scrollToIndex(count - 1, {
        align: 'end',
        behavior: 'smooth',
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages])

  // ==================== 滚动事件：加载更早 + 活跃锚点 + 到底部按钮 ====================
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    /** 滚动停止后强制重新测量已渲染条目（修正平滑滚动/流式增长期间的高度漂移） */
    let remeasureTimer: ReturnType<typeof setTimeout> | null = null
    function remeasureRenderedItems() {
      const root = containerRef.current
      if (!root) return
      root
        .querySelectorAll<HTMLElement>('.message-item-wrap')
        .forEach((node) => rowVirtualizer.measureElement(node))
      // 测量结果刚更新，顺便刷新「未测量条目」的估算高度，供后续挂载使用
      refreshEstimatedItemHeight()
    }

    /**
     * 计算当前活跃的用户消息锚点。
     *
     * 虚拟滚动下只有视口附近的条目被渲染：若仍遍历 DOM，视口内没有任何 user 消息时
     * 会找不到元素，高亮就会消失。这里改用「滚动偏移 → 消息实测起始位置」的几何计算，
     * 与 DOM 是否渲染无关。
     */
    function updateActiveDot() {
      const el = containerRef.current
      if (!el) return
      const list = messagesRef.current
      if (list.length === 0) return
      // measurements[i].start 即第 i 条消息在内容坐标系中的顶部，与渲染无关
      const measurements = rowVirtualizer.measurementsCache
      const probe = el.scrollTop + 80 // 视口顶部偏下 80px
      let closestId: string | null = null
      let closestDist = Infinity
      for (let i = 0; i < list.length; i++) {
        if (list[i].role !== 'user') continue
        const start = measurements[i]?.start
        if (start === undefined) continue
        const dist = Math.abs(start - probe)
        if (dist < closestDist) {
          closestDist = dist
          closestId = list[i].id
        } else if (start > probe) {
          // 起始偏移随索引单调递增：已越过探针且不再更近，后续只会更远
          break
        }
      }
      if (closestId !== activeMsgIdRef.current) {
        activeMsgIdRef.current = closestId
        setActiveUserMsgId(closestId)
      }
    }

    function onScroll() {
      // container 是上层 const 的窄化结果；函数声明会被提升，TS 不再保留窄化，故显式断言
      const { scrollTop, scrollHeight, clientHeight } = container!
      const distFromBottom = scrollHeight - clientHeight - scrollTop

      updateActiveDot()

      // ---- 滚动到底部按钮显隐（距底部 > 80% 视口高度时显示）----
      const btnShouldShow = distFromBottom > clientHeight * 0.8
      if (btnShouldShow !== showScrollBtnRef.current) {
        showScrollBtnRef.current = btnShouldShow
        setShowScrollToBottomBtn(btnShouldShow)
      }
      lastScrollTopRef.current = scrollTop

      // ---- 向上滚动 → 预取更早历史 ----
      const sid = chatState.value.currentSessionId
      if (
        scrollTop < SCROLL_TOP_THRESHOLD &&
        sid &&
        sessionStore.hasMoreMessages(sid)
      ) {
        void loadOlder()
      }

      // 滚动停止后重新测量：平滑跳转时虚拟库会跳过「途经」条目的测量，
      // 它们会按估算高度摆放而与相邻条目重叠；静止后统一校正一次。
      if (remeasureTimer) clearTimeout(remeasureTimer)
      remeasureTimer = setTimeout(remeasureRenderedItems, 180)
    }

    container.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      container.removeEventListener('scroll', onScroll)
      if (remeasureTimer) clearTimeout(remeasureTimer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ==================== 内容不足一屏时自动补足（避免无滚动条卡住） ====================
  useLayoutEffect(() => {
    if (!hasMoreInDb || loadingOlderRef.current) return
    const el = containerRef.current
    if (!el) return
    if (rowVirtualizer.getTotalSize() <= el.clientHeight) {
      void loadOlder()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length, hasMoreInDb])

  // ==================== 贴底状态变化：请求滚到底部事件 ====================
  useEffect(() => {
    const uninstall = commentEvent.on('requestScrollToBottom', () => {
      if (rowVirtualizer.isAtEnd(AT_BOTTOM_THRESHOLD)) {
        rowVirtualizer.scrollToEnd({ behavior: 'instant' })
      }
    })
    return () => void uninstall()
  }, [rowVirtualizer])

  // 滚动到底部按钮点击
  const handleScrollToBottom = useCallback(() => {
    const count = messagesRef.current.length
    if (count === 0) return
    // 流式回复中底部高度每个 token 都在增长：虚拟库会每帧重算目标偏移，
    // 距离超过一屏时反复以 smooth 重发 scrollTo 会不断重启平滑动画（抽搐）。
    // 目标在移动时只能用瞬时滚动；落到底部后由贴底跟随（anchorTo: 'end'）接管。
    const sid = chatState.value.currentSessionId
    rowVirtualizer.scrollToIndex(count - 1, {
      align: 'end',
      behavior: sid && isStreamingSession(sid) ? 'auto' : 'smooth',
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowVirtualizer])

  return {
    loadOlder,
    showScrollToBottomBtn,
    isLoadingOlder,
    /** 跳转控制器在「按需回补历史」时也会切换该 loading */
    setIsLoadingOlder,
    handleScrollToBottom,
  }
}
