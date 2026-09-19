/**
 * deleteSessionMessage / clearSessionMessages — 用户消息锚点索引同步回归测试
 *
 * 回归背景：
 * 右侧锚点列表的数据来自 sessionStore 的「全量用户消息索引」。
 * 该索引由 ensureUserMessageIndex 一次性从 SQLite 拉取后缓存
 *（loadedUserIndexIds 保证只加载一次），不会随 session.messages 自动更新。
 *
 * 早期 deleteSessionMessage 只截断了 session.messages，却没有同步这个缓存索引，
 * 导致删除用户消息后，锚点列表里仍残留已删除消息的圆点（点击会跳到错误位置）。
 * 现在删除 / 清空消息时会同步剔除索引中对应的用户消息。
 */
import { describe, it, expect } from 'vitest'
import { sessionStore } from '@/ui/store'
import {
  deleteSessionMessage,
  clearSessionMessages,
  replaceSessionMessages,
} from '@/services/chat-service'
import type { Message, MessageRole, Session } from '@/types'

let seq = 0

function msg(role: MessageRole, id?: string): Message {
  seq += 1
  return {
    id: id ?? `m-${seq}`,
    role,
    content: '',
    timestamp: seq,
  } as unknown as Message
}

/** 建立一个会话，并把「全量用户消息索引」预置为给定 id（模拟已从 SQLite 加载） */
function seedSession(
  id: string,
  messages: Message[],
  indexIds: string[],
): void {
  const session: Session = {
    id,
    title: `t-${id}`,
    messages,
    providerConfigId: 'p1',
    modelId: 'm1',
    systemPrompt: '',
    params: { temperature: 0.7, topP: 1, maxTokens: 1024, stream: true },
    createdAt: 1,
    updatedAt: 1,
    pinned: false,
    tags: [],
  }
  sessionStore.saveSession(session)
  sessionStore.value.userMessageIndex = {
    ...sessionStore.value.userMessageIndex,
    [id]: indexIds.map((i) => ({ id: i, preview: i })),
  }
}

describe('删除消息 → 用户消息锚点索引同步', () => {
  it('删除用户消息 → 该条及其之后的用户消息从索引中移除', () => {
    seedSession(
      's-del-1',
      [
        msg('user', 'u1'),
        msg('assistant', 'a1'),
        msg('user', 'u2'),
        msg('assistant', 'a2'),
        msg('user', 'u3'),
      ],
      ['u1', 'u2', 'u3'],
    )

    expect(deleteSessionMessage('s-del-1', 'u2')).toBe(true)

    expect(sessionStore.getUserMessageIndex('s-del-1').map((r) => r.id)).toEqual(
      ['u1'],
    )
  })

  it('删除 assistant 消息 → 其后被连带删除的用户消息也一并从索引移除', () => {
    seedSession(
      's-del-2',
      [msg('user', 'u1'), msg('assistant', 'a1'), msg('user', 'u2')],
      ['u1', 'u2'],
    )

    expect(deleteSessionMessage('s-del-2', 'a1')).toBe(true)

    expect(sessionStore.getUserMessageIndex('s-del-2').map((r) => r.id)).toEqual(
      ['u1'],
    )
  })

  it('不允许删除 tool 消息 → 索引保持不变', () => {
    seedSession(
      's-del-3',
      [msg('user', 'u1'), msg('tool', 't1'), msg('user', 'u2')],
      ['u1', 'u2'],
    )

    expect(deleteSessionMessage('s-del-3', 't1')).toBe(false)

    expect(sessionStore.getUserMessageIndex('s-del-3').map((r) => r.id)).toEqual(
      ['u1', 'u2'],
    )
  })

  it('清空会话消息 → 索引整体清空', () => {
    seedSession(
      's-clear-1',
      [msg('user', 'u1'), msg('assistant', 'a1')],
      ['u1'],
    )

    expect(clearSessionMessages('s-clear-1')).toBe(true)
    expect(sessionStore.getUserMessageIndex('s-clear-1')).toEqual([])
  })

  it('整批替换（上下文压缩）→ 索引中已不存在的用户消息被剔除', () => {
    seedSession(
      's-replace-1',
      [msg('user', 'u1'), msg('assistant', 'a1'), msg('user', 'u2')],
      ['u1', 'u2'],
    )

    // 压缩后仅保留 u1（u2 被压缩掉），并追加新的 assistant
    const next = [msg('user', 'u1'), msg('assistant', 'a2')]
    expect(replaceSessionMessages('s-replace-1', next)).toBe(true)

    expect(
      sessionStore.getUserMessageIndex('s-replace-1').map((r) => r.id),
    ).toEqual(['u1'])
  })
})
