/**
 * Gemini Provider — 使用 Google Gemini 原生 API 格式 (generateContent / streamGenerateContent)
 *
 * 与 OpenAI 不同：
 * - 端点：POST {baseUrl}/models/{model}:generateContent?key=xxx
 *         流式：.../{model}:streamGenerateContent?alt=sse&key=xxx
 * - messages 使用 contents[]：[{ role: 'user'|'model', parts: [...] }]
 * - system 提示为顶层 systemInstruction
 * - tool 调用：模型返回 parts[].functionCall；回传结果用 parts[].functionResponse，
 *   且必须以 role: 'user' 的消息返回（Gemini 的 role 仅允许 user / model）
 * - 工具声明：tools: [{ functionDeclarations: [{ name, description, parameters }] }]
 * - 工具选择：toolConfig.functionCallingConfig.mode（AUTO / NONE / ANY）
 * - 思考：generationConfig.thinkingConfig.thinkingBudget；思考内容为 part.thought === true
 * - API 密钥通过查询参数 ?key= 传递
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

/** Gemini 单次输出上限的保守上界；超过则不发送 maxOutputTokens，交由服务端使用默认值 */
const GEMINI_MAX_OUTPUT_TOKENS = 65536

interface GeminiPart {
  text?: string
  /** 该 text 是否为思考内容（thinking） */
  thought?: boolean
  /** Gemini 2.5 思考模型：函数调用附带的 thoughtSignature，回传历史时必须原样携带 */
  thoughtSignature?: string
  inlineData?: { mimeType: string; data: string }
  functionCall?: { id?: string; name: string; args?: Record<string, any> }
  functionResponse?: {
    id?: string
    name: string
    response: Record<string, any>
  }
}

