/**
 * 会话消息格式修复（悬空 tool_calls）+ 发送前准备
 *
 * 场景：应用在「LLM 已产出 tool_calls、工具还没返回」时被中断（崩溃/强杀），
 * assistant(tool_calls) 已落库但 tool 结果没写入，下次请求会被服务端以 400 拒绝：
 *   An assistant message with 'tool_calls' must be followed by tool messages ...
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
 * 把内存里的消息窗口整体回写 SQLite（按「从第一条已加载消息起」的**后缀替换**）。
 *
 * 为什么是后缀替换而不是 `cmd_replace_session_messages`（全量替换）：
 * 分页加载下内存里可能只有一段**连续后缀窗口**（尾部 N 条 / 到最后一条 summary 为止），
 * 全量替换会把「还没加载的更早消息」抹掉；后缀替换只动已加载的那一段，更早的历史原样保留。
 * 窗口就是整份历史时两者等价（删除从第一条起 = 清空）。
 *
 * 内存修复本身已经生效；落库失败 / 非 Tauri 环境静默处理，不影响本次请求。
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
 * 发送前准备历史消息：加载「模型当前上下文」（最后一条 summary 起）→ 检测并修复格式异常
 * → 只返回「最后一条 summary 及其之后」那一段交给引擎。
 *
 * 修复必须发生在请求构造之前，否则服务端会以 400 拒绝：
 *   An assistant message with 'tool_calls' must be followed by tool messages ...
 *
 * @param sessionId 会话 ID
 * @param options.repair=false 时跳过修复（暂停恢复场景：悬空 tool_calls 是待执行的，
 *        不能补占位，否则会和恢复后写入的真实工具结果重复）
 */
export async function prepareMessagesForSend(
  sessionId: string,
  options?: { repair?: boolean },
): Promise<Message[]> {
  // 只加载「模型当前上下文」所需（最后一条 summary 起），不再强制全量：
  // 请求组装本就丢掉 summary 之前的消息，把它们加载进内存 / 经 IPC 传过去纯属浪费。
  await sessionStore.ensureContextLoaded(sessionId)

  const rt = sessionRuntimeState.value.sessions[sessionId]
  if (options?.repair !== false && !rt?.paused) {
    checkAndRepairMessageList(sessionId, false, 'send')
  }
  const messages = getSessionMessages(sessionId)
  // 交给引擎的只需「最后一条 summary 及其之后」这一段：
  // Rust `slice_messages` / TS `buildRequest` 同样会切片，这里先裁掉可省一次 O(历史) 的 IPC。
  const idx = getLastSummaryMessageIndex(messages)
  return idx > 0 ? messages.slice(idx) : messages
}

/**
 * 检测并修复会话消息格式异常（assistant tool_calls 缺少对应 tool 返回）
 *
 * 场景：应用在「LLM 已产出 tool_calls、工具还没返回」时被中断（崩溃/强杀），
 * assistant(tool_calls) 已落库但 tool 结果没写入，下次请求会被服务端以 400 拒绝：
 *   An assistant message with 'tool_calls' must be followed by tool messages ...
 *
 * 修复：为悬空的 tool_call_id 补一条占位 tool 消息（内容「程序中断」），
 * 让历史重新满足协议约束；错位的返回消息则归位。
 *
 * 只扫描首/尾窗口（默认各 REPAIR_SCAN_WINDOW 条），不扫全量历史（见 message-repair.ts）。
 * 修正结果先落内存（UI 立即可见），并同步按「后缀替换」回写 SQLite —— 只动已加载的那段
 * 连续后缀窗口，更早的历史原样保留（见 flushRepairedMessages）。
 *
 * @param sessionId 会话 ID
 * @param isWorking 该会话正在回复中则跳过（不能打断进行中的 tool 循环）
 * @param phase     埋点用：switch=切换会话触发，send=发送前触发
 * @returns 本次补入 + 归位的消息条数
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

  const repairedCount = result.inserted + result.moved
  track('session.repair', {
    session_id: hashText(sessionId),
    repaired_count: repairedCount,
    inserted_count: result.inserted,
    moved_count: result.moved,
    scan_window: REPAIR_SCAN_WINDOW,
    phase,
  })
  return repairedCount
}

/**
 * 修复会话消息异常（如未响应的 tool call）
 * 切换会话时由 UI 触发，由 Application 层执行业务规则
 */
export function repairSessionIfNeeded(
  sessionId: string,
  isWorking?: boolean,
): void {
  checkAndRepairMessageList(sessionId, isWorking, 'switch')
}
