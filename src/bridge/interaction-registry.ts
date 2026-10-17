/**
 * 电脑侧的待应答交互注册表：手机要知道「有哪些交互在等我」并精确应答其中一个。
 *
 * 不直接碰 toolInteractEvent：应答落点通过 InteractionSink 注入（可測可换）。
 * 终态必须通知两端（emit 推手机、notifyLocalSettled 通知本机），缺一端就是僵尸弹窗。
 * 高风险批准必须带 confirmed: true（服务端独立校验）。
 */
import type { AnswerParams, AnswerResult, HostEmit, InteractionDTO, InteractionOutcome } from 'virlen-remote'
import { answerActionError, normalizeChoiceAnswer, type ChoiceAnswer } from 'virlen-remote'
import { track } from '@/utils/telemetry'
import type { AuditLog } from './audit'
import { previewOf } from './audit'
import { PHONE_EVENTS, previewOf as telemetryPreviewOf } from './telemetry'

// 选择答案的规范化在共享包（手机 / 桥接层 / mock 宿主共用一份），此处转身导出保持既有 import 面。
export { normalizeChoiceAnswer }
export type { ChoiceAnswer }

/** 应答落点（真实实现见 interaction-source.ts；测试注入假实现） */
export interface InteractionSink {
  /** 电脑侧收到选择：等价于桌面点「确认」；返回 false = 已不再挂起 */
  resolveChoice(interactionId: string, value: ChoiceAnswer): boolean
  /** 提问的取消 / 暂存（对应桌面弹窗的两个按钮） */
  settleChoice(interactionId: string, kind: 'cancel' | 'shelve'): boolean
  /** 授权：允许（与桌面「允许」同一条执行路径） */
  allowAuthorization(interactionId: string): boolean
  /**
   * 授权：拒绝 / 暂存。给 AI 的文案（含 shelve: 前缀）由 sink 侧构造，与桌面同形 —— 注册表只传语义。
   */
  rejectAuthorization(interactionId: string, kind: 'cancel' | 'shelve'): boolean
  /** 终端内确认：允许（用原始命令，手机不能编辑） */
  allowTerminal(toolCallId: string, command: string): boolean
  /** 终端内确认：拒绝 */
  rejectTerminal(toolCallId: string): boolean
}

export interface InteractionRegistryDeps {
  sink: InteractionSink
  /** 把 requested / resolved 推给手机 */
  emit: HostEmit
  audit?: AuditLog
  /** 桌面侧提示（手机批准高风险操作时提醒电脑前的人） */
  notify?: (text: string) => void
  /**
   * 把终态同步广播给本机应答端（桌面据此收掉弹窗）。emit 只到手机，缺这回调会留下僵尸弹窗。
   * 桌面自己应答时不需要它，故必须幂等。
   */
  notifyLocalSettled?: (
    interactionId: string,
    outcome: InteractionOutcome,
  ) => void
  /** 现在（可注入，便于测试） */
  now?: () => number
}

export class InteractionRegistry {
  private readonly pending = new Map<string, InteractionDTO>()
  private readonly now: () => number

  /**
   * 正在处理手机应答的交互 id（只在 answer() 的同步窗口内存活）。
   * sink 落点会同步触发本机回执链，不压住它就会把手机刚批的那一下按 by:'host' 收掉。
   */
  private readonly answering = new Set<string>()

  constructor(private readonly deps: InteractionRegistryDeps) {
    this.now = deps.now ?? (() => Date.now())
  }

  // 登记 / 终态

  /** 登记待应答交互并推给手机（重复登记同一 id 视为更新，不重复推送） */
  register(dto: InteractionDTO): void {
    const existing = this.pending.get(dto.interactionId)
    this.pending.set(dto.interactionId, dto)
    if (existing) return
    this.deps.emit('host.event.interaction.requested', { interaction: dto })
    // 埋点记排队情况而非载荷（推送通道已单记）：排查「卡片没出现」先看登记了没、队列几张
    track(PHONE_EVENTS.interactionRequested, {
      interaction_id: dto.interactionId,
      session_id: dto.sessionId || undefined,
      kind: dto.kind,
      tier: dto.tier,
      presentation: dto.presentation,
      tool_call_id: dto.toolCallId,
      question: telemetryPreviewOf(dto.question),
      command: telemetryPreviewOf(dto.command ?? dto.desc),
      pending: this.pending.size,
    })
  }

