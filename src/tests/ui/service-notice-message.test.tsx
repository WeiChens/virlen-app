/**
 * 后台服务结束通知（feedback 消息，消息流只留一行胶囊）的渲染测试。
 *
 * 关键约定（铁律 1）：正文是**给模型的固定英文**，界面按 `uiData` 用界面语言重建 ——
 * 所以这里既要断言「说了什么」（中文、带服务名与退出码），也要断言「没有把英文正文贴出来」。
 * 服务详情（命令 / 输出 / 终端）在标题栏面板与工具卡片里看，不在这一行里铺开。
 */
import { describe, it, expect, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

vi.mock('@tauri-apps/plugin-opener', () => ({
  openPath: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}))
vi.mock('@/ui/components/shared/Toast', () => ({
  showToast: vi.fn(),
  useToast: (): any => ({ Toast: (): any => null, showToast: vi.fn() }),
}))
vi.mock('@/monaco/setupMonaco', () => ({
  monaco: { editor: { tokenize: (): any[] => [] } },
  virlenDarkTheme: {},
}))
vi.mock('@/ui/components/shared/MessageBox', () => ({
  MessageBox: { warn: vi.fn(async () => false) },
  useMessageBox: () => ({ MessageBox: { warn: vi.fn(async () => false) } }),
}))

import MessageBubble from '@/ui/pages/chat/components/message/message-bubble'
import type { Message } from '@/types'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

/** Rust 组装的那条消息（形状见 `virlen-core` 的 `service/common.rs::exit_notice`） */
function notice(ui: Record<string, unknown>): Message {
  return {
    id: 'notice-1',
    role: 'feedback',
    content:
      '[Background service ended] "dev" (id: svc_1) exited on its own after 12s.',
    uiData: { type: 'service', event: 'exit', ...ui },
    timestamp: 0,
  } as unknown as Message
}

async function render(node: React.ReactNode) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(node)
  })
  return { host, root }
}

async function textOf(message: Message): Promise<string> {
  const { host, root } = await render(<MessageBubble message={message} />)
  const capsule = host.querySelector('.message-service-notice')
  expect(capsule).toBeTruthy()
  const text = capsule!.textContent ?? ''
  await act(async () => root.unmount())
  return text
}

describe('后台服务结束通知', () => {
  it('自行退出：一行说清「哪个服务 + 退出码」，且不放模型侧英文正文', async () => {
    const text = await textOf(
      notice({ id: 'svc_1', name: 'dev', status: 'exited', returnCode: 1, killed: false }),
    )
    expect(text).toContain('后台服务「dev」已结束')
    expect(text).toContain('退出码 1')
    // 铁律 1：英文报告只给模型，界面不贴
    expect(text).not.toContain('Background service')
  })

  it('被终止与自行退出必须分开说（对模型与用户含义完全不同）', async () => {
    const killed = await textOf(
      notice({ id: 'svc_2', name: 'watch', status: 'exited', killed: true }),
    )
    expect(killed).toContain('后台服务「watch」已被终止')
    expect(killed).not.toContain('已结束')
  })

  it('取不到退出码：只说「已结束」，不编造一个码', async () => {
    const text = await textOf(
      notice({ id: 'svc_3', name: 'job', status: 'exited', killed: false }),
    )
    expect(text).toContain('后台服务「job」已结束')
    expect(text).not.toContain('退出码')
  })
})
