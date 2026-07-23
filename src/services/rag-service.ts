/**
 * RAG 服务 — 编排知识库检索流程
 *
 * 负责：
 * - 知识库的 CRUD 操作
 * - 文档管理（上传、删除）
 * - 检索并将结果格式化注入到 Agent 上下文
 *
 * ⚠️ 配置读取策略：
 * RAG 配置（enabled / defaultKnowledgeBaseId / defaultTopK）直接从
 * settingsState (localStorage) 实时读取，不维护本地缓存副本。
 * 这样保证无论页面刷新还是设置页面修改，getConfig() 始终返回最新值。
 */

import { knowledgeBaseStore } from '@/infrastructure/rag/knowledge-base-store'
import { settingsState } from '@/ui/store/settingStore'
import type {
  KnowledgeBase,
  KnowledgeBaseDocument,
  KnowledgeBaseQueryResult,
} from '@/domain/ports'
import type { RAGConfig, RAGContext, RAGQueryOptions } from '@/domain/rag/types'
import { defaultRAGConfig } from '@/domain/rag/types'

class RagService {
  /** 最大上下文字符数（固定，不从配置读取） */
  private maxContextChars = 8000

  // ===== 配置管理 =====

  /**
   * 获取当前 RAG 配置
   *
   * 实时从 settingsState 读取，不缓存。
   * 保证引擎和工具永远读到最新值。
   */
  getConfig(): RAGConfig {
    try {
      const s = settingsState.value
      return {
        enabled: s.ragEnabled ?? false,
        defaultKnowledgeBaseId: s.ragDefaultKnowledgeBaseId ?? '',
        defaultTopK: s.ragDefaultTopK ?? 5,
        maxContextChars: this.maxContextChars,
      }
    } catch {
      return { ...defaultRAGConfig, maxContextChars: this.maxContextChars }
    }
  }

  /**
   * 更新 RAG 配置（同时写入 settingsState 持久化）
   *
   * UI 设置页面调用此方法，修改会持久化到 localStorage。
   */
  setConfig(config: Partial<RAGConfig>): void {
    try {
      if (config.enabled !== undefined) {
        settingsState.setValue('ragEnabled', config.enabled)
      }
      if (config.defaultKnowledgeBaseId !== undefined) {
        settingsState.setValue('ragDefaultKnowledgeBaseId', config.defaultKnowledgeBaseId)
      }
      if (config.defaultTopK !== undefined) {
        settingsState.setValue('ragDefaultTopK', config.defaultTopK)
      }
    } catch {
      // settingsState 尚未初始化，忽略
    }
  }

  /** 检查 RAG 是否已启用且有默认知识库 */
  isReady(): boolean {
    const cfg = this.getConfig()
    return cfg.enabled && cfg.defaultKnowledgeBaseId.length > 0
  }

  // ===== 知识库管理 =====

  /** 创建知识库 */
  async createKnowledgeBase(
    name: string,
    description?: string,
  ): Promise<KnowledgeBase> {
    return knowledgeBaseStore.create(name, description)
  }

  /** 列出所有知识库 */
  async listKnowledgeBases(): Promise<KnowledgeBase[]> {
    return knowledgeBaseStore.list()
  }

  /** 删除知识库 */
  async deleteKnowledgeBase(kbId: string): Promise<void> {
    await knowledgeBaseStore.delete(kbId)
    // 如果删除的是默认知识库，清除默认配置
    const cfg = this.getConfig()
    if (cfg.defaultKnowledgeBaseId === kbId) {
      this.setConfig({ defaultKnowledgeBaseId: '' })
    }
  }

  // ===== 文档管理 =====

  /** 添加文档到知识库 */
  async addDocument(
    kbId: string,
    filePath: string,
  ): Promise<KnowledgeBaseDocument> {
    return knowledgeBaseStore.addDocument(kbId, filePath)
  }

  /** 从知识库删除文档 */
  async removeDocument(kbId: string, docId: string): Promise<void> {
    await knowledgeBaseStore.removeDocument(kbId, docId)
  }

  /** 列出知识库中的文档 */
  async listDocuments(kbId: string): Promise<KnowledgeBaseDocument[]> {
    return knowledgeBaseStore.listDocuments(kbId)
  }

  /** 将文本内容直接写入知识库（供 AI Tool 使用） */
  async writeText(
    kbId: string,
    docName: string,
    content: string,
  ): Promise<KnowledgeBaseDocument> {
    return knowledgeBaseStore.writeText(kbId, docName, content)
  }

  /** 编辑知识库中的文档 — 用新文件替换 */
  async editDocument(
    kbId: string,
    docId: string,
    filePath: string,
  ): Promise<KnowledgeBaseDocument> {
    return knowledgeBaseStore.editDocument(kbId, docId, filePath)
  }