  /**
 * 标记终态：移除 + 广播 resolved。幂等：已移除（手机刚批完，电脑侧 settled 才到）则什么都不做。
 */
  settle(interactionId: string, outcome: InteractionOutcome, by: 'host' | 'mobile'): void {
    const dto = this.pending.get(interactionId)
    if (!this.pending.delete(interactionId)) return
    this.deps.emit('host.event.interaction.resolved', { interactionId, by, outcome })
    track(PHONE_EVENTS.interactionResolved, {
      interaction_id: interactionId,
      session_id: dto?.sessionId || undefined,
      kind: dto?.kind,
      outcome,
      by,
      // 从登记到终态的时长：判断「一闪而过 / 一直挂着」
      pending_ms: dto ? this.now() - dto.createdAt : undefined,
      pending_remaining: this.pending.size,
    })
    // 本机也要收起弹窗 —— emit 只把 resolved 推给手机
    this.deps.notifyLocalSettled?.(interactionId, outcome)
  }

  /**
 * 本机应答端（桌面弹窗 / 终端确认块）处理了该交互。凡本机观察到的终态都走这里，不要直调 settle。
 */
  settleByLocal(interactionId: string, outcome: InteractionOutcome): void {
    if (this.answering.has(interactionId)) return
    this.settle(interactionId, outcome, 'host')
  }

  has(interactionId: string): boolean {
    return this.pending.has(interactionId)
  }

  /**
 * 按 toolCallId 找终端内确认那条。只能问表（接线重挂后会丢），表是跨实例存活的。
 * 线性扫描，调用方先判 size 短路。
 */
  findTerminalByToolCall(toolCallId: string): InteractionDTO | undefined {
    if (!toolCallId) return undefined
    for (const dto of this.pending.values()) {
      if (dto.presentation === 'terminal' && dto.toolCallId === toolCallId) return dto
    }
    return undefined
  }

  /**
 * 把某会话的全部待应答交互收敛为终态：电脑侧可能不会补发 settled，不收敛会留僵尸卡片。
 */
  settleBySession(sessionId: string, outcome: InteractionOutcome = 'expired'): void {
    if (!sessionId) return
    const targets = [...this.pending].filter(([, dto]) => dto.sessionId === sessionId)
    for (const [id] of targets) this.settle(id, outcome, 'host')
    if (targets.length > 0) {
      // 批量收敛：单记一条汇总
      track(PHONE_EVENTS.interactionExpired, {
        session_id: sessionId,
        count: targets.length,
        outcome,
      })
    }
  }

  get size(): number {
    return this.pending.size
  }

  /** 当前待应答交互（手机中途接入时补看） */
  list(): InteractionDTO[] {
    return [...this.pending.values()]
  }

  // 应答

  /**
 * 处理一次手机应答。accepted:false 不是错误（多半是电脑上已处理过），手机只需收起卡片。
 * 埋点在外层统一记，免得在 6 个 return 分支上各写一遍。
 */
  answer(params: AnswerParams): AnswerResult {
    const pending = this.pending.get(params.interactionId)
    const pendingMs = pending ? this.now() - pending.createdAt : undefined
    // 标记「这一条正在由手机应答」：sink 会同步触发本机回执链
    this.answering.add(params.interactionId)
    let result: AnswerResult
    try {
      result = this.answerInner(params)
    } finally {
      this.answering.delete(params.interactionId)
    }
    track(PHONE_EVENTS.interactionAnswer, {
      interaction_id: params.interactionId,
      session_id: pending?.sessionId || undefined,
      kind: pending?.kind,
      tier: pending?.tier,
      action: params.action,
      confirmed: params.confirmed === true,
      accepted: result.accepted,
      reason: result.accepted ? undefined : result.reason,
      pending_ms: pendingMs,
      value: telemetryPreviewOf(
        typeof params.value === 'string' ? params.value : JSON.stringify(params.value ?? ''),
      ),
    })
    return result
  }

