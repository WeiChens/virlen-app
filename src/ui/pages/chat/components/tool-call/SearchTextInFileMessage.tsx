import { t, tpl } from '@/ui/i18n'
import { toShortPath } from '@/utils/common'
import { chatState, sessionStore, settingsState } from '@/ui/store'
import CodeBlock from '../message/code-block'
import { IToolCallMessage, ToolMessageProps } from './IToolCallMessage'

class SearchTextInFileMessage implements IToolCallMessage {
  diyWrapper(): boolean {
    return false
  }
  getToolName(): string {
    return 'search_text_in_files'
  }
  getToolLabel(_type: string): string {
    return t('搜索关键字')
  }
  getShortText(props: ToolMessageProps): string | React.ReactNode {
    try {
      const { path = '.', query } = props.useContent.input as any
      const length = props.message?.uiData?.length ?? null
      const workspace =
        sessionStore.getSession(chatState.value.currentSessionId)?.workspace ||
        settingsState.value.defaultWorkspace
      const shortRoot = toShortPath(path, workspace)
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span>{tpl('在 $__path__ 中搜索', { path: shortRoot })}</span>
          <span
            style={{
              color: 'var(--accent-color)',
              fontWeight: 500,
            }}>
            {query}
          </span>
          {length !== null && (
            <span style={{ color: '#999', fontSize: 12 }}>
              {tpl(' 找到$__count__项', { count: length })}
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
  // 获取消息内容
}

export default SearchTextInFileMessage
