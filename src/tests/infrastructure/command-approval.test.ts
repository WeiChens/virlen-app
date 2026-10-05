/**
 * command-approval 审批注册表测试 — 回归 #2
 *
 * 覆盖场景：
 * - 多个待审批命令同时存在时，确认第一个不会消费第二个的监听
 *   （旧实现：全局 once 监听器会被第一个事件即使不匹配也消费掉）
 * - sessionId / toolCallId 不匹配时不应执行
 * - 用户拒绝后注册表被清理，后续确认无效
 * - run 返回 rejected promise 时应原样交给调用方处理
 *
 * 另含 `interactionId` 精确路由回归（手机控制前置改造）：
 * 授权 / 提问的应答必须带 id，否则两个会话同时挂起时一次应答会同时 resolve 两者。
 */
import { describe, it, expect } from 'vitest'
import toolInteractEvent from '@/events/toolInteractEvent'
import { registerPendingApproval } from '@/infrastructure/tools/execute/common'
import { createCommandConfirmHandles, createNativeCommandConfirmHandles } from '@/services/tool-service/command_confirm'
import { createUserChoiceHandles } from '@/services/tool-service/user_choice'
import { toolOutputStore } from '@/infrastructure/tools/output-store'
import type { ToolExecutorResponse } from '@/domain/tools/types'

describe('command-approval 审批注册表', () => {
  it('多个待审批命令同时存在时，确认第一个不会消费第二个的监听', async () => {
    const approvalA = registerPendingApproval({
      sessionId: 's1',
      toolCallId: 'tc-A',
      run: async () => 'result-A',
    })
    const approvalB = registerPendingApproval({
      sessionId: 's1',
      toolCallId: 'tc-B',
      run: async () => 'result-B',
    })

    // 用户先确认 A
    const holderA: { result: Promise<ToolExecutorResponse> | null } = {
      result: null,
    }
    toolInteractEvent.emit('userAllowCmd', approvalA, 's1', 'tc-A', holderA)
    expect(holderA.result).not.toBeNull()
    expect(await holderA.result).toBe('result-A')

    // 再确认 B — 修复前 B 的监听会被 A 的事件消费掉，导致 command not found
    const holderB: { result: Promise<ToolExecutorResponse> | null } = {
      result: null,
    }
    toolInteractEvent.emit('userAllowCmd', approvalB, 's1', 'tc-B', holderB)
    expect(holderB.result).not.toBeNull()
    expect(await holderB.result).toBe('result-B')
  })

  it('sessionId / toolCallId 不匹配时不应执行', async () => {
    const approvalId = registerPendingApproval({
      sessionId: 's1',
      toolCallId: 'tc-A',
      run: async () => 'result-A',
    })
    const holder: { result: Promise<ToolExecutorResponse> | null } = {
      result: null,
    }
    toolInteractEvent.emit('userAllowCmd', approvalId, 's2', 'tc-A', holder)
    expect(holder.result).toBeNull()
  })

  it('用户拒绝后注册表被清理，后续确认无效', async () => {
    const approvalId = registerPendingApproval({
      sessionId: 's1',
      toolCallId: 'tc-A',
      run: async () => 'result-A',
    })
    toolInteractEvent.emit('userCmdRejected', approvalId, 's1', 'tc-A')

    const holder: { result: Promise<ToolExecutorResponse> | null } = {
      result: null,
    }
    toolInteractEvent.emit('userAllowCmd', approvalId, 's1', 'tc-A', holder)
    expect(holder.result).toBeNull()
  })

  it('run 抛错时应把 rejected promise 原样交给调用方（由上层处理）', async () => {
    const approvalId = registerPendingApproval({
      sessionId: 's1',
      toolCallId: 'tc-A',
      run: async () => {
        throw new Error('boom')
      },
    })
    const holder: { result: Promise<ToolExecutorResponse> | null } = {
      result: null,
    }
    toolInteractEvent.emit('userAllowCmd', approvalId, 's1', 'tc-A', holder)
    expect(holder.result).not.toBeNull()
    await expect(holder.result).rejects.toThrow('boom')
  })
})

