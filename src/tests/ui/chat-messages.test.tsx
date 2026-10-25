/**
 * `ChatMessages` —— 会话消息镜像容器（B3 性能改造的落点）。
 *
 * 背景：这层状态原先挂在 1678 行的 `ChatView` 上，流式期间每一帧都会把整个聊天页
 * （header / 侧栏 / 右侧面板 / 输入框）的 JSX 重建一遍。搬到容器里之后要守三件事：
 * 1. **高频路径走帧合批**：一轮里写两条消息，列表只重渲染一次（且拿到的是最新两条）；
 * 2. **低频路径立即生效**：`syncNow` 不等下一帧，并丢弃排队中的旧更新；
 * 3. **换会话 / 懒加载**：`sessionId` 变要在**上屏前**换掉镜像（不能先画一帧旧会话）；
 *    `ensureMessagesLoaded` 直接替换 `session.messages` 且**不发** `messagesChanged`，
 *    宿主只能靠 `syncKey` 补一次。
 *
 * 列表与轨迹视图在这里用替身：本用例只测镜像，不测虚拟滚动（那由 `side-by-side` /
 * `message-list` 自己的用例守）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, createRef } from 'react'
import { createRoot } from 'react-dom/client'
import type { Message, Session } from '@/types'
import { chatState, sessionStore } from '@/ui/store'
import { addSessionMessage } from '@/services/chat/messages'

const seen = vi.hoisted(() => ({
  list: [] as any[],
  traj: [] as any[],
}))

vi.mock('@/ui/pages/chat/components/message/message-list', () => ({
  default: (props: any): null => {
    seen.list.push(props)
    return null
  },
}))

vi.mock('@/ui/pages/chat/components/trajectory/trajectory-view', () => ({
  TrajectoryView: (props: any): null => {
    seen.traj.push(props)
    return null
  },
}))

import ChatMessages, {
  type ChatMessagesHandle,
} from '@/ui/pages/chat/components/chat-messages'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

function makeSession(id: string): Session {
  const now = Date.now()
  return {
    id,
    title: id,
    messages: [],
    providerConfigId: 'p1',
    modelId: 'm1',
    systemPrompt: '',
    params: { temperature: 0, topP: 0, maxTokens: 0, stream: true },
    createdAt: now,
    updatedAt: now,
    pinned: false,
    tags: [],
    workspace: '',
  }
}

function msg(id: string): Message {
  return { id, role: 'assistant', content: id, timestamp: 0 } as Message
}

const listProps = () => ({ setText: () => {} })
const trajectoryProps = () => ({
  hasMoreOlder: false,
  onLoadOlder: async () => {},
  onJumpToMessage: () => {},
  onClose: () => {},
})

/** 等一帧：frameBatch 用 rAF（jsdom ≈16ms） */
async function nextFrame() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 32))
  })
}

async function mount(sessionId: string, syncKey = 0) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const ref = createRef<ChatMessagesHandle>()
  const render = (sid: string, key = 0) =>
    root.render(
      <ChatMessages
        ref={ref}
        sessionId={sid}
        view="chat"
        syncKey={key}
        listProps={listProps()}
        trajectoryProps={trajectoryProps()}
      />,
    )
  await act(async () => render(sessionId, syncKey))
  return { host, root, ref, render }
}

const lastCount = () => seen.list[seen.list.length - 1]?.messages.length ?? -1

/** 消息必须写进 store 里那份（对象已被 MobX 包成 observable 代理，改局部引用不会通知） */
function storeSession(id: string): Session {
  const session = sessionStore.getSession(id)
  if (!session) throw new Error(`session not found: ${id}`)
  return session
}

beforeEach(() => {
  document.body.innerHTML = ''
  seen.list.length = 0
  seen.traj.length = 0
})

