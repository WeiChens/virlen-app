/**
 * interaction-source —— 把**本机真实交互来源**接到 `InteractionRegistry`（M4）。
 *
 * 三个来源（缺一就会出现「手机看不到的授权」）：
 *  1. `toolInteractEvent.showChoice`        → AI 提问（`user_choice`）
 *  2. `toolInteractEvent.showAuthorization` → 授权弹窗（命令 / 脚本 / 沙盒脱壳）
 *  3. `toolOutputStore.pendingConfirm`      → **终端内确认**（不弹 modal，故不触发 showAuthorization）
 *
 * 终态来源：`toolInteractEvent.interactionSettled`（电脑侧自己处理完时也要让手机收起卡片）。
 *
 * ⚠️ 职责边界：本文件只做「事件 ↔ 注册表」的搬运 + 分级判定，**不做任何执行决策**。
 * 真正的执行仍然全部发生在电脑侧原有路径（§16.2：手机不引入第二条执行路径）。
 */
import type { HostEmit, InteractionDTO, InteractionOutcome } from 'virlen-remote'
import toolInteractEvent from '@/events/toolInteractEvent'
import { toolOutputStore } from '@/infrastructure/tools/output-store'
import { classifyApproval } from './approval-policy'
import { t } from '@/ui/i18n'
import { InteractionRegistry, type ChoiceAnswer, type InteractionSink } from './interaction-registry'
import type { AuditLog } from './audit'

export interface AttachInteractionOptions {
  audit?: AuditLog
  /** 桌面侧提示（手机批准高风险操作时）。 */
  notify?: (text: string) => void
  now?: () => number
}

export interface InteractionHost {
  registry: InteractionRegistry
  dispose(): void
}

/**
 * 应答落点：**全部复用电脑侧已有的本地事件**，与桌面点击走同一条路径。
 *
 * 为什么 sink 一律返回 `true`：这些本地事件是 fire-and-forget，无法同步得知对端 handler 是否还在等。
 * 活性由**注册表自身**保证 —— 它只在 `interactionSettled` 未到来时才持有条目；
 * 若电脑侧提前结束（如取消会话）而没有 settled，则由 `settleBySession` / `pendingConfirm` 消失来收敛。
 */
function createLocalSink(): InteractionSink {
  return {
    resolveChoice(interactionId: string, value: ChoiceAnswer): boolean {
      // 与 tool-ui.tsx 的 `emit('resolve', …)` **完全同形**（含 uiData，AI 消息才能正常渲染）
      toolInteractEvent.emit('resolve', interactionId, value)
      return true
    },
    settleChoice(interactionId: string, kind: 'cancel' | 'shelve'): boolean {
      // 与 tool-ui.tsx 的 `handleChoiceShelve` / `handleChoiceCancel` **完全同形**
      // （含 `'shelve:'` 前缀与给 AI 的文案）—— AI 收到的东西不能因「哪端应答」而变
      toolInteractEvent.emit(
        'reject',
        interactionId,
        kind === 'shelve' ? 'shelve:' + t('用户暂存了这个问题') : t('用户关闭了选择弹窗'),
      )
      return true
    },
    allowAuthorization(interactionId: string): boolean {
      // `user_choice` 之外的第二条：命令授权「允许」；第二个参数在电脑侧被忽略（命令取自有状态）
      toolInteractEvent.emit('commandResolve', interactionId, '')
      return true
    },
    rejectAuthorization(interactionId: string, kind: 'cancel' | 'shelve'): boolean {
      // 同 `handleAuthShelve` / `handleAuthCancel`：文案与 `'shelve:'` 前缀完全同形
      toolInteractEvent.emit(
        'commandReject',
        interactionId,
        kind === 'shelve' ? 'shelve:' + t('用户暂存了该命令') : t('用户拒绝了该命令'),
      )
      return true
    },
    allowTerminal(toolCallId: string, command: string): boolean {
      // 终端内确认：手机**只能原样放行**（等价于在电脑上按 Enter 不改命令）
      toolInteractEvent.emit('terminalConfirmSubmit', toolCallId, command)
      return true
    },
    rejectTerminal(toolCallId: string): boolean {
      toolInteractEvent.emit('terminalConfirmCancel', toolCallId)
      return true
    },
  }
}

