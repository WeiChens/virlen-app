/**
 * 「新建会话时选定 Agent」（协议 0.6.0）—— 电脑侧接线与校验回归。
 *
 * 缺陷背景（2026-10 真机反馈）：**手机端新建会话无法切换 Agent**。
 * 查下来不是「坏了」而是「从未实现」：协议里既没有 `agentId` 入参、也没有候选集 RPC，
 * 而 `host-source.createSession` 把 `agent` 参数写死成 `undefined` —— 手机建的会话永远归默认 Agent。
 *
 * 本文件盯住电脑侧的三件事（协议包与手机端各有自己的用例）：
 * 1. `host.agent.list` 是**白名单投影**：只给 id / name / 默认模型 / 默认工作目录 ——
 *    不得漏出 personality / identity / allowTools / skills（§7-⑥ 同一条纪律）；
 * 2. `host.session.create` 的 `agentId` 走**独立校验**：未知 id → `E_BAD_REQUEST`；
 *    未授权（链路能力集里没有 `session.agent`）→ `E_DENIED`；两种情况都**不会**碰 chat-service；
 * 3. 合法 id → 真的把那个 Agent 对象交给 `chat-service.createSession`（接线不断）；
 *    不传 = `undefined`（**旧行为一字不改**，默认 Agent 那条路必须原样）。
 *
 * ⚠️ 只 mock `createSession`（真实实现要装配 systemPrompt / 读 AGENTS.md，在单测里是噪音）：
 * ACL / 数据源 / 分发胶水全部是真的，所以「拦不拦得住」「传没传对」就是线上行为。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Endpoint,
  SESSION_AGENT_CAPABILITY,
  createCaller,
  createMemoryPair,
  type HostApi,
} from 'virlen-remote'
import { startPhoneBridge, DEFAULT_CAPABILITIES, type Capability } from '@/bridge'
import { agentStore, sessionRuntimeState, sessionStore } from '@/ui/store'
import type { Agent, Session } from '@/types'

/** 记录 `chat-service.createSession` 收到的 Agent 参数（`undefined` = 走默认 Agent）。 */
const { agentArgs, CREATED_ID } = vi.hoisted(() => ({
  agentArgs: [] as Array<{ id: string } | undefined>,
  CREATED_ID: 'phone-agent-1',
}))

vi.mock('@/services/chat-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/chat-service')>()
  return {
    ...actual,
    // 只关心「传下来的 Agent 是哪一个」；会话本身怎么组装由 flow 层负责
    createSession: vi.fn(
      async (_title: string, _providerConfigId?: string, _modelId?: string, agent?: { id: string }) => {
        agentArgs.push(agent)
        return { id: CREATED_ID } as never
      },
    ),
  }
})

const AGENT_A = 'ag-a'
const AGENT_B = 'ag-b'

function makeAgent(id: string, name: string, extra: Partial<Agent> = {}): Agent {
  const now = Date.now()
  return {
    id,
    name,
    description: `${name} 的描述`,
    // 下面这些字段是**本机机密**（提示词 / 工具白名单），投影里出现任何一个都是缺陷
    personality: 'SECRET-PERSONALITY',
    identity: 'SECRET-IDENTITY',
    defaultWorkspace: 'E:/code/virlen-demo',
    defaultModel: { providerConfigId: 'p-openai', modelId: 'gpt-4o' },
    allowTools: ['read_file', 'write_file'],
    skills: ['SECRET-SKILL'],
    createdAt: now,
    updatedAt: now,
    ...extra,
  }
}

function makeSession(id: string, title: string): Session {
  const now = Date.now()
  return {
    id,
    title,
    messages: [],
    providerConfigId: 'p-openai',
    modelId: 'gpt-4o',
    systemPrompt: 'SECRET',
    params: { temperature: 0, topP: 0, maxTokens: 0, stream: true },
    createdAt: now,
    updatedAt: now,
    pinned: false,
    tags: [],
  }
}

function setup(capabilities?: Capability[]) {
  const [hostT, mobileT] = createMemoryPair()
  const hostEp = new Endpoint({ transport: hostT, defaultTimeoutMs: 2000 })
  const mobileEp = new Endpoint({ transport: mobileT, defaultTimeoutMs: 2000 })
  const bridge = startPhoneBridge(hostEp, {
    deviceName: '测试电脑',
    deviceId: 'host-test',
    ...(capabilities ? { capabilities } : {}),
  })
  return {
    caller: createCaller<HostApi>(mobileEp),
    dispose: () => {
      bridge.dispose()
      hostEp.dispose()
      mobileEp.dispose()
      hostT.close()
      mobileT.close()
    },
  }
}

