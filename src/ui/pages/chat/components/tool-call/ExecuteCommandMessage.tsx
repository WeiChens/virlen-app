import { t } from '@/ui/i18n'
import { IToolCallMessage, ToolMessageProps } from './IToolCallMessage'
import { TerminalView } from './TerminalBlock'

class ExecuteCommandMessage implements IToolCallMessage {
  getToolName(): string {
    return 'execute_command'
  }
  getToolLabel(): string {
    return t('终端')
  }
  getShortText(props: ToolMessageProps): string | React.ReactNode {
    try {
      const { command, tips } = props.useContent.input
      return (
        <span className="execute-command-short">
          {tips && (
            <span className="execute-command-tips">{tips}</span>
          )}
          <span style={{ color: 'var(--accent-color)', fontWeight: 500 }}>
            {command}
          </span>
        </span>
      )
    } catch {
      return t('解析异常')
    }
  }
  getExpandView(props: ToolMessageProps): React.ReactNode {
    try {
      const command = props.useContent.input.command as string | undefined
      const message = props.message
      // 运行中：不展开也渲染实时终端；完成后折叠则不渲染
      if (message && !props.expand) return null
      return (
        <TerminalView
          toolCallId={props.useContent.id}
          title={t('终端')}
          cmd={command}
          message={message}
        />
      )
    } catch {
      return <div className="error">{t('解析异常')}</div>
    }
  }
  diyWrapper(): boolean {
    return true
  }
}

export default ExecuteCommandMessage
