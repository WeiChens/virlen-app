/**
 * Provider HTTP 工具 — 统一 fetch 调用、SSE 流解析
 *
 * 三个 provider (OpenAI/Anthropic/Gemini) 在 chat/chatStream 中
 * 大量重复的 fetch → 错误处理 → SSE 解析逻辑，统一封装至此。
 */

// ==================== Fetch 工具 ====================

export interface ApiFetchOptions {
  url: string
  method?: string
  headers: Record<string, string>
  body?: string
  signal?: AbortSignal
  /** Provider 名称（用于错误消息） */
  providerName: string
}

/**
 * 统一 API fetch 调用，自动处理非 2xx 错误
 */
export async function apiFetch(options: ApiFetchOptions): Promise<Response> {
  const { url, method = 'POST', headers, body, signal, providerName } = options

  const res = await fetch(url, {
    method,
    headers,
    body,
    signal,
  })

  if (!res.ok) {
    const err = await res.text().catch(() => '')
    throw new Error(`API Error (${res.status}): ${err}`)
  }

  return res
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
): { json: any; isDone: boolean } | null {
  const trimmed = line.trim()
  if (!trimmed || !trimmed.startsWith('data:')) return null

  const dataStr = trimmed.slice(5).trim()
  if (dataStr === '[DONE]') return { json: null, isDone: true }

  try {
    return { json: JSON.parse(dataStr), isDone: false }
  } catch {
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
