import { t } from '@/ui/i18n'
import { getUrlFileName, toShortPath } from '@/utils/common'
import { chatState, sessionStore, settingsState } from '@/ui/store'
import CodeBlock from '../message/code-block'
import { IToolCallMessage, ToolMessageProps } from './IToolCallMessage'

class ReadFileMessage implements IToolCallMessage {
  getToolName(): string {
    return 'read_file'
  }
  getToolLabel(_type: string): string {
    return t('查看文件')
  }
  getShortText(props: ToolMessageProps): string | React.ReactNode {
    try {
      const { path } = props.useContent.input
      const workspace =
        sessionStore.getSession(chatState.value.currentSessionId)?.workspace ||
        settingsState.value.defaultWorkspace
      let content = toShortPath(path, workspace)
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span
            style={{
              color: 'var(--accent-color)',
              fontWeight: 500,
            }}>
            {content}
          </span>
          {props.message?.uiData?.startLine &&
            props.message?.uiData?.endLine && (
              <span style={{ color: '#999', fontSize: 12 }}>
                {`${props.message.uiData.startLine}-${props.message.uiData.endLine}`}
              </span>
            )}
        </div>
      )
    } catch {
      return t('解析异常')
    }
  }
  getExpandView(props: ToolMessageProps): React.ReactNode {
    if (!props.expand) return null
    const value = props.message.uiData?.content || props.message?.content
    const name = getUrlFileName(props.message.uiData?.fullPath, null)
    const startLine = props.message.uiData?.startLine || 1
    return (
      <div
        style={{
          padding: '0 10px',
          margin: '0px 20px',
          width: 'fit-content',
        }}>
        <CodeBlock
          maxHeight={450}
          width={600}
          fontSize={11}
          fileName={name}
          showLineNumbers
          startLineNumber={startLine}>
          {value as any}
        </CodeBlock>
      </div>
    )
  }
  diyWrapper(): boolean {
    return true
  }
}

export default ReadFileMessage
