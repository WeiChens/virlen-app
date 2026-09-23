/**
 * Agent 事件处理器 + 收尾逻辑
 *
 * ⚠️ 这里是 AgentEventType 契约在 service 层的唯一落点（铁律 2：事件契约四方一致）。
 * 新增/改名事件类型时务必四处同步：TS 类型 → TS 引擎 emit → Rust emit → 本文件分支。
 */
import {
  getSessionRuntime,
  sessionStore,
  updateSessionRuntime,
} from '@/ui/store'
import { settingsState } from '@/ui/store'
import type { AgentEventCallback, MessageContent } from '@/types'
import { extractText, getEngine, providerTypeOf, transformApiError } from './common'
import { activeTraces, markErrored } from './trace'
import {
  addSessionMessage,
  getSessionMessages,
  persistMessagesIfNeeded,
  updateSessionMessage,
} from './messages'
import type { ChatServiceEvents } from './types'
import { trayNotifyCompleted } from '@/services/tray-service'
import { t } from '@/ui/i18n'
import {
  track,
  trackError,
  trackPerf,
  hashText,
  truncateText,
  clearSessionTrace,
} from '@/utils/telemetry'

/** 创建通用事件处理器 */
export function createEventHandler(
  sessionId: string,
  sessionRt: ReturnType<typeof getSessionRuntime>,
  events?: ChatServiceEvents,
  traceId?: string,
): AgentEventCallback {
  return (event) => {
    switch (event.type) {
      case 'stream_event': {
        const delta = event.data?.delta || ''
        const tr = activeTraces.get(sessionId)
        if (delta && tr && !tr.firstTokenSeen && traceId) {
          tr.firstTokenSeen = true
          const sess = sessionStore.getSession(sessionId)
          track('chat.stream.first_token', {
            trace_id: traceId,
            first_token_ms: Date.now() - tr.startTime,
            model_id: sess?.modelId,
            provider_type: sess ? providerTypeOf(sess) : undefined,
          })
        }
        updateSessionRuntime(sessionId, {
          pendingContent: (sessionRt.pendingContent || '') + delta,
          streamingMessageId: event.data?.messageId || null,
        })
        events?.onPendingContent?.(sessionId, delta)
        events?.onMessagesUpdate?.(sessionId)
        break
      }

      case 'assistant_message_created': {
        // engine 创建了 assistant 消息，需要持久化
        if (event.data?.message) {
          const trMsg = activeTraces.get(sessionId)
          // 仅把 LLM 产出的 assistant 消息计为一次轮次：迭代模式下的
          // 反馈消息（role=feedback）与失败报告无 streaming 标记，不计入 rounds。
          if (
            trMsg &&
            event.data.message.role === 'assistant' &&
            event.data.message.streaming
          ) {
            trMsg.rounds += 1
          }
          addSessionMessage(sessionId, event.data.message)
          events?.onMessagesUpdate?.(sessionId)
        }
        break
      }

      case 'assistant_message_updated':
        // engine 更新了 assistant 消息内容（流式增量 / 结束标记）
        if (event.data?.messageId && event.data?.patch) {
          updateSessionMessage(
            sessionId,
            event.data.messageId,
            event.data.patch,
          )
          events?.onMessagesUpdate?.(sessionId)
        }
        break

      case 'tool_result_created':
        // engine 创建了 tool_result 消息，需要持久化
        if (event.data?.message) {
          addSessionMessage(sessionId, event.data.message)
          events?.onMessagesUpdate?.(sessionId)
        }
        break

      case 'tool_call': {
        const trTc = activeTraces.get(sessionId)
        const toolCallId = event.data?.id
        if (trTc && typeof toolCallId === 'string') {
          trTc.toolCallIds.add(toolCallId)
        }
        events?.onMessagesUpdate?.(sessionId)
        break
      }

      case 'iteration_verify_start':
        events?.onVerifyingChange?.(sessionId, true)
        break

      case 'iteration_verify_end':
        events?.onVerifyingChange?.(sessionId, false)
        break

      case 'iteration_verify_pass':
      case 'iteration_verify_fail': {
        // §5.5 engine.iteration.verify / fix
        const v = event.data?.result
        const issues = Array.isArray(v?.issues) ? v.issues : []
        track('engine.iteration.verify', {
          trace_id: traceId,
          iteration: event.data?.iteration,
          passed: !!v?.passed,
          summary: v?.summary,
          issue_count: issues.length,
          severity_list: issues.map((it: any) => it?.severity).filter(Boolean),
        })
        if (!v?.passed) {
          track('engine.iteration.fix', {
            trace_id: traceId,
            iteration: event.data?.iteration,
            issue_count: issues.length,
          })
        }
        break
      }

      case 'iteration_max_exceeded':
        track('engine.iteration.max_exceeded', {
          trace_id: traceId,
          iteration: event.data?.iteration,
          max_iterations: event.data?.maxIterations,
        })
        break

      case 'stream_end': {
        const trEnd = activeTraces.get(sessionId)
        const totalMs = trEnd ? Date.now() - trEnd.startTime : undefined
        if (event.data?.paused) {
          const snap = event.data?.snapshot
          track('chat.stream.pause', {
            trace_id: traceId,
            total_ms: totalMs,
            round: snap?.round,
            pending_steps: Array.isArray(snap?.steps)
              ? snap.steps.filter((s: any) => s?.status !== 'completed').length
              : undefined,
          })
          updateSessionRuntime(sessionId, { paused: true })
          events?.onMessagesUpdate?.(sessionId)
        } else {
          const sessEnd = sessionStore.getSession(sessionId)
          const lastAssistant = sessEnd
            ? [...sessEnd.messages].reverse().find((m) => m.role === 'assistant')
            : undefined
          const replyText = lastAssistant
            ? extractText(lastAssistant.content)
            : ''
          track('chat.stream.end', {
            trace_id: traceId,
            status: trEnd?.errored ? 'fail' : 'success',
            total_ms: totalMs,
            text_len: replyText.length,
            reasoning_elapsed_ms: lastAssistant?.reasoningElapsedMs,
            usage: lastAssistant?.usage
              ? {
                  prompt: lastAssistant.usage.promptTokens,
                  completion: lastAssistant.usage.completionTokens,
                  total: lastAssistant.usage.totalTokens,
                }
              : undefined,
          })
          // perf.stream.tps（10% 采样）：仅非暂停的正常结束
          const tokens = lastAssistant?.usage?.completionTokens ?? 0
          if (totalMs && totalMs > 0 && tokens > 0) {
            trackPerf('perf.stream.tps', {
              trace_id: traceId,
              tokens,
              duration_ms: totalMs,
              tps: Math.round((tokens / (totalMs / 1000)) * 10) / 10,
            })
          }
          // 埋点：AI 回复正文（§5.4）— 每轮 assistant 结束时发一次
          if (lastAssistant) {
            const replyReasoning = lastAssistant.reasoningContent ?? ''
            track('chat.message.received', {
              trace_id: traceId,
              session_id: hashText(sessionId),
              text: truncateText(replyText, 16384),
              text_len: replyText.length,
              reasoning_text: replyReasoning
                ? truncateText(replyReasoning, 16384)
                : undefined,
              reasoning_len: replyReasoning.length,
              paused: false,
            })
          }
          updateSessionRuntime(sessionId, {
            paused: false,
            pendingContent: '',
            streamingMessageId: null,
          })
          events?.onStreamEnd?.(sessionId)
          events?.onMessagesUpdate?.(sessionId)
        }
        // TS 引擎路径兜底：整批落库当前消息（覆盖 assistant 流式最终内容）
        persistMessagesIfNeeded(sessionId, getSessionMessages(sessionId))
        break
      }

      case 'error': {
        markErrored(sessionId)
        const errSess = sessionStore.getSession(sessionId)
        const errMsg = event.error || '未知错误'
        const httpMatch = /API Error \((\d{3})\)/.exec(errMsg)
        trackError('chat.stream.error', errMsg, {
          traceId,
          props: {
            ...(errSess ? { provider_type: providerTypeOf(errSess) } : {}),
            partial_len: (sessionRt.pendingContent || '').length,
            paused: !!sessionRt.paused,
            http_status: httpMatch ? Number(httpMatch[1]) : undefined,
          },
        })
        events?.onError?.(
          sessionId,
          transformApiError(event.error || '未知错误'),
        )
        break
      }
    }
  }
}

