/**
 * 文档列表的过滤 / 分页口径（纯函数）
 *
 * 守的两个回归：
 * 1. **清空搜索框必须恢复完整列表** —— 以前 `matchedIds` 在关键词为空时照样生效，
 *    把框删空列表也回不来（看起来像「清空没用」）；
 * 2. **按名称筛选是即时过滤、按内容才用后端命中** —— 两条口径不能混。
 */
import { describe, it, expect } from 'vitest'
import {
  filterDocuments,
  pageSlice,
  totalPagesOf,
} from '@/ui/pages/Settings/knowledge-base/doc-filter'
import type { KnowledgeBaseDocument } from '@/domain/ports'

function doc(id: string, name: string): KnowledgeBaseDocument {
  return {
    id,
    file_name: name,
    file_type: 'md',
    file_size: 10,
    chunk_count: 1,
    status: 'ready',
    created_at: '2026-01-01T00:00:00Z',
  }
}

const docs = [doc('d1', 'Rust 入门.md'), doc('d2', 'python 笔记.md'), doc('d3', 'readme.txt')]

describe('filterDocuments', () => {
  it('关键词为空 → 原样返回（不论模式、也不论上一次搜到了什么）', () => {
    expect(filterDocuments(docs, '', 'title', null)).toEqual(docs)
    expect(filterDocuments(docs, '   ', 'title', null)).toEqual(docs)
    // ⭐ 回归点：清空输入框后不能还按上一次「按内容」的命中结果过滤
    expect(
      filterDocuments(docs, '', 'content', new Set(['d2'])),
    ).toEqual(docs)
  })

  it('按名称：大小写不敏感的子串匹配，不改动原数组', () => {
    const out = filterDocuments(docs, 'PYTHON', 'title', null)
    expect(out.map((d) => d.id)).toEqual(['d2'])
    expect(docs).toHaveLength(3)
  })

  it('按名称：关键词两端空白不影响匹配', () => {
    expect(filterDocuments(docs, '  readme  ', 'title', null).map((d) => d.id)).toEqual(['d3'])
  })

  it('按内容：用后端返回的命中文档 id 过滤', () => {
    expect(
      filterDocuments(docs, '启动', 'content', new Set(['d1', 'd3'])).map((d) => d.id),
    ).toEqual(['d1', 'd3'])
  })

  it('按内容：还没拿到命中结果时不过滤（避免「搜索中一片空白」）', () => {
    expect(filterDocuments(docs, '启动', 'content', null)).toEqual(docs)
  })

  it('按内容：后端说一份都没命中 → 空列表（而不是「没过滤」）', () => {
    expect(filterDocuments(docs, '启动', 'content', new Set())).toEqual([])
  })
})

describe('分页', () => {
  it('总页数：空列表也算 1 页（界面上不该出现 1 / 0）', () => {
    expect(totalPagesOf(0, 10)).toBe(1)
    expect(totalPagesOf(10, 10)).toBe(1)
    expect(totalPagesOf(11, 10)).toBe(2)
  })

  it('越界页码收到最后一页，页码小于 1 收到第 1 页', () => {
    const items = Array.from({ length: 25 }, (_, i) => i)
    expect(pageSlice(items, 99, 10)).toEqual([20, 21, 22, 23, 24])
    expect(pageSlice(items, 0, 10)).toEqual(items.slice(0, 10))
    expect(pageSlice(items, 2, 10)).toEqual(items.slice(10, 20))
  })

  it('筛选后总页数变小 → 切片跟着收敛（不会切出空窗口）', () => {
    const items = Array.from({ length: 12 }, (_, i) => i)
    // 12 条时第 2 页只有 2 条；筛到只剩 3 条时，不管请求第几页都只能给第 1 页的内容
    expect(pageSlice(items.slice(0, 3), 2, 10)).toEqual([0, 1, 2])
  })
})
