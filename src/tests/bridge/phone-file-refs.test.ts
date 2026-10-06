/**
 * §37 消息里引用电脑上的文件（`SendParams.files` / `MessageDTO.files`）—— 电脑侧实现用例。
 *
 * 与 §36 的引用同一类失败模式：`files` 是 `host.session.send` 的一个普通字段，
 * 电脑端若不认它，RPC **照样成功** —— 用户只会发现「我明明附了文件，AI 却当没看见」。
 * 所以这里既钉「参数确实进了内容块结构（与桌面同一条 `buildUserContent`）」，
 * 也钉「下行时以结构化 `files` 回来、且不再混在 `text` 里」（否则手机端会显示两遍）。
 *
 * 另一条只在电脑侧成立的纪律：**形状非法拒整条**（不是丢掉那一条就照发）——
 * 丢一条时手机端 chip 还在、用户以为带上了，而 AI 从未看到（§36 的教训）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  Endpoint,
  MESSAGE_FILE_CAPABILITY,
  MESSAGE_FILE_MAX,
  createCaller,
  createMemoryPair,
  createSubscriber,
  type HostApi,
  type HostEvents,
} from 'virlen-remote'
import {
  collectFiles,
  projectContentToText,
  startPhoneBridge,
  toMessageDTO,
  type Capability,
  type PhoneBridge,
} from '@/bridge'
import { sessionStore } from '@/ui/store'
import { getSessionMessages } from '@/services/chat-service'
import type { Message, Session } from '@/types'

const flush = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

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
    deviceId: 'host-file-refs',
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
    bridge,
    deviceToken: device.token,
  }
}

const helloParams = (token?: string) => ({
  protocolVersion: 1,
  client: { platform: 'test', appVersion: '0' },
  capabilities: [MESSAGE_FILE_CAPABILITY],
  mobileKey: 'mk-5555555555555555',
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

/** 一条带文件引用的用户消息（与桌面 `buildUserContent` 产出的形状逐字一致）。 */
function userMessageWithFile(id: string, text: string): Message {
  return {
    id,
    role: 'user',
    content: [
      { type: 'text', text },
      { type: 'file', path: 'C:/secret/workspace/src/a.ts', name: 'a.ts', isDir: false, size: 128 },
    ],
    timestamp: Date.now(),
  }
}

afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
  sessionStore.clear()
})

// ───────────────────────── 1. 投影层：文件引用结构化下行 ─────────────────────────

describe('toMessageDTO —— 文件引用走结构化字段', () => {
  it('带文件的消息：`files` 结构化下行，`text` 里**不再**有 `[文件] …`（否则显示两遍）', () => {
    const dto = toMessageDTO(userMessageWithFile('u1', '看看这个'))
    expect(dto.text).toBe('看看这个')
    expect(dto.text).not.toContain('[文件]')
    expect(dto.files).toEqual([
      { path: 'C:/secret/workspace/src/a.ts', name: 'a.ts', isDir: false, size: 128 },
    ])
  })

  it('没有文件的消息**不带** `files` 字段（不为旧手机端凭空多一个空数组）', () => {
    const dto = toMessageDTO({ id: 'u2', role: 'user', content: '普通消息', timestamp: 0 })
    expect('files' in dto).toBe(false)
  })

  it('只带文件不写正文：正文是电脑侧补的「看看这些文件」，文件照常结构化', () => {
    const dto = toMessageDTO({
      id: 'u3',
      role: 'user',
      content: [
        { type: 'text', text: '看看这些文件' },
        { type: 'file', path: 'C:/w/a.ts', name: 'a.ts' },
      ],
      timestamp: 0,
    })
    expect(dto.text).toBe('看看这些文件')
    expect(dto.files).toHaveLength(1)
  })

  it('`name` 缺席时用路径末段兜底（协议要求它必填，而老消息可能没带）', () => {
    const dto = toMessageDTO({
      id: 'u4',
      role: 'user',
      content: [{ type: 'file', path: 'C:/w/src/index.ts' }],
      timestamp: 0,
    })
    expect(dto.files).toEqual([{ path: 'C:/w/src/index.ts', name: 'index.ts' }])
  })

  it('目录引用带 `isDir`（手机上 chip 上要能区分目录与文件）', () => {
    const dto = toMessageDTO({
      id: 'u5',
      role: 'user',
      content: [{ type: 'file', path: 'C:/w/src', name: 'src', isDir: true }],
      timestamp: 0,
    })
    expect(dto.files).toEqual([{ path: 'C:/w/src', name: 'src', isDir: true }])
  })

  it('引用与文件同时带上：两者各自结构化，正文里两个占位符都不出现', () => {
    const dto = toMessageDTO({
      id: 'u6',
      role: 'user',
      content: [
        { type: 'quote', messageId: 'm-1', role: 'assistant', text: '被引用的回答' },
        { type: 'text', text: '按这个改' },
        { type: 'file', path: 'C:/w/a.ts', name: 'a.ts' },
      ],
      timestamp: 0,
    })
    expect(dto.text).toBe('按这个改')
    expect(dto.quotes).toHaveLength(1)
    expect(dto.files).toHaveLength(1)
  })

  it('精简档不动文件引用（它是用户主动携带的上下文，不属于「详细内容」）', () => {
    const dto = toMessageDTO(userMessageWithFile('u7', '看看'), undefined, 'lean')
    expect(dto.files).toHaveLength(1)
    expect(dto.text).toBe('看看')
  })

  it('`projectContentToText` 默认**照旧**把文件展平（指纹口径不变：换附件必须能被察觉）', () => {
    const content = userMessageWithFile('u8', '正文').content
    expect(projectContentToText(content)).toContain('[文件] a.ts')
    // 显式跳过时才不带（`toMessageDTO` 走的就是这条）
    expect(projectContentToText(content, { skipFiles: true })).toBe('正文')
  })

  it('`collectFiles` 对纯字符串 / 无文件内容返回空（老消息不能被当成「有附件」）', () => {
    expect(collectFiles('裸字符串')).toEqual([])
    expect(collectFiles([{ type: 'text', text: '只有正文' }])).toEqual([])
  })
})

