/**
 * list_knowledge_base_documents — 列出知识库中的所有文档
 *
 * 返回指定知识库中所有文档的名称、ID、文件类型和片段数。
 * AI 先使用 list_knowledge_bases 发现知识库，
 * 再使用此工具获取文档 ID，然后可用 delete_knowledge_base_document 删除
 * 或用 search_knowledge_base 搜索特定文档内容。
 */
import { toolRegistry } from '@/domain/tools'
import type { ToolExecutor, ToolResult } from '@/domain/tools/types'
import { t } from '@/ui/i18n'
import { ragService } from '@/services/rag-service'

toolRegistry.register(
    'list_knowledge_base_documents',
    (async (args: Record<string, any>, _ctx: any): Promise<ToolResult> => {
    const kbId = args.knowledge_base_id
    if (!kbId || typeof kbId !== 'string') {
      return {
        content:
          'Missing required parameter: "knowledge_base_id". ' +
          'Use list_knowledge_bases to discover available knowledge bases.',
      }
    }

    try {
      const docs = await ragService.listDocuments(kbId)

      if (!docs || docs.length === 0) {
        return {
          content:
            `No documents found in knowledge base "${kbId}". ` +
            'Use write_to_knowledge_base to create new content, ' +
            'or upload documents through the UI.',
          uiData: { length: 0, knowledge_base_id: kbId },
        }
      }

      const lines: string[] = []
      lines.push(`📄 Documents in knowledge base "${kbId}" (${docs.length} total):`)
      lines.push('')

      for (let i = 0; i < docs.length; i++) {
        const d = docs[i]
        lines.push(`[${i + 1}] ${d.file_name}`)
        lines.push(`    Document ID: ${d.id}`)
        lines.push(`    Type: ${d.file_type}`)
        lines.push(`    Chunks: ${d.chunk_count}`)
        lines.push(`    Status: ${d.status}`)
        lines.push('')
      }

      lines.push('---')
      lines.push('Use search_knowledge_base to search within this knowledge base.')
      lines.push('Use delete_knowledge_base_document with a Document ID to remove it.')

      return {
        content: lines.join('\n'),
        uiData: {
          length: docs.length,
          knowledge_base_id: kbId,
          documents: docs.map((d) => ({
            id: d.id,
            file_name: d.file_name,
            file_type: d.file_type,
            chunk_count: d.chunk_count,
            status: d.status,
          })),
        },
      }
    } catch (error: any) {
      return {
        content: `Error listing documents: ${error.message || String(error)}`,
      }
    }
  }) as ToolExecutor,
    t('列出文档'),
)
