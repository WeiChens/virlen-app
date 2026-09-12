/**
 * user_choice — 用户选择弹窗（user_choice tool）的交互逻辑
 *
 * 负责创建 user_choice 的 Promise 化交互 handles，供 tool-service/index 调度。
 * 通过 toolInteractEvent 事件总线与 UI 层（tool-ui.tsx）通讯。
 */
import toolInteractEvent from '@/events/toolInteractEvent'
import { track, getSessionTrace } from '@/utils/telemetry'
import type { ToolResult } from '@/domain/tools/types'

/**
 * 用户暂存交互 — 不通知 AI，直接中断当前 tool 循环，
 * 保留会话状态让用户稍后恢复。
 */
class InteractionShelved extends Error {
  shelveMessage: string

  constructor(message: string = '用户暂存了交互') {
    super(message)
    this.name = 'InteractionShelved'
    this.shelveMessage = message
  }
}

export interface UserChoiceHandles {
  /** 给 agentEngine 的 onUserInteraction 回调 */
  handler: (type: string, data: Record<string, any>) => Promise<ToolResult>
  cleanup: () => void
}

/**
 * 创建 user_choice 弹窗的交互 handles
 */
export function createUserChoiceHandles(
  sessionId: string,
): UserChoiceHandles {
  let interactionResolve: ((value: ToolResult) => void) | null = null
  let interactionReject: ((reason: any) => void) | null = null
  let showTime = 0
  let traceId: string | undefined

  // 监听 UI 层的确认 / 取消 / 暂存
  const offResolve = toolInteractEvent.on('resolve', (value: string) => {
    track('interaction.choice.result', {
      trace_id: traceId,
      selected_count: value ? String(value).split(',').length : 0,
      action: 'confirm',
      latency_ms: showTime ? Date.now() - showTime : undefined,
    })
    interactionResolve?.(value)
    interactionResolve = null
  })
  const offReject = toolInteractEvent.on('reject', (reason: string) => {
    track('interaction.choice.result', {
      trace_id: traceId,
      action: 'cancel',
      latency_ms: showTime ? Date.now() - showTime : undefined,
    })
    if (reason.startsWith('shelve:')) {
      track('interaction.cancel', { phase: 'user_choice' })
      interactionReject?.(new InteractionShelved(reason.slice(7)))
    } else {
      interactionReject?.(reason || 'cancelled')
    }
    interactionReject = null
  })

  return {
    handler: async (type: string, data: Record<string, any>) => {
      showTime = Date.now()
      traceId = getSessionTrace(sessionId)
      track('interaction.choice.show', {
        trace_id: traceId,
        question: data.question,
        question_len: (data.question || '').length,
        option_count: (data.options || []).length,
        multi: !!data.multi,
      })
      return new Promise<string>((resolve, reject) => {
        return new Promise<ToolResult>((resolve, reject) => {
          interactionResolve = resolve
          interactionReject = reject
          toolInteractEvent.emit(
            'showChoice',
            sessionId,
            data.question,
            data.options,
            data.multi,
            data.toolCallId,
          )
        })
      },
        cleanup: () => {
          offResolve()
          offReject()
        },
  }
  }