interface GeminiContent {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

interface GeminiCandidate {
  content?: GeminiContent
  finishReason?: string
}

interface GeminiUsageMetadata {
  promptTokenCount?: number
  candidatesTokenCount?: number
  totalTokenCount?: number
  thoughtsTokenCount?: number
}

interface GeminiResponse {
  responseId?: string
  candidates?: GeminiCandidate[]
  usageMetadata?: GeminiUsageMetadata
  promptFeedback?: { blockReason?: string }
  error?: { message?: string; status?: string }
}

/** 由合成的 toolCallId（fc_{name}_{uuid}）反推函数名，作为兜底 */
function nameFromSyntheticId(id: string): string {
  return id.replace(/^fc_/, '').replace(/_[0-9a-fA-F-]{8,}$/, '') || 'unknown'
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

  async validateApiKey(config: ProviderConfig): Promise<boolean> {
    if (config.models.length === 0) {
      throw new Error('请先为该 Provider 配置至少一个模型')
    }
    const baseUrl = config.baseUrl.replace(/\/+$/, '')
    try {
      const res = await fetch(
        `${baseUrl}/models/${encodeURIComponent(
          config.models[0],
        )}:generateContent?key=${config.apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
            generationConfig: { maxOutputTokens: 1 },
          }),
        },
      )
      if (!res.ok) {
        throw new Error(await res.text().catch(() => res.statusText))
      }
      return true
    } catch (e) {
      console.error(e)
      return false
    }
  }

  async listModels(): Promise<string[]> {
    const res = await apiFetch({
      url: `${this.baseUrl}/models?key=${this.apiKey}`,
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      providerName: 'Gemini',
    })
    const data = await res.json()
    return (data.models || [])
      .filter((m: any) =>
        m.supportedGenerationMethods?.includes('generateContent'),
      )
      .map((m: any) => String(m.name || '').replace(/^models\//, ''))
      .filter(Boolean)
  }

  private getEndpoint(model: string): string {
    return `${this.baseUrl}/models/${encodeURIComponent(
      model,
    )}:generateContent?key=${this.apiKey}`
  }

  private getStreamEndpoint(model: string): string {
    return `${this.baseUrl}/models/${encodeURIComponent(
      model,
    )}:streamGenerateContent?alt=sse&key=${this.apiKey}`
  }

  async chat(request: ChatRequest, signal?: AbortSignal): Promise<Message> {
    const body = this.buildRequest(request)

    const res = await apiFetch({
      url: this.getEndpoint(request.model),
      headers: this.headers,
      body: JSON.stringify(body),
      signal,
      providerName: 'Gemini',
      traceId: request.traceId,
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
    const firedToolUses: Set<string> = new Set()
    let reasoningContent = ''
    let lastUsage:
      | { promptTokens: number; completionTokens: number; totalTokens: number }
      | undefined

    try {
      await readStreamLines(
        reader,
        decoder,
        (line) => {
          const parsed = extractJsonData(line, request.traceId)
          if (!parsed || parsed.isDone) return

          const chunk: GeminiResponse = parsed.json

          if (chunk.error) {
            callback({
              type: 'error',
              error: chunk.error.message || 'Gemini API error',
            })
            return
          }

          // usage 出现在末尾若干 chunk（含思考 token）
          if (chunk.usageMetadata) {
            const u = chunk.usageMetadata
            lastUsage = {
              promptTokens: u.promptTokenCount ?? 0,
              completionTokens: u.candidatesTokenCount ?? 0,
              totalTokens:
                u.totalTokenCount ??
                (u.promptTokenCount ?? 0) + (u.candidatesTokenCount ?? 0),
            }
          }

          const parts = chunk.candidates?.[0]?.content?.parts || []
          for (const part of parts) {
            if (part.functionCall) {
              const fc = part.functionCall
              const id = fc.id || `fc_${fc.name}_${v4()}`
              if (firedToolUses.has(id)) continue
              firedToolUses.add(id)
              const toolUse: ToolUseContent = {
                type: 'tool_use',
                id,
                name: fc.name,
                input: fc.args || {},
              }
              // Gemini 2.5：透传 thoughtSignature
              if (part.thoughtSignature) {
                toolUse.thoughtSignature = part.thoughtSignature
              }
              callback({ type: 'tool_use', toolUse })
            } else if (part.text !== undefined && part.text !== '') {
              if (part.thought) {
                reasoningContent += part.text
                callback({
                  type: 'reasoning_content_change',
                  data: reasoningContent,
                })
              } else {
                callback({ type: 'text_delta', data: part.text })
              }
            }
          }
        },
        signal,
        request.traceId,
      )
    } catch (e: any) {
      if (e?.name !== 'AbortError') {
        callback({ type: 'error', error: e.message })
      }
      return
    }

    callback({
      type: 'message_stop',
      reasoningContent: reasoningContent || undefined,
      usage: lastUsage,
    })
  }

  buildRequest(request: ChatRequest): any {
    const contents: GeminiContent[] = []

    const lastSummaryMessageIndex = getLastSummaryMessageIndex(request.messages)
    const requestMessages =
      lastSummaryMessageIndex == -1
        ? request.messages
        : request.messages.slice(lastSummaryMessageIndex)

    // toolCallId → 函数名 映射，用于 functionResponse.name（避免从 id 解析出错）
    const callIdToName = new Map<string, string>()
    for (const m of requestMessages) {
      if (m.role === 'assistant' && m.toolCalls?.length) {
        for (const tc of m.toolCalls) callIdToName.set(tc.id, tc.name)
      }
    }

    for (const msg of requestMessages) {
      // summary / feedback 角色：转为 user 消息
      if (msg.role === 'summary' || msg.role === 'feedback') {
        contents.push({
          role: 'user',
          parts: [
            {
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
        const parts: GeminiPart[] = []
        const text = typeof msg.content === 'string' ? msg.content : ''
        // 空 text part 会触发 "empty text parameter" 报错，故仅在非空时添加
        if (text) parts.push({ text })
        if (msg.toolCalls?.length) {
          for (const tc of msg.toolCalls) {
            const functionCall: GeminiPart['functionCall'] = {
              name: tc.name,
              args: tc.input || {},
            }
            // 仅回传 Gemini 原生 functionCall.id（合成 id 不回收）
            if (tc.id && !tc.id.startsWith('fc_')) functionCall.id = tc.id
            const part: GeminiPart = { functionCall }
            // Gemini 2.5 思考模型：回传函数调用的 thoughtSignature
            if (tc.thoughtSignature) part.thoughtSignature = tc.thoughtSignature
            parts.push(part)
          }
        }
        if (parts.length > 0) contents.push({ role: 'model', parts })
        continue
      }

      if (msg.role === 'tool') {
        const name =
          callIdToName.get(msg.toolCallId || '') ||
          nameFromSyntheticId(msg.toolCallId || '')
        const output =
          typeof msg.content === 'string'
            ? msg.content
            : JSON.stringify(msg.content)
        const functionResponse: GeminiPart['functionResponse'] = {
          name,
          response: { name, content: output },
        }
        if (msg.toolCallId && !msg.toolCallId.startsWith('fc_')) {
          functionResponse.id = msg.toolCallId
        }
        const fr: GeminiPart = { functionResponse }
        // 连续的多个工具结果合并到同一条 user content
        const last = contents[contents.length - 1]
        if (
          last &&
          last.role === 'user' &&
          last.parts[last.parts.length - 1]?.functionResponse
        ) {
          last.parts.push(fr)
        } else {
          contents.push({ role: 'user', parts: [fr] })
        }
        continue
      }

      // user 消息
      const parts: GeminiPart[] = []
      if (typeof msg.content === 'string' && msg.content) {
        parts.push({ text: msg.content })
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'text' && block.text) {
            parts.push({ text: block.text })
          } else if (block.type === 'image_url') {
            const url = block.image_url.url
            const match = url.match(/^data:([^;]+);base64,(.+)$/)
            if (match) {
              parts.push({ inlineData: { mimeType: match[1], data: match[2] } })
            } else {
              // 非 data URL：Gemini 需可访问的 Files API / GCS fileUri，无法直接传 http(s) URL，
              // 降级为文本占位，避免整请求 400
              parts.push({ text: `[图片: ${url}]` })
            }
          }
        }
      }

      // 视觉分析优化：替换 image_url 为分析文本
      const visionBlocks = processVisionContent(msg)
      if (visionBlocks) {
        parts.length = 0
        for (const block of visionBlocks) {
          if (block.type === 'text') parts.push({ text: block.text })
        }
      }

      if (parts.length > 0) contents.push({ role: 'user', parts })
    }

    const body: any = { contents }

    // System instruction（顶层）
    if (request.systemPrompt) {
      body.systemInstruction = { parts: [{ text: request.systemPrompt }] }
    }

    const generationConfig: any = {}
    if (request.temperature !== undefined) {
      generationConfig.temperature = request.temperature
    }
    if (request.topP !== undefined) {
      generationConfig.topP = request.topP
    }
    // 过大的 maxOutputTokens 会被 Gemini 拒绝，超过上界时交由服务端默认
    if (request.maxTokens && request.maxTokens <= GEMINI_MAX_OUTPUT_TOKENS) {
      generationConfig.maxOutputTokens = request.maxTokens
    }

    if (request.tools?.length) {
      body.tools = [
        {
          functionDeclarations: request.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          })),
        },
      ]
      // tool_choice → toolConfig.functionCallingConfig.mode
      body.toolConfig = {
        functionCallingConfig: {
          mode: request.tool_choice === 'none' ? 'NONE' : 'AUTO',
        },
      }
    }

    // thinking 模式控制：thinkingBudget=0 禁用思考
    if (request.thinking === false) {
      generationConfig.thinkingConfig = { thinkingBudget: 0 }
    }

    if (Object.keys(generationConfig).length > 0) {
      body.generationConfig = generationConfig
    }

    return body
  }

  private parseResponse(data: GeminiResponse): Message {
    const message: Message = {
      id: data.responseId || `gemini_${Date.now()}`,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
    }

    const candidate = data.candidates?.[0]
    if (!candidate) {
      if (data.promptFeedback?.blockReason) {
        message.content = `[内容被拦截: ${data.promptFeedback.blockReason}]`
      }
      return message
    }

    const parts = candidate.content?.parts || []
    const textParts: string[] = []
    const toolCalls: ToolUseContent[] = []
    let reasoning = ''

    for (const part of parts) {
      if (part.functionCall) {
        const toolUse: ToolUseContent = {
          type: 'tool_use',
          id: part.functionCall.id || `fc_${part.functionCall.name}_${v4()}`,
          name: part.functionCall.name,
          input: part.functionCall.args || {},
        }
        // Gemini 2.5：透传 thoughtSignature
        if (part.thoughtSignature) {
          toolUse.thoughtSignature = part.thoughtSignature
        }
        toolCalls.push(toolUse)
      } else if (part.text !== undefined) {
        if (part.thought) reasoning += part.text
        else textParts.push(part.text)
      }
    }

    message.content = textParts.join('')
    if (toolCalls.length > 0) message.toolCalls = toolCalls
    if (reasoning) message.reasoningContent = reasoning

    if (data.usageMetadata) {
      const u = data.usageMetadata
      message.usage = {
        promptTokens: u.promptTokenCount ?? 0,
        completionTokens: u.candidatesTokenCount ?? 0,
        totalTokens:
          u.totalTokenCount ??
          (u.promptTokenCount ?? 0) + (u.candidatesTokenCount ?? 0),
      }
    }

    return message
  }
}
