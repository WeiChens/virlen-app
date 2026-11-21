// @vitest-environment node
/**
 * Responses API 协议的 TS 侧契约（`src/infrastructure/provider/responses.ts`）。
 *
 * 与 Rust `virlen-core/src/agent/provider/responses.rs` 是同一套语义的两份实现（铁律 1），
 * 这里钉住「不能靠读代码才发现」的几条：
 *   1. 请求体是 Responses 的形状（`instructions` / `input[]` item / 平铺工具 / `store:false`）；
 *   2. 助手工具调用是**顶层** `function_call` item、工具结果是 `function_call_output`
 *      （塞进 assistant 的 `content` 里服务端会判非法）；
 *   3. 推理走 `reasoning: { effort, summary }`，禁用时只发 `effort:'none'`；
 *   4. 协议名与显示名都登记了（`ProviderType` + `protocolLabel`），否则设置页下拉会出现裸英文。
 */
import { describe, expect, it } from 'vitest'
import { ResponsesProvider } from '@/infrastructure/provider/responses'
import { createProviderInstance } from '@/infrastructure/provider'
import { protocolLabel } from '@/ui/constants/providerVocabulary'
import type { ChatRequest } from '@/infrastructure/provider/types'
import type { Message } from '@/types'

function makeRequest(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: 'gpt-5',
    messages: [],
    systemPrompt: 'SYS',
    temperature: 0.7,
    topP: 1,
    maxTokens: 100,
    stream: false,
    tool_choice: 'none',
    ...overrides,
  }
}

function msg(role: Message['role'], content: Message['content']): Message {
  return { id: 'm', role, content, timestamp: 0 } as Message
}

const provider = () => new ResponsesProvider('p', 'k', 'https://api.test.com/v1/')

describe('Responses 请求体形状', () => {
  it('系统提示走 instructions，正文包成 input_text，且 store=false', () => {
    const body = provider().buildRequest(makeRequest({ messages: [msg('user', 'hi')] }))
    expect(body.instructions).toBe('SYS')
    expect(body.store).toBe(false)
    expect(body.model).toBe('gpt-5')
    expect(body.max_output_tokens).toBe(100)
    expect(body.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    ])
  })

  it('助手工具调用是顶层 function_call、工具结果是 function_call_output', () => {
    const assistant = {
      ...msg('assistant', '看看'),
      toolCalls: [{ type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.txt' } }],
    } as Message
    const tool = { ...msg('tool', '内容'), toolCallId: 'call_1' } as Message
    const body = provider().buildRequest(makeRequest({ messages: [assistant, tool] }))

    expect(body.input[0]).toEqual({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: '看看' }],
    })
    expect(body.input[1]).toEqual({
      type: 'function_call',
      call_id: 'call_1',
      name: 'read_file',
      arguments: '{"path":"a.txt"}',
    })
    expect(body.input[2]).toEqual({
      type: 'function_call_output',
      call_id: 'call_1',
      output: '内容',
    })
  })

  it('工具定义是平铺的（没有 function 这层）', () => {
    const body = provider().buildRequest(
      makeRequest({
        tools: [
          {
            name: 'read_file',
            description: '读文件',
            parameters: { type: 'object', properties: {}, required: [] },
          } as any,
        ],
      }),
    )
    expect(body.tools[0].type).toBe('function')
    expect(body.tools[0].name).toBe('read_file')
    expect(body.tools[0].function).toBeUndefined()
  })

  it('图片块 → input_image（image_url 是字符串）', () => {
    const body = provider().buildRequest(
      makeRequest({
        messages: [
          msg('user', [
            { type: 'text', text: '看图' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
          ] as Message['content']),
        ],
      }),
    )
    expect(body.input[0].content[0]).toEqual({ type: 'input_text', text: '看图' })
    expect(body.input[0].content[1]).toEqual({
      type: 'input_image',
      image_url: 'data:image/png;base64,AAA',
    })
  })

  it('推理档位走 reasoning.effort 且带 summary:auto；thinking:false 只发 effort:none', () => {
    const on = provider().buildRequest(makeRequest({ reasoningEffort: 'high' }))
    expect(on.reasoning).toEqual({ effort: 'high', summary: 'auto' })

    const off = provider().buildRequest(
      makeRequest({ reasoningEffort: 'high', thinking: false }),
    )
    expect(off.reasoning).toEqual({ effort: 'none' })
  })

  it('content 形状异常（既非 string 也非数组）按文本兜底，不抛 not iterable', () => {
    // 对齐 Rust `responses_user_content` 的 `other =>` 分支（铁律 1）
    const body = provider().buildRequest(
      makeRequest({ messages: [msg('user', { foo: 'bar' } as any)] }),
    )
    expect(body.input[0].content).toEqual([{ type: 'input_text', text: '{"foo":"bar"}' }])
  })
})

describe('Responses 协议的注册口径', () => {
  it('工厂按 type 造出 ResponsesProvider（不落到 openai 兼容的兜底分支）', () => {
    const p = createProviderInstance({
      id: 'x',
      name: 'x',
      type: 'responses',
      apiKey: 'k',
      baseUrl: 'https://api.test.com/v1',
    })
    expect(p).toBeInstanceOf(ResponsesProvider)
    expect(p?.providerType).toBe('responses')
  })

  it('显示名登记在协议词表里（否则设置页会显示裸协议名）', () => {
    expect(protocolLabel('responses')).toBe('OpenAI Responses')
  })
})
