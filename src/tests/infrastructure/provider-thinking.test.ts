/**
 * provider thinking 参数映射测试
 *
 * 验证 ChatRequest.thinking=false 时各 provider 在请求体中正确禁用思考/推理：
 * - OpenAI 兼容（DeepSeek）：thinking:{type:'disabled'} + reasoning_effort:'none'
 * - Anthropic：thinking:{type:'disabled'}
 * - Gemini：generationConfig.thinkingConfig.thinkingBudget=0
 * 默认（不传 thinking = true）不设置任何 thinking 字段，保持模型默认行为。
 */
import { describe, it, expect } from 'vitest'
import { OpenAiProvider } from '@/infrastructure/provider/openai'
import { AnthropicProvider } from '@/infrastructure/provider/anthropic'
import { GeminiProvider } from '@/infrastructure/provider/gemini'
import type { ChatRequest } from '@/infrastructure/provider/types'

function makeRequest(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: 'test-model',
    messages: [],
    temperature: 0.7,
    topP: 1,
    maxTokens: 100,
    stream: false,
    tool_choice: 'none',
    ...overrides,
  }
}

describe('OpenAI provider thinking 映射', () => {
  const p = () => new OpenAiProvider('test', 'key', 'https://api.test.com')

  it('thinking:false → thinking disabled + reasoning_effort none', () => {
    const body = p().buildRequest(makeRequest({ thinking: false }))
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(body.reasoning_effort).toBe('none')
  })

  it('默认不传 thinking → 不设置 thinking 字段', () => {
    const body = p().buildRequest(makeRequest())
    expect(body.thinking).toBeUndefined()
    expect(body.reasoning_effort).toBeUndefined()
  })

  it('reasoningEffort → reasoning_effort，且不设置 thinking', () => {
    const body = p().buildRequest(makeRequest({ reasoningEffort: 'low' }))
    expect(body.reasoning_effort).toBe('low')
    expect(body.thinking).toBeUndefined()
  })
})

describe('Anthropic provider thinking 映射', () => {
  const p = () => new AnthropicProvider('test', 'key', 'https://api.test.com')

  it('thinking:false → thinking disabled', () => {
    const body = p().buildRequest(makeRequest({ thinking: false }))
    expect(body.thinking).toEqual({ type: 'disabled' })
  })

  it('默认不传 thinking → 不设置 thinking 字段', () => {
    const body = p().buildRequest(makeRequest())
    expect(body.thinking).toBeUndefined()
  })
})

describe('Gemini provider thinking 映射', () => {
  const p = () => new GeminiProvider('test', 'key', 'https://api.test.com')

  it('thinking:false → thinkingConfig.thinkingBudget=0', () => {
    const body = p().buildRequest(makeRequest({ thinking: false }))
    expect(body.generationConfig?.thinkingConfig).toEqual({
      thinkingBudget: 0,
    })
  })

  it('默认不传 thinking → 不设置 thinkingConfig', () => {
    const body = p().buildRequest(makeRequest())
    expect(body.generationConfig?.thinkingConfig).toBeUndefined()
  })
})
