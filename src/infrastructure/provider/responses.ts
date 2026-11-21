/**
 * OpenAI **Responses API** Provider —— `POST {baseUrl}/responses`。
 *
 * 与「OpenAI 兼容」（Chat Completions）是**两个协议**，不是同一个端点换名字：系统提示走顶层
 * `instructions`、历史是 `input[]` 的 item 列表（`message` / `function_call` /
 * `function_call_output`）、工具定义平铺、推理走 `reasoning.effort`、用量字段是
 * `input_tokens` / `output_tokens`、流式是命名事件（`response.output_text.delta` 等）。
 *
 * ⚠️ 引擎恒为 Rust：对话正文由 `virlen-core/src/agent/provider/responses.rs` 发请求（与 CLI 共用），
 * 本文件的存在是为了两件在 TS 侧的事：配置向导的 `listModels` / `validateApiKey`，以及
 * 引擎把未知协议桥接回 JS 时的兜底路径。两边的请求体 / 事件解析必须逐项对齐（铁律 1）。
 */
import type { Message, ProviderConfig, StreamCallback, TokenUsage } from '@/types'
import type { ChatRequest, IProvider } from './types'
import {
  apiFetch,
  getResponseReader,
  readStreamLines,
  extractJsonData,
} from './http-utils'
import { v4 } from '@/utils/uuid'
import {
  fileBlockToText,
  quoteBlockToText,
  skillBlockToText,
  getLastSummaryMessageIndex,
  VISION_IMAGE_ROLE,
} from '@/types'
import type { MessageContent } from '@/types'
import { processVisionContent } from './visionInject'

/** Responses 的 `input` 内容块（只有两种：文本 / 图片） */
type ResponsesPart = { type: 'input_text'; text: string } | {
  type: 'input_image'
  image_url: string
}

/**
 * content 块 → Responses 的 `input` 内容块。
 *
 * 与 `openai.ts::toOpenAiBlocks` 同一套降级（文件只带路径、引用带发送方 + id + 正文、技能带
 * SKILL.md 全文），差别只在类型名：`text` → `input_text`、`image_url` → `input_image`
 *（且 `image_url` 是**字符串**，不是 `{url}` 对象）。未知块一律丢弃 —— Responses 的 `input`
 * 只接受白名单类型，透传一个它不认的 `type` 会让整个请求 400。
 */
function toResponsesParts(blocks: Exclude<MessageContent, string>): ResponsesPart[] {
  const out: ResponsesPart[] = []
  for (const block of blocks) {
    if (block.type === 'text') {
      out.push({ type: 'input_text', text: block.text })
    } else if (block.type === 'image_url') {
      out.push({ type: 'input_image', image_url: block.image_url.url })
    } else if (block.type === 'file') {
      out.push({ type: 'input_text', text: fileBlockToText(block) })
    } else if (block.type === 'quote') {
      out.push({ type: 'input_text', text: quoteBlockToText(block) })
    } else if (block.type === 'skill') {
      out.push({ type: 'input_text', text: skillBlockToText(block) })
    }
  }
  return out
}

/** 任意 content → parts（字符串正文包成 `input_text`） */
function contentToParts(content: MessageContent): ResponsesPart[] {
  if (typeof content === 'string') return [{ type: 'input_text', text: content }]
  // 形状兜底与 Rust `responses_user_content` 一致：只认 string / 数组，其余按文本发，
  // 否则这条消息会整条消失（或 `for…of` 直接抛 not iterable）
  if (Array.isArray(content)) return toResponsesParts(content)
  return [{ type: 'input_text', text: JSON.stringify(content) }]
}

/**
 * 从 Responses 的 usage 里取出**缓存命中**的输入量（`input_tokens_details.cached_tokens`）。
 *
 * 与 Chat Completions 同口径：命中量已算在 `input_tokens` 里，不单独取出来账本里的缓存
 * token 就永远是 0（口径拉平在 `domain/usage::ledgerTokensOf`）。
 */
function cachedTokensFromUsage(usage: any): number {
  const n = usage?.input_tokens_details?.cached_tokens ?? 0
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0
}

/** Responses 的 usage → `TokenUsage`（input/output 命名） */
function usageOf(usage: any): TokenUsage {
  const promptTokens = usage?.input_tokens ?? 0
  const completionTokens = usage?.output_tokens ?? 0
  return {
    promptTokens,
    completionTokens,
    totalTokens: usage?.total_tokens ?? promptTokens + completionTokens,
    cachedTokens: cachedTokensFromUsage(usage),
  }
}

