/**
 * QueryMessagesMessage — list_messages / read_messages 工具调用的消息展示
 *
 * 一行：作用范围（时序区间 / 条数 / 状态）
 * 展开：与下发给模型的文本完全一致的纯文本视图
 *      （正文全文、工具调用摘要；深度思考永不展示）
 */
import { t, tpl } from '@/ui/i18n'
import { IToolCallMessage, ToolMessageProps } from './IToolCallMessage'

class QueryMessagesMessage implements IToolCallMessage {
  getToolName(): string {
    return 'list_messages'
  }

  getToolLabel(type: string): string {
    return type === 'read_messages'
      ? t('读取历史消息')
      : t('列出历史消息')
  }

  getShortText(props: ToolMessageProps): React.ReactNode {
    try {
      const ui = props.message?.uiData as any
      const status = ui?.status
      if (status === 'not_compressed') {
        return <span style={{ color: '#999' }}>{t('未压缩，无需查询')}</span>
      }
      if (status === 'in_context') {
        return <span style={{ color: '#999' }}>{t('已在上下文中')}</span>
      }
      if (status === 'not_found') {
        return <span style={{ color: '#999' }}>{t('未找到该消息')}</span>
      }
      if (!ui) {
        return t('查询历史消息')
      }
      if (ui.mode === 'window') {
        return (
          <span>
            {tpl('读取 $__range__', {
              range: `#${ui.startSeq}–#${ui.endSeq}`,
            })}
          </span>
        )
      }
      const items = (ui.items as any[]) || []
      if (items.length === 0) {
        return <span style={{ color: '#999' }}>{t('暂无结果')}</span>
      }
      const first = items[0].seq
      const last = items[items.length - 1].seq
      return (
        <span>
          {tpl('时序 $__range__（$__count__ 条）', {
            range: `#${first}–#${last}`,
            count: items.length,
          })}
        </span>
      )
    } catch {
      return t('解析异常')
    }
  }

  getExpandView(props: ToolMessageProps): React.ReactNode {
    const content = props.message?.content as string | undefined
    if (props.message?.isError) {
      return <div className="error">{content}</div>
    }
    if (!content) return null
    return (
      <pre
        style={{
          whiteSpace: 'pre-wrap',
          margin: 0,
          fontSize: 'var(--font-size-sm)',
          lineHeight: 1.6,
        }}>
        {content}
      </pre>
    )
  }

  diyWrapper(): boolean {
    return false
  }
}

export default QueryMessagesMessage
