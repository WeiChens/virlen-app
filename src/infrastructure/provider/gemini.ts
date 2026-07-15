/**
 * Gemini Provider — 使用 Google AI API 格式
 *
 * 与 OpenAI 不同：
 * - API 端点是 genai API（google-generativeai SDK / 原生 REST）
 * - messages 使用 contents[] 结构：[{role, parts:[{text, ...}, {functionCall, ...}]}]
 * - tool 调用使用 functionCall / functionResponse 嵌入 parts
 * - 流式使用 Server-Sent Events (SSE)
 * - API 密钥通过查询参数 ?key=xxx 传递
 *
 * API 端点：https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
 * 流式：https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent
 */
import type { Message, StreamCallback, ToolUseContent } from '@/types'
import type { ChatRequest, IProvider } from './types'
import {
  apiFetch,
  getResponseReader,
  readStreamLines,
  extractJsonData,
} from './http-utils'
import { processVisionContent } from './visionInject'

interface GeminiContent {
  role: string
  parts: GeminiPart[]
}

interface GeminiPart {
  text?: string
  inlineData?: { mimeType: string; data: string }
  functionCall?: { name: string; args: Record<string, any> }
  functionResponse?: { name: string; response: { name: string; content: any } }
}

interface GeminiCandidate {
  content: GeminiContent
  finishReason?: string
}

interface GeminiResponse {
  candidates: GeminiCandidate[]
  usageMetadata?: {
    promptTokenCount: number
    candidatesTokenCount: number
    totalTokenCount: number
  }
}

export class GeminiProvider implements IProvider {
  readonly name: string
  private apiKey: string
  private baseUrl: string

  private get headers() {
    return { 'Content-Type': 'application/json' }
  }

  constructor(name: string, apiKey: string, baseUrl?: string) {
    this.name = name
    this.apiKey = apiKey
    this.baseUrl = (
      baseUrl || 'https://generativelanguage.googleapis.com/v1beta'
    ).replace(/\/+$/, '')
  }
  validateApiKey(): Promise<boolean> {
    throw new Error('Method not implemented.')
  }

  async listModels(): Promise<string[]> {
    try {
      const res = await fetch(`${this.baseUrl}/models?key=${this.apiKey}`, {
        headers: { 'Content-Type': 'application/json' },
      })
      if (!res.ok) return []
      const data = await res.json()
      return (data.models || [])
        .filter((m: any) =>
          m.supportedGenerationMethods?.includes('generateContent'),
        )
        .map((m: any) => m.name.replace('models/', ''))
    } catch {
      return []
    }
  }

  private getEndpoint(model: string): string {
    return `${this.baseUrl}/models/${model}:generateContent?key=${this.apiKey}`
  }

  private getStreamEndpoint(model: string): string {
    return `${this.baseUrl}/models/${model}:streamGenerateContent?alt=sse&key=${this.apiKey}`
  }

  async chat(request: ChatRequest, signal?: AbortSignal): Promise<Message> {
    const body = this.buildRequest(request)

    const res = await apiFetch({
      url: this.getEndpoint(request.model),
      headers: this.headers,
      body: JSON.stringify(body),
      signal,
      providerName: 'Gemini',
    })

    const data: GeminiResponse = await res.json()
    return this.parseResponse(data)
  }

