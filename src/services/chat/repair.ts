/**
 * 会话消息格式修复（悬空 tool_calls）+ 发送前准备。中断时会留下 assistant(tool_calls) 但无 tool 结果，
 * 下次请求会被服务端 400 拒绝，故必须在构造请求前修。
 */
import { sessionRuntimeState, sessionStore } from '@/ui/store'
import { getLastSummaryMessageIndex } from '@/types'
import type { Message } from '@/types'
import { invoke } from '@tauri-apps/api/core'
import {
  REPAIR_SCAN_WINDOW,
  isRepaired,
  repairToolCallMessages,
} from '@/services/message-repair'
import { getSessionMessages, setSessionMessagesInPlace } from './messages'
import { hashText, track } from '@/utils/telemetry'
import { sanitizeLoneSurrogates } from '@/utils/text'

/**
 * 把内存消息窗口按「从第一条已加载消息起」的后缀回写 SQLite：分页下内存可能只有一段连续后缀，
 * 全量替换会抹掉更早的未加载消息。失败 / 非 Tauri 静默忽略。
 */
function flushRepairedMessages(sessionId: string): void {
  const messages = getSessionMessages(sessionId)
  if (!messages.length) return
  try {
    void invoke('cmd_replace_session_messages_from', {
      sessionId,
      fromMessageId: messages[0].id,
      // 兜底：修复后的历史同样不能带孤立代理（否则这条 IPC 静默失败）
      messages: sanitizeLoneSurrogates(messages),
    }).catch(() => {})
  } catch {
    // 非 Tauri 环境忽略
  }
}

/**
 * 发送前准备历史：加载模型上下文（最后一条 summary 起）→ 修复格式异常 → 只返回该段。
 * @param options.repair=false 跳过修复（暂停恢复：悬空 tool_calls 是待执行的）
 */
export async function prepareMessagesForSend(
  sessionId: string,
  options?: { repair?: boolean },
): Promise<Message[]> {
  // 只加载「模型当前上下文」所需（最后一条 summary 起）：请求组装本就丢掉更早的消息，全量加载纯属浪费。
  await sessionStore.ensureContextLoaded(sessionId)

  const rt = sessionRuntimeState.value.sessions[sessionId]
  if (options?.repair !== false && !rt?.paused) {
    checkAndRepairMessageList(sessionId, false, 'send')
  }
  const messages = getSessionMessages(sessionId)
  // 交给引擎的只需「最后一条 summary 及其之后」：Rust/TS 也会切片，这里先裁可省一次 O(历史) 的 IPC。
  const idx = getLastSummaryMessageIndex(messages)
  return idx > 0 ? messages.slice(idx) : messages
}

/**
 * 检测并修复消息格式异常（补占位 / 去重 / 丢孤儿 / 归位，细则见 message-repair.ts）：
 * 补占位与归位只扫首/尾窗口，去重与丢孤儿全量。先落内存（UI 立即可见）再按后缀回写 SQLite。
 * @param isWorking 回复中则跳过（不打断进行中的 tool 循环）
 * @param phase     埋点：switch=切换会话，send=发送前
 */
export function checkAndRepairMessageList(
  sessionId: string,
  isWorking?: boolean,
  phase: 'switch' | 'send' = 'switch',
): number {
  if (isWorking) return 0

  const session = sessionStore.getSession(sessionId)
  if (!session || session.messages.length === 0) return 0

  const result = repairToolCallMessages(session.messages)
  if (!isRepaired(result)) return 0

  setSessionMessagesInPlace(sessionId, result.messages)
  flushRepairedMessages(sessionId)

  const repairedCount =
    result.inserted +
    result.moved +
    result.removedDuplicates +
    result.removedOrphans
  track('session.repair', {
    session_id: hashText(sessionId),
    repaired_count: repairedCount,
    inserted_count: result.inserted,
    moved_count: result.moved,
    removed_duplicate_count: result.removedDuplicates,
    removed_orphan_count: result.removedOrphans,
    scan_window: REPAIR_SCAN_WINDOW,
    phase,
  })
  return repairedCount
}

/** 切换会话时触发修复（UI 调用，业务规则由 Application 层执行）。 */
export function repairSessionIfNeeded(
  sessionId: string,
  isWorking?: boolean,
): void {
  checkAndRepairMessageList(sessionId, isWorking, 'switch')
}
