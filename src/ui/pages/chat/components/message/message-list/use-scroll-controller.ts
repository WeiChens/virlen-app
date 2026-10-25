/**
 * message-list「滚动行为」控制器：回补更早历史（loadOlder）、切会话后的贴底稳定、滚动到底部按钮、
 * 内容不足一屏自动补足、滚动事件监听（活跃锚点 / 预取更早）。
 *
 * 与「跳转控制器」共享若干 ref / state（由 message-list 控制器创建后注入）。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import type { Message } from '@/types'
import { chatState, sessionStore } from '@/ui/store'
import commentEvent from '@/events/commentEvent'
import {
  captureOlderAnchor,
  isStreamingSession,
  pickActiveAnchorUser,
  resolveOlderAnchorRow,
  type OlderAnchor,
} from './helpers'
import type { ListRow } from './rows'
import {
  anchorAt,
  nextIntent,
  restoreTargetOf,
  type ScrollIntent,
  type ScrollView,
} from './scroll-restore'
import {
  AT_BOTTOM_THRESHOLD,
  MAX_SETTLE_POLLS,
  SCROLL_TOP_THRESHOLD,
} from './constants'

/** 取滚动容器的几何（与 `scroll-restore.ts` 的入参同形） */
function viewOf(el: HTMLElement): ScrollView {
  return {
    scrollTop: el.scrollTop,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  }
}

/**
 * 复位窗口最长跑多少帧（约 2s）：窗口恢复 / 行重测分几拍回来时要连续纠正，
 * 但不能无限跑 —— 到点还在动就说明有别的东西在抢（这时让位比硬拉更安全）。
 */
const MAX_RESTORE_FRAMES = 120
/**
 * 复位窗口至少跑多少帧（约 200ms）：位置「看起来已经对了」不能马上收手 ——
 * 浏览器可能在恢复后的几帧里再补写一次它自己存下的偏移。
 */
const MIN_RESTORE_FRAMES = 12

interface Params {
  messages: Message[]
  messagesRef: { current: Message[] }
  sessionId: string | null
  hasMoreInDb: boolean
  setMessages: (msgs: Message[]) => void
  containerRef: { current: HTMLDivElement | null }
  /** 行模型（虚拟库 / 跳转均以行下标工作） */
  rowsRef: { current: readonly ListRow[] }
  /** 消息下标 → 行下标（锚点定位需要换算） */
  rowIndexOfMessageRef: { current: readonly number[] }
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
  rowsRef,
  rowIndexOfMessageRef,
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
  /** 本次回补前抓住的阅读锚点（前插提交后由 layout effect 消费） */
  const olderAnchorRef = useRef<(OlderAnchor & { before: number }) | null>(null)
  /** 上一次的条目数（用于判断「条目数变化」而非流式内容更新） */
  const lastMsgCountRef = useRef(0)
  /**
   * 离开这一屏时的滚动意图（贴底 / 停在某个偏移）。
   * 位置被浏览器夹到 0 之后按它复位 —— 详见 `scroll-restore.ts` 与 `restoreLostPosition`。
   */
  const intentRef = useRef<ScrollIntent>({ atEnd: true, offset: 0, anchor: null })
  /** 上一拍的内容总高（判断「塌陷 → 重建」，见下面的 layout effect） */
  const lastTotalSizeRef = useRef(0)
  /** 复位窗口正在跑：这期间的位置是浏览器挪的，不能拿它覆盖意图 */
  const restoringRef = useRef(false)
  /** 复位窗口的 rAF 句柄与代数（代数让被取消的旧帧老实退出） */
  const restoreRafRef = useRef<number | null>(null)
  const restoreGenRef = useRef(0)

