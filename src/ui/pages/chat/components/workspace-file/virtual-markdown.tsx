/**
 * VirtualMarkdown — 文件预览的 markdown 虚拟渲染（只在预览分支用；聊天区不走这里）。
 *
 * 为什么虚拟化：预览的 md 是**一次性完整内容**（不像聊天在流式增长），几 MB 的 md 全量渲染会
 * 挂几十万节点把面板卡死。做法：`mdBlocks.ts` 把全文按顶层块切成安全片段，`@tanstack/react-virtual`
 * 只渲染视口附近的片段，行高交给 measureElement 实测（markdown 块高度差异极大，估不准）。
 *
 * 关键取舍：
 * - 总长小于 `MIN_VIRTUALIZE_CHARS` 时返回单块 → 走整篇渲染（DOM 结构与原来一致，切分纯亏）；
 * - 滚动容器就是 `.wfp-preview`（预览面板原来就在这里滚），不用另建滚动层；
 * - 片段切分是纯文本操作，`useMemo` 按 content 缓存：编辑切换回预览时切分不重跑；
 * - 渲染用聊天区同一套 `MarkdownRenderer`（非 streaming），图片 / 链接 / 代码高亮口径不变。
 *
 * 🔍 查找（Ctrl/Cmd+F，见 `md-find.ts` / `md-find-widget.tsx`）：虚拟列表里没滚到的块不在 DOM 中，
 * 浏览器自带的查找根本搜不到，所以自己实现「源码级匹配 + 按块跳转 + 尽力高亮」——
 * 匹配在块文本上算（命中数是全量的），跳转用 `scrollToIndex`，高亮只画在已挂载的块上。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import { useVirtualizer, type VirtualItem, type Virtualizer } from '@tanstack/react-virtual'
import MarkdownRenderer from '@/ui/pages/chat/components/message/markdown-renderer'
import { splitMarkdownBlocks, MIN_VIRTUALIZE_CHARS } from './mdBlocks'
import {
  applyFindHighlights,
  clearFindHighlights,
  findMatches,
  isTextEditingElement,
  selectionToQuery,
  FIND_INPUT_ATTR,
} from './md-find'
import MdFindWidget from './md-find-widget'
import './virtual-markdown.scss'

/** 未测量前的估算块高：只决定首帧占位，测过即被真实值取代 */
const ESTIMATED_BLOCK_HEIGHT = 120
/** 视口外上下多渲染几块 */
const OVERSCAN = 6

/**
 * 首测补偿的容差：条目顶部在视口上方不足这个距离时，不再调 scrollTop。
 * 首测分支（isFirstMeasure）只看 `itemStart < scrollOffset`，被 overscan 提前挂载的
 * 顶部附近块一实测就会触发补偿 —— 向上滚时表现为视口内容突然整体位移（抽搐）。
 * 跳转 / 锚点场景的偏移远大于这个值，不受影响。
 */
const FIRST_MEASURE_TOLERANCE = 240

const SCROLL_MARGIN = 12

/**
 * 宽度变化后等多少帧才算「稳定」：面板的 `transition: width 200ms` 跑完后 RO 还会
 * 再报一拍（rAF 延迟），给 3 帧余量（≈48ms）让它收敛。
 */
const WIDTH_STABLE_FRAMES = 3

interface Props {
  content: string
  /** 本地文件链接接管（与 MarkdownRenderer 同义，透传下去） */
  onLocalLink?: (href: string) => void
}

