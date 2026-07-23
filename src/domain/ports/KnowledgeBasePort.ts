/**
 * 知识库端口 — 定义知识库 CRUD 和检索的抽象接口
 *
 * 遵循六边形架构，由基础设施层（infrastructure/rag）实现，
 * 通过 Tauri invoke 调用 Rust 后端的 RAG 命令。
 */

/** 知识库元数据 */
export interface KnowledgeBase {
  id: string
  name: string
  description: string
  document_count: number
  chunk_count: number
  created_at: string
  updated_at: string
}

/** 知识库中的文档信息 */
export interface KnowledgeBaseDocument {
  id: string
  file_name: string
  file_type: string
  file_size: number
  chunk_count: number
  status: 'processing' | 'ready' | 'error'
  error?: string
  created_at: string
}

/** 检索结果块 */
export interface KnowledgeBaseChunk {
  id: string
  content: string
  document_id: string
  document_name: string
  chunk_index: number
  score: number
}

/** 检索响应（含格式化的上下文） */
export interface KnowledgeBaseQueryResult {
  results: KnowledgeBaseChunk[]
  context: string
}

/** 知识库端口接口 */
export interface KnowledgeBasePort {
  /** 创建知识库 */
  create(name: string, description?: string): Promise<KnowledgeBase>
  /** 列出所有知识库 */
  list(): Promise<KnowledgeBase[]>
  /** 删除知识库 */
  delete(kbId: string): Promise<void>
  /** 添加文档到知识库 */
  addDocument(kbId: string, filePath: string): Promise<KnowledgeBaseDocument>
  /** 从知识库删除文档 */
  removeDocument(kbId: string, docId: string): Promise<void>
  /** 列出知识库中的文档 */
  listDocuments(kbId: string): Promise<KnowledgeBaseDocument[]>
  /** 检索知识库 */
  query(kbId: string, query: string, topK?: number): Promise<KnowledgeBaseQueryResult>
  /** 将文本直接写入知识库（AI Tool 使用） */
  writeText(kbId: string, docName: string, content: string): Promise<KnowledgeBaseDocument>
  /** 编辑知识库中的文档 — 用新文件替换 */
  editDocument(kbId: string, docId: string, filePath: string): Promise<KnowledgeBaseDocument>
  /** 获取知识库中某个文档的完整内容 */
  getDocumentContent(kbId: string, docId: string): Promise<string>
  /** 模糊搜索文档内容 — 在知识库所有 chunk 中匹配关键词，返回匹配的文档 ID 列表 */
  searchDocumentsContent(kbId: string, keyword: string): Promise<string[]>
  /** 导出知识库为 ZIP 文件 */
  exportKnowledgeBase(kbId: string, outputPath: string): Promise<void>
  /** 初始化知识库 — 无知识库时自动创建默认知识库 */
  initKnowledgeBases(): Promise<string>
}
