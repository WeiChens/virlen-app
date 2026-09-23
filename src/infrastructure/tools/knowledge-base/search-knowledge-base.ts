/**
 * search_knowledge_base — 语义搜索知识库
 *
 * AI 可以在回答问题时主动检索知识库中的相关文档内容，
 * 就像 web_search 搜索互联网一样。
 */
import { toolRegistry } from '@/domain/tools'
import type { ToolExecutor, ToolResult } from '@/domain/tools/types'
import { t } from '@/ui/i18n'
import { ragService } from '@/services/rag-service'
import { buildSearchContext } from './common'
import { sliceHead } from '@/utils/text'

toolRegistry.register(
  {
    name: 'search_knowledge_base',
    label: t('搜索知识库'),
    description:
      'Search the knowledge base for relevant information. ' +
      'Use this tool when you need to answer questions based on uploaded documents, ' +
      'private data, or any content stored in the knowledge base. ' +
      'Returns relevant text chunks with similarity scores and source document names. ' +
      'The results can be used as context to answer user questions accurately. ' +
      'Always call list_knowledge_bases first to discover available knowledge bases, ' +
      'then use the correct knowledge_base_id for your search.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'The search query. Be specific and use keywords for better results.',
        },
        knowledge_base_id: {
          type: 'string',
          description:
            'The ID of the knowledge base to search in. ' +
            'Use list_knowledge_bases tool to see available knowledge bases and their IDs.',
        },
        top_k: {
          type: 'number',
          description:
            'Number of relevant chunks to return. Default: 5, Max: 20.',
          default: 5,
        },
      },
      required: ['query', 'knowledge_base_id'],
    },
  },
  (async (args: Record<string, any>, _ctx: any): Promise<ToolResult> => {
    const query = args.query
    if (!query || typeof query !== 'string' || query.trim() === '') {
      return {
        content:
          'Missing required parameter: "query". Please provide a search query.',
      }
    }

    const kbId = args.knowledge_base_id
    if (!kbId || typeof kbId !== 'string') {
      return {
        content:
          'Missing required parameter: "knowledge_base_id". ' +
          'Use list_knowledge_bases to discover available knowledge bases and their IDs.',
      }
    }

    const topK = Math.min(args.top_k ?? 5, 20)

    try {
      const result = await ragService.query(kbId, query.trim(), topK)

      if (!result.results || result.results.length === 0) {
        return {
          content: `No relevant information found in knowledge base "${kbId}" for query: "${query}".`,
          uiData: { length: 0, query },
        }
      }

      // 构建包含 document_id 的上下文（Rust 返回的 context 不含 document_id）
      const contextWithDocIds = buildSearchContext(result.results, query, kbId)

      return {
        content: contextWithDocIds,
        uiData: {
          length: result.results.length,
          results: result.results.map((r) => ({
            id: r.id,
            document_name: r.document_name,
            document_id: r.document_id,
            score: r.score,
            snippet: sliceHead(r.content, 200),
          })),
          query,
          knowledge_base_id: kbId,
        },
      }
    } catch (error: any) {
      return {
        content: `Error searching knowledge base: ${error.message || String(error)}`,
      }
    }
  }) as ToolExecutor,
)
