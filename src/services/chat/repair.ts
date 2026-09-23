/**
 * 会话消息格式修复（悬空 tool_calls）+ 发送前准备
 *
 * 场景：应用在「LLM 已产出 tool_calls、工具还没返回」时被中断（崩溃/强杀），
 * assistant(tool_calls) 已落库但 tool 结果没写入，下次请求会被服务端以 400 拒绝：
 *   An assistant message with 'tool_calls' must be followed by tool messages ...
 */
import { sessionRuntimeState, sessionStore } from '@/ui/store'
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
 * 已检测出格式异常、补入了占位 tool 消息，但当时历史尚未全量加载、还没能整体回写落库的会话。
 *
 * 分页加载下「切换会话」时内存里只有尾部窗口，此时整体回写 SQLite 会把没拉取的旧消息抹掉，
 * 故先记账，等发送前 ensureAllMessagesLoaded 之后再补落库。
 */
const pendingRepairFlush = new Set<string>()

/**
 * 把修复后的完整消息列表整体回写 SQLite（全量写保证行序与内存一致）。
 *
 * - 仅当历史已全量在内存时执行，否则记为待落库（见 pendingRepairFlush）
 * - 内存修复本身已经生效，落库失败/非 Tauri 环境静默处理，不影响本次请求
 */
function flushRepairedMessages(sessionId: string): void {
  if (!sessionStore.isMessagesFullyLoaded(sessionId)) {
    pendingRepairFlush.add(sessionId)
    return
  }
  pendingRepairFlush.delete(sessionId)
  const messages = getSessionMessages(sessionId)
  if (!messages.length) return
  try {
    void invoke('cmd_replace_session_messages', {
      sessionId,
      // 兜底：修复后的历史同样不能带孤立代理（否则这条 IPC 静默失败）
      messages: sanitizeLoneSurrogates(messages),
    }).catch(() => {})
  } catch {
    // 非 Tauri 环境忽略
  }
}

/**
 * 发送前准备历史消息：全量加载 → 补落库（如有待落库修复）→ 检测并修复格式异常。
 *
 * 修复必须发生在请求构造之前，否则服务端会以 400 拒绝：
 *   An assistant message with 'tool_calls' must be followed by tool messages ...
 *
 * @param sessionId 会话 ID
 * @param options.repair=false 时只做全量加载（暂停恢复场景：悬空 tool_calls 是待执行的，
 *        不能补占位，否则会和恢复后写入的真实工具结果重复）
 */
export async function prepareMessagesForSend(
  sessionId: string,
  options?: { repair?: boolean },
): Promise<Message[]> {
  // 分页加载下，发送前需确保完整历史都在内存，否则会截断 LLM 上下文
  await sessionStore.ensureAllMessagesLoaded(sessionId)
  // 历史已全量加载：补落库此前只能内存修复的结果
  if (pendingRepairFlush.has(sessionId)) flushRepairedMessages(sessionId)

  const rt = sessionRuntimeState.value.sessions[sessionId]
  if (options?.repair !== false && !rt?.paused) {
    checkAndRepairMessageList(sessionId, false, 'send')
  }
  return getSessionMessages(sessionId)
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
 * 修正结果先落内存（UI 立即可见），历史已全量加载时同步整体回写 SQLite，
 * 否则记账，等发送前全量加载后再落库（见 prepareMessagesForSend）。
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
