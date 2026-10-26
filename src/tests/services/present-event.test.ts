// @vitest-environment node
/**
 * `present` → 右侧面板（自动打开那一次的唯一落点）
 *
 * 四条口径：
 *   ① 只有 `uiData.type = "present"` 的**成功**结果才开标签（失败结果里的东西根本没被收下）；
 *   ② 只认用户正看着的那个会话 —— 后台会话的工具结果不该把标签页抢过去；
 *   ③ 没有登记宿主（不在聊天页 / 用例里没注入）时如实返回 false，不假装开过；
 *   ④ 注销后不再回调（聊天页卸载不能把旧实例的 handler 留着）。
 *
 * 交付网址（`uiData.links`）与文件同一条路：一条消息可以只有网址（此时 `files` 为空）。
 *
 * 卡片里「点文件名再打开一次」走的是同一个出口，见 `tests/ui/present-message.test.tsx`。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import type { Message, Session } from '@/types'
import { DEFAULT_SESSION_PARAMS } from '@/types'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve()) }))

import { chatState, sessionStore } from '@/ui/store'
import { dropSessionRuntime } from '@/ui/store/sessionRuntimeStore'
import { createEventHandler } from '@/services/chat/event-handler'
import {
  presentedLinksOf,
  presentedOf,
  presentedPathsOf,
  revealPresented,
  setPresentRevealHandler,
} from '@/services/present-service'

const created: string[] = []

function seed(): string {
  const id = `s-present-${created.length}-${Math.random().toString(36).slice(2, 8)}`
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
  setPresentRevealHandler(null)
  chatState.setValue('currentSessionId', null)
  dropSessionRuntime(created)
  sessionStore.deleteSessions(created.splice(0))
})

function presentResult(
  paths: string[],
  over: Record<string, any> = {},
  urls: string[] = [],
): Message {
  return {
    id: 'tr-present',
    role: 'tool',
    content: 'Presented 2 deliverable(s) to the user …',
    toolCallId: 'tc-present',
    uiData: {
      type: 'present',
      files: paths.map((path) => ({ path, name: path.split('/').pop(), sizeBytes: 1 })),
      links: urls.map((url) => ({ url, name: new URL(url).host })),
      skipped: [],
    },
    timestamp: 1,
    ...over,
  } as Message
}

describe('presentedPathsOf', () => {
  it('从 uiData.files 取路径（权威来源，不解析正文）', () => {
    expect(
      presentedPathsOf(presentResult(['E:/out/a.xlsx', 'E:/out/b.pptx'])),
    ).toEqual(['E:/out/a.xlsx', 'E:/out/b.pptx'])
  })

  it('失败结果 / 别的 uiData 类型 / 缺消息 → 空', () => {
    expect(presentedPathsOf(presentResult(['E:/out/a.xlsx'], { isError: true }))).toEqual(
      [],
    )
    expect(
      presentedPathsOf({
        id: 'x',
        role: 'tool',
        content: '',
        uiData: { type: 'todo', todos: [] },
        timestamp: 0,
      } as Message),
    ).toEqual([])
    expect(presentedPathsOf(undefined)).toEqual([])
  })
})

describe('presentedOf / presentedLinksOf', () => {
  it('从 uiData.links 取网址（与文件同一个 payload）', () => {
    const message = presentResult(['E:/out/a.xlsx'], {}, ['https://docs.rs/tokio'])
    expect(presentedLinksOf(message)).toEqual(['https://docs.rs/tokio'])
    expect(presentedOf(message)).toEqual({
      paths: ['E:/out/a.xlsx'],
      urls: ['https://docs.rs/tokio'],
    })
  })

  it('文件 / 网址可以各只有一边（旧的「只有文件」结果仍然能用）', () => {
    expect(presentedOf(presentResult(['E:/out/a.xlsx']))).toEqual({
      paths: ['E:/out/a.xlsx'],
      urls: [],
    })
    expect(presentedOf(presentResult([], {}, ['https://example.com/']))).toEqual({
      paths: [],
      urls: ['https://example.com/'],
    })
  })

  it('失败结果 / 缺字段 / 缺消息 → 两项都空', () => {
    const failed = presentResult(['E:/out/a.xlsx'], { isError: true }, ['https://a.com/'])
    expect(presentedOf(failed)).toEqual({ paths: [], urls: [] })
    // 老版本的 uiData 没有 links 字段：不能把整条结果当成空的
    expect(presentedLinksOf(presentResult([]))).toEqual([])
    expect(presentedOf(undefined)).toEqual({ paths: [], urls: [] })
  })
})

describe('revealPresented', () => {
  it('登记后把文件与网址交给宿主；注销后不再回调', () => {
    const seen: { paths: string[]; urls: string[] }[] = []
    const dispose = setPresentRevealHandler((payload) => seen.push(payload))

    expect(revealPresented({ paths: ['E:/out/a.xlsx'], urls: ['https://a.com/'] })).toBe(true)
    expect(seen).toEqual([{ paths: ['E:/out/a.xlsx'], urls: ['https://a.com/'] }])

    dispose()
    expect(revealPresented({ paths: [], urls: ['https://b.com/'] })).toBe(false)
    expect(seen).toHaveLength(1)
  })

  it('两项都空不算一次打开', () => {
    const handler = vi.fn()
    setPresentRevealHandler(handler)
    expect(revealPresented({ paths: [], urls: [] })).toBe(false)
    expect(handler).not.toHaveBeenCalled()
  })
})

describe('tool_result_created → 右侧面板', () => {
  it('当前会话的交付物直接摊开', () => {
    const id = seed()
    chatState.setValue('currentSessionId', id)
    const handler = vi.fn()
    setPresentRevealHandler(handler)

    const events = createEventHandler(id, {} as never)
    events({
      type: 'tool_result_created',
      data: { message: presentResult(['E:/out/a.xlsx', 'E:/out/b.pptx']) },
    })

    expect(handler).toHaveBeenCalledWith({
      paths: ['E:/out/a.xlsx', 'E:/out/b.pptx'],
      urls: [],
    })
  })

  it('只交网址也算交付（以往会因为「没文件」而不开）', () => {
    const id = seed()
    chatState.setValue('currentSessionId', id)
    const handler = vi.fn()
    setPresentRevealHandler(handler)

    const events = createEventHandler(id, {} as never)
    events({
      type: 'tool_result_created',
      data: { message: presentResult([], {}, ['https://docs.rs/tokio']) },
    })

    expect(handler).toHaveBeenCalledWith({
      paths: [],
      urls: ['https://docs.rs/tokio'],
    })
  })

  it('后台会话（用户没在看）不开标签', () => {
    const id = seed()
    chatState.setValue('currentSessionId', 'some-other-session')
    const handler = vi.fn()
    setPresentRevealHandler(handler)

    const events = createEventHandler(id, {} as never)
    events({
      type: 'tool_result_created',
      data: { message: presentResult(['E:/out/a.xlsx']) },
    })

    expect(handler).not.toHaveBeenCalled()
  })

  it('失败结果不开标签（文件根本没被收下）', () => {
    const id = seed()
    chatState.setValue('currentSessionId', id)
    const handler = vi.fn()
    setPresentRevealHandler(handler)

    const events = createEventHandler(id, {} as never)
    events({
      type: 'tool_result_created',
      data: {
        message: presentResult(['E:/out/a.xlsx'], { isError: true, uiData: undefined }),
      },
    })

    expect(handler).not.toHaveBeenCalled()
  })
})
