/**
 * 真机反馈（2026-10）：「工具在电脑上有显示，手机上什么都看不到」—— 电脑侧这一半。
 *
 * 现象：AI 执行工具的那段时间（从「参数生成完」到「结果回来」），电脑上有一张呼吸点卡片
 * （工具名 + 关键入参），而手机端**从头到尾只有「正在思考…」** —— 用户以为卡死了。
 *
 * 根因不是「坏了」而是「从未下行」：那段状态只活在**电脑侧界面**里（桌面用
 * `message-bubble.tsx` + `use-virtual-list.ts::toolResultsFor` 把「assistant 的 `toolCalls[]`
 * 减掉已有结果」推导成 pending 卡片），而工具消息（`role:'tool'`）只在**执行完之后**才
 * 作为消息下行；隔壁那个 `toolProgress` 又只管**累积参数**那段（工具一开跑就被清掉）。
 *
 * 本文件盯住投影与推送两半：
 * 1. `runningToolsOf` 的判据与桌面 pending 卡片逐字一致（声明 − 已有结果）；
 * 2. 摘要与工具消息的 `toolArgs` **同源**（`summarizeToolArgs` + 同一份 shortenPath），
 *    且**绝不含参数正文**；
 * 3. 只认 `working === true`（run 没在跑时，那些没结果的调用只是历史遗留，不是「正在执行」）；
 * 4. 推送：工具开跑 → 一帧带 `runningTools`；结果到达 → 一帧**不带**该字段（手机据此收掉）；
 * 5. 订阅门照旧（未订阅的会话一个字节都不发）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  Endpoint,
  createCaller,
  createMemoryPair,
  createSubscriber,
  type HostApi,
  type HostEvents,
} from 'virlen-remote'
import { startPhoneBridge } from '@/bridge'
import { buildToolCallIndex, toMessageDTO, toRuntimeDTO } from '@/bridge/dto'
import { addSessionMessage } from '@/services/chat-service'
import { sessionRuntimeState, sessionStore, updateSessionRuntime } from '@/ui/store'
import type { Message, Session, ToolUseContent } from '@/types'

const flush = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时')
    await flush(5)
  }
}

const cleanups: Array<() => void> = []

function setup() {
  const [hostT, mobileT] = createMemoryPair()
  const hostEp = new Endpoint({ transport: hostT, defaultTimeoutMs: 2000 })
  const mobileEp = new Endpoint({ transport: mobileT, defaultTimeoutMs: 2000 })
  const bridge = startPhoneBridge(hostEp, { deviceName: '测试电脑', deviceId: 'host-test' })
  cleanups.push(() => {
    bridge.dispose()
    hostEp.dispose()
    mobileEp.dispose()
    hostT.close()
    mobileT.close()
  })
  return {
    caller: createCaller<HostApi>(mobileEp),
    sub: createSubscriber<HostEvents>(mobileEp),
  }
}

function makeSession(id: string, workspace?: string): Session {
  const now = Date.now()
  return {
    id,
    title: '工具执行中',
    messages: [],
    providerConfigId: 'p1',
    modelId: 'm1',
    systemPrompt: 'SECRET',
    params: { temperature: 0, topP: 0, maxTokens: 0, stream: true },
    createdAt: now,
    updatedAt: now,
    pinned: false,
    tags: [],
    ...(workspace ? { workspace } : {}),
  }
}

const call = (id: string, name: string, input: Record<string, unknown>): ToolUseContent => ({
  type: 'tool_use',
  id,
  name,
  input,
})

/** 一条 assistant 消息：声明若干 `tool_calls`（引擎在执行工具**之前**就落库/下发它）。 */
function assistantWithCalls(id: string, calls: ToolUseContent[]): Message {
  return { id, role: 'assistant', content: '', toolCalls: calls, timestamp: Date.now() }
}

function toolResult(id: string, toolCallId: string, content: string): Message {
  return { id, role: 'tool', content, toolCallId, timestamp: Date.now() }
}

beforeEach(() => {
  sessionStore.clear()
  sessionRuntimeState.setValue('sessions', {})
})

afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
  sessionStore.clear()
  sessionRuntimeState.setValue('sessions', {})
})

// ───────────────────────── 投影：谁在跑 ─────────────────────────

