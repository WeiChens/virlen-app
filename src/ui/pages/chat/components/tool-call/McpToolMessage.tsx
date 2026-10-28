/**
 * McpToolMessage — 任意 MCP 服务器工具调用（`mcp__<server>__<raw>`）的卡片。
 *
 * 为什么不给每台服务器写一张卡：MCP 工具是**运行期动态定义**，前端在编译期不知道有哪些。
 * 一张卡按 Rust 下发的 `uiData.blocks[]` 通用渲染即可 —— 块类型（text / image / resource /
 * json / unsupported）就是 `mcp/results.rs::project` 的输出契约，两侧一一对应。
 *
 * ⚠️ 图片块**不渲染 base64**（结果里根本没有）：Rust 只下发 `mediaType` + 字节数，模型侧拿到的
 * 也是一行诊断。真正的「落附件 / 给视觉模型看」是后续步骤的事，这里如实显示「有图、多大、未显示」。
 * ⚠️ 正文 / 参数都是**不可信外部文本**：一律当纯文本渲染（`<pre>` / 字符串插值），绝不 `dangerouslySetInnerHTML`。
 */
import { t, tpl } from '@/ui/i18n'
import { parseMcpToolName } from '@/domain/mcp/naming'
import { IToolCallMessage, ToolMessageProps } from './IToolCallMessage'

/** 一行摘要最多显示多少字符（完整内容在展开视图里） */
const SHORT_TEXT_CHARS = 80

/** `results.rs` 投影出的界面块（形状是跨语言契约，字段名照抄） */
interface McpBlock {
  type?: string
  text?: string
  mediaType?: string
  bytes?: number
  name?: string
  uri?: string
  mimeType?: string
  value?: unknown
  blockType?: string
}

interface McpUiData {
  type?: string
  server?: string
  rawName?: string
  name?: string
  blocks?: McpBlock[]
  truncated?: boolean
}

/** 从结果消息里取结构化块（形状不对就当没有：宁可退回纯文本，也不要渲染出空白） */
function blocksOf(ui: unknown): McpBlock[] {
  const data = ui as McpUiData | undefined
  return Array.isArray(data?.blocks) ? data.blocks : []
}

/** 首个文本块的首个非空行（收起态那一行字） */
function firstLine(blocks: McpBlock[]): string {
  for (const block of blocks) {
    if (block.type !== 'text' || !block.text) continue
    const line = block.text.split('\n').find((l) => l.trim())?.trim()
    if (line) {
      return line.length > SHORT_TEXT_CHARS
        ? `${line.slice(0, SHORT_TEXT_CHARS)}…`
        : line
    }
  }
  return ''
}

class McpToolMessage implements IToolCallMessage {
  /** 前缀注册（`getToolCallMessage` 对 `mcp__*` 直接兜底到本类），这个名字只用于诊断 */
  getToolName(): string {
    return 'mcp__'
  }

  getToolLabel(type: string): string {
    const parsed = parseMcpToolName(type)
    return parsed ? tpl('MCP · $__server__', { server: parsed.server }) : t('MCP 工具')
  }

  getShortText(props: ToolMessageProps): React.ReactNode {
    try {
      // 工具还在跑（没有结果消息）：把参数摘要摆出来，让用户知道它在干什么
      if (!props.message) {
        const input = props.useContent.input
        const raw =
          input && typeof input === 'object' && Object.keys(input).length > 0
            ? JSON.stringify(input)
            : ''
        return raw.length > SHORT_TEXT_CHARS ? `${raw.slice(0, SHORT_TEXT_CHARS)}…` : raw
      }
      if (props.message.isError) {
        const content = String(props.message.content ?? '')
        const line = content.split('\n').find((l) => l.trim())?.trim() ?? ''
        return line.length > SHORT_TEXT_CHARS ? `${line.slice(0, SHORT_TEXT_CHARS)}…` : line
      }
      const blocks = blocksOf(props.message.uiData)
      const line = firstLine(blocks)
      if (line) return line
      // 没有文本块：说清楚结果里是什么（图片 / 结构化内容 / 空）
      const images = blocks.filter((b) => b.type === 'image').length
      if (images > 0) return tpl('$__count__ 个图片块', { count: images })
      const hasJson = blocks.some((b) => b.type === 'json')
      if (hasJson) return t('结构化结果')
      const content = String(props.message.content ?? '')
      return content.split('\n')[0] ?? ''
    } catch {
      return t('解析异常')
    }
  }

  getExpandView(props: ToolMessageProps): React.ReactNode {
    const content = String(props.message?.content ?? '')
    if (props.message?.isError) {
      return <div className="error">{content}</div>
    }
    const blocks = blocksOf(props.message?.uiData)
    // 没有结构化块（宿主 / 旧会话）：退回与下发给模型的文本同构的纯文本
    if (blocks.length === 0) {
      return <pre className="tool-plain-text">{content}</pre>
    }
    const data = props.message?.uiData as McpUiData | undefined
    return (
      <div className="mcp-tool-view">
        {blocks.map((block, index) => (
          <div className="mcp-block" key={index}>
            {this.renderBlock(block)}
          </div>
        ))}
        {data?.truncated && (
          <div className="mcp-note">{t('结果已截断，完整内容请看服务器侧日志')}</div>
        )}
      </div>
    )
  }

  private renderBlock(block: McpBlock): React.ReactNode {
    switch (block.type) {
      case 'text':
        return <pre className="tool-plain-text">{block.text ?? ''}</pre>
      case 'resource':
        // 内嵌资源：有正文就照文本渲染，二进制只报大小（与 Rust 的诊断口径一致）
        if (typeof block.text === 'string') {
          return (
            <>
              <div className="mcp-block-title">
                <code>{block.uri}</code>
                {block.mimeType && <span className="mcp-block-muted">{block.mimeType}</span>}
              </div>
              <pre className="tool-plain-text">{block.text}</pre>
            </>
          )
        }
        return (
          <div className="mcp-chip">
            {tpl('资源 $__uri__（$__mime__，二进制 $__kb__ KB，未显示）', {
              uri: block.uri ?? '',
              mime: block.mimeType ?? 'unknown',
              kb: Math.max(1, Math.ceil((block.bytes ?? 0) / 1024)),
            })}
          </div>
        )
      case 'image':
        return (
          <div className="mcp-chip">
            {tpl('图片（$__mime__，$__kb__ KB）未在会话中显示', {
              mime: block.mediaType ?? 'image/*',
              kb: Math.max(1, Math.ceil((block.bytes ?? 0) / 1024)),
            })}
          </div>
        )
      case 'resource_link':
        return (
          <div className="mcp-chip">
            <code>{block.uri}</code>
            {[block.name, block.mimeType].filter(Boolean).length > 0 && (
              <span className="mcp-block-muted">
                {[block.name, block.mimeType].filter(Boolean).join(' · ')}
              </span>
            )}
          </div>
        )
      case 'json':
        return (
          <details className="mcp-json">
            <summary>{t('结构化结果')}</summary>
            <pre className="tool-plain-text">{JSON.stringify(block.value ?? null, null, 2)}</pre>
          </details>
        )
      default:
        return (
          <div className="mcp-note">
            {tpl('不支持的内容块：$__type__', { type: block.blockType ?? block.type ?? '?' })}
          </div>
        )
    }
  }

  /** 自有外层容器：展开视图要排版多块内容（`tool-call-expand-view` 之外再包一层会多一份间距） */
  diyWrapper(): boolean {
    return false
  }
}

export default McpToolMessage
