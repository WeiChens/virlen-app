/**
 * knowledge-base 工具测试 — AI Tool 定义与执行
 *
 * 覆盖场景：
 * - 5 个工具的正确注册（名称、参数、必填项）
 * - search_knowledge_base 执行逻辑
 * - list_knowledge_bases 执行逻辑
 * - list_knowledge_base_documents 执行逻辑
 * - write_to_knowledge_base 执行逻辑
 * - delete_knowledge_base_document 执行逻辑
 * - 参数验证（缺失必填参数）
 * - 空结果处理
 * - 错误处理
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { toolRegistry } from '@/domain/tools'
import type { ToolExecutor, ToolResult } from '@/domain/tools/types'

// Mock ragService
const mockQuery = vi.fn()
const mockListKnowledgeBases = vi.fn()
const mockWriteText = vi.fn()
const mockRemoveDocument = vi.fn()
const mockListDocuments = vi.fn()
const mockGetDocumentContent = vi.fn()

vi.mock('@/services/rag-service', () => ({
  ragService: {
    query: (...args: any[]) => mockQuery(...args),
    listKnowledgeBases: (...args: any[]) => mockListKnowledgeBases(...args),
    writeText: (...args: any[]) => mockWriteText(...args),
    removeDocument: (...args: any[]) => mockRemoveDocument(...args),
    listDocuments: (...args: any[]) => mockListDocuments(...args),
    getDocumentContent: (...args: any[]) => mockGetDocumentContent(...args),
  },
}))

// Mock i18n
vi.mock('@/ui/i18n', () => ({
  t: (key: string) => key,
  tpl: (template: string, data: Record<string, any>) => {
    let result = template
    for (const [key, value] of Object.entries(data)) {
      result = result.replace(`$__${key}__`, String(value))
    }
    return result
  },
}))

// 导入知识库工具模块（副作用：注册 3 个工具到 registry）
// 需要在 mock 之后 import
import '@/infrastructure/tools/builtin/knowledge-base'

/** 获取已注册的 Tool 执行器 */
async function getExecutor(name: string): Promise<ToolExecutor> {
  const registered = await toolRegistry.get(name)
  if (!registered) throw new Error(`Tool "${name}" 未注册`)
  return registered.executor
}

/** 创建一个模拟的 ToolContext */
function mockCtx(): any {
  return {
    sessionId: 'test-session',
    toolCallId: 'test-call',
    abortSignal: new AbortController().signal,
    write: vi.fn(),
  }
}

/** 提取 ToolResult 内容 */
function extractContent(result: any): string {
  if (typeof result === 'string') return result
  if ((result as ToolResult).content) return (result as ToolResult).content
  return String(result)
}