  private answerInner(params: AnswerParams): AnswerResult {
    const pending = this.pending.get(params.interactionId)
    if (!pending) return { accepted: false, reason: 'not-found' }

    // 动作合法性（与 mock 宿主共用同一判据）
    const actionError = answerActionError(pending, params.action)
    if (actionError) return { accepted: false, reason: actionError }

    // 提问：choose 确认；deny / shelve 取消 / 暂存
    if (pending.kind === 'choice') {
      switch (params.action) {
        case 'choose':
          return this.answerChoice(pending, params)
        case 'deny':
          return this.settleChoice(pending, 'cancel')
        case 'shelve':
          return this.settleChoice(pending, 'shelve')
        default:
          // 到不了（answerActionError 已拦）
          return { accepted: false, reason: 'unsupported-by-host' }
      }
    }

    // 授权（含终端内确认）
    switch (params.action) {
      case 'allow':
        // 服务端独立校验：高风险批准必须显式确认过
        if (pending.tier === 'high' && params.confirmed !== true) {
          this.auditAnswer(pending, 'allow', false, '缺少二次确认标记')
          return { accepted: false, reason: 'confirm-required' }
        }
        return this.answerAuthorization(pending, 'allow')
      case 'deny':
        return this.answerAuthorization(pending, 'cancel')
      case 'shelve':
        return this.answerAuthorization(pending, 'shelve')
      default:
        // 到不了（answerActionError 已拦）
        return { accepted: false, reason: 'unsupported-by-host' }
    }
  }

  private answerChoice(pending: InteractionDTO, params: AnswerParams): AnswerResult {
    const value = normalizeChoiceAnswer(params.value)
    if (!value) {
      this.auditAnswer(pending, 'deny', false, '选择结果为空')
      return { accepted: false, reason: 'invalid-value' }
    }
    const ok = this.deps.sink.resolveChoice(pending.interactionId, value)
    if (!ok) return this.stale(pending.interactionId)
    this.auditAnswer(pending, 'allow', true, value.content)
    this.settle(pending.interactionId, 'allow', 'mobile')
    return { accepted: true }
  }

  /** 提问的取消 / 暂存（终态分别是 deny / shelve） */
  private settleChoice(pending: InteractionDTO, kind: 'cancel' | 'shelve'): AnswerResult {
    const ok = this.deps.sink.settleChoice(pending.interactionId, kind)
    if (!ok) return this.stale(pending.interactionId)
    const outcome: InteractionOutcome = kind === 'shelve' ? 'shelve' : 'deny'
    this.auditAnswer(pending, outcome, true)
    this.settle(pending.interactionId, outcome, 'mobile')
    return { accepted: true }
  }

  private answerAuthorization(
    pending: InteractionDTO,
    mode: 'allow' | 'cancel' | 'shelve',
  ): AnswerResult {
    const terminal = pending.presentation === 'terminal'
    const toolCallId = pending.toolCallId ?? ''
    let ok: boolean
    if (mode === 'allow') {
      // 终端内确认：只能原样放行（用电脑侧下发的命令原文）
      ok = terminal
        ? this.deps.sink.allowTerminal(toolCallId, pending.desc ?? pending.command ?? '')
        : this.deps.sink.allowAuthorization(pending.interactionId)
    } else {
      ok = terminal
        ? this.deps.sink.rejectTerminal(toolCallId)
        : this.deps.sink.rejectAuthorization(pending.interactionId, mode)
    }
    if (!ok) return this.stale(pending.interactionId)

    const outcome: InteractionOutcome =
      mode === 'allow' ? 'allow' : mode === 'shelve' ? 'shelve' : 'deny'
    this.auditAnswer(pending, outcome, true)
    if (mode === 'allow' && pending.tier === 'high') {
      // 手机批准会收掉桌面弹窗，电脑前的人必须知道刚才那下不是自己点的
      this.deps.notify?.(
        `手机已批准高风险操作：${pending.title || pending.permName || '未知操作'}`,
      )
    }
    this.settle(pending.interactionId, outcome, 'mobile')
    return { accepted: true }
  }

  /** 电脑侧已不再挂起（通常是它先处理了）→ 清掉并告知手机收起卡片 */
  private stale(interactionId: string): AnswerResult {
    this.settle(interactionId, 'expired', 'host')
    return { accepted: false, reason: 'already-settled' }
  }

  private auditAnswer(
    pending: InteractionDTO,
    decision: InteractionOutcome,
    accepted: boolean,
    detail?: string,
  ): void {
    this.deps.audit?.record({
      at: this.now(),
      method: 'host.interaction.answer',
      kind: 'approval',
      allowed: accepted,
      sessionId: pending.sessionId || undefined,
      tier: pending.tier,
      decision: decision === 'expired' ? undefined : decision,
      by: 'mobile',
      interactionId: pending.interactionId,
      commandPreview: previewOf(pending.command ?? pending.desc ?? pending.question),
      detail: [
        pending.kind === 'choice' ? '提问' : pending.permName || '授权',
        pending.presentation === 'terminal' ? '终端内确认' : undefined,
        detail,
      ]
        .filter(Boolean)
        .join(' | '),
    })
  }
}


