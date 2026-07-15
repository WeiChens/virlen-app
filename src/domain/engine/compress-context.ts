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
  allMessages: Message[],
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
    const response = await provider.chat(request)
    summaryContent =
      typeof response.content === 'string'
        ? response.content
        : JSON.stringify(response.content)

    // 优先使用 API 返回的真实 Token 用量（最准确）
    if (response.usage) {
      usage = { ...response.usage }
    } else {
      // 兜底估算：统计输入/输出文本的总字符数，按 ~4 字符 ≈ 1 token 估算
      const inputText = request.messages
        .map((m) =>
          typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        )
        .join('')
      const systemText = request.systemPrompt || ''
      const estimatedInputTokens = Math.ceil(
        (inputText.length + systemText.length) / 4,
      )
      const estimatedOutputTokens = Math.ceil(summaryContent.length / 4)
      usage = {
        promptTokens: estimatedInputTokens,
        completionTokens: estimatedOutputTokens,
        totalTokens: estimatedInputTokens + estimatedOutputTokens,
      }
    }
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
