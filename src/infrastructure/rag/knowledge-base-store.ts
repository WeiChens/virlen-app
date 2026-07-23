/**
 * 知识库基础设施实现 — 通过 Tauri invoke 调用 Rust 后端的 RAG 命令
 */

import { invoke } from '@tauri-apps/api/core'
import type {
  KnowledgeBase,
  KnowledgeBaseDocument,
  KnowledgeBasePort,
  KnowledgeBaseQueryResult,
} from '@/domain/ports'

/**
 * 知识库存储 — 实现 KnowledgeBasePort 接口
 *
 * 所有方法通过 Tauri IPC 调用 Rust 端实现的 RAG 命令，
 * 使用 spawn_blocking 异步执行，不会阻塞 UI。
 */
class KnowledgeBaseStore implements KnowledgeBasePort {
  /** 创建知识库 */
  async create(name: string, description?: string): Promise<KnowledgeBase> {
    return invoke<KnowledgeBase>('create_knowledge_base', {
      name,
      description: description ?? '',
    })
  }

  /** 列出所有知识库 */
  async list(): Promise<KnowledgeBase[]> {
    const result = await invoke<unknown[]>('list_knowledge_bases')
    return result as KnowledgeBase[]
  }

  /** 删除知识库 */
  async delete(kbId: string): Promise<void> {
    await invoke('delete_knowledge_base', { kbId })
  }

  /** 添加文档到知识库 */
  async addDocument(
    kbId: string,
    filePath: string,
  ): Promise<KnowledgeBaseDocument> {
    return invoke<KnowledgeBaseDocument>('add_document_to_knowledge_base', {
      kbId,
      filePath,
    })
  }

  /** 从知识库删除文档 */
  async removeDocument(kbId: string, docId: string): Promise<void> {
    await invoke('remove_document_from_knowledge_base', { kbId, docId })
  }

  /** 列出知识库中的文档 */
  async listDocuments(kbId: string): Promise<KnowledgeBaseDocument[]> {
    const result = await invoke<unknown[]>('list_knowledge_base_documents', { kbId })
    return result as KnowledgeBaseDocument[]
  }

  /** 检索知识库 */
  async query(
    kbId: string,
    query: string,
    topK: number = 5,
  ): Promise<KnowledgeBaseQueryResult> {
    return invoke<KnowledgeBaseQueryResult>('query_knowledge_base', {
      kbId,
      query,
      topK,
    })
  }

  /** 将文本直接写入知识库（AI Tool 使用） */
  async writeText(
    kbId: string,
    docName: string,
    content: string,
  ): Promise<KnowledgeBaseDocument> {
    return invoke<KnowledgeBaseDocument>('write_text_to_knowledge_base', {
      kbId,
      docName,
      content,
    })
  }

  /** 编辑知识库中的文档 — 用新文件替换 */
  async editDocument(
    kbId: string,
    docId: string,
    filePath: string,
  ): Promise<KnowledgeBaseDocument> {
    return invoke<KnowledgeBaseDocument>('edit_document_in_knowledge_base', {
      kbId,
      docId,
      filePath,
    })
  }

  /** 编辑知识库中的文本文档 — 用新内容替换（AI Tool 使用） */
  async editTextDocument(
    kbId: string,
    docId: string,
    docName: string,
    content: string,
  ): Promise<KnowledgeBaseDocument> {
    return invoke<KnowledgeBaseDocument>('edit_text_in_knowledge_base', {
      kbId,
      docId,
      docName,
      content,
    })
  }

  /** 获取知识库中某个文档的完整内容 */
  async getDocumentContent(
    kbId: string,
    docId: string,
  ): Promise<string> {
    return invoke<string>('get_knowledge_base_document', {
      kbId,
      docId,
    })
  }

  /** 模糊搜索文档内容 — 在知识库所有 chunk 中匹配关键词，返回匹配的文档 ID 列表 */
  async searchDocumentsContent(
    kbId: string,
    keyword: string,
  ): Promise<string[]> {
    return invoke<string[]>('search_documents_content', {
      kbId,
      keyword,
    })
  }

  /** 导出知识库为 ZIP 文件 */
  async exportKnowledgeBase(
    kbId: string,
    outputPath: string,
  ): Promise<void> {
    await invoke('export_knowledge_base', {
      kbId,
      outputPath,
    })
  }

  /** 初始化知识库 — 无知识库时自动创建默认知识库 */
  async initKnowledgeBases(): Promise<string> {
    return invoke<string>('init_knowledge_bases')
  }
}

/** 全局知识库存储实例 */
export const knowledgeBaseStore = new KnowledgeBaseStore()
