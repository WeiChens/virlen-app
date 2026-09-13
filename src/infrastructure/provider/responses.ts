/**
 * OpenAI Responses API Provider — 使用 Responses API 格式 (/v1/responses)
 *
 * 与 Chat Completions 的主要区别：
 * - 端点：POST {baseUrl}/responses
 * - 请求：system 作为顶层 instructions；消息放进 input 数组
 *   - user/assistant 文本用 message item（content 为 input_text / output_text）
 *   - 助手发起的函数调用为顶层 function_call item，工具结果为 function_call_output item
 * - 工具定义：{ type:'function', name, description, parameters }（平铺，不嵌套 function）
 * - 响应：output 数组（message / reasoning / function_call item），
 *   usage 使用 input_tokens / output_tokens / total_tokens
 * - 流式：命名事件（response.output_text.delta / response.function_call_arguments.delta /
 *   response.output_item.done / response.completed 等）
 */
import type {
  Message,
  ProviderConfig,
  StreamCallback,
  ToolUseContent,
} from '@/types'
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

/** Responses API 中的输入内容块 */
interface ResponsesContentPart {
  type: 'input_text' | 'input_image' | 'output_text'
  text?: string
  image_url?: string
}

interface ResponsesUsage {
  input_tokens?: number
  output_tokens?: number
  total_tokens?: number
}

interface ResponsesItem {
  type: string
  id?: string
  call_id?: string
  name?: string
  arguments?: string
  role?: string
  content?: Array<{ type: string; text?: string }>
  summary?: Array<{ type?: string; text?: string }>
}

export class ResponsesProvider implements IProvider {
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

  /** 更新 API 配置 */
  updateConfig(apiKey: string, baseUrl: string): void {
    this.apiKey = apiKey
    this.baseUrl = baseUrl.replace(/\/+$/, '')
  }

