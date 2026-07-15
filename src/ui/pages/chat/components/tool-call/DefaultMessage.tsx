import { t } from '@/ui/i18n'
import { IToolCallMessage, ToolMessageProps } from './IToolCallMessage'

class DefaultMessage implements IToolCallMessage {
  getToolName(): string {
    return ''
  }
  getToolLabel(type: string): string {
    return type
  }
  getShortText(props: ToolMessageProps): string {
    try {
      let input = props.useContent.input as any
      if (typeof input === 'object') {
        const keys = Object.keys(input)
        if (keys.length > 1) {
          if (keys.includes('path')) {
            input = input.path
          } else {
            input = JSON.stringify(input)
          }
        } else if (keys.length === 1) {
          input = input[keys[0]]
        } else {
          input = ''
        }
      }
      return `${input}`
    } catch {
      return t('解析异常')
    }
  }
  getExpandView(props: ToolMessageProps): React.ReactNode {
    return t('暂无详情')
  }
  diyWrapper(): boolean {
    return false
  }
}

export default DefaultMessage