describe('知识库工具注册', () => {
  beforeEach(async () => {
    // 清理 mock 调用记录
    mockQuery.mockReset()
    mockListKnowledgeBases.mockReset()
    mockWriteText.mockReset()
  })

  it('应注册 search_knowledge_base 工具', async () => {
    const tool = await toolRegistry.get('search_knowledge_base')
    expect(tool).toBeDefined()
    expect(tool!.definition.name).toBe('search_knowledge_base')
    expect(tool!.definition.parameters.required).toContain('query')
    expect(tool!.definition.parameters.required).toContain('knowledge_base_id')
    expect(tool!.definition.parameters.properties).toHaveProperty('query')
    expect(tool!.definition.parameters.properties).toHaveProperty('knowledge_base_id')
    expect(tool!.definition.parameters.properties).toHaveProperty('top_k')
  })

  it('应注册 list_knowledge_bases 工具', async () => {
    const tool = await toolRegistry.get('list_knowledge_bases')
    expect(tool).toBeDefined()
    expect(tool!.definition.name).toBe('list_knowledge_bases')
    expect(tool!.definition.parameters.required).toEqual([])
  })

  it('应注册 write_to_knowledge_base 工具', async () => {
    const tool = await toolRegistry.get('write_to_knowledge_base')
    expect(tool).toBeDefined()
    expect(tool!.definition.name).toBe('write_to_knowledge_base')
    expect(tool!.definition.parameters.required).toContain('knowledge_base_id')
    expect(tool!.definition.parameters.required).toContain('document_name')
    expect(tool!.definition.parameters.required).toContain('content')
  })

  it('应注册 delete_knowledge_base_document 工具', async () => {
    const tool = await toolRegistry.get('delete_knowledge_base_document')
    expect(tool).toBeDefined()
    expect(tool!.definition.name).toBe('delete_knowledge_base_document')
    expect(tool!.definition.parameters.required).toContain('knowledge_base_id')
    expect(tool!.definition.parameters.required).toContain('document_id')
  })

  it('应注册 list_knowledge_base_documents 工具', async () => {
    const tool = await toolRegistry.get('list_knowledge_base_documents')
    expect(tool).toBeDefined()
    expect(tool!.definition.name).toBe('list_knowledge_base_documents')
    expect(tool!.definition.parameters.required).toContain('knowledge_base_id')
  })

  it('应注册 get_knowledge_base_document 工具', async () => {
    const tool = await toolRegistry.get('get_knowledge_base_document')
    expect(tool).toBeDefined()
    expect(tool!.definition.name).toBe('get_knowledge_base_document')
    expect(tool!.definition.parameters.required).toContain('knowledge_base_id')
    expect(tool!.definition.parameters.required).toContain('document_id')
  })
})

describe('search_knowledge_base 工具执行', () => {
  let executor: ToolExecutor

  beforeEach(async () => {
    mockQuery.mockReset()
    mockListKnowledgeBases.mockReset()
    mockWriteText.mockReset()
    mockRemoveDocument.mockReset()
    mockListDocuments.mockReset()
    mockGetDocumentContent.mockReset()
    executor = await getExecutor('search_knowledge_base')
  })

  it('query 为空时应返回错误', async () => {
    const result = await executor({ query: '', knowledge_base_id: 'kb-1' }, mockCtx())
    const content = extractContent(result)
    expect(content).toContain('Missing required parameter')
  })

  it('缺少 knowledge_base_id 时应返回错误', async () => {
    const result = await executor({ query: 'test' }, mockCtx())
    const content = extractContent(result)
    expect(content).toContain('Missing required parameter')
  })

  it('查询无结果时应返回友好提示', async () => {
    mockQuery.mockResolvedValue({ results: [], context: '' })

    const result = await executor(
      { query: 'nonexistent', knowledge_base_id: 'kb-1' },
      mockCtx(),
    )
    const content = extractContent(result)
    expect(content).toContain('No relevant information found')
  })

  it('正常查询应返回包含 document_id 的上下文', async () => {
    mockQuery.mockResolvedValue({
      results: [
        {
          id: 'chunk-1',
          content: 'Rust 是一种系统编程语言',
          document_id: 'doc-1',
          document_name: 'rust.md',
          chunk_index: 0,
          score: 0.95,
        },
      ],
      context: '知识库上下文内容',
    })

    const result = await executor(
      { query: 'Rust 编程', knowledge_base_id: 'kb-1', top_k: 3 },
      mockCtx(),
    )
    const content = extractContent(result)
    // 应包含 document_id 以便 AI 识别
    expect(content).toContain('Document ID: doc-1')
    expect(content).toContain('Document: rust.md')
    expect(content).toContain('Rust 是一种系统编程语言')
    expect(content).toContain('kb-1')
  })

  it('top_k 不应超过 20', async () => {
    mockQuery.mockResolvedValue({ results: [], context: '' })

    await executor(
      { query: 'test', knowledge_base_id: 'kb-1', top_k: 100 },
      mockCtx(),
    )
    // topK 应该被限制为 20
    expect(mockQuery).toHaveBeenCalledWith('kb-1', 'test', 20)
  })

  it('默认 top_k 为 5', async () => {
    mockQuery.mockResolvedValue({ results: [], context: '' })

    await executor(
      { query: 'test', knowledge_base_id: 'kb-1' },
      mockCtx(),
    )
    expect(mockQuery).toHaveBeenCalledWith('kb-1', 'test', 5)
  })

  it('搜索失败时应返回错误信息', async () => {
    mockQuery.mockRejectedValue(new Error('知识库不存在'))

    const result = await executor(
      { query: 'test', knowledge_base_id: 'nonexistent' },
      mockCtx(),
    )
    const content = extractContent(result)
    expect(content).toContain('Error searching knowledge base')
    expect(content).toContain('知识库不存在')
  })
})