export default function VirtualMarkdown({ content, onLocalLink }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  /** 包一层（查找浮层的定位基准 + 找自己那个输入框） */
  const wrapRef = useRef<HTMLDivElement>(null)

  const blocks = useMemo(() => splitMarkdownBlocks(content), [content])
  // 短文档只有一块 → 不值得虚拟化，直接整篇渲染（DOM 结构与原来一致）
  const plain = blocks.length <= 1

  /**
   * 容器**宽度**正在变化（面板展开 / 收起 / 拖宽的过渡期）：
   * 期间所有块都会被重测（文本折行变了 → 高度变了），但绝不能让虚拟库据此补偿
   * scrollTop —— 那会把阅读位置逐帧推走（宽度变 → 折行变 → 视口上方块高度变 →
   * 库补偿 → scrollTop 被推下去 → 又一批块进视口被重测 → 循环到过渡结束）。
   * 宽度稳定后再按记住的 scrollTop 校正一次（折行变了总高也变了，位置可能差一点）。
   *
   * · `widthChanging` = 正在过渡中（`shouldAdjustScrollPositionOnItemSizeChange` 读它 → 全禁补偿）；
   * · `anchorTop` / `anchorKey` = 过渡开始那一刻「视口顶端压在哪一块的什么位置」，
   *   稳定后用它 + 重新测出的块位置校正 scrollTop（块高度变了，同一个 key 的 start 也变了）。
   */
  const widthChangeRef = useRef<{
    changing: boolean
    stableFrames: number
    anchorKey: VirtualItem['key'] | null
    anchorDelta: number
    scrollTop: number
  }>({ changing: false, stableFrames: 0, anchorKey: null, anchorDelta: 0, scrollTop: 0 })

  const virtualizer = useVirtualizer({
    count: blocks.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_BLOCK_HEIGHT,
    // 用块首行文本做 key：内容编辑后未变的块能沿用测量缓存
    getItemKey: (index) => {
      const b = blocks[index] ?? ''
      return `${index}:${b.length}:${b.slice(0, 32)}`
    },
    overscan: OVERSCAN,
    // 滚动容器有 padding（.wfp-preview 的 12px 14px）：虚拟块坐标从内容区起算，
    // 必须扣掉左右 padding（横向 padding 决定测量原点），否则首块被推开、末尾多一段空白
    scrollMargin: 12,
    // 测量发生在提交阶段，库同步改 scrollTop 会在渲染中 flushSync(rerender) → React 告警
    useFlushSync: false,
    // ⚠️ 该字段已在 virtual-core 3.17.10 运行时支持（见其 esm/index.js 的 measureNode），
    // 但 VirtualizerOptions 类型尚未声明，这里用断言透传，等上游补齐类型后可去掉。
    ...( {
      // 向上滚动时不要补偿 scrollTop：未测量块（估算 120px）实测后普遍变大，
      // 内容在视口上方膨胀时库若调整 scrollTop，整个预览会「抽一下」跳到别处。
      // 这里接管补偿判定：完全在视口上方较远处才补偿（跳转/锚点场景），
      // 视口附近（容差内）与向上滚动中一律不补偿。
      //
      // ⚠️ 容器宽度正在变化时（面板展开/收起/拖宽的过渡期）一律不补偿：
      // 文本折行变 → 视口上方的块高度逐批变 → 库若补偿会把 scrollTop 一步步推走，
      // 用户看到的就是「内容往下跑了」。宽度稳定后由外层的 rAF 校正一次位置。
      shouldAdjustScrollPositionOnItemSizeChange: (
        item: VirtualItem,
        _delta: number,
        instance: Virtualizer<HTMLDivElement, Element>,
      ) => {
        if (widthChangeRef.current.changing) return false
        const offset = instance.scrollOffset + instance.scrollAdjustments
        if (instance.scrollDirection === 'backward') return false
        if (item.end <= offset) return true
        return offset - item.start > FIRST_MEASURE_TOLERANCE
      },
    } as Partial<Parameters<typeof useVirtualizer>[0]> ),
  })

  /**
   * 容器宽度变化检测：面板展开 / 收起 / 拖宽时有 200ms 的 `transition: width`，
   * 期间文本折行逐帧变 → 块高度逐批变 → 虚拟库重测。
   *
   * 这里在宽度变化的第一帧：
   * 1. 抓住「此刻视口顶端压在哪一块」（anchor key + 块内偏移）；
   * 2. 置 `changing = true`（`shouldAdjustScrollPositionOnItemSizeChange` 读它 → 全禁补偿）；
   *
   * 宽度稳定后（连续 N 帧不再变）：
   * 3. 用同一个 anchor key 在重测后的 measurementsCache 里查它的新 start；
   * 4. `scrollTop = newStart + anchorDelta` —— 折行变了块高度也变了，但用户压着的那一条
   *    内容块的顶部还是应该在同一个偏移上。
   *
   * ⚠️ 只管宽度，不管高度：高度变化是宽度变化的后果（折行变了），不是独立事件。
   * 拖宽手柄期间面板的 `.is-resizing` 关掉了过渡，宽度跟手走——那也走这条路径，
   * 但宽度一帧一帧地变、每一帧都重测重校正，观感就是「内容跟着手走不跳」。
   */
  useEffect(() => {
    if (plain) return // 整篇渲染没有虚拟层，浏览器自己管 scrollTop
    const el = scrollRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    let lastWidth = el.clientWidth
    let rafId: number | null = null

    const onWidthChange = () => {
      const cur = scrollRef.current
      if (!cur) return
      const width = cur.clientWidth
      if (width === lastWidth) return
      // 宽度变了：如果还没在 changing 中，抓住此刻的阅读错点
      const state = widthChangeRef.current
      if (!state.changing) {
        const items = virtualizer.getVirtualItems()
        const scrollTop = cur.scrollTop
        if (items.length > 0) {
          // 视口顶端压在哪个块上（items 按 start 升序）
          let hit = items[0]
          for (const vi of items) {
            if (vi.start <= scrollTop) hit = vi
            else break
          }
          state.anchorKey = hit.key
          state.anchorDelta = scrollTop - hit.start
        } else {
          state.anchorKey = null
          state.anchorDelta = 0
        }
        state.scrollTop = scrollTop
        state.changing = true
        state.stableFrames = 0
      }
      lastWidth = width
      // 每次宽度变化都重置稳定计数
      state.stableFrames = 0

      // 用 rAF 轮询：宽度不再变化后连续 N 帧才收（过渡结束 + RO 的 rAF 延迟）
      if (rafId !== null) cancelAnimationFrame(rafId)
      const tick = () => {
        rafId = null
        const s = widthChangeRef.current
        if (!s.changing) return
        const el = scrollRef.current
        if (!el) {
          s.changing = false
          return
        }
        if (++s.stableFrames >= WIDTH_STABLE_FRAMES) {
          // 宽度已稳定：校正 scrollTop
          s.changing = false
          if (s.anchorKey !== null) {
            // 在重测后的 measurementsCache 里查 anchor key 的新 start
            const measurements = virtualizer.measurementsCache
            const idx = measurements.findIndex(
              (m) => m.key === s.anchorKey,
            )
            if (idx >= 0) {
              const target = measurements[idx].start + s.anchorDelta
              if (Math.abs(el.scrollTop - target) > 1) {
                el.scrollTop = target
                virtualizer.scrollOffset = target
              }
            }
          }
          return
        }
        rafId = requestAnimationFrame(tick)
      }
      rafId = requestAnimationFrame(tick)
    }

    const observer = new ResizeObserver(() => onWidthChange())
    observer.observe(el)
    return () => {
      observer.disconnect()
      if (rafId !== null) cancelAnimationFrame(rafId)
      widthChangeRef.current.changing = false
    }
  }, [plain, virtualizer])

  // ==================== 查找（Ctrl/Cmd+F） ====================
  const [findOpen, setFindOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  /** 当前命中下标（0 基）；靠 `activeMatch` 收敛到有效范围 */
  const [current, setCurrent] = useState(0)
  /** 每次 Ctrl+F 自增：让浮层重新聚焦并全选（选中的文本要先写进查询再全选） */
  const [focusSignal, setFocusSignal] = useState(0)

  const matches = useMemo(
    () => findMatches(blocks, query, caseSensitive),
    [blocks, query, caseSensitive],
  )
  const active = matches.length === 0 ? -1 : Math.min(current, matches.length - 1)
  const activeMatch = active >= 0 ? matches[active] : null

  // 查询 / 大小写变了：回到第一处命中
  useEffect(() => {
    setCurrent(0)
  }, [query, caseSensitive])

  const jumpTo = useCallback(
    (index: number) => {
      const match = matches[index]
      // 整篇渲染没有虚拟层，滚动交给下面的 Range 兜底
      if (!match || plain) return
      virtualizer.scrollToIndex(match.block, { align: 'center' })
    },
    [matches, plain, virtualizer],
  )

  useEffect(() => {
    if (active >= 0) jumpTo(active)
  }, [active, jumpTo])

  // 高亮：命中 / 当前项 / 已挂载的块集合变化都要重算。
  // 依赖 renderedKey 而不是每次渲染都跑：块集合没变时重复扫 DOM 纯属浪费。
  const renderedKey = plain
    ? 'plain'
    : virtualizer
        .getVirtualItems()
        .map((item) => item.index)
        .join(',')

  useEffect(() => {
    const root = scrollRef.current
    if (!root) return
    if (query === '') {
      clearFindHighlights()
      return
    }
    const blockRoots = Array.from(root.querySelectorAll<HTMLElement>('[data-index]'))
    const result = applyFindHighlights(
      blockRoots,
      query,
      caseSensitive,
      activeMatch ? { block: activeMatch.block, ordinal: activeMatch.ordinal } : null,
    )

    const host = result.current?.startContainer.parentElement
    // 当前命中在**收起的** <details> 里：先把它展开，否则「跳到了但什么都看不见」
    const folded = host?.closest('details')
    if (folded && !folded.open) folded.open = true

    // 整篇渲染（短文档）没有虚拟滚动：把当前命中滚进视野中间
    if (plain && result.current) {
      const rect = result.current.getBoundingClientRect()
      const box = root.getBoundingClientRect()
      if (rect.top < box.top || rect.bottom > box.bottom) {
        const parent = result.current.startContainer.parentElement
        parent?.scrollIntoView({ block: 'center' })
      }
    }
  }, [query, caseSensitive, activeMatch, renderedKey, plain])

  /**
   * 点正文 → 把焦点收回滚动容器（下面 Ctrl+F 的「这个预览在前台」判据要靠它）。
   *
   * ⚠️ 只在「这一下点击没人认领焦点」时才能这么做：Monaco（代码块）在自己的 mousedown 里
   * 刚把隐藏 textarea 聚焦并 `preventDefault()`（浏览器此后不会再纠正焦点），而 React 的
   * 事件委托挂在根容器上 —— 我们这段跑在 Monaco 之后，一 `focus()` 就把焦点从编辑器抢走。
   * 编辑器一失焦：Ctrl+C 的 keydown 进不到它，原生复制也没有选区（Monaco 的选区不进
   * `window.getSelection()`）→ 表现就是「代码块里选中了文本，Ctrl+C 没反应」。
   * 里面的输入控件 / Monaco 自己管焦点，一律不碰。
   */
  const focusPreview = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target instanceof Element ? event.target : null
    if (isTextEditingElement(target)) return
    scrollRef.current?.focus({ preventScroll: true })
  }, [])

  const closeFind = useCallback(() => {
    setFindOpen(false)
    // 关掉就清查询：高亮跟着消失（不然浮层没了还有一片橙色块，看不出是谁画的）
    setQuery('')
  }, [])

  const step = useCallback(
    (delta: number) => {
      if (matches.length === 0) return
      setCurrent((index) => (index + delta + matches.length) % matches.length)
    },
    [matches.length],
  )

  /**
   * Ctrl/Cmd+F → 打开查找浮层；有选中文本时直接拿它当查询词（不看浮层是否已打开）。
   *
   * 只在「这个预览确实是用户眼前那个」时接管：
   * - 浮层已经开着（焦点在自己的输入框，或用户刚点开又去点别处）→ 填词 + 重新聚焦全选；
   * - 焦点在**别的**可编辑控件（Monaco / 聊天输入框 / 设置里那些 input）→ 不抢，让它们自己处理；
   * - 否则要求焦点在面板内，或鼠标正悬在预览上（点过正文后焦点会落到容器上，见 onMouseDown）。
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return
      if (event.key.toLowerCase() !== 'f') return
      const root = scrollRef.current
      // 面板不在前台（别的标签页 / 别的会话桶）时完全不插手
      if (!root || !isVisible(root)) return

      const findInput = wrapRef.current?.querySelector<HTMLInputElement>(
        `[${FIND_INPUT_ATTR}="true"]`,
      )
      const active = document.activeElement
      // 焦点在别人的输入控件里：那边自己处理，哪怕我们的浮层还开着
      if (active !== findInput && isTextEditingElement(active)) return

      // 选中的文本直接当查询词（Monaco 同一套手感）；没选中就沿用原来的词
      const selected = selectedTextIn(root)

      if (findInput) {
        event.preventDefault()
        if (selected) setQuery(selected)
        // 用信号而不是在这里直接 focus：选中文本要先写进查询，输入框才能全选正确的文本
        setFocusSignal((signal) => signal + 1)
        return
      }

      const panel = root.closest('.workspace-file-panel')
      const focusedHere = panel !== null && panel!.contains(active)
      if (!focusedHere && !root.matches(':hover')) return
      event.preventDefault()
      if (selected) setQuery(selected)
      setFindOpen(true)
      setFocusSignal((signal) => signal + 1)
    }

    // 捕获阶段：抢在 Monaco / 浏览器原生查找之前
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  const findWidget = findOpen ? (
    <MdFindWidget
      query={query}
      total={matches.length}
      current={active}
      caseSensitive={caseSensitive}
      focusSignal={focusSignal}
      onQueryChange={setQuery}
      onCaseToggle={() => setCaseSensitive((value) => !value)}
      onPrev={() => step(-1)}
      onNext={() => step(1)}
      onClose={closeFind}
    />
  ) : null

  if (plain) {
    return (
      <div className="wfp-preview-wrap" ref={wrapRef}>
        <div
          className="wfp-preview"
          ref={scrollRef}
          tabIndex={-1}
          onMouseDown={focusPreview}>
          {/* data-index 是查找高亮的锚：整篇渲染也算「第 0 块」，两条路径共用一套高亮代码 */}
          <div data-index={0}>
            <MarkdownRenderer content={content} onLocalLink={onLocalLink} />
          </div>
        </div>
        {findWidget}
      </div>
    )
  }

  return (
    <div className="wfp-preview-wrap" ref={wrapRef}>
      <div
        className="wfp-preview virtual-md"
        ref={scrollRef}
        tabIndex={-1}
        onMouseDown={focusPreview}>
        <div className="virtual-md-inner" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => (
            <div
              key={item.key}
              data-index={item.index}
              ref={virtualizer.measureElement}
              className="virtual-md-item"
              style={{ top: item.start }}>
              <MarkdownRenderer content={blocks[item.index] ?? ''} onLocalLink={onLocalLink} />
            </div>
          ))}
        </div>
      </div>
      {findWidget}
    </div>
  )
}

/**
 * 预览里选中的文本（选区不在预览内则不算，比如聊天消息里的选中）。
 * 提取规则见 `md-find.ts::selectionToQuery`（跨行只取第一行）。
 */
function selectedTextIn(root: HTMLElement): string {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return ''
  const range = selection.getRangeAt(0)
  if (!root.contains(range.commonAncestorContainer)) return ''
  return selectionToQuery(selection.toString())
}

/**
 * 元素是否真的显示在画面上（隐藏的标签页 / 后台会话桶里的预览也在 React 树上）。
 * 支持 `checkVisibility` 就用它（Chromium 105+），不支持时按「可见」处理 ——
 * 误判的代价只是多开一个浮层，比在真实界面里按 Ctrl+F 没反应轻得多。
 */
function isVisible(el: HTMLElement): boolean {
  const check = (el as unknown as { checkVisibility?: (options?: object) => boolean }).checkVisibility
  if (typeof check !== 'function') return true
  return check.call(el, { visibilityProperty: true, checkOpacity: true })
}

export { MIN_VIRTUALIZE_CHARS }
