import { t } from '@/ui/i18n'
import { getFileParentDir, getUrlFileName, toShortPath } from '@/utils/common'
import { chatState, sessionStore, settingsState } from '@/ui/store'
import CodeBlock from '../message/code-block'
import { IToolCallMessage, ToolMessageProps } from './IToolCallMessage'
import { editorService } from '@/services/editor-service'
import { openPath } from '@tauri-apps/plugin-opener'
import FolderSvg from '@/ui/components/icons/FolderSvg'

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
    if (props.message?.isError) {
      return <div className="error">{props.message.content as string}</div>
    }
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
          startLineNumber={startLine}
          actions={[{
            title: t('文件资源管理器打开'),
            iconRender() {
              return <FolderSvg />
            },
            onClick() {
              const filePath = props.message.uiData?.fullPath;
              const parentDir = getFileParentDir(filePath)
              openPath(parentDir)
            },
          }, {
            title: t('编辑器打开'),
            iconRender() {
              return <svg viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="16625" width="200" height="200">
                <path d="M438.4 849.1l222.7-646.7c0.2-0.5 0.3-1.1 0.4-1.6L438.4 849.1z" opacity=".224" p-id="16626"></path><path d="M661.2 168.7h-67.5c-3.4 0-6.5 2.2-7.6 5.4L354.7 846c-0.3 0.8-0.4 1.7-0.4 2.6 0 4.4 3.6 8 8 8h67.8c3.4 0 6.5-2.2 7.6-5.4l0.7-2.1 223.1-648.3 7.4-21.4c0.3-0.8 0.4-1.7 0.4-2.6-0.1-4.5-3.6-8.1-8.1-8.1zM954.6 502.1c-0.8-1-1.7-1.9-2.7-2.7l-219-171.3c-3.5-2.7-8.5-2.1-11.2 1.4-1.1 1.4-1.7 3.1-1.7 4.9v81.3c0 2.5 1.1 4.8 3.1 6.3l115 90-115 90c-1.9 1.5-3.1 3.8-3.1 6.3v81.3c0 4.4 3.6 8 8 8 1.8 0 3.5-0.6 4.9-1.7l219-171.3c6.9-5.4 8.2-15.5 2.7-22.5zM291.1 328.1l-219 171.3c-1 0.8-1.9 1.7-2.7 2.7-5.4 7-4.2 17 2.7 22.5l219 171.3c1.4 1.1 3.1 1.7 4.9 1.7 4.4 0 8-3.6 8-8v-81.3c0-2.5-1.1-4.8-3.1-6.3l-115-90 115-90c1.9-1.5 3.1-3.8 3.1-6.3v-81.3c0-1.8-0.6-3.5-1.7-4.9-2.7-3.5-7.7-4.1-11.2-1.4z">
                </path>
              </svg>
            },
            onClick() {
              // TODO: 打开编辑器
              editorService.openFile({
                filePath: props.message.uiData?.fullPath,
                line: props.message.uiData?.startLine
              })
            },
          },]}
        >
          {value as any}
        </CodeBlock>
      </div >
    )
  }
  diyWrapper(): boolean {
    return true
  }
}

export default ReadFileMessage
