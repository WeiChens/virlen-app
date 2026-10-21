/**
 * Agent 事件处理器 + 收尾逻辑。
 *
 * ⚠️ AgentEventType 契约在 service 层的唯一落点：新增 / 改名事件类型时三处同步（TS 类型 → Rust emit → 本文件）。
 */
import {
  chatState,
  getSessionRuntime,
  sessionStore,
  updateSessionRuntime,
} from '@/ui/store'
import { settingsState } from '@/ui/store'
import type { AgentEventCallback, Message, MessageContent } from '@/types'
import { messageHasVisibleContent } from '@/utils/messageContent'
import { extractText, getEngine, providerTypeOf, transformApiError } from './common'
import { activeTraces, markErrored } from './trace'
import {
  addSessionMessage,
  getSessionMessage,
  getSessionMessages,
  persistMessagesIfNeeded,
  setAgentElapsedMs,
  updateSessionMessage,
} from './messages'
import type { ChatServiceEvents } from './types'
import { trayNotifyCompleted } from '@/services/tray-service'
import { notifyWorkspaceActivity } from '@/services/git-service'
import { flushTodoDraft } from '@/services/todo-service'
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
        })
        events?.onPendingContent?.(sessionId, delta)
        events?.onMessagesUpdate?.(sessionId)
        break
      }

      case 'assistant_message_created': {
        // engine 创建了 assistant 消息，需要持久化
        if (event.data?.message) {
          const trMsg = activeTraces.get(sessionId)
          // 只把 LLM 产出的 assistant 消息计为一次轮次：迭代反馈与失败报告无 streaming 标记，不计入
          if (
            trMsg &&
            event.data.message.role === 'assistant' &&
            event.data.message.streaming
          ) {
            trMsg.rounds += 1
          }
          addSessionMessage(sessionId, event.data.message)
          // 记录「正在生成的那条消息」：Rust 的 stream_event 不带 messageId，只能由本事件与定稿补丁维护。
          // 手机 bridge 的流式通道已直接读 store 里 streaming===true 的消息，这里保持语义正确即可。
          if (event.data.message.role === 'assistant' && event.data.message.streaming) {
            updateSessionRuntime(sessionId, { streamingMessageId: event.data.message.id })
          }
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
            resolveAssistantPatch(
              sessionId,
              event.data.messageId,
              event.data.patch,
            ),
          )
          // 定稿补丁（streaming:false）→ 该条不再生成中
          if (event.data.patch.streaming === false) {
            updateSessionRuntime(sessionId, { streamingMessageId: null })
          }
          events?.onMessagesUpdate?.(sessionId)
        }
        break

      case 'tool_result_created':
        // engine 创建了 tool_result 消息，需要持久化
        if (event.data?.message) {
          addSessionMessage(sessionId, event.data.message)
          events?.onMessagesUpdate?.(sessionId)
        }
        // 这次工具可能改了工作区文件 → 排期一次 git 状态刷新（防抖在 git-service）
        scheduleGitRefresh(sessionId)
        break

      case 'tool_progress': {
        // 引擎在累积工具参数期间推送的进度：这段时间没有其它事件，用它显示「正在写入 · 1.2k 字符」。
        const tp = event.data ?? {}
        updateSessionRuntime(sessionId, {
          toolProgress: { name: String(tp.name ?? ''), chars: Number(tp.chars ?? 0) },
        })
        break
      }

      case 'tool_call': {
        const trTc = activeTraces.get(sessionId)
        const toolCallId = event.data?.id
        if (trTc && typeof toolCallId === 'string') {
          trTc.toolCallIds.add(toolCallId)
        }
        // 参数已生成完、工具开始执行 —— 进度该收了
        updateSessionRuntime(sessionId, { toolProgress: null })
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
        // engine.iteration.verify / fix
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
          // 跑完最后一条回复：本轮 agent 循环总耗时挂到最后一条助手消息上（界面在 message-actions 显示）。
          // 只在这条分支写：paused 是挂起、error / 用户取消根本不会走到 stream_end，都不算「完成整个循环」。
          recordAgentElapsed(sessionId, totalMs, trEnd?.rounds ?? 0)
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
          // 埋点：AI 回复正文 —— 每轮 assistant 结束时发一次
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
          // 本轮真正结束（非 paused）→ 落地任务清单草稿；paused 分支刻意不落地（草稿留到恢复后合并）
          flushTodoDraft(sessionId, 'stream_end')
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
 * 本轮 agent 循环总耗时 → 挂到最后一条助手消息的 `uiData` 上（
 * `utils/messageMeta.ts::AGENT_ELAPSED_KEY`，随消息落库）。
 *
 * 只认「最后一条助手消息」：气泡的操作栏只在它身上渲染；更早的回合挂上去会张冠李戴。
 * 最后一条没有可见内容（空壳）时不写 —— 那种气泡连操作栏都没有，写了也看不到。
 *
 * `rounds` 是本轮 LLM 轮次数（`assistant_message_created` 计数）：为 0 说明这一轮没产出任何
 * 助手消息，最后一条属于上一回合，不能拿本轮耗时去标它。
 * 暂停恢复的那一轮从「恢复时刻」起算（`activeTraces` 在 resumePausedRun 里重建），不含挂起前的部分。
 */
function recordAgentElapsed(
  sessionId: string,
  totalMs: number | undefined,
  rounds: number,
): void {
  if (!totalMs || totalMs <= 0 || rounds <= 0) return
  const messages = getSessionMessages(sessionId)
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'assistant') continue
    if (!messageHasVisibleContent(messages[i])) return
    setAgentElapsedMs(sessionId, messages[i].id, totalMs)
    return
  }
}

