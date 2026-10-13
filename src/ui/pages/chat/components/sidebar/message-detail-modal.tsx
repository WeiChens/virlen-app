/**
 * message-detail-modal — 「导入知识库」消息选择列表右键菜单里的「查看详情」。
 *
 * 列表预览行是 60 字截断的单行，选不选这条往往取决于完整正文 / 思考过程 / 工具调用，
 * 所以这里原样给全文（唯一不做省略的地方），把「选的到底是什么」摊开给用户看。
 *
 * 层级：嵌套在外层「导入会话到知识库」弹窗之上 —— 共享 Modal 的 Esc 只关最上层，不会一按关两层。
 */
import Modal from '@/ui/components/shared/Modal'
import type { Message } from '@/types'
import { t, tpl, getCurrentLanguage } from '@/ui/i18n'
import { extractPlainText } from './session-text'
import { ROLE_ICON, DEFAULT_ROLE_ICON, roleLabel } from './message-role'

interface Props {
  message: Message
  /** 消息在会话里的序号（从 1 开始，与列表顺序一致） */
  seq: number
  onClose: () => void
}

/**
 * 绝对时间。不用 timeFormat 的相对时间（「3 分钟前」）：详情是拿来核对内容的，
 * 用户会拿它跟会话里的时间戳对照（口径同 export-service::messageTime）。
 */
function absoluteTime(ts: number): string {
  return new Date(ts).toLocaleString(getCurrentLanguage(), { hour12: false })
}

/** 非文本块的占位标记（图片 / 文件 / 引用 / 技能 / 工具块），否则详情里会「凭空少一段」 */
function nonTextParts(message: Message): string[] {
  const content = message.content
  if (!Array.isArray(content)) return []
  return content
    .filter(
      (c) =>
        c.type !== 'text' &&
        !(c.type === 'tool_result' && typeof (c as { content?: unknown }).content === 'string'),
    )
    .map((c) => `[${c.type}]`)
}

export default function MessageDetailModal({ message, seq, onClose }: Props) {
  const text = extractPlainText(message.content)
  const parts = nonTextParts(message)
  const toolCalls = message.toolCalls ?? []

  return (
    <Modal
      visible
      title={t('消息详情')}
      onClose={onClose}
      width={640}
      className="msg-detail-modal">
      <div className="msg-detail">
        <div className="msg-detail-meta">
          <span className="msg-detail-role">
            {ROLE_ICON[message.role] ?? DEFAULT_ROLE_ICON} {roleLabel(message.role)}
          </span>
          <span>{tpl('第 $__index__ 条', { index: seq })}</span>
          <span>{absoluteTime(message.timestamp)}</span>
          {message.model && <span>{message.model}</span>}
        </div>

        <pre className="msg-detail-text">
          {text || (parts.length === 0 ? t('无正文内容') : '')}
        </pre>
        {parts.length > 0 && (
          <div className="msg-detail-parts">{parts.join(' ')}</div>
        )}

        {message.reasoningContent && (
          <div className="msg-detail-section">
            <div className="msg-detail-title">{t('思考过程')}</div>
            <pre className="msg-detail-text">{message.reasoningContent}</pre>
          </div>
        )}

        {toolCalls.length > 0 && (
          <div className="msg-detail-section">
            <div className="msg-detail-title">{t('工具调用')}</div>
            {toolCalls.map((tc) => (
              <div key={tc.id} className="msg-detail-call">
                <div className="msg-detail-call-name">{tc.name}</div>
                <pre className="msg-detail-text">
                  {JSON.stringify(tc.input, null, 2)}
                </pre>
              </div>
            ))}
          </div>
        )}

        {message.toolCallId && (
          <div className="msg-detail-id">
            {tpl('工具调用 ID：$__id__', { id: message.toolCallId })}
            {message.isError && ` · ${t('执行失败')}`}
          </div>
        )}
      </div>
    </Modal>
  )
}
