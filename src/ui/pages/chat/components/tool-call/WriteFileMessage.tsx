import { t } from '@/ui/i18n'
import { getUrlFileName, toShortPath } from '@/utils/common'
import { chatState, sessionStore, settingsState } from '@/ui/store'
import CodeBlock from '../message/code-block'
import { IToolCallMessage, ToolMessageProps } from './IToolCallMessage'

class WriteFileMessage implements IToolCallMessage {
  getToolName(): string {
    return 'write_file'
  }
  getToolLabel(): string {
    return t('写入文件')
  }
  getShortText(props: ToolMessageProps): string {
    try {
      const { path } = props.useContent.input
      const workspace =
        sessionStore.getSession(chatState.value.currentSessionId)?.workspace ||
        settingsState.value.defaultWorkspace
      return toShortPath(path, workspace)
    } catch {
      return t('解析异常')
    }
  }
  getExpandView(props: ToolMessageProps): React.ReactNode {
    if (!props.expand) return null
    const value = props.useContent.input.content
    const name = getUrlFileName(props.useContent.input.path, null)
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
          showLineNumbers>
          {value as any}
        </CodeBlock>
      </div>
    )
  }
  diyWrapper(): boolean {
    return true
  }
}

export default WriteFileMessage
