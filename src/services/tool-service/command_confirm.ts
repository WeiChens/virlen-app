/**
 * command_confirm — 授权确认弹窗的交互逻辑（命令 / 脚本 / 沙盒脱壳等，通用）
 *
 * handler 收到 confirm_command 后：
 * 1. 弹「授权确认」弹窗（展示权限唯一 key + title / sub-title / desc）
 * 2. 用户点「允许」→ handler 自己调 runCommand 执行，把结果 resolve 回去
 * 3. 用户点「拒绝」→ reject 'cancelled'
 * 4. 用户点「暂存」→ throw InteractionShelved
 *
 * ⚠️ handler 只负责「问用户」与「放行 / 拒绝」，**不做任何脱壳决策**：
 *    「忽略沙盒命令」规则（设置 → 安全）在审批**之前**就定了这条命令是否强制无沙盒执行
 *    ——TS 引擎在 `tools/execute/*.ts`、Rust 引擎 / CLI 在 `src-tauri/virlen-core/src/security/`
 *    （S7 起匹配完全在 Rust 侧，不再经桥问 JS）。命中规则时**根本走不到这里**，
 *    不要在本文里再加规则匹配（两处匹配会分叉）。
 */
import { ToolExecutorResponse } from '@/domain/tools/types'
import toolInteractEvent from '@/events/toolInteractEvent'
import { toolOutputStore } from '@/infrastructure/tools/output-store'
import { track } from '@/utils/telemetry'

class InteractionShelved extends Error {
  shelveMessage: string
  constructor(message: string = '用户暂存了交互') {
    super(message)
    this.name = 'InteractionShelved'
    this.shelveMessage = message
  }
}

export interface CommandConfirmHandles {
  handler: (
    type: string,
    data: Record<string, any>,
  ) => Promise<ToolExecutorResponse>
  cleanup: () => void
}

export function createCommandConfirmHandles(
  sessionId: string,
): CommandConfirmHandles {
  let interactionResolve: ((value: ToolExecutorResponse) => void) | null = null
  let interactionReject: ((reason: any) => void) | null = null
  let pendingCommand = ''
  let pendingToolCallId = ''
  let pendingApprovalId = ''
  let showTime = 0

  /**
   * 放行：执行待审批命令并把结果 resolve 回去。
   * 用户点「允许」（commandResolve 事件）与规则自动放行共用同一条路径，
   * 保证两种入口的执行语义完全一致。
   */
  async function doAllow() {
    const resolve = interactionResolve
    const toolCallId = pendingToolCallId
    const approvalId = pendingApprovalId
    interactionResolve = null
    interactionReject = null
    pendingCommand = ''
    pendingToolCallId = ''
    pendingApprovalId = ''

    if (!resolve) return

    try {
      const result = {
        result: null as Promise<ToolExecutorResponse> | null,
      }
      toolInteractEvent.emit(
        'userAllowCmd',
        approvalId,
        sessionId,
        toolCallId,
        result,
      )
      if (result.result == null) {
        resolve('[error] command not found')
        return
      }
      result.result
        .then((r: ToolExecutorResponse) => resolve(r))
        .catch((e: any) => resolve(`[error] ${e.message || String(e)}`))
    } catch (e: any) {
      resolve(`[error] ${e.message || String(e)}`)
    }
  }

  const offResolve = toolInteractEvent.on(
    'commandResolve',
    async (_value: string) => {
      const approvalId = pendingApprovalId
      track('interaction.command.confirm.result', {
        approval_id: approvalId,
        action: 'allow',
        latency_ms: showTime ? Date.now() - showTime : undefined,
      })
      await doAllow()
    },
  )
  const offReject = toolInteractEvent.on('commandReject', (reason: string) => {
    const reject = interactionReject
    const cmd = pendingCommand
    const toolCallId = pendingToolCallId
    const approvalId = pendingApprovalId
    interactionResolve = null
    interactionReject = null
    // pendingCommand = ''
    // pendingToolCallId = ''
    if (!reject) return
    track('interaction.command.confirm.result', {
      approval_id: approvalId,
      action: reason.startsWith('shelve:') ? 'shelve' : 'reject',
      latency_ms: showTime ? Date.now() - showTime : undefined,
    })
    if (!reason.startsWith('shelve:')) {
      track('interaction.cancel', { phase: 'command_confirm' })
    }
    if (reason.startsWith('shelve:')) {
      reject(new InteractionShelved(reason.slice(7)))
    } else {
      // 通知 execute_command 侧清理待审批注册表，避免内存泄漏
      if (approvalId) {
        toolInteractEvent.emit(
          'userCmdRejected',
          approvalId,
          sessionId,
          toolCallId,
        )
      }
      reject(reason || 'cancelled')
      // 拒绝的命令也写一条记录到 tool output
      if (cmd) {
        try {
          toolOutputStore.append(toolCallId, `[User rejected] ${cmd}\n`)
        } catch {}
      }
    }
  })

  return {
    handler: async (_type: string, data: Record<string, any>) => {
      pendingCommand = data.command || data.desc || ''
      pendingToolCallId = data.toolCallId || ''
      pendingApprovalId = data.approvalId || ''
      showTime = Date.now()
      track('interaction.command.confirm.show', {
        approval_id: pendingApprovalId,
        perm_name: data.permName,
        command: pendingCommand,
        command_len: pendingCommand.length,
        risk: data.risk,
        // 申请「不使用沙盒」执行时留痕（便于事后审计，见 AGENTS §9）
        sandbox_bypass: data.sandboxBypass === true ? true : undefined,
      })
      return new Promise<ToolExecutorResponse>((resolve, reject) => {
        interactionResolve = resolve
        interactionReject = reject
        toolInteractEvent.emit('showAuthorization', {
          permName: data.permName || '',
          title: data.title || '',
          subTitle: data.subTitle,
          desc: data.desc,
          command: data.command,
          hint: data.hint,
          risk: data.risk,
        })
      })
    },
    cleanup: () => {
      offResolve()
      offReject()
    },
  }
}