describe('list_knowledge_bases 工具执行', () => {
  let executor: ToolExecutor

  beforeEach(async () => {
    mockQuery.mockReset()
    mockListKnowledgeBases.mockReset()
    mockWriteText.mockReset()
    mockRemoveDocument.mockReset()
    mockListDocuments.mockReset()
    mockGetDocumentContent.mockReset()
    executor = await getExecutor('list_knowledge_bases')
  })

  it('无知识库时应提示创建', async () => {
    mockListKnowledgeBases.mockResolvedValue([])

    const result = await executor({}, mockCtx())
    const content = extractContent(result)
    expect(content).toContain('No knowledge bases found')
  })

  it('有知识库时应列出详细信息，并包含文档标题', async () => {
    mockListKnowledgeBases.mockResolvedValue([
      {
        id: 'kb-1',
        name: 'Rust 知识库',
        description: 'Rust 相关文档',
        document_count: 3,
        chunk_count: 15,
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-01T00:00:00Z',
      },
      {
        id: 'kb-2',
        name: 'Python 知识库',
        description: '',
        document_count: 1,
        chunk_count: 5,
        created_at: '2025-01-02T00:00:00Z',
        updated_at: '2025-01-02T00:00:00Z',
      },
    ])
    // 模拟每个知识库的文档列表
    mockListDocuments
      .mockResolvedValueOnce([
        { id: 'd1', file_name: 'rust-intro.md', file_type: 'md', file_size: 100, chunk_count: 3, status: 'ready', created_at: '' },
        { id: 'd2', file_name: 'ownership.md', file_type: 'md', file_size: 200, chunk_count: 5, status: 'ready', created_at: '' },
        { id: 'd3', file_name: 'traits.md', file_type: 'md', file_size: 150, chunk_count: 4, status: 'ready', created_at: '' },
      ])
      .mockResolvedValueOnce([
        { id: 'd4', file_name: 'python-basics.md', file_type: 'md', file_size: 80, chunk_count: 2, status: 'ready', created_at: '' },
      ])

    const result = await executor({}, mockCtx())
    const content = extractContent(result)
    expect(content).toContain('Rust 知识库')
    expect(content).toContain('Python 知识库')
    expect(content).toContain('kb-1')
    expect(content).toContain('kb-2')
    expect(content).toContain('3')
    expect(content).toContain('15')
    // 应包含文档标题和 ID
    expect(content).toContain('rust-intro.md')
    expect(content).toContain('ownership.md')
    expect(content).toContain('traits.md')
    expect(content).toContain('python-basics.md')
    expect(content).toContain('ID: d1')
    expect(content).toContain('ID: d4')
    // 空描述应显示 "No description"
    expect(content).toContain('No description')
  })

  it('失败时应返回错误信息', async () => {
    mockListKnowledgeBases.mockRejectedValue(new Error('数据库连接失败'))

    const result = await executor({}, mockCtx())
    const content = extractContent(result)
    expect(content).toContain('Error listing knowledge bases')
    expect(content).toContain('数据库连接失败')
  })
})