describe('toRuntimeDTO.runningTools —— 「已声明、结果还没到」的那些调用', () => {
  it('同批两个调用、只有一个出了结果 → 只剩那个还在跑的；结果到达后清空', () => {
    sessionStore.saveSession(makeSession('s-run-1', 'E:/code/demo'))
    addSessionMessage(
      's-run-1',
      assistantWithCalls('a1', [
        call('tc1', 'read_file', { path: 'E:/code/demo/src/a.ts' }),
        call('tc2', 'execute_command', { command: 'npm test' }),
      ]),
    )
    updateSessionRuntime('s-run-1', { working: true })

    let running = toRuntimeDTO('s-run-1').runningTools!
    expect(running.map((t) => t.toolCallId)).toEqual(['tc1', 'tc2'])
    // 摘要与工具消息的 `toolArgs` **同源**：同一个格式化口径、同一份路径缩短
    const index = buildToolCallIndex(sessionStore.getSession('s-run-1')!.messages)
    const dto = toMessageDTO(toolResult('t1', 'tc1', '文件内容'), index, 'full', {
      sessionId: 's-run-1',
    })
    expect(running[0].args).toBe('src/a.ts')
    expect(running[0].args).toBe(dto.toolArgs)
    expect(running[1].args).toBe('npm test')
    // 入参正文绝不下行（`toolArgs` 唯一可能的形态就是一行摘要）
    expect(JSON.stringify(running)).not.toContain('E:/code/demo')

    // 结果到达 → 那一条不再「执行中」（判据与桌面 pending 卡片一致）
    addSessionMessage('s-run-1', toolResult('t1', 'tc1', '文件内容'))
    running = toRuntimeDTO('s-run-1').runningTools!
    expect(running.map((t) => t.toolCallId)).toEqual(['tc2'])

    // 两个都回来了 → 字段整个缺席（手机端 `?? undefined` 即清空）
    addSessionMessage('s-run-1', toolResult('t2', 'tc2', '用例全绿'))
    expect('runningTools' in toRuntimeDTO('s-run-1')).toBe(false)
  })

  it('会话没在跑（working=false）时一律不下发：没结果的调用只是历史遗留', () => {
    sessionStore.saveSession(makeSession('s-run-2'))
    addSessionMessage('s-run-2', assistantWithCalls('a1', [call('tc1', 'read_file', { path: 'x' })]))
    // 崩了 / 被取消 / 重启后残留的悬空 tool_calls：手机端不该看到一行永远「正在执行」
    updateSessionRuntime('s-run-2', { working: false })
    expect('runningTools' in toRuntimeDTO('s-run-2')).toBe(false)
    // 跑起来才是「正在执行」
    updateSessionRuntime('s-run-2', { working: true })
    expect(toRuntimeDTO('s-run-2').runningTools).toEqual([
      { toolCallId: 'tc1', name: 'read_file', args: 'x' },
    ])
  })

  it('拿不到 name 的调用不猜、不列（宁缺勿造）', () => {
    sessionStore.saveSession(makeSession('s-run-3'))
    addSessionMessage(
      's-run-3',
      assistantWithCalls('a1', [{ type: 'tool_use', id: 'tc1', name: '', input: {} }]),
    )
    updateSessionRuntime('s-run-3', { working: true })
    expect('runningTools' in toRuntimeDTO('s-run-3')).toBe(false)
  })
})

// ───────────────────────── 推送：工具开跑 / 跑完 ─────────────────────────

describe('推送通道 —— 工具开跑与跑完各一帧', () => {
  it('订阅后：声明工具 → 带 runningTools 的帧；结果到达 → 不带该字段的帧', async () => {
    sessionStore.saveSession(makeSession('s-push-1', 'E:/code/demo'))
    const h = setup()
    const frames: NonNullable<HostEvents['host.event.session.runtime.changed']['runtime']>[] = []
    h.sub.subscribe('host.event.session.runtime.changed', (p) => {
      frames.push((p as HostEvents['host.event.session.runtime.changed']).runtime)
    })
    await h.caller.call('host.session.subscribe', { sessionId: 's-push-1' })

    // 引擎拿到 tool_calls → 先落 assistant 消息（含 toolCalls）→ 再执行
    updateSessionRuntime('s-push-1', { working: true })
    addSessionMessage(
      's-push-1',
      assistantWithCalls('a1', [call('tc1', 'read_file', { path: 'E:/code/demo/src/a.ts' })]),
    )
    await waitFor(() => frames.some((f) => f.runningTools != null))
    expect(frames.find((f) => f.runningTools != null)!.runningTools).toEqual([
      { toolCallId: 'tc1', name: 'read_file', args: 'src/a.ts' },
    ])

    // 工具跑完 → 结果消息到达 → 手机端收掉那一行
    const before = frames.length
    addSessionMessage('s-push-1', toolResult('t1', 'tc1', '文件内容'))
    await waitFor(() => frames.length > before && frames[frames.length - 1].runningTools == null)
    expect('runningTools' in frames[frames.length - 1]).toBe(false)
  })

  it('只推被订阅的会话（未订阅的会话一个字节都不发）', async () => {
    sessionStore.saveSession(makeSession('s-push-a'))
    sessionStore.saveSession(makeSession('s-push-b'))
    const h = setup()
    const frames: HostEvents['host.event.session.runtime.changed'][] = []
    h.sub.subscribe('host.event.session.runtime.changed', (p) => {
      frames.push(p as HostEvents['host.event.session.runtime.changed'])
    })
    await h.caller.call('host.session.subscribe', { sessionId: 's-push-a' })

    updateSessionRuntime('s-push-b', { working: true })
    addSessionMessage('s-push-b', assistantWithCalls('a1', [call('tc1', 'read_file', { path: 'x' })]))
    await flush(30)
    expect(frames.filter((f) => f.sessionId === 's-push-b')).toHaveLength(0)
  })
})
