/**
 * Anthropic Provider — 使用 Anthropic Messages API 格式
 *
 * 与 OpenAI（content 为字符串/tool_calls 在顶层）不同：
 * - content 始终为 block array，tool_use/tool_result 嵌入 content 内
 * - 流式输出包含 content_block_delta / content_block_stop 事件
 * - 使用 x-api-key header
 * - API 端点：https://api.anthropic.com/v1/messages
 */
import type {
  Message,
  ProviderConfig,
  StreamCallback,
  ToolUseContent,
} from '@/types'
import type { ChatRequest, IProvider } from './types'
import { apiFetch, getResponseReader, readStreamLines } from './http-utils'
import { getLastSummaryMessageIndex } from '@/types'
import { processVisionContent } from './visionInject'
import { fetch } from '@tauri-apps/plugin-http'

interface AnthropicContentBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, any>
  tool_use_id?: string
  content?: string
  source?: { type: string; media_type?: string; data?: string; url?: string }
  is_error?: boolean
  thinking?: string
  signature?: string
}

interface AnthropicResponse {
  id: string
  type: string
  role: string
  content: AnthropicContentBlock[]
  model: string
  stop_reason: string | null
  usage?: {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
}
export class AnthropicProvider implements IProvider {
  readonly name: string
  private apiKey: string
  private baseUrl: string

  private get headers() {
    return {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': '2023-06-01',
    }
  }

  constructor(name: string, apiKey: string, baseUrl?: string) {
    this.name = name
    this.apiKey = apiKey
    this.baseUrl = (baseUrl || 'https://api.anthropic.com/v1').replace(
      /\/+$/,
      '',
    )
  }
  async validateApiKey(config: ProviderConfig): Promise<boolean> {
    if (config.models.length === 0) {
      throw new Error('请先为该 Provider 配置至少一个模型')
    }
    try {
      const res = await fetch(`${this.baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
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
        throw new Error(await res.text())
      }
      return res.ok
    } catch (e) {
      console.error(e)
      return false
    }
  }

  async listModels(): Promise<string[]> {
    try {
      const urlObj = new URL(this.baseUrl)
      const res = await fetch(`${urlObj.protocol}//${urlObj.host}/models`, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
      })
      if (!res.ok) throw '请手动填写模型'
      const data = await res.json()
      return (data.data || []).map((m: any) => m.id)
    } catch {
      throw '请手动填写模型'
    }
  }

  async chat(request: ChatRequest, signal?: AbortSignal): Promise<Message> {
    const body = this.buildRequest(request)
    const res = await apiFetch({
      url: `${this.baseUrl}/messages`,
      headers: this.headers,
      body: JSON.stringify(body),
      signal,
      providerName: 'Anthropic',
    })
    const data: AnthropicResponse = await res.json()
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
        url: `${this.baseUrl}/messages`,
        headers: this.headers,
        body: JSON.stringify(body),
        signal,
        providerName: 'Anthropic',
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
    await this.parseAnthropicSSE(reader, decoder, callback, signal)
  }

