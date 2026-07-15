/**
 * command_confirm — 命令执行确认弹窗的交互逻辑
 *
 * handler 收到 confirm_command 后：
 * 1. 弹窗让用户确认
 * 2. 用户点「允许」→ handler 自己调 runCommand 执行，把结果 resolve 回去
 * 3. 用户点「拒绝」→ reject 'cancelled'
 * 4. 用户点「暂存」→ throw InteractionShelved
 */
import { ToolExecutorResponse } from '@/domain/tools/types'
import toolInteractEvent from '@/events/toolInteractEvent'
import { toolOutputStore } from '@/infrastructure/tools/output-store'

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

  const offResolve = toolInteractEvent.on(
    'commandResolve',
    async (_value: string) => {
      const resolve = interactionResolve
      const toolCallId = pendingToolCallId
      interactionResolve = null
      interactionReject = null
      pendingCommand = ''
      pendingToolCallId = ''

      if (!resolve) return

      try {
        const result = {
          result: null as Promise<ToolExecutorResponse>,
        }
        toolInteractEvent.emit('userAllowCmd', sessionId, toolCallId, result)
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
    },
  )
  const offReject = toolInteractEvent.on('commandReject', (reason: string) => {
    const reject = interactionReject
    const cmd = pendingCommand
    interactionResolve = null
    interactionReject = null
    // pendingCommand = ''
    // pendingToolCallId = ''
    if (!reject) return
    if (reason.startsWith('shelve:')) {
      reject(new InteractionShelved(reason.slice(7)))
    } else {
      reject(reason || 'cancelled')
      // 拒绝的命令也写一条记录到 tool output
      if (cmd) {
        try {
          toolOutputStore.append(pendingToolCallId, `[User rejected] ${cmd}\n`)
        } catch {}
      }
    }
  })

  return {
    handler: async (_type: string, data: Record<string, any>) => {
      pendingCommand = data.command || ''
      pendingToolCallId = data.toolCallId || ''
      return new Promise<ToolExecutorResponse>((resolve, reject) => {
        interactionResolve = resolve
        interactionReject = reject
        toolInteractEvent.emit(
          'showCommandConfirm',
          sessionId,
          data.command,
          data.risk,
          data.label,
          data.hint,
        )
      })
    },
    cleanup: () => {
      offResolve()
      offReject()
    },
  }
}
