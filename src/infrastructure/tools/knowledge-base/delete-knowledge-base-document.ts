/**
 * delete_knowledge_base_document — 删除知识库中的文档
 *
 * AI 可以删除不再需要的文档。
 * 先使用 list_knowledge_bases 发现可用知识库，
 * 再使用 list_knowledge_base_documents 获取文档 ID。
 */
import { toolRegistry } from '@/domain/tools'
import type { ToolExecutor, ToolResult } from '@/domain/tools/types'
import { t } from '@/ui/i18n'
import { ragService } from '@/services/rag-service'

toolRegistry.register(
  {
    name: 'delete_knowledge_base_document',
    label: t('删除文档'),
    description:
      'Delete a document from a knowledge base. ' +
      'Use this tool to remove outdated or incorrect documents from a knowledge base. ' +
      'The document and all its chunks will be permanently removed and will no longer be searchable. ' +
      'Use list_knowledge_bases to discover knowledge base IDs, ' +
      'then use list_knowledge_base_documents to find document IDs within a knowledge base.',
    parameters: {
      type: 'object',
      properties: {
        knowledge_base_id: {
          type: 'string',
          description:
            'The ID of the knowledge base containing the document. ' +
            'Use list_knowledge_bases tool to see available knowledge bases.',
        },
        document_id: {
          type: 'string',
          description:
            'The ID of the document to delete. ' +
            'Use list_knowledge_base_documents to find document IDs within a knowledge base.',
        },
      },
      required: ['knowledge_base_id', 'document_id'],
    },
  },
  (async (args: Record<string, any>, _ctx: any): Promise<ToolResult> => {
    const kbId = args.knowledge_base_id
    if (!kbId || typeof kbId !== 'string') {
      return {
        content:
          'Missing required parameter: "knowledge_base_id". ' +
          'Use list_knowledge_bases to discover available knowledge bases.',
      }
    }

    const docId = args.document_id
    if (!docId || typeof docId !== 'string') {
      return {
        content:
          'Missing required parameter: "document_id". ' +
          'Use search_knowledge_base to find document IDs within a knowledge base.',
      }
    }

    try {
      await ragService.removeDocument(kbId, docId)

      return {
        content:
          `Successfully deleted document "${docId}" from knowledge base (ID: ${kbId}). ` +
          `The document and all its chunks have been permanently removed.`,
        uiData: {
          document_id: docId,
          knowledge_base_id: kbId,
        },
      }
    } catch (error: any) {
      return {
        content: `Error deleting document from knowledge base: ${error.message || String(error)}`,
      }
    }
  }) as ToolExecutor,
)
