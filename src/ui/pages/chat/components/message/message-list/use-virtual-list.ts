/**
 * message-list 虚拟滚动核心 + 派生数据
 *
 * 从 message-list 抽出：这里只依赖 messages / messagesRef / 容器 / 会话信息，
 * 不含滚动事件与跳转逻辑，是「可独立阅读」的一层。
 *
 * @tanstack/react-virtual 的「动态高度」虚拟滚动：
 *  - DOM 恒定：仅渲染视口附近的若干条消息。
 *  - 滚动锚定：前插历史时保持视口不跳动（getItemKey 用消息 id）。
 *  - 贴底跟随：anchorTo:'end' + followOnAppend。
 */
import { useCallback, useMemo, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { Range, Virtualizer } from '@tanstack/react-virtual'
import type { Message } from '@/types'
import { sessionStore } from '@/ui/store'
import { previewOfMessage } from './helpers'
import {
  AT_BOTTOM_THRESHOLD,
  EMPTY_TOOL_RESULTS,
  ESTIMATED_ITEM_HEIGHT,
  LIST_PADDING,
  LOAD_MORE_HINT_HEIGHT,
  MAX_OVERSCAN_ITEMS,
  OVERSCAN,
  OVERSCAN_PX,
} from './constants'
import { EMPTY_ANCHOR_USERS } from './types'
import type { AnchorUser } from './types'

interface Params {
  messages: Message[]
  /** 供「只注册一次」的回调读取最新的 messages */
  messagesRef: { current: Message[] }
  sessionId: string | null
  hasMoreInDb: boolean
  /** 滚动容器（虚拟库的 getScrollElement） */
  containerRef: { current: HTMLDivElement | null }
  /** message.id → toolCalls 结果数组的缓存（引用稳定，保证 memo 命中） */
  toolResultsCacheRef: { current: Map<string, (Message | undefined)[]> }
}

export function useVirtualList({
  messages,
  messagesRef,
  sessionId,
  hasMoreInDb,
  containerRef,
  toolResultsCacheRef,
}: Params) {
  // ==================== tool 结果索引（一次遍历 + 引用稳定） ====================
  const toolResultById = useMemo(() => {
    const map = new Map<string, Message>()
    for (const m of messages) {
      if (m.role === 'tool' && m.toolCallId) map.set(m.toolCallId, m)
    }
    return map
  }, [messages])

  /**
   * 取某条消息 toolCalls 对应的结果数组（按索引对齐）。
   * 结果消息引用未变时返回缓存数组 → MessageBubble / ToolCallGroup 不会因
   *「messages 数组整体换新」而重渲染。
   */
  function toolResultsFor(msg: Message): (Message | undefined)[] {
    const tcs = msg.toolCalls
    if (!tcs || tcs.length === 0) return EMPTY_TOOL_RESULTS
    const next = tcs.map((tc) => toolResultById.get(tc.id))
    const prev = toolResultsCacheRef.current.get(msg.id)
    if (
      prev &&
      prev.length === next.length &&
      prev.every((p, i) => p === next[i])
    ) {
      return prev
    }
    toolResultsCacheRef.current.set(msg.id, next)
    return next
  }

  // 用户消息（本地已加载的，用于「跟随最新用户消息」）
  const userMessages = useMemo(
    () => messages.filter((m) => m.role === 'user'),
    [messages],
  )

  // ==================== 锚点列表数据 ====================
  // 后端「全量用户消息索引」（id + 摘要）覆盖整个会话历史，不依赖消息分页；
  // 本会话中刚发送、尚未包含在索引里的消息由本地已加载消息补齐。
  const userMsgIndex = sessionId
    ? sessionStore.getUserMessageIndex(sessionId)
    : EMPTY_ANCHOR_USERS

  // 本地「user 消息集合」的签名：流式更新 assistant/tool 消息时保持不变，
  // 用它做依赖可避免锚点列表在高频 token 更新中重建（下方 messages 通过 ref 读取）。
  const localUserSig = useMemo(() => {
    const ids: string[] = []
    for (const m of messages) if (m.role === 'user') ids.push(m.id)
    return ids.join('\u0001')
  }, [messages])

  const anchorUsers = useMemo((): AnchorUser[] => {
    const out: AnchorUser[] = []
    const seen = new Set<string>()
    for (const ref of userMsgIndex) {
      out.push(ref)
      seen.add(ref.id)
    }
    for (const m of messagesRef.current) {
      if (m.role !== 'user' || seen.has(m.id)) continue
      out.push({ id: m.id, preview: previewOfMessage(m) })
    }
    return out
    // messages 通过 messagesRef 读取；其 user 消息集合的变化已由 localUserSig 跟踪
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userMsgIndex, localUserSig])

  // ==================== 虚拟滚动核心 ====================
  // getItemKey 用消息 id（稳定），前插历史时测量缓存可跟随同一条消息，
  // 库据此把「视口锚点项」保持在原位置 → 上翻不跳动。
  const getItemKey = useCallback(
    (index: number) => messagesRef.current[index]?.id ?? `idx-${index}`,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  /**
   * 未测量条目的估算高度（存 ref，避免重渲染；虚拟库重算测量值时读取）。
   * 用「已测量条目的平均高度」动态逼近而不是固定常数：估算值与真实值越接近，
   * 新条目挂载时虚拟库对 scrollTop 的高度补偿就越小。
   */
  const avgItemHeightRef = useRef(ESTIMATED_ITEM_HEIGHT)
  const estimateSize = useCallback(() => avgItemHeightRef.current, [])

  /** 虚拟器实例：rangeExtractor 在库的回调里需要读它的 measurementsCache */
  const rowVirtualizerRef = useRef<Virtualizer<HTMLDivElement, Element> | null>(
    null,
  )

  /**
   * 按「像素」而不是「条数」计算渲染范围：视口上下各多渲染约一屏内容，
   * 给滚动（含快速 / 惯性滚动）留出反应空间。
   */
  const rangeExtractor = useCallback((range: Range) => {
    const { startIndex, endIndex, count } = range
    let start = startIndex
    let end = endIndex
    const virt = rowVirtualizerRef.current
    const m = virt?.measurementsCache
    if (!virt || !m || m.length < count) {
      // 兜底（实例 / 测量值尚未就绪）：退回按条数扩展
      start = Math.max(startIndex - OVERSCAN, 0)
      end = Math.min(endIndex + OVERSCAN, count - 1)
    } else {
      // 缓冲区取「一屏高度」与 OVERSCAN_PX 的较大值
      const buffer = Math.max(OVERSCAN_PX, virt.scrollRect?.height ?? 0)
      // 向上扩展，直到覆盖顶部缓冲区或达到条数上限
      const topLimit = (m[startIndex]?.start ?? 0) - buffer
      while (
        start > 0 &&
        startIndex - start < MAX_OVERSCAN_ITEMS &&
        (m[start - 1]?.start ?? topLimit) >= topLimit
      ) {
        start--
      }
      // 向下扩展，直到覆盖底部缓冲区或达到条数上限
      const bottomLimit = (m[endIndex]?.end ?? 0) + buffer
      while (
        end < count - 1 &&
        end - endIndex < MAX_OVERSCAN_ITEMS &&
        (m[end + 1]?.end ?? bottomLimit) <= bottomLimit
      ) {
        end++
      }
    }
    const len = Math.max(end - start + 1, 1)
    const indexes = new Array<number>(len)
    for (let i = 0; i < len; i++) indexes[i] = start + i
    return indexes
  }, [])

  const rowVirtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => containerRef.current,
    estimateSize,
    overscan: OVERSCAN,
    getItemKey,
    rangeExtractor,
    // 以「底部」为锚：
    //  - 贴底时新消息 / 流式增长自动跟随（anchorTo=end + followOnAppend）
    //  - 前插历史时按锚点项回推 scrollTop，视口不跳动
    //  - 用户上滑离开底部后，不再自动拉扯
    anchorTo: 'end',
    followOnAppend: true,
    scrollEndThreshold: AT_BOTTOM_THRESHOLD,
    // ---- 消除 Chromium「ResizeObserver loop completed with undelivered notifications」----
    // 打开后库把 RO 回调体推迟到 rAF，布局写入落在本帧 RO 投递之后，
    // 新通知顺延到下一帧，报错消失。代价：实测高度晚一帧生效（观感无差）。
    useAnimationFrameWithResizeObserver: true,
    paddingStart: LIST_PADDING + (hasMoreInDb ? LOAD_MORE_HINT_HEIGHT : 0),
    paddingEnd: LIST_PADDING,
  })
  rowVirtualizerRef.current = rowVirtualizer
  const virtualItems = rowVirtualizer.getVirtualItems()

  /**
   * 用「已测量条目的平均高度」刷新未测量条目的估算高度（estimateSize）。
   * 估算越准，新条目挂载时虚拟库对 scrollTop 的补偿越小，快速滚动越不抖。
   */
  const refreshEstimatedItemHeight = useCallback(() => {
    const sizes = rowVirtualizer.itemSizeCache
    if (sizes.size === 0) return
    let sum = 0
    for (const size of sizes.values()) sum += size
    const avg = sum / sizes.size
    // 只在明显偏离时更新，避免估算值被反复微调
    if (avg > 0 && Math.abs(avg - avgItemHeightRef.current) > 8) {
      avgItemHeightRef.current = avg
    }
  }, [rowVirtualizer])

  /**
   * 跳转到指定索引。
   *  - 目标在当前已渲染范围内 → 平滑滚动（体验好，且这些条目已测量）
   *  - 目标在范围外（跨越大量未测量条目）→ 瞬间跳转（避免途经条目重叠）
   */
  const jumpTo = useCallback(
    (idx: number) => {
      const items = rowVirtualizer.getVirtualItems()
      const near =
        items.length > 0 &&
        idx >= items[0].index &&
        idx <= items[items.length - 1].index
      rowVirtualizer.scrollToIndex(idx, {
        align: 'start',
        behavior: near ? 'smooth' : 'auto',
      })
    },
    [rowVirtualizer],
  )

  return {
    rowVirtualizer,
    virtualItems,
    jumpTo,
    refreshEstimatedItemHeight,
    toolResultsFor,
    userMessages,
    anchorUsers,
  }
}
