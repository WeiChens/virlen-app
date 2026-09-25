/**
 * 会话标题生成 — 用 LLM 基于对话内容生成简短标题
 *
 * 从 AgentEngine.generateTitle() 提取为独立纯函数，不依赖 class this。
 * 失败时由调用方（chat-service）回退到用户消息截取。
 */
import type { Message, Session } from '@/types'
import { ChatRequest } from '@/infrastructure/provider/types'
import { providerPort } from '../provider'
import { AI_AGENT_GENERATE_TITLE_PROMPT } from '../agent'
import { ledgerTokensOf, recordUsage } from '../usage'
import { sliceHead } from '@/utils/text'

/** 标题最大长度（超过则截断并追加省略号） */
export const MAX_TITLE_LENGTH = 30

/** 从 MessageContent 中提取纯文本（容错：null / 空 / 非文本块一律返回空串） */
export function extractTitleText(content: Message['content']): string {
  if (typeof content === 'string') return content
  // 纯工具调用轮次的 assistant 消息 content 为 null，此处不做容错会直接抛 TypeError
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b && b.type === 'text')
    .map((b) => ('text' in b ? b.text : ''))
    .join(' ')
}

/**
 * 清洗 AI 生成的标题：
 * - 去掉首尾引号/书名号等装饰符号与空白
 * - 去掉 markdown 标题符号
 * - 压缩换行/空白为单个空格
 * - 超长截断（MAX_TITLE_LENGTH + '...'）
 */
export function sanitizeTitle(raw: string): string {
  let t = (raw || '').trim()
  // 去掉 markdown 标题符号（#、-、* 等行首装饰）
  t = t.replace(/^[#\-*\s]+/, '')
  // 去掉首尾常见的引号/括号/装饰符号
  t = t.replace(
    /^["'“”‘’《》「」【】()[\]{}<>：:，,。.\s]+|["'“”‘’《》「」【】()[\]{}<>：:，,。.\s]+$/g,
    '',
  )
  // 压缩换行/多余空白为单个空格
  t = t.replace(/\s+/g, ' ').trim()
  if (t.length > MAX_TITLE_LENGTH) {
    t = sliceHead(t, MAX_TITLE_LENGTH) + '...'
  }
  return t
}

/**
 * 标题生成上下文清洗 —— 只保留「有正文的 user / assistant」纯文本轮次。
 *
 * 为什么必须清洗：标题请求只截取对话开头的几轮、**不携带工具结果消息**。
 * 若上下文里带进 "assistant(content=null, toolCalls=[...])" 这种轮次，
 * Provider 转成 API 报文后会渲染出孤立 tool_calls（没有后续 role='tool' 应答），
 * OpenAI 兼容 API（如 DeepSeek）会直接拒绝：
 * "An assistant message with 'tool_calls' must be followed by tool messages"。
 *
 * 因此这里：
 * - 丢弃 tool / summary / feedback 等非对话角色（标题场景无用，且 tool 无配对同样会报错）
 * - 剥离 assistant 的 toolCalls / toolCallId / reasoningContent（纯工具调用轮次正文为空 → 整条丢弃）
 * - 顺带剥掉 usage / uiData 等与请求无关的重字段，避免无谓的序列化开销
 */
export function sanitizeTitleContext(messages: Message[]): Message[] {
  const result: Message[] = []
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue
    // assistant 只带工具调用、没有正文时（content 为 null / 空串）整条丢弃
    if (!extractTitleText(m.content).trim()) continue
    result.push({
      id: m.id,
      role: m.role,
      content: m.content,
      timestamp: m.timestamp,
    })
  }
  return result
}

/**
 * 基于会话内容生成标题
 *
 * 流程：
 * 1. 取第一条用户消息（+ 其后的首条 assistant 回复）作为上下文
 * 2. 以非流式方式调用 LLM，让 AI 生成简短标题
 * 3. 清洗（去装饰符号/压缩空白/截断）后返回
 *
 * @throws 没有用户消息 / 未配置模型 / Provider 未注册 / AI 未生成有效标题 / Provider 调用失败
 */
export async function generateTitle(
  session: Session,
  messages: Message[],
): Promise<string> {
  // 找到第一条用户消息，作为标题上下文基准
  const firstUserIdx = messages.findIndex((m) => m.role === 'user')
  if (firstUserIdx === -1) {
    throw new Error('No user messages found')
  }
  const firstUser = messages[firstUserIdx]
  // 附带其后的首条 assistant 回复，帮助 AI 理解对话主题
  const firstAssistant = messages
    .slice(firstUserIdx + 1)
    .find((m) => m.role === 'assistant')

  const providerId = session.providerConfigId
  const model = session.modelId
  if (!model || !providerId) {
    throw new Error('The session has no model or provider configured')
  }

  const provider = await providerPort.get(providerId)
  if (!provider) {
    throw new Error(`Provider "${providerId}" is not registered`)
  }

  // ⚠️ 必须清洗：首条 assistant 常常是「纯工具调用轮次」，直接透传会被 API 判为非法报文
  const contextMessages = sanitizeTitleContext(
    firstAssistant ? [firstUser, firstAssistant] : [firstUser],
  )

  const request: ChatRequest = {
    model,
    messages: [
      ...contextMessages,
      {
        role: 'user',
        content: AI_AGENT_GENERATE_TITLE_PROMPT,
        id: 'generate-title-request',
        timestamp: Date.now(),
      },
    ],
    systemPrompt: undefined,
    tools: undefined,
    temperature: 0.3,
    topP: session.params.topP,
    maxTokens: 40,
    stream: false,
    tool_choice: 'none',
    thinking: false,
  }

  const startedAt = Date.now()
  const response = await provider.chat(request)
  // 标题生成耗时（含首字延迟）：UI 用它算 tok/s
  const durationMs = Date.now() - startedAt

  // 标题生成是真实 LLM 调用但不产生消息 → 必须显式记账，否则这笔消费就漏了
  if (response.usage) {
    recordUsage({
      ts: Date.now(),
      sessionId: session.id,
      model,
      providerType: provider.providerType,
      providerConfigId: providerId,
      kind: 'title',
      ...ledgerTokensOf(response.usage, provider.providerType),
      estimated: false,
      durationMs,
    })
  }

  const raw =
    typeof response.content === 'string'
      ? response.content
      : extractTitleText(response.content)

  const title = sanitizeTitle(raw)
  if (!title) {
    throw new Error('The AI did not generate a valid title')
  }
  return title
}
