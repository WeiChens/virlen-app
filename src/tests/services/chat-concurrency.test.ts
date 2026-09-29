/**
 * chat 并发保护 + 会话激活测试（手机控制 M0 前置改造）
 *
 * 覆盖两件事：
 *  1. `E_BUSY` 并发保护 —— 同一会话同时只能有一个 run。
 *     桌面端靠「按钮禁用」规避重复发送，但手机端是**第二个操作源**，没有这层 UI 保护；
 *     没有该检查时，两端同时发送会起两个引擎 run 去写同一份 messages
 *     （消息交错 / 结构损坏，见 `docs/phone-control-bridge.md` §7-④）。
 *  2. `activateSession` —— 进入会话的数据侧准备（组件与手机接口层共用的唯一入口）。
 */
import { describe, it, expect, afterEach } from 'vitest'
import type { Session } from '@/types'
import { DEFAULT_SESSION_PARAMS } from '@/types'
import { sessionStore } from '@/ui/store/sessionStore'
import {
  getSessionRuntime,
  updateSessionRuntime,
  dropSessionRuntime,
  isSessionRuntimeBusy,
} from '@/ui/store/sessionRuntimeStore'
import {
  sendMessage,
  resumePausedRun,
  sendMessageWithGoal,
  activateSession,
} from '@/services/chat-service'

const BUSY_MSG = '该会话正在回复中，请等待完成或先取消'

/** 构造一个最小可用会话（默认**不带** modelId / providerConfigId） */
function makeSession(id: string, over: Partial<Session> = {}): Session {
  return {
    id,
    title: `t-${id}`,
    messages: [],
    providerConfigId: '',
    modelId: '',
    systemPrompt: '',
    params: { ...DEFAULT_SESSION_PARAMS },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    pinned: false,
    tags: [],
    ...over,
  }
}

/** 登记本次测试创建的会话，供 afterEach 清理（避免跨用例串味） */
const created: string[] = []
function seed(over: Partial<Session> = {}): string {
  const id = `m0-${created.length}-${Math.random().toString(36).slice(2, 8)}`
  sessionStore.saveSession(makeSession(id, over))
  created.push(id)
  return id
}

afterEach(() => {
  dropSessionRuntime(created)
  sessionStore.deleteSessions(created.splice(0))
})