  private async parseAnthropicSSE(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    decoder: TextDecoder,
    callback: StreamCallback,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    let currentEvent = ''
    const blockTexts: Map<number, string> = new Map()
    const toolUses: Map<number, ToolUseContent> = new Map()
    const inputPartials: Map<number, string> = new Map()
    let toolUseEventFired = false
    let thinkingContentBuffer = ''
    let lastUsage:
      | { promptTokens: number; completionTokens: number; totalTokens: number }
      | undefined

    try {
      await readStreamLines(
        reader,
        decoder,
        (line) => {
          const trimmed = line.trim()

          if (trimmed.startsWith('event:')) {
            currentEvent = trimmed.slice(6).trim()
            return
          }

          if (trimmed.startsWith('data:')) {
            const dataStr = trimmed.slice(5).trim()

            if (dataStr === '[DONE]') {
              callback({ type: 'message_stop' })
              return
            }

            try {
              const data = JSON.parse(dataStr)

              switch (currentEvent) {
                case 'content_block_start': {
                  if (data.content_block?.type === 'tool_use') {
                    toolUses.set(data.index, {
                      type: 'tool_use',
                      id: data.content_block.id,
                      name: data.content_block.name,
                      input: data.content_block.input || {},
                    })
                  }
                  blockTexts.set(data.index, '')
                  break
                }

                case 'content_block_delta': {
                  const delta = data.delta
                  if (delta?.type === 'text_delta') {
                    const current = blockTexts.get(data.index) || ''
                    blockTexts.set(data.index, current + delta.text)
                    callback({ type: 'text_delta', data: delta.text })
                  }
                  if (delta?.type === 'input_json_delta') {
                    const existing = inputPartials.get(data.index) || ''
                    inputPartials.set(
                      data.index,
                      existing + (delta.partial_json || ''),
                    )
                  }
                  if (delta?.type === 'thinking_delta') {
                    thinkingContentBuffer += delta.thinking || ''
                    callback({
                      type: 'reasoning_content_change',
                      data: thinkingContentBuffer,
                    })
                  }
                  break
                }

                case 'content_block_stop': {
                  const toolUse = toolUses.get(data.index)
                  if (toolUse) {
                    const partial = inputPartials.get(data.index)
                    if (partial) {
                      try {
                        toolUse.input = JSON.parse(partial)
                      } catch {
                        toolUse.input = { _partial: partial }
                      }
                    }
                    if (!toolUseEventFired) {
                      toolUseEventFired = true
                      callback({ type: 'tool_use', toolUse })
                    }
                  }
                  break
                }

                case 'message_delta': {
                  if (data.usage) {
                    lastUsage = {
                      promptTokens: data.usage.input_tokens ?? 0,
                      completionTokens: data.usage.output_tokens ?? 0,
                      totalTokens:
                        (data.usage.input_tokens ?? 0) +
                        (data.usage.output_tokens ?? 0) +
                        (data.usage.cache_read_input_tokens ?? 0) +
                        (data.usage.cache_creation_input_tokens ?? 0),
                    }
                  }
                  if (
                    data.delta?.stop_reason === 'tool_use' &&
                    !toolUseEventFired
                  ) {
                    for (const [, tu] of toolUses) {
                      callback({ type: 'tool_use', toolUse: tu })
                    }
                    toolUseEventFired = true
                  }
                  break
                }

                case 'message_stop': {
                  callback({
                    type: 'message_stop',
                    reasoningContent: thinkingContentBuffer || undefined,
                    usage: lastUsage,
                  })
                  break
                }

                case 'error': {
                  callback({
                    type: 'error',
                    error: data.error?.message || 'Anthropic API error',
                  })
                  break
                }
              }
            } catch {
              // Parse error
            }
            return
          }

          // Empty line resets event type
          if (trimmed === '') {
            currentEvent = ''
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
    // Anthropic API: system is a top-level field, messages are [{role, content}]
    // content is always an array of blocks

    const messages: { role: string; content: AnthropicContentBlock[] }[] = []
    let system: string | undefined = request.systemPrompt || ''

    // 收集当前消息批次中已完成内容的索引
    let tempAssistantBlocks: AnthropicContentBlock[] = []
    const lastSummaryMessageIndex = getLastSummaryMessageIndex(request.messages)
    const requestMessages =
      lastSummaryMessageIndex == -1
        ? request.messages
        : request.messages.slice(lastSummaryMessageIndex)
    for (const msg of requestMessages) {
      // summary 角色：转为 user 消息，作为压缩后的历史上下文
      if (msg.role === 'summary') {
        messages.push({
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                typeof msg.content === 'string'
                  ? `${msg.content}`
                  : '' + JSON.stringify(msg.content),
            },
          ],
        })
        continue
      }

      if (msg.role === 'assistant') {
        tempAssistantBlocks = []
        const content = msg.content
        // 将历史消息中的 thinking 内容作为 thinking block 传给 API
        if (msg.reasoningContent) {
          tempAssistantBlocks.push({
            type: 'thinking',
            thinking: msg.reasoningContent,
          })
        }
        if (typeof content === 'string' && content) {
          tempAssistantBlocks.push({ type: 'text', text: content })
        }

        if (msg.toolCalls?.length) {
          for (const tc of msg.toolCalls) {
            tempAssistantBlocks.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.name,
              input: tc.input,
            })
          }
        }

        messages.push({
          role: 'assistant',
          content:
            tempAssistantBlocks.length > 0
              ? tempAssistantBlocks
              : [{ type: 'text', text: '' }],
        })
        continue
      }

      if (msg.role === 'tool') {
        // tool_result — content is a block array
        const toolResultBlock: AnthropicContentBlock = {
          type: 'tool_result',
          tool_use_id: msg.toolCallId || '',
          content:
            typeof msg.content === 'string'
              ? msg.content
              : JSON.stringify(msg.content),
          is_error: msg.isError ? true : undefined,
        }

        const lastMsg = messages[messages.length - 1]
        if (
          lastMsg &&
          lastMsg.role === 'user' &&
          lastMsg.content.length > 0 &&
          lastMsg.content[0].type === 'tool_result'
        ) {
          // 前一条消息已经是 tool_result 的 user 消息 → 追加到同一条
          lastMsg.content.push(toolResultBlock)
        } else {
          // 创建新的 tool_result 消息
          messages.push({
            role: 'user',
            content: [toolResultBlock],
          })
        }
        continue
      }

      // user message
      const contentBlocks: AnthropicContentBlock[] = []
      if (typeof msg.content === 'string') {
        contentBlocks.push({ type: 'text', text: msg.content })
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'text') {
            contentBlocks.push({ type: 'text', text: block.text })
          } else if (block.type === 'image_url') {
            const url = block.image_url.url
            if (url.startsWith('data:')) {
              const parts = url.split(',')
              contentBlocks.push({
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/jpeg',
                  data: parts[1],
                },
              })
            } else {
              contentBlocks.push({
                type: 'image',
                source: { type: 'url', url },
              })
            }
          }
        }
      }

      // 注入视觉分析结果
      // 视觉分析优化：替换 image_url 为分析文本
      const visionBlocks = processVisionContent(msg)
      if (visionBlocks) {
        // 整个 content 由 vision 接管（去掉 image_url，追加分析文本）
        messages.push({ role: 'user', content: visionBlocks as any })
      } else {
        messages.push({ role: 'user', content: contentBlocks })
      }
    }

    const body: any = {
      model: request.model,
      max_tokens: request.maxTokens ?? 2000000,
      messages,
    }

    if (system) {
      body.system = system.trim()
    }

    if (request.temperature !== undefined) {
      body.temperature = request.temperature
    }

    if (request.tools?.length) {
      body.tools = request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }))
    }
    if (request.tool_choice == 'none') {
      body.tool_choice = { type: 'none' }
    }

    return body
  }

  private parseResponse(data: AnthropicResponse): Message {
    const message: Message = {
      id: data.id,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
    }

    const textBlocks: string[] = []
    const toolCalls: ToolUseContent[] = []

    for (const block of data.content || []) {
      if (block.type === 'text') {
        textBlocks.push(block.text || '')
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          type: 'tool_use',
          id: block.id || '',
          name: block.name || '',
          input: block.input || {},
        })
      }
    }

    message.content = textBlocks.join('')

    if (toolCalls.length > 0) {
      message.toolCalls = toolCalls
    }

    if (data.usage) {
      message.usage = {
        promptTokens: data.usage.input_tokens,
        completionTokens: data.usage.output_tokens,
        totalTokens:
          data.usage.input_tokens +
          data.usage.output_tokens +
          (data.usage.cache_read_input_tokens ?? 0) +
          (data.usage.cache_creation_input_tokens ?? 0),
      }
    }

    return message
  }
}
