/**
 * RAG 领域类型 — 知识库相关的领域模型
 */

/** RAG 上下文（注入到 LLM 的检索结果） */
export interface RAGContext {
  chunks: Array<{
    id: string
    content: string
    documentName: string
    score: number
  }>
  query: string
  knowledgeBaseId: string
  formattedContext: string
}

/** RAG 查询选项 */
export interface RAGQueryOptions {
  /** 要检索的知识库 ID 列表 */
  knowledgeBaseIds: string[]
  /** 每个知识库返回的最相关块数 */
  topK: number
  /** 最低相似度分数（0~1） */
  minScore?: number
}

/** RAG 配置 */
export interface RAGConfig {
  /** 是否启用 RAG 自动检索 */
  enabled: boolean
  /** 默认检索的知识库 ID */
  defaultKnowledgeBaseId: string
  /** 默认检索数量 */
  defaultTopK: number
  /** 注入上下文的最大字符数 */
  maxContextChars: number
  /** 嵌入模型配置（模型名、API地址等） */
  embeddingModel?: {
    provider: string
    model: string
    dimensions: number
  }
}

/** 默认 RAG 配置 */
export const defaultRAGConfig: RAGConfig = {
  enabled: false,
  defaultKnowledgeBaseId: '',
  defaultTopK: 5,
  maxContextChars: 8000,
}