  const loadOlder = useCallback(async () => {
    const sid = chatState.value.currentSessionId
    if (!sid || loadingOlderRef.current) return
    if (!sessionStore.hasMoreMessages(sid)) return
    loadingOlderRef.current = true
    setIsLoadingOlder(true)
    // 抓「阅读锚点」：前插提交后用它校对 scrollTop（见下方 layout effect）。
    // 贴底时不抓：那种情况由虚拟库的 followOnAppend 接管，硬校正会把用户从底部拽回上面。
    olderAnchorRef.current = null
    const el = containerRef.current
    if (
      el &&
      el.scrollHeight - el.clientHeight - el.scrollTop > AT_BOTTOM_THRESHOLD
    ) {
      const anchor = captureOlderAnchor(
        rowVirtualizer.getVirtualItems(),
        el.scrollTop,
        rowsRef.current,
        messagesRef.current,
      )
      if (anchor) {
        olderAnchorRef.current = { ...anchor, before: messagesRef.current.length }
      }
    }
    try {
      const ok = await sessionStore.loadOlderMessages(sid)
      if (ok && sid === chatState.value.currentSessionId) {
        const s = sessionStore.getSession(sid)
        if (s) setMessages([...s.messages])
      }
    } finally {
      setIsLoadingOlder(false)
      // 不能「数据一回来就放开重入」：此时错点还没把 scrollTop 推离顶部（< SCROLL_TOP_THRESHOLD），
      // 仍在持续上滑的滚动事件会立刻再拉一页 → 两页叠在同一帧提交，主线程直接多花一倍。
      // 给一次提交留出窗口再放开（期间重复调用直接 return，不会丢数据）。
      setTimeout(() => {
        loadingOlderRef.current = false
      }, 150)
    }
  }, [rowVirtualizer, setMessages])

  /**
   * 用回补前抓的语义锚点校对滚动位置（消息已提交、绘制之前）。
   *
   * 虚拟库自己也会按行 key 锚定（`anchorTo:'end'` 的 `setOptions`），但两件事它做不到：
   * 1. 锚点行的 key 没了（页边界跨工具组 → `tools:` 首成员变）→ 它一次补偿都不做；
   * 2. 新页行高还是估值时，`start` 也是估的，误差会留在视口上方。
   * 这里用库里同一份 `measurementsCache` 重算「该行应当在哪」，只差 > 1px 才写 —— 库已经补正时
   * 是彻底的空操作，不会双补偿。
   */
  const applyOlderAnchor = useCallback(
    (anchor: OlderAnchor & { before: number }) => {
      const el = containerRef.current
      // 只认「真的多出了消息」的那一次提交（否则是流式 / 删除 / 切会话）
      if (!el || messagesRef.current.length <= anchor.before) return
      const row = resolveOlderAnchorRow(
        anchor,
        messagesRef.current,
        rowIndexOfMessageRef.current,
      )
      if (row === null) return
      const start = rowVirtualizer.measurementsCache[row]?.start
      if (start === undefined) return
      const target = Math.max(0, start + anchor.offset)
      if (Math.abs(el.scrollTop - target) <= 1) return
      el.scrollTop = target
      // 库内部偏移跟着走：否则下一帧会按旧偏移算渲染范围（视口空一块 / 渲染错行）
      rowVirtualizer.scrollOffset = el.scrollTop
    },
    [rowVirtualizer],
  )

  /** 收掉复位窗口（用户一动手 / 切会话 / 卸载时走这里） */
  const stopRestoreHold = useCallback(() => {
    restoreGenRef.current += 1
    if (restoreRafRef.current !== null) cancelAnimationFrame(restoreRafRef.current)
    restoreRafRef.current = null
    restoringRef.current = false
  }, [])

  /** 按意图写一次位置；写了返回 true（`false` = 已经在位 / 现在没法判断） */
  const applyRestoreTarget = useCallback(
    (el: HTMLDivElement): boolean => {
      const target = restoreTargetOf(
        intentRef.current,
        viewOf(el),
        (index) => rowVirtualizer.measurementsCache[index]?.start,
      )
      if (target === null) return false
      if (target === 'end') {
        const count = rowsRef.current.length
        if (count === 0) return false
        rowVirtualizer.scrollToIndex(count - 1, {
          align: 'end',
          behavior: 'auto',
        })
        return true
      }
      el.scrollTop = target
      // 库内部偏移跟着走：否则下一帧会按旧偏移算渲染范围（视口空一块 / 渲染错行）
      rowVirtualizer.scrollOffset = el.scrollTop
      return true
    },
    [rowVirtualizer, rowsRef],
  )

