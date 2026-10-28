/**
 * MCP 工具调用的授权（`ask` 档）。
 *
 * 与 `command_confirm.ts` 的差别只有一处：**这里不执行任何东西**。用户的「允许」只是把
 * `'approved'` 回给 Rust（`mcp/bridge.rs` 收到后才真的去调服务器），拒绝 / 暂存则原样回给桥。
 * 所以不需要 `toolOutputStore`（MCP 没有终端可看），也不需要按 `approvalId` 清任何注册表。
 *
 * ⚠️ 复用 `commandResolve` / `commandReject` 两个**通用**授权事件：弹窗（`modals/authorization`）
 * 与会话内卡片（`inline-interactions`）本来就是按「授权」这一个概念渲染的，MCP 只是又一个来源。
 * 各 handles 各自按 `interactionId` 过滤 —— 别的 handle 的 id 在自己表里查不到，天然不会串。
 * ⚠️ 多槽（`PendingSlots`）：AI 并行调两台服务器的工具会同时挂起两次审批，单槽会被后到的顶掉。
 */
import toolInteractEvent from '@/events/toolInteractEvent'
import { track } from '@/utils/telemetry'
import { v4 } from '@/utils/uuid'
import { t } from '@/ui/i18n'
import { InteractionEnded } from './interaction-end'
import { PendingSlots } from './pending-slots'
import type { CommandConfirmHandles } from './command_confirm'

/** 用户暂存（与 `command_confirm` / `user_choice` 同族：引擎按 `error.name` 识别） */
class InteractionShelved extends Error {
  shelveMessage: string
  constructor(message: string = '用户暂存了交互') {
    super(message)
    this.name = 'InteractionShelved'
    this.shelveMessage = message
  }
}

/** 一个待审批的 MCP 调用（应答 / 收敛后即摘掉 → 重复应答自然失效） */
interface PendingMcpConfirm {
  resolve: (value: string) => void
  reject: (reason: any) => void
  /** 埋点用：server / tool 都不是敏感信息，参数正文一个字都不记 */
  server: string
  tool: string
  showTime: number
}

export function createMcpConfirmHandles(sessionId: string): CommandConfirmHandles {
  const pendings = new PendingSlots<PendingMcpConfirm>(sessionId)

  const offResolve = toolInteractEvent.on('commandResolve', (interactionId: string) => {
    const entry = pendings.get(interactionId)
    if (!entry) return
    pendings.delete(interactionId)
    track('interaction.mcp.confirm.result', {
      server: entry.server,
      tool: entry.tool,
      action: 'allow',
      latency_ms: entry.showTime ? Date.now() - entry.showTime : undefined,
    })
    // Rust 侧 `mcp/bridge.rs::is_approved` 认这个字面量（与命令审批同一口径）
    entry.resolve('approved')
    toolInteractEvent.emit('interactionSettled', interactionId, 'allow')
  })

  const offReject = toolInteractEvent.on(
    'commandReject',
    (interactionId: string, reason: string) => {
      const entry = pendings.get(interactionId)
      if (!entry) return
      pendings.delete(interactionId)
      const shelved = reason.startsWith('shelve:')
      track('interaction.mcp.confirm.result', {
        server: entry.server,
        tool: entry.tool,
        action: shelved ? 'shelve' : 'reject',
        latency_ms: entry.showTime ? Date.now() - entry.showTime : undefined,
      })
      if (!shelved) track('interaction.cancel', { phase: 'mcp_confirm' })
      if (shelved) {
        entry.reject(new InteractionShelved(reason.slice(7)))
      } else {
        entry.reject(reason || 'cancelled')
      }
      toolInteractEvent.emit(
        'interactionSettled',
        interactionId,
        shelved ? 'shelve' : 'reject',
      )
    },
  )

  /**
   * 运行结束时收敛未应答的审批（cleanup 之后监听器就拆了）。
   * 广播 `expired`（**没人回答**）而不是 `reject`（用户拒绝）—— 两者在手机端与埋点里含义不同。
   */
  function endPending(): void {
    if (pendings.size === 0) return
    const entries = [...pendings]
    pendings.clear()
    for (const [interactionId, entry] of entries) {
      toolInteractEvent.emit('interactionSettled', interactionId, 'expired')
      entry.reject(new InteractionEnded())
    }
  }

  return {
    handler: async (_type: string, data: Record<string, any>) => {
      const interactionId = v4()
      const server: string = data.serverName || ''
      const tool: string = data.toolName || ''
      const entry: PendingMcpConfirm = {
        resolve: () => {},
        reject: () => {},
        server,
        tool,
        showTime: Date.now(),
      }
      track('interaction.mcp.confirm.show', {
        perm_name: data.permName,
        server,
        tool,
        risk: data.risk,
        // 参数正文只记长度：正文可能含文件名 / 内容（与 Rust 侧「不记参数」同一纪律）
        desc_len: typeof data.desc === 'string' ? data.desc.length : 0,
      })
      return new Promise<string>((resolve, reject) => {
        entry.resolve = resolve
        entry.reject = reject
        pendings.set(interactionId, entry)
        toolInteractEvent.emit('showAuthorization', {
          interactionId,
          sessionId,
          toolCallId: data.toolCallId || '',
          permName: data.permName || '',
          // Rust 下发的是 i18n 的 key（中文即 key）：翻译在这一层做，手机侧拿到的就是界面语言
          title: t(data.title || 'MCP 工具调用'),
          subTitle: data.subTitle,
          desc: data.desc,
          hint: data.hint ? t(data.hint) : undefined,
          risk: data.risk,
        })
      })
    },
    cleanup: () => {
      endPending()
      offResolve()
      offReject()
    },
  }
}
