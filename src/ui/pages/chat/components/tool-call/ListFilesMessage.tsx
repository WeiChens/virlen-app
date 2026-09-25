import { t, tpl } from '@/ui/i18n'
import { toShortPath } from '@/utils/common'
import { chatState, sessionStore, settingsState } from '@/ui/store'
import { formatSize } from '@/infrastructure/tools/file/common'
import CodeBlock from '../message/code-block'
import { IToolCallMessage, ToolMessageProps } from './IToolCallMessage'

/**
 * 把语言无关的目录树 uiData 渲染成本地化树状文本。
 *
 * P4b：模型侧 `content` 固定英文，UI 侧改为按界面语言渲染结构化 `uiData`，
 * 避免中文界面下展示英文结果。
 */
function renderTree(ui: any): string {
  const lines: string[] = [String(ui.rootPath ?? '')]
  const walk = (nodes: any[], prefix: string) => {
    nodes.forEach((node, i) => {
      const isLast = i === nodes.length - 1
      const connector = isLast ? '└── ' : '├── '
      const nextPrefix = prefix + (isLast ? '    ' : '│   ')
      const sizeStr =
        !node.isDir && node.size != null ? `  (${formatSize(node.size)})` : ''
      const elidedStr = node.elided ? `  ${t('# 内部省略')}` : ''
      lines.push(
        `${prefix}${connector}${node.name}${node.isDir ? '/' : ''}${sizeStr}${elidedStr}`,
      )
      if (Array.isArray(node.children) && node.children.length > 0) {
        walk(node.children, nextPrefix)
      }
    })
  }
  walk(Array.isArray(ui.nodes) ? ui.nodes : [], '')
  lines.push('')
  lines.push(
    ui.truncated
      ? tpl('⚠️ 文件数量超过限制，仅显示前 $__max__ 项（共 $__total__ 项）', {
          max: ui.maxItems ?? 0,
          total: ui.totalItems ?? 0,
        })
      : tpl('总计 $__count__ 项', { count: ui.totalItems ?? 0 }),
  )
  return lines.join('\n')
}

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
    if (props.message?.isError) {
      return <div className="error">{props.message.content as string}</div>
    }
    try {
      const ui = props.message?.uiData as any
      // 有结构化目录树 → UI 侧本地化渲染；旧数据无 uiData → 回退模型侧文本
      const text =
        ui && Array.isArray(ui.nodes)
          ? renderTree(ui)
          : (props.message?.content as string)
      return (
        <CodeBlock
          width={400}
          maxHeight={600}
          showLineNumbers={false}>
          {text as unknown as React.ReactNode}
        </CodeBlock>
      )
    } catch {
      return <div className="error">{t('解析异常')}</div>
    }
  }
  diyWrapper(): boolean {
    return false
  }
}

export default ListFilesMessage
