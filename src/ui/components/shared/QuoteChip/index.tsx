/**
 * QuoteChip — 引用消息标签（输入框 / 消息气泡共用）
 *
 * 只承载「被引用消息的元数据 + 正文快照」：
 *   [发送方图标] 发送方 [正文摘要] [×]
 *
 * - hover 显示完整正文 + 消息 id（正文快照与 id 才是这条数据的本体，必须可核对）
 * - 传入 onClick 时主体可点击（跳转定位到被引用的原消息）；传入 onRemove 时显示移除按钮
 * - 正文快照可能来自已被删除 / 已被上下文压缩的原消息，所以整块不依赖原消息是否还在
 */
import UserSvg from '@/ui/components/icons/UserSvg'
import { t, tpl } from '@/ui/i18n'
import './style.scss'
import AgentSvg from '../../icons/AgentSvg'

interface Props {
  /** 被引用消息的发送方 */
  role: 'user' | 'assistant'
  /** 被引用消息正文 */
  text: string
  /** 被引用消息 id（在 title 里展示，便于核对） */
  messageId?: string
  /** 点击主体（跳转到原消息） */
  onClick?: () => void
  /** 移除该引用 */
  onRemove?: () => void
  className?: string
}

function QuoteChip({
  role,
  text,
  messageId,
  onClick,
  onRemove,
  className,
}: Props) {
  const senderLabel = role === 'user' ? t('你') : t('AI')
  // title 里给全文 + id：正文可能被 UI 省略，但模型看到的与用户核对到的必须是同一份
  const title = [
    tpl('引用 $__sender__ 的消息', { sender: senderLabel }),
    text,
    messageId ? tpl('消息 ID：$__id__', { id: messageId }) : '',
  ]
    .filter(Boolean)
    .join('\n')

  const body = (
    <>
      <span className="quote-chip-bar" aria-hidden="true" />
      <span className="quote-chip-icon">
        {role === 'user' ? <UserSvg /> : <AgentSvg />}
      </span>
      {/* <span className="quote-chip-sender">{senderLabel}</span> */}
      <span className="quote-chip-text">{text}</span>
    </>
  )

  return (
    <span className={`quote-chip${className ? ` ${className}` : ''}`} title={title}>
      {onClick ? (
        <button
          type="button"
          className="quote-chip-body"
          onClick={onClick}
          aria-label={t('定位到引用的消息')}>
          {body}
        </button>
      ) : (
        <span className="quote-chip-body">{body}</span>
      )}
      {onRemove && (
        <button
          type="button"
          className="quote-chip-remove"
          onClick={onRemove}
          title={t('移除引用')}
          aria-label={tpl('移除引用：$__sender__', { sender: senderLabel })}>
          ✕
        </button>
      )}
    </span>
  )
}

export default QuoteChip