  /** 编辑知识库中的文本文档 — 用新内容替换（AI Tool 使用） */
  async editTextDocument(
    kbId: string,
    docId: string,
    docName: string,
    content: string,
  ): Promise<KnowledgeBaseDocument> {
    return knowledgeBaseStore.editTextDocument(kbId, docId, docName, content)
  }

  /** 获取知识库中某个文档的完整内容 */
  async getDocumentContent(
    kbId: string,
    docId: string,
  ): Promise<string> {
    return knowledgeBaseStore.getDocumentContent(kbId, docId)
  }

  /** 模糊搜索文档内容 — 在知识库所有 chunk 中匹配关键词，返回匹配的文档 ID 列表 */
  async searchDocumentsContent(
    kbId: string,
    keyword: string,
  ): Promise<string[]> {
    return knowledgeBaseStore.searchDocumentsContent(kbId, keyword)
  }

  /** 导出知识库为 ZIP 文件 */
  async exportKnowledgeBase(
    kbId: string,
    outputPath: string,
  ): Promise<void> {
    await knowledgeBaseStore.exportKnowledgeBase(kbId, outputPath)
  }

  /** 初始化知识库 — 无知识库时自动创建默认知识库 */
  async initKnowledgeBases(): Promise<string> {
    return knowledgeBaseStore.initKnowledgeBases()
  }

  // ===== 检索 =====

  /** 检索知识库 */
  async query(
    kbId: string,
    query: string,
    topK?: number,
  ): Promise<KnowledgeBaseQueryResult> {
    const cfg = this.getConfig()
    const result = await knowledgeBaseStore.query(
      kbId,
      query,
      topK ?? cfg.defaultTopK,
    )
    return result
  }

  /** 使用默认知识库进行检索（基于当前配置） */
  async queryDefault(query: string): Promise<KnowledgeBaseQueryResult | null> {
    const cfg = this.getConfig()
    if (!cfg.defaultKnowledgeBaseId) {
      return null
    }
    return this.query(cfg.defaultKnowledgeBaseId, query)
  }

  /** 使用完整 RAG 选项检索 */
  async queryWithOptions(
    options: RAGQueryOptions,
    query: string,
  ): Promise<RAGContext> {
    const allChunks: Array<{
      id: string
      content: string
      documentName: string
      score: number
    }> = []

    for (const kbId of options.knowledgeBaseIds) {
      try {
        const result = await this.query(kbId, query, options.topK)
        for (const chunk of result.results) {
          if (!options.minScore || chunk.score >= options.minScore) {
            allChunks.push({
              id: chunk.id,
              content: chunk.content,
              documentName: chunk.document_name,
              score: chunk.score,
            })
          }
        }
      } catch (err) {
        console.warn(`[RAG] 检索知识库 ${kbId} 失败:`, err)
      }
    }

    // 按分数降序排列
    allChunks.sort((a, b) => b.score - a.score)

    // 去重
    const seen = new Set<string>()
    const uniqueChunks = allChunks.filter((c) => {
      const key = `${c.documentName}:${c.id}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

    // 构建格式化上下文
    const formattedContext = this.buildContextText(uniqueChunks)

    return {
      chunks: uniqueChunks,
      query,
      knowledgeBaseId: options.knowledgeBaseIds.join(','),
      formattedContext,
    }
  }

  /** 构建注入到 LLM 的上下文文本
   *
   * ⚠️ 此逻辑与 Rust 端 `rag_service.rs` 中的 `format_context()` 方法重复。
   * Rust 端版本用于 UI 搜索测试（`query_knowledge_base` 命令），
   * 前端版本用于引擎多知识库组合检索（`queryWithOptions`）。
   * 修改时请同步更新两处。 */
  private buildContextText(
    chunks: Array<{
      id: string
      content: string
      documentName: string
      score: number
    }>,
  ): string {
    let context = '以下是从知识库中检索到的相关文档片段：\n\n---\n'
    let totalChars = 0
    const maxChars = this.maxContextChars

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]
      const header = `[片段 ${i + 1}] 来自：${chunk.documentName}（相似度：${chunk.score.toFixed(2)}）\n`
      const entry = `${header}${chunk.content}\n\n---\n`

      if (totalChars + entry.length > maxChars) {
        context += `\n...（已截断，共 ${chunks.length} 个片段中的前 ${i} 个）\n`
        break
      }

      context += entry
      totalChars += entry.length
    }

    return context
  }
}

/** 全局 RAG 服务实例 */
export const ragService = new RagService()
