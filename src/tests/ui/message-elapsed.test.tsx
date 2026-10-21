/**
 * 气泡操作栏上的「本轮 agent 循环总耗时」。
 *
 * 为什么要挂真实组件：耗时是挂在 `message.uiData.agentElapsedMs` 上的（见 `utils/messageMeta.ts`），
 * 它只在**有值且不是工具卡**的消息上渲染，并且必须落在 `.message-actions` 里 ——
 * 这三点都只有在 DOM 里才看得见（纯函数层只能钉住「读出来的数是多少」）。
 *
 * ⚠️ 操作栏的整体显隐由 CSS 控制（按钮随 hover 出现、耗时常显）：那是样式契约，见
 * `message-bubble.scss` 的 `.message-actions`；本用例只钉结构。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Message } from '@/types'

vi.mock('@tauri-apps/plugin-opener', () => ({
  openPath: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}))
vi.mock('@/ui/components/shared/Toast', () => ({
  showToast: vi.fn(),
  useToast: (): any => ({ Toast: (): any => null, showToast: vi.fn() }),
}))
vi.mock('@/ui/components/shared/MessageBox', () => ({
  MessageBox: { warn: vi.fn(async () => false) },
  useMessageBox: () => ({ MessageBox: { warn: vi.fn(async () => false) } }),
}))
/** Monaco 在 jsdom 里跑不起来（缺 CSS.escape / canvas）——气泡会经 ToolCallMessage 间接拉到它 */
vi.mock('@/monaco/setupMonaco', () => ({
  monaco: { editor: { tokenize: (): any[] => [] } },
  virlenDarkTheme: {},
}))
vi.mock('@/ui/pages/chat/components/message/code-block', () => ({
  default: ({ children }: any) => <pre className="code-block-body">{children}</pre>,
}))
/** 正文渲染器换成替身：本用例只关心操作栏 */
vi.mock('@/ui/pages/chat/components/message/markdown-renderer', () => ({
  default: ({ content }: { content: string }) => <div className="md-body">{content}</div>,
}))

import MessageBubble from '@/ui/pages/chat/components/message/message-bubble'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement | null = null
let root: Root | null = null

function mount(message: Message): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(<MessageBubble message={message} />)
  })
}

const assistant = (extra: Partial<Message> = {}): Message => ({
  id: 'a1',
  role: 'assistant',
  content: '跑完了。',
  timestamp: 0,
  ...extra,
})

afterEach(() => {
  if (root) {
    act(() => root!.unmount())
    root = null
  }
  container?.remove()
  container = null
})

describe('message-actions —— 本轮总耗时', () => {
  it('有总耗时：渲染在操作栏里（弱化标签，不占按钮位）', () => {
    mount(assistant({ uiData: { agentElapsedMs: 12_400 } }))
    const badge = container!.querySelector('.message-actions .action-elapsed')
    expect(badge?.textContent).toBe('耗时 12.4s')
    // 与发送时间并存：耗时在左、时间在右（同一行）
    expect(
      container!.querySelector('.message-actions .action-time'),
    ).not.toBeNull()
  })

  it('没有总耗时（旧消息 / 出错 / 取消）：不渲染标签', () => {
    mount(assistant())
    expect(container!.querySelector('.action-elapsed')).toBeNull()
  })

  it('用户消息不显示（耗时是本轮 AI 的，不是用户发言的）', () => {
    mount({
      id: 'u1',
      role: 'user',
      content: '你好',
      timestamp: 0,
      uiData: { agentElapsedMs: 5000 },
    })
    expect(container!.querySelector('.message-actions')).not.toBeNull()
    expect(container!.querySelector('.action-elapsed')).toBeNull()
  })
})
