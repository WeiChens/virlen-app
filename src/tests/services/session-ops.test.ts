/**
 * 会话写操作用例（手机控制 M4）
 *
 * 覆盖 `renameSession` / `setSessionPinned` —— 这两个是**接口层（手机）与桌面侧栏共用的用例入口**。
 * 为什么要有用例层（而不是让 bridge 直接调 store 裸 action）：校验规则（空标题、超长标题、目标态幂等）
 * 只能有一份；两端各写一份必然漂移（见 docs/phone-control-bridge.md §3/§16.1）。
 */
import { describe, it, expect, afterEach } from 'vitest'
import type { Session } from '@/types'
import { DEFAULT_SESSION_PARAMS } from '@/types'
import { sessionStore } from '@/ui/store/sessionStore'
import { renameSession, setSessionPinned, MAX_SESSION_TITLE_LEN } from '@/services/chat-service'

/** 构造一个最小可用会话 */
function makeSession(id: string, over: Partial<Session> = {}): Session {
  return {
    id,
    title: `t-${id}`,
    messages: [],
    providerConfigId: '',
    modelId: '',
    systemPrompt: '',
    params: { ...DEFAULT_SESSION_PARAMS },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    pinned: false,
    tags: [],
    ...over,
  }
}

const created: string[] = []
function seed(over: Partial<Session> = {}): string {
  const id = `m4-${created.length}-${Math.random().toString(36).slice(2, 8)}`
  sessionStore.saveSession(makeSession(id, over))
  created.push(id)
  return id
}

afterEach(() => {
  sessionStore.deleteSessions(created.splice(0))
})

describe('renameSession（唯一入口）', () => {
  it('正常改名：写入 trim 后的标题', () => {
    const id = seed()
    expect(renameSession(id, '  新标题  ')).toBe(true)
    expect(sessionStore.getSession(id)?.title).toBe('新标题')
  })

  it('空标题 / 纯空白：不改动（返回 false）—— 手机端删空标题不应把会话变成空名', () => {
    const id = seed({ title: '原名' })
    expect(renameSession(id, '')).toBe(false)
    expect(renameSession(id, '   ')).toBe(false)
    expect(sessionStore.getSession(id)?.title).toBe('原名')
  })

  it('超长标题：截断到上限（手机是第二个输入源，不能指望它的输入框限长）', () => {
    const id = seed()
    const long = 'x'.repeat(MAX_SESSION_TITLE_LEN + 50)
    expect(renameSession(id, long)).toBe(true)
    expect(sessionStore.getSession(id)?.title).toHaveLength(MAX_SESSION_TITLE_LEN)
  })

  it('会话不存在：返回 false 且不抛（手机端可能持有已删除的会话 id）', () => {
    expect(renameSession('no-such-session', 'x')).toBe(false)
  })
})

describe('setSessionPinned（目标态语义）', () => {
  it('置顶 / 取消置顶', () => {
    const id = seed({ pinned: false })
    expect(setSessionPinned(id, true)).toBe(true)
    expect(sessionStore.getSession(id)?.pinned).toBe(true)
    expect(setSessionPinned(id, false)).toBe(true)
    expect(sessionStore.getSession(id)?.pinned).toBe(false)
  })

  it('幂等：目标态已达成时不做无谓写入（不改变 updatedAt）', () => {
    const id = seed({ pinned: true })
    const before = sessionStore.getSession(id)?.updatedAt
    expect(setSessionPinned(id, true)).toBe(true)
    const after = sessionStore.getSession(id)
    expect(after?.pinned).toBe(true)
    expect(after?.updatedAt).toBe(before)
  })

  it('会话不存在：返回 false', () => {
    expect(setSessionPinned('no-such-session', true)).toBe(false)
  })
})
