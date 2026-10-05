/**
 * 交互终态的**双向**通知（真机缺陷回归，2026-10）。
 *
 * 背景：`InteractionRegistry.settle()` 原先只 `emit('host.event.interaction.resolved')` ——
 * 那条只到**手机**，于是「谁先应答」决定了另一端的下场，留下两种点不动的僵尸弹窗
 * （手机批完桌面还在弹；手机端取消会话后桌面还在弹）。
 *
 * 更隐蔽的一处发生在注册表内部：`InteractionSink` 的落点是**本机既有的交互事件**
 * （`resolve` / `commandResolve` / `terminalConfirmSubmit`…），而本机 handles 应答成功后
 * 又会**同步**广播 `interactionSettled`（那是给「第二个应答端」收 UI 用的）。那条广播会抢在
 * `answerInner` 之前把条目收掉，终态被记成「电脑侧处理」：
 *  - AI 提问：`by` 错成 `host`（手机端把用户自己刚批的那一下显示成「电脑已处理」）；
 *  - 终端内确认：更糟，`outcome` 会错成 `expired`（`pendingConfirm` 消失先触发了收敛）。
 *
 * 本文件钉住五条：
 *  1. 手机答 AI 提问 → 手机收到 `by:'mobile'`，且本机也收到终态（桌面弹窗收起）；
 *  2. 桌面先答 → 注册表随之收敛，手机收到 `by:'host'`；
 *  3. 交互被 `settleBySession` 收敛（手机端取消 / 删除会话）→ 手机与本机**都**收到终态；
 *  4. 手机答授权（弹窗分支）→ `by:'mobile'`；
 *  5. 手机在终端块里放行（高风险，须二次确认）→ `by:'mobile'` 且 `outcome:'allow'`（不是 `expired`）。
 *  6. 桌面在终端块里放行/取消 → 终态是 `allow`/`deny`（不是「待确认消失」推导出来的 `expired`）。
 *  7. 接线被**重挂**（改 ICE 换服务实例）后，终端确认仍能收敛（`toolCallId` 映射不丢）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { InteractionRegistry } from '@/bridge'
import type { InteractionOutcome } from '@/events/toolInteractEvent'
import toolInteractEvent from '@/events/toolInteractEvent'
import { attachInteractionSources, createInteractionRegistry } from '@/bridge'
import { wireInteractionSources } from '@/bridge/interaction-source'
import { toolOutputStore } from '@/infrastructure/tools/output-store'
import { createUserChoiceHandles } from '@/services/tool-service/user_choice'
import {
  createNativeCommandConfirmHandles,
} from '@/services/tool-service/command_confirm'

/** 电脑侧推给手机的事件（`host.event.*`）。 */
type Emitted = { topic: string; payload: any }

const cleanups: Array<() => void> = []
/** 本机（桌面 UI）收到的终态 —— 桌面弹窗就是靠它收起的。 */
const settledLocal: Array<{ interactionId: string; outcome: InteractionOutcome }> = []

afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
  settledLocal.length = 0
})

/**
 * 装一套「注册表 + 真实本机交互来源」（散装入口 `attachInteractionSources`），
 * 返回手机侧收到的事件流与注册表。
 */
function setup(): { emitted: Emitted[]; registry: InteractionRegistry; rewire: () => void } {
  const emitted: Emitted[] = []
  const host = attachInteractionSources((topic, payload) => {
    emitted.push({ topic, payload })
  })
  const offLocal = toolInteractEvent.on('interactionSettled', (interactionId, outcome) => {
    settledLocal.push({ interactionId, outcome })
  })
  /**
   * 模拟「接线被重挂」（改 ICE → 换服务实例 → 旧实例 `dispose()` 解绑、新实例重新接线）：
   * **表不动**，只把监听器解绑再挂一次 —— 接线级的任何映射都会在这一步丢掉。
   */
  const rewire = (): void => {
    host.dispose()
    cleanups.push(wireInteractionSources(host.registry))
  }
  cleanups.push(offLocal, () => host.dispose())
  return { emitted, registry: host.registry, rewire }
}

