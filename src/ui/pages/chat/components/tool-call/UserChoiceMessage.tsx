import { t, tpl } from '@/ui/i18n'
import { IToolCallMessage, ToolMessageProps } from './IToolCallMessage'
import MarkdownRenderer from '../message/markdown-renderer'

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
        const answer = props.message?.content
        if (answer)
          content += tpl('  已选: $__answer__', { answer: String(answer) })
      }
      return content
    } catch {
      return t('解析异常')
    }
  }
  getExpandView(props: ToolMessageProps): React.ReactNode {
    try {
      const { multi, options, question } = props.useContent.input
      const answer = props.message?.content as string
      return (
        <div>
          <div>
            <MarkdownRenderer content={question} />
          </div>
          <div>
            {options.map((option: string) => {
              const selected = multi
                ? answer?.includes(option)
                : answer === option
              return (
                <div
                  key={option}
                  className="UserChoiceMessageOption"
                  style={{
                    border: selected ? '1px solid' : '1px solid #d9d9d9',
                    backgroundColor: selected ? 'var(--accent-color)' : '#fff',
                    color: selected ? '#fff' : '#000',
                  }}>
                  {option}
                </div>
              )
            })}
          </div>
        </div>
      )
    } catch {
      return <div>{t('解析异常')}</div>
    }
  }
  diyWrapper(): boolean {
    return false
  }
}

export default UserChoiceMessage
