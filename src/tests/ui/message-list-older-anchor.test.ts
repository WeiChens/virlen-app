// @vitest-environment node
/**
 * 回补历史时的「阅读锚点」纯函数用例（`message-list/helpers.ts` 的
 * `captureOlderAnchor` / `resolveOlderAnchorRow`）。
 *
 * 为什么锚点用**消息 id** 而不是行 key：前插一页历史时，若页边界劈开了「工具宿主 + 它的结果」，
 * 工具组会吸收新成员 → 组行 key 从 `tools:旧首成员` 变成 `tools:新首成员`。虚拟库按 key 锚定，
 * key 一没就一次补偿都不做（视口整块跳到刚取回的那一页）。消息 id 不会变，拿它重新查「现在
 * 落在哪一行」才是稳的。
 *
 * Rust 侧的页边界对齐（`session_db/visible.rs::is_turn_head`）就是为了让这种情况尽量不发生 ——
 * 本文件的最后一组用例把这条不变式钉在行模型上。
 */
import { describe, expect, it } from 'vitest'
import type { Message, ToolUseContent } from '@/types'
import {
  captureOlderAnchor,
  resolveOlderAnchorRow,
} from '@/ui/pages/chat/components/message/message-list/helpers'
import {
  buildRowIndexMap,
  buildRows,
  TOOL_GROUP_PREFIX,
} from '@/ui/pages/chat/components/message/message-list/rows'

const tc = (id: string): ToolUseContent => ({
  type: 'tool_use',
  id,
  name: 'read_file',
  input: {},
})

const user = (id: string): Message => ({
  id,
  role: 'user',
  content: 'hi',
  timestamp: 0,
})

/** 工具宿主 assistant（无正文 → 会被折进工具组） */
const host = (id: string): Message => ({
  id,
  role: 'assistant',
  content: '',
  toolCalls: [tc(`${id}-call`)],
  timestamp: 0,
})

/** role='tool' 的结果消息（列表里 0 高度） */
const result = (id: string, hostId: string): Message => ({
  id,
  role: 'tool',
  content: 'ok',
  toolCallId: `${hostId}-call`,
  timestamp: 0,
})

/** 普通 assistant 气泡（自成一行） */
const say = (id: string): Message => ({
  id,
  role: 'assistant',
  content: '好',
  timestamp: 0,
})

describe('captureOlderAnchor', () => {
  it('取「压在折叠线上的那一行」+ 行内偏移', () => {
    const messages = [user('u1'), say('a1')]
    const rows = buildRows(messages, true)
    const anchor = captureOlderAnchor(
      [
        { index: 0, start: 8 },
        { index: 1, start: 100 },
      ],
      120,
      rows,
      messages,
    )
    expect(anchor).toEqual({ messageId: 'a1', offset: 20 })
  })

  it('工具组行取首成员 id（组的身份，不随组内变动而变）', () => {
    const messages = [user('u1'), host('a1'), result('r1', 'a1'), host('a2'), result('r2', 'a2')]
    const rows = buildRows(messages, true)
    // 首行 user，第二行是工具组（a1 / a2 合一段）
    expect(rows[1].key).toBe(`${TOOL_GROUP_PREFIX}a1`)
    const anchor = captureOlderAnchor(
      [
        { index: 0, start: 8 },
        { index: 1, start: 100 },
      ],
      150,
      rows,
      messages,
    )
    expect(anchor).toEqual({ messageId: 'a1', offset: 50 })
  })

  it('条目为空（空列表 / 尚未渲染）→ null', () => {
    expect(captureOlderAnchor([], 0, buildRows([], true), [])).toBeNull()
  })

  it('滚动偏移停在首行之上（顶部内边距里）→ 取第一条，偏移为负也不写错', () => {
    const messages = [user('u1')]
    const rows = buildRows(messages, true)
    const anchor = captureOlderAnchor([{ index: 0, start: 8 }], 3, rows, messages)
    expect(anchor).toEqual({ messageId: 'u1', offset: -5 })
    // 校正公式在未变动时是恒等：start + offset === 当前 scrollTop
    expect(8 + (anchor?.offset ?? 0)).toBe(3)
  })
})

describe('resolveOlderAnchorRow', () => {
  it('前插后按消息 id 找回「现在落在哪一行」', () => {
    const before = [user('u1'), say('a1')]
    const after = [user('u0'), say('a0'), ...before]
    const anchor = captureOlderAnchor(
      [
        { index: 0, start: 8 },
        { index: 1, start: 100 },
      ],
      120,
      buildRows(before, true),
      before,
    )
    expect(anchor).not.toBeNull()
    const rows = buildRows(after, true)
    expect(resolveOlderAnchorRow(anchor!, after, buildRowIndexMap(after, rows))).toBe(3)
  })

  it('组行 key 变了也认得回来（锚点用 id，不用 key）', () => {
    const before = [host('a1'), result('r1', 'a1'), host('a2'), result('r2', 'a2')]
    const beforeRows = buildRows(before, true)
    const anchor = { messageId: 'a1', offset: 30 }
    // 前插一段『劈开工具段』的历史：新宿主 h0 把 a1 / a2 并入同一组
    const after = [host('h0'), result('r0', 'h0'), ...before]
    const afterRows = buildRows(after, true)
    expect(afterRows[0].key).toBe(`${TOOL_GROUP_PREFIX}h0`)
    expect(beforeRows[0].key).toBe(`${TOOL_GROUP_PREFIX}a1`)
    expect(resolveOlderAnchorRow(anchor, after, buildRowIndexMap(after, afterRows))).toBe(0)
  })

  it('消息已不在内存（被删 / 换了会话）→ null', () => {
    const messages = [user('u1')]
    const rows = buildRows(messages, true)
    expect(
      resolveOlderAnchorRow(
        { messageId: 'gone', offset: 0 },
        messages,
        buildRowIndexMap(messages, rows),
      ),
    ).toBeNull()
  })
})

describe('页边界对齐（Rust `is_turn_head`）守住的不变式', () => {
  it('前插块以 user 消息收尾 → 既有首行 key 不变', () => {
    const before = [user('u2'), host('a2'), result('r2', 'a2')]
    // 上一页的最后一条是 user 消息 u2 之前的 u1（Rust 侧保证页首是 user）
    const after = [user('u1'), say('a1'), ...before]
    expect(buildRows(after, true)[2].key).toBe(buildRows(before, true)[0].key)
  })

  it('前插块以工具宿主收尾 → 既有工具组被吞并（key 变，只能靠 id 兜底）', () => {
    const before = [host('a1'), result('r1', 'a1'), host('a2'), result('r2', 'a2')]
    const after = [host('h0'), result('r0', 'h0'), ...before]
    expect(buildRows(before, true)).toHaveLength(1)
    expect(buildRows(after, true)[0].key).not.toBe(buildRows(before, true)[0].key)
  })
})
