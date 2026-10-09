/**
 * 文档列表的过滤口径（纯函数，无 React / 无 Tauri 依赖 —— 就是为了能直接单测）
 *
 * 为什么单独一个文件：这段逻辑以前在 `DocListModal` 的 footer 与列表里各写了一遍，
 * 改一处漏一处；而它恰好是「清空输入框不恢复」「筛选不回第 1 页」那类 bug 的老家。
 */
import type { KnowledgeBaseDocument } from '@/domain/ports'

export type DocSearchMode = 'title' | 'content'

/**
 * 按当前搜索条件过滤文档。
 *
 * 两条口径：
 * - 按名称：前端即时过滤（不用请求后端）；
 * - 按内容：用后端返回的命中文档 id 过滤。
 *
 * ⚠️ `matchedIds` 只在**按内容且有关键词**时生效 —— 否则用户把搜索框删空后，列表会一直
 * 停在上一次内容搜索的结果上（看起来像「清空没用」）。
 */
export function filterDocuments(
  docs: KnowledgeBaseDocument[],
  query: string,
  mode: DocSearchMode,
  matchedIds: Set<string> | null,
): KnowledgeBaseDocument[] {
  const keyword = query.trim().toLowerCase()
  if (!keyword) return docs
  if (mode === 'title') {
    return docs.filter((d) => d.file_name.toLowerCase().includes(keyword))
  }
  return matchedIds ? docs.filter((d) => matchedIds.has(d.id)) : docs
}

/** 分页切片（`page` 从 1 开始；越界时返回最后一页） */
export function pageSlice<T>(items: T[], page: number, pageSize: number): T[] {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize))
  const safePage = Math.min(Math.max(1, page), totalPages)
  return items.slice((safePage - 1) * pageSize, safePage * pageSize)
}

/** 总页数（空列表也算 1 页，免得界面上出现「1 / 0」） */
export function totalPagesOf(count: number, pageSize: number): number {
  return Math.max(1, Math.ceil(count / pageSize))
}
