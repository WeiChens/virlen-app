/** 知识库端口 — 知识库 CRUD 与检索的抽象接口（由 infrastructure/rag 实现，经 Tauri invoke 调 Rust RAG 命令）。 */

/** 知识库元数据 */
export interface KnowledgeBase {
  id: string
  name: string
  description: string
  document_count: number
  chunk_count: number
  created_at: string
  updated_at: string
  /**
   * 系统自建（默认知识库 / 记忆详情）：由功能自己创建与维护，**不能删除**。
   * Rust 侧一定会返回它（升级前建的老库读出来是 false）；这里可选只是为了不让测试桩逐个补字段。
   */
  builtin?: boolean
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
  /**
   * 引用这份文档（把它当详情正文）的记忆 id；没有则为 `null` / 缺省。
   *
   * 系统自建库里只有「记忆详情」的正文受这条约束 —— 删/改它等于把那条记忆的正文悄悄换掉，
   * 所以后端会拒绝（`remove_document_from_knowledge_base` / `edit_*_in_knowledge_base`），
   * 界面也据此把「删除 / 编辑」换成一句说明。
   */
  memory_detail_of?: string | null
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
  /** 改知识库的名称 / 说明（`undefined` = 不动这一项） */
  update(
    kbId: string,
    name?: string,
    description?: string,
  ): Promise<KnowledgeBase>
  /** 删除知识库 */
  delete(kbId: string): Promise<void>
  /** 添加文档到知识库 */
  /** 添加文档到知识库（`docName` 可选：从文件夹导入时传相对路径，避免同名相撞） */
  addDocument(
    kbId: string,
    filePath: string,
    docName?: string,
  ): Promise<KnowledgeBaseDocument>
  /** 从知识库删除文档 */
  removeDocument(kbId: string, docId: string): Promise<void>
  /** 列出知识库中的文档 */
  listDocuments(kbId: string): Promise<KnowledgeBaseDocument[]>
  /** 检索知识库 */
  query(kbId: string, query: string, topK?: number): Promise<KnowledgeBaseQueryResult>
  /** 将文本直接写入知识库（AI Tool 使用） */
  writeText(kbId: string, docName: string, content: string): Promise<KnowledgeBaseDocument>
  /** 编辑知识库中的文档 — 用新文件替换 */
  editDocument(
    kbId: string,
    docId: string,
    filePath: string,
    docName?: string,
  ): Promise<KnowledgeBaseDocument>
  /** 获取知识库中某个文档的完整内容 */
  getDocumentContent(kbId: string, docId: string): Promise<string>
  /** 模糊搜索文档内容 — 在知识库所有 chunk 中匹配关键词，返回匹配的文档 ID 列表 */
  searchDocumentsContent(kbId: string, keyword: string): Promise<string[]>
  /** 导出知识库为 ZIP 文件 */
  exportKnowledgeBase(kbId: string, outputPath: string): Promise<void>
  /** 扫描文件夹：按 .gitignore 过滤后列出可导入的文档（导入前的预览） */
  scanImportFolder(dirPath: string): Promise<FolderScan>
  /** 列出压缩包里会导入的文档名（不解压）—— 导入前的预览，含被 .gitignore 排除的条数 */
  previewKnowledgeBaseZip(zipPath: string): Promise<ZipPreview>
  /** 读压缩包里一个条目的正文（逐条导入的一条 = 一次这个调用） */
  readKnowledgeBaseZipEntry(
    zipPath: string,
    entryName: string,
  ): Promise<string>
  /** 初始化知识库 — 无知识库时自动创建默认知识库 */
  initKnowledgeBases(): Promise<string>
}

/** 文件夹扫描结果（与 Rust `import_scan::FolderScan` 同形） */
export interface FolderScan {
  /** 可以导入的文件（绝对路径） */
  files: string[]
  /** 被 .gitignore 排除的文件数 */
  ignored: number
  /** 整棵跳过的「依赖 / 构建产物」目录个数（node_modules、dist 之类） */
  skipped_dirs: number
  /** 看着不是文本、也不是 PDF 的份数（图片 / 压缩包 / 可执行文件） */
  not_text: number
  /** 纯文本但超过 2 MB 的份数 */
  text_too_large: number
  /** PDF 但超过 50 MB 的份数 */
  pdf_too_large: number
}

/** 压缩包预览（与 Rust `ZipPreview` 同形） */
export interface ZipPreview {
  /** 会入库的条目名（已按包内 .gitignore 过滤、已排除超过 2 MB 的条目） */
  names: string[]
  /** 被 .gitignore 排除的条目数 */
  ignored: number
  /** 超过 2 MB 而没收的条目数 */
  too_large: number
}
