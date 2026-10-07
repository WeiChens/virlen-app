/**
 * interaction-source —— 把**本机真实交互来源**接到 InteractionRegistry（M4）。
 *
 * 三个来源（缺一就会出现「手机看不到的授权」）：① toolInteractEvent.showChoice（AI 提问）；
 * ② showAuthorization（命令 / 脚本 / 沙盒脱壳）；③ toolOutputStore.pendingConfirm（终端内确认，不弹 modal）。
 *
 * 终态**双向**同步（缺一边就有「点不动的僵尸弹窗」）：本机 → interactionSettled → registry.settleByLocal；
 * 手机 → registry.settle → notifyLocalSettled → 本机收起弹窗。
 *
 * ⚠️ 职责边界：本文件只做「事件 ↔ 注册表」的搬运 + 分级判定，**不做任何执行决策**（执行仍全在电脑侧原有
 * 路径，§16.2：手机不引入第二条执行路径）。
 * ⚠️ **建表与接线是两个函数**：createInteractionRegistry 只建表（推送出口由持有者给）；
 * wireInteractionSources 把来源接到一个**已存在**的表上。拆开是因为待应答交互是电脑侧的事实、生命周期属于
 *「手机控制服务」而非某条链路 —— 换链路（closed 自愈 / 握手超时 / 移除设备 / 改 ICE）若让注册表跟着链路走，
 * 排队中的交互会被静默清掉（手机卡片变僵尸、电脑弹窗与引擎仍在等）。故生产路径由 PhoneControlService 持表、
 * 只接一次线，再注进每条新链路。
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
  /**
   * 推送出口。**由持有者决定推到哪里** —— 注册表自己不认识链路（链路会被重建）。
   * 服务级持表时的正确写法：`(topic, payload) => this.bridge?.emit(topic, payload)`。
   */
  emit: HostEmit
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
  // 本机「运行结束 / 没人回答」的收敛（handles 的 `endPending`）—— 与共享包同名同义，不再近似
  expired: 'expired',
}

/**
 * 反向映射：共享包终态 → 本机 `interactionSettled` 的终态（`notifyLocalSettled` 用）。
 *
 * `expired`（会话被取消 / 被删除 / 运行结束）现在在本机**有对应词**了（2026-10）：以前手动近似成
 * `reject`，那会让本机监听方无法区分「用户拒绝」与「没人回答」；现在 1:1 透传。
 * 本机监听方（`tool-ui.tsx`）目前仍只看 `interactionId`，但契约上两者已经是两件事。
 */
const LOCAL_OUTCOME_MAP: Record<InteractionOutcome, LocalOutcome> = {
  allow: 'allow',
  deny: 'reject',
  shelve: 'shelve',
  expired: 'expired',
}

/**
 * 建一个待应答交互注册表（应答落点仍是本机既有交互事件，见 `createLocalSink`）。
 *
 * ⚠️ **只建表、不接线** —— 接线走 `wireInteractionSources`（原因见文件头）。
 * 建出来的表可以**比链路活得久**：链路重建时把它注进新链路即可（`PhoneBridgeOptions.interactions`）。
 */
export function createInteractionRegistry(
  options: CreateInteractionRegistryOptions,
): InteractionRegistry {
  return new InteractionRegistry({
    sink: createLocalSink(),
    emit: options.emit,
    audit: options.audit,
    notify: options.notify,
    // 手机批完 / 交互被收敛 → 桌面上那张弹窗也要收掉（`emit` 只到手机）
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
 * 「正在接线」的表（**同一时刻**只允许一份）。
 *
 * 语义是「**同时**只能接一次」，不是「一辈子只能接一次」：返回的解绑函数会把标记摘掉，
 * 于是「解绑 → 重新接线」（改 ICE 换服务实例：旧实例 `dispose()` + 新实例 `enable()`）照常可用。
 *
 * 为何要把它变成运行时约束（而不是只写在注释里）：违反它的后果是**静默**的 ——
 * 每个交互被登记两遍（第二次因 id 已存在而不重复推送，看着像没事），但 `interactionSettled`
 * 会收两遍、`settleByLocal` 也会走两遍，终态与 `by` 的归属就错了（排查时现场全无）。
 */
const wiredRegistries = new WeakSet<InteractionRegistry>()

/**
 * 把本机真实交互来源（三个）接到**已存在**的注册表上，返回解绑函数。
 *
 * ⚠️ 同一张表**同时只能接一份线**（违反 → 立即抛错，见 `wiredRegistries`；
 * 「解绑后重新接」是合法的，那正是改 ICE 的路径）。
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
   * 本机应答端（桌面弹窗 / 终端块 / `notifyLocalSettled` 的回声）报了终态。
   * 走 `settleByLocal` 而**不是** `settle` —— 手机正在应答的那一条必须留给手机自己落终态，
   * 否则 `by` 会被记成 `host`（手机端于是把自己刚批的结果显示成「电脑已处理」）。
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
    /*
     * 待确认已消失：电脑侧提交/取消了（具体终态未知）→ 按 expired 收敛，让手机收起卡片。
     *
     * 走 `settleByLocal`：这是**本机观察到的**终态，必须让位于手机正在应答的那一次
     * —— 手机在终端块里放行时，`clearPendingConfirm` 会**先于** handles 的回执触发这里，
     * 抢先把终态落成 `expired`（手机端于是把自己刚放行的那一下显示成「不知怎么结束的」）。
     *
     * ⚠️ 这是条**热路径**：每次工具输出通知都会走到这里（节流后仍可达 ~20 次/秒）。
     * 注册表为空就立刻返回（绝大多数输出事件都不涉及交互），再去表里按 `toolCallId` 现查 ——
     * 不在这里做分配，也不用「接线级」的映射（那个重挂就空，条目会永远收敛不掉）。
     */
    if (registry.size === 0) return
    const pending = registry.findTerminalByToolCall(toolCallId)
    if (pending) registry.settleByLocal(pending.interactionId, 'expired')
  })

  return () => {
    // 先摘标记（重复调本函数是无害的：`off*` 与 WeakSet 的删除都幂等），
    // 于是「解绑 → 重新接线」仍被允许 —— 但**同时挂两份**不会。
    wiredRegistries.delete(registry)
    offChoice()
    offAuth()
    offSettled()
    offOutput()
  }
}

/**
 * 便捷入口（散装场景 / 单测）：自建一份注册表 + 接一次线，一次性拿到 `{ registry, dispose }`。
 *
 * ⚠️ 用它拿到的注册表**随本函数的 `dispose` 一起消失** —— 生产路径（`PhoneControlService`）
 * **不要**用这个入口：待应答交互必须跨链路存活，见 `createInteractionRegistry` 的说明。
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
