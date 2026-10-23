/**
 * 授权确认弹窗的交互逻辑（命令 / 脚本 / 沙盒脱壳等，通用）。
 *
 * handler 收到 confirm_command 后弹授权确认弹窗；允许 → 执行并 resolve；拒绝 → reject 'cancelled'；
 * 暂存 → throw InteractionShelved。
 *
 * ⚠️ 不做任何脱壳决策：「忽略沙盒命令」规则的匹配在 Rust 侧，命中时根本走不到这里。
 * ⚠️ 路由：弹窗分支用 interactionId、终端分支用 toolCallId；不匹配的应答一律忽略，
 * 否则多会话同时授权时一次应答会放行两条命令。
 * ⚠️ pendings 是多槽：AI 并行执行两条命令会同时挂起两次审批，单槽会被后到的覆盖至永久挂起。
 */
import { ToolExecutorResponse } from '@/domain/tools/types'
import toolInteractEvent from '@/events/toolInteractEvent'
import { toolOutputStore } from '@/infrastructure/tools/output-store'
import { track } from '@/utils/telemetry'
import { v4 } from '@/utils/uuid'
import { InteractionEnded } from './interaction-end'
import { PendingSlots } from './pending-slots'

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

/**
 * 授权结束（允许 / 拒绝 / 收敛 / 终端内提交）：撒掉「等授权」标记 —— 工具卡从这时起才渲染终端。
 *
 * 三个结束点都走这里，就是为了不出现「已经批过了终端还藏着」或「拒了反而弹出终端」两类漏洞。
 */
function endAuthPending(toolCallId: string): void {
  if (toolCallId) toolOutputStore.clearAwaitingAuth(toolCallId)
}

/** 一个待审批交互的槽位（应答 / 收敛后即摘掉 → 重复应答自然失效） */
interface PendingConfirm {
  resolve: (value: ToolExecutorResponse) => void
  reject: (reason: any) => void
  /** 命令正文（拒绝时写进 tool output 用） */
  command: string
  toolCallId: string
  approvalId: string
  /** 弹出时刻（埋点的 latency_ms 用） */
  showTime: number
}

