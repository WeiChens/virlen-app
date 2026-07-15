/**
 * CopyMoveFileMessage — copy_move_file 工具调用的消息展示组件
 *
 * 一行显示：操作模式图标 + 源路径 → 目标路径
 * 展开显示：完整的执行结果文本
 */
import { t } from '@/ui/i18n'
import { toShortPath } from '@/utils/common'
import { chatState, sessionStore, settingsState } from '@/ui/store'
import { IToolCallMessage, ToolMessageProps } from './IToolCallMessage'

class CopyMoveFileMessage implements IToolCallMessage {
  getToolName(): string {
    return 'copy_move_file'
  }

  getToolLabel(_type: string): string {
    return ''
  }

  getShortText(props: ToolMessageProps): string | React.ReactNode {
    try {
      const input = props.useContent.input as any
      const source: string = input?.source ?? ''
      const dest: string = input?.destination ?? ''
      const mode: string = input?.mode ?? 'move'
      const workspace =
        sessionStore.getSession(chatState.value.currentSessionId)?.workspace ||
        settingsState.value.defaultWorkspace
      const shortSource = toShortPath(source, workspace)
      const shortDest = toShortPath(dest, workspace)
      const modeText = mode === 'copy' ? '复制文件' : '移动文件'
      return (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            overflow: 'hidden',
          }}>
          <span
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              color: 'var(--accent-color)',
            }}>
            {shortSource}
          </span>
          <span>{modeText}</span>
          <span
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              color: 'var(--accent-color)',
            }}>
            {shortDest}
          </span>
        </div>
      )
    } catch {
      return t('解析异常')
    }
  }

  getExpandView(props: ToolMessageProps): React.ReactNode {
    return null
  }

  diyWrapper(): boolean {
    return true
  }
}

export default CopyMoveFileMessage
