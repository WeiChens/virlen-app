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

/**
 * RAG 配置 —— 只留「怎么取」的参数（知识库固定启用、检索目标由调用方显式给 kbId）。
 *
 * 为什么没有 `enabled` / `defaultKnowledgeBaseId`：知识库已经是常开能力，检索目标由
 * 「用户当前在哪个知识库」决定（会话导入选库、文档页测试检索都在所在知识库内），
 * 不再有「全局默认库」这一层需要用户配置。
 */
export interface RAGConfig {
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
  defaultTopK: 5,
  maxContextChars: 8000,
}