// ───────────────────────── 2. 端到端：手机发文件引用 → 电脑端落结构化内容块 ─────────────────────────

describe('host.session.send —— 手机发的文件引用与桌面走同一条内容块路径', () => {
  it('带正文 + 文件：content 是结构化 file 块（块顺序 text → file，与桌面一致）', async () => {
    sessionStore.saveSession(makeSession('s-file-1', '引用文件'))
    const h = setup()
    await h.caller.call('host.hello', helloParams(h.deviceToken))

    await h.caller.call('host.session.send', {
      sessionId: 's-file-1',
      text: '帮我看看这个',
      files: [{ path: 'C:/secret/workspace/src/a.ts', name: 'a.ts', size: 128 }],
    })

    const user = getSessionMessages('s-file-1').find((m) => m.role === 'user')
    expect(user!.content).toEqual([
      { type: 'text', text: '帮我看看这个' },
      { type: 'file', path: 'C:/secret/workspace/src/a.ts', name: 'a.ts', isDir: undefined, size: 128 },
    ])
  })

  it('只带文件不写正文也能发（电脑侧补「看看这些文件」，与桌面的兜底句一致）', async () => {
    sessionStore.saveSession(makeSession('s-file-2', '引用文件'))
    const h = setup()
    await h.caller.call('host.hello', helloParams(h.deviceToken))

    await h.caller.call('host.session.send', {
      sessionId: 's-file-2',
      text: '',
      files: [{ path: 'C:/secret/workspace/src', name: 'src', isDir: true }],
    })

    const user = getSessionMessages('s-file-2').find((m) => m.role === 'user')
    expect(user!.content).toEqual([
      { type: 'text', text: '看看这些文件' },
      { type: 'file', path: 'C:/secret/workspace/src', name: 'src', isDir: true, size: undefined },
    ])
  })

  it('引用 + 文件同时带上：块顺序 quote → text → file', async () => {
    sessionStore.saveSession(makeSession('s-file-3', '引用文件'))
    const h = setup()
    await h.caller.call('host.hello', helloParams(h.deviceToken))

    await h.caller.call('host.session.send', {
      sessionId: 's-file-3',
      text: '按这个改',
      quotes: [{ messageId: 'm-hist-1', role: 'assistant', text: '被引用的回答' }],
      files: [{ path: 'C:/secret/workspace/a.ts', name: 'a.ts' }],
    })

    const user = getSessionMessages('s-file-3').find((m) => m.role === 'user')
    expect((user!.content as Array<{ type: string }>).map((b) => b.type)).toEqual([
      'quote',
      'text',
      'file',
    ])
  })

  it('没带文件时内容仍是裸字符串（空数组也不改变既有路径的形状）', async () => {
    sessionStore.saveSession(makeSession('s-file-4', '引用文件'))
    const h = setup()
    await h.caller.call('host.hello', helloParams(h.deviceToken))
    await h.caller.call('host.session.send', { sessionId: 's-file-4', text: '手机发的话', files: [] })
    const user = getSessionMessages('s-file-4').find((m) => m.role === 'user')
    expect(user!.content).toBe('手机发的话')
  })

  it('推送回来的投影同时具备：结构化 `files` + 不含 `[文件]` 的正文', async () => {
    sessionStore.saveSession(makeSession('s-file-5', '引用文件'))
    const h = setup()
    await h.caller.call('host.hello', helloParams(h.deviceToken))
    await h.caller.call('host.session.subscribe', { sessionId: 's-file-5' })

    const added: Array<HostEvents['host.event.message.added']> = []
    h.sub.subscribe('host.event.message.added', (p) => added.push(p))

    await h.caller.call('host.session.send', {
      sessionId: 's-file-5',
      text: '看这个',
      files: [{ path: 'C:/secret/workspace/src/a.ts', name: 'a.ts', size: 12 }],
    })
    await waitFor(() => added.some((e) => e.message.role === 'user'))

    const dto = added.find((e) => e.message.role === 'user')!.message
    expect(dto.text).toBe('看这个')
    expect(dto.files).toEqual([{ path: 'C:/secret/workspace/src/a.ts', name: 'a.ts', size: 12 }])
  })

  it('拉取窗口（重开会话路径）同样带 `files` —— 推送与拉取不能两副样子', async () => {
    sessionStore.saveSession(makeSession('s-file-6', '引用文件'))
    const h = setup()
    await h.caller.call('host.hello', helloParams(h.deviceToken))
    await h.caller.call('host.session.send', {
      sessionId: 's-file-6',
      text: '看这个',
      files: [{ path: 'C:/secret/workspace/b.ts', name: 'b.ts' }],
    })
    const page = await h.caller.call('host.session.messages', { sessionId: 's-file-6' })
    const user = page.messages.find((m) => m.role === 'user')!
    expect(user.files).toEqual([{ path: 'C:/secret/workspace/b.ts', name: 'b.ts' }])
    expect(user.text).toBe('看这个')
  })
})

