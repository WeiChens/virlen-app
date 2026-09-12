/**
 * Provider HTTP 工具 — 统一 fetch 调用、SSE 流解析
 *
 * 三个 provider (OpenAI/Anthropic/Gemini) 在 chat/chatStream 中
 * 大量重复的 fetch → 错误处理 → SSE 解析逻辑，统一封装至此。
 */
import { track, urlHost } from '@/utils/telemetry'

// ==================== 埋点辅助（§5.7 provider.*） ====================

/** 将 providerName 归一化为 provider_type */
function mapProviderType(name: string): string {
  const n = (name || '').toLowerCase()
  if (n.includes('anthropic') || n.includes('claude')) return 'anthropic'
  if (n.includes('gemini') || n.includes('google')) return 'gemini'
  if (n.includes('openai')) return 'openai'
  return n || 'unknown'
}

/** 根据 HTTP 状态码分类错误 */
function classifyHttpError(status: number): string {
  if (status === 401 || status === 403) return 'auth'
  if (status === 429) return 'rate_limit'
  if (status >= 500) return 'server'
  if (status >= 400) return 'network'
  return 'network'
}

/**
 * 从请求体解析 provider.request.start 需要的上下文（§5.7）。
 * 解析失败一律静默返回空对象，绝不影响请求。
 */
function parseRequestBody(body: string | undefined): {
  model_id?: string
  stream?: boolean
  has_tools?: boolean
  has_reasoning?: boolean
  msg_count?: number
} {
  if (!body || typeof body !== 'string') return {}
  try {
    const parsed = JSON.parse(body)
    if (!parsed || typeof parsed !== 'object') return {}
    const tools = Array.isArray(parsed.tools) ? parsed.tools : undefined
    return {
      model_id: typeof parsed.model === 'string' ? parsed.model : undefined,
      stream: typeof parsed.stream === 'boolean' ? parsed.stream : undefined,
      has_tools: !!(
        (tools && tools.length > 0) ||
        Array.isArray(parsed.functions) ||
        parsed.toolConfig ||
        parsed.tool_config
      ),
      has_reasoning: !!(
        parsed.reasoning_effort ||
        parsed.reasoning ||
        parsed.thinking ||
        parsed.enable_thinking ||
        parsed.thinkingConfig
      ),
      msg_count: Array.isArray(parsed.messages)
        ? parsed.messages.length
        : Array.isArray(parsed.contents)
          ? parsed.contents.length
          : undefined,
    }
  } catch {
    return {}
  }
}

// ==================== Fetch 工具 ====================

export interface ApiFetchOptions {
  url: string
  method?: string
  headers: Record<string, string>
  body?: string
  signal?: AbortSignal
  /** Provider 名称（用于错误消息） */
  providerName: string
  /** 链路 ID（可选，透传自 ChatRequest.traceId，用于 provider.* 埋点关联） */
  traceId?: string
}

/**
 * 统一 API fetch 调用，自动处理非 2xx 错误
 */
export async function apiFetch(options: ApiFetchOptions): Promise<Response> {
  const { url, method = 'POST', headers, body, signal, providerName, traceId } =
    options

  const providerType = mapProviderType(providerName)
  const host = urlHost(url)
  const start = Date.now()
  track('provider.request.start', {
    trace_id: traceId,
    provider_type: providerType,
    base_url_host: host,
    method,
    ...parseRequestBody(body),
  })

  try {
    const res = await fetch(url, {
      method,
      headers,
      body,
      signal,
    })

    if (!res.ok) {
      const err = await res.text().catch(() => '')
      const message = `API Error (${res.status}): ${err}`
      track('provider.request.error', {
        trace_id: traceId,
        provider_type: providerType,
        http_status: res.status,
        error: message.slice(0, 500),
        error_type: classifyHttpError(res.status),
        duration_ms: Date.now() - start,
      })
      // §5.9 error.api：Provider API 报错的规范化事件
      track('error.api', {
        trace_id: traceId,
        provider_type: providerType,
        http_status: res.status,
        message: message.slice(0, 500),
      })
      throw new Error(message)
    }

    track('provider.request.end', {
      trace_id: traceId,
      provider_type: providerType,
      http_status: res.status,
      duration_ms: Date.now() - start,
      status: 'success',
    })
    return res
  } catch (e: any) {
    // 用户取消（AbortError）不上报；非 2xx 已在上面上报过，不重复
    if (e?.name !== 'AbortError' && !/^API Error \(/.test(e?.message || '')) {
      track('provider.request.error', {
        trace_id: traceId,
        provider_type: providerType,
        base_url_host: host,
        error: e?.message || String(e),
        error_type: 'network',
        duration_ms: Date.now() - start,
      })
    }
    throw e
  }
}

// ==================== SSE 流解析 ====================

export type SSELineHandler = (line: string) => void

/**
 * 逐 chunk 读取响应体，按行分割后回调处理。
 *
 * 返回一个 Promise，在流结束或 AbortError 时 resolve。
 */
export async function readStreamLines(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  onLine: SSELineHandler,
  signal?: AbortSignal,
  traceId?: string,
): Promise<void> {
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        onLine(line)
      }
    }
  } catch (e: any) {
    if (e?.name !== 'AbortError') {
      // §5.7 provider.sse.interrupt：流读取中途异常
      track('provider.sse.interrupt', {
        trace_id: traceId,
        error: e?.message || String(e),
        last_event_type: null,
        bytes_received: buffer.length,
      })
      throw e
    }
  }
}

/**
 * 解析 SSE 格式的 data: 行，提取 JSON 字符串。
 * 返回 null 表示这是一个 "[DONE]" 行或空 data 行。
 */
export function extractJsonData(
  line: string,
  traceId?: string,
): { json: any; isDone: boolean } | null {
  const trimmed = line.trim()
  if (!trimmed || !trimmed.startsWith('data:')) return null

  const dataStr = trimmed.slice(5).trim()
  if (dataStr === '[DONE]') return { json: null, isDone: true }

  try {
    return { json: JSON.parse(dataStr), isDone: false }
  } catch (e: any) {
    // §5.7 provider.sse.interrupt：SSE 分片解析失败（非 [DONE]）
    track('provider.sse.interrupt', {
      trace_id: traceId,
      error: e?.message || String(e),
      last_event_type: null,
      bytes_received: dataStr.length,
    })
    return null
  }
}

/**
 * 标准 OpenAI 风格流式 SSE 解析器。
 * 逐行读取，每当遇到完整的 event: / data: 格式时回调 onEvent。
 * 用于 Anthropic 的 event: + data: 双行格式。
 */
export interface SSESession {
  eventType: string
}

export function parseSSELine(
  line: string,
  session: SSESession,
): { eventType: string; dataStr: string } | null {
  const trimmed = line.trim()

  if (trimmed.startsWith('event:')) {
    session.eventType = trimmed.slice(6).trim()
    return null
  }

  if (trimmed.startsWith('data:')) {
    return { eventType: session.eventType, dataStr: trimmed.slice(5).trim() }
  }

  if (trimmed === '') {
    session.eventType = ''
  }

  return null
}

// ==================== 响应体读取 ====================

/**
 * 从 Response 获取 reader，如果为空则抛异常。
 */
export function getResponseReader(
  res: Response,
): ReadableStreamDefaultReader<Uint8Array> {
  const reader = res.body?.getReader()
  if (!reader) {
    throw new Error('Response body is empty')
  }
  return reader
}
