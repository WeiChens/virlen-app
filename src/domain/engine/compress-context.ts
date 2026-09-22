/**
 * 上下文压缩 — 用 LLM 摘要替换早期对话历史
 *
 * 从 AgentEngine.compressContext() 提取为独立纯函数，不依赖 class this。
 */
import { v4 } from '@/utils/uuid'
import type { Message, Session, TokenUsage } from '@/types'
import { ChatRequest } from '@/infrastructure/provider/types'
import { providerPort } from '../provider'
import { toolRegistry } from '../tools'
import { AI_AGEMT_COMPRESS_CONTEXT_PROMPT } from '../agent'
import { invoke } from '@tauri-apps/api/core'
import { ledgerTokensOf, recordUsage } from '../usage'

/**
 * 估算 token 数 — 优先用 Rust 端 DeepSeek V3 tokenizer 精确计数，
 * 不可用（非 Tauri 环境）时回退到字符数 / 4 的粗略估算。
 */
async function estimateTokens(...texts: string[]): Promise<number> {
  const combined = texts.join('')
  if (!combined) return 0
  const fallback = () => Math.ceil(combined.length / 4)
  try {
    const n = await invoke<number>('cmd_count_tokens', { text: combined })
    // 非 Tauri 环境（vitest）invoke 可能 resolve undefined，需校验
    if (typeof n === 'number' && Number.isFinite(n) && n >= 0) return n
    return fallback()
  } catch {
    return fallback()
  }
}

/**
 * 兜底估算「本次请求」的 prompt token — 仅在 API 不返回 usage 时使用。
 *
 * ⚠️ 必须把**发出去的全部内容**计入：历史消息 + 压缩指令 + systemPrompt + 工具 schema。
 * 早期版本只算了首条消息 + systemPrompt，漏掉中间消息与 27 个工具的 schema → 系统性低估。
 */
async function estimateRequestTokens(request: ChatRequest): Promise<number> {
  const texts: string[] = [request.systemPrompt || '']
  for (const msg of request.messages || []) {
    if (typeof msg.content === 'string') {
      texts.push(msg.content)
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block && typeof block === 'object' && 'text' in block) {
          const t = (block as { text?: unknown }).text
          if (typeof t === 'string') texts.push(t)
        }
      }
    }
  }
  // 工具 schema 是随请求一起发给模型的内容，实打实占 prompt token
  if (request.tools?.length) {
    texts.push(JSON.stringify(request.tools))
  }
  return estimateTokens(...texts)
}

/**
 * 压缩会话上下文 — 用 LLM 摘要替换早期对话历史
 *
 * 流程：
 * 1. 保留最近的 N 轮对话（默认 3 轮）
 * 2. 将更早的对话发送给 LLM 生成摘要
 * 3. 用 summary 消息替换被压缩的消息
 */
export async function compressContext(
  session: Session,
  allMessages: Message[]
): Promise<{ summary?: string; messages: Message[] }> {
  // 找到最后一个 summary 消息的索引
  let idx = -1
  for (let i = allMessages.length - 1; i >= 0; i--) {
    if (allMessages[i].role === 'summary') {
      idx = i
      break
    }
  }
  const compressMessages = idx === -1 ? allMessages : allMessages.slice(idx)

  if (compressMessages.length <= 1) {
    throw new Error('没有可压缩的消息')
  }

  const providerId = session.providerConfigId
  const model = session.modelId
  if (!model || !providerId) {
    throw new Error('会话未配置模型或 Provider')
  }

  const provider = await providerPort.get(providerId)
  if (!provider) {
    throw new Error(`Provider "${providerId}" 未注册`)
  }

  const summaryPrompt = AI_AGEMT_COMPRESS_CONTEXT_PROMPT

  const allToolDefs = await toolRegistry.listDefinitions()
  const toolDefs =
    session.allowedTools === undefined
      ? allToolDefs
      : session.allowedTools.length > 0
      ? allToolDefs.filter((t) => session.allowedTools!.includes(t.name))
      : undefined

  const request: ChatRequest = {
    model,
    messages: [
      ...compressMessages,
      {
        role: 'user',
        content: summaryPrompt,
        id: v4(),
        timestamp: Date.now(),
      },
    ],
    systemPrompt: session.systemPrompt,
    tools: toolDefs,
    temperature: session.params.temperature,
    topP: session.params.topP,
    maxTokens: undefined,
    stream: false,
    tool_choice: 'none',
  }

  let summaryContent: string
  let usage: TokenUsage

  try {
    const startedAt = Date.now()
    const response = await provider.chat(request)
    // 压缩调用耗时（含首字延迟）：UI 用它算 tok/s。
    // ⚠️ 下面的 tokenizer 估算耗时**不计入**（那不是模型生成时间）
    const durationMs = Date.now() - startedAt
    summaryContent =
      typeof response.content === 'string'
        ? response.content
        : JSON.stringify(response.content)

    // 用量优先取 API 返回的**真实值**：压缩请求走非流式（stream:false），
    // 三种协议的响应都带 usage（openai / anthropic 见各自 parseResponse，gemini 见 usageMetadata）。
    // 只有极少数兼容实现不返回 usage 时才退到本地 tokenizer —— 那时才标 estimated。
    let estimated = false
    if (response.usage) {
      usage = response.usage
    } else {
      estimated = true
      const [promptTokens, completionTokens] = await Promise.all([
        estimateRequestTokens(request),
        estimateTokens(summaryContent),
      ])
      usage = {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      }
    }

    // 压缩上下文是真实 LLM 调用（会消耗 token）但不产生对话消息 → 单独记账。
    // ⚠️ estimated=true 仅出现在本地 tokenizer 兜底路径（无缓存概念，cached 恒为 0），UI 需与真实用量区分。
    recordUsage({
      ts: Date.now(),
      sessionId: session.id,
      model,
      providerType: provider.providerType,
      providerConfigId: providerId,
      kind: 'compress',
      ...ledgerTokensOf(usage, provider.providerType),
      estimated,
      durationMs,
    })
  } catch (e: any) {
    console.error('上下文压缩失败:', e)
    throw e
  }

  const summaryMessage: Message = {
    id: v4(),
    role: 'summary',
    content: summaryContent,
    timestamp: Date.now(),
    usage,
  }

  return {
    summary: summaryContent,
    messages: [...allMessages, summaryMessage],
  }
}
