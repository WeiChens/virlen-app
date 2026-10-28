/**
 * McpResourceMessage — MCP **资源**工具（`list_mcp_resources` / `read_mcp_resource`）的卡片。
 *
 * 与 `McpToolMessage` 的区别：那张卡画的是「某台服务器某个工具的一次调用」，这张画的是
 * **服务器声明的资源清单**与**一份资源正文**。两者都吃 Rust 下发的 `uiData`，
 * 形状即跨语言契约（`virlen-core/src/mcp/resources.rs::project_*`）。
 *
 * ⚠️ 资源正文是**不可信外部文本**：一律 `<pre>` / 字符串插值渲染，绝不 `dangerouslySetInnerHTML`。
 * ⚠️ 二进制资源**没有**正文块（Rust 只下发字节数），这里如实显示「有内容、多大、未显示」。
 */
import { t, tpl } from '@/ui/i18n'
import { IToolCallMessage, ToolMessageProps } from './IToolCallMessage'

/** 一行摘要最多多少字符 */
const SHORT_TEXT_CHARS = 80

/** `mcp/resources.rs` 投影出的单条资源（字段名照抄） */
interface ResourceItem {
  uri?: string
  name?: string
  title?: string
  description?: string
  mimeType?: string
  size?: number
}

interface ResourceServer {
  server?: string
  state?: string
  resources?: ResourceItem[]
  error?: string
}

interface ListUiData {
  type?: string
  servers?: ResourceServer[]
  truncated?: boolean
}

interface ReadUiData {
  type?: string
  server?: string
  uri?: string
  mimeType?: string
  bytes?: number
  contents?: number
  text?: string
  truncated?: boolean
}

function serversOf(ui: unknown): ResourceServer[] {
  const data = ui as ListUiData | undefined
  return Array.isArray(data?.servers) ? data.servers : []
}

/** 一台服务器的资源条数（含错误服务器：0） */
function countOf(list: ResourceServer[]): number {
  return list.reduce((sum, item) => sum + (item.resources?.length ?? 0), 0)
}

/** 字节 → KB（向上取整，最小 1；与 Rust 侧 `kb()` 同口径） */
function kb(bytes: number | undefined): number {
  return Math.max(1, Math.ceil((bytes ?? 0) / 1024))
}

/** 单条资源的次要信息（名字 / 标题 / mime / 大小），空值丢掉 */
function meta(resource: ResourceItem): string {
  return [
    resource.name || resource.title,
    resource.mimeType,
    typeof resource.size === 'number' ? `${resource.size} B` : undefined,
  ]
    .filter(Boolean)
    .join(' · ')
}

class McpResourceMessage implements IToolCallMessage {
  getToolName(): string {
    // 注册时按名字写进表里（`registerMulti`），这个名字只用于诊断
    return 'list_mcp_resources'
  }

  getToolLabel(type: string): string {
    return type === 'read_mcp_resource' ? t('MCP 资源') : t('MCP 资源列表')
  }

  getShortText(props: ToolMessageProps): React.ReactNode {
    try {
      const type = props.useContent?.name
      if (!props.message) {
        // 还在跑：把参数摘要摆出来（server / uri）
        const input = props.useContent?.input
        const raw =
          input && typeof input === 'object' && Object.keys(input).length > 0
            ? JSON.stringify(input)
            : ''
        return raw.length > SHORT_TEXT_CHARS ? `${raw.slice(0, SHORT_TEXT_CHARS)}…` : raw
      }
      const content = String(props.message.content ?? '')
      if (props.message.isError) {
        return firstLine(content)
      }
      if (type === 'read_mcp_resource') {
        const data = props.message.uiData as ReadUiData | undefined
        return data?.uri || firstLine(content)
      }
      const list = serversOf(props.message.uiData)
      if (list.length === 0) return t('没有可用的 MCP 资源')
      return tpl('$__count__ 个资源（$__servers__ 个服务器）', {
        count: countOf(list),
        servers: list.length,
      })
    } catch {
      return t('解析异常')
    }
  }

  getExpandView(props: ToolMessageProps): React.ReactNode {
    const content = String(props.message?.content ?? '')
    if (props.message?.isError) {
      return <div className="error">{content}</div>
    }
    if (props.useContent?.name === 'read_mcp_resource') {
      return this.renderRead(props.message?.uiData)
    }
    return this.renderList(props.message?.uiData)
  }

  private renderList(ui: unknown): React.ReactNode {
    const data = ui as ListUiData | undefined
    const list = serversOf(ui)
    if (list.length === 0) {
      return <div className="mcp-block-muted">{t('没有可用的 MCP 资源')}</div>
    }
    return (
      <div className="mcp-tool-view">
        {list.map((item, index) => (
          <div className="mcp-block" key={`${item.server ?? 'server'}-${index}`}>
            <div className="mcp-block-title">
              <strong>{item.server ?? '?'}</strong>
              <span className="mcp-block-muted">
                {tpl('$__count__ 个资源', { count: item.resources?.length ?? 0 })}
              </span>
            </div>
            {item.error ? (
              <div className="mcp-note">
                {tpl('服务器暂时不可用：$__reason__', { reason: item.error })}
              </div>
            ) : (
              <ul className="mcp-resource-list">
                {(item.resources ?? []).map((resource) => (
                  <li key={resource.uri ?? ''}>
                    <code>{resource.uri ?? ''}</code>
                    {meta(resource) && (
                      <span className="mcp-block-muted">{meta(resource)}</span>
                    )}
                    {resource.description && (
                      <div className="mcp-block-muted">{resource.description}</div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
        {data?.truncated && (
          <div className="mcp-note">{t('结果已截断，完整内容请看服务器侧日志')}</div>
        )}
      </div>
    )
  }

  private renderRead(ui: unknown): React.ReactNode {
    const data = ui as ReadUiData | undefined
    return (
      <div className="mcp-tool-view">
        <div className="mcp-block">
          <div className="mcp-block-title">
            <code>{data?.uri ?? ''}</code>
            <span className="mcp-block-muted">
              {[data?.server, data?.mimeType].filter(Boolean).join(' · ')}
            </span>
          </div>
          {typeof data?.text === 'string' ? (
            <pre className="tool-plain-text">{data.text}</pre>
          ) : (
            <div className="mcp-chip">
              {tpl('资源 $__uri__（$__mime__，二进制 $__kb__ KB，未显示）', {
                uri: data?.uri ?? '',
                mime: data?.mimeType ?? 'unknown',
                kb: kb(data?.bytes),
              })}
            </div>
          )}
        </div>
        {data?.truncated && (
          <div className="mcp-note">{t('结果已截断，完整内容请看服务器侧日志')}</div>
        )}
      </div>
    )
  }

  diyWrapper(): boolean {
    return false
  }
}

/** 首个非空行（错误摘要用） */
function firstLine(content: string): string {
  const line = content.split('\n').find((l) => l.trim())?.trim() ?? ''
  return line.length > SHORT_TEXT_CHARS ? `${line.slice(0, SHORT_TEXT_CHARS)}…` : line
}

export default McpResourceMessage
