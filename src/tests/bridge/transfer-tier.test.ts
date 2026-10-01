/**
 * §33 传输档位 —— 「TURN 中继 / 类型未知时，只发主要内容」。
 *
 * 为什么值得这么测：档位裁剪是**不可见的**。用户在手机上只会看到「输出已省略」，看不出
 * 「本来会发什么」，也看不出“是策略省略”还是“电脑端根本没发”。所以口径必须钉在两端：
 *  - 该省的一定要省（否则这个功能等于没做）；
 *  - 不该省的**一个字节都不能少** —— 尤其是「旧手机端」这条：它不认 `detail` 字段，
 *    被省略的正文会被它显示成「这次调用没有输出」，那是**假话**。
 *
 * 覆盖三层：
 *  1. 投影层（`toMessageDTO`）：裁什么、不裁什么、什么时候打标记；
 *  2. 端到端（memory transport）：推送与**拉取**同档（少了拉取半边就有缝：重开会话会把
 *     刚省下的流量又花出去）；能力闸门（旧手机端拿全量）；
 *  3. 回归：**档位变化本身不得触发任何事件** —— 否则「切到精简」会经由*别的消息*引起的
 *     整会话 diff，把手机上已经收到的正文静默抹掉（用户读到一半的输出凭空消失）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  Endpoint,
  createCaller,
  createMemoryPair,
  createSubscriber,
  type HostApi,
  type HostEvents,
  type MessageDTO,
  type TransferTier,
} from 'virlen-remote'
import {
  MESSAGE_DETAIL_CAPABILITY,
  startPhoneBridge,
  toMessageDTO,
  type PhoneBridge,
} from '@/bridge'
import { sessionStore } from '@/ui/store'
import { addSessionMessage } from '@/services/chat-service'
import type { Message, Session } from '@/types'

const flush = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 等条件成立（内存传输的事件投递是异步的）。 */
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时')
    await flush(5)
  }
}

const cleanups: Array<() => void> = []

interface Harness {
  caller: ReturnType<typeof createCaller<HostApi>>
  sub: ReturnType<typeof createSubscriber<HostEvents>>
  bridge: PhoneBridge
  deviceToken: string
}

/**
 * 起一条内存链路。
 *
 * `tier` 传的是**策略档位**（等价于 `PhoneControlService` 注入的 `transferTierOf(kindWatch.kind)`）：
 * 只有它还不够 —— 真正生效还要看手机端有没有声明 `MESSAGE_DETAIL_CAPABILITY`（见下面的 hello）。
 */
function setup(tier?: () => TransferTier): Harness {
  const [hostT, mobileT] = createMemoryPair()
  const hostEp = new Endpoint({ transport: hostT, defaultTimeoutMs: 2000 })
  const mobileEp = new Endpoint({ transport: mobileT, defaultTimeoutMs: 2000 })
  const bridge = startPhoneBridge(hostEp, {
    deviceName: '测试电脑',
    deviceId: 'host-tier',
    ...(tier ? { transferTier: tier } : {}),
  })
  const device = bridge.pairing.register('测试手机')
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
    bridge,
    deviceToken: device.token,
  }
}

/** hello 参数：`detail` = 手机端是否声明「我能渲染省略标记」（老手机端不声明）。 */
const helloParams = (token?: string, opts: { detail?: boolean } = {}) => ({
  protocolVersion: 1,
  client: { platform: 'test', appVersion: '0' },
  capabilities: opts.detail ? [MESSAGE_DETAIL_CAPABILITY] : ['session.list'],
  mobileKey: 'mk-3333333333333333',
  mobileName: '测试手机',
  ...(token ? { token } : {}),
})

function makeSession(id: string, title: string): Session {
  const now = Date.now()
  return {
    id,
    title,
    messages: [],
    providerConfigId: 'p1',
    modelId: 'm1',
    systemPrompt: 'SECRET',
    params: { temperature: 0, topP: 0, maxTokens: 0, stream: true },
    createdAt: now,
    updatedAt: now,
    pinned: false,
    tags: [],
    workspace: 'C:/secret/workspace',
  }
}

/** 一条工具输出（正文可达数 KB —— 手机上最大的一笔流量）。 */
function toolMessage(id: string, toolCallId: string, text: string): Message {
  return { id, role: 'tool', content: text, toolCallId, timestamp: Date.now() }
}

/** 发起该工具调用的 assistant 消息（工具名靠它反查）。 */
function assistantToolCall(id: string, toolCallId: string, name: string): Message {
  return {
    id,
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    toolCalls: [{ type: 'tool_use', id: toolCallId, name, input: {} }],
  }
}

afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
  sessionStore.clear()
})

// ───────────────────────── 1. 投影层：裁什么、不裁什么 ─────────────────────────