describe('ChatMessages（消息镜像）', () => {
  it('一轮里写两条：只同步一次，且拿到最新两条（帧合批）', async () => {
    const session = makeSession('b3-batch')
    sessionStore.saveSession(session)
    chatState.setValue('currentSessionId', session.id)
    const { root } = await mount(session.id)

    const before = seen.list.length
    await act(async () => {
      addSessionMessage(session.id, msg('a1'))
      addSessionMessage(session.id, msg('a2'))
    })
    await nextFrame()

    expect(lastCount()).toBe(2)
    // 两次通知在同一帧里被合并：只多渲染一次
    expect(seen.list.length - before).toBe(1)
    await act(async () => root.unmount())
  })

  it('非当前会话的变更不同步（后台会话不抢前台）', async () => {
    const a = makeSession('b3-a')
    const b = makeSession('b3-b')
    sessionStore.saveSession(a)
    sessionStore.saveSession(b)
    chatState.setValue('currentSessionId', a.id)
    const { root } = await mount(a.id)

    await act(async () => {
      addSessionMessage(b.id, msg('b1'))
    })
    await nextFrame()
    expect(lastCount()).toBe(0)

    await act(async () => {
      addSessionMessage(a.id, msg('a1'))
    })
    await nextFrame()
    expect(lastCount()).toBe(1)
    await act(async () => root.unmount())
  })

  it('syncNow 立即生效，并丢弃排队中的旧更新', async () => {
    const session = makeSession('b3-now')
    sessionStore.saveSession(session)
    chatState.setValue('currentSessionId', session.id)
    const { root, ref } = await mount(session.id)

    act(() => {
      addSessionMessage(session.id, msg('n1'))
      addSessionMessage(session.id, msg('n2'))
      // 先排一帧（旧内容），紧接着立刻同步 —— 立即那次要用最新内容，且只生效一次
      ref.current!.schedule(session.id)
      ref.current!.syncNow(session.id)
    })
    expect(lastCount()).toBe(2)
    await nextFrame()
    // 排队的那一帧已被 cancel，不会再用旧快照覆盖一次
    expect(lastCount()).toBe(2)
    await act(async () => root.unmount())
  })

  it('换会话：上屏前换成新会话的消息（不等事件）', async () => {
    const a = makeSession('b3-sw-a')
    const b = makeSession('b3-sw-b')
    a.messages = [msg('a1')]
    b.messages = [msg('b1'), msg('b2'), msg('b3')]
    sessionStore.saveSession(a)
    sessionStore.saveSession(b)
    chatState.setValue('currentSessionId', a.id)
    const { root, render } = await mount(a.id)
    expect(lastCount()).toBe(1)

    await act(async () => {
      chatState.setValue('currentSessionId', b.id)
      render(b.id)
    })
    expect(lastCount()).toBe(3)
    await act(async () => root.unmount())
  })

  it('syncKey 自增补一次（懒加载 / 修复不发 messagesChanged）', async () => {
    const session = makeSession('b3-key')
    sessionStore.saveSession(session)
    chatState.setValue('currentSessionId', session.id)
    const { root, render } = await mount(session.id)
    expect(lastCount()).toBe(0)

    // 模拟 ensureMessagesLoaded：直接替换 messages，**不**发 messagesChanged
    await act(async () => {
      storeSession(session.id).messages = [msg('l1'), msg('l2')]
      render(session.id, 1)
    })
    expect(lastCount()).toBe(2)
    await act(async () => root.unmount())
  })

  it('view=trajectory 渲染轨迹视图，且带上同一个尾巴', async () => {
    const session = makeSession('b3-traj')
    session.messages = [msg('t1')]
    sessionStore.saveSession(session)
    chatState.setValue('currentSessionId', session.id)

    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () =>
      root.render(
        <ChatMessages
          sessionId={session.id}
          view="trajectory"
          listProps={listProps()}
          trajectoryProps={trajectoryProps()}
          trajectoryTail={<span id="tail" />}
        />,
      ),
    )
    expect(seen.traj[seen.traj.length - 1]?.messages.length).toBe(1)
    expect(host.querySelector('#tail')).not.toBeNull()
    await act(async () => root.unmount())
  })
})

/**
 * 结构契约（B3 的意义全在这一条）：镜像状态不得再搬回页面组件 ——
 * 搬回去就是「每个流式 token 重建整页 JSX」，而这在那个文件里看不出来（测试全绿、只是变卡）。
 */
describe('chat-view 不得再持有消息镜像', () => {
  const src = readFileSync(
    resolve(process.cwd(), 'src/ui/pages/chat/chat-view.tsx'),
    'utf8',
  )

  it('没有本地 messages 状态，也不直接订阅 messagesChanged', () => {
    expect(src).not.toContain('useState<Message[]>')
    expect(src).not.toContain('onMessagesChanged')
    expect(src).toContain('<ChatMessages')
  })

  it('不把 messages 透传给子组件（由容器注入）', () => {
    expect(src).not.toMatch(/messages=\{messages\}/)
  })
})