/**
 * 原生命令审批 handles — Rust 原生 execute_command 的审批交互
 *
 * 与 createCommandConfirmHandles 的差异：
 * - 不注册 JS 侧审批（approvalId），命令由 Rust 原生执行
 * - 用户「允许」→ resolve('approved')，Rust 收到后直接执行命令
 * - 用户「拒绝/暂存」→ reject，Rust 收到 cancelled / shelved
 */
export function createNativeCommandConfirmHandles(
  sessionId: string,
): CommandConfirmHandles {
  let interactionResolve: ((value: ToolExecutorResponse) => void) | null = null
  let interactionReject: ((reason: any) => void) | null = null
  let pendingCommand = ''
  let pendingToolCallId = ''
  let pendingApprovalId = ''
  let showTime = 0

  const offResolve = toolInteractEvent.on(
    'commandResolve',
    async (_value: string) => {
      const resolve = interactionResolve
      const toolCallId = pendingToolCallId
      const approvalId = pendingApprovalId
      interactionResolve = null
      interactionReject = null
      pendingCommand = ''
      pendingToolCallId = ''
      pendingApprovalId = ''
      if (!resolve) return

      track('interaction.command.confirm.result', {
        approval_id: approvalId,
        action: 'allow',
        latency_ms: showTime ? Date.now() - showTime : undefined,
      })

      // 原生命令：只回「允许」标记，实际执行由 Rust 完成
      resolve('approved')
      // 记录到 tool output
      try {
        toolOutputStore.append(toolCallId, '[User approved] command executed natively\n')
      } catch {}
    },
  )
  const offReject = toolInteractEvent.on('commandReject', (reason: string) => {
    const reject = interactionReject
    const cmd = pendingCommand
    const toolCallId = pendingToolCallId
    const approvalId = pendingApprovalId
    interactionResolve = null
    interactionReject = null
    pendingApprovalId = ''
    if (!reject) return
    track('interaction.command.confirm.result', {
      approval_id: approvalId,
      action: reason.startsWith('shelve:') ? 'shelve' : 'reject',
      latency_ms: showTime ? Date.now() - showTime : undefined,
    })
    if (!reason.startsWith('shelve:')) {
      track('interaction.cancel', { phase: 'command_confirm' })
    }
    if (reason.startsWith('shelve:')) {
      reject(new InteractionShelved(reason.slice(7)))
    } else {
      reject(reason || 'cancelled')
      if (cmd) {
        try {
          toolOutputStore.append(toolCallId, `[User rejected] ${cmd}\n`)
        } catch {}
      }
    }
  })

  // Step 2 ①：终端内确认（UI 组件 emit → 这里 resolve / reject）。
  const offTermSubmit = toolInteractEvent.on(
    'terminalConfirmSubmit',
    (toolCallId, command) => {
      const resolve = interactionResolve
      // 只响应当前待确认的那个 toolCallId（多命令并发 / 跨 session 不互抄）
      if (!resolve || toolCallId !== pendingToolCallId) return
      const approvalId = pendingApprovalId
      interactionResolve = null
      interactionReject = null
      pendingCommand = ''
      pendingToolCallId = ''
      pendingApprovalId = ''
      track('interaction.command.confirm.result', {
        approval_id: approvalId,
        action: 'allow',
        latency_ms: showTime ? Date.now() - showTime : undefined,
      })
      toolOutputStore.clearPendingConfirm(toolCallId)
      // ⚠️ 必须回传命令正文：用户可能改过，只回「批准」会让 Rust 跑旧命令
      resolve(JSON.stringify({ approved: true, command }))
    },
  )
  const offTermCancel = toolInteractEvent.on(
    'terminalConfirmCancel',
    (toolCallId) => {
      const reject = interactionReject
      if (!reject || toolCallId !== pendingToolCallId) return
      const approvalId = pendingApprovalId
      interactionResolve = null
      interactionReject = null
      pendingApprovalId = ''
      track('interaction.command.confirm.result', {
        approval_id: approvalId,
        action: 'reject',
        latency_ms: showTime ? Date.now() - showTime : undefined,
      })
      track('interaction.cancel', { phase: 'command_confirm' })
      toolOutputStore.clearPendingConfirm(toolCallId)
      reject('cancelled')
    },
  )

  return {
    handler: async (_type: string, data: Record<string, any>) => {
      pendingCommand = data.command || data.desc || ''
      pendingToolCallId = data.toolCallId || ''
      // 原生路径 Rust 不下发 approvalId，回退用 toolCallId 作为审批关联 ID
      pendingApprovalId = data.approvalId || data.toolCallId || ''
      showTime = Date.now()
      track('interaction.command.confirm.show', {
        approval_id: pendingApprovalId,
        perm_name: data.permName,
        command: pendingCommand,
        command_len: pendingCommand.length,
        risk: data.risk,
        // 原生路径同样留痕（sandbox:"off" 由 Rust 下发该标记）
        sandbox_bypass: data.sandboxBypass === true ? true : undefined,
        // Step 2 ①：留痕呈现方式（terminal 由 Rust 判定并下发）
        presentation: data.presentation,
      })
      return new Promise<ToolExecutorResponse>((resolve, reject) => {
        interactionResolve = resolve
        interactionReject = reject
        // Step 2 ①：Rust 判定「走终端」时**不弹 modal**，改在该 toolCallId 的终端块里
        // 渲染可编辑命令行。走哪条路只由 Rust 下发的 presentation 决定（前端不猜平台）。
        if (data.presentation === 'terminal') {
          toolOutputStore.setPendingConfirm(pendingToolCallId, {
            permName: data.permName,
            title: data.title,
            subTitle: data.subTitle,
            desc: data.desc,
            hint: data.hint,
            risk: data.risk,
          })
          return
        }
        toolInteractEvent.emit('showAuthorization', {
          permName: data.permName || '',
          title: data.title || '',
          subTitle: data.subTitle,
          desc: data.desc,
          command: data.command,
          hint: data.hint,
          risk: data.risk,
        })
      })
    },
    cleanup: () => {
      offResolve()
      offReject()
      offTermSubmit()
      offTermCancel()
    },
  }
}