describe('toMessageDTO —— 档位只裁「详细内容」（工具输出正文）', () => {
  it('精简档 + 工具输出 → 正文清空 + `detail:omitted`，且**保留工具名**', () => {
    const dto = toMessageDTO(toolMessage('t1', 'tc1', 'git diff 的一大段输出'), new Map([['tc1', 'run_command']]), 'lean')
    expect(dto.text).toBe('')
    expect(dto.detail).toBe('omitted')
    // 「这一步调了什么」必须留着：否则会话里会凭空少一步（用户不知道 AI 干了什么）
    expect(dto.toolName).toBe('run_command')
  })

  it('精简档不动其它角色：assistant 正文 / 用户消息 / 压缩摘要一律完整', () => {
    const assistant = toMessageDTO({ id: 'a1', role: 'assistant', content: '这是正文', timestamp: 0 }, undefined, 'lean')
    expect(assistant.text).toBe('这是正文')
    expect('detail' in assistant).toBe(false)

    const user = toMessageDTO({ id: 'u1', role: 'user', content: '你好', timestamp: 0 }, undefined, 'lean')
    expect(user.text).toBe('你好')

    const summary = toMessageDTO({ id: 's1', role: 'summary', content: '[上下文摘要] 很长', timestamp: 0 }, undefined, 'lean')
    expect(summary.role).toBe('system')
    expect(summary.text).toBe('[上下文摘要] 很长')
  })

  it('本来就没输出的工具消息**不打**省略标记：不能把「真没输出」反过来说成「被省略」', () => {
    const empty = toMessageDTO(toolMessage('t2', 'tc2', ''), undefined, 'lean')
    expect(empty.text).toBe('')
    expect('detail' in empty).toBe(false)
    // 纯空白同理（与手机端 `hasBody()` 同一口径）
    const blank = toMessageDTO(toolMessage('t3', 'tc3', '\n  \n'), undefined, 'lean')
    expect('detail' in blank).toBe(false)
  })

  it('完整档 / 不传档位 → 与旧行为逐字节一致（裁剪必须是显式选择，不能因忘传参而发生）', () => {
    const message = toolMessage('t4', 'tc4', '输出')
    const full = toMessageDTO(message, undefined, 'full')
    const byDefault = toMessageDTO(message)
    expect(full.text).toBe('输出')
    expect(byDefault.text).toBe('输出')
    expect('detail' in full).toBe(false)
  })
})

// ───────────────────────── 2. 端到端：推送 / 拉取 / 能力闸门 ─────────────────────────

describe('store-bridge —— 精简档下推送与拉取同档', () => {
  it('精简档 + 手机声明能力 → 工具输出推送被省略（正文完整的那条不受影响）', async () => {
    sessionStore.saveSession(makeSession('s-tier-1', '档位'))
    const h = setup(() => 'lean')
    await h.caller.call('host.hello', helloParams(h.deviceToken, { detail: true }))
    await h.caller.call('host.session.subscribe', { sessionId: 's-tier-1' })

    const added: Array<HostEvents['host.event.message.added']> = []
    h.sub.subscribe('host.event.message.added', (p) => added.push(p))

    addSessionMessage('s-tier-1', assistantToolCall('asst-1', 'tc-1', 'write_file'))
    addSessionMessage('s-tier-1', toolMessage('tool-1', 'tc-1', '写了 2KB 的内容'))
    addSessionMessage('s-tier-1', { id: 'asst-2', role: 'assistant', content: '正文在这里', timestamp: Date.now() })
    await waitFor(() => added.length >= 3)

    const tool = added.find((e) => e.message.id === 'tool-1')!.message
    expect(tool.text).toBe('')
    expect(tool.detail).toBe('omitted')
    expect(tool.toolName).toBe('write_file')

    // 正文是「主要内容」：一个字节都不许少
    const answer = added.find((e) => e.message.id === 'asst-2')!.message
    expect(answer.text).toBe('正文在这里')
    expect('detail' in answer).toBe(false)
  })

  it('精简档下拉取（窗口）同样省略 —— 推送省了、拉取漏了就等于流量白省', async () => {
    sessionStore.saveSession(makeSession('s-tier-2', '档位'))
    addSessionMessage('s-tier-2', assistantToolCall('asst-1', 'tc-1', 'read_file'))
    addSessionMessage('s-tier-2', toolMessage('tool-1', 'tc-1', '很长的文件内容'))
    const h = setup(() => 'lean')
    await h.caller.call('host.hello', helloParams(h.deviceToken, { detail: true }))

    const page = await h.caller.call('host.session.messages', { sessionId: 's-tier-2' })
    const tool = page.messages.find((m) => m.id === 'tool-1') as MessageDTO
    expect(tool.text).toBe('')
    expect(tool.detail).toBe('omitted')
    expect(tool.toolName).toBe('read_file')

    // 单条拉取（流式对齐路径）也走同一档位
    const single = await h.caller.call('host.session.message.get', { sessionId: 's-tier-2', messageId: 'tool-1' })
    expect(single.message.detail).toBe('omitted')
    expect(single.message.text).toBe('')
  })

  it('旧手机端（未声明能力）→ 即便档位是精简，也**全量**下发（它会把省略显示成「没有输出」）', async () => {
    sessionStore.saveSession(makeSession('s-tier-3', '档位'))
    const h = setup(() => 'lean')
    // ⚠️ 不声明 `MESSAGE_DETAIL_CAPABILITY` = 老客户端
    await h.caller.call('host.hello', helloParams(h.deviceToken, { detail: false }))

    addSessionMessage('s-tier-3', assistantToolCall('asst-1', 'tc-1', 'read_file'))
    addSessionMessage('s-tier-3', toolMessage('tool-1', 'tc-1', '很长的文件内容'))
    const after = await h.caller.call('host.session.messages', { sessionId: 's-tier-3' })
    const tool = after.messages.find((m) => m.id === 'tool-1') as MessageDTO
    expect(tool.text).toBe('很长的文件内容')
    expect('detail' in tool).toBe(false)
  })

  it('老电脑（不传档位）→ 默认完整：档位是显式选择，缺省绝不裁剪', async () => {
    sessionStore.saveSession(makeSession('s-tier-4', '档位'))
    const h = setup()
    await h.caller.call('host.hello', helloParams(h.deviceToken, { detail: true }))
    addSessionMessage('s-tier-4', toolMessage('tool-1', 'tc-1', '输出'))
    const page = await h.caller.call('host.session.messages', { sessionId: 's-tier-4' })
    expect((page.messages.find((m) => m.id === 'tool-1') as MessageDTO).text).toBe('输出')
  })
})

