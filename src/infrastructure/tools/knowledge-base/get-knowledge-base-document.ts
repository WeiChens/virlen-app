/**
 * get_knowledge_base_document — 获取知识库中某个文档的完整内容
 *
 * 返回指定文档的所有文本内容（按原始顺序拼接）。
 * AI 先用 list_knowledge_base_documents 获取文档 ID，
 * 再用此工具获取完整内容进行深度分析。
 */
import { toolRegistry } from '@/domain/tools'
import type { ToolExecutor, ToolResult } from '@/domain/tools/types'
import { t } from '@/ui/i18n'
import { ragService } from '@/services/rag-service'

toolRegistry.register(
    'get_knowledge_base_document',
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
          'Use list_knowledge_base_documents to find document IDs.',
      }
    }

    try {
      const content = await ragService.getDocumentContent(kbId, docId)

      return {
        content:
          `Full content of document "${docId}" from knowledge base (ID: ${kbId}):\n\n---\n${content}\n---`,
        uiData: {
          document_id: docId,
          knowledge_base_id: kbId,
        },
      }
    } catch (error: any) {
      return {
        content: `Error retrieving document: ${error.message || String(error)}`,
      }
    }
  }) as ToolExecutor,
    t('获取文档内容'),
)
