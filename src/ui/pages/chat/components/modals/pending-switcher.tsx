/**
 * pending-switcher — 「待应答交互」切换条：一次只展示一个弹窗，由它告诉用户**还有几个**、分别是什么，
 * 点一下就能切过去（先去回答别的，再切回来继续答）。
 *
 * 为什么必须存在：并发挂起的交互如果只是「排成一队」，用户就只知道眼前这一个 —— 排查问题时更常见的
 * 是「另一个会话在等授权、这边 AI 又提了个问题」，看不见的那个会被无限期搁置（引擎一直在等回执）。
 *
 * ⚠️ 只在待处理 ≥ 2 时渲染：只有一个交互时它没有「还有别的」可提示，纯噪音。
 * ⚠️ 位置固定在自绘标题栏下方居中（见 .scss）：不压标题栏的拖拽区与窗口按钮，也不压底部输入框；
 * z-index 高于弹窗，任何弹窗都盖不住它。
 * ⚠️ 这里只负责「显示与点击」：切换动作走 `onSwitch`，队列状态在 `pending-interactions.ts`。
 */
import { t, tpl } from '@/ui/i18n'
import { pendingLabel, type PendingInteraction } from './pending-interactions'
import './pending-switcher.scss'

interface Props {
  /** 待应答交互（按到达顺序，序号就是列表顺序） */
  items: PendingInteraction[]
  /** 当前展示项（未命中时不高亮任何一项） */
  activeId: string | null
  /** 还没被展示过的项（打「未读」点，切过去后消失） */
  unread: string[]
  onSwitch: (interactionId: string) => void
}

export default function PendingSwitcher({
  items,
  activeId,
  unread,
  onSwitch,
}: Props) {
  if (items.length < 2) return null
  return (
    <div
      className="pending-switcher"
      role="group"
      aria-label={t('待处理的交互')}>
      <span className="pending-switcher__count">
        {tpl('$__count__ 个待处理', { count: items.length })}
      </span>
      <div className="pending-switcher__list">
        {items.map((item, index) => {
          const isActive = item.interactionId === activeId
          const isUnread = unread.includes(item.interactionId)
          const label = pendingLabel(item)
          const kind = item.kind === 'choice' ? t('提问') : t('授权')
          return (
            <button
              key={item.interactionId}
              type="button"
              className={
                'pending-switcher__item' +
                (isActive ? ' is-active' : '') +
                (isUnread ? ' is-unread' : '')
              }
              aria-current={isActive ? 'true' : undefined}
              title={`${index + 1}. ${kind}：${label}`}
              onClick={() => onSwitch(item.interactionId)}>
              <span className="pending-switcher__index">{index + 1}</span>
              <span className="pending-switcher__kind">{kind}</span>
              <span className="pending-switcher__label">{label}</span>
            </button>
          )
        })}
      </div>
      <span className="pending-switcher__hint">{t('Alt + ←/→')}</span>
    </div>
  )
}
