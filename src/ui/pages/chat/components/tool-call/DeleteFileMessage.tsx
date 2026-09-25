import { t, tpl } from '@/ui/i18n'
import { toShortPath } from '@/utils/common'
import { chatState, sessionStore, settingsState } from '@/ui/store'
import { IToolCallMessage, ToolMessageProps } from './IToolCallMessage'

/**
 * 把 delete_file 的结构化结果按界面语言渲染。
 *
 * P4b：模型侧 `content` 固定英文，UI 侧改为按界面语言渲染结构化 `uiData`。
 */
function renderResult(ui: any): string {
  const deleted: string[] = Array.isArray(ui.deleted) ? ui.deleted : []
  const failed: string[] = Array.isArray(ui.errors) ? ui.errors : []
  const parts: string[] = []
  if (deleted.length === 1) {
    parts.push(`🗑️ ${tpl('已移至回收站: $__path__', { path: deleted[0] })}`)
  } else if (deleted.length > 1) {
    parts.push(
      `🗑️ ${tpl('已移至回收站 $__count__ 项', { count: deleted.length })}:\n${deleted
        .map((p) => `  - ${p}`)
        .join('\n')}`,
    )
  }
  if (failed.length > 0) {
    parts.push(
      `⚠️ ${tpl('有 $__count__ 项删除失败', { count: failed.length })}:\n${failed
        .map((e) => `  - ${e}`)
        .join('\n')}`,
    )
  }
  return parts.join('\n')
}

class DeleteFileMessage implements IToolCallMessage {
  getToolName(): string {
    return 'delete_file'
  }
  getToolLabel(_type: string): string {
    return t('删除文件')
  }
  /** 提取本次删除请求涉及的路径列表：优先 paths 数组，兼容单个 path 字符串 */
  private getPaths(input: any): string[] {
    if (!input) return []
    if (Array.isArray(input.paths)) {
      return input.paths.filter((p: any) => typeof p === 'string' && p)
    }
    if (typeof input.path === 'string' && input.path) {
      return [input.path]
    }
    if (typeof input === 'object') {
      // 兜底：对象只有一个键时取其值
      const keys = Object.keys(input)
      if (keys.length === 1) {
        const v = input[keys[0]]
        if (Array.isArray(v)) {
          return v.filter((p: any) => typeof p === 'string' && p)
        }
        if (typeof v === 'string' && v) {
          return [v]
        }
      }
    }
    if (typeof input === 'string') {
      return [input]
    }
    return []
  }
  getShortText(props: ToolMessageProps): string {
    try {
      const workspace =
        sessionStore.getSession(chatState.value.currentSessionId)?.workspace ||
        settingsState.value.defaultWorkspace

      const paths = this.getPaths(props.useContent.input as any)
      if (paths.length === 0) return t('删除文件')
      if (paths.length === 1) return toShortPath(paths[0], workspace)
      return `${toShortPath(paths[0], workspace)} +${paths.length - 1}`
    } catch {
      return t('解析异常')
    }
  }
  getExpandView(props: ToolMessageProps): React.ReactNode {
    if (props.message?.isError) {
      return <div className="error">{props.message.content as string}</div>
    }
    if (!props.expand) return null

    const paths = this.getPaths(props.useContent.input as any)

    const ui = props.message?.uiData as any
    const deleted: string[] = Array.isArray(ui?.deleted) ? ui.deleted : []
    const failed: string[] = Array.isArray(ui?.errors) ? ui.errors : []

    // 单项且无失败 → 短文本已表达清楚，不展开（保持原有取舍）
    if (paths.length <= 1 && deleted.length + failed.length <= 1) return null

    // 有结构化结果 → UI 侧本地化渲染（P4b：模型侧 content 固定英文）
    if (ui && (deleted.length > 0 || failed.length > 0)) {
      return (
        <div className="tool-call-expand-view">
          <pre
            style={{
              margin: 0,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              fontSize: 12,
            }}>
            {renderResult(ui)}
          </pre>
        </div>
      )
    }

    const workspace =
      sessionStore.getSession(chatState.value.currentSessionId)?.workspace ||
      settingsState.value.defaultWorkspace

    // 工具正文已包含删除清单（例如 "🗑️ 已移至回收站 3 项: ..."）
    const content = props.message?.content as string | undefined
    return (
      <div className="tool-call-expand-view">
        {content ? (
          <pre
            style={{
              margin: 0,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              fontSize: 12,
            }}>
            {content}
          </pre>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {paths.map((p, i) => (
              <div
                key={`${i}-${p}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 12,
                }}>
                <span style={{ color: 'var(--accent-color)' }}>🗑</span>
                <span style={{ wordBreak: 'break-all' }}>
                  {toShortPath(p, workspace)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }
  diyWrapper(): boolean {
    return true
  }
}

export default DeleteFileMessage