describe('write_to_knowledge_base 工具执行', () => {
  let executor: ToolExecutor

  beforeEach(async () => {
    mockQuery.mockReset()
    mockListKnowledgeBases.mockReset()
    mockWriteText.mockReset()
    mockRemoveDocument.mockReset()
    mockListDocuments.mockReset()
    mockGetDocumentContent.mockReset()
    executor = await getExecutor('write_to_knowledge_base')
  })

  it('缺少 knowledge_base_id 时应返回错误', async () => {
    const result = await executor(
      { document_name: 'doc', content: 'content' },
      mockCtx(),
    )
    const content = extractContent(result)
    expect(content).toContain('Missing required parameter')
    expect(content).toContain('knowledge_base_id')
  })

  it('缺少 document_name 时应返回错误', async () => {
    const result = await executor(
      { knowledge_base_id: 'kb-1', content: 'content' },
      mockCtx(),
    )
    const content = extractContent(result)
    expect(content).toContain('Missing required parameter')
    expect(content).toContain('document_name')
  })

  it('缺少 content 时应返回错误', async () => {
    const result = await executor(
      { knowledge_base_id: 'kb-1', document_name: 'doc' },
      mockCtx(),
    )
    const content = extractContent(result)
    expect(content).toContain('Missing required parameter')
    expect(content).toContain('content')
  })

  it('写入成功应返回确认信息', async () => {
    mockWriteText.mockResolvedValue({
      id: 'doc-new',
      file_name: '笔记.md',
      file_type: 'md',
      file_size: 200,
      chunk_count: 3,
      status: 'ready',
      created_at: '2025-01-01T00:00:00Z',
    })

    const result = await executor(
      {
        knowledge_base_id: 'kb-1',
        document_name: '笔记.md',
        content: '这是 AI 生成的笔记内容。',
      },
      mockCtx(),
    )
    const content = extractContent(result)
    expect(content).toContain('Successfully saved')
    expect(content).toContain('笔记.md')
    expect(content).toContain('3')
  })

  it('写入失败时应返回错误信息', async () => {
    mockWriteText.mockRejectedValue(new Error('知识库不存在'))

    const result = await executor(
      {
        knowledge_base_id: 'nonexistent',
        document_name: 'doc.md',
        content: 'content',
      },
      mockCtx(),
    )
    const content = extractContent(result)
    expect(content).toContain('Error writing to knowledge base')
    expect(content).toContain('知识库不存在')
  })

  it('空 content 应被拒绝', async () => {
    const result = await executor(
      {
        knowledge_base_id: 'kb-1',
        document_name: 'doc.md',
        content: '',
      },
      mockCtx(),
    )
    const content = extractContent(result)
    expect(content).toContain('Missing required parameter')
    expect(content).toContain('content')
  })
})

describe('delete_knowledge_base_document 工具执行', () => {
  let executor: ToolExecutor

  beforeEach(async () => {
    mockQuery.mockReset()
    mockListKnowledgeBases.mockReset()
    mockWriteText.mockReset()
    mockRemoveDocument.mockReset()
    mockListDocuments.mockReset()
    mockGetDocumentContent.mockReset()
    executor = await getExecutor('delete_knowledge_base_document')
  })

  it('缺少 knowledge_base_id 时应返回错误', async () => {
    const result = await executor({ document_id: 'doc-1' }, mockCtx())
    const content = extractContent(result)
    expect(content).toContain('Missing required parameter')
    expect(content).toContain('knowledge_base_id')
  })

  it('缺少 document_id 时应返回错误', async () => {
    const result = await executor({ knowledge_base_id: 'kb-1' }, mockCtx())
    const content = extractContent(result)
    expect(content).toContain('Missing required parameter')
    expect(content).toContain('document_id')
  })

  it('删除成功应返回确认信息', async () => {
    mockRemoveDocument.mockResolvedValue(undefined)

    const result = await executor(
      { knowledge_base_id: 'kb-1', document_id: 'doc-1' },
      mockCtx(),
    )
    const content = extractContent(result)
    expect(content).toContain('Successfully deleted')
    expect(content).toContain('doc-1')
    expect(content).toContain('kb-1')
  })

  it('删除失败时应返回错误信息', async () => {
    mockRemoveDocument.mockRejectedValue(new Error('文档不存在'))

    const result = await executor(
      { knowledge_base_id: 'kb-1', document_id: 'nonexistent' },
      mockCtx(),
    )
    const content = extractContent(result)
    expect(content).toContain('Error deleting document')
    expect(content).toContain('文档不存在')
  })
})

