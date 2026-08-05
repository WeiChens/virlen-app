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

/** 标题最大长度（超过则截断并追加省略号） */
export const MAX_TITLE_LENGTH = 30

/** 从 MessageContent 中提取纯文本 */
export function extractTitleText(content: Message['content']): string {
  if (typeof content === 'string') return content
  return content
    .filter((b) => b.type === 'text')
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
    t = t.slice(0, MAX_TITLE_LENGTH) + '...'
  }
  return t
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
    throw new Error('没有用户消息')
  }
  const firstUser = messages[firstUserIdx]
  // 附带其后的首条 assistant 回复，帮助 AI 理解对话主题
  const firstAssistant = messages
    .slice(firstUserIdx + 1)
    .find((m) => m.role === 'assistant')

  const providerId = session.providerConfigId
  const model = session.modelId
  if (!model || !providerId) {
    throw new Error('会话未配置模型或 Provider')
  }

  const provider = await providerPort.get(providerId)
  if (!provider) {
    throw new Error(`Provider "${providerId}" 未注册`)
  }

  const contextMessages: Message[] = [firstUser]
  if (firstAssistant) contextMessages.push(firstAssistant)

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

  const response = await provider.chat(request)
  const raw =
    typeof response.content === 'string'
      ? response.content
      : extractTitleText(response.content)

  const title = sanitizeTitle(raw)
  if (!title) {
    throw new Error('AI 未生成有效标题')
  }
  return title
}
