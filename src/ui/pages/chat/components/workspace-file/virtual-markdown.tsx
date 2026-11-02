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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
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

/** 滚动容器（.wfp-preview）的 padding：虚拟坐标要扣掉这段（见 virtual-markdown.scss 头注） */
const SCROLL_MARGIN = 14

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
    scrollMargin: SCROLL_MARGIN,
    // 测量发生在提交阶段，库同步改 scrollTop 会在渲染中 flushSync(rerender) → React 告警
    useFlushSync: false,
  })

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
          onMouseDown={() => scrollRef.current?.focus({ preventScroll: true })}>
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
        onMouseDown={() => scrollRef.current?.focus({ preventScroll: true })}>
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
