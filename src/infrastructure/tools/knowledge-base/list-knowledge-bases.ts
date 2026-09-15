/**
 * list_knowledge_bases — 列出所有可用知识库
 *
 * 辅助工具，帮助 AI 了解有哪些知识库可供检索和写入。
 */
import { toolRegistry } from '@/domain/tools'
import type { ToolExecutor, ToolResult } from '@/domain/tools/types'
import { t } from '@/ui/i18n'
import { ragService } from '@/services/rag-service'

toolRegistry.register(
  {
    name: 'list_knowledge_bases',
    label: t('列出知识库'),
    description:
      'List all available knowledge bases. ' +
      'Returns the name, description, ID, and document count for each knowledge base. ' +
      'Use this tool to discover which knowledge bases are available before searching or writing. ' +
      'The ID field is required for search_knowledge_base and write_to_knowledge_base tools.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  (async (_args: Record<string, any>, _ctx: any): Promise<ToolResult> => {
    try {
      const kbs = await ragService.listKnowledgeBases()

      if (!kbs || kbs.length === 0) {
        return {
          content:
            'No knowledge bases found. ' +
            'Create a knowledge base first and upload documents to it, ' +
            'or use write_to_knowledge_base to create new content.',
          uiData: { length: 0 },
        }
      }

      // 为每个知识库获取文档标题（最多 20 个）
      const kbDocPromises = kbs.map(async (kb) => {
        let docs: Array<{ file_name: string; id: string }> = []
        try {
          const result = await ragService.listDocuments(kb.id)
          docs = result.slice(0, 20).map((d) => ({ file_name: d.file_name, id: d.id }))
        } catch {
          // 单个知识库查询失败不影响其他
        }
        return { kb, docs }
      })

      const kbDocs = await Promise.all(kbDocPromises)

      const lines: string[] = []
      lines.push(`📚 Available Knowledge Bases (${kbs.length} total):`)
      lines.push('')

      for (let i = 0; i < kbDocs.length; i++) {
        const { kb, docs } = kbDocs[i]
        lines.push(`[${i + 1}] ${kb.name}`)
        lines.push(`    ID: ${kb.id}`)
        lines.push(`    Description: ${kb.description || 'No description'}`)
        lines.push(`    Documents: ${kb.document_count}`)
        lines.push(`    Chunks: ${kb.chunk_count}`)

        if (docs.length > 0) {
          const docLines = docs.map((d, idx) => `      ${idx + 1}. ${d.file_name}  (ID: ${d.id})`)
          lines.push(`    Document titles (showing ${docs.length} of ${kb.document_count}):`)
          lines.push(docLines.join('\n'))
        }
        lines.push('')
      }

      lines.push('---')
      lines.push(
        'Use list_knowledge_base_documents with the knowledge_base_id to see all documents and their IDs.',
      )
      lines.push(
        'Use search_knowledge_base with the knowledge_base_id to search within a specific knowledge base.',
      )
      lines.push(
        'Use write_to_knowledge_base with the knowledge_base_id to save new content.',
      )

      return {
        content: lines.join('\n'),
        uiData: {
          length: kbs.length,
          knowledgeBases: kbs.map((kb) => ({
            id: kb.id,
            name: kb.name,
            description: kb.description,
            documentCount: kb.document_count,
          })),
        },
      }
    } catch (error: any) {
      return {
        content: `Error listing knowledge bases: ${error.message || String(error)}`,
      }
    }
  }) as ToolExecutor,
)
