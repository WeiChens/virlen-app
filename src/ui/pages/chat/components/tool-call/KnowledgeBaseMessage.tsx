/**
 * KnowledgeBaseMessage — 知识库工具调用的消息展示组件
 *
 * 支持六个知识库工具的统一展示：
 * - search_knowledge_base：搜索知识库
 * - list_knowledge_bases：列出知识库
 * - list_knowledge_base_documents：列出文档
 * - get_knowledge_base_document：获取文档内容
 * - write_to_knowledge_base：写入知识库
 * - delete_knowledge_base_document：删除文档
 *
 * 一行显示：工具名称 + 关键参数摘要
 * 展开显示：完整的工具返回内容
 *
 * 样式一律走 style.scss 的类（主题令牌）：这里不写内联 px 字号，也不写死色值 ——
 * 内联 px 用不了 `var()`，「设置 → 字体大小 / 主题色」都跟不动（口径见 theme.scss 的字号等级一节）。
 * 折叠态那一行用共用的 `.tool-short-*` 片段，展开态用 `.kb-*`。
 */
import { t, tpl } from '@/ui/i18n'
import { IToolCallMessage, ToolMessageProps } from './IToolCallMessage'
import CodeBlock from '../message/code-block'

interface SearchResultItem {
  id: string
  document_name: string
  document_id: string
  score: number
  snippet: string
}

interface KnowledgeBaseItem {
  id: string
  name: string
  description: string
  documentCount: number
}

interface DocumentItem {
  id: string
  file_name: string
  file_type: string
  chunk_count: number
  status: string
}

class KnowledgeBaseMessage implements IToolCallMessage {
  getToolName(): string {
    return 'knowledge_base'
  }

  getToolLabel(type: string): string {
    const labels: Record<string, string> = {
      search_knowledge_base: t('搜索知识库'),
      list_knowledge_bases: t('列出知识库'),
      list_knowledge_base_documents: t('列出文档'),
      get_knowledge_base_document: t('获取文档内容'),
      write_to_knowledge_base: t('写入知识库'),
      delete_knowledge_base_document: t('删除文档'),
    }
    return labels[type] || t('知识库')
  }

  getShortText(props: ToolMessageProps): string | React.ReactNode {
    try {
      const input = props.useContent.input as any
      const type = props.useContent.name

      switch (type) {
        case 'search_knowledge_base': {
          const query: string = input?.query ?? ''
          const kbId: string = input?.knowledge_base_id ?? ''
          const uiData = props.message?.uiData as
            | { length?: number }
            | undefined
          const count = uiData?.length
          return (
            <div className="tool-short-row">
              <span className="tool-short-em">{query}</span>
              <span className="tool-short-muted">
                {count !== undefined
                  ? tpl('— $__count__ 条结果', { count })
                  : tpl('ID: $__id__', { id: kbId.slice(0, 8) + '...' })}
              </span>
            </div>
          )
        }

        case 'list_knowledge_bases': {
          const uiData = props.message?.uiData as
            | { length?: number; knowledgeBases?: KnowledgeBaseItem[] }
            | undefined
          const count = uiData?.length ?? 0
          return (
            tpl('共 $__count__ 个知识库', { count })
          )
        }

        case 'list_knowledge_base_documents': {
          const kbId: string = input?.knowledge_base_id ?? ''
          const uiData = props.message?.uiData as
            | { length?: number }
            | undefined
          const count = uiData?.length ?? 0
          return (
            tpl('ID: $__id__ · $__count__ 个文档', {
              id: kbId.slice(0, 8) + '...',
              count,
            })
          )
        }

        case 'get_knowledge_base_document': {
          const docId: string = input?.document_id ?? ''
          return (
            tpl('文档 ID: $__id__', { id: docId.slice(0, 8) + '...' })
          )
        }

        case 'write_to_knowledge_base': {
          const docName: string = input?.document_name ?? ''
          const uiData = props.message?.uiData as
            | { chunk_count?: number }
            | undefined
          const chunks = uiData?.chunk_count
          return (
            <div className="tool-short-row">
              <span className="tool-short-em">{docName}</span>
              {chunks !== undefined && (
                <span className="tool-short-muted">
                  {tpl('— $__count__ 个片段', { count: chunks })}
                </span>
              )}
            </div>
          )
        }

        case 'delete_knowledge_base_document': {
          const docId: string = input?.document_id ?? ''
          return (
            <span className="tool-short-danger">
              {tpl('文档 ID: $__id__', { id: docId.slice(0, 8) + '...' })}
            </span>
          )
        }

        default:
          return ''
      }
    } catch {
      return t('解析异常')
    }
  }

