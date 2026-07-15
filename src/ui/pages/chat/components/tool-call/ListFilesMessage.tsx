import { t, tpl } from '@/ui/i18n'
import { toShortPath } from '@/utils/common'
import { chatState, sessionStore, settingsState } from '@/ui/store'
import CodeBlock from '../message/code-block'
import { IToolCallMessage, ToolMessageProps } from './IToolCallMessage'

class ListFilesMessage implements IToolCallMessage {
  getToolName(): string {
    return 'list_files'
  }
  getToolLabel(_type: string): string {
    return t('查看文件列表')
  }
  getShortText(props: ToolMessageProps): string | React.ReactNode {
    try {
      let input = props.useContent.input as any
      if (typeof input === 'object') {
        input = input.path || '.'
      }
      const workspace =
        sessionStore.getSession(chatState.value.currentSessionId)?.workspace ||
        settingsState.value.defaultWorkspace
      const shortPath = toShortPath(`${input}`, workspace)
      const count = props.message?.uiData?.count || 0
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span
            style={{
              color: 'var(--accent-color)',
              fontWeight: 500,
            }}>
            {shortPath}
          </span>
          {count !== null && (
            <span style={{ color: '#999', fontSize: 12 }}>
              {tpl('找到 $__count__ 项', { count })}
            </span>
          )}
        </div>
      )
    } catch {
      return t('解析异常')
    }
  }
  getExpandView(props: ToolMessageProps): React.ReactNode {
    try {
      return (
        <CodeBlock
          fontSize={11}
          width={400}
          maxHeight={600}
          showLineNumbers={false}>
          {props?.message?.content}
        </CodeBlock>
      )
    } catch {
      return <div>{t('解析异常')}</div>
    }
  }
  diyWrapper(): boolean {
    return false
  }
}

export default ListFilesMessage
