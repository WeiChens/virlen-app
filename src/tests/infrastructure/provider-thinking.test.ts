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
import { ResponsesProvider } from '@/infrastructure/provider/responses'
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

describe('Responses provider thinking 映射', () => {
  const p = () => new ResponsesProvider('test', 'key', 'https://api.test.com')

  it('thinking:false → reasoning.effort none', () => {
    const body = p().buildRequest(makeRequest({ thinking: false }))
    expect(body.reasoning).toEqual({ effort: 'none' })
  })

  it('默认不传 thinking → 不设置 reasoning 字段', () => {
    const body = p().buildRequest(makeRequest())
    expect(body.reasoning).toBeUndefined()
  })

  it('reasoningEffort → reasoning.effort', () => {
    const body = p().buildRequest(makeRequest({ reasoningEffort: 'low' }))
    expect(body.reasoning).toEqual({ effort: 'low' })
  })
})

describe('Responses provider 请求映射', () => {
  const p = () => new ResponsesProvider('test', 'key', 'https://api.test.com')

  it('system prompt → instructions，端点字段为 input', () => {
    const body = p().buildRequest(
      makeRequest({
        systemPrompt: '你是一个助手',
        messages: [
          { id: '1', role: 'user', content: 'hi', timestamp: 0 },
        ],
      }),
    )
    expect(body.instructions).toBe('你是一个助手')
    expect(body.model).toBe('test-model')
    expect(body.input).toHaveLength(1)
    expect(body.input[0]).toEqual({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'hi' }],
    })
    expect(body.store).toBe(false)
  })

  it('工具定义平铺为 { type:function, name, parameters }', () => {
    const body = p().buildRequest(
      makeRequest({
        tools: [
          {
            name: 'foo',
            description: 'desc',
            parameters: { type: 'object', properties: {} },
          } as any,
        ],
      }),
    )
    expect(body.tools[0]).toEqual({
      type: 'function',
      name: 'foo',
      description: 'desc',
      parameters: { type: 'object', properties: {} },
    })
  })

  it('助手 toolCalls → function_call item，工具结果 → function_call_output item', () => {
    const body = p().buildRequest(
      makeRequest({
        messages: [
          {
            id: 'a1',
            role: 'assistant',
            content: '',
            timestamp: 0,
            toolCalls: [
              {
                type: 'tool_use',
                id: 'call_1',
                name: 'get_time',
                input: { tz: 'UTC' },
              },
            ],
          },
          {
            id: 't1',
            role: 'tool',
            content: '12:00',
            toolCallId: 'call_1',
            timestamp: 0,
          },
        ],
      }),
    )
    expect(body.input[0]).toEqual({
      type: 'function_call',
      call_id: 'call_1',
      name: 'get_time',
      arguments: JSON.stringify({ tz: 'UTC' }),
    })
    expect(body.input[1]).toEqual({
      type: 'function_call_output',
      call_id: 'call_1',
      output: '12:00',
    })
  })
})

