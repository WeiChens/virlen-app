/**
 * LLMVerifier — 使用同一模型验证执行结果是否达标
 *
 * 设计决策（见 plan.md）：
 * - 同一模型验证：使用与执行相同的模型，成本低、架构简单
 * - 每次 LLM 产出 tool_calls 并执行完毕后，立即验证一次
 * - 如果 LLM 没有产生 tool_calls，也做一次验证
 */
import VERIFY_PROMPT_TEMPLATE from './prompts/verify-prompt.md?raw'
import type { IProvider } from '@/infrastructure/provider/types'
import type { Message, Session } from '@/types'
import type { Goal, VerificationResult } from './iteration-types'

/** 验证器配置 */
export interface VerifierConfig {
  /** 验证时使用的 maxTokens */
  maxTokens?: number
}

/** 默认验证 maxTokens */
const DEFAULT_VERIFY_MAX_TOKENS = 4096

/** 验证 prompt 模板（占位符: {{goal}} / {{trace}}） */
function buildVerifyPrompt(goal: Goal, messages: Message[]): string {
  const trace = buildExecutionTrace(messages)

  return VERIFY_PROMPT_TEMPLATE.replace('{{goal}}', goal.description).replace(
    '{{trace}}',
    trace,
  )
}

/** 从消息列表构建执行轨迹摘要 */
function buildExecutionTrace(messages: Message[]): string {
  const parts: string[] = []

  for (const msg of messages) {
    switch (msg.role) {
      case 'assistant': {
        // 提取文本内容
        const text = extractTextContent(msg.content)
        if (text) {
          parts.push(`[Assistant] ${text.slice(0, 500)}`)
        }
        // 提取 tool calls
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          for (const tc of msg.toolCalls) {
            parts.push(
              `[Tool Call] ${tc.name}(${JSON.stringify(tc.input).slice(0, 300)})`,
            )
          }
        }
        break
      }
      case 'tool': {
        const text = extractTextContent(msg.content)
        const status = msg.isError ? ' (失败)' : ''
        parts.push(`[Tool Result${status}] ${text.slice(0, 500)}`)
        break
      }
      // 跳过 user 和 summary 消息
    }
  }

  return parts.join('\n') || '(无执行轨迹)'
}

/** 从 MessageContent 中提取纯文本 */
function extractTextContent(content: Message['content']): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((b) => b.type === 'text')
      .map((b) => ('text' in b ? b.text : ''))
      .join(' ')
  }
  return ''
}

/** 从 LLM 响应中解析 VerificationResult */
function parseVerificationResult(raw: string): VerificationResult {
  try {
    // 尝试直接解析 JSON
    const parsed = JSON.parse(raw.trim())
    return normalizeResult(parsed)
  } catch {
    // 尝试从文本中提取 JSON 块
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0])
        return normalizeResult(parsed)
      } catch {
        // 解析失败，返回默认失败结果
      }
    }
  }

  // 兜底：无法解析时返回"需要人工判断"
  return {
    passed: false,
    summary: '无法解析验证结果，请人工判断',
    issues: [
      {
        severity: 'warning',
        description: '验证器返回了无法解析的响应',
        suggestion: '请人工检查执行结果是否符合预期',
      },
    ],
  }
}

/** 规范化解析结果 */
function normalizeResult(raw: any): VerificationResult {
  return {
    passed: Boolean(raw.passed),
    summary: String(raw.summary || ''),
    issues: Array.isArray(raw.issues)
      ? raw.issues.map((i: any) => ({
          severity: (['error', 'warning', 'info'].includes(i.severity)
            ? i.severity
            : 'warning') as VerificationResult['issues'][0]['severity'],
          description: String(i.description || ''),
          suggestion: String(i.suggestion || ''),
        }))
      : [],
  }
}

/**
 * LLMVerifier 类
 *
 * 使用与执行相同的 LLM provider 来验证执行结果。
 * 构造验证 prompt → 调用 LLM（非流式）→ 解析 JSON 结果。
 */
export class LLMVerifier {
  private config: VerifierConfig

  constructor(config: VerifierConfig = {}) {
    this.config = config
  }

  /**
   * 验证执行结果是否达到目标
   *
   * @param provider  LLM provider（与执行共用）
   * @param session   当前会话
   * @param goal      用户目标
   * @param messages  包含执行轨迹的消息列表
   * @returns 验证结果
   */
  async verify(
    provider: IProvider,
    session: Session,
    goal: Goal,
    messages: Message[],
  ): Promise<VerificationResult> {
    const verifyPrompt = buildVerifyPrompt(goal, messages)

    const verifyMessages: Message[] = [
      {
        id: 'verify_user',
        role: 'user',
        content: verifyPrompt,
        timestamp: Date.now(),
      },
    ]

    try {
      const response = await provider.chat(
        {
          model: session.modelId,
          messages: verifyMessages,
          systemPrompt: '你是一个精确的任务验证器。只输出 JSON。',
          temperature: 0.1, // 低温度以获得更一致的验证结果
          topP: 1.0,
          maxTokens: this.config.maxTokens ?? DEFAULT_VERIFY_MAX_TOKENS,
          stream: false,
          tool_choice: 'none', // 验证时不需要工具
        },
        // 不传 abortSignal，验证不应被用户取消中断
      )

      const rawText = extractTextContent(response.content)
      return parseVerificationResult(rawText)
    } catch (e: any) {
      // 验证调用失败时返回未通过，让迭代循环继续或结束
      return {
        passed: false,
        summary: `验证调用失败: ${e.message || String(e)}`,
        issues: [
          {
            severity: 'error',
            description: `验证 LLM 调用失败: ${e.message || String(e)}`,
            suggestion: '请检查 provider 配置或网络连接后重试',
          },
        ],
      }
    }
  }
}

/** 默认验证器实例 */
export const llmVerifier = new LLMVerifier()
