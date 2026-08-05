/**
 * command-approval — 命令审批注册表
 *
 * 负责 execute_command 工具与 command_confirm 交互层之间的审批协调。
 * 按 approvalId 精确匹配，避免旧实现（全局 once 监听）在多个命令同时待确认时
 * 被第一个事件（即使不匹配）消费掉的问题。
 */
import type { ToolExecutorResponse } from '@/domain/tools/types'
import { v4 } from '@/utils/uuid'
import toolInteractEvent from '@/events/toolInteractEvent'

/** 一次待审批的命令 */
export interface PendingApproval {
  sessionId: string
  toolCallId: string
  run: () => Promise<ToolExecutorResponse>
}

const pendingApprovals = new Map<string, PendingApproval>()
let listenerInstalled = false

/**
 * 注册一次待审批命令，返回唯一 approvalId。
 * 用户确认后，command_confirm 侧 emit userAllowCmd(approvalId, ...) 触发执行；
 * 用户拒绝后，emit userCmdRejected(approvalId, ...) 清理注册表。
 */
export function registerPendingApproval(entry: PendingApproval): string {
  installListener()
  const approvalId = v4()
  pendingApprovals.set(approvalId, entry)
  return approvalId
}

/** 安装常驻审批监听器（只安装一次，按 approvalId 精确分发） */
function installListener(): void {
  if (listenerInstalled) return
  listenerInstalled = true

  toolInteractEvent.on(
    'userAllowCmd',
    (approvalId, sessionId, toolCallId, callback) => {
      const entry = pendingApprovals.get(approvalId)
      if (!entry) return
      if (entry.sessionId !== sessionId || entry.toolCallId !== toolCallId) {
        return
      }
      pendingApprovals.delete(approvalId)
      callback.result = entry.run()
    },
  )

  // 用户拒绝 → 清理注册表，避免内存泄漏
  toolInteractEvent.on(
    'userCmdRejected',
    (approvalId, sessionId, toolCallId) => {
      const entry = pendingApprovals.get(approvalId)
      if (
        entry &&
        entry.sessionId === sessionId &&
        entry.toolCallId === toolCallId
      ) {
        pendingApprovals.delete(approvalId)
      }
    },
  )
}
