import { t } from '@/ui/i18n'
import { toShortPath } from '@/utils/common'
import { chatState, sessionStore, settingsState } from '@/ui/store'
import { IToolCallMessage, ToolMessageProps } from './IToolCallMessage'

class VisionAnalyzeMessage implements IToolCallMessage {
  getToolName(): string {
    return 'vision_analyze'
  }
  getToolLabel(_type: string): string {
    return t('视觉分析')
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
      const workspace =
        sessionStore.getSession(chatState.value.currentSessionId)?.workspace ||
        settingsState.value.defaultWorkspace
      return toShortPath(`${input}`, workspace)
    } catch {
      return t('解析异常')
    }
  }
  getExpandView(props: ToolMessageProps): React.ReactNode {
    if (props.message?.content) {
      return <pre>{props.message.content as string}</pre>
    }
    return null
  }
  diyWrapper(): boolean {
    return false
  }
}

export default VisionAnalyzeMessage