  /**
   * 位置被浏览器挪走之后按「离开前的意图」复位（判定见 `scroll-restore.ts`）。
   *
   * ⚠️ 只纠一次不够：窗口恢复那一拍 `scrollTop` 可能被**分几次**夹（恢复动画逐帧改高）、
   * 浏览器会在我们写完后又补写它自己的偏移、行重测也会改总高。所以开一个「复位窗口」，
   * 至少跑 ~200ms、连续 3 帧不再需要动才收（或到帧上限）。
   * 窗口期间**冻结意图**（`restoringRef`）：那几拍的滚动事件看到的位置都是被夹出来的，
   * 记下来只会让下一次纠正照着错的位置走。用户一动手（wheel / 触摸 / 按键）立即收手。
   * ⚠️ 切会话 / 首开的贴底由 `settleToBottom` 独占：它在跑的时候必须让路，否则两边抢写 scrollTop。
   */
  const restoreLostPosition = useCallback(() => {
    if (needInitialBottomRef.current || settleTimerRef.current !== null) return
    const el = containerRef.current
    if (!el) return
    if (restoringRef.current) {
      // 窗口已经在跑（高度分几拍回来时每一拍都会调到这里）：就地把新的一拍纠正掉
      applyRestoreTarget(el)
      return
    }
    stopRestoreHold()
    const gen = restoreGenRef.current
    restoringRef.current = true
    let stable = 0
    let frames = 0
    const step = () => {
      if (gen !== restoreGenRef.current) return
      restoreRafRef.current = null
      const el = containerRef.current
      if (!el || needInitialBottomRef.current || settleTimerRef.current !== null) {
        stopRestoreHold()
        return
      }
      if (++frames > MAX_RESTORE_FRAMES) {
        stopRestoreHold()
        return
      }
      const moved = applyRestoreTarget(el)
      // 视口 0 那几拍（窗口还最小化着）不写也不计稳定：等它回来看高度
      stable = el.clientHeight > 0 && !moved ? stable + 1 : 0
      if (stable >= 3 && frames >= MIN_RESTORE_FRAMES) {
        stopRestoreHold()
        return
      }
      restoreRafRef.current = requestAnimationFrame(step)
    }
    step()
  }, [
    applyRestoreTarget,
    needInitialBottomRef,
    settleTimerRef,
    stopRestoreHold,
  ])

