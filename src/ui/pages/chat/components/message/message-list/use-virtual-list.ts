/**
 * message-list 虚拟滚动核心 + 派生数据（不含滚动事件与跳转逻辑）。
 *
 * 动态高度虚拟滚动：只渲染视口附近若干行；getItemKey 用行 key 做错定，前插历史不跳动；
 * anchorTo:'end' 贴底跟随。
 */
import { useCallback, useMemo, useRef } from 'react'
import { elementScroll, useVirtualizer } from '@tanstack/react-virtual'
import type { Range, Virtualizer } from '@tanstack/react-virtual'
import type { Message } from '@/types'
import { sessionStore } from '@/ui/store'
import { previewOfMessage } from './helpers'
import { buildRows, buildRowIndexMap, type ListRow } from './rows'
import { createScrollHold } from './scroll-hold'
import {
  AT_BOTTOM_THRESHOLD,
  EMPTY_TOOL_RESULTS,
  ESTIMATED_ITEM_HEIGHT,
  LIST_PADDING,
  LOAD_MORE_HINT_HEIGHT,
  MAX_OVERSCAN_ITEMS,
  OVERSCAN,
  OVERSCAN_PX,
  OVERSCAN_SCREENS,
} from './constants'
import { EMPTY_ANCHOR_USERS } from './types'
import type { AnchorUser } from './types'

/** 工具组行模型：成员消息 + 与每个成员一一对应的结果数组（引用稳定，供行组件 memo 用） */
export interface GroupRowModel {
  members: Message[]
  /** 与 members 一一对应：该成员每条 toolCall 的结果消息（按 toolCalls 顺序） */
  results: (Message | undefined)[][]
}

interface Params {
  messages: Message[]
  /** 供「只注册一次」的回调读取最新的 messages */
  messagesRef: { current: Message[] }
  sessionId: string | null
  /** 是否启用工具组折叠（= 设置项 hideToolCallThink） */
  groupTools: boolean
  /** 滚动容器（虚拟库的 getScrollElement） */
  containerRef: { current: HTMLDivElement | null }
  /** message.id → toolCalls 结果数组的缓存（引用稳定，保证 memo 命中） */
  toolResultsCacheRef: { current: Map<string, (Message | undefined)[]> }
}