  async validateApiKey(config: ProviderConfig): Promise<boolean> {
    if (config.models.length === 0) {
      throw new Error('请先为该 Provider 配置至少一个模型')
    }
    try {
      const baseUrl = config.baseUrl.replace(/\/+$/, '')
      const res = await fetch(`${baseUrl}/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.models[0],
          input: 'ping',
          max_output_tokens: 16,
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
      url: `${this.baseUrl}/responses`,
      headers: this.headers,
      body: JSON.stringify(body),
      signal,
      providerName: this.name,
      traceId: request.traceId,
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
        url: `${this.baseUrl}/responses`,
        headers: this.headers,
        body: JSON.stringify(body),
        signal,
        providerName: this.name,
        traceId: request.traceId,
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
    // 按 output_index / item_id 累积 function_call
    const toolCallItems: Map<
      string,
      { id: string; name: string; args: string; fired: boolean }
    > = new Map()

    const emitToolUse = (itemId: string | undefined) => {
      if (!itemId) return
      const it = toolCallItems.get(itemId)
      if (!it || it.fired) return
      it.fired = true
      let input: Record<string, any> = {}
      try {
        input = JSON.parse(it.args || '{}')
      } catch {
        input = { _partial: it.args }
      }
      callback({
        type: 'tool_use',
        toolUse: {
          type: 'tool_use',
          id: it.id,
          name: it.name,
          input,
        },
      })
    }

    // 流结束（response.completed / [DONE]）只结算一次
    let stopped = false
    const finish = () => {
      if (stopped) return
      stopped = true
      for (const key of toolCallItems.keys()) emitToolUse(key)
      callback({
        type: 'message_stop',
        reasoningContent: reasoningContent || undefined,
        usage: lastUsage,
      })
    }

    try {
      await readStreamLines(
        reader,
        decoder,
        (line) => {
          const parsed = extractJsonData(line, request.traceId)
          if (!parsed) return
          if (parsed.isDone) {
            finish()
            return
          }

          const data = parsed.json
          // Responses 流式使用命名事件，data 内的 type 字段与事件名一致
          const type: string = data?.type || ''

          switch (type) {
            case 'response.output_text.delta': {
              if (typeof data.delta === 'string' && data.delta) {
                callback({ type: 'text_delta', data: data.delta })
              }
              break
            }

            case 'response.reasoning_summary_text.delta':
            case 'response.reasoning_text.delta': {
              if (typeof data.delta === 'string' && data.delta) {
                reasoningContent += data.delta
                callback({
                  type: 'reasoning_content_change',
                  data: reasoningContent,
                })
              }
              break
            }

            case 'response.output_item.added': {
              const item: ResponsesItem | undefined = data.item
              if (item?.type === 'function_call') {
                const key = item.id || data.output_index
                if (key !== undefined) {
                  toolCallItems.set(String(key), {
                    id: item.call_id || item.id || '',
                    name: item.name || '',
                    args: item.arguments || '',
                    fired: false,
                  })
                }
              }
              break
            }

            case 'response.function_call_arguments.delta': {
              const it = toolCallItems.get(String(data.item_id))
              if (it && typeof data.delta === 'string') {
                it.args += data.delta
              }
              break
            }

            case 'response.function_call_arguments.done': {
              const it = toolCallItems.get(String(data.item_id))
              if (it && typeof data.arguments === 'string') {
                it.args = data.arguments
              }
              break
            }

            case 'response.output_item.done': {
              const item: ResponsesItem | undefined = data.item
              if (item?.type === 'function_call') {
                const key = String(item.id ?? data.output_index)
                const it = toolCallItems.get(key)
                if (it) {
                  if (typeof item.arguments === 'string' && item.arguments) {
                    it.args = item.arguments
                  }
                  if (item.name) it.name = item.name
                  if (item.call_id) it.id = item.call_id
                } else if (item.id || data.output_index !== undefined) {
                  toolCallItems.set(key, {
                    id: item.call_id || item.id || '',
                    name: item.name || '',
                    args: item.arguments || '',
                    fired: false,
                  })
                }
                emitToolUse(key)
              }
              break
            }

            case 'response.completed':
            case 'response.incomplete': {
              const usage: ResponsesUsage | undefined = data.response?.usage
              if (usage) {
                lastUsage = {
                  promptTokens: usage.input_tokens ?? 0,
                  completionTokens: usage.output_tokens ?? 0,
                  totalTokens:
                    usage.total_tokens ??
                    (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
                }
              }
              // 兜底触发尚未发出的 function_call
              finish()
              break
            }

            case 'response.failed':
            case 'response.error':
            case 'error': {
              callback({
                type: 'error',
                error:
                  data.response?.error?.message ||
                  data.error?.message ||
                  data.message ||
                  'Responses API error',
              })
              break
            }

            default:
              break
          }
        },
        signal,
        request.traceId,
      )
    } catch (e: any) {
      if (e?.name !== 'AbortError') {
        callback({ type: 'error', error: e.message })
      }
    }
  }

  buildRequest(request: ChatRequest): any {
    const input: any[] = []

    const lastSummaryMessageIndex = getLastSummaryMessageIndex(request.messages)
    const requestMessages =
      lastSummaryMessageIndex == -1
        ? request.messages
        : request.messages.slice(lastSummaryMessageIndex)

    for (const msg of requestMessages) {
      // summary / feedback 角色：转为 user 消息
      if (msg.role === 'summary' || msg.role === 'feedback') {
        input.push({
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
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
        const text = typeof msg.content === 'string' ? msg.content : ''
        // 助手正文（Responses 的 message content 不允许为空，故仅在非空时输出）
        if (text) {
          input.push({
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text }],
          })
        }
        // 助手发起的函数调用 → 顶层 function_call item
        if (msg.toolCalls?.length) {
          for (const tc of msg.toolCalls) {
            input.push({
              type: 'function_call',
              call_id: tc.id,
              name: tc.name,
              arguments: JSON.stringify(tc.input ?? {}),
            })
          }
        }
        continue
      }

      if (msg.role === 'tool') {
        // 工具结果 → function_call_output item
        input.push({
          type: 'function_call_output',
          call_id: msg.toolCallId || '',
          output:
            typeof msg.content === 'string'
              ? msg.content
              : JSON.stringify(msg.content),
        })
        continue
      }

      // user 消息
      const contentParts: ResponsesContentPart[] = []
      if (typeof msg.content === 'string') {
        contentParts.push({ type: 'input_text', text: msg.content })
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'text') {
            contentParts.push({ type: 'input_text', text: block.text })
          } else if (block.type === 'image_url') {
            contentParts.push({
              type: 'input_image',
              image_url: block.image_url.url,
            })
          }
        }
      }

      // 视觉分析优化：替换 image_url 为分析文本
      const visionBlocks = processVisionContent(msg)
      if (visionBlocks) {
        const mapped: ResponsesContentPart[] = visionBlocks.map((b) =>
          b.type === 'image_url'
            ? { type: 'input_image', image_url: b.image_url.url }
            : { type: 'input_text', text: b.text },
        )
        input.push({ type: 'message', role: 'user', content: mapped })
      } else {
        input.push({ type: 'message', role: 'user', content: contentParts })
      }
    }

    const body: any = {
      model: request.model,
      input,
      stream: request.stream,
      // 不依赖服务端存储，消息历史由客户端维护
      store: false,
    }

    if (request.systemPrompt) {
      body.instructions = request.systemPrompt
    }
    if (request.temperature !== undefined) {
      body.temperature = request.temperature
    }
    if (request.topP !== undefined) {
      body.top_p = request.topP
    }
    if (request.maxTokens) {
      body.max_output_tokens = request.maxTokens
    }

    if (request.tools?.length) {
      body.tools = request.tools.map((t) => ({
        type: 'function',
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      }))
    }
    if (request.tool_choice) {
      body.tool_choice = request.tool_choice
    }

    // thinking 模式控制（Responses API 使用 reasoning.effort）
    // 官方合法取值：'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
    // （见 openai-node ReasoningEffort），'none' 用于显式禁用推理。
    if (request.thinking === false) {
      body.reasoning = { effort: 'none' }
    } else if (request.reasoningEffort) {
      body.reasoning = { effort: request.reasoningEffort }
    }

    return body
  }

  private parseResponse(data: any): Message {
    const message: Message = {
      id: data.id || v4(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
    }

    const textParts: string[] = []
    const toolCalls: ToolUseContent[] = []
    let reasoning = ''

    for (const item of (data.output || []) as ResponsesItem[]) {
      if (item.type === 'message') {
        for (const c of item.content || []) {
          if (c.type === 'output_text' && typeof c.text === 'string') {
            textParts.push(c.text)
          }
        }
      } else if (item.type === 'function_call') {
        let inputVal: Record<string, any> = {}
        try {
          inputVal = JSON.parse(item.arguments || '{}')
        } catch {
          inputVal = { _partial: item.arguments }
        }
        toolCalls.push({
          type: 'tool_use',
          id: item.call_id || item.id || '',
          name: item.name || '',
          input: inputVal,
        })
      } else if (item.type === 'reasoning') {
        for (const s of item.summary || []) {
          if (typeof s?.text === 'string') reasoning += s.text
        }
      }
    }

    message.content = textParts.join('')
    if (toolCalls.length > 0) {
      message.toolCalls = toolCalls
    }
    if (reasoning) {
      message.reasoningContent = reasoning
    }

    if (data.usage) {
      message.usage = {
        promptTokens: data.usage.input_tokens ?? 0,
        completionTokens: data.usage.output_tokens ?? 0,
        totalTokens:
          data.usage.total_tokens ??
          (data.usage.input_tokens ?? 0) + (data.usage.output_tokens ?? 0),
      }
    }

    return message
  }
}
