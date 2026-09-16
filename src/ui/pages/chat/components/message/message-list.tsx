/**
 * chat-message-list — 聊天消息列表组件（虚拟滚动版）
 *
 * 从 chat-view 分离，管理消息列表的渲染、滚动行为、暂停/错误提示。
 *
 * 使用 @tanstack/react-virtual 做「动态高度」虚拟滚动：
 *  - DOM 恒定：仅渲染视口附近的若干条消息，向上翻阅上万条也不会累积 DOM。
 *  - 滚动锚定：向上从 SQLite 回补更早历史（前插）时保持视口不跳动。
 *  - 贴底跟随：位于底部时，新消息 / 流式增长自动跟随；用户上滑后不打扰。
 *
 * 数据从 store 同步，通过回调与父组件通信。
 */
import {
  useEffect,
  useRef,
  useCallback,
  useState,
  useLayoutEffect,
  useMemo,
} from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { Message } from '@/types'
import {
  chatState,
  sessionStore,
  getSessionRuntime,
  updateSessionRuntime,
} from '@/ui/store'
import {
  cancelPausedRun,
  resumePausedRun,
  deleteSessionMessage,
} from '@/services/chat-service'
import MessageBubble from './message-bubble'
import DropDownSvg from '@/ui/components/icons/DropDownSvg'
import Tooltip from '@/ui/components/shared/Tooltip'
import { t } from '@/ui/i18n'
import './message-list.scss'
import commentEvent from '@/events/commentEvent'
import { observer } from 'mobx-react-lite'

// ==================== 虚拟滚动常量 ====================
/** 单条消息「未被测量前」的估算高度（测量后以真实高度为准） */
const ESTIMATED_ITEM_HEIGHT = 120
/** 视口外前后额外渲染的条目数 */
const OVERSCAN = 6
/** 距底部 ≤ 该值视为「贴在底部」：新消息 / 流式增长时自动跟随 */
const AT_BOTTOM_THRESHOLD = 120
/** 距顶部 ≤ 该值触发回补更早消息 */
const SCROLL_TOP_THRESHOLD = 400
/** 列表上下内边距（由虚拟容器承担，保证滚动偏移计算与真实布局一致） */
const LIST_PADDING = 8
/** 「点击查看更多」提示条高度（预留占位，避免与首条消息重叠） */
const LOAD_MORE_HINT_HEIGHT = 36
/**
 * 切会话「等布局稳定」的轮询上限（50ms/次 → 约 1s）。
 * 兜底：无论高度是否还在变，到点都必须显示，避免任何异常情况下永久空白。
 */
const MAX_SETTLE_POLLS = 20
/**
 * 锚点列表最多渲染的圆点数（安全上限，避免极端会话挂载过多 DOM）。
 * 正常会话（数千消息）全部渲染，超出部分通过滚动条查看。
 */
const MAX_ANCHOR_DOTS = 2000

/** 稳定的空 tool 结果数组（无 toolCalls 的消息共用，保证 memo 命中） */
const EMPTY_TOOL_RESULTS: (Message | undefined)[] = []

/** 稳定的空锚点数组（索引未加载时共用，保证 useMemo 依赖稳定） */
const EMPTY_ANCHOR_USERS: AnchorUser[] = []

/** 锚点列表项：全量用户消息索引（后端）与本地已加载消息合并后的结果 */
interface AnchorUser {
  id: string
  /** 纯文本摘要（tooltip 用） */
  preview: string
}

/** 从消息内容中提取纯文本摘要（截断长度与后端预览保持一致：420 字符） */
function previewOfMessage(msg: Message): string {
  const text =
    typeof msg.content === 'string'
      ? msg.content
      : msg.content
          .filter((b) => b.type === 'text')
          .map((b) => ('text' in b ? b.text : ''))
          .join('')
  return text.slice(0, 420)
}

/**
 * 会话是否正在「流式输出」中。
 *
 * 流式期间 assistant 气泡的高度随 token 持续增长，任何「等待布局稳定」的逻辑
 * 都永远等不到稳定（等待用户交互而暂停的会话不算：此时没有新内容，高度静止）。
 */