describe('会话并发保护（E_BUSY）', () => {
  it('会话正在回复时：sendMessage 被拒绝，并说明原因', async () => {
    const id = seed()
    updateSessionRuntime(id, { working: true })
    const errors: string[] = []
    await sendMessage(id, 'hello', { onError: (_s, m) => errors.push(m) })
    expect(errors).toEqual([BUSY_MSG])
  })

  it('被拒绝时不写入用户消息（不污染会话内容）', async () => {
    const id = seed()
    updateSessionRuntime(id, { working: true })
    await sendMessage(id, 'hello', { onError: () => {} })
    expect(sessionStore.getSession(id)?.messages.length).toBe(0)
  })

  it('并发检查优先于其它校验（模型未选也先报「忙」）', async () => {
    // 该会话故意不带 modelId：若检查顺序颠倒，这里会报「未选择模型」
    const id = seed()
    updateSessionRuntime(id, { working: true })
    const errors: string[] = []
    await sendMessage(id, 'hello', { onError: (_s, m) => errors.push(m) })
    expect(errors).toEqual([BUSY_MSG])
  })

  it('空闲时不会被并发检查误拦（继续走到下一道校验）', async () => {
    const id = seed()
    updateSessionRuntime(id, { working: false })
    const errors: string[] = []
    await sendMessage(id, 'hello', { onError: (_s, m) => errors.push(m) })
    expect(errors).toEqual(['未选择模型'])
  })

  it('resumePausedRun / sendMessageWithGoal 受同一判据保护', async () => {
    const id = seed()
    updateSessionRuntime(id, { working: true })
    const resumeErrors: string[] = []
    const goalErrors: string[] = []
    await resumePausedRun(id, { onError: (_s, m) => resumeErrors.push(m) })
    await sendMessageWithGoal(id, 'hello', 'goal', {
      onError: (_s, m) => goalErrors.push(m),
    })
    expect(resumeErrors).toEqual([BUSY_MSG])
    expect(goalErrors).toEqual([BUSY_MSG])
  })

  it('暂停态（working+paused）不是「忙」：「继续」能进入恢复流程', async () => {
    // 回归缺陷：resumePausedRun 曾复用 isSessionBusy（只看 working），
    // 而暂停态的 working 仍为 true → 点「继续」必被误拦。此用例锁死该行为。
    const id = seed()
    updateSessionRuntime(id, { working: true, paused: true })
    const errors: string[] = []
    await resumePausedRun(id, { onError: (_s, m) => errors.push(m) })
    // 未被 BUSY_MSG 拦下 → 继续走到「无快照」分支（测试环境无 Tauri 引擎，快照恒为 null）
    expect(errors).toEqual(['没有可恢复的暂停任务'])
  })

  it('会话不存在时仍报「会话不存在」（先于并发检查）', async () => {
    const errors: string[] = []
    await sendMessage('no-such-session', 'hello', {
      onError: (_s, m) => errors.push(m),
    })
    expect(errors).toEqual(['会话不存在'])
  })

  it('本地前置处理（preparing：图片本地识别）不算「忙」，本次发送不被自己的锁拦下', async () => {
    // 回归缺陷（2026-10 用户报）：`chat-view.doSend` 为了点亮「视觉分析中」指示器写了
    // `working: true`，而本地识别结束后紧接着的 sendMessage 开头就是这把锁 ——
    // 用户消息已显示，却报「该会话正在回复中，请等待完成或先取消」。
    // 修法：本地准备换用 `preparing`（锁只认 `working`）。
    const id = seed()
    updateSessionRuntime(id, { preparing: true })
    const errors: string[] = []
    await sendMessage(id, 'hello', { onError: (_s, m) => errors.push(m) })
    // 没被 BUSY 拦下 → 继续走到下一道校验（该会话故意不带 modelId）
    expect(errors).toEqual(['未选择模型'])
  })

  it('同一判据覆盖 sendMessageWithGoal / resumePausedRun', async () => {
    const id = seed()
    updateSessionRuntime(id, { preparing: true })
    const goalErrors: string[] = []
    const resumeErrors: string[] = []
    await sendMessageWithGoal(id, 'hello', 'goal', {
      onError: (_s, m) => goalErrors.push(m),
    })
    await resumePausedRun(id, { onError: (_s, m) => resumeErrors.push(m) })
    expect(goalErrors).toEqual(['未选择模型'])
    // 恢复路径用的是「活跃执行」判据（working && !paused），preparing 同样不算
    expect(resumeErrors).toEqual(['没有可恢复的暂停任务'])
  })

  it('本地准备结束后重新被锁（preparing 不泄露到 run 阶段）', async () => {
    const id = seed()
    // 识别结束 → 引擎开跑：此时必须重新拦住手机端 / 第二个操作源
    updateSessionRuntime(id, { preparing: false, working: true })
    const errors: string[] = []
    await sendMessage(id, 'hello', { onError: (_s, m) => errors.push(m) })
    expect(errors).toEqual([BUSY_MSG])
  })
})

describe('isSessionRuntimeBusy（界面用的「在忙」，不是锁）', () => {
  it('working 或 preparing 任一为真 → 忙（指示器不因本地识别而闪断）', () => {
    const id = seed()
    const busy = () => isSessionRuntimeBusy(getSessionRuntime(id))
    expect(busy()).toBe(false)
    updateSessionRuntime(id, { preparing: true })
    expect(busy()).toBe(true)
    updateSessionRuntime(id, { preparing: false, working: true })
    expect(busy()).toBe(true)
    updateSessionRuntime(id, { working: false })
    expect(busy()).toBe(false)
  })
})

describe('activateSession（进入会话的数据侧准备）', () => {
  it('会话不存在 → 返回 null（调用方据此不切）', async () => {
    expect(await activateSession('no-such-session')).toBeNull()
  })

  it('激活会清除「新回复」标记', async () => {
    const id = seed()
    updateSessionRuntime(id, { hasNewReply: true })
    const session = await activateSession(id)
    expect(session?.id).toBe(id)
    expect(getSessionRuntime(id).hasNewReply).toBe(false)
  })

  it('重复激活是幂等的（第二次不应报错，也不改变会话标识）', async () => {
    const id = seed()
    const first = await activateSession(id)
    const second = await activateSession(id)
    expect(first?.id).toBe(id)
    expect(second?.id).toBe(id)
  })
})
