/**
 * OpenAI 兼容 Provider — 支持所有 OpenAI 协议兼容的 API
 * (OpenAI, DeepSeek, Moonshot, Zhipu, Ollama, 自定义等)
 */
import type { Message, ProviderConfig, StreamCallback } from '@/types'
import type { ChatRequest, IProvider } from './types'
import {
  apiFetch,
  getResponseReader,
  readStreamLines,
  extractJsonData,
} from './http-utils'
import { v4 } from '@/utils/uuid'
import { getLastSummaryMessageIndex } from '@/types'
import { processVisionContent } from './visionInject'

export class OpenAiProvider implements IProvider {
  readonly name: string
  private apiKey: string
  private baseUrl: string
  private get headers() {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    }
  }

  constructor(name: string, apiKey: string, baseUrl: string) {
    this.name = name
    this.apiKey = apiKey
    this.baseUrl = baseUrl.replace(/\/+$/, '')
  }
  async validateApiKey(config: ProviderConfig): Promise<boolean> {
    if (config.models.length === 0) {
      throw new Error('请先为该 Provider 配置至少一个模型')
    }
    try {
      const res = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.models[0],
          messages: [
            { role: 'user', content: [{ type: 'text', text: 'ping' }] },
          ],
          max_tokens: 1,
        }),
      })
      if (!res.ok) {
        throw new Error(res.statusText)
      }
      return res.ok
    } catch (e) {
      console.error(e)
      return false
    }
  }

  /** 更新 API 配置 */
  updateConfig(apiKey: string, baseUrl: string): void {
    this.apiKey = apiKey
    this.baseUrl = baseUrl.replace(/\/+$/, '')
  }

  async listModels(): Promise<string[]> {
    const res = await apiFetch({
      url: `${this.baseUrl}/models`,
      method: 'GET',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      providerName: this.name,
    })
    const data = await res.json()
    return (data.data || []).map((m: any) => m.id)
  }

  async chat(request: ChatRequest, signal?: AbortSignal): Promise<Message> {
    const body = this.buildRequest(request)
    body.stream = false

    const res = await apiFetch({
      url: `${this.baseUrl}/chat/completions`,
      headers: this.headers,
      body: JSON.stringify(body),
      signal,
      providerName: this.name,
    })

    const data = await res.json()
    return this.parseResponse(data)
  }

  async chatStream(
    request: ChatRequest,
    callback: StreamCallback,
    signal?: AbortSignal,
  ): Promise<void> {
    const body = this.buildRequest(request)
    body.stream = true

    let res: Response
    try {
      res = await apiFetch({
        url: `${this.baseUrl}/chat/completions`,
        headers: this.headers,
        body: JSON.stringify(body),
        signal,
        providerName: this.name,
      })
    } catch (e: any) {
      callback({ type: 'error', error: e.message })
      return
    }

    let reader: ReadableStreamDefaultReader<Uint8Array>
    try {
      reader = getResponseReader(res)
    } catch (e: any) {
      callback({ type: 'error', error: e.message })
      return
    }

    const decoder = new TextDecoder()
    let reasoningContent = ''
    let lastUsage:
      | { promptTokens: number; completionTokens: number; totalTokens: number }
      | undefined
    const toolCallsAccumulator: Map<
      number,
      { id: string; name: string; arguments: string }
    > = new Map()
    let toolCallsFired = false

    try {
      await readStreamLines(
        reader,
        decoder,
        (line) => {
          const parsed = extractJsonData(line)
          if (!parsed) return
          if (parsed.isDone) {
            callback({
              type: 'message_stop',
              reasoningContent,
              usage: lastUsage,
            })
            return
          }

          const chunk = parsed.json
          const delta = chunk.choices?.[0]?.delta

          if (delta?.content) {
            callback({ type: 'text_delta', data: delta.content })
          }
          if (delta?.reasoning_content) {
            reasoningContent += delta.reasoning_content
            callback({
              type: 'reasoning_content_change',
              data: reasoningContent,
            })
          }

          // 处理 tool call delta
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0
              if (!toolCallsAccumulator.has(idx)) {
                toolCallsAccumulator.set(idx, {
                  id: tc.id || '',
                  name: tc.function?.name || '',
                  arguments: tc.function?.arguments || '',
                })
              } else {
                const existing = toolCallsAccumulator.get(idx)!
                if (tc.id) existing.id = tc.id
                if (tc.function?.name) existing.name = tc.function.name
                if (tc.function?.arguments)
                  existing.arguments += tc.function.arguments
              }
            }
          }

          // 记录 usage（流式模式下出现在带有 finish_reason 的最后一个 chunk 中）
          if (chunk.usage) {
            lastUsage = {
              promptTokens: chunk.usage.prompt_tokens ?? 0,
              completionTokens: chunk.usage.completion_tokens ?? 0,
              totalTokens: chunk.usage.total_tokens ?? 0,
            }
          }

          // 检查 finish_reason 是否为 tool_calls（只触发一次）
          if (
            !toolCallsFired &&
            chunk.choices?.[0]?.finish_reason === 'tool_calls'
          ) {
            toolCallsFired = true
            for (const [, tc] of toolCallsAccumulator) {
              callback({
                type: 'tool_use',
                toolUse: {
                  type: 'tool_use',
                  id: tc.id,
                  name: tc.name,
                  input: JSON.parse(tc.arguments || '{}'),
                },
              })
            }
          }
        },
        signal,
      )
    } catch (e: any) {
      if (e?.name !== 'AbortError') {
        callback({ type: 'error', error: e.message })
      }
    }
  }

  buildRequest(request: ChatRequest): any {
    const messages: any[] = []

    // 系统提示词
    if (request.systemPrompt) {
      messages.push({ role: 'system', content: request.systemPrompt })
    }
    const lastSummaryMessageIndex = getLastSummaryMessageIndex(request.messages)
    const requestMessages =
      lastSummaryMessageIndex == -1
        ? request.messages
        : request.messages.slice(lastSummaryMessageIndex)

    // 消息列表
    for (const msg of requestMessages) {
      // summary 角色：转为 user 消息，作为压缩后的历史上下文
      if (msg.role === 'summary') {
        messages.push({
          role: 'user',
          content:
            typeof msg.content === 'string'
              ? `${msg.content}`
              : '' + JSON.stringify(msg.content),
        })
        continue
      }

      const formatted: any = { role: msg.role }

      if (typeof msg.content === 'string') {
        // assistant 带 tool_calls 时，若 content 为空字符串则设为 null（OpenAI strict 模式要求）
        // if (msg.role === 'assistant' && msg.toolCalls?.length && msg.content === '') {
        //   formatted.content = null
        // } else {
        formatted.content = msg.content
        // }
      } else if (Array.isArray(msg.content)) {
        formatted.content = msg.content.map((block) => {
          if (block.type === 'text') return block
          if (block.type === 'image_url') return block
          return block
        })
      }

      // 视觉分析优化：替换 image_url 为分析文本
      const visionBlocks = processVisionContent(msg)
      if (visionBlocks) {
        formatted.content = visionBlocks
      }

      if (msg.toolCalls?.length) {
        formatted.tool_calls = msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.input) },
        }))
      }

      if (msg.role === 'assistant' && msg.reasoningContent) {
        formatted.reasoning_content = msg.reasoningContent
      }

      if (msg.toolCallId) {
        formatted.tool_call_id = msg.toolCallId
      }

      messages.push(formatted)
    }

    const body: any = {
      model: request.model,
      messages,
      temperature: request.temperature,
      top_p: request.topP,
      max_tokens: request.maxTokens,
      stream: request.stream,
    }

    if (request.tools?.length) {
      body.tools = request.tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }))
    }
    if (request.tool_choice) {
      body.tool_choice = request.tool_choice
    }

    // 推理努力程度（OpenAI o 系列模型：low / medium / high）
    if (request.reasoningEffort) {
      body.reasoning_effort = request.reasoningEffort
    }

    return body
  }

  private parseResponse(data: any): Message {
    const choice = data.choices?.[0]
    const msg = choice?.message || choice?.delta || {}

    const message: Message = {
      id: v4(),
      role: 'assistant',
      content: msg.content || '',
      timestamp: Date.now(),
    }

    if (msg.tool_calls?.length) {
      message.toolCalls = msg.tool_calls.map((tc: any) => ({
        type: 'tool_use' as const,
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments || '{}'),
      }))
    }

    if (data.usage) {
      message.usage = {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens,
      }
    }

    // 保留 reasoning_content（DeepSeek thinking 模式）
    if (msg.reasoning_content) {
      message.reasoningContent = msg.reasoning_content
    }

    return message
  }
}
