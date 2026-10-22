/**
 * 上下文压缩产物（role='summary'）在消息列表里的呈现。
 *
 * 正文可能极长（正文压缩产物可达数万字符），铺在消息流里既没必要也会让虚拟列表测量 /
 * Markdown 渲染成本飙升 —— 故列表**只渲染一条紧凑提示条**；点它把全文开到**右侧抽屉**
 * （`summary-drawer`：浮层、不挤布局，点遮罩 / Esc / × 关闭）。
 *
 * ⚠️ 摘要正文只在抽屉里渲染 —— 提示条本身不得出现正文
 * （回归测试钉住：`src/tests/ui/summary-message.test.tsx`）。
 */
import { useState, type MouseEvent as ReactMouseEvent } from 'react'
import type { Message } from '@/types'
import StatsSvg from '@/ui/components/icons/StatsSvg'
import CollapsedSvg from '@/ui/components/icons/CollapsedSvg'
import { t } from '@/ui/i18n'
import { summaryMetaText } from './summary-meta'
import SummaryDrawer from './summary-drawer'
import './summary-message.scss'

interface Props {
  message: Message
  /**
   * 右键菜单（由 message-bubble 统一接管）：摘要条目同样支持「复制 / 转移到新对话 / 删除」。
   * 删除 summary = 放弃这次压缩，本条及之后的消息一并删除（二次确认见 `message-bubble`）。不传则不挂监听。
   */
  onContextMenu?: (e: ReactMouseEvent) => void
}

function SummaryMessage({ message, onContextMenu }: Props) {
  /** 抽屉开关留在本条消息上：每条摘要各看各的，关掉即卸载（正文不常驻） */
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
            <span className="compress-summary-title">{t('上下文已压缩')}</span>
            <span className="compress-summary-meta">{summaryMetaText(message)}</span>
          </span>
          <CollapsedSvg className="compress-summary-expand" />
        </button>
      </div>
      {open && (
        <SummaryDrawer message={message} onClose={() => setOpen(false)} />
      )}
    </>
  )
}

export default SummaryMessage