/**
 * 还原 assistant 消息补丁：把流式增量补丁拼成完整正文。
 *
 * 引擎流式期间只回传增量（全量会让 IPC 载荷 O(n²)），结束帧仍回传全量 patch.content。
 * 拼不上时退化为「只应用其余字段」，交给结束帧纠正 —— 不做猜测式兜底。
 */
function resolveAssistantPatch(
  sessionId: string,
  messageId: string,
  patch: Record<string, any>,
): Partial<Message> {
  if (typeof patch?.contentDelta !== 'string') return patch
  const { contentDelta, ...rest } = patch
  const current = getSessionMessage(sessionId, messageId)?.content
  if (typeof current !== 'string') return rest
  return { ...rest, content: current + contentDelta }
}

/** 会话的工作目录 —— 会话活动的 git 自动刷新用它定位要刷新的仓库 */
function workspaceOf(sessionId: string): string | null {
  return sessionStore.getSession(sessionId)?.workspace || null
}

/**
 * 会话有活动（工具调用结束 / 一轮对话结束）→ 排期一次工作目录的 git 刷新。
 * ⚠️ 只认当前选中的会话：后台会话的活动与用户看到的目录无关。
 */
function scheduleGitRefresh(sessionId: string): void {
  if (chatState.value.currentSessionId !== sessionId) return
  notifyWorkspaceActivity(workspaceOf(sessionId))
}

/**
 * 取该会话最后一条有正文的助手消息，作为完成提醒的预览。拿不到时返回空串，交给 Rust 用标题兜底。
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

/** 收尾：清理本轮运行的 runtime state（暂停态则保留 working/paused）。 */
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
  // 无论是否带 traceId 都回收链路上下文，否则 activeTraces / sessionTraces 持续残留。
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
      // 本轮结束：工具进度必须一起收，否则界面会一直挂着「正在生成…」
      toolProgress: null,
    })
    events?.onWorkingChange?.(sessionId, false)
    events?.onMessagesUpdate?.(sessionId)
    // 一轮对话跑完：期间的工具调用很可能改过工作区文件 → 排期一次 git 刷新
    scheduleGitRefresh(sessionId)
    // 托盘提醒：真的跑完（含出错）才提醒；是否打扰、走哪条通道由 Rust 判断（窗口聚焦时不打扰）
    const errored = !!tr?.errored
    trayNotifyCompleted(sessionId, {
      title: sessionStore.getSession(sessionId)?.title ?? '',
      // 空正文（只调工具、没输出文本）用 i18n 文案兜底 —— 系统通知正文不能是空的；
      // 文案由前端给（原生侧不养第二套语言逻辑）
      preview:
        lastAssistantPreview(sessionId) ||
        t(errored ? 'AI 回复出错' : 'AI 回复完成'),
      status: errored ? 'error' : 'success',
    })
  }

  // 自动设置标题（仅标题仍为默认值「新对话」时触发一次）：优先生成，关闭或失败回退到用户消息截取
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
          // 设置项关闭时不发起标题生成的 LLM 调用
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
