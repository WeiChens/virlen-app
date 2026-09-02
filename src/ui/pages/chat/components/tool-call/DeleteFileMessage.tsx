import { t } from '@/ui/i18n'
import { toShortPath } from '@/utils/common'
import { chatState, sessionStore, settingsState } from '@/ui/store'
import { IToolCallMessage, ToolMessageProps } from './IToolCallMessage'

class DeleteFileMessage implements IToolCallMessage {
  getToolName(): string {
    return 'delete_file'
  }
  getToolLabel(_type: string): string {
    return t('删除文件')
  }
  getShortText(props: ToolMessageProps): string {
    try {
      const input = props.useContent.input as any
      const workspace =
        sessionStore.getSession(chatState.value.currentSessionId)?.workspace ||
        settingsState.value.defaultWorkspace

      // 提取路径列表：优先 paths 数组，兼容单个 path 字符串
      let paths: string[] = []
      if (Array.isArray(input?.paths)) {
        paths = input.paths.filter((p: any) => typeof p === 'string' && p)
      } else if (typeof input?.path === 'string' && input.path) {
        paths = [input.path]
      } else if (typeof input === 'object' && input !== null) {
        // 兜底：对象只有一个键时取其值
        const keys = Object.keys(input)
        if (keys.length === 1) {
          const v = input[keys[0]]
          if (Array.isArray(v)) {
            paths = v.filter((p: any) => typeof p === 'string' && p)
          } else if (typeof v === 'string' && v) {
            paths = [v]
          }
        }
      } else if (typeof input === 'string') {
        paths = [input]
      }

      if (paths.length === 0) return t('删除文件')
      if (paths.length === 1) return toShortPath(paths[0], workspace)
      return `${toShortPath(paths[0], workspace)} +${paths.length - 1}`
    } catch {
      return t('解析异常')
    }
  }
  getExpandView(props: ToolMessageProps): React.ReactNode {
    if (props.message?.isError) {
      return <div className="error">{props.message.content as string}</div>
    }
    return null
  }
  diyWrapper(): boolean {
    return true
  }
}

export default DeleteFileMessage
