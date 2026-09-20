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
 *   授权（authorization）系列 —— 通用的「授权确认」弹窗（不限于命令/脚本）：
 *     showAuthorization → tool 层触发，tool-ui 监听打开授权确认弹窗
 *     commandResolve    → tool-ui 触发“允许”，tool 层收到后 resolve
 *     commandReject     → tool-ui 触发拒绝/暂存，tool 层收到后 reject
 */
import { ToolExecutorResponse, ToolResult } from '@/domain/tools/types'
import EventEmitter from '@/utils/EventEmitter'

/**
 * 一次授权确认请求（通用，不限于命令/脚本）。
 *
 * 未来的授权类型（如自定义权限）只需构造同样的结构即可复用同一个弹窗。
 */
export interface AuthorizationRequest {
  /** 权限唯一 key（跨 TS / Rust 稳定契约），如 `terminal.normal.execute` */
  permName: string
  /** 权限名称（展示，即 permissionLabel） */
  title: string
  /** 副标题：AI 给出的操作说明（命令的 `tips`） */
  subTitle?: string
  /** 正文：具体内容（命令文本 / 脚本正文等） */
  desc?: string
  /**
   * 实际执行的 shell 命令（仅当 `desc` 不是命令本身时提供，如脚本正文）。
   * 命令工具不设置此字段（`desc` 本身就是命令）。
   */
  command?: string
  /** 风险 / 警告提示（风险提示 + 绕过沙盒警告，可空） */
  hint?: string
  /** 风险等级（仅用于配色，可空） */
  risk?: string
}

type ToolInteractEvents = {
  // user_choice
  showChoice: (
    sessionId: string,
    question: string,
    options: string[],
    multi: boolean,
    toolCallId: string,
  ) => void
  resolve: (value: ToolResult) => void
  reject: (reason: string) => void

  // authorization（授权确认）
  showAuthorization: (payload: AuthorizationRequest) => void
  commandResolve: (value: string) => void
  commandReject: (reason: string) => void

  /**
   * Step 2 ① 终端内确认（纯 UI 事件，组件 → tool-service，不让组件直接摸 service）：
   * 用户在某 toolCallId 的终端块里改完命令并按 Enter。
   */
  terminalConfirmSubmit: (toolCallId: string, command: string) => void
  /** Step 2 ①：用户在终端块里取消（Esc / Ctrl+C）。 */
  terminalConfirmCancel: (toolCallId: string) => void

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
