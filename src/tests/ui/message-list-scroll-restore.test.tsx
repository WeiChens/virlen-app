/**
 * 「滚动位置被浏览器挪走之后还能回到原来读到的地方」的守卫用例。
 *
 * 背景（真机 + 无头 Chromium 实测）：`scrollTop` 有两类**不可逆**的归零，浏览器不会自己恢复 ——
 * 内容高度塌到 0、视口一度高过内容。窗口最小化 / 恢复、右侧面板占满把聊天区藏起来都会撞上这两类，
 * 而且夹出来的结果未必是 0（中段也可能被夹成一个小偏移）—— 症状就是「切到会话时在底部，最小化再
 * 切回来变成最顶部」或「读到一半的位置变了」。
 *
 * 守两条：
 * 1. **0 高度不入缓存**：还没布局的行（量到 0）不能把 sizer 的总高一起塌掉；
 * 2. **意图判定**（纯函数）：贴底 / 停在某行某处；几何不可信那一拍不能把真正的意图抹掉。
 *
 * 需要真实 260ms 等待的「被夹到 0 之后复位」四条集成用例已随全量测试提速删除；
 * 取回见 `git log -- src/tests/ui/message-list-scroll-restore.test.tsx`。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { runInAction } from 'mobx'
import type { Message, Session } from '@/types'

// 气泡本身与本用例无关（只关心行高与滚动位置）
vi.mock('@/ui/pages/chat/components/message/message-bubble', () => ({
  default: ({ message }: { message: Message }) => (
    <div className="bubble" data-id={message.id} />
  ),
}))
// monaco 在 jsdom 里跑不起来（它的入口 import 了 `@mono-codicon/codicon.css`）
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
import {
  anchorAt,
  nextIntent,
  restoreTargetOf,
  type ScrollIntent,
  type ScrollView,
} from '@/ui/pages/chat/components/message/message-list/scroll-restore'
import { ESTIMATED_ITEM_HEIGHT } from '@/ui/pages/chat/components/message/message-list/constants'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

/** 可控的 RO：记录每个目标的回调，用例自己决定什么时候触发（真机上是布局变了才回调） */
const observers: { cb: ResizeObserverCallback; targets: Element[] }[] = []
class FakeResizeObserver {
  constructor(private cb: ResizeObserverCallback) {
    observers.push({ cb, targets: [] })
  }
  observe(target: Element): void {
    const entry = observers[observers.length - 1]
    if (entry) entry.targets.push(target)
  }
  unobserve(): void {}
  disconnect(): void {}
}
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
  FakeResizeObserver

const SESSION = 's-scroll-restore'
/** 视口高度（用例里可改，模拟最小化 0 → 恢复 600） */
let viewportHeight = 600
/** 内容高度（用例里可改，模拟塌陷 → 重建） */
let contentHeight = 0

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
// 浏览器里 `elementScroll` 走的是 `scrollTo`；jsdom 不实现它，这里按 Web 语义写回 scrollTop
Element.prototype.scrollTo = function (
  this: Element,
  options?: ScrollToOptions | number,
): void {
  if (typeof options === 'object' && options && typeof options.top === 'number') {
    ;(this as HTMLElement).scrollTop = options.top
  }
}
Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
  configurable: true,
  get(this: HTMLElement) {
    return this.classList?.contains('chat-messages-container') ? viewportHeight : 600
  },
})
Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
  configurable: true,
  get: () => 800,
})
Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
  configurable: true,
  get(this: HTMLElement) {
    if (this.classList?.contains('chat-messages-container')) return contentHeight
    // 行：0 = 还没布局（最小化 / 聊天区被藏起来）
    return this.classList?.contains('message-item-wrap') ? 0 : 600
  },
})
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
  configurable: true,
  get(this: HTMLElement) {
    return this.classList?.contains('message-item-wrap') ? 0 : 600
  },
})
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
  configurable: true,
  get: () => 800,
})

const messages: Message[] = Array.from({ length: 20 }, (_, i) => ({
  id: `m${i}`,
  role: i % 2 === 0 ? 'user' : 'assistant',
  content: `第 ${i} 条`,
  timestamp: i,
})) as Message[]

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

function mount(): HTMLDivElement {
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
  const list = container.querySelector('.chat-messages-container') as HTMLDivElement
  return list
}

