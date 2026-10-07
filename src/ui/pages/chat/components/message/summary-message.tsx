/**
 * 上下文压缩产物（role='summary'）在消息列表里的呈现。
 * 正文可能极长（正文压缩产物可达数万字符），铺在消息流里既没必要也会让虚拟列表测量 / Markdown 渲染成本飙升
 * —— 故列表只渲染一条紧凑提示条，点击后弹窗看全文。
 *
 * ⚠️ 摘要正文只在弹窗里渲染 —— 提示条本身不得出现正文（回归测试钉住：`src/tests/ui/summary-message.test.tsx`）。
 */
import { useState, type MouseEvent as ReactMouseEvent } from 'react'
import type { Message } from '@/types'
import Modal from '@/ui/components/shared/Modal'
import StatsSvg from '@/ui/components/icons/StatsSvg'
import CollapsedSvg from '@/ui/components/icons/CollapsedSvg'
import MarkdownRenderer from './markdown-renderer'
import { t, tpl } from '@/ui/i18n'
import { timeFormat } from '@/utils/time'
import './summary-message.scss'

/** 12500 → 12.5k（与 token-ring 同一口径：整数 k 不带多余的 .0） */
function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  const k = tokens / 1000
  return `${Number.isInteger(k) ? k.toFixed(0) : k.toFixed(1)}k`
}

/** summary 消息正文 → 纯文本（正常是 string，数组块兜底取 text） */
function summaryText(message: Message): string {
  if (typeof message.content === 'string') return message.content
  return message.content
    .filter((b) => b.type === 'text')
    .map((b) => ('text' in b ? b.text : ''))
    .join('')
}

/**
 * 副标题：压缩方式 +（仅正文压缩）压缩后上下文占用 + 时间。
 * 只有 `compressMode === 'raw'` 才有「压缩后占用」：AI 摘要消息的 `usage` 是摘要调用的消耗、
 * 不是压缩后的上下文大小，拿它当占用展示会误导 → 用 `uiData.contextTokens` 区分。
 */
function metaText(message: Message): string {
  const parts: string[] = []
  const mode = message.uiData?.compressMode
  if (mode === 'raw') parts.push(t('正文压缩'))
  else if (mode === 'ai') parts.push(t('AI 摘要'))

  const tokens = message.uiData?.contextTokens
  if (typeof tokens === 'number' && tokens > 0) {
    parts.push(tpl('压缩后约 $__n__ tokens', { n: formatTokens(tokens) }))
  }
  parts.push(timeFormat(message.timestamp))
  return parts.join(' · ')
}

interface SummaryModalProps {
  visible: boolean
  message: Message
  onClose: () => void
}

/** 摘要全文弹窗（独立导出，便于测试直接渲染展开态） */
export function SummaryModal({ visible, message, onClose }: SummaryModalProps) {
  return (
    <Modal
      visible={visible}
      title={t('上下文压缩摘要')}
      onClose={onClose}
      width={720}
      closeOnClickOutside
      move>
      <div className="compress-summary-modal-meta">{metaText(message)}</div>
      <div className="compress-summary-modal-body">
        <MarkdownRenderer
          content={summaryText(message) || t('（无内容）')}
          isUser={false}
          streaming={false}
        />
      </div>
    </Modal>
  )
}

interface Props {
  message: Message
  /**
   * 右键菜单（由 message-bubble 统一接管）：摘要条目同样支持「复制 / 转移到新对话 / 删除」。
   * 删除 summary = 放弃这次压缩，本条及之后的消息一并删除（二次确认见 `message-bubble`）。不传则不挂监听。
   */
  onContextMenu?: (e: ReactMouseEvent) => void
}

function SummaryMessage({ message, onContextMenu }: Props) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <div className="message-compress-summary" onContextMenu={onContextMenu}>
        <button
          type="button"
          className="compress-summary-card"
          onClick={() => setOpen(true)}
          title={t('点击查看压缩后的摘要')}>
          <StatsSvg className="compress-summary-icon" />
          <span className="compress-summary-main">
            <span className="compress-summary-title">
              {t('上下文已压缩')}
            </span>
            <span className="compress-summary-meta">{metaText(message)}</span>
          </span>
          <CollapsedSvg className="compress-summary-expand" />
        </button>
      </div>
      <SummaryModal
        visible={open}
        message={message}
        onClose={() => setOpen(false)}
      />
    </>
  )
}

export default SummaryMessage
