/**
 * interaction-registry —— 电脑侧的**待应答交互注册表**（M4）。
 *
 * 解决的问题：手机要能「知道现在有哪些交互在等我」并「精确应答其中一个」。改造前手机只收到一次性
 * 的 showChoice，无法：① 中途连上来时补看；② 判断是否需要二次确认（分级）；③ 应答后收到终态。
 *
 * ⚠️ 本类**不直接碰 toolInteractEvent**：应答落点通过 InteractionSink 注入 —— 单测可注入假 sink 断言
 *「手机点允许 → 电脑收到的载荷与桌面点击完全同形」；未来换落点（如 Rust 审批）只需换 sink。
 * ⚠️ **终态必须通知两端**：emit 推给手机、notifyLocalSettled 通知本机（收起桌面弹窗）。缺任一端会留下
 *「用户看得见、却点不动」的僵尸弹窗。
 * ⚠️ **高风险批准必须带 confirmed: true**（服务端权威校验；手机 UI 的二次确认只是第一道摩擦，
 * §16.2 要求两侧独立成立）。
 */
import type { AnswerParams, AnswerResult, HostEmit, InteractionDTO, InteractionOutcome } from 'virlen-remote'
import { answerActionError, normalizeChoiceAnswer, type ChoiceAnswer } from 'virlen-remote'
import { track } from '@/utils/telemetry'
import type { AuditLog } from './audit'
import { previewOf } from './audit'
import { PHONE_EVENTS, previewOf as telemetryPreviewOf } from './telemetry'

// 选择答案的规范化实现在共享包（virlen-remote）：手机侧、电脑侧桥接层、mock 宿主共用一份，
// 避免三处各写一遍导致「AI 收到内容但消息渲染不出（uiData 缺失）」。此处转身导出，保持既有 import 面。
export { normalizeChoiceAnswer }
export type { ChoiceAnswer }

/** 应答落点（真实实现见 `interaction-source.ts`；测试注入假实现）。 */
export interface InteractionSink {
  /** 电脑侧收到手机的选择 → 等价于桌面点「确认」。返回 false = 电脑侧已不再挂起该交互。 */
  resolveChoice(interactionId: string, value: ChoiceAnswer): boolean
  /** 提问的取消 / 暂存（对应桌面弹窗的「取消」/「暂存」两个按钮） */
  settleChoice(interactionId: string, kind: 'cancel' | 'shelve'): boolean
  /** 授权：允许（与桌面「允许」同一条执行路径） */
  allowAuthorization(interactionId: string): boolean
  /**
   * 授权：拒绝 / 暂存。
   *
   * 给 AI 的文案（含 `'shelve:'` 前缀）由 sink 侧构造，与桌面 `tool-ui.tsx` 的
   * `handleAuthCancel` / `handleAuthShelve` **完全同形** —— 注册表只传语义。
   */
  rejectAuthorization(interactionId: string, kind: 'cancel' | 'shelve'): boolean
  /** 终端内确认：允许（**用原始命令**，手机不能编辑） */
  allowTerminal(toolCallId: string, command: string): boolean
  /** 终端内确认：拒绝 */
  rejectTerminal(toolCallId: string): boolean
}

export interface InteractionRegistryDeps {
  sink: InteractionSink
  /** 把 `host.event.interaction.requested / resolved` 推给手机。 */
  emit: HostEmit
  audit?: AuditLog
  /** 桌面侧提示（手机批准高风险操作时提醒电脑前的人，§16.3-2）。 */
  notify?: (text: string) => void
  /**
   * 把终态同步广播给**本机**应答端（桌面 `tool-ui` 据此收掉那张弹窗）。
   *
   * 为什么必须有（2026-10 真机缺陷）：`emit` 只到**手机**，于是「谁先应答」决定了另一端的下场 ——
   *  - 手机先应答 → 桌面弹窗没人收，用户看到一张点不动的僵尸弹窗（再点一次就是对同一条交互重复应答）；
   *  - 电脑侧把交互收敛成终态（`settleBySession`：手机端取消会话 / 删除会话）→ 桌面同样没人收。
   * 落点是 `toolInteractEvent.interactionSettled`（注入，见 `interaction-source.ts`）。
   * ⚠️ 桌面自己应答时**不需要**这条（桌面各 handles 应答后会自己广播，见
   * `services/tool-service/{user_choice,command_confirm}.ts`），故本回调**必须幂等**。
   */
  notifyLocalSettled?: (
    interactionId: string,
    outcome: InteractionOutcome,
  ) => void
  /** 现在（可注入，便于测试）。 */
  now?: () => number
}

