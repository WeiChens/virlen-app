import { t, tpl } from '@/ui/i18n'
import { toShortPath } from '@/utils/common'
import { chatState, sessionStore, settingsState } from '@/ui/store'
import CodeBlock from '../message/code-block'
import { IToolCallMessage, ToolMessageProps } from './IToolCallMessage'

class SearchFileByNameMessage implements IToolCallMessage {
  getToolName(): string {
    return 'search_files_by_name'
  }
  getToolLabel(_type: string): string {
    return t('搜索文件')
  }
  getShortText(props: ToolMessageProps): React.ReactNode {
    try {
      const { query = '', path = '.' } = props.useContent.input as any
      const length = props.message?.uiData?.length ?? null
      const workspace =
        sessionStore.getSession(chatState.value.currentSessionId)?.workspace ||
        settingsState.value.defaultWorkspace
      const shortRoot = toShortPath(path, workspace)
      const findStr = tpl('目录 $__path__ 搜索 ', {
        path: shortRoot,
      })
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span>{findStr}</span>
          <span
            style={{
              color: 'var(--accent-color)',
              fontWeight: 500,
            }}>
            {query}
          </span>
          {length !== null && (
            <span style={{ color: '#999', fontSize: 12 }}>
              {tpl(' 找到 $__count__ 项', { count: length })}
            </span>
          )}
        </div>
      )
    } catch {
      return t('解析异常')
    }
  }
  getExpandView(props: ToolMessageProps): React.ReactNode {
    return (
      <CodeBlock fontSize={11} showLineNumbers={false}>
        {props.message?.content as string}
      </CodeBlock>
    )
  }
  diyWrapper(): boolean {
    return false
  }
}

export default SearchFileByNameMessage
