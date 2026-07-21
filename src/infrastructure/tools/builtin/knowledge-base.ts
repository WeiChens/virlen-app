/**
 * 知识库工具 — 让 AI 可以主动检索、管理和写入知识库
 *
 * 注册六个工具：
 * 1. `search_knowledge_base` — 在指定知识库中搜索相关内容
 * 2. `list_knowledge_bases` — 列出所有可用知识库
 * 3. `list_knowledge_base_documents` — 列出知识库中的所有文档
 * 4. `get_knowledge_base_document` — 获取知识库中某个文档的完整内容
 * 5. `write_to_knowledge_base` — 将文本内容写入知识库
 * 6. `delete_knowledge_base_document` — 删除知识库中的文档
 *
 * ⚠️ AI 自主决定何时使用这些工具，引擎不会自动注入 RAG 上下文。
 */

import { toolRegistry } from '@/domain/tools'
import type { ToolExecutor, ToolResult } from '@/domain/tools/types'
import { t } from '@/ui/i18n'
import { ragService } from '@/services/rag-service'
import type { KnowledgeBaseChunk } from '@/domain/ports'

/**
 * 构建包含 document_id 的搜索上下文（AI 可见的格式化文本）
 *
 * 相比 Rust 后端返回的 context（只有 document_name），
 * 此函数额外输出 document_id，使 AI 能识别每个 chunk 所属的文档，
 * 从而能够调用 delete_knowledge_base_document / edit_text_in_kb 等需要 document_id 的工具。
 */
function buildSearchContext(
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

/**
 * search_knowledge_base — 语义搜索知识库
 *
 * AI 可以在回答问题时主动检索知识库中的相关文档内容，
 * 就像 web_search 搜索互联网一样。
 */
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
            snippet: r.content.slice(0, 200),
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

/**
 * get_knowledge_base_document — 获取知识库中某个文档的完整内容
 *
 * 返回指定文档的所有文本内容（按原始顺序拼接）。
 * AI 先用 list_knowledge_base_documents 获取文档 ID，
 * 再用此工具获取完整内容进行深度分析。
 */
toolRegistry.register(
  {
    name: 'get_knowledge_base_document',
    label: t('获取文档内容'),
    description:
      'Get the full content of a specific document in a knowledge base. ' +
      'Returns all text content of the document, which can be used for deep analysis, ' +
      'summarization, or extracting specific information. ' +
      'Use list_knowledge_base_documents first to find the document ID, ' +
      'then use this tool to retrieve the full content.',
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
            'The ID of the document to retrieve. ' +
            'Use list_knowledge_base_documents to find document IDs.',
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
)

/**
 * list_knowledge_base_documents — 列出知识库中的所有文档
 *
 * 返回指定知识库中所有文档的名称、ID、文件类型和片段数。
 * AI 先使用 list_knowledge_bases 发现知识库，
 * 再使用此工具获取文档 ID，然后可用 delete_knowledge_base_document 删除
 * 或用 search_knowledge_base 搜索特定文档内容。
 */
toolRegistry.register(
  {
    name: 'list_knowledge_base_documents',
    label: t('列出文档'),
    description:
      'List all documents in a specific knowledge base. ' +
      'Returns the document name, ID, file type, chunk count, and status for each document. ' +
      'Use this tool to discover document IDs needed for delete_knowledge_base_document. ' +
      'Use list_knowledge_bases first to discover available knowledge base IDs.',
    parameters: {
      type: 'object',
      properties: {
        knowledge_base_id: {
          type: 'string',
          description:
            'The ID of the knowledge base to list documents from. ' +
            'Use list_knowledge_bases tool to see available knowledge bases.',
        },
      },
      required: ['knowledge_base_id'],
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
)

/**
 * delete_knowledge_base_document — 删除知识库中的文档
 *
 * AI 可以删除不再需要的文档。
 * 先使用 list_knowledge_bases 发现可用知识库，
 * 再使用 list_kb_documents （通过 search_knowledge_base 或用户提供）获取文档 ID。
 */
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

/**
 * list_knowledge_bases — 列出所有可用知识库
 *
 * 辅助工具，帮助 AI 了解有哪些知识库可供检索和写入。
 */
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

/**
 * write_to_knowledge_base — 将内容写入知识库
 *
 * AI 可以将有用的信息、总结、提取的知识等保存到知识库中，
 * 供将来检索使用。
 */
toolRegistry.register(
  {
    name: 'write_to_knowledge_base',
    label: t('写入知识库'),
    description:
      'Write text content to a knowledge base. ' +
      'Use this tool to save useful information, summaries, extracted knowledge, ' +
      'or any content that should be stored for future reference and search. ' +
      'The content will be automatically chunked, embedded, and indexed for semantic search. ' +
      'Use list_knowledge_bases first to discover available knowledge bases and their IDs.',
    parameters: {
      type: 'object',
      properties: {
        knowledge_base_id: {
          type: 'string',
          description:
            'The ID of the knowledge base to write to. ' +
            'Use list_knowledge_bases tool to see available knowledge bases and their IDs.',
        },
        document_name: {
          type: 'string',
          description:
            'A descriptive name for this document (e.g., "Meeting Notes - Q4 Planning", "Research Summary - Rust vs Go"). ' +
            'This helps users identify the content later.',
        },
        content: {
          type: 'string',
          description:
            'The text content to save. This can include formatted text, code snippets, structured data, etc. ' +
            'The content will be automatically indexed and made searchable.',
        },
      },
      required: ['knowledge_base_id', 'document_name', 'content'],
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
)
