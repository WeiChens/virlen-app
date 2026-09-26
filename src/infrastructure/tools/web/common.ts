/**
 * web — 网络分类公共函数（分类 id: web）
 *
 * 供 web_fetch / web_search 复用的纯函数与常量。
 */
import type { SearchResultItem } from '@/domain/search/types'
import { sliceHead } from '@/utils/text'

/** web_fetch 返回内容的最大字符数 */
export const MAX_LENGTH = 20_000

/** ASCII 空白集合（**显式列出**，与 Rust 侧同一集合）。
 * 不用 `/\s/`：JS 的 `\s` 含 `U+FEFF`、Rust 的 `is_whitespace` 含 `U+0085`，
 * 两侧 Unicode 空白定义并不等价，显式枚举才能保证逐字一致。 */
const ASCII_WHITESPACE = ' \t\n\r\f\v'

/** 剥掉首尾 BOM（`U+FEFF`）。
 * JS 的 `trim()` 把 `U+FEFF` 当空白、Rust 的 `trim()` **不**当 —— 两侧都显式剥，避免分叉。 */
function stripBom(s: string): string {
  return s.replace(/^\uFEFF+|\uFEFF+$/g, '')
}

/** `lower` 是否以 `prefix` 开头，且其后是**标签边界**（结尾 / `>` / ASCII 空白）。
 * 用于避免 `<htmlfoo` 这类假前缀被误判成 HTML 根标签。 */
function startsWithTagBoundary(lower: string, prefix: string): boolean {
  if (!lower.startsWith(prefix)) return false
  const next = lower.charAt(prefix.length)
  return next === '' || next === '>' || ASCII_WHITESPACE.includes(next)
}

/**
 * 判断响应体是否应按 HTML 处理（即 `htmlToMd` 是否生效）。
 *
 * 判定顺序（⚠️ 与 Rust `is_html` 逐字对齐，契约见 `src/tests/fixtures/web-html-detect.golden.json`，
 * 两侧共读）：① **Content-Type 优先**（`text/html` / `application/xhtml+xml` 时直接认定）；② 否则回退
 * **形状判定**（大小写不敏感）：剥 BOM + `trim()` 后以 `<!doctype html…` / `<html…` 开头（后接标签
 * 边界）且以 `</html>` 结尾。
 *
 * 为什么要有 Content-Type 这一层：真实站点普遍返回**小写** `<!doctype html>`，旧实现只认大写 → 大量
 * 网页被判成「非 HTML」，`htmlToMd` 形同虚设（模型拿到的是原始 HTML）。
 */
export function isHtml(content: string, contentType?: string): boolean {
  // ① Content-Type 优先：媒体类型大小写不敏感，参数（`; charset=…`）不参与判定
  const mediaType = (contentType || '').split(';')[0].trim().toLowerCase()
  if (mediaType === 'text/html' || mediaType === 'application/xhtml+xml') return true

  // ② 回退形状判定（大小写不敏感）
  const trimmed = stripBom(content).trim().toLowerCase()
  if (!trimmed.endsWith('</html>')) return false
  return (
    startsWithTagBoundary(trimmed, '<!doctype html') ||
    startsWithTagBoundary(trimmed, '<html')
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
