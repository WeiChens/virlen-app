/**
 * 把本机真实交互来源接到 InteractionRegistry。
 *
 * 三个来源：AI 提问 / 命令·脚本·沙盒脱壳授权 / 终端内确认。终态必须双向同步（缺一边就有僵尸弹窗）。
 * 本文件只做「事件 ↔ 注册表」的搬运与分级判定，不做任何执行决策。
 *
 * 建表与接线拆开：待应答交互是电脑侧的事实，生命周期属于服务而非某条链路；
 * 让注册表跟着链路走会静默清掉排队中的交互。
 */
import type { HostEmit, InteractionDTO, InteractionOutcome } from 'virlen-remote'
import toolInteractEvent, {
  type InteractionOutcome as LocalOutcome,
} from '@/events/toolInteractEvent'
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

/** 建注册表所需的一切（比 `AttachInteractionOptions` 多一个推送出口）。 */
export interface CreateInteractionRegistryOptions extends AttachInteractionOptions {
  /** 推送出口，由持有者决定推到哪里（注册表不认识链路）。 */
  emit: HostEmit
}

export interface InteractionHost {
  registry: InteractionRegistry
  dispose(): void
}

/**
 * 应答落点：全部复用电脑侧已有的本地事件，与桌面点击走同一条路径。
 * sink 一律返回 true（本地事件是 fire-and-forget）；活性由注册表自身保证。
 */
function createLocalSink(): InteractionSink {
  return {
    resolveChoice(interactionId: string, value: ChoiceAnswer): boolean {
      // 与 tool-ui.tsx 的 `emit('resolve', …)` 同形（含 uiData，AI 消息才能正常渲染）
      toolInteractEvent.emit('resolve', interactionId, value)
      return true
    },
    settleChoice(interactionId: string, kind: 'cancel' | 'shelve'): boolean {
      // 与 tool-ui.tsx 的 handleChoiceShelve / handleChoiceCancel 同形（含 'shelve:' 前缀与文案）
      toolInteractEvent.emit(
        'reject',
        interactionId,
        kind === 'shelve' ? 'shelve:' + t('用户暂存了这个问题') : t('用户关闭了选择弹窗'),
      )
      return true
    },
    allowAuthorization(interactionId: string): boolean {
      // 第二种授权应答：命令「允许」；第二个参数在电脑侧被忽略
      toolInteractEvent.emit('commandResolve', interactionId, '')
      return true
    },
    rejectAuthorization(interactionId: string, kind: 'cancel' | 'shelve'): boolean {
      // 同 handleAuthShelve / handleAuthCancel：文案与 'shelve:' 前缀同形
      toolInteractEvent.emit(
        'commandReject',
        interactionId,
        kind === 'shelve' ? 'shelve:' + t('用户暂存了该命令') : t('用户拒绝了该命令'),
      )
      return true
    },
    allowTerminal(toolCallId: string, command: string): boolean {
      // 终端内确认：手机只能原样放行（等价于在电脑上按 Enter）
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
  // 本机「运行结束 / 没人回答」的收敛，与共享包同名同义
  expired: 'expired',
}

/**
 * 反向映射：共享包终态 → 本机 interactionSettled 的终态。
 * expired 现有对应词（以前近似成 reject，监听方无法区分「拒绝」与「没人回答」）。
 */
const LOCAL_OUTCOME_MAP: Record<InteractionOutcome, LocalOutcome> = {
  allow: 'allow',
  deny: 'reject',
  shelve: 'shelve',
  expired: 'expired',
}

/**
 * 建一个待应答交互注册表（应答落点仍是本机既有交互事件）。
 * 只建表、不接线；建出来的表可比链路活得久，链路重建时注进新链路即可。
 */
export function createInteractionRegistry(
  options: CreateInteractionRegistryOptions,
): InteractionRegistry {
  return new InteractionRegistry({
    sink: createLocalSink(),
    emit: options.emit,
    audit: options.audit,
    notify: options.notify,
    // 手机批完 / 交互被收敛 → 桌面上那张弹窗也要收掉
    notifyLocalSettled: (interactionId, outcome) => {
      toolInteractEvent.emit(
        'interactionSettled',
        interactionId,
        LOCAL_OUTCOME_MAP[outcome],
      )
    },
    now: options.now ?? (() => Date.now()),
  })
}

/**
 * 「正在接线」的表，同一时刻只允许一份（解绑后重新接线是合法的）。
 * 违反的后果是静默的：每个交互登记两遍，终态与 by 归属都会错。
 */
const wiredRegistries = new WeakSet<InteractionRegistry>()

/**
 * 把三个本机交互来源接到已存在的注册表上，返回解绑函数。
 * 同一张表同时只能接一份线（违反立即抛错；解绑后重新接是合法的）。
 */
export function wireInteractionSources(
  registry: InteractionRegistry,
  now: () => number = Date.now,
): () => void {
  if (wiredRegistries.has(registry)) {
    throw new Error(
      'wireInteractionSources：同一张待应答交互注册表被接了两次线 —— ' +
        '每个交互会被登记两遍（`interactionSettled` / `settleByLocal` 也跟着走两遍，' +
        '终态与 by 的归属就错了）。请先调用上一次返回的解绑函数（服务侧即 `disable()`），' +
        '或检查是否重复装配（见本文件头与 `PhoneControlService.attachInteractions`）。',
    )
  }
  wiredRegistries.add(registry)
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

  /*
   * 本机应答端报了终态。走 settleByLocal 而不是 settle —— 手机正在应答的那条要留给手机落终态，
   * 否则 by 会被记成 host。
   */
  const offSettled = toolInteractEvent.on('interactionSettled', (interactionId, outcome) => {
    registry.settleByLocal(interactionId, OUTCOME_MAP[outcome] ?? 'expired')
  })

  const offOutput = toolOutputStore.subscribe((toolCallId, output) => {
    const info = output.pendingConfirm
    if (info) {
      const interactionId = info.interactionId ?? `tc:${toolCallId}`
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
        // 终端内确认没有会话信息 → 手机端以全局卡片呈现
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
    /*
     * 待确认已消失：电脑侧提交 / 取消了 → 按 expired 收敛，让手机收起卡片。
     * 走 settleByLocal：必须让位于手机正在应答的那一次（clearPendingConfirm 会先于回执触发）。
     * 这是热路径（节流后仍可达 ~20 次/秒）：表为空立刻返回，再按 toolCallId 现查。
     */
    if (registry.size === 0) return
    const pending = registry.findTerminalByToolCall(toolCallId)
    if (pending) registry.settleByLocal(pending.interactionId, 'expired')
  })

  return () => {
    // 先摘标记，于是「解绑 → 重新接线」仍被允许；同时挂两份不会
    wiredRegistries.delete(registry)
    offChoice()
    offAuth()
    offSettled()
    offOutput()
  }
}

/**
 * 便捷入口（散装场景 / 单测）：自建注册表 + 接一次线。
 * 生产路径（PhoneControlService）不要用：待应答交互必须跨链路存活。
 */
export function attachInteractionSources(
  emit: HostEmit,
  options: AttachInteractionOptions = {},
): InteractionHost {
  const now = options.now ?? (() => Date.now())
  const registry = createInteractionRegistry({
    emit,
    audit: options.audit,
    notify: options.notify,
    now,
  })
  return { registry, dispose: wireInteractionSources(registry, now) }
}
