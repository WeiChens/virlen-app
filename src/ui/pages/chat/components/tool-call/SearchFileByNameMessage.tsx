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
        <div className="tool-short-row">
          <span>{findStr}</span>
          <span className="tool-short-em">{query}</span>
          {length !== null && (
            <span className="tool-short-muted">
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
    if(!props.expand){
      return <></>
    }
    if (props.message?.isError) {
      return <div className="error">{props.message.content as string}</div>
    }
    return (
      <CodeBlock showLineNumbers={false} width={'80%'} style={{ marginLeft: 30 }}>
        {props.message?.content as string}
      </CodeBlock>
    )
  }
  diyWrapper(): boolean {
    return true
  }
}

export default SearchFileByNameMessage
