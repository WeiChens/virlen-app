/**
 * toolInteractEvent — 工具交互事件总线
 *
 * 连接 chat-service（工具调用层）与 tool-ui（UI 层），取代所有 window.* 全局挂载。
 *
 * 事件清单：
 *   user_choice 系列：
 *     showChoice  → chat-service 触发，tool-ui 监听打开选择弹窗
 *     resolve     → tool-ui 触发确认结果，chat-service 收到后 resolve Promise
 *     reject      → tool-ui 触发取消/暂存，chat-service 收到后 reject Promise
 *
 *   command_confirm 系列：
 *     showCommandConfirm → chat-service 触发，tool-ui 监听打开命令确认弹窗
 *     commandResolve     → tool-ui 触发"允许执行"，chat-service 收到后 resolve
 *     commandReject      → tool-ui 触发拒绝/暂存，chat-service 收到后 reject
 */
import { ToolExecutorResponse } from '@/domain/tools/types'
import EventEmitter from '@/utils/EventEmitter'

type ToolInteractEvents = {
  // user_choice
  showChoice: (
    sessionId: string,
    question: string,
    options: string[],
    multi: boolean,
    toolCallId: string,
  ) => void
  resolve: (value: string) => void
  reject: (reason: string) => void

  // command_confirm
  showCommandConfirm: (
    sessionId: string,
    command: string,
    risk: string,
    label: string,
    hint: string,
    tips?: string,
  ) => void
  commandResolve: (value: string) => void
  commandReject: (reason: string) => void

  /**
   * 用户同意执行命令
   * @param approvalId  本次审批的唯一标识（由 execute_command 生成并随弹窗数据下发）
   * @param sessionId
   * @param toolCallId
   * @param callback
   */
  userAllowCmd: (
    approvalId: string,
    sessionId: string,
    toolCallId: string,
    callback: { result: Promise<ToolExecutorResponse> | null },
  ) => void

  /**
   * 用户拒绝执行命令 — 通知 execute_command 侧清理待审批注册表，避免内存泄漏
   * @param approvalId
   * @param sessionId
   * @param toolCallId
   */
  userCmdRejected: (
    approvalId: string,
    sessionId: string,
    toolCallId: string,
  ) => void
}

const toolInteractEvent = new EventEmitter<ToolInteractEvents>()

export default toolInteractEvent
