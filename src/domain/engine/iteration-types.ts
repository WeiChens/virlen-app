/**
 * 迭代循环类型定义
 *
 * 用于「执行→验证→修复」自主迭代能力
 */
import type { Message } from '@/types'

/** 用户设定的迭代目标 */
export interface Goal {
  /** 目标描述文本 */
  description: string
}

/** 验证发现的问题严重级别 */
export type IssueSeverity = 'error' | 'warning' | 'info'

/** 单个验证问题 */
export interface VerificationIssue {
  severity: IssueSeverity
  description: string
  suggestion: string
}

/** 验证结果 */
export interface VerificationResult {
  /** 目标是否已达成 */
  passed: boolean
  /** 验证摘要 */
  summary: string
  /** 发现的问题列表 */
  issues: VerificationIssue[]
}

/** 迭代会话 — 跟踪整个迭代过程的状态 */
export interface IterationSession {
  /** 用户目标 */
  goal: Goal
  /** 当前迭代次数（从 1 开始） */
  currentIteration: number
  /** 最大允许迭代次数 */
  maxIterations: number
  /** 各轮验证结果历史 */
  verificationHistory: VerificationResult[]
}

/** 迭代过程中发出的事件 */
export type IterationEventType =
  | 'iteration_start'
  | 'iteration_verify_start'
  | 'iteration_verify_end'
  | 'iteration_verify_pass'
  | 'iteration_verify_fail'
  | 'iteration_max_exceeded'
  | 'iteration_end'

/** 迭代事件 */
export interface IterationEvent {
  type: IterationEventType
  data?: {
    iteration?: number
    maxIterations?: number
    result?: VerificationResult
    summary?: string
  }
}

/** 迭代事件回调 */
export type IterationEventCallback = (event: IterationEvent) => void

/**
 * 构建注入到对话中的验证反馈消息
 *
 * 以 user 角色注入，让 LLM 天然看到上一轮问题
 */
export function buildFeedbackMessage(result: VerificationResult): Message {
  const issueLines = result.issues.map(
    (issue, i) =>
      `${i + 1}. [${issue.severity}] ${issue.description}\n   建议: ${issue.suggestion}`,
  )

  const content = [
    '【验证反馈】',
    '',
    `验证结果: ${result.passed ? '✅ 通过' : '❌ 未通过'}`,
    `摘要: ${result.summary}`,
    '',
    ...(result.issues.length > 0
      ? ['发现的问题:', ...issueLines, '', '请修正以上问题后重新尝试。']
      : []),
  ].join('\n')

  return {
    id: `feedback_${Date.now()}`,
    role: 'feedback',
    content,
    timestamp: Date.now(),
  }
}