  /**
   * 容器**高度**变了 = 窗口被最小化 / 恢复、聊天区被藏起来又放回来、面板占满被解除：
   * 这些时机浏览器会把 scrollTop 夹掉（中段也不例外，见 `scroll-restore.ts` 头注释），
   * 而容器自己不会告诉虚拟库「该回哪去」—— 在这里补。
   * 只认高度差 ≥ 1px：拖分隔条只改宽度，纵向位置本来就对，硬滚会跟手打架。
   */
  useEffect(() => {
    const el = containerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    let lastHeight = el.clientHeight
    const observer = new ResizeObserver(() => {
      const cur = containerRef.current
      if (!cur) return
      if (Math.abs(cur.clientHeight - lastHeight) < 1) return
      lastHeight = cur.clientHeight
      restoreLostPosition()
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [restoreLostPosition])

  /**
   * 窗口重新可见 / 重新聚焦也补一次：最小化时 RO 未必真报到 0 高度（WebView2 各版本不一），
   * 这条是「总有个触发点」的兜底 —— 位置本来就在位时它是一次空操作。
   */
  useEffect(() => {
    const wake = () => {
      if (!document.hidden) restoreLostPosition()
    }
    document.addEventListener('visibilitychange', wake)
    window.addEventListener('focus', wake)
    return () => {
      document.removeEventListener('visibilitychange', wake)
      window.removeEventListener('focus', wake)
    }
  }, [restoreLostPosition])

  /**
   * 用户一动手就收手：复位窗口期间意图是冻结的，继续拉会跟手打架。
   * 自下而上滚动的入口只有这些（滚轮 / 触摸 / 拖滚动条 / 键盘），监听在捕获前即可。
   */
  useEffect(() => {
    const cancel = () => stopRestoreHold()
    const el = containerRef.current
    const passive = { passive: true }
    el?.addEventListener('wheel', cancel, passive)
    el?.addEventListener('touchstart', cancel, passive)
    el?.addEventListener('pointerdown', cancel, passive)
    window.addEventListener('keydown', cancel)
    return () => {
      el?.removeEventListener('wheel', cancel)
      el?.removeEventListener('touchstart', cancel)
      el?.removeEventListener('pointerdown', cancel)
      window.removeEventListener('keydown', cancel)
    }
  }, [stopRestoreHold])

  // 卸载时把复位窗口停掉（否则帧回调会在组件没了之后继续写 DOM）
  useEffect(() => stopRestoreHold, [stopRestoreHold])

  /**
   * 切会话：**上一段的意图不代表这一段**。这里只是把意图拨回「贴底」——真正的贴底由
   * `settleToBottom` 做（它靠 `needInitialBottomRef`，不读这里）。不拨的话，上一会话「读到一半」
   * 的偏移会在新会话里被当成复位目标。
   */
  useLayoutEffect(() => {
    // 切会话也是「上一段的复位窗口作废」的时刻：它还在跑就会把旧锚点写进新会话
    stopRestoreHold()
    intentRef.current = { atEnd: true, offset: 0, anchor: null }
    lastTotalSizeRef.current = 0
  }, [sessionId, stopRestoreHold])

  /**
   * 内容总高从塌陷里重建（例如窗口最小化期间行没布局 → 总高被夹掉，恢复后重新测出来）：
   * 容器尺寸没变，上面的 RO 唤不醒，补在这里。
   * ⚠️ 只认「上一拍不足一屏（塌陷）→ 现在长出来了」：正常增长（流式 / 行内展开）位置本来就对，
   * 抢着写会把用户正在读的位置推走。
   */
  useLayoutEffect(() => {
    const el = containerRef.current
    const total = rowVirtualizer.getTotalSize()
    const prev = lastTotalSizeRef.current
    lastTotalSizeRef.current = total
    if (!el || total <= prev || prev >= el.clientHeight) return
    restoreLostPosition()
  })

  /**
   * 滚到底部并等布局稳定后显示：markdown / canvas / 图片首帧后仍会异步改高度（虚拟列表还有
   * 估算→实测），立即显示会看到跳动。每 50ms 轮询 scrollHeight：连续 3 次（~150ms）无变化
   * 视为稳定；流式回复中高度不可能稳定 → 直接显示；超过 MAX_SETTLE_POLLS 兜底显示，绝不无限隐藏。
   */
  const settleToBottom = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    if (settleTimerRef.current) clearInterval(settleTimerRef.current)
    settleTimerRef.current = null
    const scrollToEnd = () => {
      const count = rowsRef.current.length
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

  useLayoutEffect(() => {
    const count = messages.length
    if (count === 0) {
      // 空会话（没消息 / 懒加载未完成或失败 / 刚被清空）：没有高度要等稳定，直接取消隐藏 ——
      // 否则 hide 会停在切会话时置的 true（opacity:0），看起来像「列表是空的」，与加载失败无法区分。
      setHide(false)
      return
    }
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
        jumpTo(rowIndexOfMessageRef.current[idx] ?? idx)
        return
      }
    }
    // 回补历史：用回补前抓的语义锚点校对滚动位置（跳转优先，故放在跳转之后）
    const olderAnchor = olderAnchorRef.current
    if (olderAnchor) {
      olderAnchorRef.current = null
      applyOlderAnchor(olderAnchor)
    }
    if (needInitialBottomRef.current) {
      // 切会话 / 首次打开：容器隐藏，等布局稳定后滚到底部再显示
      needInitialBottomRef.current = false
      settleToBottom()
      return
    }
    const last = messages[count - 1]
    if (last?.role === 'user') {
      // 用户刚发送消息 → 立即滚动到底部（行下标 = 末行）
      setHide(false)
      rowVirtualizer.scrollToIndex(rowsRef.current.length - 1, {
        align: 'end',
        behavior: 'auto',
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    /** 滚动停止后强制重新测量已渲染条目（修正平滑滚动/流式增长期间的高度漂移） */
    let remeasureTimer: ReturnType<typeof setTimeout> | null = null
    function remeasureRenderedItems() {
      const root = containerRef.current
      if (!root) return
      const nodes = root.querySelectorAll<HTMLElement>('.message-item-wrap')
      nodes.forEach((node) => rowVirtualizer.measureElement(node))
      // 顺带刷新未测量条目的估算高度
      refreshEstimatedItemHeight()
    }

    /**
     * 当前活跃的用户消息锚点。虚拟滚动下只有视口附近条目被渲染，遍历 DOM 会在视口内没有 user
     * 消息时找不到元素；改用「滚动偏移 → 消息实测起始位置」的几何计算，与 DOM 是否渲染无关
     *（取哪一条见 `pickActiveAnchorUser`）。
     */
    function updateActiveDot() {
      const el = containerRef.current
      if (!el) return
      const list = messagesRef.current
      if (list.length === 0) return
      // measurements[i].start 即第 i 条消息在内容坐标系中的顶部，与渲染无关
      const measurements = rowVirtualizer.measurementsCache
      const next = pickActiveAnchorUser(
        list,
        (i) => measurements[rowIndexOfMessageRef.current[i]]?.start,
        el.scrollTop + el.clientHeight,
      )
      if (next !== activeMsgIdRef.current) {
        activeMsgIdRef.current = next
        setActiveUserMsgId(next)
      }
    }

    function onScroll() {
      // container 是上层 const 的窄化结果；函数声明会被提升，TS 不再保留窄化，故显式断言
      const { scrollTop, scrollHeight, clientHeight } = container!
      const distFromBottom = scrollHeight - clientHeight - scrollTop

      // 记住「离开这一屏时在哪」：位置被浏览器挪走（窗口最小化 / 恢复、面板占满）后靠它复位。
      // ⚠️ 复位窗口期间不记：那几拍的偏移是浏览器夹出来的，记下来就把真正的锚点覆盖掉了。
      if (!restoringRef.current) {
        intentRef.current = nextIntent(
          intentRef.current,
          { scrollTop, scrollHeight, clientHeight },
          anchorAt(rowVirtualizer.measurementsCache, scrollTop),
        )
      }

      updateActiveDot()

      // 滚动到底部按钮：距底部 > 80% 视口高时显示
      const btnShouldShow = distFromBottom > clientHeight * 0.8
      if (btnShouldShow !== showScrollBtnRef.current) {
        showScrollBtnRef.current = btnShouldShow
        setShowScrollToBottomBtn(btnShouldShow)
      }
      lastScrollTopRef.current = scrollTop

      // 向上滚动 → 预取更早历史
      const sid = chatState.value.currentSessionId
      if (
        scrollTop < SCROLL_TOP_THRESHOLD &&
        sid &&
        sessionStore.hasMoreMessages(sid)
      ) {
        void loadOlder()
      }

      // 滚动停止后重新测量：平滑跳转时虚拟库跳过「途经」条目的测量，它们会按估算高度
      // 摆放而与相邻条目重叠；静止后统一校正一次。
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

  useLayoutEffect(() => {
    if (!hasMoreInDb || loadingOlderRef.current) return
    const el = containerRef.current
    if (!el) return
    if (rowVirtualizer.getTotalSize() <= el.clientHeight) {
      void loadOlder()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length, hasMoreInDb])

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
    const count = rowsRef.current.length
    if (count === 0) return
    // 流式回复中底部高度每个 token 都在增长，距离超过一屏时反复以 smooth 重发 scrollTo
    // 会不断重启平滑动画（抽搐）；故目标移动时只能用瞬时滚动，落到底后由贴底跟随接管。
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
