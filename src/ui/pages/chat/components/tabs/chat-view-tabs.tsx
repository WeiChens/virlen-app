/**
 * 视图切换 tab（对话 / 轨迹）—— 位置与视觉对齐 dsh：header 正下方一条**纯文字** tab，
 * 选中项走品牌色 + 2px 下划线（下划线压住 header 的底边）。切换只是换「同一份消息的
 * 两种看法」，数据不重新加载、流式回答在两种视图下都照常长出来。
 *
 * 下划线是容器上的一条共享线（见 style.scss 的 `::after`），这里只负责把选中 tab 的
 * 实测坐标写进 CSS 变量——换 tab 时它靠 transform 平移过去，而不是原地淡入淡出。
 */
import { useCallback, useLayoutEffect, useRef } from 'react'
import { t } from '@/ui/i18n'
import './style.scss'

/** 消息区的两种看法（同一份 messages） */
export type ChatViewTab = 'chat' | 'trajectory'

export interface ChatViewTabsProps {
  /** 当前选中的视图 */
  value: ChatViewTab
  /** 选中视图变化（点击 tab） */
  onChange: (next: ChatViewTab) => void
}

/** tab 列表：顺序即展示顺序（对话在前，与 dsh 的 chat=0 / trajectory=10 一致） */
const TABS: readonly { id: ChatViewTab; label: string }[] = [
  { id: 'chat', label: '对话' },
  { id: 'trajectory', label: '轨迹' },
]

export function ChatViewTabs({ value, onChange }: ChatViewTabsProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const tabRefs = useRef(new Map<ChatViewTab, HTMLButtonElement>())

  /** 把选中 tab 的位置 / 宽度同步给下划线；用 rect 而不是 offsetLeft，
   *  避免 offsetParent 的 border / padding 基准差一截 */
  const syncUnderline = useCallback(() => {
    const wrap = wrapRef.current
    const btn = tabRefs.current.get(value)
    if (!wrap || !btn) return
    const wrapRect = wrap.getBoundingClientRect()
    const btnRect = btn.getBoundingClientRect()
    wrap.style.setProperty('--tab-underline-x', `${btnRect.left - wrapRect.left}px`)
    wrap.style.setProperty('--tab-underline-w', `${btnRect.width}px`)
  }, [value])

  // layout effect：首帧前就写好变量，否则挂载时会从 0 宽「长」出来
  useLayoutEffect(syncUnderline, [syncUnderline])

  // 窗口缩放 / 字体加载完改字号，tab 宽度会变，下划线得跟着重算
  useLayoutEffect(() => {
    const wrap = wrapRef.current
    if (!wrap || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(syncUnderline)
    ro.observe(wrap)
    for (const el of tabRefs.current.values()) ro.observe(el)
    return () => ro.disconnect()
  }, [syncUnderline])

  return (
    <div className="chat-view-tabs" role="tablist" ref={wrapRef}>
      {TABS.map((tab) => {
        const active = tab.id === value
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            className={`chat-view-tab${active ? ' is-active' : ''}`}
            ref={(el) => {
              if (el) tabRefs.current.set(tab.id, el)
              else tabRefs.current.delete(tab.id)
            }}
            onClick={() => onChange(tab.id)}>
            {t(tab.label)}
          </button>
        )
      })}
    </div>
  )
}