export class InteractionRegistry {
  private readonly pending = new Map<string, InteractionDTO>()
  private readonly now: () => number

  /**
   * 正在处理「手机应答」的交互 id（只在 `answer()` 的**同步窗口内**存活）。
   *
   * 为何必需：`InteractionSink` 的落点是**本机既有的交互事件**（`resolve` / `commandResolve`…），
   * 而本机 handles 应答成功后又会广播 `interactionSettled`（那是给「第二个应答端」收 UI 用的）。
   * 那条广播会**同步**回到本注册表 —— 不压住它，它会先于 `answerInner` 把条目按 `by:'host'`
   * 收掉：手机端于是把自己刚批的那一下显示成「电脑已处理」，`phone.interaction.resolved.by`
   * 也永远失真（排查「到底谁答的」时这个字段是唯一的依据）。
   */
  private readonly answering = new Set<string>()

  constructor(private readonly deps: InteractionRegistryDeps) {
    this.now = deps.now ?? (() => Date.now())
  }

  // 登记 / 终态

  /** 登记一个待应答交互并推给手机（重复登记同一 id 视为更新，不重复推送）。 */
  register(dto: InteractionDTO): void {
    const existing = this.pending.get(dto.interactionId)
    this.pending.set(dto.interactionId, dto)
    if (existing) return
    this.deps.emit('host.event.interaction.requested', { interaction: dto })
    // 埋点记「排队情况」而不是再拄一遍载荷（推送通道已单记 `phone.push.event`）：
    // 手机端卡片没出现时，首先要回答的是「电脑侧到底登记了没 / 队列里排了几张」
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
   * 标记终态：从注册表移除 + 广播 `interaction.resolved`。
   * **幂等**：已被移除（例如手机刚批完，电脑侧的 `interactionSettled` 才到）时什么都不做。
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
      // 从登记到终态的时长：手机端卡片「一闪而过 / 一直挂着」都可由此判断
      pending_ms: dto ? this.now() - dto.createdAt : undefined,
      pending_remaining: this.pending.size,
    })
    // 本机（桌面）也要收起那张弹窗 —— `emit` 只把 `interaction.resolved` 推给手机
    this.deps.notifyLocalSettled?.(interactionId, outcome)
  }

  /**
   * 本机应答端（桌面弹窗 / 终端确认块）处理了该交互。
   *
   * ⚠️ **凡「本机观察到的终态」都走这里**，不要直调 `settle`。本机观察有三种：
   * 桌面 handles 的 `interactionSettled`、终端 `pendingConfirm` 消失、本机自己收敛。
   * 三种都可能在**手机正在应答**时同步触发，而那一条必须留给手机自己落终态（见 `answering`）。
   * 与 `settle(…, 'host')` 的唯一区别就是这个让位。
   */
  settleByLocal(interactionId: string, outcome: InteractionOutcome): void {
    if (this.answering.has(interactionId)) return
    this.settle(interactionId, outcome, 'host')
  }

  has(interactionId: string): boolean {
    return this.pending.has(interactionId)
  }

  /**
   * 按 `toolCallId` 找**终端内确认**那条（`presentation: 'terminal'`）。
   *
   * 为什么由注册表提供：这个查询原先记在 `wireInteractionSources` 的**接线级** Map 里，
   * 接线被重挂（改 ICE → 换服务实例 → 旧实例 `dispose()` 解绑、新实例重新接线）就空了 ——
   * 而表是**跳实例存活**的（那正是上一条不变量的内容），所以「这条终端确认还在不在等」
   * 只能问表，不能问接线。
   *
   * 线性扫描（队列通常 0~2 条）；调用方先判 `size` 短路（这是个每次工具输出都会走的热路径）。
   */
  findTerminalByToolCall(toolCallId: string): InteractionDTO | undefined {
    if (!toolCallId) return undefined
    for (const dto of this.pending.values()) {
      if (dto.presentation === 'terminal' && dto.toolCallId === toolCallId) return dto
    }
    return undefined
  }

  /**
   * 把某会话的全部待应答交互收敛为终态。
   *
   * 用于「会话被取消 / 被删除 / 被电脑侧放弃」——此时电脑侧可能不会补发 `interactionSettled`，
   * 注册表里会留下僵尸条目，手机端会一直显示一张点不动的卡片。
   */
  settleBySession(sessionId: string, outcome: InteractionOutcome = 'expired'): void {
    if (!sessionId) return
    const targets = [...this.pending].filter(([, dto]) => dto.sessionId === sessionId)
    for (const [id] of targets) this.settle(id, outcome, 'host')
    if (targets.length > 0) {
      // 批量收敛（取消 / 删除会话导致的僵尸卡片清理）：单记一条汇总，避免只看到一堆 resolved
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

  /** 当前待应答交互（供手机中途接入时补看；按登记顺序）。 */
  list(): InteractionDTO[] {
    return [...this.pending.values()]
  }

  // 应答

  /**
   * 处理一次手机应答。
   *
   * 返回 `accepted:false` **不是错误**：多数情况下是「这条交互电脑上已经处理过了」，
   * 手机只需收起卡片（用 `reason` 决定提示文案），不要弹红。
   *
   * 埋点在**外层**统一记录本次尝试（动作 / 结果 / 等待时长），内部逻辑与本方法拆分，
   * 免得在 6 个 return 分支上各写一遍（那种写法必漏）。
   */
  answer(params: AnswerParams): AnswerResult {
    const pending = this.pending.get(params.interactionId)
    const pendingMs = pending ? this.now() - pending.createdAt : undefined
    // 标记「这一条正在由手机应答」—— sink 会同步触发本机回执链，见 `answering`
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

    // 动作合法性（与 mock 宿主**共用同一份**判据 `answerActionError`）
    const actionError = answerActionError(pending, params.action)
    if (actionError) return { accepted: false, reason: actionError }

    // 提问：`choose` 确认；`deny` / `shelve` 取消 / 暂存（对应桌面弹窗的「取消」/「暂存」）
    if (pending.kind === 'choice') {
      switch (params.action) {
        case 'choose':
          return this.answerChoice(pending, params)
        case 'deny':
          return this.settleChoice(pending, 'cancel')
        case 'shelve':
          return this.settleChoice(pending, 'shelve')
        default:
          // 到不了（`answerActionError` 已拦下 choice + allow）
          return { accepted: false, reason: 'unsupported-by-host' }
      }
    }

    // 授权（含终端内确认）
    switch (params.action) {
      case 'allow':
        // ⚠️ 服务端独立校验（不依赖手机 UI）：高风险批准必须显式确认过
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
        // 到不了（`answerActionError` 已拦下 authorization + choose）
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

  /**
   * 提问的取消 / 暂存（与桌面弹窗「取消」/「暂存」同形；终态分别是 `deny` / `shelve`）。
   *
   * ⚠️ 2026-09-27 真机反馈修复：本分支的 sink 方法（`settleChoice`）在 M4 就预留了，
   * 但 `answer()` 的分发**从未调用它** —— 手机对提问点「取消」会被判成
   * `unsupported-by-host`（"电脑端不支持该操作"）。接口做了、接线忘了。
   */
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
      // 终端内确认：**只能原样放行**（用电脑侧下发的命令原文），手机不提供编辑
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
      // 手机批准会收掉桌面上的弹窗 —— 电脑前的人必须知道「刚才那下不是我点的」
      this.deps.notify?.(
        `手机已批准高风险操作：${pending.title || pending.permName || '未知操作'}`,
      )
    }
    this.settle(pending.interactionId, outcome, 'mobile')
    return { accepted: true }
  }

  /** 电脑侧已不再挂起（通常是它先处理了）→ 清掉并告知手机收起卡片。 */
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