/**
 * 终端内确认（Step 2 ①）—— 原生审批 handles 的分支：
 * `presentation:"terminal"` 时**不弹 modal**，改写入 toolOutputStore.pendingConfirm；
 * 提交回传改后命令（JSON），取消则 reject `cancelled`；无 presentation 时行为不变。
 */
describe('createNativeCommandConfirmHandles 终端内确认（Step 2 ①）', () => {
  it('presentation=terminal：不弹 modal、写入 pendingConfirm；提交回传改后命令', async () => {
    const handles = createNativeCommandConfirmHandles('s1')
    const shows: any[] = []
    const off = toolInteractEvent.on('showAuthorization', (...args) => {
      shows.push(args)
    })

    const p = handles.handler('confirm_command_native', {
      presentation: 'terminal',
      desc: 'npm login',
      risk: 'install',
      permName: 'terminal.install.execute',
      title: '终端安装命令执行',
      subTitle: 't',
      hint: 'h',
      toolCallId: 'tc-T',
    })

    // 不弹 modal；改在终端块里渲染可编辑命令行
    expect(shows.length).toBe(0)
    expect(toolOutputStore.get('tc-T')?.pendingConfirm?.desc).toBe('npm login')

    toolInteractEvent.emit(
      'terminalConfirmSubmit',
      'tc-T',
      'npm login --registry https://x',
    )
    await expect(p).resolves.toBe(
      JSON.stringify({ approved: true, command: 'npm login --registry https://x' }),
    )
    expect(toolOutputStore.get('tc-T')?.pendingConfirm).toBeUndefined()

    off()
    handles.cleanup()
    toolOutputStore.remove('tc-T')
  })

  it('presentation=terminal：取消 → reject cancelled 并清空 pendingConfirm', async () => {
    const handles = createNativeCommandConfirmHandles('s2')
    const p = handles.handler('confirm_command_native', {
      presentation: 'terminal',
      desc: 'gh auth login',
      toolCallId: 'tc-C',
    })
    expect(toolOutputStore.get('tc-C')?.pendingConfirm).toBeTruthy()

    toolInteractEvent.emit('terminalConfirmCancel', 'tc-C')
    await expect(p).rejects.toBe('cancelled')
    expect(toolOutputStore.get('tc-C')?.pendingConfirm).toBeUndefined()

    handles.cleanup()
    toolOutputStore.remove('tc-C')
  })

  it('无 presentation：仍走弹窗（showAuthorization），行为不变', async () => {
    const handles = createNativeCommandConfirmHandles('s3')
    const shows: any[] = []
    const off = toolInteractEvent.on('showAuthorization', (payload) => {
      shows.push(payload)
    })
    const p = handles.handler('confirm_command_native', {
      desc: 'ls',
      risk: 'safe',
      permName: 'terminal.normal.execute',
      title: '终端正常命令执行',
      subTitle: 't',
      hint: 'h',
      toolCallId: 'tc-M',
    })
    expect(shows.length).toBe(1)
    expect(shows[0].toolCallId).toBe('tc-M')
    expect(toolOutputStore.get('tc-M')?.pendingConfirm).toBeUndefined()

    // 收尾：模拟用户关闭弹窗，避免 promise 悬挂（应答必须带 interactionId）
    toolInteractEvent.emit('commandReject', shows[0].interactionId, 'cancelled')
    await expect(p).rejects.toBeTruthy()

    off()
    handles.cleanup()
  })
})

/**
 * `interactionId` 精确路由 —— 手机控制前置改造的回归
 *
 * 改造前：应答事件**只带值不带标识**，而所有 handles 实例都监听同一个全局事件 ——
 * 两个交互同时挂起时，**一次应答会同时 resolve 两者**（串扰）；手机端作为第二个
 * 应答源更是无从知道自己应答的是哪一个（见 docs/phone-control-bridge.md §7-①）。
 */
