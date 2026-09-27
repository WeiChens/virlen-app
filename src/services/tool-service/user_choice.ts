/**
 * user_choice — 用户选择弹窗（user_choice tool）的交互逻辑
 *
 * 负责创建 user_choice 的 Promise 化交互 handles，供 tool-service/index 调度。
 * 通过 toolInteractEvent 事件总线与 UI 层（tool-ui.tsx）通讯。
 *
 * ⚠️ **路由依据是 `interactionId`**（见 `events/toolInteractEvent.ts` 文件头）：
 * 每次 handler 调用生成一个新 id 并随 `showChoice` 下发，应答事件必须原样回传，
 * 不匹配的一律忽略。否则两个会话同时提问时，一次应答会把两个都 resolve 掉
 * （改造前的既存串扰）。
 */
import toolInteractEvent from '@/events/toolInteractEvent'
import { track, getSessionTrace } from '@/utils/telemetry'
import type { ToolResult } from '@/domain/tools/types'
import { v4 } from '@/utils/uuid'

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
  /** 给引擎的 onUserInteraction 回调 */
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
  /** 当前待应答的交互 id（应答后置空 → 重复应答 / 过期应答自然失效） */
  let pendingInteractionId: string | null = null
  let showTime = 0
  let traceId: string | undefined

  // 监听 UI 层的确认 / 取消 / 暂存
  const offResolve = toolInteractEvent.on(
    'resolve',
    (interactionId: string, value: ToolResult) => {
      // 只响应当前挂起的那个交互（多交互并发 / 跨 session 不互抄）
      if (interactionId !== pendingInteractionId) return
      pendingInteractionId = null
      const resolve = interactionResolve
      interactionResolve = null
      track('interaction.choice.result', {
        trace_id: traceId,
        selected_count: value ? String(value).split(',').length : 0,
        action: 'confirm',
        latency_ms: showTime ? Date.now() - showTime : undefined,
      })
      resolve?.(value)
      // 广播终态：其他应答端（手机）据此收起自己的弹窗
      toolInteractEvent.emit('interactionSettled', interactionId, 'allow')
    },
  )
  const offReject = toolInteractEvent.on(
    'reject',
    (interactionId: string, reason: string) => {
      if (interactionId !== pendingInteractionId) return
      pendingInteractionId = null
      const reject = interactionReject
      interactionReject = null
      const shelved = reason.startsWith('shelve:')
      track('interaction.choice.result', {
        trace_id: traceId,
        action: 'cancel',
        latency_ms: showTime ? Date.now() - showTime : undefined,
      })
      if (shelved) {
        track('interaction.cancel', { phase: 'user_choice' })
      }
      if (shelved) {
        reject?.(new InteractionShelved(reason.slice(7)))
      } else {
        reject?.(reason || 'cancelled')
      }
      toolInteractEvent.emit(
        'interactionSettled',
        interactionId,
        shelved ? 'shelve' : 'reject',
      )
    },
  )

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
      const interactionId = v4()
      return new Promise<ToolResult>((resolve, reject) => {
        interactionResolve = resolve
        interactionReject = reject
        pendingInteractionId = interactionId
        toolInteractEvent.emit('showChoice', {
          interactionId,
          sessionId,
          toolCallId: data.toolCallId || '',
          question: data.question || '',
          options: data.options || [],
          multi: !!data.multi,
        })
      })
    },
    cleanup: () => {
      offResolve()
      offReject()
    },
  }
}