/** 流式里累积的一条 function_call */
interface ToolAcc {
  /** `call_id`：回填历史时必须用它（与 tool 消息的 `toolCallId` 是同一个值） */
  id: string
  name: string
  args: string
  emitted: boolean
}

export class ResponsesProvider implements IProvider {
  readonly name: string
  /** 协议类型（供用量统计记账，见 IProvider.providerType） */
  readonly providerType = 'responses'
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
      const res = await fetch(`${config.baseUrl}/responses`, {
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
    // 模型列表与 Chat Completions 共用同一个端点
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
    let lastUsage: TokenUsage | undefined
    // key = item id（缺 id 时用 output_index），保持出现顺序
    const tools = new Map<string, ToolAcc>()
    let stopped = false

    const emitTool = (key: string) => {
      const acc = tools.get(key)
      if (!acc || acc.emitted) return
      acc.emitted = true
      // 参数不是合法 JSON（截断 / 服务端分片异常）→ `null`，与 Rust
      // `responses.rs::emit_tool` 完全一致（铁律 1）：两侧给工具执行器的输入必须相同，
      // 否则同一份历史在引擎路径和桥接路径下报错文案不一样
      let input: any = null
      try {
        input = JSON.parse(acc.args || '{}')
      } catch {
        input = null
      }
      callback({
        type: 'tool_use',
        toolUse: { type: 'tool_use', id: acc.id, name: acc.name, input },
      })
    }

    /** 结算一次：补发未发出的工具调用 + `message_stop`（`response.completed` 与 `[DONE]` 都会到） */
    const finish = () => {
      if (stopped) return
      stopped = true
      for (const key of tools.keys()) emitTool(key)
      callback({
        type: 'message_stop',
        reasoningContent: reasoningContent || undefined,
        usage: lastUsage,
      })
    }

    const itemKey = (item: any, chunk: any): string =>
      String(item?.id ?? `idx-${chunk?.output_index ?? 0}`)

    const register = (key: string, item: any) => {
      if (tools.has(key)) return
      tools.set(key, {
        id: item?.call_id || item?.id || '',
        name: item?.name || '',
        args: item?.arguments || '',
        emitted: false,
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

          const chunk = parsed.json
          // Responses 的流式事件是**命名事件**，`type` 就在 data 里
          const type: string = chunk?.type || ''

          switch (type) {
            case 'response.output_text.delta': {
              if (typeof chunk.delta === 'string' && chunk.delta) {
                callback({ type: 'text_delta', data: chunk.delta })
              }
              break
            }
            case 'response.reasoning_summary_text.delta':
            case 'response.reasoning_text.delta': {
              if (typeof chunk.delta === 'string' && chunk.delta) {
                reasoningContent += chunk.delta
                callback({ type: 'reasoning_content_change', data: reasoningContent })
              }
              break
            }
            case 'response.output_item.added': {
              const item = chunk.item
              if (item?.type === 'function_call') {
                register(itemKey(item, chunk), item)
              }
              break
            }
            case 'response.function_call_arguments.delta': {
              const acc = tools.get(String(chunk.item_id ?? ''))
              if (acc && typeof chunk.delta === 'string') acc.args += chunk.delta
              break
            }
            case 'response.function_call_arguments.done': {
              const acc = tools.get(String(chunk.item_id ?? ''))
              if (acc && typeof chunk.arguments === 'string') {
                acc.args = chunk.arguments
              }
              break
            }
            case 'response.output_item.done': {
              const item = chunk.item
              if (item?.type === 'function_call') {
                const key = itemKey(item, chunk)
                // item.done 可能先于 added 到达（快模型 / 兜底实现）→ 现场登记
                register(key, item)
                const acc = tools.get(key)!
                if (typeof item.arguments === 'string' && item.arguments) {
                  acc.args = item.arguments
                }
                if (item.name) acc.name = item.name
                if (item.call_id) acc.id = item.call_id
                emitTool(key)
              }
              break
            }
            case 'response.completed':
            case 'response.incomplete': {
              if (chunk.response?.usage) {
                lastUsage = usageOf(chunk.response.usage)
              }
              finish()
              break
            }
            case 'response.failed':
            case 'response.error':
            case 'error': {
              callback({
                type: 'error',
                error:
                  chunk.response?.error?.message ||
                  chunk.error?.message ||
                  chunk.message ||
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

  /**
   * 构建 Responses 请求体。三个不能省的差别（与 `responses.rs::build_request` 必须逐项一致）：
   * - `store: false`：历史本机托管，不上传服务端留 30 天，也不用 `previous_response_id`；
   * - 助手正文用 `output_text`，助手工具调用是**顶层** `function_call` item；
   * - `reasoning.summary = 'auto'`：不带它服务端不产 reasoning summary，界面上的思考过程永远是空的。
   */
  buildRequest(request: ChatRequest): any {
    const input: any[] = []

    const lastSummaryMessageIndex = getLastSummaryMessageIndex(request.messages)
    const requestMessages =
      lastSummaryMessageIndex == -1
        ? request.messages
        : request.messages.slice(lastSummaryMessageIndex)

    for (const msg of requestMessages) {
      // 工具交付的图片（vision_image）：投影成一条 user 消息
      //（`function_call_output.output` 只能是字符串，放不下图片）
      if (msg.role === VISION_IMAGE_ROLE) {
        input.push({
          type: 'message',
          role: 'user',
          content: contentToParts(msg.content),
        })
        continue
      }

      // summary / feedback 角色：转成 user 消息
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
        // 只拼 text 块（与 Rust `Message::text_content` 同一口径）：`output_text` 只接受纯文本
        const text =
          typeof msg.content === 'string'
            ? msg.content
            : (msg.content as any[])
                .filter((b) => b?.type === 'text')
                .map((b) => b.text || '')
                .join(' ')
        // message 的 content 不允许为空数组 → 没正文就不发这条 item
        if (text) {
          input.push({
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text }],
          })
        }
        for (const tc of msg.toolCalls || []) {
          input.push({
            type: 'function_call',
            call_id: tc.id,
            name: tc.name,
            arguments: JSON.stringify(tc.input ?? {}),
          })
        }
        continue
      }

      if (msg.role === 'tool') {
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

      // user：本地图片伪视觉分析结果优先（纯文本模型不带原图）
      const vision = processVisionContent(msg)
      input.push({
        type: 'message',
        role: 'user',
        content: contentToParts(vision ?? msg.content),
      })
    }

    const body: any = {
      model: request.model,
      input,
      stream: request.stream,
      store: false,
    }

    if (request.systemPrompt) body.instructions = request.systemPrompt
    body.temperature = request.temperature
    body.top_p = request.topP
    if (request.maxTokens) body.max_output_tokens = request.maxTokens

    if (request.tools?.length) {
      // 工具定义是平铺的（没有 `function` 这层）
      body.tools = request.tools.map((t) => ({
        type: 'function',
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      }))
    }
    if (request.tool_choice) body.tool_choice = request.tool_choice

    // 思考控制：`thinking:false` 用 `effort:'none'` 显式禁用；指定档位时顺带要 summary
    if (request.thinking === false) {
      body.reasoning = { effort: 'none' }
    } else if (request.reasoningEffort) {
      body.reasoning = { effort: request.reasoningEffort, summary: 'auto' }
    }

    return body
  }

  /** 解析非流式响应：`output[]` = message / reasoning / function_call 三类 item */
  private parseResponse(data: any): Message {
    const message: Message = {
      // 不取 `data.id`：那是服务端的 `resp_xxx`，与 `openai.ts` / Rust `parse_response`
      // 一致恒造本地 uuid，否则桥接路径下库里会出现服务端 id
      id: v4(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
    }

    const textParts: string[] = []
    const toolCalls: any[] = []
    let reasoning = ''

    for (const item of data?.output || []) {
      if (item?.type === 'message') {
        for (const part of item.content || []) {
          if (part?.type === 'output_text' && typeof part.text === 'string') {
            textParts.push(part.text)
          }
        }
      } else if (item?.type === 'function_call') {
        let inputVal: any
        try {
          inputVal = JSON.parse(item.arguments || '{}')
        } catch {
          // 与 Rust `parse_response` 同口径：非法 JSON → `null`，交给工具执行器报错
          inputVal = null
        }
        toolCalls.push({
          type: 'tool_use',
          id: item.call_id || item.id || '',
          name: item.name || '',
          input: inputVal,
        })
      } else if (item?.type === 'reasoning') {
        for (const part of item.summary || []) {
          if (typeof part?.text === 'string') reasoning += part.text
        }
      }
    }

    message.content = textParts.join('')
    if (toolCalls.length > 0) message.toolCalls = toolCalls
    if (reasoning) message.reasoningContent = reasoning
    if (data?.usage) message.usage = usageOf(data.usage)

    return message
  }
}