  getExpandView(props: ToolMessageProps): React.ReactNode {
    if (props.message?.isError) {
      return <div className="error">{props.message.content as string}</div>
    }
    try {
      const type = props.useContent.name
      const content = props.message?.content as string | undefined
      const uiData = props.message?.uiData as any

      if (!content) {
        return <div className="kb-empty-state">{t('无返回数据')}</div>
      }

      // 针对 search_knowledge_base 做结构化渲染
      if (type === 'search_knowledge_base' && uiData?.results) {
        const results = uiData.results as SearchResultItem[]
        return (
          <div className="kb-search-results-list">
            {results.map((item, index) => (
              <div key={item.id} className="kb-search-result-item">
                <div className="kb-search-result-header">
                  <span className="kb-search-result-index">#{index + 1}</span>
                  <span className="kb-search-result-doc">
                    {item.document_name}
                  </span>
                  <span className="kb-search-result-score">
                    {tpl('$__score__%', {
                      score: (item.score * 100).toFixed(0),
                    })}
                  </span>
                </div>
                <div className="kb-search-result-id">
                  {tpl('文档 ID: $__id__', { id: item.document_id })}
                </div>
                <div className="kb-search-result-snippet">{item.snippet}</div>
              </div>
            ))}
          </div>
        )
      }

      // 针对 list_knowledge_bases 做结构化渲染
      if (type === 'list_knowledge_bases' && uiData?.knowledgeBases) {
        const kbs = uiData.knowledgeBases as KnowledgeBaseItem[]
        return (
          <div className="kb-list-results">
            {kbs.map((kb, index) => (
              <div key={kb.id} className="kb-list-item">
                <div className="kb-list-item-header">
                  <span className="kb-list-item-index">#{index + 1}</span>
                  <span className="kb-list-item-name">{kb.name}</span>
                </div>
                <div className="kb-list-item-id">
                  {tpl('ID: $__id__', { id: kb.id })}
                </div>
                {kb.description && (
                  <div className="kb-list-item-desc">{kb.description}</div>
                )}
                <div className="kb-list-item-meta">
                  {tpl('$__count__ 个文档', { count: kb.documentCount })}
                </div>
              </div>
            ))}
          </div>
        )
      }

      // 针对 list_knowledge_base_documents 做结构化渲染
      if (type === 'list_knowledge_base_documents' && uiData?.documents) {
        const docs = uiData.documents as DocumentItem[]
        return (
          <div className="kb-doc-list-results">
            {docs.map((doc, index) => (
              <div key={doc.id} className="kb-doc-item">
                <div className="kb-doc-item-header">
                  <span className="kb-doc-item-index">#{index + 1}</span>
                  <span className="kb-doc-item-name" title={doc.file_name}>
                    {doc.file_name}
                  </span>
                  <span className={`kb-doc-item-status status-${doc.status}`}>
                    {doc.status === 'ready'
                      ? t('就绪')
                      : doc.status === 'processing'
                        ? t('处理中')
                        : t('错误')}
                  </span>
                </div>
                <div className="kb-doc-item-id">
                  {tpl('ID: $__id__ · $__type__ · $__count__ 个片段', {
                    id: doc.id,
                    type: doc.file_type,
                    count: doc.chunk_count,
                  })}
                </div>
              </div>
            ))}
          </div>
        )
      }

      // 兜底：使用 CodeBlock 展示原始内容
      return (
        <CodeBlock
          width={'100%'}
          maxHeight={600}
          showLineNumbers={false}>
          {content}
        </CodeBlock>
      )
    } catch {
      return <div className="error">{t('解析异常')}</div>
    }
  }

  diyWrapper(): boolean {
    return false
  }
}

export default KnowledgeBaseMessage
