/**
 * user_choice — 用户选择弹窗（user_choice tool）的交互逻辑，供 tool-service/index 调度。
 * 通过 toolInteractEvent 事件总线与 UI 层（tool-ui.tsx）通讯。
 *
 * ⚠️ **路由依据是 interactionId**：每次 handler 调用生成新 id 随 showChoice 下发，应答事件必须
 * 原样回传，不匹配的忽略 —— 否则两个会话同时提问时，一次应答会把两个都 resolve。
 *
 * ⚠️ **待应答交互是多槽（`pendings`），不是单个槽位**：同一个会话里可能同时挂起多个提问
 *（AI 一次并行调两次 user_choice，或一轮工具循环里连问两次）。改造前是「单槽 + 后到覆盖」：
 * 新交互会把上一个的 resolve/reject 直接顶掉 —— 上一个的 Promise 永久挂起（await 永不 settle、
 * 闭包被一直引用），而用户在待处理切换条上回答它时**看着弹窗关掉了、引擎那边却什么也没发生**。
 */
import toolInteractEvent from '@/events/toolInteractEvent'
import { track, getSessionTrace } from '@/utils/telemetry'
import type { ToolResult } from '@/domain/tools/types'
import { v4 } from '@/utils/uuid'
import { InteractionEnded } from './interaction-end'

/**
 * 用户暂存交互 — 不通知 AI，直接中断当前 tool 循环，保留会话状态让用户稍后恢复。
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

/** 一个待应答交互的槽位（应答 / 收敛后即从表里摘掉 → 重复应答 / 过期应答自然失效） */
interface PendingChoice {
  resolve: (value: ToolResult) => void
  reject: (reason: any) => void
  /** 弹出时刻（埋点的 latency_ms 用） */
  showTime: number
  traceId?: string
}

/**
 * 创建 user_choice 弹窗的交互 handles
 */
export function createUserChoiceHandles(
  sessionId: string,
): UserChoiceHandles {
  /** interactionId → 待应答槽位（跨 session 天然隔离：每个 session 一个 handles 实例） */
  const pendings = new Map<string, PendingChoice>()

  // 监听 UI 层的确认 / 取消 / 暂存
  const offResolve = toolInteractEvent.on(
    'resolve',
    (interactionId: string, value: ToolResult) => {
      // 只响应**这个**交互（未知 / 已应答 / 已被收敛的一律忽略，幂等）
      const entry = pendings.get(interactionId)
      if (!entry) return
      pendings.delete(interactionId)
      track('interaction.choice.result', {
        trace_id: entry.traceId,
        selected_count: value ? String(value).split(',').length : 0,
        action: 'confirm',
        latency_ms: entry.showTime ? Date.now() - entry.showTime : undefined,
      })
      entry.resolve(value)
      // 广播终态：其他应答端（手机）据此收起自己的弹窗
      toolInteractEvent.emit('interactionSettled', interactionId, 'allow')
    },
  )
  const offReject = toolInteractEvent.on(
    'reject',
    (interactionId: string, reason: string) => {
      const entry = pendings.get(interactionId)
      if (!entry) return
      pendings.delete(interactionId)
      const shelved = reason.startsWith('shelve:')
      track('interaction.choice.result', {
        trace_id: entry.traceId,
        action: 'cancel',
        latency_ms: entry.showTime ? Date.now() - entry.showTime : undefined,
      })
      if (shelved) {
        track('interaction.cancel', { phase: 'user_choice' })
      }
      if (shelved) {
        entry.reject(new InteractionShelved(reason.slice(7)))
      } else {
        entry.reject(reason || 'cancelled')
      }
      toolInteractEvent.emit(
        'interactionSettled',
        interactionId,
        shelved ? 'shelve' : 'reject',
      )
    },
  )

  /**
   * 运行结束时的收尾：把**还没被回答**的每一次交互都收敛掉（F4）。
   *
   * 为何必须在 cleanup() 里做：一跑监听器就拆了，此后任何应答事件都到不了这里 ——
   * 而「运行结束」≠「用户答过了」（停止 / 取消 / 删会话 / 引擎放弃，这四条路都还没被回答）。
   * 不收敛的后果：① Promise 永不 settle，await 永远挂着、闭包被一直引用；② 手机侧卡片永不消失。
   *
   * ⚠️ 先广播终态再 reject（桌面弹窗与手机注册表都靠那条事件收 UI），且广播用 'expired'
   *（**没人回答**）而非 'reject'（用户拒绝）—— 两者在手机端与埋点里含义不同。
   * ⚠️ 多槽：**逐个**收敛（只收敛最后一个的话，其余几个仍然挂死）。
   */
  function endPending(): void {
    if (pendings.size === 0) return
    const entries = [...pendings]
    pendings.clear()
    for (const [interactionId, entry] of entries) {
      toolInteractEvent.emit('interactionSettled', interactionId, 'expired')
      entry.reject(new InteractionEnded())
    }
  }

  return {
    handler: async (type: string, data: Record<string, any>) => {
      const showTime = Date.now()
      const traceId = getSessionTrace(sessionId)
      track('interaction.choice.show', {
        trace_id: traceId,
        question: data.question,
        question_len: (data.question || '').length,
        option_count: (data.options || []).length,
        multi: !!data.multi,
      })
      const interactionId = v4()
      return new Promise<ToolResult>((resolve, reject) => {
        pendings.set(interactionId, { resolve, reject, showTime, traceId })
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
      // 先收敛未答的交互（否则监听器一拆，它就永远收不掉了）
      endPending()
      offResolve()
      offReject()
    },
  }
}
