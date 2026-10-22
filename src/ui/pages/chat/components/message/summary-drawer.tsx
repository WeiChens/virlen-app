/**
 * SummaryDrawer — 上下文压缩摘要的详情：**从右侧滑入的抽屉**（与设置页 / 用量统计同一套观感）。
 *
 * 为什么是抽屉（而不是原来那个居中弹窗 `SummaryModal`）：
 * 1. **正文极长**（正文压缩产物可达数万字符）：抽屉给的是整条高度 + 自己的滚动条，
 *    居中弹窗只能挤出一个短胖的框；
 * 2. **不挤布局**：它是浮层（`position: fixed` + portal 到 body），打开 / 关闭都不会改变
 *    消息列表的宽度 —— 面板塞在消息流旁边的老方案会让虚拟列表重排、滚动位置跳；
 * 3. **close 习惯现成**：点遮罩 / Esc / 右上角 × 与设置页一致，用户不用另学一套。
 *
 * ⚠️ 正文只在这里渲染一次；抽屉关掉即卸载（既不进虚拟列表，也不缓存 DOM）。
 */
import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import CloseSvg from '@/ui/components/icons/CloseSvg'
import type { Message } from '@/types'
import { t } from '@/ui/i18n'
import MarkdownRenderer from './markdown-renderer'
import { summaryMetaText, summaryText } from './summary-meta'
import './summary-drawer.scss'

interface Props {
  message: Message
  onClose: () => void
}

function SummaryDrawer({ message, onClose }: Props) {
  const panelRef = useRef<HTMLElement>(null)

  // Esc 关闭（与设置页 / 用量统计同一习惯）：捕获阶段先接住，别让宿主里的其它 Esc 抢走
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [onClose])

  // 打开即把焦点收进抽屉：键盘用户不必再从页面顶部逐个 Tab
  useEffect(() => {
    panelRef.current?.focus()
  }, [])

  const text = summaryText(message)

  // portal 到 body：消息行在虚拟列表里（绝对定位、随时可能被卸载），fixed 浮层挂在行内不可靠
  return createPortal(
    <div className="summary-drawer-overlay">
      <div
        className="summary-drawer-mask"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        ref={panelRef}
        className="summary-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={t('上下文压缩摘要')}
        tabIndex={-1}>
        <header className="summary-drawer-head">
          <h3 className="summary-drawer-title">{t('上下文压缩摘要')}</h3>
          <button
            type="button"
            className="summary-drawer-close"
            onClick={onClose}
            title={t('关闭')}
            aria-label={t('关闭')}>
            <CloseSvg />
          </button>
        </header>

        <div className="summary-drawer-meta">{summaryMetaText(message)}</div>

        <div className="summary-drawer-body">
          {text ? (
            <MarkdownRenderer content={text} isUser={false} streaming={false} />
          ) : (
            <p className="summary-drawer-empty">{t('（无内容）')}</p>
          )}
        </div>
      </aside>
    </div>,
    document.body,
  )
}

export default SummaryDrawer