describe('Gemini provider 请求映射', () => {
  const p = () => new GeminiProvider('test', 'key', 'https://api.test.com')

  it('systemPrompt → systemInstruction，user 文本 → contents', () => {
    const body = p().buildRequest(
      makeRequest({
        systemPrompt: '你是助手',
        messages: [{ id: '1', role: 'user', content: 'hi', timestamp: 0 }],
      }),
    )
    expect(body.systemInstruction).toEqual({ parts: [{ text: '你是助手' }] })
    expect(body.contents).toEqual([
      { role: 'user', parts: [{ text: 'hi' }] },
    ])
  })

  it('工具声明为 functionDeclarations，tool_choice:none → mode NONE', () => {
    const body = p().buildRequest(
      makeRequest({
        tools: [
          {
            name: 'search_files',
            description: 'd',
            parameters: { type: 'object', properties: {} },
          } as any,
        ],
        tool_choice: 'none',
      }),
    )
    expect(body.tools[0].functionDeclarations[0]).toEqual({
      name: 'search_files',
      description: 'd',
      parameters: { type: 'object', properties: {} },
    })
    expect(body.toolConfig.functionCallingConfig.mode).toBe('NONE')
  })

  it('tool_choice:auto + tools → mode AUTO', () => {
    const body = p().buildRequest(
      makeRequest({
        tools: [{ name: 'x', description: '', parameters: {} } as any],
        tool_choice: 'auto',
      }),
    )
    expect(body.toolConfig.functionCallingConfig.mode).toBe('AUTO')
  })

  it('无 tools 时不附带 toolConfig', () => {
    const body = p().buildRequest(makeRequest({ tool_choice: 'none' }))
    expect(body.toolConfig).toBeUndefined()
  })

  it('助手 toolCalls → model.functionCall，工具结果 → user.functionResponse（名称含下划线正确）', () => {
    const body = p().buildRequest(
      makeRequest({
        messages: [
          {
            id: 'a1',
            role: 'assistant',
            content: '',
            timestamp: 0,
            toolCalls: [
              {
                type: 'tool_use',
                id: 'fc_read_file_abc12345',
                name: 'read_file',
                input: { path: 'a.txt' },
              },
            ],
          },
          {
            id: 't1',
            role: 'tool',
            content: 'content',
            toolCallId: 'fc_read_file_abc12345',
            timestamp: 0,
          },
        ],
      }),
    )
    expect(body.contents[0]).toEqual({
      role: 'model',
      parts: [{ functionCall: { name: 'read_file', args: { path: 'a.txt' } } }],
    })
    // 合成的 fc_ id 不回传
    expect(body.contents[0].parts[0].functionCall.id).toBeUndefined()
    expect(body.contents[1].role).toBe('user')
    expect(body.contents[1].parts[0].functionResponse).toEqual({
      name: 'read_file',
      response: { name: 'read_file', content: 'content' },
    })
  })

  it('连续工具结果合并到同一条 user content', () => {
    const body = p().buildRequest(
      makeRequest({
        messages: [
          {
            id: 'a1',
            role: 'assistant',
            content: '',
            timestamp: 0,
            toolCalls: [
              { type: 'tool_use', id: 'fc_a_11111111', name: 'a', input: {} },
              { type: 'tool_use', id: 'fc_b_22222222', name: 'b', input: {} },
            ],
          },
          {
            id: 't1',
            role: 'tool',
            content: 'r1',
            toolCallId: 'fc_a_11111111',
            timestamp: 0,
          },
          {
            id: 't2',
            role: 'tool',
            content: 'r2',
            toolCallId: 'fc_b_22222222',
            timestamp: 0,
          },
        ],
      }),
    )
    const userTurn = body.contents.find((c: any) => c.role === 'user')
    expect(userTurn.parts).toHaveLength(2)
    expect(userTurn.parts[0].functionResponse.name).toBe('a')
    expect(userTurn.parts[1].functionResponse.name).toBe('b')
  })

  it('过大的 maxTokens 不写入 maxOutputTokens', () => {
    const body = p().buildRequest(makeRequest({ maxTokens: 2000000 }))
    expect(body.generationConfig?.maxOutputTokens).toBeUndefined()
  })

  it('Gemini 2.5：回传 functionCall 的 thoughtSignature', () => {
    const body = p().buildRequest(
      makeRequest({
        messages: [
          {
            id: 'a1',
            role: 'assistant',
            content: '',
            timestamp: 0,
            toolCalls: [
              {
                type: 'tool_use',
                id: 'call_abc',
                name: 'get_weather',
                input: { city: 'BJ' },
                thoughtSignature: 'SIG123',
              },
            ],
          },
        ],
      }),
    )
    expect(body.contents[0].parts[0]).toEqual({
      functionCall: { id: 'call_abc', name: 'get_weather', args: { city: 'BJ' } },
      thoughtSignature: 'SIG123',
    })
  })

  it('无 thoughtSignature 时不输出该字段', () => {
    const body = p().buildRequest(
      makeRequest({
        messages: [
          {
            id: 'a1',
            role: 'assistant',
            content: '',
            timestamp: 0,
            toolCalls: [
              { type: 'tool_use', id: 'call_abc', name: 'foo', input: {} },
            ],
          },
        ],
      }),
    )
    expect(body.contents[0].parts[0].thoughtSignature).toBeUndefined()
  })
})
