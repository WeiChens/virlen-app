/**
 * RAG 领域类型测试 — 知识库相关的类型定义和默认值
 *
 * 覆盖场景：
 * - RAGContext 类型结构
 * - RAGQueryOptions 类型结构
 * - RAGConfig 默认值的正确性
 * - defaultRAGConfig 字段值
 * - embeddingModel 可选配置
 */
import { describe, it, expect } from 'vitest'
import { defaultRAGConfig } from '@/domain/rag/types'
import type {
  RAGContext,
  RAGQueryOptions,
  RAGConfig,
} from '@/domain/rag/types'

describe('RAGContext 类型结构', () => {
  it('应能构建一个有效的 RAGContext 对象', () => {
    const context: RAGContext = {
      chunks: [
        {
          id: 'chunk-1',
          content: '这是检索到的文本块',
          documentName: 'doc-1',
          score: 0.95,
        },
        {
          id: 'chunk-2',
          content: '另一个文本块',
          documentName: 'doc-1',
          score: 0.87,
        },
      ],
      query: '如何配置 RAG',
      knowledgeBaseId: 'kb-1',
      formattedContext: '检索结果：\n1. 这是检索到的文本块\n2. 另一个文本块',
    }

    expect(context.chunks).toHaveLength(2)
    expect(context.query).toBe('如何配置 RAG')
    expect(context.knowledgeBaseId).toBe('kb-1')
    expect(context.formattedContext).toContain('检索结果')
  })

  it('应能处理空的 chunks 列表', () => {
    const context: RAGContext = {
      chunks: [],
      query: 'test',
      knowledgeBaseId: 'kb-1',
      formattedContext: '',
    }
    expect(context.chunks).toHaveLength(0)
  })

  it('chunk 数据的 score 范围应在 0~1 之间', () => {
    const validScores = [0, 0.5, 1.0, 0.123]
    for (const score of validScores) {
      const chunk = {
        id: 'chunk-1',
        content: 'test',
        documentName: 'doc',
        score,
      }
      expect(chunk.score).toBeGreaterThanOrEqual(0)
      expect(chunk.score).toBeLessThanOrEqual(1)
    }
  })
})

describe('RAGQueryOptions 类型结构', () => {
  it('应能构建有效的 RAGQueryOptions', () => {
    const options: RAGQueryOptions = {
      knowledgeBaseIds: ['kb-1', 'kb-2'],
      topK: 5,
      minScore: 0.7,
    }
    expect(options.knowledgeBaseIds).toHaveLength(2)
    expect(options.topK).toBe(5)
    expect(options.minScore).toBe(0.7)
  })

  it('minScore 应为可选项', () => {
    const options: RAGQueryOptions = {
      knowledgeBaseIds: ['kb-1'],
      topK: 3,
    }
    expect(options.minScore).toBeUndefined()
  })
})

describe('defaultRAGConfig', () => {
  it('RAG 功能默认应禁用', () => {
    expect(defaultRAGConfig.enabled).toBe(false)
  })

  it('默认知识库 ID 应为空字符串', () => {
    expect(defaultRAGConfig.defaultKnowledgeBaseId).toBe('')
  })

  it('默认 topK 应为 5', () => {
    expect(defaultRAGConfig.defaultTopK).toBe(5)
  })

  it('最大上下文字符数应为 8000', () => {
    expect(defaultRAGConfig.maxContextChars).toBe(8000)
  })

  it('embeddingModel 默认应为 undefined', () => {
    expect(defaultRAGConfig.embeddingModel).toBeUndefined()
  })

  it('应能覆盖默认配置创建自定义配置', () => {
    const customConfig: RAGConfig = {
      enabled: true,
      defaultKnowledgeBaseId: 'kb-custom',
      defaultTopK: 10,
      maxContextChars: 16000,
      embeddingModel: {
        provider: 'openai',
        model: 'text-embedding-3-small',
        dimensions: 1536,
      },
    }

    expect(customConfig.enabled).toBe(true)
    expect(customConfig.defaultTopK).toBe(10)
    expect(customConfig.embeddingModel!.dimensions).toBe(1536)
  })
})
