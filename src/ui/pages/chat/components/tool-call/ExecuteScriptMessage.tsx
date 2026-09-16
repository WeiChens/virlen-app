import { t } from '@/ui/i18n'
import { IToolCallMessage, ToolMessageProps } from './IToolCallMessage'
import { getUrlFileName, toShortPath } from '@/utils/common'
import { chatState, sessionStore, settingsState } from '@/ui/store'
import { TerminalView } from './TerminalBlock'

function shortPath(path: string): string {
  const workspace =
    sessionStore.getSession(chatState.value.currentSessionId)?.workspace ||
    settingsState.value.defaultWorkspace
  return path ? toShortPath(path, workspace) : ''
}

class ExecuteScriptMessage implements IToolCallMessage {
  getToolName(): string {
    return 'execute_script'
  }
  getToolLabel(): string {
    return t('执行脚本')
  }
  getShortText(props: ToolMessageProps): string | React.ReactNode {
    try {
      const { command, tips, file_path } = props.useContent.input
      return (
        <span className="execute-command-short">
          {tips && <span className="execute-command-tips">{tips}</span>}
          <span style={{ color: 'var(--accent-color)', fontWeight: 500 }}>
            {command || file_path || getUrlFileName(file_path || '', null)}
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
      const filePath = props.useContent.input.file_path as string | undefined
      const tips = props.useContent.input.tips as string | undefined
      const message = props.message
      // 运行中：不展开也渲染实时终端；完成后折叠则不渲染
      if (message && !props.expand) return null
      return (
        <TerminalView
          toolCallId={props.useContent.id}
          title={t('脚本')}
          tips={tips}
          cmd={command}
          fileLabel={filePath && shortPath(filePath)}
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

export default ExecuteScriptMessage
