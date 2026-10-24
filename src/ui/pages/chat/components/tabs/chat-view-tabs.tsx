/**
 * 视图切换 tab（对话 / 轨迹）—— 位置与视觉对齐 dsh：header 正下方一条**纯文字** tab，
 * 选中项走品牌色 + 2px 下划线（下划线压住 header 的底边）。切换只是换「同一份消息的
 * 两种看法」，数据不重新加载、流式回答在两种视图下都照常长出来。
 */
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
  return (
    <div className="chat-view-tabs" role="tablist">
      {TABS.map((tab) => {
        const active = tab.id === value
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            className={`chat-view-tab${active ? ' is-active' : ''}`}
            onClick={() => onChange(tab.id)}>
            {t(tab.label)}
          </button>
        )
      })}
    </div>
  )
}
