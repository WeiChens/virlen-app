/**
 * web — 网络分类公共函数（分类 id: web）
 *
 * 供 web_fetch / web_search 复用的纯函数与常量。
 */
import type { SearchResultItem } from '@/domain/search/types'
import { sliceHead } from '@/utils/text'

/** web_fetch 返回内容的最大字符数 */
export const MAX_LENGTH = 20_000

/** 粗略判断响应体是否为完整 HTML 文档 */
export function isHtml(content: string): boolean {
  content = content.trim()
  return (
    (content.startsWith('<!DOCTYPE html>') || content.startsWith('<html')) &&
    content.endsWith('</html>')
  )
}

/**
 * 格式化搜索结果供 LLM 阅读
 */
export function formatSearchResults(
  items: SearchResultItem[],
  query: string,
  providerName: string,
  elapsedMs?: number,
): string {
  const lines: string[] = []
  lines.push(
    `🔍 Search results for "${query}" (via ${providerName})${elapsedMs ? ` in ${elapsedMs}ms` : ''}:`,
  )
  lines.push('')

  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    lines.push(`[${i + 1}] ${item.title}`)
    lines.push(`    URL: ${item.url}`)
    lines.push(`    ${item.snippet}`)

    if (item.publishedDate) {
      lines.push(`    Published: ${item.publishedDate}`)
    }
    if (item.source) {
      lines.push(`    Source: ${item.source}`)
    }
    if (item.score !== undefined) {
      lines.push(`    Relevance: ${(item.score * 100).toFixed(0)}%`)
    }

    // 如果有全文内容，附带（但限制长度避免 token 溢出）
    if (item.content && item.content.length > 0) {
      const maxContentLen = 2000
      const content =
        item.content.length > maxContentLen
          ? sliceHead(item.content, maxContentLen) + '... [truncated]'
          : item.content
      lines.push(`    Content: ${content}`)
    }

    lines.push('')
  }
  lines.push(`--- End of search results (${items.length} items) ---`)
  return lines.join('\n')
}
