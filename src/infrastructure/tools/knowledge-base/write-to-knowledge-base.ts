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