describe('interactionId 精确路由（多交互并发不串扰）', () => {
  /** 断言一个 promise 在下一轮宏任务前仍未定稿（未被串扰地提前 resolve / reject） */
  async function expectPending(p: Promise<unknown>): Promise<void> {
    let settled = false
    void p.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(settled).toBe(false)
  }

  it('授权：两个会话同时挂起，应答 A 不会 resolve B', async () => {
    const handlesA = createNativeCommandConfirmHandles('s1')
    const handlesB = createNativeCommandConfirmHandles('s2')
    const shows: any[] = []
    const off = toolInteractEvent.on('showAuthorization', (p) => {
      shows.push(p)
    })

    const pA = handlesA.handler('confirm_command_native', {
      desc: 'cmd-A',
      toolCallId: 'tc-A',
      permName: 'permission.a',
      title: 'A',
    })
    const pB = handlesB.handler('confirm_command_native', {
      desc: 'cmd-B',
      toolCallId: 'tc-B',
      permName: 'permission.b',
      title: 'B',
    })
    expect(shows.length).toBe(2)
    expect(shows[0].interactionId).not.toBe(shows[1].interactionId)
    // 载荷必须带齐会话与 tool call —— 手机端靠它路由到对应会话的视图
    expect(shows[0].sessionId).toBe('s1')
    expect(shows[1].sessionId).toBe('s2')
    expect(shows[0].toolCallId).toBe('tc-A')

    // 只应答 A
    toolInteractEvent.emit('commandResolve', shows[0].interactionId, '')
    await expect(pA).resolves.toBe('approved')
    // B 必须仍未决 —— 修复前它会被 A 的应答一起放行
    await expectPending(pB)

    // 再应答 B
    toolInteractEvent.emit('commandResolve', shows[1].interactionId, '')
    await expect(pB).resolves.toBe('approved')

    off()
    handlesA.cleanup()
    handlesB.cleanup()
  })

  it('未知 / 过期 interactionId 的应答一律忽略', async () => {
    const handles = createNativeCommandConfirmHandles('s1')
    const shows: any[] = []
    const off = toolInteractEvent.on('showAuthorization', (p) => {
      shows.push(p)
    })
    const p = handles.handler('confirm_command_native', {
      desc: 'ls',
      toolCallId: 'tc-1',
    })

    toolInteractEvent.emit('commandResolve', 'not-the-id', '')
    await expectPending(p)

    // 正确 id 仍能应答（忽略不影响后续）
    toolInteractEvent.emit('commandResolve', shows[0].interactionId, '')
    await expect(p).resolves.toBe('approved')

    off()
    handles.cleanup()
  })

  it('user_choice：两个会话同时提问，应答 A 不会 resolve B', async () => {
    const handlesA = createUserChoiceHandles('s1')
    const handlesB = createUserChoiceHandles('s2')
    const shows: any[] = []
    const off = toolInteractEvent.on('showChoice', (p) => {
      shows.push(p)
    })

    const pA = handlesA.handler('user_choice', {
      question: 'q-A',
      options: ['a1', 'a2'],
      multi: false,
      toolCallId: 'tc-A',
    })
    const pB = handlesB.handler('user_choice', {
      question: 'q-B',
      options: ['b1'],
      multi: true,
      toolCallId: 'tc-B',
    })
    expect(shows.length).toBe(2)
    expect(shows[0].sessionId).toBe('s1')
    expect(shows[0].toolCallId).toBe('tc-A')
    expect(shows[0].question).toBe('q-A')
    expect(shows[1].multi).toBe(true)

    toolInteractEvent.emit('resolve', shows[0].interactionId, { content: 'A' })
    await expect(pA).resolves.toEqual({ content: 'A' })
    await expectPending(pB)

    toolInteractEvent.emit('resolve', shows[1].interactionId, { content: 'B' })
    await expect(pB).resolves.toEqual({ content: 'B' })

    off()
    handlesA.cleanup()
    handlesB.cleanup()
  })

  it('应答后广播 interactionSettled（供第二个应答端收起 UI）', async () => {
    const handles = createNativeCommandConfirmHandles('s1')
    const shows: any[] = []
    const settled: Array<[string, string]> = []
    const offShow = toolInteractEvent.on('showAuthorization', (p) => {
      shows.push(p)
    })
    const offSettled = toolInteractEvent.on(
      'interactionSettled',
      (interactionId, outcome) => {
        settled.push([interactionId, outcome])
      },
    )

    const p = handles.handler('confirm_command_native', {
      desc: 'ls',
      toolCallId: 'tc-1',
    })
    toolInteractEvent.emit('commandReject', shows[0].interactionId, 'cancelled')
    await expect(p).rejects.toBe('cancelled')
    expect(settled).toEqual([[shows[0].interactionId, 'reject']])

    offShow()
    offSettled()
    handles.cleanup()
  })
})