/**
 * 取该会话最后一条有正文的助手消息，作为完成提醒的预览。
 *
 * 拿不到（空回复）时返回空串，交给 Rust 用会话标题兜底。
 */
function lastAssistantPreview(sessionId: string): string {
  const messages = getSessionMessages(sessionId)
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== 'assistant') continue
    const text = extractText(message.content).trim()
    if (text) return text.slice(0, 120)
  }
  return ''
}

/** 完成工作（清理 runtime state on non-pause） */
export async function finishWorking(
  sessionId: string,
  sessionRt: ReturnType<typeof getSessionRuntime>,
  events?: ChatServiceEvents,
  content?: MessageContent,
  traceId?: string,
): Promise<void> {
  const snapshot = await getEngine().getRunSnapshot(sessionId)

  const isPaused = !!snapshot
  const tr = activeTraces.get(sessionId)
  if (traceId) {
    track('engine.finish', {
      trace_id: traceId,
      total_ms: tr ? Date.now() - tr.startTime : undefined,
      rounds: tr?.rounds,
      tool_calls_total: tr?.toolCallIds.size,
      status: tr?.errored ? 'fail' : 'success',
      paused: isPaused,
    })
  }
  // 无论是否带 traceId 都回收链路上下文：恢复暂停（resumePausedRun）等
  // 未传 traceId 的路径也必须清理，否则 activeTraces / sessionTraces 持续残留。
  activeTraces.delete(sessionId)
  clearSessionTrace(sessionId)
  updateSessionRuntime(sessionId, {
    working: isPaused,
    paused: isPaused,
  })

  if (!isPaused) {
    updateSessionRuntime(sessionId, {
      pendingContent: '',
      streamingMessageId: null,
    })
    events?.onWorkingChange?.(sessionId, false)
    events?.onMessagesUpdate?.(sessionId)
    // 托盘提醒：真的跑完（含出错）才提醒；是否打扰、走哪条通道由 Rust 判断（窗口聚焦时不打扰）
    const errored = !!tr?.errored
    trayNotifyCompleted(sessionId, {
      title: sessionStore.getSession(sessionId)?.title ?? '',
      // 空正文（模型只调了工具、没输出文本）用 i18n 文案兜底 —— 系统通知的正文不能是空的；
      // 文案由前端给（原生侧不养第二套语言逻辑，铁律 7）
      preview:
        lastAssistantPreview(sessionId) ||
        t(errored ? 'AI 回复出错' : 'AI 回复完成'),
      status: errored ? 'error' : 'success',
    })
  }

  // 自动设置标题（仅 session 标题仍为默认值时触发一次）
  // 优先让 AI 生成标题（可在「设置 → 聊天设置 → AI 生成标题」关闭），
  // 关闭或失败则回退到用户消息截取
  if (!isPaused && content) {
    const updatedSession = sessionStore.getSession(sessionId)
    if (updatedSession && updatedSession.title === '新对话') {
      const text = extractText(content)
      const fallbackTitle = text.slice(0, 30) + (text.length > 30 ? '...' : '')
      let title = fallbackTitle
      const titleStart = Date.now()
      let titleStatus: 'ai' | 'fallback' | 'fail' | 'disabled' = 'fallback'
      let titleError: string | undefined
      try {
        // 设置项关闭时不发起标题生成的 LLM 调用，直接用回退标题
        if (!settingsState.value.aiGenerateTitle) {
          titleStatus = 'disabled'
        } else {
          const aiTitle = await getEngine().generateTitle(
            updatedSession,
            getSessionMessages(sessionId),
          )
          if (aiTitle) {
            title = aiTitle
            titleStatus = 'ai'
          }
        }
      } catch (e: any) {
        titleStatus = 'fail'
        titleError = e?.message || String(e)
        console.warn('[chat-service] AI 生成标题失败，回退到用户消息截取:', e)
      }
      track('chat.title.generate', {
        status: titleStatus,
        duration_ms: Date.now() - titleStart,
        error: titleError,
      })
      // 二次检查：标题可能已被用户手动修改或并发设置
      const current = sessionStore.getSession(sessionId)
      if (current && current.title === '新对话') {
        sessionStore.updateSession(sessionId, { title })
      }
    }
  }
}