describe('list_knowledge_base_documents 工具执行', () => {
  let executor: ToolExecutor

  beforeEach(async () => {
    mockQuery.mockReset()
    mockListKnowledgeBases.mockReset()
    mockWriteText.mockReset()
    mockRemoveDocument.mockReset()
    mockListDocuments.mockReset()
    mockGetDocumentContent.mockReset()
    executor = await getExecutor('list_knowledge_base_documents')
  })

  it('缺少 knowledge_base_id 时应返回错误', async () => {
    const result = await executor({}, mockCtx())
    const content = extractContent(result)
    expect(content).toContain('Missing required parameter')
    expect(content).toContain('knowledge_base_id')
  })

  it('无文档时应提示创建', async () => {
    mockListDocuments.mockResolvedValue([])

    const result = await executor({ knowledge_base_id: 'kb-1' }, mockCtx())
    const content = extractContent(result)
    expect(content).toContain('No documents found')
  })

  it('有文档时应列出详细信息', async () => {
    mockListDocuments.mockResolvedValue([
      { id: 'doc-1', file_name: 'rust.md', file_type: 'md', file_size: 100, chunk_count: 3, status: 'ready', created_at: '' },
      { id: 'doc-2', file_name: 'python.md', file_type: 'md', file_size: 200, chunk_count: 5, status: 'ready', created_at: '' },
    ])

    const result = await executor({ knowledge_base_id: 'kb-1' }, mockCtx())
    const content = extractContent(result)
    expect(content).toContain('rust.md')
    expect(content).toContain('python.md')
    expect(content).toContain('doc-1')
    expect(content).toContain('doc-2')
    expect(content).toContain('kb-1')
  })

  it('失败时应返回错误信息', async () => {
    mockListDocuments.mockRejectedValue(new Error('知识库不存在'))

    const result = await executor({ knowledge_base_id: 'nonexistent' }, mockCtx())
    const content = extractContent(result)
    expect(content).toContain('Error listing documents')
    expect(content).toContain('知识库不存在')
  })
})

describe('get_knowledge_base_document 工具执行', () => {
  let executor: ToolExecutor

  beforeEach(async () => {
    mockQuery.mockReset()
    mockListKnowledgeBases.mockReset()
    mockWriteText.mockReset()
    mockRemoveDocument.mockReset()
    mockListDocuments.mockReset()
    mockGetDocumentContent.mockReset()
    executor = await getExecutor('get_knowledge_base_document')
  })

  it('缺少 knowledge_base_id 时应返回错误', async () => {
    const result = await executor({ document_id: 'doc-1' }, mockCtx())
    const content = extractContent(result)
    expect(content).toContain('Missing required parameter')
    expect(content).toContain('knowledge_base_id')
  })

  it('缺少 document_id 时应返回错误', async () => {
    const result = await executor({ knowledge_base_id: 'kb-1' }, mockCtx())
    const content = extractContent(result)
    expect(content).toContain('Missing required parameter')
    expect(content).toContain('document_id')
  })

  it('成功时应返回文档完整内容', async () => {
    mockGetDocumentContent.mockResolvedValue('这是文档的完整内容。\n\n第二段内容。')

    const result = await executor(
      { knowledge_base_id: 'kb-1', document_id: 'doc-1' },
      mockCtx(),
    )
    const content = extractContent(result)
    expect(content).toContain('这是文档的完整内容')
    expect(content).toContain('第二段内容')
    expect(content).toContain('doc-1')
  })

  it('失败时应返回错误信息', async () => {
    mockGetDocumentContent.mockRejectedValue(new Error('文档不存在'))

    const result = await executor(
      { knowledge_base_id: 'kb-1', document_id: 'nonexistent' },
      mockCtx(),
    )
    const content = extractContent(result)
    expect(content).toContain('Error retrieving document')
    expect(content).toContain('文档不存在')
  })
})
