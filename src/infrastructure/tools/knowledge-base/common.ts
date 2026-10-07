/** knowledge-base — 知识库分类公共函数（id: knowledge_base），供本分类 6 个工具复用。 */
import type { KnowledgeBaseChunk } from '@/domain/ports'

/**
 * 构建含 document_id 的搜索上下文（AI 可见文本）。相比 Rust 后端返回的 context（只有 document_name），
 * 额外输出 document_id，使 AI 能识别每个 chunk 所属文档，从而调用需要 document_id 的工具。
 */
export function buildSearchContext(
  results: KnowledgeBaseChunk[],
  query: string,
  kbId: string,
): string {
  const lines: string[] = []
  lines.push(`Search results from knowledge base "${kbId}" for query: "${query}"`)
  lines.push('')

  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    lines.push(`[${i + 1}] Document: ${r.document_name}`)
    lines.push(`    Document ID: ${r.document_id}`)
    lines.push(`    Similarity: ${(r.score * 100).toFixed(1)}%`)
    lines.push(`    Content: ${r.content}`)
    lines.push('')
  }

  lines.push('---')
  lines.push('To delete or edit a document, use its Document ID above.')

  return lines.join('\n')
}