export function createCommandConfirmHandles(
  sessionId: string,
): CommandConfirmHandles {
  /** interactionId → 待审批槽位（跨 session 天然隔离：每个 session 一个 handles 实例） */
  const pendings = new PendingSlots<PendingConfirm>(sessionId)

  /**
 * 放行：执行待审批命令并把结果 resolve 回去。用户点「允许」与规则自动放行共用同一条路径。
 */
  async function doAllow(entry: PendingConfirm) {
    try {
      const result = {
        result: null as Promise<ToolExecutorResponse> | null,
      }
      toolInteractEvent.emit(
        'userAllowCmd',
        entry.approvalId,
        sessionId,
        entry.toolCallId,
        result,
      )
      if (result.result == null) {
        entry.resolve('[error] command not found')
        return
      }
      result.result
        .then((r: ToolExecutorResponse) => entry.resolve(r))
        .catch((e: any) => entry.resolve(`[error] ${e.message || String(e)}`))
    } catch (e: any) {
      entry.resolve(`[error] ${e.message || String(e)}`)
    }
  }

  const offResolve = toolInteractEvent.on(
    'commandResolve',
    async (interactionId: string, _value: string) => {
      // 只响应这个交互（未知 / 已应答 / 已收敛的一律忽略，幂等）
      const entry = pendings.get(interactionId)
      if (!entry) return
      pendings.delete(interactionId)
      endAuthPending(entry.toolCallId)
      track('interaction.command.confirm.result', {
        approval_id: entry.approvalId,
        action: 'allow',
        latency_ms: entry.showTime ? Date.now() - entry.showTime : undefined,
      })
      await doAllow(entry)
      toolInteractEvent.emit('interactionSettled', interactionId, 'allow')
    },
  )
  const offReject = toolInteractEvent.on(
    'commandReject',
    (interactionId: string, reason: string) => {
      const entry = pendings.get(interactionId)
      if (!entry) return
      pendings.delete(interactionId)
      endAuthPending(entry.toolCallId)
      const shelved = reason.startsWith('shelve:')
      track('interaction.command.confirm.result', {
        approval_id: entry.approvalId,
        action: shelved ? 'shelve' : 'reject',
        latency_ms: entry.showTime ? Date.now() - entry.showTime : undefined,
      })
      if (!shelved) {
        track('interaction.cancel', { phase: 'command_confirm' })
      }
      if (shelved) {
        entry.reject(new InteractionShelved(reason.slice(7)))
      } else {
        // 通知 execute_command 侧清理待审批注册表，避免内存泄漏
        if (entry.approvalId) {
          toolInteractEvent.emit(
            'userCmdRejected',
            entry.approvalId,
            sessionId,
            entry.toolCallId,
          )
        }
        entry.reject(reason || 'cancelled')
        // 拒绝的命令也写一条记录到 tool output
        if (entry.command) {
          try {
            toolOutputStore.append(
              entry.toolCallId,
              `[User rejected] ${entry.command}\n`,
            )
          } catch {}
        }
      }
      toolInteractEvent.emit(
        'interactionSettled',
        interactionId,
        shelved ? 'shelve' : 'reject',
      )
    },
  )

  /**
   * 运行结束时把还没被回答的交互都收敛掉（cleanup 之后监听器就拆了）。
   * 多槽：逐个收敛，只收敛最后一个的话其余仍然挂死。
   */
  function endPending(): void {
    if (pendings.size === 0) return
    const entries = [...pendings]
    pendings.clear()
    for (const [interactionId, entry] of entries) {
      toolInteractEvent.emit('interactionSettled', interactionId, 'expired')
      entry.reject(new InteractionEnded())
      endAuthPending(entry.toolCallId)
    }
  }

  return {
    handler: async (_type: string, data: Record<string, any>) => {
      const interactionId = v4()
      const entry: PendingConfirm = {
        resolve: () => {},
        reject: () => {},
        command: data.command || data.desc || '',
        toolCallId: data.toolCallId || '',
        approvalId: data.approvalId || '',
        showTime: Date.now(),
      }
      track('interaction.command.confirm.show', {
        approval_id: entry.approvalId,
        perm_name: data.permName,
        command: entry.command,
        command_len: entry.command.length,
        risk: data.risk,
        // 申请「不使用沙盒」执行时留痕
        sandbox_bypass: data.sandboxBypass === true ? true : undefined,
      })
      return new Promise<ToolExecutorResponse>((resolve, reject) => {
        entry.resolve = resolve
        entry.reject = reject
        pendings.set(interactionId, entry)
        // 授权前不显示终端：运行中的工具卡此时还是一片空白输出，看着像「已经跑完了」
        if (entry.toolCallId) toolOutputStore.setAwaitingAuth(entry.toolCallId)
        toolInteractEvent.emit('showAuthorization', {
          interactionId,
          sessionId,
          toolCallId: entry.toolCallId,
          permName: data.permName || '',
          title: data.title || '',
          subTitle: data.subTitle,
          desc: data.desc,
          command: data.command,
          hint: data.hint,
          risk: data.risk,
          // 手机控制：审批分级靠它把「沙盒脱壳」判为高风险
          sandboxBypass: data.sandboxBypass === true ? true : undefined,
        })
      })
    },
    cleanup: () => {
      // 先收敛未答的交互（监听器一拆就永远收不掉了）
      endPending()
      offResolve()
      offReject()
    },
  }
}

/**
 * 原生命令审批 handles（Rust 原生 execute_command）。
 * 与上者的差异：不注册 JS 侧审批，命令由 Rust 执行 —— 允许下 resolve('approved')。
 */