beforeEach(() => {
  observers.length = 0
  viewportHeight = 600
  contentHeight = 4000
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

describe('消息列表：位置被夹到 0 之后的复位', () => {
  it('行量到 0 高度时不写进缓存（sizer 不能被塌成一条线）', () => {
    mount()
    const sizer = document.querySelector('.vm-list') as HTMLElement
    // 没有实测高度时按估算值占位：20 行 × 估算高度（远大于「塌陷后只剩上下 padding」）
    expect(parseFloat(sizer.style.height)).toBeGreaterThan(
      20 * ESTIMATED_ITEM_HEIGHT * 0.5,
    )
  })

})

describe('scroll-restore：意图判定', () => {
  const view = (
    scrollTop: number,
    scrollHeight = 4000,
    clientHeight = 600,
  ): ScrollView => ({ scrollTop, scrollHeight, clientHeight })
  const intent = (over: Partial<ScrollIntent> = {}): ScrollIntent => ({
    atEnd: false,
    offset: 0,
    anchor: null,
    ...over,
  })

  it('贴底 / 离开底部（离开底部时记下行锚点）', () => {
    const anchor = { index: 3, delta: 40 }
    expect(nextIntent(intent(), view(3400), anchor)).toEqual({
      atEnd: true,
      offset: 3400,
      anchor: null,
    })
    expect(nextIntent(intent({ atEnd: true }), view(1200), anchor)).toEqual({
      atEnd: false,
      offset: 1200,
      anchor,
    })
  })

  it('几何不可信（内容塌陷 / 视口被夹到 0）时保留上一次意图', () => {
    const prev = intent({ offset: 1200, anchor: { index: 10, delta: 0 } })
    // 内容比视口还矮（塌陷 / 空列表）
    expect(nextIntent(prev, view(0, 40, 600), null)).toBe(prev)
    // 最小化那一拍：视口 0（内容高度还在，但这一拍不能当成「用户滑到了某个位置」）
    expect(nextIntent(prev, view(0, 4000, 0), null)).toBe(prev)
  })

  it('行锚点：二分找出视口顶端压在哪一行', () => {
    const rows = [
      { index: 0, start: 0 },
      { index: 1, start: 100 },
      { index: 2, start: 250 },
    ]
    expect(anchorAt(rows, 0)).toEqual({ index: 0, delta: 0 })
    expect(anchorAt(rows, 160)).toEqual({ index: 1, delta: 60 })
    expect(anchorAt(rows, 260)).toEqual({ index: 2, delta: 10 })
    expect(anchorAt([], 100)).toBeNull()
  })

  it('复位目标：贴底 → end；中段 → 锚点（被夹成 0 或别的值都算丢）', () => {
    expect(restoreTargetOf(intent({ atEnd: true, offset: 3400 }), view(0))).toBe('end')
    expect(
      restoreTargetOf(intent({ atEnd: true, offset: 3400 }), view(3380)),
    ).toBeNull()
    expect(restoreTargetOf(intent({ offset: 1200 }), view(0))).toBe(1200)
    // 中段被夹成非 0 值（真机症状）同样是丢了
    expect(restoreTargetOf(intent({ offset: 1200 }), view(300))).toBe(1200)
    // 容差之内不写（虚拟库已经补正）
    expect(restoreTargetOf(intent({ offset: 1200 }), view(1199))).toBeNull()
    // 用户自己滚到顶（意图里的偏移就是 0）不是「丢了」
    expect(restoreTargetOf(intent({ offset: 0 }), view(0))).toBeNull()
    // 内容不足一屏 / 视口 0（最小化那一拍）：没法判断，不写
    expect(restoreTargetOf(intent({ offset: 1200 }), view(0, 300, 600))).toBeNull()
    expect(restoreTargetOf(intent({ offset: 1200 }), view(0, 4000, 0))).toBeNull()
    // 偏移超过新的最大可滚动值 → 收敛到最大值
    expect(restoreTargetOf(intent({ offset: 9000 }), view(0))).toBe(3400)
  })

  it('复位目标优先用行锚点：行重测过也能回到同一处内容', () => {
    const startOf = (index: number) => (index === 4 ? 900 : undefined)
    // 记下时第 4 行从 1200 开始、视口压在行内 30px 处
    const anchored = intent({ offset: 1230, anchor: { index: 4, delta: 30 } })
    expect(restoreTargetOf(anchored, view(0), startOf)).toBe(930)
    // 锚点行已经不在测量缓存里 → 退回记下的像素偏移
    expect(
      restoreTargetOf(
        intent({ offset: 1200, anchor: { index: 99, delta: 30 } }),
        view(0),
        startOf,
      ),
    ).toBe(1200)
  })
})