/**
 * 运行结束（`cleanup()`）时必须收敛未答的交互（F4）
 *
 * `cleanup()` 是**唯一**的「运行结束」钩子（`services/chat/flow.ts` 的 finally）—— 它一跑，
 * 各 handles 的监听器就拆了。而「运行结束」≠「用户答过了」：桌面点停止 / 手机取消或删除会话 /
 * 引擎放弃这次交互请求，这四条路上这次交互都还没被回答。不收敛的三个后果：
 *   ① 那个 Promise 永不 settle（`handleUserInteractionRequest` 的 await 永远挂着、闭包被一直引用）；
 *   ② 终端块上留一行点不动的「待确认命令行」；
 *   ③ 手机侧那张卡片永远不消失 → 点一下得「该请求已在电脑上处理」。
 *
 * ⚠️ 终态是 `expired`（**没人回答**）而不是 `reject`（用户拒绝）：这两件事在手机端与埋点里含义不同。
 */
describe('运行结束时收敛未答的交互（F4）', () => {
  it('终端内确认：清 pendingConfirm + 终态 expired + Promise 收掉', async () => {
    const handles = createNativeCommandConfirmHandles('s-f4-1')
    const settled: Array<[string, string]> = []
    const offSettled = toolInteractEvent.on(
      'interactionSettled',
      (interactionId, outcome) => {
        settled.push([interactionId, outcome])
      },
    )
    const p = handles.handler('confirm_command_native', {
      presentation: 'terminal',
      desc: 'npm login',
      toolCallId: 'tc-F4',
    })
    const interactionId =
      toolOutputStore.get('tc-F4')!.pendingConfirm!.interactionId!

    // 运行结束（flow.ts 的 finally）—— 用户一直没作答
    handles.cleanup()

    expect(toolOutputStore.get('tc-F4')?.pendingConfirm).toBeUndefined()
    expect(settled).toEqual([[interactionId, 'expired']])
    await expect(p).rejects.toMatchObject({ name: 'InteractionEnded' })

    offSettled()
    toolOutputStore.remove('tc-F4')
  })

  it('弹窗授权：终态 expired + Promise 收掉', async () => {
    const handles = createCommandConfirmHandles('s-f4-2')
    const settled: Array<[string, string]> = []
    const offSettled = toolInteractEvent.on(
      'interactionSettled',
      (interactionId, outcome) => {
        settled.push([interactionId, outcome])
      },
    )
    const shown: string[] = []
    const offShow = toolInteractEvent.on('showAuthorization', (payload) => {
      shown.push(payload.interactionId)
    })
    const p = handles.handler('confirm_command', {
      desc: 'rm -rf /tmp/x',
      toolCallId: 'tc-F4-M',
    })
    expect(shown).toHaveLength(1)

    handles.cleanup()

    expect(settled).toEqual([[shown[0], 'expired']])
    await expect(p).rejects.toMatchObject({ name: 'InteractionEnded' })

    offSettled()
    offShow()
  })
})
