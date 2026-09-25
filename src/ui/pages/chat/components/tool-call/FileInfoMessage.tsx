import { t } from '@/ui/i18n'
import { toShortPath } from '@/utils/common'
import { chatState, sessionStore, settingsState } from '@/ui/store'
import { formatSize } from '@/infrastructure/tools/file/common'
import { IToolCallMessage, ToolMessageProps } from './IToolCallMessage'

/**
 * 把 file_info 的结构化元信息按界面语言渲染。
 *
 * P4b：模型侧 `content` 固定英文，UI 侧改为按界面语言渲染结构化 `uiData`。
 */
function renderResult(ui: any): string {
  const lines = [
    `📋 ${ui.path}`,
    `  ${t('类型')}: ${ui.isDirectory ? `📁 ${t('目录')}` : `📄 ${t('文件')}`}`,
    ui.sizeBytes != null ? `  ${t('大小')}: ${formatSize(ui.sizeBytes)}` : '',
    ui.atimeMs != null
      ? `  ${t('访问时间')}: ${new Date(ui.atimeMs).toLocaleString()}`
      : '',
    ui.mtimeMs != null
      ? `  ${t('修改时间')}: ${new Date(ui.mtimeMs).toLocaleString()}`
      : '',
  ]
  return lines.filter(Boolean).join('\n')
}

class FileInfoMessage implements IToolCallMessage {
  getToolName(): string {
    return 'file_info'
  }
  getToolLabel(_type: string): string {
    return t('查看文件')
  }
  getShortText(props: ToolMessageProps): string {
    try {
      let input = props.useContent.input as any
      if (typeof input === 'object') {
        const keys = Object.keys(input)
        if (keys.length > 1) {
          if (keys.includes('path')) {
            input = input.path
          } else {
            input = JSON.stringify(input)
          }
        } else if (keys.length === 1) {
          input = input[keys[0]]
        } else {
          input = ''
        }
      }
      const workspace =
        sessionStore.getSession(chatState.value.currentSessionId)?.workspace ||
        settingsState.value.defaultWorkspace
      return toShortPath(`${input}`, workspace)
    } catch {
      return t('解析异常')
    }
  }
  getExpandView(props: ToolMessageProps): React.ReactNode {
    if (props.message?.isError) {
      return <div className="error">{props.message.content as string}</div>
    }
    const ui = props.message?.uiData as any
    // 有结构化元信息 → UI 侧本地化渲染；旧数据无 uiData → 回退模型侧文本
    if (ui && ui.path) {
      return <pre>{renderResult(ui)}</pre>
    }
    if (props.message?.content) {
      return <pre>{props.message.content as string}</pre>
    }
    return null
  }
  diyWrapper(): boolean {
    return false
  }
}

export default FileInfoMessage
