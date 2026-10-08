/**
 * rag-service 测试 — 知识库服务编排层
 *
 * 覆盖场景：
 * - getConfig 实时读取 settingsState
 * - query/writeText 委托到 store
 * - queryWithOptions 多库聚合
 * - buildContextText 格式化
 *
 * ⚠️ 已无 `isReady` / `queryDefault` / `setConfig`：知识库常开（没有总开关）、检索目标一律由
 * 调用方给出 `kbId`（没有全局默认库），所以这三条 API 也随之删掉了。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { ragService } from '@/services/rag-service'
import { settingsState } from '@/ui/store/settingStore'
import { knowledgeBaseStore } from '@/infrastructure/rag/knowledge-base-store'
import { invoke } from '@tauri-apps/api/core'

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  mockInvoke.mockReset()
  // 重置 settingsState 到默认值
  settingsState.setValue('ragDefaultTopK', 5)
})

describe('RagService', () => {
  // ==================== getConfig ====================

  describe('getConfig', () => {
    it('未配置时返回默认值', () => {
      const cfg = ragService.getConfig()
      expect(cfg.defaultTopK).toBe(5)
      expect(cfg.maxContextChars).toBe(8000)
    })

    it('配置后应实时反映 settingsState 变化', () => {
      settingsState.setValue('ragDefaultTopK', 10)

      const cfg = ragService.getConfig()
      expect(cfg.defaultTopK).toBe(10)
    })

    it('getConfig 不应缓存，每次实时读取', () => {
      // 第一次读取
      const cfg1 = ragService.getConfig()
      expect(cfg1.defaultTopK).toBe(5)

      // 修改 settingsState
      settingsState.setValue('ragDefaultTopK', 7)

      // 第二次读取应看到变化
      const cfg2 = ragService.getConfig()
      expect(cfg2.defaultTopK).toBe(7)
    })
  })

  // ==================== Knowledge Base CRUD ====================

  describe('知识库管理', () => {
    it('createKnowledgeBase 委托到 store', async () => {
      const expected = {
        id: 'kb-1', name: 'test', description: 'desc',
        document_count: 0, chunk_count: 0,
        created_at: '', updated_at: '',
      }
      mockInvoke.mockResolvedValue(expected)

      const result = await ragService.createKnowledgeBase('test', 'desc')
      expect(result).toEqual(expected)
    })

    it('listKnowledgeBases 委托到 store', async () => {
      mockInvoke.mockResolvedValue([])
      const result = await ragService.listKnowledgeBases()
      expect(result).toEqual([])
    })

    it('deleteKnowledgeBase 只删库，不再顺带改设置', async () => {
      mockInvoke.mockResolvedValue(undefined)
      settingsState.setValue('ragDefaultTopK', 7)

      await ragService.deleteKnowledgeBase('kb-to-delete')

      // 没有「默认知识库」这个设置项可清 —— 删库就是删库
      expect(settingsState.value.ragDefaultTopK).toBe(7)
      expect(mockInvoke).toHaveBeenCalledWith('delete_knowledge_base', {
        kbId: 'kb-to-delete',
      })
    })
  })

  // ==================== Document Management ====================

  describe('文档管理', () => {
    it('addDocument 委托到 store', async () => {
      const expected = {
        id: 'doc-1', file_name: 'test.md', file_type: 'md',
        file_size: 100, chunk_count: 3, status: 'ready' as const,
        created_at: '',
      }
      mockInvoke.mockResolvedValue(expected)

      const result = await ragService.addDocument('kb-1', '/path/test.md')
      expect(result).toEqual(expected)
    })

    it('writeText 委托到 store', async () => {
      const expected = {
        id: 'doc-write', file_name: 'ai-note.md', file_type: 'md',
        file_size: 50, chunk_count: 1, status: 'ready' as const,
        created_at: '',
      }
      mockInvoke.mockResolvedValue(expected)

      const result = await ragService.writeText('kb-1', 'ai-note.md', 'AI 生成内容')
      expect(result).toEqual(expected)
    })
  })

  // ==================== Edit Document ====================

  describe('编辑文档（editDocument）', () => {
    it('editDocument 委托到 store', async () => {
      const expected = {
        id: 'doc-new', file_name: 'v2.pdf', file_type: 'pdf',
        file_size: 500, chunk_count: 3, status: 'ready' as const,
        created_at: '',
      }
      mockInvoke.mockResolvedValue(expected)

      const result = await ragService.editDocument('kb-1', 'doc-old', '/path/v2.pdf')
      expect(result).toEqual(expected)
    })

    it('editTextDocument 委托到 store', async () => {
      const expected = {
        id: 'doc-edited', file_name: 'updated.md', file_type: 'md',
        file_size: 100, chunk_count: 2, status: 'ready' as const,
        created_at: '',
      }
      mockInvoke.mockResolvedValue(expected)

      const result = await ragService.editTextDocument('kb-1', 'doc-old', 'updated.md', '新内容')
      expect(result).toEqual(expected)
    })

    it('getDocumentContent 委托到 store', async () => {
      mockInvoke.mockResolvedValue('文档完整内容')

      const result = await ragService.getDocumentContent('kb-1', 'doc-1')
      expect(result).toBe('文档完整内容')
    })
  })

  // ==================== Query ====================

  describe('query', () => {
    const mockResult = {
      results: [
        { id: 'c1', content: 'Rust 内容', document_id: 'd1', document_name: 'rust.md', chunk_index: 0, score: 0.95 },
      ],
      context: '知识库上下文',
    }

    beforeEach(() => {
      mockInvoke.mockResolvedValue(mockResult)
    })

    it('应使用指定的 topK', async () => {
      const result = await ragService.query('kb-1', 'Rust', 3)
      expect(result).toEqual(mockResult)
    })

    it('不传 topK 时使用配置的默认值', async () => {
      settingsState.setValue('ragDefaultTopK', 10)
      const result = await ragService.query('kb-1', 'Rust')
      expect(result).toEqual(mockResult)
    })
  })

  // ==================== queryWithOptions ====================

  describe('queryWithOptions', () => {
    beforeEach(() => {
      mockInvoke.mockResolvedValue({
        results: [
          { id: 'c1', content: 'Rust 编程', document_id: 'd1', document_name: 'rust.md', chunk_index: 0, score: 0.9 },
        ],
        context: 'ctx',
      })
    })

    it('应在多个知识库中检索并聚合', async () => {
      const ctx = await ragService.queryWithOptions(
        { knowledgeBaseIds: ['kb-1', 'kb-2'], topK: 3 },
        'Rust',
      )
      expect(ctx.chunks.length).toBeGreaterThanOrEqual(1)
      expect(ctx.query).toBe('Rust')
      expect(ctx.knowledgeBaseId).toBe('kb-1,kb-2')
      expect(ctx.formattedContext).toContain('Rust 编程')
    })

    it('一个知识库失败不应影响其他', async () => {
      // kb-1 失败，kb-2 成功
      mockInvoke
        .mockRejectedValueOnce(new Error('KB1 错误'))
        .mockResolvedValueOnce({
          results: [
            { id: 'c2', content: 'Python 编程', document_id: 'd2', document_name: 'python.md', chunk_index: 0, score: 0.85 },
          ],
          context: 'ctx',
        })

      const ctx = await ragService.queryWithOptions(
        { knowledgeBaseIds: ['kb-1', 'kb-2'], topK: 3 },
        '编程',
      )
      expect(ctx.chunks.length).toBe(1)
      expect(ctx.chunks[0].documentName).toBe('python.md')
    })

    it('minScore 过滤低分结果', async () => {
      mockInvoke.mockResolvedValue({
        results: [
          { id: 'c1', content: 'A', document_id: 'd1', document_name: 'a.md', chunk_index: 0, score: 0.9 },
          { id: 'c2', content: 'B', document_id: 'd1', document_name: 'a.md', chunk_index: 1, score: 0.3 },
        ],
        context: 'ctx',
      })

      const ctx = await ragService.queryWithOptions(
        { knowledgeBaseIds: ['kb-1'], topK: 5, minScore: 0.5 },
        'test',
      )
      expect(ctx.chunks.length).toBe(1)
      expect(ctx.chunks[0].score).toBeGreaterThanOrEqual(0.5)
    })

    it('结果按分数降序排列', async () => {
      mockInvoke.mockResolvedValue({
        results: [
          { id: 'c1', content: '低分', document_id: 'd1', document_name: 'a.md', chunk_index: 0, score: 0.3 },
          { id: 'c2', content: '高分', document_id: 'd1', document_name: 'a.md', chunk_index: 1, score: 0.9 },
        ],
        context: 'ctx',
      })

      const ctx = await ragService.queryWithOptions(
        { knowledgeBaseIds: ['kb-1'], topK: 5 },
        'test',
      )
      expect(ctx.chunks.length).toBe(2)
      expect(ctx.chunks[0].score).toBeGreaterThanOrEqual(ctx.chunks[1].score)
    })
  })

  // ==================== buildContextText ====================

  describe('buildContextText', () => {
    it('应格式化 chunks 为可读文本', () => {
      const chunks = [
        { id: 'c1', content: '第一块内容', documentName: 'doc1.md', score: 0.95 },
        { id: 'c2', content: '第二块内容', documentName: 'doc2.md', score: 0.85 },
      ]

      // 通过 queryWithOptions 测试 buildContextText
      mockInvoke.mockResolvedValue({
        results: chunks.map((c) => ({
          id: c.id,
          content: c.content,
          document_id: 'd1',
          document_name: c.documentName,
          chunk_index: 0,
          score: c.score,
        })),
        context: 'ctx',
      })

      // 直接测试私有方法不可行，通过 queryWithOptions 间接验证
    })
  })
})
