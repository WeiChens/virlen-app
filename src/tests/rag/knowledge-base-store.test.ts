/**
 * knowledge-base-store 测试 — Tauri invoke 委托层
 *
 * 覆盖场景：
 * - 所有 CRUD 方法的 invoke 参数验证
 * - writeText 方法
 * - invoke 失败的错误传播
 * - 返回数据的类型完整性
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { knowledgeBaseStore } from '@/infrastructure/rag/knowledge-base-store'
import { invoke } from '@tauri-apps/api/core'

/** Mock invoke */
const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  mockInvoke.mockReset()
})

describe('KnowledgeBaseStore', () => {
  // ==================== create ====================

  describe('create', () => {
    it('应使用正确的参数调用 invoke', async () => {
      const expected = {
        id: 'kb-1',
        name: '测试知识库',
        description: '测试描述',
        document_count: 0,
        chunk_count: 0,
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-01T00:00:00Z',
      }
      mockInvoke.mockResolvedValue(expected)

      const result = await knowledgeBaseStore.create('测试知识库', '测试描述')
      expect(result).toEqual(expected)
      expect(mockInvoke).toHaveBeenCalledWith('create_knowledge_base', {
        name: '测试知识库',
        description: '测试描述',
      })
    })

    it('不带描述时应传递空字符串', async () => {
      mockInvoke.mockResolvedValue({
        id: 'kb-2',
        name: '无描述',
        description: '',
        document_count: 0,
        chunk_count: 0,
        created_at: '',
        updated_at: '',
      })

      const result = await knowledgeBaseStore.create('无描述')
      expect(result.description).toBe('')
      expect(mockInvoke).toHaveBeenCalledWith('create_knowledge_base', {
        name: '无描述',
        description: '',
      })
    })

    it('invoke 失败时应传播错误', async () => {
      mockInvoke.mockRejectedValue(new Error('创建失败'))
      await expect(knowledgeBaseStore.create('test')).rejects.toThrow('创建失败')
    })
  })

  // ==================== list ====================

  describe('list', () => {
    it('应调用 list_knowledge_bases', async () => {
      const kbs = [
        { id: 'kb-1', name: 'KB1', description: '', document_count: 0, chunk_count: 0, created_at: '', updated_at: '' },
      ]
      mockInvoke.mockResolvedValue(kbs)

      const result = await knowledgeBaseStore.list()
      expect(result).toEqual(kbs)
      expect(mockInvoke).toHaveBeenCalledWith('list_knowledge_bases')
    })

    it('无知识库时返回空数组', async () => {
      mockInvoke.mockResolvedValue([])
      const result = await knowledgeBaseStore.list()
      expect(result).toEqual([])
    })
  })

  // ==================== delete ====================

  describe('delete', () => {
    it('应调用 delete_knowledge_base', async () => {
      mockInvoke.mockResolvedValue(undefined)
      await knowledgeBaseStore.delete('kb-1')
      expect(mockInvoke).toHaveBeenCalledWith('delete_knowledge_base', { kbId: 'kb-1' })
    })
  })

  // ==================== addDocument ====================

  describe('addDocument', () => {
    it('应调用 add_document_to_kb 并传递 kbId 和 filePath', async () => {
      const expected = {
        id: 'doc-1',
        file_name: 'test.pdf',
        file_type: 'pdf',
        file_size: 1024,
        chunk_count: 5,
        status: 'ready' as const,
        created_at: '2025-01-01T00:00:00Z',
      }
      mockInvoke.mockResolvedValue(expected)

      const result = await knowledgeBaseStore.addDocument('kb-1', '/path/to/test.pdf')
      expect(result).toEqual(expected)
      expect(mockInvoke).toHaveBeenCalledWith('add_document_to_knowledge_base', {
        kbId: 'kb-1',
        filePath: '/path/to/test.pdf',
      })
    })
  })

  // ==================== removeDocument ====================

  describe('removeDocument', () => {
    it('应调用 remove_document_from_kb', async () => {
      mockInvoke.mockResolvedValue(undefined)
      await knowledgeBaseStore.removeDocument('kb-1', 'doc-1')
      expect(mockInvoke).toHaveBeenCalledWith('remove_document_from_knowledge_base', {
        kbId: 'kb-1',
        docId: 'doc-1',
      })
    })
  })

  // ==================== listDocuments ====================

  describe('listDocuments', () => {
    it('应调用 list_kb_documents', async () => {
      const docs = [
        { id: 'doc-1', file_name: 'a.md', file_type: 'md', file_size: 100, chunk_count: 2, status: 'ready' as const, created_at: '' },
      ]
      mockInvoke.mockResolvedValue(docs)

      const result = await knowledgeBaseStore.listDocuments('kb-1')
      expect(result).toEqual(docs)
      expect(mockInvoke).toHaveBeenCalledWith('list_knowledge_base_documents', { kbId: 'kb-1' })
    })
  })

  // ==================== query ====================

  describe('query', () => {
    const mockQueryResult = {
      results: [
        { id: 'chunk-1', content: 'Rust 是系统编程语言', document_id: 'doc-1', document_name: 'rust.md', chunk_index: 0, score: 0.95 },
      ],
      context: '知识库上下文',
    }

    it('应调用 query_knowledge_base 并传递所有参数', async () => {
      mockInvoke.mockResolvedValue(mockQueryResult)

      const result = await knowledgeBaseStore.query('kb-1', 'Rust', 3)
      expect(result).toEqual(mockQueryResult)
      expect(mockInvoke).toHaveBeenCalledWith('query_knowledge_base', {
        kbId: 'kb-1',
        query: 'Rust',
        topK: 3,
      })
    })

    it('不传 topK 时应默认 5', async () => {
      mockInvoke.mockResolvedValue(mockQueryResult)

      await knowledgeBaseStore.query('kb-1', 'Rust')
      expect(mockInvoke).toHaveBeenCalledWith('query_knowledge_base', {
        kbId: 'kb-1',
        query: 'Rust',
        topK: 5,
      })
    })

    it('返回结果应包含 results 和 context', async () => {
      mockInvoke.mockResolvedValue(mockQueryResult)

      const result = await knowledgeBaseStore.query('kb-1', 'Rust', 5)
      expect(result).toHaveProperty('results')
      expect(result).toHaveProperty('context')
      expect(Array.isArray(result.results)).toBe(true)
      expect(typeof result.context).toBe('string')
    })
  })

  // ==================== writeText ====================

  describe('writeText', () => {
    it('应调用 write_text_to_kb 并传递所有参数', async () => {
      const expected = {
        id: 'doc-write-1',
        file_name: '笔记.md',
        file_type: 'md',
        file_size: 200,
        chunk_count: 1,
        status: 'ready' as const,
        created_at: '2025-01-01T00:00:00Z',
      }
      mockInvoke.mockResolvedValue(expected)

      const result = await knowledgeBaseStore.writeText('kb-1', '笔记.md', '这是 AI 生成的内容')
      expect(result).toEqual(expected)
      expect(mockInvoke).toHaveBeenCalledWith('write_text_to_knowledge_base', {
        kbId: 'kb-1',
        docName: '笔记.md',
        content: '这是 AI 生成的内容',
      })
    })

    it('invoke 失败时应传播错误', async () => {
      mockInvoke.mockRejectedValue(new Error('写入失败'))
      await expect(
        knowledgeBaseStore.writeText('kb-1', 'doc.md', 'content'),
      ).rejects.toThrow('写入失败')
    })
  })

  // ==================== editDocument ====================

  describe('editDocument', () => {
    it('应调用 edit_document_in_kb 并传递所有参数', async () => {
      const expected = {
        id: 'doc-new',
        file_name: 'updated.pdf',
        file_type: 'pdf',
        file_size: 2048,
        chunk_count: 4,
        status: 'ready' as const,
        created_at: '2025-01-01T00:00:00Z',
      }
      mockInvoke.mockResolvedValue(expected)

      const result = await knowledgeBaseStore.editDocument('kb-1', 'doc-old', '/path/new.pdf')
      expect(result).toEqual(expected)
      expect(mockInvoke).toHaveBeenCalledWith('edit_document_in_knowledge_base', {
        kbId: 'kb-1',
        docId: 'doc-old',
        filePath: '/path/new.pdf',
      })
    })
  })

  // ==================== editTextDocument ====================

  describe('editTextDocument', () => {
    it('应调用 edit_text_in_kb 并传递所有参数', async () => {
      const expected = {
        id: 'doc-edited',
        file_name: 'updated.md',
        file_type: 'md',
        file_size: 150,
        chunk_count: 2,
        status: 'ready' as const,
        created_at: '2025-01-01T00:00:00Z',
      }
      mockInvoke.mockResolvedValue(expected)

      const result = await knowledgeBaseStore.editTextDocument(
        'kb-1', 'doc-old', 'updated.md', '新内容',
      )
      expect(result).toEqual(expected)
      expect(mockInvoke).toHaveBeenCalledWith('edit_text_in_knowledge_base', {
        kbId: 'kb-1',
        docId: 'doc-old',
        docName: 'updated.md',
        content: '新内容',
      })
    })
  })

  // ==================== getDocumentContent ====================

  describe('getDocumentContent', () => {
    it('应调用 get_knowledge_base_document 并返回文本内容', async () => {
      const expected = '文档完整内容'
      mockInvoke.mockResolvedValue(expected)

      const result = await knowledgeBaseStore.getDocumentContent('kb-1', 'doc-1')
      expect(result).toBe(expected)
      expect(mockInvoke).toHaveBeenCalledWith('get_knowledge_base_document', {
        kbId: 'kb-1',
        docId: 'doc-1',
      })
    })
  })
})
