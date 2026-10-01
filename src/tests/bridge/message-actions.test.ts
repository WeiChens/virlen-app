/**
 * §36 消息级操作（引用 / 删除单条）—— 电脑侧实现用例。
 *
 * 这两件事都得在**真实 bridge 代码 + memory transport** 上验，理由是它们的失败都**不报错**：
 *
 * 1. **引用**：`quotes` 是 `host.session.send` 的一个普通字段。电脑端若不认它，RPC 照样
 *    成功 —— 用户只会发现「我明明引用了，AI 却当没看见」。所以这里既钉「参数确实进了
 *    内容块结构（与桌面同一条 `buildUserContent`）」，也钉「下行时以结构化 `quotes` 回来、
 *    且不再混在 `text` 里」（否则手机端会把同一段引文显示两遍）。
 * 2. **删除**：它是**不可逆的截断**。三道闸（confirm / 回复中 / 工具消息）必须在**服务端**
 *    成立 —— 手机 UI 的二次确认不算数（§7-⑪）。用例一律绕开类型包装直打线上方法。
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  Endpoint,
  MESSAGE_DELETE_CAPABILITY,
  MESSAGE_QUOTE_CAPABILITY,
  createCaller,
  createMemoryPair,
  createSubscriber,
  type HostApi,
  type HostEvents,
  type MessageDTO,
} from 'virlen-remote'
import { collectQuotes, projectContentToText, startPhoneBridge, toMessageDTO, type Capability, type PhoneBridge } from '@/bridge'
import { sessionStore, updateSessionRuntime } from '@/ui/store'
import { addSessionMessage, getSessionMessages } from '@/services/chat-service'
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

interface Harness {
  caller: ReturnType<typeof createCaller<HostApi>>
  sub: ReturnType<typeof createSubscriber<HostEvents>>
  /** 未经类型包装的「手机」端点 —— 用来验证**绕开手机 UI** 的调用同样被拦。 */
  raw: Endpoint
  bridge: PhoneBridge
  deviceToken: string
}

const cleanups: Array<() => void> = []

