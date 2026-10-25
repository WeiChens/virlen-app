// @vitest-environment node
/**
 * `present` → 右侧面板（自动打开那一次的唯一落点）
 *
 * 四条口径：
 *   ① 只有 `uiData.type = "present"` 的**成功**结果才开标签（失败结果里的文件根本没被收下）；
 *   ② 只认用户正看着的那个会话 —— 后台会话的工具结果不该把标签页抢过去；
 *   ③ 没有登记宿主（不在聊天页 / 用例里没注入）时如实返回 false，不假装开过；
 *   ④ 注销后不再回调（聊天页卸载不能把旧实例的 handler 留着）。
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
  presentedPathsOf,
  revealPresentedFiles,
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

function presentResult(paths: string[], over: Record<string, any> = {}): Message {
  return {
    id: 'tr-present',
    role: 'tool',
    content: 'Presented 2 file(s) to the user …',
    toolCallId: 'tc-present',
    uiData: {
      type: 'present',
      files: paths.map((path) => ({ path, name: path.split('/').pop(), sizeBytes: 1 })),
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

describe('revealPresentedFiles', () => {
  it('登记后把路径交给宿主；注销后不再回调', () => {
    const seen: string[][] = []
    const dispose = setPresentRevealHandler((paths) => seen.push(paths))

    expect(revealPresentedFiles(['E:/out/a.xlsx'])).toBe(true)
    expect(seen).toEqual([['E:/out/a.xlsx']])

    dispose()
    expect(revealPresentedFiles(['E:/out/b.pptx'])).toBe(false)
    expect(seen).toHaveLength(1)
  })

  it('空列表不算一次打开', () => {
    const handler = vi.fn()
    setPresentRevealHandler(handler)
    expect(revealPresentedFiles([])).toBe(false)
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

    expect(handler).toHaveBeenCalledWith(['E:/out/a.xlsx', 'E:/out/b.pptx'])
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
