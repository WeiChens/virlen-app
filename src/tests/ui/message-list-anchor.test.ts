/**
 * message-list 锚点纯函数用例：`pickActiveAnchorUser`（活跃圆点判定）与 `findJumpTarget`（定位目标判定）。
 *
 * 这两条判据都是「看着对、真机上不对」的典型：
 * - 活跃圆点过去取「离视口顶部最近的一条」，视口里同时有两条用户消息时会高亮**上面**那条（已经读过的那条）；
 * - 定位目标过去只看 `resolveJumpAnchorId`，它找不到消息时会**原样返回 id**（「还没加载到」），
 *   直接拿来当命中判据会让回补循环第一页就“找到”一个并不存在的目标。
 */
import { describe, expect, it } from 'vitest'
import type { Message, ToolUseContent } from '@/types'
import {
  findJumpTarget,
  pickActiveAnchorUser,
  resolveJumpAnchorId,
} from '@/ui/pages/chat/components/message/message-list/helpers'

function msg(id: string, role: Message['role']): Message {
  return { id, role, content: '', timestamp: 0 } as unknown as Message
}

const tc = (id: string): ToolUseContent => ({
  type: 'tool_use',
  id,
  name: 'list_files',
  input: {},
})

/** 用「消息下标 → 顶部偏移」的字面表构造 topOf（未列出的 = 未测量） */
function topOfMap(map: Record<number, number>) {
  return (i: number): number | undefined => map[i]
}

describe('pickActiveAnchorUser', () => {
  // 视口 [0, 600]：u1 在 100（已滚过顶部）、u2 在 500（刚露头）
  const twoUsers: Message[] = [
    msg('u1', 'user'),
    msg('a1', 'assistant'),
    msg('u2', 'user'),
  ]
  const twoUsersTops = topOfMap({ 0: 100, 1: 300, 2: 500 })

  it('视口内同时有两条用户消息 → 取下面那条（正在读的那条）', () => {
    expect(pickActiveAnchorUser(twoUsers, twoUsersTops, 600)).toBe('u2')
  })

  it('下面那条还没进入视口 → 仍是上面那条', () => {
    expect(pickActiveAnchorUser(twoUsers, twoUsersTops, 400)).toBe('u1')
  })

  it('视口内没有任何用户消息（整体停在第一条之上）→ 兜底指向第一条', () => {
    const users: Message[] = [msg('u1', 'user'), msg('u2', 'user')]
    const tops = topOfMap({ 0: 900, 1: 1200 })
    expect(pickActiveAnchorUser(users, tops, 600)).toBe('u1')
  })

  it('没有用户消息 → null', () => {
    expect(
      pickActiveAnchorUser([msg('a1', 'assistant')], () => 0, 600),
    ).toBeNull()
  })

  it('未测量的条目跳过，不影响已测量条目的结论', () => {
    const users: Message[] = [msg('u1', 'user'), msg('u2', 'user')]
    // u1 未测量；u2 在视口内
    const tops = topOfMap({ 1: 200 })
    expect(pickActiveAnchorUser(users, tops, 600)).toBe('u2')
  })
})

describe('findJumpTarget', () => {
  it('消息还没回补到窗口里 → null（不能当成命中）', () => {
    expect(findJumpTarget([msg('m1', 'user')], 'm9')).toBeNull()
  })

  it('普通消息 → 返回它自己', () => {
    expect(findJumpTarget([msg('m1', 'user'), msg('m2', 'assistant')], 'm2')).toBe(
      'm2',
    )
  })

  it('tool 消息 + 宿主都在窗口里 → 返回宿主 assistant', () => {
    const host: Message = {
      ...msg('a1', 'assistant'),
      toolCalls: [tc('t1')],
    }
    const result = msg('r1', 'tool')
    result.toolCallId = 't1'
    expect(findJumpTarget([host, result], 'r1')).toBe('a1')
  })

  it('tool 消息在窗口里但宿主还没回补到 → null（继续回补）', () => {
    const result = msg('r1', 'tool')
    result.toolCallId = 't1'
    expect(findJumpTarget([result], 'r1')).toBeNull()
  })

  it('与 resolveJumpAnchorId 的差别：后者对「没加载到」原样返回 id', () => {
    expect(resolveJumpAnchorId([msg('m1', 'user')], 'm9')).toBe('m9')
    expect(findJumpTarget([msg('m1', 'user')], 'm9')).toBeNull()
  })
})