/** 手机侧收到的终态事件。 */
function resolvedPayloads(emitted: Emitted[]): any[] {
  return emitted.filter((e) => e.topic === 'host.event.interaction.resolved').map((e) => e.payload)
}

/**
 * 挂起一次 AI 提问（`handles.handler` 内同步 `showChoice` → 注册表登记）。
 *
 * 返回 `handles` 是为了让用例能自己驱动「运行结束」（`cleanup()`）。
 * ⚠️ 挂一个兜底 catch：本文件多数用例只关心注册表、不 await 这个 Promise，而 `cleanup()` 会把它
 * 收敛掉（reject `InteractionEnded`）—— 不接下来就是「未处理拒绝」。
 */
function askQuestion(registry: InteractionRegistry) {
  const handles = createUserChoiceHandles('s1')
  cleanups.push(handles.cleanup)
  const answered = handles.handler('user_choice', {
    question: '选哪个？',
    options: ['A', 'B'],
    multi: false,
    toolCallId: 'tc-1',
  })
  answered.catch(() => {})
  const dto = registry.list()[0]
  return { interactionId: dto.interactionId, answered, handles }
}

describe('交互终态：手机 ↔ 本机双向通知', () => {
  it('手机答 AI 提问 → 手机收到 by=mobile（不是 host），本机也收到终态', async () => {
    const { emitted, registry } = setup()
    const { interactionId, answered } = askQuestion(registry)
    expect(registry.list()[0]).toMatchObject({ kind: 'choice', tier: 'low' })

    const result = registry.answer({
      interactionId,
      action: 'choose',
      value: { selected: ['A'], customReply: '' },
    })
    expect(result).toEqual({ accepted: true })

    // 是「手机批的」，不是「电脑处理掉的」—— 这个字段是事后判断「到底谁答的」的唯一依据
    expect(resolvedPayloads(emitted)).toEqual([
      { interactionId, by: 'mobile', outcome: 'allow' },
    ])
    // 本机也要收到：桌面上的提问弹窗必须跟着收起
    expect(settledLocal.map((s) => s.interactionId)).toContain(interactionId)

    await expect(answered).resolves.toMatchObject({ content: 'A' })
  })

  it('桌面先答 → 注册表随之收敛，手机收到 by=host', async () => {
    const { emitted, registry } = setup()
    const { interactionId, answered } = askQuestion(registry)

    // 桌面弹窗点「确认」（tool-ui 与 `user_choice.ts` 之间的既有事件）
    toolInteractEvent.emit('resolve', interactionId, {
      content: 'B',
      uiData: { selected: ['B'], customReply: '' },
    })

    expect(registry.has(interactionId)).toBe(false)
    expect(resolvedPayloads(emitted)).toEqual([
      { interactionId, by: 'host', outcome: 'allow' },
    ])
    await expect(answered).resolves.toMatchObject({ content: 'B' })
  })

  it('交互被收敛（settleBySession：手机端取消 / 删除会话）→ 手机与本机都收到终态', async () => {
    const { emitted, registry } = setup()
    const { interactionId, answered } = askQuestion(registry)

    registry.settleBySession('s1', 'expired')

    expect(registry.has(interactionId)).toBe(false)
    expect(resolvedPayloads(emitted)).toEqual([
      { interactionId, by: 'host', outcome: 'expired' },
    ])
    // ⚠️ 这一条就是「桌面僵尸弹窗」：会话都没了，桌面上还挂着一个点不动的提问弹窗
    expect(settledLocal.map((s) => s.interactionId)).toContain(interactionId)
    /*
     * 收敛 ≠ 应答：这里绝不能把提问的 Promise 当成「用户选了 B」resolve 掉（那是骗 AI）。
     * 但它也不能永远挂着 —— 由「运行结束」那条钩子收掉（见下一条用例）。
     */
    expect(answered).toBeInstanceOf(Promise)
  })

  it('运行结束（cleanup）→ 未答的交互被收敛：手机 expired、本机收 UI、Promise 收掉', async () => {
    /*
     * 「运行结束」≠「用户答过了」：桌面点停止 / 手机取消或删除会话 / 引擎放弃这次交互请求，
     * 这四条路上交互都还没被回答。而 `cleanup()` 是**唯一**的「运行结束」钩子
     *（`services/chat/flow.ts` 的 finally），它一跑监听器就拆了 ——
     * 收敛必须在这里做，否则这个 Promise 永不 settle、手机侧卡片永远不消失。
     */
    const { emitted, registry } = setup()
    const { interactionId, answered, handles } = askQuestion(registry)
    expect(registry.has(interactionId)).toBe(true)

    handles.cleanup()

    expect(registry.has(interactionId)).toBe(false)
    // 手机侧：终态是 `expired`（没人回答），**不是** `deny`（用户拒绝）
    expect(resolvedPayloads(emitted)).toEqual([
      { interactionId, by: 'host', outcome: 'expired' },
    ])
    // 本机（桌面弹窗）也收到终态，且**同样**是 `expired`（本机契约不再把它近似成 `reject`）
    expect(
      settledLocal.filter((s) => s.outcome === 'expired').map((s) => s.interactionId),
    ).toContain(interactionId)
    // 而且必须**收掉这个 Promise**：否则 `handleUserInteractionRequest` 的 await 永远挂着（闭包泄漏）
    await expect(answered).rejects.toMatchObject({ name: 'InteractionEnded' })
  })

  it('手机答授权（弹窗分支）→ by=mobile', async () => {
    const { emitted, registry } = setup()
    const handles = createNativeCommandConfirmHandles('s1')
    cleanups.push(handles.cleanup)
    const answered = handles.handler('confirm_command_native', {
      permName: 'terminal.normal.execute',
      risk: 'safe',
      title: '命令执行确认',
      desc: 'pnpm test',
      toolCallId: 'tc-2',
    })
    const dto = registry.list()[0]
    expect(dto).toMatchObject({ kind: 'authorization', tier: 'low' })

    const result = registry.answer({ interactionId: dto.interactionId, action: 'allow' })
    expect(result).toEqual({ accepted: true })
    expect(resolvedPayloads(emitted)).toEqual([
      { interactionId: dto.interactionId, by: 'mobile', outcome: 'allow' },
    ])
    expect(settledLocal.map((s) => s.interactionId)).toContain(dto.interactionId)
    await expect(answered).resolves.toBe('approved')
  })

  it('手机在终端块里放行 → by=mobile 且 outcome=allow（不是 expired）', async () => {
    const { emitted, registry } = setup()
    const handles = createNativeCommandConfirmHandles('s1')
    cleanups.push(handles.cleanup)
    const answered = handles.handler('confirm_command_native', {
      presentation: 'terminal',
      permName: 'terminal.install.execute',
      title: '终端安装命令执行',
      desc: 'npm i -g pnpm',
      risk: 'install',
      toolCallId: 'tc-term',
    })
    const dto = registry.list()[0]
    expect(dto).toMatchObject({
      kind: 'authorization',
      presentation: 'terminal',
      tier: 'high', // 终端内确认：手机只能原样放行，不能编辑命令
    })

    // 高风险：缺二次确认标记 → 电脑侧独立拒绝（§16.2）
    expect(
      registry.answer({ interactionId: dto.interactionId, action: 'allow', confirmed: false }),
    ).toMatchObject({ accepted: false, reason: 'confirm-required' })
    expect(resolvedPayloads(emitted)).toHaveLength(0)

    const ok = registry.answer({ interactionId: dto.interactionId, action: 'allow', confirmed: true })
    expect(ok).toEqual({ accepted: true })
    // `pendingConfirm` 消失会先触发一次收敛（`expired`）—— 不能让它抢先落终态
    expect(resolvedPayloads(emitted)).toEqual([
      { interactionId: dto.interactionId, by: 'mobile', outcome: 'allow' },
    ])
    await expect(answered).resolves.toBe(JSON.stringify({ approved: true, command: 'npm i -g pnpm' }))
  })

  it('桌面在终端块里放行 → 终态是 allow/host（不是 expired）', async () => {
    /*
     * `pendingConfirm` 消失与 handles 广播终态是**同一件事的两个信号**，而前者只推导得出
     * 「具体终态未知 → expired」（见 `interaction-source.ts` 的 offOutput）。
     * handles 必须先广播，否则这条被放行的记录在手机端与埋点里永远显示成 `expired`。
     */
    const { emitted, registry } = setup()
    const handles = createNativeCommandConfirmHandles('s1')
    cleanups.push(handles.cleanup)
    const answered = handles.handler('confirm_command_native', {
      presentation: 'terminal',
      permName: 'terminal.install.execute',
      title: '终端安装命令执行',
      desc: 'npm i -g pnpm',
      risk: 'install',
      toolCallId: 'tc-term',
    })
    const dto = registry.list()[0]

    // 桌面终端块里按 Enter（用户改后原样提交）
    toolInteractEvent.emit('terminalConfirmSubmit', 'tc-term', 'npm i -g pnpm')

    expect(registry.has(dto.interactionId)).toBe(false)
    expect(resolvedPayloads(emitted)).toEqual([
      { interactionId: dto.interactionId, by: 'host', outcome: 'allow' },
    ])
    await expect(answered).resolves.toBe(JSON.stringify({ approved: true, command: 'npm i -g pnpm' }))
  })

  it('接线被重挂（改 ICE 换服务实例）后，终端确认仍能收敛（映射不丢）', () => {
    /*
     * 终端确认的收敛原先靠 `wireInteractionSources` 里的一个**接线级** Map（`toolCallId → id`）——
     * 接线一重挂它就空了，那条终端确认会永远收敛不掉（手机上留一张点不动的卡片）。
     * 现在这个查询归注册表（`findTerminalByToolCall`），而表跨实例存活 ⇒ 重挂后照样能收。
     */
    const { emitted, registry, rewire } = setup()
    const handles = createNativeCommandConfirmHandles('s1')
    cleanups.push(handles.cleanup)
    const answered = handles.handler('confirm_command_native', {
      presentation: 'terminal',
      permName: 'terminal.install.execute',
      title: '终端安装命令执行',
      desc: 'npm i -g pnpm',
      risk: 'install',
      toolCallId: 'tc-rw',
    })
    /*
     * 本用例只查「表里那条链路映射还在不在」，不关心这次交互的归宿：
     * afterEach 的 `cleanup()` 会把它收敛掉（reject `InteractionEnded`，见 F4）—— 不接住就是「未处理拒绝」。
     */
    answered.catch(() => {})
    const dto = registry.list()[0]
    expect(dto).toMatchObject({ presentation: 'terminal', toolCallId: 'tc-rw' })

    // 换服务实例：表还在（上一条不变量），但「toolCallId → 条目」的映射连同接线一起没了
    rewire()

    // 电脑侧提交 / 取消了这次待确认（具体终态未知 → 收敛为 expired，让手机收起卡片）
    toolOutputStore.clearPendingConfirm('tc-rw')

    expect(registry.has(dto.interactionId)).toBe(false)
    expect(resolvedPayloads(emitted)).toEqual([
      { interactionId: dto.interactionId, by: 'host', outcome: 'expired' },
    ])
  })

  it('同一张表**同时**不许接两份线；解绑后可以重新接（改 ICE 走的就是这条）', () => {
    /*
     * 违反这条不变量的后果是**静默**的：每个交互被登记两遍（第二次因 id 已存在而不重复推送，
     * 看着像没事），但 `interactionSettled` / `settleByLocal` 会跟着走两遍 —— 终态与 `by` 的归属就错了。
     */
    const emitted: Emitted[] = []
    const registry = createInteractionRegistry({
      emit: (topic, payload) => emitted.push({ topic, payload }),
    })
    const off1 = wireInteractionSources(registry)
    cleanups.push(off1)

    expect(() => wireInteractionSources(registry)).toThrow(/接了两次线/)

    // 解绑 → 重新接：这正是「改 ICE 换服务实例」的路径（旧实例 dispose、新实例 enable），必须合法
    off1()
    const off2 = wireInteractionSources(registry)
    cleanups.push(off2)

    askQuestion(registry)
    // 只登记一份、只推一次（双份接线会让这里变成 2 —— 那才是这个护栏要防的）
    expect(registry.list()).toHaveLength(1)
    expect(emitted.filter((e) => e.topic === 'host.event.interaction.requested')).toHaveLength(1)
  })
})
