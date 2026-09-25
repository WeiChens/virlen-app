import { t, tpl } from '@/ui/i18n'
import { toShortPath } from '@/utils/common'
import { chatState, sessionStore, settingsState } from '@/ui/store'
import { IToolCallMessage, ToolMessageProps } from './IToolCallMessage'

/**
 * 把 mkdir 的结构化结果按界面语言渲染。
 *
 * P4b：模型侧 `content` 固定英文，UI 侧改为按界面语言渲染结构化 `uiData`。
 */
function renderResult(ui: any): string {
  const created: string[] = Array.isArray(ui.created) ? ui.created : []
  const existed: string[] = Array.isArray(ui.existed) ? ui.existed : []
  const errors: string[] = Array.isArray(ui.errors) ? ui.errors : []
  const parts: string[] = []
  if (created.length === 1) {
    parts.push(`📁 ${tpl('已创建目录: $__path__', { path: created[0] })}`)
  } else if (created.length > 1) {
    parts.push(
      `📁 ${tpl('已创建 $__count__ 个目录', { count: created.length })}:\n${created
        .map((p) => `  - ${p}`)
        .join('\n')}`,
    )
  }
  if (existed.length === 1) {
    parts.push(`ℹ️ ${tpl('目录已存在: $__path__', { path: existed[0] })}`)
  } else if (existed.length > 1) {
    parts.push(
      `ℹ️ ${tpl('已存在 $__count__ 个目录', { count: existed.length })}:\n${existed
        .map((p) => `  - ${p}`)
        .join('\n')}`,
    )
  }
  if (errors.length > 0) {
    parts.push(
      `⚠️ ${tpl('有 $__count__ 个目录创建失败', { count: errors.length })}:\n${errors
        .map((e) => `  - ${e}`)
        .join('\n')}`,
    )
  }
  return parts.join('\n')
}

class MkdirMessage implements IToolCallMessage {
  getToolName(): string {
    return 'mkdir'
  }
  getToolLabel(_type: string): string {
    return t('创建目录')
  }
  getShortText(props: ToolMessageProps): string {
    try {
      let input = props.useContent.input as any
      if (typeof input === 'object') {
        const keys = Object.keys(input)
        if (keys.includes('paths')) {
          const paths = input.paths as string[]
          if (paths.length === 1) {
            input = paths[0]
          } else {
            return tpl('创建 $__count__ 个目录', { count: paths.length })
          }
        } else if (keys.includes('path')) {
          input = input.path
        } else {
          input = JSON.stringify(input)
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
    // 有结构化结果 → UI 侧本地化渲染；旧数据无 uiData → 回退模型侧文本
    if (
      ui &&
      (Array.isArray(ui.created) ||
        Array.isArray(ui.existed) ||
        Array.isArray(ui.errors))
    ) {
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

export default MkdirMessage