beforeEach(() => {
  agentArgs.length = 0
  sessionStore.clear()
  sessionRuntimeState.setValue('sessions', {})
  for (const id of [AGENT_A, AGENT_B]) agentStore.deleteAgent(id)
  agentStore.saveAgent(makeAgent(AGENT_A, 'Virlen'))
  agentStore.saveAgent(
    makeAgent(AGENT_B, '代码评审员', {
      defaultWorkspace: 'E:/code/another-project',
      defaultModel: { providerConfigId: 'p-anthropic', modelId: 'claude-sonnet-4' },
    }),
  )
})

afterEach(() => {
  for (const id of [AGENT_A, AGENT_B]) agentStore.deleteAgent(id)
  sessionStore.clear()
  sessionRuntimeState.setValue('sessions', {})
})

describe('host.agent.list —— 候选集是白名单投影', () => {
  it('只给 id / name / 默认模型 / 默认工作目录（提示词与工具白名单不得外泄）', async () => {
    const h = setup()
    const { agents } = await h.caller.call('host.agent.list', {})

    const b = agents.find((a) => a.id === AGENT_B)
    expect(b).toBeTruthy()
    expect(b!.name).toBe('代码评审员')
    expect(b!.defaultModel).toEqual({ providerConfigId: 'p-anthropic', modelId: 'claude-sonnet-4' })
    expect(b!.defaultWorkspace).toBe('E:/code/another-project')

    // 字段白名单：多一个字段（哪怕值看起来无害）都算投影失守
    expect(Object.keys(b!).sort()).toEqual(['defaultModel', 'defaultWorkspace', 'id', 'name'])
    expect(JSON.stringify(agents)).not.toContain('SECRET')

    h.dispose()
  })
})

describe('host.session.create 的 agentId —— 电脑侧独立校验', () => {
  it('未知 Agent → E_BAD_REQUEST，且不会去建会话', async () => {
    sessionStore.saveSession(makeSession(CREATED_ID, '手机新建的会话'))
    const h = setup()

    await expect(
      h.caller.call('host.session.create', { agentId: 'ag-不存在' }),
    ).rejects.toMatchObject({ code: 'E_BAD_REQUEST' })
    expect(agentArgs).toHaveLength(0)

    h.dispose()
  })

  it('链路未获 session.agent 授权 → E_DENIED（候选集也一并拒）', async () => {
    sessionStore.saveSession(makeSession(CREATED_ID, '手机新建的会话'))
    // 模拟一台「只被授权发消息」的手机：能力集里没有 session.agent
    const h = setup(['session.list', 'session.create'])

    await expect(h.caller.call('host.agent.list', {})).rejects.toMatchObject({ code: 'E_DENIED' })
    await expect(
      h.caller.call('host.session.create', { agentId: AGENT_A }),
    ).rejects.toMatchObject({ code: 'E_DENIED' })
    expect(agentArgs).toHaveLength(0)

    h.dispose()
  })

  it('授权缺失只挡「选定 Agent」——不指定 Agent 的旧路径照常可用', async () => {
    sessionStore.saveSession(makeSession(CREATED_ID, '手机新建的会话'))
    const h = setup(['session.list', 'session.create'])

    const { sessionId } = await h.caller.call('host.session.create', { title: '不带 Agent' })
    expect(sessionId).toBe(CREATED_ID)
    expect(agentArgs).toEqual([undefined])

    h.dispose()
  })

  it('合法 agentId → 交给 chat-service 的正是那个 Agent 对象', async () => {
    sessionStore.saveSession(makeSession(CREATED_ID, '手机新建的会话'))
    const h = setup()

    const { sessionId } = await h.caller.call('host.session.create', {
      title: '评审一下',
      agentId: AGENT_B,
    })
    expect(sessionId).toBe(CREATED_ID)
    expect(agentArgs).toHaveLength(1)
    expect(agentArgs[0]?.id).toBe(AGENT_B)

    h.dispose()
  })

  it('不传 agentId → undefined（默认 Agent 的旧行为一字不改）', async () => {
    sessionStore.saveSession(makeSession(CREATED_ID, '手机新建的会话'))
    const h = setup()

    await h.caller.call('host.session.create', {})
    expect(agentArgs).toEqual([undefined])

    h.dispose()
  })

  it('默认能力集包含 session.agent（新安装默认就授权手机选 Agent）', () => {
    // 与 `hello` 应答同源（`Acl.capabilities` 单一真源）：断言默认值就等于断言下发给手机的清单。
    // 真机后果：漏了它，手机上根本不显示 Agent 选择器（能力驱动显隐），且难从现象反推到原因。
    expect(DEFAULT_CAPABILITIES).toContain(SESSION_AGENT_CAPABILITY)
  })
})