const OUTCOME_MAP: Record<string, InteractionOutcome> = {
  allow: 'allow',
  reject: 'deny',
  shelve: 'shelve',
}

export function attachInteractionSources(
  emit: HostEmit,
  options: AttachInteractionOptions = {},
): InteractionHost {
  const now = options.now ?? (() => Date.now())
  const registry = new InteractionRegistry({
    sink: createLocalSink(),
    emit,
    audit: options.audit,
    notify: options.notify,
    now,
  })

  const offChoice = toolInteractEvent.on('showChoice', (payload) => {
    registry.register({
      interactionId: payload.interactionId,
      sessionId: payload.sessionId,
      toolCallId: payload.toolCallId,
      kind: 'choice',
      createdAt: now(),
      tier: 'low',
      question: payload.question,
      options: payload.options,
      multi: payload.multi,
      presentation: 'modal',
    } satisfies InteractionDTO)
  })

  const offAuth = toolInteractEvent.on('showAuthorization', (payload) => {
    const { tier } = classifyApproval({
      kind: 'authorization',
      permName: payload.permName,
      risk: payload.risk,
      sandboxBypass: payload.sandboxBypass,
      presentation: 'modal',
    })
    registry.register({
      interactionId: payload.interactionId,
      sessionId: payload.sessionId,
      toolCallId: payload.toolCallId,
      kind: 'authorization',
      createdAt: now(),
      tier,
      permName: payload.permName,
      title: payload.title,
      subTitle: payload.subTitle,
      desc: payload.desc,
      command: payload.command,
      hint: payload.hint,
      risk: payload.risk,
      sandboxBypass: payload.sandboxBypass === true ? true : undefined,
      presentation: 'modal',
    } satisfies InteractionDTO)
  })

  const offSettled = toolInteractEvent.on('interactionSettled', (interactionId, outcome) => {
    registry.settle(interactionId, OUTCOME_MAP[outcome] ?? 'expired', 'host')
  })

  /** toolCallId → interactionId（`pendingConfirm` 消失时用它收敛）。 */
  const terminalSeen = new Map<string, string>()
  const offOutput = toolOutputStore.subscribe((toolCallId, output) => {
    const info = output.pendingConfirm
    if (info) {
      const interactionId = info.interactionId ?? `tc:${toolCallId}`
      terminalSeen.set(toolCallId, interactionId)
      if (registry.has(interactionId)) return
      const { tier } = classifyApproval({
        kind: 'authorization',
        permName: info.permName,
        risk: info.risk,
        sandboxBypass: info.sandboxBypass,
        presentation: 'terminal',
      })
      registry.register({
        interactionId,
        // 终端内确认**没有会话信息**（PendingConfirmInfo 不带）→ 手机端以全局卡片呈现（§16.4）
        sessionId: '',
        toolCallId,
        kind: 'authorization',
        createdAt: now(),
        tier,
        permName: info.permName,
        title: info.title,
        subTitle: info.subTitle,
        desc: info.desc,
        hint: info.hint,
        risk: info.risk,
        sandboxBypass: info.sandboxBypass === true ? true : undefined,
        presentation: 'terminal',
      } satisfies InteractionDTO)
      return
    }
    // 待确认已消失：电脑侧提交/取消了（具体终态未知）→ 按 expired 收敛，让手机收起卡片
    const interactionId = terminalSeen.get(toolCallId)
    if (interactionId) {
      registry.settle(interactionId, 'expired', 'host')
      terminalSeen.delete(toolCallId)
    }
  })

  return {
    registry,
    dispose() {
      offChoice()
      offAuth()
      offSettled()
      offOutput()
      terminalSeen.clear()
    },
  }
}
