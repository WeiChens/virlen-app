/**
 * 「已中断」徽标（P0-2 的可见性收尾）。
 *
 * 背景：崩溃/退出会打断一轮回复，`repair_tail` 在库里把那条消息标成
 * `uiData.interrupted = true` 并保留已产出的正文。如果界面不表态，用户看到的只是
 * 「一句话说到一半」，会以为是模型抽风 —— 这个徽标就是那句「不是你记错了」。
 *
 * 只断言两件事：带标记时有徽标、不带时没有（其余渲染逻辑由 message-bubble 自己的测试覆盖）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

vi.mock('@tauri-apps/plugin-opener', () => ({
  openPath: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}))
vi.mock('@/utils/clipboard', () => ({
  copyText: vi.fn(() => Promise.resolve(true)),
  copyImageToClipboard: vi.fn(() => Promise.resolve(true)),
  saveImageAs: vi.fn(() => Promise.resolve('E:/tmp/a.png')),
  defaultImageName: vi.fn(() => 'image-1'),
  imageMimeOf: vi.fn(() => 'image/png'),
  imageExtOf: vi.fn(() => 'png'),
  readImageBytes: vi.fn(() => Promise.resolve(new Uint8Array())),
}))
vi.mock('@/ui/components/shared/Toast', () => ({
  showToast: vi.fn(),
  useToast: (): any => ({ Toast: (): any => null, showToast: vi.fn() }),
}))
/** Monaco 在 jsdom 里跑不起来（缺 CSS.escape / canvas） */
vi.mock('@/monaco/setupMonaco', () => ({
  monaco: { editor: { tokenize: (): any[] => [] } },
  virlenDarkTheme: {},
}))
vi.mock('@/ui/pages/chat/components/message/code-block', () => ({
  default: ({ children }: any) => <pre className="code-block-body">{children}</pre>,
}))
vi.mock('@/ui/components/shared/MessageBox', () => ({
  MessageBox: { warn: vi.fn(async () => false) },
  useMessageBox: () => ({ MessageBox: { warn: vi.fn(async () => false) } }),
}))

import MessageBubble from '@/ui/pages/chat/components/message/message-bubble'
import '@/ui/i18n'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

async function render(node: React.ReactNode): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(node)
  })
  return host
}

/** 一条 assistant 回复；`interrupted` 决定是否带崩溃标记 */
function assistantMessage(interrupted: boolean): any {
  return {
    id: 'm1',
    role: 'assistant',
    content: '这句话说到一半',
    timestamp: 1_700_000_000_000,
    ...(interrupted ? { uiData: { interrupted: true } } : {}),
  }
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('已中断徽标', () => {
  it('带 uiData.interrupted 的回复显示徽标', async () => {
    const host = await render(<MessageBubble message={assistantMessage(true)} />)
    const badge = host.querySelector('.action-interrupted')
    expect(badge).not.toBeNull()
    expect(badge!.textContent).toBe('已中断')
    // 正文照常显示（徽标不代表内容被丢弃）
    expect(host.textContent).toContain('这句话说到一半')
  })

  it('正常回复不显示徽标', async () => {
    const host = await render(<MessageBubble message={assistantMessage(false)} />)
    expect(host.querySelector('.action-interrupted')).toBeNull()
  })

  it('未定稿占位（uiData.pending + streaming）也按「已中断」展示', async () => {
    // 进程在流式途中被杀：库里那行还带着 streaming=1 + uiData.pending。
    // 即使后台修复还没跑，界面也不能永远停在一个闪光的流式光标上。
    const message = {
      ...assistantMessage(false),
      streaming: true,
      uiData: { pending: true },
    }
    const host = await render(<MessageBubble message={message} />)
    expect(host.querySelector('.action-interrupted')).not.toBeNull()
    // 已产出的正文必须还在
    expect(host.textContent).toContain('这句话说到一半')
  })

  it('流式中（streaming）不显示徽标：它是“已停止”的终态标记', async () => {
    const message = { ...assistantMessage(true), streaming: true }
    const host = await render(<MessageBubble message={message} />)
    // 操作栏整体不渲染（`showActions = !streaming && ...`）
    expect(host.querySelector('.message-actions')).toBeNull()
    expect(host.querySelector('.action-interrupted')).toBeNull()
  })
})
