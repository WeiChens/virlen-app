/**
 * JS 桥接层：用户交互回执的**异常路径**与处理器归属（真机缺陷回归，2026-10）。
 *
 * 两个缺陷（都在 `services/rust-engine.ts`）：
 *
 * 1. **静默消费**：会话没有注册处理器时，桥接层**静静**回 `{__kind:'cancelled'}` ——
 *    Rust 侧据此把工具结果写成 `[User cancelled]`，AI 顺势跳过这一步，界面上不留任何痕迹。
 *    真相是「没人能应答」，却伪装成「用户取消」：用户与排查者都无从知道**这个问题从未被展示**。
 *    现在：留痕（控制台 + 埋点 `error.bridge`）+ 回 `error`（作工具失败结果，消息流里看得见）。
 *
 * 2. **注销无归属校验**：只按 `sessionId` 注销，交错的 run（同一会话重发 / 手机端与桌面端
 *    几乎同时发 / 暂停恢复）会互相删表 —— 先结束的那个把后一个的处理器删掉，后一个的
 *    提问或授权就落到上面那条分支。现在：注册返回**归属令牌**，注销时校验。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import {
  handleUserInteractionRequest,
  registerSessionToolHandler,
  unregisterSessionToolHandler,
} from '@/services/rust-engine'
import { InteractionEnded } from '@/services/tool-service/interaction-end'

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}))

const QUESTION = {
  requestId: 'req-1',
  sessionId: 's1',
  type: 'user_choice',
  data: { question: '选哪个？', options: ['A', 'B'], toolCallId: 'tc-1' },
}

/** 最近一次 `agent_user_interaction_response` 的回执载荷。 */
function lastPayload(): any {
  const calls = vi.mocked(invoke).mock.calls
  const call = [...calls].reverse().find((c) => c[0] === 'agent_user_interaction_response')
  if (!call) throw new Error('没有回执调用')
  return (call[1] as any).payload
}

beforeEach(() => {
  vi.mocked(invoke).mockClear()
  // 无令牌 = 无条件注销（测试清理用；生产路径一律带令牌）
  unregisterSessionToolHandler('s1')
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('用户交互回执：无处理器时不许伪装成「用户取消」', () => {
  it('回 error（不是 cancelled）并留下控制台痕迹', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await handleUserInteractionRequest(QUESTION)

    const payload = lastPayload()
    expect(payload.__kind).toBe('error')
    // 给模型看的英文说明：说清「问题没被展示」，并明确叫它别重试
    expect(String(payload.message)).toMatch(/never shown/i)
    expect(warn).toHaveBeenCalled()
    expect(String(warn.mock.calls[0]?.[0])).toContain('没有注册处理器')
  })

  it('有处理器时照旧回 value（含 uiData）', async () => {
    registerSessionToolHandler('s1', async () => ({
      content: 'A',
      uiData: { selected: ['A'], customReply: '' },
    }))

    await handleUserInteractionRequest(QUESTION)

    expect(lastPayload()).toEqual({
      __kind: 'value',
      value: 'A',
      uiData: { selected: ['A'], customReply: '' },
    })
  })
})

describe('处理器归属：交错的 run 不许互相删表', () => {
  it('旧 run 收尾（带自己的令牌）不会删掉新 run 的处理器', async () => {
    const tokenA = registerSessionToolHandler('s1', async () => 'A')
    const tokenB = registerSessionToolHandler('s1', async () => 'B') // 后一轮顶替

    unregisterSessionToolHandler('s1', tokenA) // 旧 run 的 finally

    await handleUserInteractionRequest(QUESTION)
    expect(lastPayload()).toEqual({ __kind: 'value', value: 'B' })

    unregisterSessionToolHandler('s1', tokenB)
    await handleUserInteractionRequest(QUESTION)
    expect(lastPayload().__kind).toBe('error')
  })

  it('拿别人的令牌注销无效', async () => {
    const token = registerSessionToolHandler('s1', async () => 'A')

    unregisterSessionToolHandler('s1', {}) // 外来令牌

    await handleUserInteractionRequest(QUESTION)
    expect(lastPayload()).toEqual({ __kind: 'value', value: 'A' })

    unregisterSessionToolHandler('s1', token)
    await handleUserInteractionRequest(QUESTION)
    expect(lastPayload().__kind).toBe('error')
  })

  it('处理器抛错仍回 cancelled（真·用户取消/失败路径不变）', async () => {
    registerSessionToolHandler('s1', async () => {
      throw new Error('boom')
    })

    await handleUserInteractionRequest(QUESTION)

    expect(lastPayload()).toEqual({ __kind: 'cancelled' })
  })

  it('处理器抛 InteractionEnded（运行结束收敛）→ 回 error（不是 cancelled）', async () => {
    /*
     * 「运行结束」不是「用户点了取消」：桌面点停止 / 手机取消或删除会话 / 引擎放弃时，
     * handles 在 `cleanup()` 里用 `InteractionEnded` 收敛未答的交互。若伪装成 `[User cancelled]`，
     * 就等于告诉 AI「用户拒绝了这次提问」—— 那是假话（同本文件第 1 条纪律）。
     */
    registerSessionToolHandler('s1', async () => {
      throw new InteractionEnded()
    })

    await handleUserInteractionRequest(QUESTION)

    const payload = lastPayload()
    expect(payload.__kind).toBe('error')
    expect(String(payload.message)).toMatch(/never answered/i)
  })
})
