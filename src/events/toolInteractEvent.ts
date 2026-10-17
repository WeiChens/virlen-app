/**
 * 工具交互事件总线：连接 chat-service（工具层）与 tool-ui（UI 层）。
 *
 * ⚠️ 核心不变量：每次「提问 / 授权」都有唯一 interactionId，应答方必须原样回传。
 * 一次 run 内可并发挂起多个交互，没有 id 就会串扰。
 *
 * 路由依据：提问 / 授权按 interactionId，终端内确认按 toolCallId，原始审批注册表按 approvalId。
 * interactionSettled 是终态广播：第二个应答端据此收起 UI，应答发起端收到应为幂等无操作。
 */
import { ToolExecutorResponse, ToolResult } from '@/domain/tools/types'
import EventEmitter from '@/utils/EventEmitter'

/**
 * 一次交互的公共标识。应答方必须把 interactionId 原样回传 —— 多交互并发时精确路由的唯一依据。
 */
export interface InteractionRef {
  /** 本次交互的唯一 id（每弹一次生成一个） */
  interactionId: string
  /** 归属会话（手机端据此路由到对应会话的视图） */
  sessionId: string
  /** 关联的 tool call id（用于在消息流里定位到具体的工具块） */
  toolCallId: string
}

/** 用户选择（user_choice tool）的请求载荷 */
export interface ChoiceRequest extends InteractionRef {
  /** 问题文本 */
  question: string
  /** 选项列表 */
  options: string[]
  /** 是否多选 */
  multi: boolean
}

/** 一次授权确认请求（通用，不限于命令 / 脚本） */
export interface AuthorizationRequest extends InteractionRef {
  /** 权限唯一 key（跨 TS / Rust 稳定契约），如 terminal.normal.execute */
  permName: string
  /** 权限名称（展示，即 permissionLabel） */
  title: string
  /** 副标题：AI 给出的操作说明（命令的 tips） */
  subTitle?: string
  /** 正文：具体内容（命令文本 / 脚本正文等） */
  desc?: string
  /**
   * 实际执行的 shell 命令（仅当 desc 不是命令本身时提供）。命令工具不设此字段。
   */
  command?: string
  /** 风险 / 警告提示（风险提示 + 绕过沙盒警告，可空） */
  hint?: string
  /** 风险等级（仅用于配色，可空） */
  risk?: string
  /**
   * AI 申请「不使用沙盒」执行本次操作，供手机控制侧审批分级用（脱壳是高危面，需二次确认）。
   * 不参与弹窗渲染（警告文案已在 hint 里）。
   */
  sandboxBypass?: boolean
}

/**
 * 一次交互的最终归宿。
 * expired = 没人回答（随运行结束被收敛），与 reject（用户点了拒绝）是两件事。
 */
export type InteractionOutcome = 'allow' | 'reject' | 'shelve' | 'expired'

type ToolInteractEvents = {
  // user_choice
  showChoice: (payload: ChoiceRequest) => void
  resolve: (interactionId: string, value: ToolResult) => void
  reject: (interactionId: string, reason: string) => void

  // authorization（授权确认）
  showAuthorization: (payload: AuthorizationRequest) => void
  commandResolve: (interactionId: string, value: string) => void
  commandReject: (interactionId: string, reason: string) => void

  /** 某个交互已被应答 —— 其他应答端据此收起自己的 UI（幂等） */
  interactionSettled: (
    interactionId: string,
    outcome: InteractionOutcome,
  ) => void

  /**
   * 终端内确认（组件 → tool-service，不让组件直接摸 service）：用户改完命令并按 Enter。
   */
  terminalConfirmSubmit: (toolCallId: string, command: string) => void
  /** 用户在终端块里取消（Esc / Ctrl+C）。 */
  terminalConfirmCancel: (toolCallId: string) => void

  /** 用户同意执行命令 */
  userAllowCmd: (
    approvalId: string,
    sessionId: string,
    toolCallId: string,
    callback: { result: Promise<ToolExecutorResponse> | null },
  ) => void

  /** 用户拒绝执行命令 —— 通知 execute_command 侧清理待审批注册表。 */
  userCmdRejected: (
    approvalId: string,
    sessionId: string,
    toolCallId: string,
  ) => void
}

const toolInteractEvent = new EventEmitter<ToolInteractEvents>()

export default toolInteractEvent