  async chatStream(
    request: ChatRequest,
    callback: StreamCallback,
    signal?: AbortSignal,
  ): Promise<void> {
    const body = this.buildRequest(request)

    let res: Response
    try {
      res = await apiFetch({
        url: this.getStreamEndpoint(request.model),
        headers: this.headers,
        body: JSON.stringify(body),
        signal,
        providerName: 'Gemini',
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
    const toolCallsAccumulator: ToolUseContent[] = []
    let toolCallFinished = false
    let lastUsage:
      | { promptTokens: number; completionTokens: number; totalTokens: number }
      | undefined

    try {
      await readStreamLines(
        reader,
        decoder,
        (line) => {
          const parsed = extractJsonData(line)
          if (!parsed || parsed.isDone) return

          const chunk = parsed.json

          // 记录 usage（最后一两个 chunk 会携带 usageMetadata）
          if (chunk.usageMetadata) {
            lastUsage = {
              promptTokens: chunk.usageMetadata.promptTokenCount ?? 0,
              completionTokens: chunk.usageMetadata.candidatesTokenCount ?? 0,
              totalTokens: chunk.usageMetadata.totalTokenCount ?? 0,
            }
          }

          const candidate = chunk.candidates?.[0]
          if (!candidate) return

          const part = candidate.content?.parts?.[0]
          if (!part) return

          if (part.text !== undefined) {
            callback({ type: 'text_delta', data: part.text })
          }

          if (part.functionCall && !toolCallFinished) {
            toolCallFinished = true
            const toolUse: ToolUseContent = {
              type: 'tool_use',
              id: `fc_${part.functionCall.name}_${Date.now()}`,
              name: part.functionCall.name,
              input: part.functionCall.args || {},
            }
            toolCallsAccumulator.push(toolUse)
            callback({ type: 'tool_use', toolUse })
          }
        },
        signal,
      )
    } catch (e: any) {
      if (e?.name !== 'AbortError') {
        callback({ type: 'error', error: e.message })
      }
    }

    callback({ type: 'message_stop', usage: lastUsage })
  }

  buildRequest(request: ChatRequest): any {
    const contents: GeminiContent[] = []

    for (const msg of request.messages) {
      // summary 角色：转为 user 消息，作为压缩后的历史上下文
      if (msg.role === 'summary') {
        contents.push({
          role: 'user',
          parts: [
            {
              text:
                typeof msg.content === 'string'
                  ? `[以下是对之前对话历史的摘要]\n${msg.content}`
                  : '[以下是对之前对话历史的摘要]\n' +
                    JSON.stringify(msg.content),
            },
          ],
        })
        continue
      }

      const parts: GeminiPart[] = []

      if (typeof msg.content === 'string' && msg.content) {
        parts.push({ text: msg.content })
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'text' && block.text) {
            parts.push({ text: block.text })
          } else if (block.type === 'image_url') {
            const url = block.image_url.url
            if (url.startsWith('data:')) {
              const match = url.match(/^data:(image\/\w+);base64,(.+)$/)
              if (match) {
                parts.push({
                  inlineData: { mimeType: match[1], data: match[2] },
                })
              }
            } else {
              // URL — try fetching it
              parts.push({ text: `[Image: ${url}]` })
            }
          }
        }
      }

      // 视觉分析优化：替换 image_url 为分析文本
      const visionBlocks = processVisionContent(msg)
      if (visionBlocks) {
        // 清空 parts，用 vision 处理后的 blocks 重建
        parts.length = 0
        for (const block of visionBlocks) {
          if (block.type === 'text') {
            parts.push({ text: block.text })
          }
        }
      }

      if (msg.toolCalls?.length) {
        for (const tc of msg.toolCalls) {
          parts.push({
            functionCall: { name: tc.name, args: tc.input },
          })
        }
      }

      if (msg.role === 'tool' && msg.toolCallId) {
        // Gemini: functionResponse format
        const fnCall = msg.content
          ? {
              functionResponse: {
                name:
                  msg.toolCallId.replace(/^fc_/, '').split('_')[0] || 'unknown',
                response: {
                  name: '',
                  content:
                    typeof msg.content === 'string' ? msg.content : msg.content,
                },
              },
            }
          : { text: typeof msg.content === 'string' ? msg.content : '' }
        parts.push(fnCall as GeminiPart)
      }

      if (parts.length === 0) continue

      // Gemini uses 'model' instead of 'assistant'
      const geminiRole =
        msg.role === 'assistant'
          ? 'model'
          : msg.role === 'tool'
            ? 'function'
            : 'user'

      contents.push({ role: geminiRole, parts })
    }

    const body: any = { contents }

    // System instruction (top-level)
    if (request.systemPrompt) {
      body.system_instruction = {
        parts: [{ text: request.systemPrompt }],
      }
    }

    if (request.temperature !== undefined) {
      body.generationConfig = body.generationConfig || {}
      body.generationConfig.temperature = request.temperature
    }

    if (request.maxTokens !== undefined) {
      body.generationConfig = body.generationConfig || {}
      body.generationConfig.maxOutputTokens = request.maxTokens
    }

    if (request.tools?.length) {
      body.tools = request.tools.map((t) => ({
        functionDeclarations: [
          {
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          },
        ],
      }))
    }
    if (request.tool_choice) {
      body.tool_choice = request.tool_choice
    }

    return body
  }

  private parseResponse(data: GeminiResponse): Message {
    const message: Message = {
      id: `gemini_${Date.now()}`,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
    }

    const candidate = data.candidates?.[0]
    if (!candidate) return message

    const parts = candidate.content?.parts || []
    const textParts: string[] = []
    const toolCalls: ToolUseContent[] = []

    for (const part of parts) {
      if (part.text !== undefined) {
        textParts.push(part.text)
      }
      if (part.functionCall) {
        toolCalls.push({
          type: 'tool_use',
          id: `fc_${part.functionCall.name}_${Date.now()}`,
          name: part.functionCall.name,
          input: part.functionCall.args || {},
        })
      }
    }

    message.content = textParts.join('')
    if (toolCalls.length > 0) {
      message.toolCalls = toolCalls
    }

    if (data.usageMetadata) {
      message.usage = {
        promptTokens: data.usageMetadata.promptTokenCount,
        completionTokens: data.usageMetadata.candidatesTokenCount,
        totalTokens: data.usageMetadata.totalTokenCount,
      }
    }

    return message
  }
}
