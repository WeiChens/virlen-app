/**
 * WebSearchMessage — web_search 工具调用的消息展示组件
 *
 * 一行显示：搜索关键词 + 结果数
 * 展开显示：搜索结果列表（标题、摘要、链接可点击）
 * 优先使用 message.uiData 结构化数据渲染，兜底解析 content 文本
 */
import { t, tpl } from '@/ui/i18n'
import { IToolCallMessage, ToolMessageProps } from './IToolCallMessage'
import { openUrl } from '@tauri-apps/plugin-opener'

interface SearchResultItem {
  title: string
  url: string
  snippet?: string
  icon?: string
}

class WebSearchMessage implements IToolCallMessage {
  getToolName(): string {
    return 'web_search'
  }

  getToolLabel(): string {
    return t('网络搜索')
  }

  getShortText(props: ToolMessageProps): string | React.ReactNode {
    try {
      const input = props.useContent.input as any
      const query: string = input?.query ?? ''
      const uiData = props.message?.uiData as
        | { length?: number; provider?: string }
        | undefined
      const length = uiData?.length
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span
            style={{
              color: 'var(--accent-color)',
              fontWeight: 500,
            }}>
            {query}
          </span>
          {length !== undefined && length !== null && (
            <span style={{ color: '#999', fontSize: 12 }}>
              {tpl(' — $__count__项结果', { count: length })}
            </span>
          )}
        </div>
      )
    } catch {
      return t('解析异常')
    }
  }

  getExpandView(props: ToolMessageProps): React.ReactNode {
    try {
      const uiData = props.message?.uiData as
        | { items?: SearchResultItem[]; provider?: string; query?: string }
        | undefined
      const items = uiData?.items

      // 优先使用 uiData 的结构化数据
      if (items && items.length > 0) {
        return (
          <div className="web-search-results">
            {items.map((item, index) => (
              <div key={index} className="web-search-item">
                {item.icon ? (
                  <img
                    className="web-search-item-icon"
                    src={item.icon}
                    alt=""
                    onError={(e) => {
                      // 图标加载失败时隐藏
                      ;(e.target as HTMLElement).style.display = 'none'
                    }}
                  />
                ) : (
                  <div className="web-search-item-index">{index + 1}</div>
                )}
                <div className="web-search-item-content">
                  <a
                    className="web-search-item-title"
                    onClick={() => openUrl(item.url)}
                    title={item.url}>
                    {item.title}
                  </a>
                  <div className="web-search-item-snippet">{item.snippet}</div>
                  <div className="web-search-item-url">{item.url}</div>
                </div>
              </div>
            ))}
          </div>
        )
      }

      // 兜底：解析 content 文本
      const content = props.message?.content as string | undefined
      if (content) {
        // 简单解析文本格式的搜索结果
        const lines = content.split('\n')
        const resultLines = lines.filter(
          (line) =>
            line.trim().startsWith('[') && line.trim().match(/^\[\d+\]/),
        )
        if (resultLines.length > 0) {
          return (
            <div
              style={{
                maxHeight: '400px',
                overflowY: 'auto',
                fontSize: 'var(--font-size-sm)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                lineHeight: 1.6,
              }}>
              {content}
            </div>
          )
        }
      }

      return <div>{t('无搜索结果')}</div>
    } catch {
      return <div>{t('解析异常')}</div>
    }
  }

  diyWrapper(): boolean {
    return false
  }
}

export default WebSearchMessage
