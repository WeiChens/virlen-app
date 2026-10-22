import { t, tpl } from '@/ui/i18n'
import { toShortPath } from '@/utils/common'
import { chatState, sessionStore, settingsState } from '@/ui/store'
import CodeBlock from '../message/code-block'
import { IToolCallMessage, ToolMessageProps } from './IToolCallMessage'

class SearchTextInFileMessage implements IToolCallMessage {
  diyWrapper(): boolean {
    return true
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
        <div className="tool-short-row">
          <span>{tpl('在 $__path__ 中搜索', { path: shortRoot })}</span>
          <span className="tool-short-em">{query}</span>
          {length !== null && (
            <span className="tool-short-muted">
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
    if (!props.expand) {
      return <></>
    }
    if (props.message?.isError) {
      return <div className="error">{props.message.content as string}</div>
    }
    return (
      <CodeBlock showLineNumbers={false} width={'100%'} style={{ marginLeft: 30 }}>
        {props.message?.content as string}
      </CodeBlock>
    )
  }
  // 获取消息内容
}

export default SearchTextInFileMessage