// ───────────────────────── 3. 回归：档位变化本身不发任何事件 ─────────────────────────

describe('档位切换 —— 只影响「下一次发什么」，不改写已发出的事实', () => {
  it('完整档发过的工具输出，切到精简档后**不会**被重推成「已省略」', async () => {
    sessionStore.saveSession(makeSession('s-tier-5', '档位'))
    let tier: TransferTier = 'full'
    const h = setup(() => tier)
    await h.caller.call('host.hello', helloParams(h.deviceToken, { detail: true }))
    await h.caller.call('host.session.subscribe', { sessionId: 's-tier-5' })

    const added: Array<HostEvents['host.event.message.added']> = []
    const updated: Array<HostEvents['host.event.message.updated']> = []
    h.sub.subscribe('host.event.message.added', (p) => added.push(p))
    h.sub.subscribe('host.event.message.updated', (p) => updated.push(p))

    addSessionMessage('s-tier-5', toolMessage('tool-1', 'tc-1', '手机上已经读到的输出'))
    await waitFor(() => added.some((e) => e.message.id === 'tool-1'))
    expect(added.find((e) => e.message.id === 'tool-1')!.message.text).toBe('手机上已经读到的输出')

    // 链路变成中继：切档位
    tier = 'lean'
    /*
     * 关键触发点：本函数在**任何**消息变化时都会跑过该会话的**全部**消息 ——
     * 所以随便动一条别的消息，就能把「切档位会不会顺手改写老消息」这件事逼出来。
     */
    addSessionMessage('s-tier-5', { id: 'u-2', role: 'user', content: '再问一句', timestamp: Date.now() })
    await waitFor(() => added.some((e) => e.message.id === 'u-2'))
    await flush(20)

    expect(updated.filter((e) => e.message.id === 'tool-1')).toHaveLength(0)
  })

  it('切档位之后**新产生**的工具输出按新档位发', async () => {
    sessionStore.saveSession(makeSession('s-tier-6', '档位'))
    let tier: TransferTier = 'full'
    const h = setup(() => tier)
    await h.caller.call('host.hello', helloParams(h.deviceToken, { detail: true }))
    await h.caller.call('host.session.subscribe', { sessionId: 's-tier-6' })

    const added: Array<HostEvents['host.event.message.added']> = []
    h.sub.subscribe('host.event.message.added', (p) => added.push(p))

    addSessionMessage('s-tier-6', toolMessage('tool-old', 'tc-old', '完整档的输出'))
    await waitFor(() => added.some((e) => e.message.id === 'tool-old'))

    tier = 'lean'
    addSessionMessage('s-tier-6', toolMessage('tool-new', 'tc-new', '精简档的输出'))
    await waitFor(() => added.some((e) => e.message.id === 'tool-new'))

    expect(added.find((e) => e.message.id === 'tool-old')!.message.text).toBe('完整档的输出')
    const fresh = added.find((e) => e.message.id === 'tool-new')!.message
    expect(fresh.text).toBe('')
    expect(fresh.detail).toBe('omitted')
  })
})
