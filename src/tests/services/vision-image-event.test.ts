// @vitest-environment node
/**
 * vision_image_created —— 「工具把图片交给模型」注入消息的前端落点。
 *
 * 为什么必须进内存：下一次发送的 `options.messages` 就是界面这份列表；缺了它，
 * 图片只躺在数据库里，模型下一轮根本看不到 —— 而工具结果文案已经写着「图已附上」。
 * 界面**不渲染**它（`rows.ts` 跳过）由 `tool-group-rows.test.ts` 另有用例守住。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import type { Message, Session } from '@/types'
import { DEFAULT_SESSION_PARAMS } from '@/types'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve()) }))

import { sessionStore } from '@/ui/store/sessionStore'
import { dropSessionRuntime } from '@/ui/store/sessionRuntimeStore'
import { createEventHandler } from '@/services/chat/event-handler'

const created: string[] = []

/** 登记一个空会话（afterEach 统一清掉，避免跨用例串味） */
function seed(): string {
  const id = `s-vision-forward-${created.length}-${Math.random().toString(36).slice(2, 8)}`
  const session: Session = {
    id,
    title: 't',
    messages: [],
    providerConfigId: '',
    modelId: '',
    systemPrompt: '',
    params: { ...DEFAULT_SESSION_PARAMS },
    createdAt: 0,
    updatedAt: 0,
    pinned: false,
    tags: [],
  }
  sessionStore.saveSession(session)
  created.push(id)
  return id
}

afterEach(() => {
  dropSessionRuntime(created)
  sessionStore.deleteSessions(created.splice(0))
})

/** Rust 发来的那条消息（内容已是外置引用：界面不渲染它，也就无需 base64） */
function imageMessage(): Message {
  return {
    id: 'img-1',
    role: 'vision_image',
    content: [
      { type: 'text', text: 'Image "shot.png" (/w/shot.png)' },
      {
        type: 'image_url',
        image_url: { url: `attachment://${'a'.repeat(64)}.png` },
      },
    ],
    timestamp: 2,
  }
}

describe('vision_image_created', () => {
  it('注入消息进会话内存（下一次请求才带得上图），且不刷新会话时间', () => {
    const id = seed()
    const updates: string[] = []
    const handler = createEventHandler(
      id,
      {} as never,
      { onMessagesUpdate: (sid) => updates.push(sid) },
    )

    handler({ type: 'vision_image_created', data: { message: imageMessage() } })

    const messages = sessionStore.getSession(id)?.messages ?? []
    expect(messages.map((m) => m.role)).toEqual(['vision_image'])
    expect(messages[0].id).toBe('img-1')
    // 图片注入不是用户发言 → 会话时间不刷新
    expect(sessionStore.getSession(id)?.updatedAt).toBe(0)
    // 界面需要重绘（虽然这条不渲染，它的到达会改变行下标映射）
    expect(updates).toEqual([id])
  })

  it('载荷缺消息 → 直接忽略（不进内存、不重绘）', () => {
    const id = seed()
    const updates: string[] = []
    const handler = createEventHandler(
      id,
      {} as never,
      { onMessagesUpdate: (sid) => updates.push(sid) },
    )

    handler({ type: 'vision_image_created', data: {} })

    expect(sessionStore.getSession(id)?.messages ?? []).toHaveLength(0)
    expect(updates).toEqual([])
  })
})