function isStreamingSession(sessionId: string): boolean {
  const rt = getSessionRuntime(sessionId)
  return rt.working && !rt.paused
}

interface ChatMessageListProps {
  /** 当前已加载的所有消息（可能只是 SQLite 中的尾部若干页） */
  messages: Message[]
  /** 更新消息（触发父组件重渲染 / 虚拟列表 count 变化） */
  setMessages: (msgs: Message[]) => void
  /** 输入框设置文本回调 */
  setText: (text: string) => void
}

function ChatMessageList({
  messages,
  setMessages,
  setText,
}: ChatMessageListProps) {
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const lastScrollTopRef = useRef(0)
  const showScrollBtnRef = useRef(false)
  /** 正在从 SQLite 回补更早消息（防重入） */
  const loadingOlderRef = useRef(false)
  /**
   * 待执行的「锚点跳转」目标消息 id。
   * 回补历史后 messages 尚未提交时 count 仍是旧值，直接 scrollToIndex 会被
   * 夹到旧 count-1（跳错位置）。改为先记录目标，等 messages 提交后的
   * layout effect 里再用最新 count 跳转。
   */
  const pendingJumpIdRef = useRef<string | null>(null)
  /** 切会话/首开时的「贴底稳定」轮询定时器 */
  const settleTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  /** 切会话后需要「先滚到底部 + 布局稳定后再显示」 */
  const needInitialBottomRef = useRef(false)
  /**
   * message.id → 该消息 toolCalls 对应的结果数组（按索引对齐）。
   * 缓存引用：只要结果消息的对象引用不变，就复用同一数组，
   * 使 MessageBubble 的 memo 命中，避免 messages 整体换新时全量重渲染。
   */
  const toolResultsCacheRef = useRef(new Map<string, (Message | undefined)[]>())

  const [showScrollToBottomBtn, setShowScrollToBottomBtn] = useState(false)
  const [isLoadingOlder, setIsLoadingOlder] = useState(false)
  /**
   * 锚点「定位中」的目标消息 id（点击锚点需回补历史时显示 loading）。
   * 极短的加载不显示，避免 loading 一闪而过（延迟 150ms 再显示）。
   */
  const [jumpLoadingId, setJumpLoadingId] = useState<string | null>(null)
  /** 「定位中」提示的延迟显示定时器 */
  const jumpLoadingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 切会话 / 首开时容器先隐藏（opacity:0），布局稳定后再显示，避免中间态闪动 */
  const [hide, setHide] = useState(false)

  // 供「只注册一次」的 scroll 回调 / 异步回调读取最新的 messages
  const messagesRef = useRef(messages)
  messagesRef.current = messages

  const sessionId = chatState.value.currentSessionId
  const hasMoreInDb = sessionId
    ? sessionStore.hasMoreMessages(sessionId)
    : false

  // 当前会话运行时状态
  const currentRt = sessionId ? getSessionRuntime(sessionId) : null
  const isCurrentPaused = currentRt?.paused ?? false

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

  const anchorUsers = useMemo(() => {
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
    [],
  )
  const estimateSize = useCallback(() => ESTIMATED_ITEM_HEIGHT, [])

  const rowVirtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => messagesContainerRef.current,
    estimateSize,
    overscan: OVERSCAN,
    getItemKey,
    // 以「底部」为锚：
    //  - 贴底时新消息 / 流式增长自动跟随（anchorTo=end + followOnAppend）
    //  - 前插历史时按锚点项回推 scrollTop，视口不跳动
    //  - 用户上滑离开底部后，不再自动拉扯
    anchorTo: 'end',
    followOnAppend: true,
    scrollEndThreshold: AT_BOTTOM_THRESHOLD,
    paddingStart: LIST_PADDING + (hasMoreInDb ? LOAD_MORE_HINT_HEIGHT : 0),
    paddingEnd: LIST_PADDING,
  })
  const virtualItems = rowVirtualizer.getVirtualItems()

  /**
   * 跳转到指定索引。
   *  - 目标在当前已渲染范围内 → 平滑滚动（体验好，且这些条目已测量）
   *  - 目标在范围外（跨越大量未测量条目）→ 瞬间跳转。
   *    平滑滚动时虚拟库会刻意跳过「途经」条目的测量（见 virtual-core 的
   *    shouldMeasureDuringScroll），这些条目会按估算高度摆放，导致相邻气泡
   *    相互重叠。瞬间跳转不途经，目标条目挂载即被测量，避免该问题。
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

  // ==================== 切会话：清缓存 + 标记「需要贴底」 ====================
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
  }, [sessionId])

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
    const el = messagesContainerRef.current
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
      const cur = messagesContainerRef.current
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
  }, [rowVirtualizer])

  // 卸载时清理定时器
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
    }
  }, [])

  // ==================== 消息变化：贴底 / 稳定显示 ====================
  useLayoutEffect(() => {
    const count = messages.length
    if (count === 0) return
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

  // ==================== 从 store 同步消息到 UI ====================
  const syncMessagesToUI = useCallback(
    (sid: string) => {
      if (sid !== chatState.value.currentSessionId) return
      const s = sessionStore.getSession(sid)
      if (s) setMessages([...s.messages])
    },
    [setMessages],
  )

  // ==================== 滚动事件：加载更早 + 活跃锚点 + 到底部按钮 ====================
  const [activeUserMsgId, setActiveUserMsgId] = useState<string | null>(null)
  const activeMsgIdRef = useRef<string | null>(null)
  useEffect(() => {
    const container = messagesContainerRef.current
    if (!container) return

    /** 滚动停止后强制重新测量已渲染条目（修正平滑滚动/流式增长期间的高度漂移） */
    let remeasureTimer: ReturnType<typeof setTimeout> | null = null
    function remeasureRenderedItems() {
      const root = messagesContainerRef.current
      if (!root) return
      root
        .querySelectorAll<HTMLElement>('.message-item-wrap')
        .forEach((node) => rowVirtualizer.measureElement(node))
    }

    /**
     * 计算当前活跃的用户消息锚点。
     *
     * 虚拟滚动下只有视口附近的条目被渲染：若仍遍历 DOM，视口内没有任何 user 消息时
     * 会找不到元素，高亮就会消失。这里改用「滚动偏移 → 消息实测起始位置」的几何计算，
     * 与 DOM 是否渲染无关。
     */
    function updateActiveDot() {
      const el = messagesContainerRef.current
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
      const { scrollTop, scrollHeight, clientHeight } = container
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
    const el = messagesContainerRef.current
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

  // ==================== 锚点点击：跳转到指定消息（必要时按需回补历史） ====================
  const scrollToMessage = useCallback(
    async (msgId: string) => {
      const sid = chatState.value.currentSessionId
      if (!sid) return

      // ① 已在内存 → 直接跳（count 已包含该消息，可立即跳转）
      const inMemory = messagesRef.current.findIndex((m) => m.id === msgId)
      if (inMemory >= 0) {
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
        while (
          idx < 0 &&
          sessionStore.hasMoreMessages(sid) &&
          guard++ < 1000
        ) {
          const ok = await sessionStore.loadOlderMessages(sid)
          if (sid !== chatState.value.currentSessionId) return
          const s = sessionStore.getSession(sid)
          if (!s) return
          idx = s.messages.findIndex((m) => m.id === msgId)
          // 没有进展（失败 / 已到最旧）→ 停止，避免死循环
          if (!ok && idx < 0) break
        }
        const s = sessionStore.getSession(sid)
        if (!s) return
        setMessages([...s.messages])
        const finalIdx = s.messages.findIndex((m) => m.id === msgId)
        // 等 messages 提交后（layout effect）再跳，确保 count 已更新
        if (finalIdx >= 0) pendingJumpIdRef.current = msgId
      } finally {
        if (jumpLoadingTimerRef.current) {
          clearTimeout(jumpLoadingTimerRef.current)
          jumpLoadingTimerRef.current = null
        }
        setJumpLoadingId(null)
        setIsLoadingOlder(false)
      }
    },
    [jumpTo, setMessages],
  )

  /**
   * 锚点圆点列表（memo）：仅在「用户消息集合」或活跃项/跳转回调变化时重建。
   * 长会话下圆点可能上千个，必需避免流式 token 高频更新时反复创建。
   */
  const anchorDots = useMemo(
    () =>
      anchorUsers.slice(-MAX_ANCHOR_DOTS).map((u) => (
        <Tooltip key={u.id} content={u.preview || ''} direction="left">
          <button
            className={`msg-anchor-dot${activeUserMsgId === u.id ? ' active' : ''}${
              jumpLoadingId === u.id ? ' loading' : ''
            }`}
            onClick={() => void scrollToMessage(u.id)}
            type="button"
            aria-label={t('跳转到该消息')}
          />
        </Tooltip>
      )),
    [anchorUsers, activeUserMsgId, scrollToMessage, jumpLoadingId],
  )

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

  // MessageBubble 已 memo，这里用稳定的回调避免每次重渲染都改变 props 引用
  const handleEditBubble = useCallback(
    (msg: string) => setText(msg),
    [setText],
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

  // 滚动到底部按钮点击
  const handleScrollToBottom = useCallback(() => {
    const count = messagesRef.current.length
    if (count === 0) return
    rowVirtualizer.scrollToIndex(count - 1, {
      align: 'end',
      behavior: 'smooth',
    })
  }, [rowVirtualizer])

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

  return (
    <>
      {/* 错误提示 */}
      {chatState.value.error && (
        <div className="error-banner">
          <span>{chatState.value.error}</span>
          <button
            onClick={() => {
              const sid = chatState.value.currentSessionId
              if (sid) updateSessionRuntime(sid, { error: null })
              chatState.setValue('error', null)
            }}>
            ✕
          </button>
        </div>
      )}

      {/* 消息列表（虚拟滚动：仅渲染视口附近的若干条） */}
      <div
        className="chat-messages-container"
        style={{
          opacity: hide ? 0 : 1,
        }}
        ref={messagesContainerRef}>
        <div
          className="vm-list"
          style={{
            height: rowVirtualizer.getTotalSize(),
            width: '100%',
            position: 'relative',
          }}>
          {/* 加载更多提示（点击可手动回补更早历史） */}
          {hasMoreInDb && (
            <div
              className="load-more-hint"
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                height: LOAD_MORE_HINT_HEIGHT,
              }}
              onClick={() => {
                if (!isLoadingOlder) void loadOlder()
              }}>
              {isLoadingOlder ? t('加载更多消息...') : t('点击查看更多')}
            </div>
          )}

          {virtualItems.map((vi) => {
            const msg = messages[vi.index]
            if (!msg) return null
            return (
              <div
                key={vi.key}
                data-index={vi.index}
                ref={rowVirtualizer.measureElement}
                className="message-item-wrap"
                data-msg-id={msg.role === 'user' ? msg.id : undefined}
                style={{
                  position: 'absolute',
                  top: vi.start,
                  left: 0,
                  width: '100%',
                }}>
                <MessageBubble
                  onEdit={handleEditBubble}
                  onDelete={handleDeleteBubble}
                  message={msg}
                  toolResults={toolResultsFor(msg)}
                />
              </div>
            )
          })}
        </div>
      </div>

      {/* 用户消息锚点列表 — 覆盖整个会话的全量 user 消息，可视区内滚动查找 */}
      {anchorUsers.length > 1 && (
        <div className="msg-anchor-list">{anchorDots}</div>
      )}

      {/* 锚点定位中：点击的锚点在回补历史（需等待时显示） */}
      {jumpLoadingId && (
        <div className="msg-jump-loading" aria-live="polite">
          <span className="msg-jump-spinner" />
          <span>{t('定位中...')}</span>
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
            <span className="paused-text">{t('会话已暂停，是否继续？')}</span>
          </div>
          <button className="paused-resume-btn" onClick={handleResume}>
            {t('继续')}
          </button>
          <button className="paused-cancel-btn" onClick={handleCancelPaused}>
            {t('取消')}
          </button>
        </div>
      )}
    </>
  )
}

export default observer(ChatMessageList)