export function useVirtualList({
  messages,
  messagesRef,
  sessionId,
  groupTools,
  containerRef,
  toolResultsCacheRef,
}: Params) {
  const toolResultById = useMemo(() => {
    const map = new Map<string, Message>()
    for (const m of messages) {
      if (m.role === 'tool' && m.toolCallId) map.set(m.toolCallId, m)
    }
    return map
  }, [messages])

  /**
   * 取某条消息 toolCalls 对应的结果数组（按索引对齐）。引用未变时返回缓存。
   * ⚠️ 列表把它「取好值」传给气泡（而非把函数透传下去）：messages 一换新函数也换引用，
   * memo 化的气泡就会被整片击穿。工具组那两个数组走 `groupRowFor`，同一条理由。
   */
  const toolResultsFor = useCallback(
    (msg: Message): (Message | undefined)[] => {
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
    },
    [toolResultById],
  )

  /** 渲染期总是最新的「toolCallId → 结果消息」（供只注册一次的缓存函数读取） */
  const toolResultByIdRef = useRef(toolResultById)
  toolResultByIdRef.current = toolResultById

  /**
   * 工具组的「行模型」：成员消息 + 与每个成员一一对应的结果数组，按行 key 缓存。
   *
   * ⚠️ 工具组行绝不能再收「全量 messages」或「每次渲染新建的函数 / 数组」：messages 每次
   * setMessages 都换引用（前插历史 / 流式 token 都是），`toolResultsFor` 也跟着换引用 ——
   * 任一条都能把 `memo` 击穿，展开着的工具组会把组内几十张卡片整片重渲染（实测单次前插 30~70ms）。
   * 这里按**成员对象身份 + 每张卡的结果身份**逐项比对，没变就返回同一份模型。
   */
  const groupRowsCacheRef = useRef(new Map<string, GroupRowModel>())
  const groupRowFor = useCallback(
    (key: string, indexes: readonly number[]): GroupRowModel => {
      const src = messagesRef.current
      const byId = toolResultByIdRef.current
      const prev = groupRowsCacheRef.current.get(key)
      // 先无分配地比一遍（稳态：没变就直接返回上一份）
      if (prev && prev.members.length === indexes.length) {
        let same = true
        for (let k = 0; k < indexes.length; k++) {
          const msg = src[indexes[k]]
          const pm = prev.members[k]
          const pr = prev.results[k]
          const tcs = msg?.toolCalls ?? []
          if (!msg || pm !== msg || !pr || pr.length !== tcs.length) {
            same = false
            break
          }
          for (let i = 0; i < tcs.length; i++) {
            if (pr[i] !== byId.get(tcs[i].id)) {
              same = false
              break
            }
          }
          if (!same) break
        }
        if (same) return prev
      }
      const members: Message[] = []
      const results: (Message | undefined)[][] = []
      for (const index of indexes) {
        const msg = src[index]
        if (!msg) continue
        members.push(msg)
        results.push((msg.toolCalls ?? []).map((tc) => byId.get(tc.id)))
      }
      const model: GroupRowModel = { members, results }
      groupRowsCacheRef.current.set(key, model)
      return model
    },
    // messages / toolResultById 走 ref（渲染期总是最新）；换会话时由 clearRowCaches 显式清空
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  /** 清空按行缓存（切会话时调用，避免旧会话的消息对象被长期持有） */
  const clearRowCaches = useCallback(() => {
    groupRowsCacheRef.current.clear()
  }, [])

  // 连续的工具调用合并成一行（见 rows.ts）；未启用折叠时退化为「一条消息 = 一行」。
  const rows = useMemo(
    () => buildRows(messages, groupTools),
    [messages, groupTools],
  )
  /** 供「只注册一次」的回调读取最新的行模型 */
  const rowsRef = useRef<readonly ListRow[]>(rows)
  rowsRef.current = rows
  /** 消息下标 → 行下标（锚点 / 检索命中等入口拿到的是消息下标） */
  const rowIndexOfMessage = useMemo(
    () => buildRowIndexMap(messages, rows),
    [messages, rows],
  )
  const rowIndexOfMessageRef = useRef<readonly number[]>(rowIndexOfMessage)
  rowIndexOfMessageRef.current = rowIndexOfMessage

  // 用户消息（本地已加载的，用于「跟随最新用户消息」）
  const userMessages = useMemo(
    () => messages.filter((m) => m.role === 'user'),
    [messages],
  )

  // 后端「全量用户消息索引」覆盖整个会话历史，不依赖分页；
  // 本会话刚发送、尚未进索引的消息由本地已加载消息补齐。
  const userMsgIndex = sessionId
    ? sessionStore.getUserMessageIndex(sessionId)
    : EMPTY_ANCHOR_USERS

  // 本地「user 消息集合」的签名：流式更新 assistant / tool 时不变，用它做依赖可避免
  // 锚点列表在高频 token 更新中重建。
  const localUserSig = useMemo(() => {
    const ids: string[] = []
    for (const m of messages) if (m.role === 'user') ids.push(m.id)
    return ids.join('\u0001')
  }, [messages])

  /**
   * 上一次的锚点数组：id 序列不变就复用同一引用。
   * 不这么做的话，每次前插历史都会换一个新数组 → `AnchorDots` 的 memo 被击穿 → 几百个
   * Tooltip + button 整片重渲染（实测单个 commit 可因此多花 25~50ms）。
   */
  const anchorUsersRef = useRef<AnchorUser[]>([])
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
    const prev = anchorUsersRef.current
    if (prev.length === out.length && prev.every((u, i) => u.id === out[i].id)) {
      return prev
    }
    anchorUsersRef.current = out
    return out
    // messages 通过 messagesRef 读取；其 user 消息集合的变化已由 localUserSig 跟踪
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userMsgIndex, localUserSig])

  // getItemKey 用行 key（稳定）：one 行 = 消息 id，tools 行 = tools: + 首条 id。
  // 前插历史时测量缓存可跟随同一行，库据此把视口锚点项保持原位 → 上翻不跳动。
  const getItemKey = useCallback(
    (index: number) => rowsRef.current[index]?.key ?? `row-${index}`,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  /**
   * 未测量条目的估算高度（存 ref 避免重渲染）。用已测量条目的平均高度动态逼近：
   * 估算越准，新条目挂载时对 scrollTop 的补偿越小。
   */
  const avgItemHeightRef = useRef(ESTIMATED_ITEM_HEIGHT)
  const estimateSize = useCallback(() => avgItemHeightRef.current, [])

  /** 虚拟器实例：rangeExtractor 在库的回调里需要读它的 measurementsCache */
  const rowVirtualizerRef = useRef<Virtualizer<HTMLDivElement, Element> | null>(
    null,
  )

  /**
   * 按像素（而非条数）计算渲染范围：视口上下各留 OVERSCAN_SCREENS 屏，
   * 给快速 / 惯性滚动留出反应空间。
   */
  const rangeExtractor = useCallback((range: Range) => {
    const { startIndex, endIndex, count } = range
    let start = startIndex
    let end = endIndex
    const virt = rowVirtualizerRef.current
    const m = virt?.measurementsCache
    if (!virt || !m || m.length < count) {
      // 兜底（实例 / 测量值未就绪）：退回按条数扩展
      start = Math.max(startIndex - MAX_OVERSCAN_ITEMS, 0)
      end = Math.min(endIndex + MAX_OVERSCAN_ITEMS, count - 1)
    } else {
      // 缓冲区取「视口高 × 单侧屏数」与 OVERSCAN_PX 的较大值
      const buffer = Math.max(
        OVERSCAN_PX,
        (virt.scrollRect?.height ?? 0) * OVERSCAN_SCREENS,
      )
      // 扩大至覆盖顶部缓冲区或达到条数上限
      const topLimit = (m[startIndex]?.start ?? 0) - buffer
      while (
        start > 0 &&
        startIndex - start < MAX_OVERSCAN_ITEMS &&
        (m[start - 1]?.start ?? topLimit) >= topLimit
      ) {
        start--
      }
      // 扩大至覆盖底部缓冲区或达到条数上限
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

  /** 行内改高的「按住滚动偏移」（见 scroll-hold.ts） */
  const scrollHold = useMemo(() => createScrollHold(), [])

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => containerRef.current,
    estimateSize,
    // 条数 overscan 不决定渲染范围（由 rangeExtractor 按像素给出），只影响平滑滚动时的重测窗口。
    overscan: OVERSCAN,
    getItemKey,
    rangeExtractor,
    // ⚠️ 必须关掉库默认开启的 flushSync：条目测量发生在提交阶段，库在「测量同步改写了 scrollTop」
    // 时会 flushSync(rerender)，而渲染 / 提交中调 flushSync 是 React 明令禁止的。
    useFlushSync: false,
    // 以底部为锚：贴底时新消息自动跟随；前插历史时按锚点项回推 scrollTop；
    // 用户上滑离开底部后不再自动拉扯。
    anchorTo: 'end',
    followOnAppend: true,
    scrollEndThreshold: AT_BOTTOM_THRESHOLD,
    // 把 RO 回调推迟到 rAF，消除 Chromium 的「ResizeObserver loop」告警；代价是实测高度晚一帧生效。
    useAnimationFrameWithResizeObserver: true,
    // 顶部提示条的高度**恒定预留**（不随 hasMoreInDb 变）：该值一变，库不会重做锚定
    //（setOptions 只在 count / 首尾 key 变化时锚定 scrollTop），已读位置会整体跳一个提示条高。
    paddingStart: LIST_PADDING + LOAD_MORE_HINT_HEIGHT,
    paddingEnd: LIST_PADDING,
    // 行内改高时按住滚动偏移（见 scroll-hold.ts）：只拦「尺寸补偿」，跳转 / 平滑滚动照旧。
    scrollToFn: (offset, opts, instance) => {
      const held = scrollHold.intercept(opts.adjustments)
      if (held !== null) {
        elementScroll(held, {}, instance)
        return
      }
      elementScroll(offset, opts, instance)
    },
    onChange: (instance) => {
      // 补偿被拦下后，库的内部偏移还是加过那笔量 → 按回去；否则下一帧渲染范围算错。
      const held = scrollHold.consumeIntercepted()
      if (held !== null) instance.scrollOffset = held
    },
  })
  rowVirtualizerRef.current = rowVirtualizer
  const virtualItems = rowVirtualizer.getVirtualItems()

  /**
   * 行 ref：注册 RO + **挂载即同步实测**。库在 `isScrolling` 的 150ms 窗口里会跳过 ref 的同步测量
   * （程序化写 scrollTop 也会把窗口点开），只等被 rAF 推迟的 RO —— 新挂载的行（前插历史 / 切会话）
   * 会先按估算高度画一帧（位置错、互相重叠）再被纠正，这就是列表闪动的来源。
   * 只补「测量缓存里没有」的 key：有缓存时与库行为一致，避免每次挂载都强制布局读。
   * 引用必须稳定 —— 每帧换新会让 React 卸挂所有行并重跑上面的强制测量。
   */
  const measureRow = useCallback(
    (node: HTMLDivElement | null) => {
      rowVirtualizer.measureElement(node)
      if (!node) return
      const index = rowVirtualizer.indexFromElement(node)
      if (index < 0) return
      const key = rowVirtualizer.options.getItemKey(index)
      if (rowVirtualizer.itemSizeCache.has(key)) return
      rowVirtualizer.resizeItem(index, node.offsetHeight)
    },
    [rowVirtualizer],
  )

  /** 用已测量条目的平均高度刷新估算高度 */
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
   * 目标在当前渲染范围内 → 平滑滚动；在范围外 → 瞬间跳转（避免途经未测量条目重叠）。
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

  /**
   * 「按住当前滚动偏移」：行内展开 / 收起超长正文会改行高，贴底补偿会把阅读位置甩到底部。
   * ⚠️ 必须是稳定引用：作为 prop 传给 memo 化的气泡，引用一变全部重渲染。
   */
  const holdScrollOffset = useCallback(() => {
    const el = containerRef.current
    if (el) scrollHold.arm(el.scrollTop)
  }, [scrollHold])

  return {
    rowVirtualizer,
    measureRow,
    virtualItems,
    rows,
    rowsRef,
    rowIndexOfMessageRef,
    jumpTo,
    refreshEstimatedItemHeight,
    toolResultsFor,
    groupRowFor,
    clearRowCaches,
    userMessages,
    anchorUsers,
    holdScrollOffset,
  }
}
