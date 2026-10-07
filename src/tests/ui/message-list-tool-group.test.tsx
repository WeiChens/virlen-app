/**
 * 集成接线用例：真实挂载 `ChatMessageList`，验证「消息 → 工具组行」端到端生效。
 *
 * 纯函数用例（`tool-group-rows.test.ts`）只钉住「怎么切行」；DOM 用例（`tool-group.test.tsx`）
 * 只钉住「组组件怎么折」。这两层都过了，仍可能因为**接线**（`m.rows` 未传入、设置开关没读对）
 * 而在真机上完全不折叠 —— 本用例专门补这个缺口。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { runInAction } from 'mobx'
import type { Message, Session, ToolUseContent } from '@/types'

vi.mock('@/ui/pages/chat/components/tool-call', () => ({
  ToolCallMessage: ({ message }: { message: ToolUseContent }) => (
    <div className="tool-card" data-tool-name={message.name} />
  ),
}))

// monaco 在 jsdom 里跑不起来（缺 CSS.escape）：替换成结构等价的最小替身
vi.mock('@/monaco/setupMonaco', () => ({
  monaco: { editor: { tokenize: (): unknown[] => [] } },
  virlenDarkTheme: { rules: [] as unknown[] },
}))
vi.mock('@/ui/pages/chat/components/message/code-block', () => ({
  toMonacoLang: (): string | undefined => undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default: ({ children }: any) => <pre>{children}</pre>,
}))

import ChatMessageList from '@/ui/pages/chat/components/message/message-list'
import { chatState, sessionStore, settingsState } from '@/ui/store'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

// jsdom 没有 ResizeObserver（虚拟库需要它观察滚动容器尺寸）；
// 同步回调一次，把容器尺寸喂给虚拟库（否则渲染区间为空 → 什么都不渲染）
class FakeResizeObserver {
  constructor(private cb: ResizeObserverCallback) {}
  observe(target: Element): void {
    this.cb(
      [
        {
          target,
          contentRect: target.getBoundingClientRect(),
        } as unknown as ResizeObserverEntry,
      ],
      this as unknown as ResizeObserver,
    )
  }
  unobserve(): void {}
  disconnect(): void {}
}
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
  FakeResizeObserver

const SESSION = 's-group'

// jsdom 没有布局：给所有元素一个非零尺寸，否则虚拟库的渲染区间为空（什么都不渲染）
const RECT: DOMRect = {
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: 800,
  bottom: 600,
  width: 800,
  height: 600,
  toJSON: () => ({}),
} as DOMRect
Element.prototype.getBoundingClientRect = () => RECT
Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
  configurable: true,
  get: () => 600,
})
Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
  configurable: true,
  get: () => 800,
})
Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
  configurable: true,
  get: () => 600,
})
// ⚠️ 虚拟库的 getRect 读的是 offsetWidth / offsetHeight（不是 getBoundingClientRect）
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
  configurable: true,
  get: () => 600,
})
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
  configurable: true,
  get: () => 800,
})
const tc = (id: string, name: string): ToolUseContent => ({
  type: 'tool_use',
  id,
  name,
  input: {},
})
const assistantTool = (id: string, tcs: ToolUseContent[]): Message => ({
  id,
  role: 'assistant',
  content: '',
  toolCalls: tcs,
  timestamp: 0,
})
const toolResult = (id: string, toolCallId: string, text: string): Message => ({
  id,
  role: 'tool',
  content: text,
  toolCallId,
  timestamp: 0,
})

const messages: Message[] = [
  { id: 'u1', role: 'user', content: '跑两个工具', timestamp: 0 },
  assistantTool('a1', [tc('t1', 'list_files')]),
  toolResult('r1', 't1', 'a\nb'),
  assistantTool('a2', [tc('t2', 'read_file')]),
  toolResult('r2', 't2', 'c'),
  { id: 'a3', role: 'assistant', content: '看完了。', timestamp: 0 },
]

function makeSession(): Session {
  return {
    id: SESSION,
    title: 't',
    messages,
    providerConfigId: 'p',
    modelId: 'm',
    systemPrompt: '',
    params: { temperature: 0.7, topP: 1, maxTokens: 1000, stream: false },
    createdAt: 0,
    updatedAt: 0,
    pinned: false,
    tags: [],
  }
}

let container: HTMLDivElement | null = null
let root: Root | null = null

function mount(): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(
      <ChatMessageList
        messages={messages}
        setMessages={() => {}}
        setText={() => {}}
      />,
    )
  })
}

beforeEach(() => {
  settingsState.setValue('hideToolCallThink', true)
  runInAction(() => {
    sessionStore.value.sessions = [makeSession()]
    sessionStore.value.messagePaging = {}
  })
  chatState.setValue('currentSessionId', SESSION)
})

afterEach(() => {
  if (root) {
    act(() => root!.unmount())
    root = null
  }
  container?.remove()
  container = null
})

describe('ChatMessageList：工具组接线', () => {
  it('连续两个仅工具调用的 assistant → 渲染成一个工具组行（默认折叠）', async () => {
    mount()
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30))
    })

    expect(container!.querySelectorAll('.tool-group').length).toBe(1)
    const head = container!.querySelector('.tool-group__head')
    expect(head?.textContent ?? '').toContain('2 次工具调用')
    expect(container!.querySelector('.tool-group__body')).toBeNull()
    // 组外那条有正文的 assistant 照常渲染（组没把边界外的东西吞进去）
    expect(container!.textContent ?? '').toContain('看完了。')
  })

  it('关闭设置（hideToolCallThink=false）→ 不分组，工具卡片平铺', async () => {
    settingsState.setValue('hideToolCallThink', false)
    mount()
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30))
    })

    expect(container!.querySelector('.tool-group')).toBeNull()
    // 两个工具调用各自作为卡片平铺（MessageBubble 的 toolCalls 直接渲染）
    expect(container!.querySelectorAll('.tool-card').length).toBe(2)
  })

  it('检索 / 引用跳转命中组内工具消息 → 自动展开该组并高亮', async () => {
    // r1 是工具结果 → resolveJumpAnchorId 解析到宿主 assistant a1 → 命中组内成员
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      root!.render(
        <ChatMessageList
          messages={messages}
          setMessages={() => {}}
          setText={() => {}}
          jumpTarget={{ id: 'r1', sessionId: SESSION, nonce: 1 }}
        />,
      )
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30))
    })

    // 组被自动展开（否则用户只看到一行折叠头，看不到命中的内容）
    expect(container!.querySelector('.tool-group__body')).not.toBeNull()
    expect(
      container!.querySelector('.tool-group__head')?.getAttribute('aria-expanded'),
    ).toBe('true')
    // 整个组行高亮（与单条消息同一套 .highlighted 视觉）
    expect(
      container!.querySelector('.message-item-wrap.highlighted'),
    ).not.toBeNull()
  })
})