function setup(capabilities?: Capability[]): Harness {
  const [hostT, mobileT] = createMemoryPair()
  const hostEp = new Endpoint({ transport: hostT, defaultTimeoutMs: 2000 })
  const mobileEp = new Endpoint({ transport: mobileT, defaultTimeoutMs: 2000 })
  const bridge = startPhoneBridge(hostEp, {
    deviceName: '测试电脑',
    deviceId: 'host-msg-actions',
    capabilities,
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
    raw: mobileEp,
    bridge,
    deviceToken: device.token,
  }
}

const helloParams = (token?: string) => ({
  protocolVersion: 1,
  client: { platform: 'test', appVersion: '0' },
  capabilities: [MESSAGE_QUOTE_CAPABILITY, MESSAGE_DELETE_CAPABILITY],
  mobileKey: 'mk-4444444444444444',
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

/** 一条带引用的用户消息（与桌面 `buildUserContent` 产出的形状逐字一致）。 */
function userMessageWithQuote(id: string, text: string): Message {
  return {
    id,
    role: 'user',
    content: [
      { type: 'quote', messageId: 'm-hist-1', role: 'assistant', text: '被引用的那段回答' },
      { type: 'text', text },
    ],
    timestamp: Date.now(),
  }
}

afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
  sessionStore.clear()
})

// ───────────────────────── 1. 投影层：引用结构化下行 ─────────────────────────

describe('toMessageDTO —— 引用走结构化字段', () => {
  it('带引用的用户消息：`quotes` 结构化下行，`text` 里**不再**有 `[引用] …`（否则显示两遍）', () => {
    const dto = toMessageDTO(userMessageWithQuote('u1', '这条你怎么看？'))
    expect(dto.text).toBe('这条你怎么看？')
    expect(dto.text).not.toContain('[引用]')
    expect(dto.quotes).toEqual([
      { messageId: 'm-hist-1', role: 'assistant', text: '被引用的那段回答' },
    ])
  })

  it('没有引用的消息**不带** `quotes` 字段（不为旧手机端凭空多一个空数组）', () => {
    const dto = toMessageDTO({ id: 'u2', role: 'user', content: '普通消息', timestamp: 0 })
    expect(dto.text).toBe('普通消息')
    expect('quotes' in dto).toBe(false)
  })

  it('只引用不写正文：正文是电脑侧补的「请针对引用的消息回复」，引用照常结构化', () => {
    const dto = toMessageDTO(
      userMessageWithQuote('u3', '请针对引用的消息回复'),
    )
    expect(dto.text).toBe('请针对引用的消息回复')
    expect(dto.quotes).toHaveLength(1)
  })

  it('多条引用按发送顺序保留（桌面输入框可以一次引用好几条）', () => {
    const dto = toMessageDTO({
      id: 'u4',
      role: 'user',
      content: [
        { type: 'quote', messageId: 'a', role: 'user', text: '第一段' },
        { type: 'quote', messageId: 'b', role: 'assistant', text: '第二段' },
        { type: 'text', text: '对比一下' },
      ],
      timestamp: 0,
    })
    expect(dto.quotes?.map((q) => q.messageId)).toEqual(['a', 'b'])
  })

  it('精简档不动引用（引用是用户主动携带的上下文，不属于「详细内容」）', () => {
    const dto = toMessageDTO(userMessageWithQuote('u5', '看这条'), undefined, 'lean')
    expect(dto.quotes).toHaveLength(1)
    expect(dto.text).toBe('看这条')
  })

  it('`projectContentToText` 默认**照旧**把引用展平（指纹口径不变：改引用必须能被察觉）', () => {
    const content = userMessageWithQuote('u6', '正文').content
    expect(projectContentToText(content)).toContain('[引用] 被引用的那段回答')
    // 显式跳过时才不带（`toMessageDTO` 走的就是这条）
    expect(projectContentToText(content, { skipQuotes: true })).toBe('正文')
  })

  it('`collectQuotes` 对纯字符串 / 无引用内容返回空（老消息不能被当成「有引用」）', () => {
    expect(collectQuotes('裸字符串')).toEqual([])
    expect(collectQuotes([{ type: 'text', text: '只有正文' }])).toEqual([])
  })
})

// ───────────────────────── 2. 端到端：手机发引用 → 电脑端落结构化内容块 ─────────────────────────

describe('host.session.send —— 手机发的引用与桌面走同一条内容块路径', () => {
  it('引用随用户消息落进会话（content 是结构化 quote 块，不是拼出来的文本）', async () => {
    sessionStore.saveSession(makeSession('s-quote-1', '引用'))
    const h = setup()
    await h.caller.call('host.hello', helloParams(h.deviceToken))

    await h.caller.call('host.session.send', {
      sessionId: 's-quote-1',
      text: '这条你怎么看？',
      quotes: [{ messageId: 'm-hist-9', role: 'assistant', text: '被引用的那段回答' }],
    })

    const user = getSessionMessages('s-quote-1').find((m) => m.role === 'user')
    expect(user).toBeTruthy()
    // 与桌面 `doSend` 产出的形状一致：block 顺序 quote → text
    expect(user!.content).toEqual([
      { type: 'quote', messageId: 'm-hist-9', role: 'assistant', text: '被引用的那段回答' },
      { type: 'text', text: '这条你怎么看？' },
    ])
  })

  it('没带引用时内容仍是裸字符串（不因本次改动改变既有路径的形状）', async () => {
    sessionStore.saveSession(makeSession('s-quote-2', '引用'))
    const h = setup()
    await h.caller.call('host.hello', helloParams(h.deviceToken))
    await h.caller.call('host.session.send', { sessionId: 's-quote-2', text: '手机发的话' })
    const user = getSessionMessages('s-quote-2').find((m) => m.role === 'user')
    expect(user!.content).toBe('手机发的话')
  })

  it('推送回来的投影同时具备：结构化 `quotes` + 不含 `[引用]` 的正文', async () => {
    sessionStore.saveSession(makeSession('s-quote-3', '引用'))
    const h = setup()
    await h.caller.call('host.hello', helloParams(h.deviceToken))
    await h.caller.call('host.session.subscribe', { sessionId: 's-quote-3' })

    const added: Array<HostEvents['host.event.message.added']> = []
    h.sub.subscribe('host.event.message.added', (p) => added.push(p))

    await h.caller.call('host.session.send', {
      sessionId: 's-quote-3',
      text: '看这条',
      quotes: [{ messageId: 'm-1', role: 'user', text: '原来的问题' }],
    })
    await waitFor(() => added.some((e) => e.message.role === 'user'))

    const dto = added.find((e) => e.message.role === 'user')!.message
    expect(dto.text).toBe('看这条')
    expect(dto.quotes).toEqual([{ messageId: 'm-1', role: 'user', text: '原来的问题' }])
  })

  it('拉取窗口（重开会话路径）同样带 `quotes` —— 推送与拉取不能两副样子', async () => {
    sessionStore.saveSession(makeSession('s-quote-4', '引用'))
    const h = setup()
    await h.caller.call('host.hello', helloParams(h.deviceToken))
    await h.caller.call('host.session.send', {
      sessionId: 's-quote-4',
      text: '看这条',
      quotes: [{ messageId: 'm-2', role: 'assistant', text: '引用内容' }],
    })
    const page = await h.caller.call('host.session.messages', { sessionId: 's-quote-4' })
    const user = page.messages.find((m) => m.role === 'user') as MessageDTO
    expect(user.quotes).toHaveLength(1)
    expect(user.text).toBe('看这条')
  })
})

// ───────────────────────── 3. 删除：三道闸 + 截断语义 ─────────────────────────

describe('host.session.message.delete —— 服务端独立校验，不靠手机 UI', () => {
  it('缺 confirm → E_CONFIRM_REQUIRED，消息一条不少', async () => {
    sessionStore.saveSession(makeSession('s-del-1', '删除'))
    const h = setup()
    await h.caller.call('host.hello', helloParams(h.deviceToken))
    addSessionMessage('s-del-1', { id: 'a1', role: 'user', content: '一', timestamp: Date.now() })
    addSessionMessage('s-del-1', { id: 'a2', role: 'assistant', content: '二', timestamp: Date.now() })

    // ⚠️ 绕开类型包装：验证**服务端**确实拦（手机 UI 的确认弹窗不算数）
    await expect(
      h.raw.call('host.session.message.delete', { sessionId: 's-del-1', messageId: 'a1' }),
    ).rejects.toMatchObject({ code: 'E_CONFIRM_REQUIRED' })
    expect(getSessionMessages('s-del-1').map((m) => m.id)).toEqual(['a1', 'a2'])
  })

  it('ACL 未开该能力 → E_DENIED（默认拒绝）', async () => {
    sessionStore.saveSession(makeSession('s-del-acl', '删除'))
    const h = setup(['session.list'])
    await h.caller.call('host.hello', helloParams(h.deviceToken))
    addSessionMessage('s-del-acl', { id: 'a1', role: 'user', content: '一', timestamp: Date.now() })
    await expect(
      h.caller.call('host.session.message.delete', { sessionId: 's-del-acl', messageId: 'a1', confirm: true }),
    ).rejects.toMatchObject({ code: 'E_DENIED' })
    expect(getSessionMessages('s-del-acl')).toHaveLength(1)
  })

  it('回复中（working）→ E_BUSY，不乱删正在跑的那轮', async () => {
    sessionStore.saveSession(makeSession('s-del-busy', '删除'))
    const h = setup()
    await h.caller.call('host.hello', helloParams(h.deviceToken))
    addSessionMessage('s-del-busy', { id: 'a1', role: 'user', content: '一', timestamp: Date.now() })
    // 直接摆一个 working 运行态（send 的 busy 判据与它同一个 `isSessionRuntimeBusy`）
    updateSessionRuntime('s-del-busy', { working: true })
    await expect(
      h.caller.call('host.session.message.delete', { sessionId: 's-del-busy', messageId: 'a1', confirm: true }),
    ).rejects.toMatchObject({ code: 'E_BUSY' })
    expect(getSessionMessages('s-del-busy')).toHaveLength(1)
    updateSessionRuntime('s-del-busy', { working: false })
  })

  it('工具消息不可删 → E_BAD_REQUEST（工具结果与发起它的 assistant 消息是一体两面）', async () => {
    sessionStore.saveSession(makeSession('s-del-tool', '删除'))
    const h = setup()
    await h.caller.call('host.hello', helloParams(h.deviceToken))
    addSessionMessage('s-del-tool', { id: 't1', role: 'tool', content: '输出', toolCallId: 'tc1', timestamp: Date.now() })
    await expect(
      h.caller.call('host.session.message.delete', { sessionId: 's-del-tool', messageId: 't1', confirm: true }),
    ).rejects.toMatchObject({ code: 'E_BAD_REQUEST' })
    expect(getSessionMessages('s-del-tool')).toHaveLength(1)
  })

  it('消息 / 会话不存在 → E_NOT_FOUND', async () => {
    sessionStore.saveSession(makeSession('s-del-404', '删除'))
    const h = setup()
    await h.caller.call('host.hello', helloParams(h.deviceToken))
    await expect(
      h.caller.call('host.session.message.delete', { sessionId: 's-del-404', messageId: 'nope', confirm: true }),
    ).rejects.toMatchObject({ code: 'E_NOT_FOUND' })
    await expect(
      h.caller.call('host.session.message.delete', { sessionId: 'nope', messageId: 'a1', confirm: true }),
    ).rejects.toMatchObject({ code: 'E_NOT_FOUND' })
  })

  it('成功：删本条**及其后全部**，并推 `messages.reset`（手机端据此重拉窗口）', async () => {
    sessionStore.saveSession(makeSession('s-del-ok', '删除'))
    const h = setup()
    await h.caller.call('host.hello', helloParams(h.deviceToken))
    await h.caller.call('host.session.subscribe', { sessionId: 's-del-ok' })
    addSessionMessage('s-del-ok', { id: 'b1', role: 'user', content: '一', timestamp: Date.now() })
    addSessionMessage('s-del-ok', { id: 'b2', role: 'assistant', content: '二', timestamp: Date.now() })
    addSessionMessage('s-del-ok', { id: 'b3', role: 'user', content: '三', timestamp: Date.now() })
    await waitFor(() => getSessionMessages('s-del-ok').length === 3)

    const resets: string[] = []
    h.sub.subscribe('host.event.session.messages.reset', (p) => resets.push(p.sessionId))

    await h.caller.call('host.session.message.delete', { sessionId: 's-del-ok', messageId: 'b2', confirm: true })
    expect(getSessionMessages('s-del-ok').map((m) => m.id)).toEqual(['b1'])
    await waitFor(() => resets.includes('s-del-ok'))
  })

  it('删中间那条用户消息：后面的对话也一并消失（截断语义，不是把它从中间抽走）', async () => {
    sessionStore.saveSession(makeSession('s-del-mid', '删除'))
    const h = setup()
    await h.caller.call('host.hello', helloParams(h.deviceToken))
    addSessionMessage('s-del-mid', { id: 'c1', role: 'user', content: '问题一', timestamp: Date.now() })
    addSessionMessage('s-del-mid', { id: 'c2', role: 'assistant', content: '回答一', timestamp: Date.now() })
    addSessionMessage('s-del-mid', { id: 'c3', role: 'user', content: '问题二', timestamp: Date.now() })

    await h.caller.call('host.session.message.delete', { sessionId: 's-del-mid', messageId: 'c1', confirm: true })
    // 全空：没有「回答一还在、问题一没了」这种失去因果的历史
    expect(getSessionMessages('s-del-mid')).toEqual([])
  })
})

// ───────────────────────── 4. 能力声明（决定手机端给不给入口） ─────────────────────────

describe('hello.capabilities —— 电脑端如实声明', () => {
  it('默认 ACL 声明引用与删除（不声明则手机端隐藏入口，功能等于没做）', async () => {
    const h = setup()
    const hello = await h.caller.call('host.hello', helloParams(h.deviceToken))
    expect(hello.capabilities).toContain(MESSAGE_QUOTE_CAPABILITY)
    expect(hello.capabilities).toContain(MESSAGE_DELETE_CAPABILITY)
  })

  it('ACL 收窄时如实不声明（手机端因此不显示「删除」，而不是点了报错）', async () => {
    const h = setup(['session.list', MESSAGE_QUOTE_CAPABILITY])
    const hello = await h.caller.call('host.hello', helloParams(h.deviceToken))
    expect(hello.capabilities).toContain(MESSAGE_QUOTE_CAPABILITY)
    expect(hello.capabilities).not.toContain(MESSAGE_DELETE_CAPABILITY)
  })
})
