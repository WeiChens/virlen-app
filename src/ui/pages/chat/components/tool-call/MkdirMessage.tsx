import { t, tpl } from '@/ui/i18n'
import { toShortPath } from '@/utils/common'
import { chatState, sessionStore, settingsState } from '@/ui/store'
import { IToolCallMessage, ToolMessageProps } from './IToolCallMessage'

class MkdirMessage implements IToolCallMessage {
  getToolName(): string {
    return 'mkdir'
  }
  getToolLabel(_type: string): string {
    return t('创建目录')
  }
  getShortText(props: ToolMessageProps): string {
    try {
      let input = props.useContent.input as any
      if (typeof input === 'object') {
        const keys = Object.keys(input)
        if (keys.includes('paths')) {
          const paths = input.paths as string[]
          if (paths.length === 1) {
            input = paths[0]
          } else {
            return tpl('创建 $__count__ 个目录', { count: paths.length })
          }
        } else if (keys.includes('path')) {
          input = input.path
        } else {
          input = JSON.stringify(input)
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
    if (props.message?.isError) {
      return <div className="error">{props.message.content as string}</div>
    }
    if (props.message?.content) {
      return <pre>{props.message.content as string}</pre>
    }
    return null
  }
  diyWrapper(): boolean {
    return false
  }
}

export default MkdirMessage