export function createNativeCommandConfirmHandles(
  sessionId: string,
): CommandConfirmHandles {
  /** interactionId → 待审批槽位（多槽，见文件头） */
  const pendings = new PendingSlots<PendingConfirm>(sessionId)

  /** 终端分支按 toolCallId 路由（命令行走在终端块里，UI 拿不到 interactionId） */
  function findByToolCallId(
    toolCallId: string,
  ): [string, PendingConfirm] | undefined {
    return [...pendings].find(([, e]) => e.toolCallId === toolCallId)
  }

  const offResolve = toolInteractEvent.on(
    'commandResolve',
    async (interactionId: string, _value: string) => {
      // 只响应**这个**交互（未知 / 已应答 / 已被收敛的一律忽略，幂等）
      const entry = pendings.get(interactionId)
      if (!entry) return
      pendings.delete(interactionId)
      endAuthPending(entry.toolCallId)

      track('interaction.command.confirm.result', {
        approval_id: entry.approvalId,
        action: 'allow',
        latency_ms: entry.showTime ? Date.now() - entry.showTime : undefined,
      })

      // 原生命令：只回「允许」标记，实际执行由 Rust 完成
      entry.resolve('approved')
      // 记录到 tool output
      try {
        toolOutputStore.append(
          entry.toolCallId,
          '[User approved] command executed natively\n',
        )
      } catch {}
      toolInteractEvent.emit('interactionSettled', interactionId, 'allow')
    },
  )
  const offReject = toolInteractEvent.on(
    'commandReject',
    (interactionId: string, reason: string) => {
      const entry = pendings.get(interactionId)
      if (!entry) return
      pendings.delete(interactionId)
      endAuthPending(entry.toolCallId)
      const shelved = reason.startsWith('shelve:')
      track('interaction.command.confirm.result', {
        approval_id: entry.approvalId,
        action: shelved ? 'shelve' : 'reject',
        latency_ms: entry.showTime ? Date.now() - entry.showTime : undefined,
      })
      if (!shelved) {
        track('interaction.cancel', { phase: 'command_confirm' })
      }
      if (shelved) {
        entry.reject(new InteractionShelved(reason.slice(7)))
      } else {
        entry.reject(reason || 'cancelled')
        if (entry.command) {
          try {
            toolOutputStore.append(
              entry.toolCallId,
              `[User rejected] ${entry.command}\n`,
            )
          } catch {}
        }
      }
      toolInteractEvent.emit(
        'interactionSettled',
        interactionId,
        shelved ? 'shelve' : 'reject',
      )
    },
  )

  // 终端内确认（UI 组件 emit → 这里 resolve / reject）。
  const offTermSubmit = toolInteractEvent.on(
    'terminalConfirmSubmit',
    (toolCallId, command) => {
      const found = findByToolCallId(toolCallId)
      // 只响应这条待确认命令（多命令并发 / 跨 session 不互抄）
      if (!found) return
      const [interactionId, entry] = found
      pendings.delete(interactionId)
      endAuthPending(entry.toolCallId)
      track('interaction.command.confirm.result', {
        approval_id: entry.approvalId,
        action: 'allow',
        latency_ms: entry.showTime ? Date.now() - entry.showTime : undefined,
      })
      /*
       * ⚠️ 先广播终态、再清 pendingConfirm：桥接层把「待确认消失」当成一次本机终态（expired）且是
       * 同步触发的 —— 先清后播的话，手机端这条被放行的记录会显示成「不知怎么结束的」。
       */
      toolInteractEvent.emit('interactionSettled', interactionId, 'allow')
      toolOutputStore.clearPendingConfirm(toolCallId)
      // ⚠️ 必须回传命令正文：用户可能改过，只回「批准」会让 Rust 跑旧命令
      entry.resolve(JSON.stringify({ approved: true, command }))
    },
  )
  const offTermCancel = toolInteractEvent.on(
    'terminalConfirmCancel',
    (toolCallId) => {
      const found = findByToolCallId(toolCallId)
      if (!found) return
      const [interactionId, entry] = found
      pendings.delete(interactionId)
      endAuthPending(entry.toolCallId)
      track('interaction.command.confirm.result', {
        approval_id: entry.approvalId,
        action: 'reject',
        latency_ms: entry.showTime ? Date.now() - entry.showTime : undefined,
      })
      track('interaction.cancel', { phase: 'command_confirm' })
      // 同 offTermSubmit：终态必须先广播（否则被注册表的 expired 抢先落）
      toolInteractEvent.emit('interactionSettled', interactionId, 'reject')
      toolOutputStore.clearPendingConfirm(toolCallId)
      entry.reject('cancelled')
    },
  )

  /**
   * 运行结束时的收尾：除了 Promise，还要撤掉终端内确认那条命令行（否则会留一行点不动的命令）。
   * 多槽：逐个收敛。
   */
  function endPending(): void {
    if (pendings.size === 0) return
    const entries = [...pendings]
    pendings.clear()
    for (const [interactionId, entry] of entries) {
      if (entry.toolCallId) {
        toolOutputStore.clearPendingConfirm(entry.toolCallId)
      }
      toolInteractEvent.emit('interactionSettled', interactionId, 'expired')
      entry.reject(new InteractionEnded())
      endAuthPending(entry.toolCallId)
    }
  }

  return {
    handler: async (_type: string, data: Record<string, any>) => {
      const interactionId = v4()
      const entry: PendingConfirm = {
        resolve: () => {},
        reject: () => {},
        command: data.command || data.desc || '',
        toolCallId: data.toolCallId || '',
        // 原生路径 Rust 不下发 approvalId，回退用 toolCallId 作为审批关联 ID
        approvalId: data.approvalId || data.toolCallId || '',
        showTime: Date.now(),
      }
      track('interaction.command.confirm.show', {
        approval_id: entry.approvalId,
        perm_name: data.permName,
        command: entry.command,
        command_len: entry.command.length,
        risk: data.risk,
        // 申请「不使用沙盒」执行时留痕（sandbox:"off" 由 Rust 下发该标记）
        sandbox_bypass: data.sandboxBypass === true ? true : undefined,
        // 留痕呈现方式（terminal 由 Rust 判定并下发）
        presentation: data.presentation,
      })
      return new Promise<ToolExecutorResponse>((resolve, reject) => {
        entry.resolve = resolve
        entry.reject = reject
        pendings.set(interactionId, entry)
        // 授权前不显示终端：等批期间工具卡不渲染终端 / 脚本视图（授权结束由 endAuthPending 撤掉）
        if (entry.toolCallId) toolOutputStore.setAwaitingAuth(entry.toolCallId)
        // Rust 判定「走终端」时不弹 modal，改在该 toolCallId 的终端块里渲染可编辑命令行。
        // 走哪条路只由 Rust 下发的 presentation 决定（前端不猜平台）。
        if (data.presentation === 'terminal') {
          toolOutputStore.setPendingConfirm(entry.toolCallId, {
            // 带上 interactionId：终端内确认不弹 modal，手机控制侧靠它把卡片与 interactionSettled 对齐
            interactionId,
            permName: data.permName,
            title: data.title,
            subTitle: data.subTitle,
            desc: data.desc,
            hint: data.hint,
            risk: data.risk,
            sandboxBypass: data.sandboxBypass === true ? true : undefined,
          })
          return
        }
        toolInteractEvent.emit('showAuthorization', {
          interactionId,
          sessionId,
          toolCallId: entry.toolCallId,
          permName: data.permName || '',
          title: data.title || '',
          subTitle: data.subTitle,
          desc: data.desc,
          command: data.command,
          hint: data.hint,
          risk: data.risk,
          sandboxBypass: data.sandboxBypass === true ? true : undefined,
        })
      })
    },
    cleanup: () => {
      // 先收敛未答的交互（含终端内确认的待确认命令行）
      endPending()
      offResolve()
      offReject()
      offTermSubmit()
      offTermCancel()
    },
  }
}
