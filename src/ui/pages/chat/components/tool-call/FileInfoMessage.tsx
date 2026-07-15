import { t } from '@/ui/i18n'
import { toShortPath } from '@/utils/common'
import { chatState, sessionStore, settingsState } from '@/ui/store'
import { IToolCallMessage, ToolMessageProps } from './IToolCallMessage'

class FileInfoMessage implements IToolCallMessage {
  getToolName(): string {
    return 'file_info'
  }
  getToolLabel(_type: string): string {
    return t('查看文件')
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
      // const content = props.message.content as any
      return <pre>{props.message.content as string}</pre>
    }
    return null
  }
  diyWrapper(): boolean {
    return false
  }
}

export default FileInfoMessage
