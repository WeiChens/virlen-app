import { t, tpl } from '@/ui/i18n'
import { IToolCallMessage, ToolMessageProps } from './IToolCallMessage'
import MarkdownRenderer from '../message/markdown-renderer'
import type { UserChoiceResult } from '../modals/user-choice'

class UserChoiceMessage implements IToolCallMessage {
  getToolName(): string {
    return 'user_choice'
  }
  getToolLabel(): string {
    return t('用户选择')
  }
  getShortText(props: ToolMessageProps): string {
    try {
      const { multi, question } = props.useContent.input as any
      const mode = multi ? t('多选') : t('单选')
      let content = `${mode} ${question}`
      if (props.message) {
        const uiData = props.message.uiData as UserChoiceResult | undefined
        if (uiData) {
          const parts: string[] = []
          if (uiData.selected.length > 0) {
            parts.push(t('已选') + ': ' + uiData.selected.join(', '))
          }
          if (uiData.customReply) {
            parts.push(t('补充') + ': ' + uiData.customReply)
          }
          if (parts.length > 0) content += '  ' + parts.join(t('；'))
        } else {
          // 兼容旧数据：content 即为回答
          const answer = props.message?.content
          if (answer)
            content += tpl('  已选: $__answer__', { answer: String(answer) })
        }
      }
      return content
    } catch {
      return t('解析异常')
    }
  }
  getExpandView(props: ToolMessageProps): React.ReactNode {
    if (props.message?.isError) {
      return <div className="error">{props.message.content as string}</div>
    }
    try {
      const { multi, options, question } = props.useContent.input
      const uiData = props.message?.uiData as UserChoiceResult | undefined

      // 优先使用结构化 uiData，兼容旧数据回退到 content
      let selectedOptions: string[] = []
      let customReply = ''
      if (uiData) {
        selectedOptions = uiData.selected || []
        customReply = uiData.customReply || ''
      } else {
        // 旧数据：content 是选项文本（多选为逗号分隔）
        const answer = props.message?.content as string
        if (answer) {
          selectedOptions = answer.split(', ').filter(Boolean)
        }
      }

      return (
        <div className="UserChoiceMessage">
          <div className="UserChoiceMessage-question">
            <MarkdownRenderer content={question} />
          </div>
          {options && options.length > 0 && (
            <div className="UserChoiceMessage-options">
              {options.map((option: string) => {
                const selected = selectedOptions.includes(option)
                return (
                  <div
                    key={option}
                    className="UserChoiceMessageOption"
                    style={{
                      border: selected ? '1px solid' : '1px solid #d9d9d9',
                      backgroundColor: selected
                        ? 'var(--accent-color)'
                        : 'var(--bg-secondary, #f9fafb)',
                      color: selected ? '#fff' : 'var(--text-primary, #1a1a1a)',
                    }}>
                    {option}
                  </div>
                )
              })}
            </div>
          )}
          {customReply && (
            <div className="UserChoiceMessage-customReply">
              <span className="customReply-label">{t('自定义补充')}：</span>
              <span className="customReply-text">{customReply}</span>
            </div>
          )}
        </div>
      )
    } catch {
      return <div className="error">{t('解析异常')}</div>
    }
  }
  diyWrapper(): boolean {
    return false
  }
}

export default UserChoiceMessage
