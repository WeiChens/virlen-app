/**
 * message-list「跳转 / 锚点」控制器
 *
 * 负责：锚点点击定位（必要时按需回补历史）、检索跳转（Ctrl+P）滚动定位 + 临时高亮、
 * 锚点列表跟随最新用户消息、活跃圆点自动滚入可视区。
 *
 * `pendingJumpIdRef` / `needInitialBottomRef` / `settleTimerRef` 与滚动控制器共享，
 * 由 message-list 控制器创建后注入；回调依赖数组保持与原实现一致。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import type { Message } from '@/types'
import { chatState, sessionStore } from '@/ui/store'
import { resolveJumpAnchorId } from './helpers'
import { AT_BOTTOM_THRESHOLD } from './constants'
import type { MessageJumpTarget } from './types'

interface Params {
  messages: Message[]
  messagesRef: { current: Message[] }
  sessionId: string | null
  setMessages: (msgs: Message[]) => void
  /** 与滚动控制器共用：按需回补历史时切换 loading */
  setIsLoadingOlder: (v: boolean) => void
  pendingJumpIdRef: { current: string | null }
  needInitialBottomRef: { current: boolean }
  settleTimerRef: { current: ReturnType<typeof setInterval> | null }
  setHide: (v: boolean) => void
  setHighlightMsgId: (id: string | null) => void
  highlightTimerRef: { current: ReturnType<typeof setTimeout> | null }
  jumpLoadingTimerRef: { current: ReturnType<typeof setTimeout> | null }
  userMessages: Message[]
  rowVirtualizer: Virtualizer<HTMLDivElement, Element>
  jumpTo: (idx: number) => void
  activeMsgIdRef: { current: string | null }
  activeUserMsgId: string | null
  setActiveUserMsgId: (id: string | null) => void
  jumpTarget?: MessageJumpTarget | null
}

export function useJumpController({
  messages,
  messagesRef,
  sessionId,
  setMessages,
  setIsLoadingOlder,
  pendingJumpIdRef,
  needInitialBottomRef,
  settleTimerRef,
  setHide,
  setHighlightMsgId,
  highlightTimerRef,
  jumpLoadingTimerRef,
  userMessages,
  rowVirtualizer,
  jumpTo,
  activeMsgIdRef,
  activeUserMsgId,
  setActiveUserMsgId,
  jumpTarget,
}: Params) {
  const [jumpLoadingId, setJumpLoadingId] = useState<string | null>(null)
  /** 已消费的跳转 nonce（避免同一目标被重复定位） */
  const lastJumpNonceRef = useRef(0)

  /** 临时高亮某条消息（约 1s 后自动淡出清除；重复调用重置计时） */
  const flashHighlight = useCallback(
    (msgId: string) => {
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current)
      setHighlightMsgId(msgId)
      highlightTimerRef.current = setTimeout(() => {
        highlightTimerRef.current = null
        setHighlightMsgId(null)
      }, 1000)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  // ==================== 锚点点击：跳转到指定消息（必要时按需回补历史） ====================
  const scrollToMessage = useCallback(
    async (msgId: string, highlight = false) => {
      const sid = chatState.value.currentSessionId
      if (!sid) return

      // ① 已在内存 → 直接跳（count 已包含该消息，可立即跳转）
      // tool 命中先解析到宿主 assistant（见 resolveJumpAnchorId）
      const inMemoryId = resolveJumpAnchorId(messagesRef.current, msgId) ?? msgId
      const inMemory = messagesRef.current.findIndex((m) => m.id === inMemoryId)
      if (inMemory >= 0) {
        if (highlight) flashHighlight(inMemoryId)
        requestAnimationFrame(() => jumpTo(inMemory))
        return
      }

      // ② 尚未回补到内存：逐页从 SQLite 拉取，直到找到该消息
      setIsLoadingOlder(true)
      // 显示「定位中」提示；延迟 150ms，避免极短加载时 loading 一闪而过
      if (jumpLoadingTimerRef.current) clearTimeout(jumpLoadingTimerRef.current)
      jumpLoadingTimerRef.current = setTimeout(() => {
        jumpLoadingTimerRef.current = null
        setJumpLoadingId(msgId)
      }, 150)
      try {
        let idx = -1
        let guard = 0
        /** 实际定位的消息 id（tool 命中会解析到宿主 assistant） */
        let anchorId = msgId
        while (idx < 0 && sessionStore.hasMoreMessages(sid) && guard++ < 1000) {
          const ok = await sessionStore.loadOlderMessages(sid)
          if (sid !== chatState.value.currentSessionId) return
          const s = sessionStore.getSession(sid)
          if (!s) return
          // tool 消息自身零高度：改为定位宿主 assistant；宿主还没回来时继续回补
          const resolved = resolveJumpAnchorId(s.messages, msgId)
          anchorId = resolved ?? msgId
          idx = resolved ? s.messages.findIndex((m) => m.id === resolved) : -1
          // 没有进展（失败 / 已到最旧）→ 停止，避免死循环
          if (!ok && idx < 0) break
        }
        const s = sessionStore.getSession(sid)
        if (!s) return
        setMessages([...s.messages])
        const finalIdx = s.messages.findIndex((m) => m.id === anchorId)
        // 等 messages 提交后（layout effect）再跳，确保 count 已更新
        if (finalIdx >= 0) {
          pendingJumpIdRef.current = anchorId
          if (highlight) flashHighlight(anchorId)
        }
      } finally {
        if (jumpLoadingTimerRef.current) {
          clearTimeout(jumpLoadingTimerRef.current)
          jumpLoadingTimerRef.current = null
        }
        setJumpLoadingId(null)
        setIsLoadingOlder(false)
      }
    },
    [jumpTo, setMessages, flashHighlight],
  )

  // ==================== 检索跳转：滚动定位 + 高亮 ====================
  // 由 Ctrl+P 检索弹窗选中结果时下发 jumpTarget。等目标会话激活后再跳，并取消
  // 「切会话贴底稳定」流程 —— 否则 settle 轮询会在跳转后把视口重新拉回底部。
  useEffect(() => {
    if (!jumpTarget || !sessionId) return
    if (jumpTarget.sessionId !== sessionId) return
    if (jumpTarget.nonce === lastJumpNonceRef.current) return
    lastJumpNonceRef.current = jumpTarget.nonce

    needInitialBottomRef.current = false
    if (settleTimerRef.current) {
      clearInterval(settleTimerRef.current)
      settleTimerRef.current = null
    }
    setHide(false)
    void scrollToMessage(jumpTarget.id, true)
  }, [jumpTarget, sessionId, scrollToMessage])

  // 锚点列表滚动到底部 + active 指向最后一条用户消息
  const prevSessionRef = useRef<string | null>(null)
  useEffect(() => {
    if (userMessages.length === 0) return
    const lastUserMsg = userMessages[userMessages.length - 1]

    const isNewSession = prevSessionRef.current !== sessionId
    prevSessionRef.current = sessionId

    // 切换会话 或 用户正在底部 → 跟随最新用户消息
    if (isNewSession || rowVirtualizer.isAtEnd(AT_BOTTOM_THRESHOLD)) {
      activeMsgIdRef.current = lastUserMsg.id
      setActiveUserMsgId(lastUserMsg.id)
      requestAnimationFrame(() => {
        const anchorList = document.querySelector('.msg-anchor-list')
        if (anchorList) anchorList.scrollTop = anchorList.scrollHeight
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  return {
    jumpLoadingId,
    scrollToMessage,
  }
}
