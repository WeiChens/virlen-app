/**
 * write_to_knowledge_base — 将内容写入知识库
 *
 * AI 可以将有用的信息、总结、提取的知识等保存到知识库中，
 * 供将来检索使用。
 */
import { toolRegistry } from '@/domain/tools'
import type { ToolExecutor, ToolResult } from '@/domain/tools/types'
import { t } from '@/ui/i18n'
import { ragService } from '@/services/rag-service'

toolRegistry.register(
    'write_to_knowledge_base',
    (async (args: Record<string, any>, _ctx: any): Promise<ToolResult> => {
    const kbId = args.knowledge_base_id
    if (!kbId || typeof kbId !== 'string') {
      return {
        content:
          'Missing required parameter: "knowledge_base_id". ' +
          'Use list_knowledge_bases to discover available knowledge bases.',
      }
    }

    const docName = args.document_name
    if (!docName || typeof docName !== 'string' || docName.trim() === '') {
      return {
        content:
          'Missing required parameter: "document_name". ' +
          'Please provide a descriptive name for the document.',
      }
    }

    const content = args.content
    if (!content || typeof content !== 'string' || content.trim() === '') {
      return {
        content:
          'Missing required parameter: "content". ' +
          'Please provide the text content to save.',
      }
    }

    try {
      const doc = await ragService.writeText(
        kbId,
        docName.trim(),
        content.trim(),
      )

      return {
        content:
          `Successfully saved "${doc.file_name}" to knowledge base (ID: ${kbId}). ` +
          `Document ID: ${doc.id}. ` +
          `The content has been chunked into ${doc.chunk_count} segments and is now available for semantic search.`,
        uiData: {
          document_id: doc.id,
          document_name: doc.file_name,
          knowledge_base_id: kbId,
          chunk_count: doc.chunk_count,
        },
      }
    } catch (error: any) {
      return {
        content: `Error writing to knowledge base: ${error.message || String(error)}`,
      }
    }
  }) as ToolExecutor,
    t('写入知识库'),
)