// ───────────────────────── 3. 形状非法：拒整条 + 留痕 ─────────────────────────

describe('host.session.send —— 文件引用非法就拒整条（不静默丢掉那一条）', () => {
  it('条目缺路径 → E_BAD_REQUEST，消息一条不落，且审计留痕（allowed:false）', async () => {
    sessionStore.saveSession(makeSession('s-bad-1', '引用文件'))
    const h = setup()
    await h.caller.call('host.hello', helloParams(h.deviceToken))

    await expect(
      // ⚠️ 绕开类型包装：验证**服务端**确实拦（手机端的形状校验不算数）
      h.caller.call('host.session.send', {
        sessionId: 's-bad-1',
        text: 'x',
        files: [{ name: 'a.ts' } as never],
      }),
    ).rejects.toMatchObject({ code: 'E_BAD_REQUEST' })

    expect(getSessionMessages('s-bad-1').filter((m) => m.role === 'user')).toEqual([])
    // 「发了但被拒」必须能在审计里查到原因（否则用户报「点不动」时无从查证）
    const entry = h.bridge.audit.list().find((e) => e.method === 'host.session.send')
    expect(entry).toMatchObject({ allowed: false })
    expect(entry?.detail).toContain('files 非法')
  })

  it(`超过 ${MESSAGE_FILE_MAX} 个 → E_BAD_REQUEST（截断是静默的，不能做）`, async () => {
    sessionStore.saveSession(makeSession('s-bad-2', '引用文件'))
    const h = setup()
    await h.caller.call('host.hello', helloParams(h.deviceToken))

    const many = Array.from({ length: MESSAGE_FILE_MAX + 1 }, (_, i) => ({
      path: `C:/secret/workspace/f${i}.ts`,
      name: `f${i}.ts`,
    }))
    await expect(
      h.caller.call('host.session.send', { sessionId: 's-bad-2', text: 'x', files: many }),
    ).rejects.toMatchObject({ code: 'E_BAD_REQUEST' })
    expect(getSessionMessages('s-bad-2').filter((m) => m.role === 'user')).toEqual([])
  })

  it('合法的那一次在审计里报 `files=N`（与 `quotes=N` 一句话并存）', async () => {
    sessionStore.saveSession(makeSession('s-audit', '引用文件'))
    const h = setup()
    await h.caller.call('host.hello', helloParams(h.deviceToken))
    await h.caller.call('host.session.send', {
      sessionId: 's-audit',
      text: '看这两个',
      quotes: [{ messageId: 'm-1', role: 'assistant', text: '回答' }],
      files: [
        { path: 'C:/secret/workspace/a.ts', name: 'a.ts' },
        { path: 'C:/secret/workspace/b.ts', name: 'b.ts' },
      ],
    })
    const entry = h.bridge.audit.list().find((e) => e.method === 'host.session.send')
    expect(entry).toMatchObject({ allowed: true, detail: 'quotes=1 files=2' })
  })
})

// ───────────────────────── 4. 能力声明（决定手机端给不给「引用」入口） ─────────────────────────

describe('hello.capabilities —— 文件引用能力如实声明', () => {
  it('默认 ACL 声明 `message.file`（不声明则手机端不显示入口，功能等于没做）', async () => {
    const h = setup()
    const hello = await h.caller.call('host.hello', helloParams(h.deviceToken))
    expect(hello.capabilities).toContain(MESSAGE_FILE_CAPABILITY)
  })

  it('ACL 收窄时不声明（手机端因此不给「引用」入口，而不是点了静默丢）', async () => {
    const h = setup(['session.list', 'session.send'])
    const hello = await h.caller.call('host.hello', helloParams(h.deviceToken))
    expect(hello.capabilities).not.toContain(MESSAGE_FILE_CAPABILITY)
  })
})
