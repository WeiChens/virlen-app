/**
 * WebSearchMessage — web_search 工具调用的消息展示组件
 *
 * 一行显示：搜索关键词 + 结果数
 * 展开显示：搜索结果列表（标题、摘要、地址）；整条可点 → **右侧栏网页标签**
 * 优先使用 message.uiData 结构化数据渲染，兜底解析 content 文本
 */
import { t, tpl } from '@/ui/i18n'
import { IToolCallMessage, ToolMessageProps } from './IToolCallMessage'
import { openUrl } from '@tauri-apps/plugin-opener'
import { sidePanelUrlOf } from '@/ui/pages/chat/components/message/markdown-link'
import { openUrlInSidePanelBrowser } from '@/services/browser-open-service'

interface SearchResultItem {
  title: string
  url: string
  snippet?: string
  icon?: string
}

/**
 * 点一条结果 → 右侧栏网页标签（与正文里的链接同一个出口 `browser-open-service`）。
 *
 * ⚠️ 地址先过 `sidePanelUrlOf`：它只放行绝对的 http(s) —— 面板视图在本应用的源里跑，
 * 搜索结果里混进来的非网页协议（`javascript:` / `file:`）一律不能吃；
 * 顺手规范化一次，让标签地址与地址栏、导航回写用的是同一个字符串（同一页面不出两种写法）。
 * 没宿主（不在聊天页 / 用例里没注入）时退回系统浏览器，别让一次点击变成「什么都没发生」。
 */
function openResult(url: string) {
  const target = sidePanelUrlOf(url)
  if (!target) return
  if (openUrlInSidePanelBrowser(target)) return
  void openUrl(target).catch(() => {})
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
        <div className="tool-short-row">
          <span className="tool-short-em">{query}</span>
          {length !== undefined && length !== null && (
            <span className="tool-short-muted">
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
    if (props.message?.isError) {
      return <div className="error">{props.message.content as string}</div>
    }
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
              <div
                key={index}
                className="web-search-item"
                role="button"
                tabIndex={0}
                title={item.url}
                onClick={() => openResult(item.url)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    openResult(item.url)
                  }
                }}>
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
                  <span className="web-search-item-title">{item.title}</span>
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
            <div className="tool-plain-text web-search-raw">{content}</div>
          )
        }
      }

      return <div>{t('无搜索结果')}</div>
    } catch {
      return <div className="error">{t('解析异常')}</div>
    }
  }

  diyWrapper(): boolean {
    return false
  }
}

export default WebSearchMessage
