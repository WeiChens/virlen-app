/**
 * VirtualMarkdown — 文件预览的 markdown 虚拟渲染（只在预览分支用；聊天区不走这里）。
 *
 * 为什么虚拟化：预览的 md 是**一次性完整内容**（不像聊天在流式增长），几 MB 的 md 全量渲染会
 * 挂几十万节点把面板卡死。做法：`mdBlocks.ts` 把全文按顶层块切成安全片段，`@tanstack/react-virtual`
 * 只渲染视口附近的片段，行高交给 measureElement 实测（markdown 块高度差异极大，估不准）。
 *
 * 关键取舍：
 * - 总长小于 `MIN_VIRTUALIZE_CHARS` 时直接走整篇渲染（与原行为完全一致，切分纯亏）；
 * - 滚动容器就是 `.wfp-preview`（预览面板原来就在这里滚），不用另建滚动层；
 * - 片段切分是纯文本操作，`useMemo` 按 content 缓存：编辑切换回预览时切分不重跑；
 * - 渲染用聊天区同一套 `MarkdownRenderer`（非 streaming），图片 / 链接 / 代码高亮口径不变。
 */
import { useMemo, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import MarkdownRenderer from '@/ui/pages/chat/components/message/markdown-renderer'
import { splitMarkdownBlocks, MIN_VIRTUALIZE_CHARS } from './mdBlocks'
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

  if (plain) {
    return (
      <div className="wfp-preview">
        <MarkdownRenderer content={content} onLocalLink={onLocalLink} />
      </div>
    )
  }

  return (
    <div className="wfp-preview virtual-md" ref={scrollRef}>
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
  )
}

export { MIN_VIRTUALIZE_CHARS }
