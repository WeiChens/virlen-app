// @vitest-environment node
/**
 * 侧边栏「待你回答」徽标的数据源（`ui/store/pendingInteractionStore`）。
 *
 * 守一条：**入表 +1、出表 -1、运行结束收敛清零**。漏一次就是那条会话永远红着（或该红时不红），
 * 而行内卡片不弹窗、不闪烁 —— 这个点就是别的会话唯一的提示。
 *
 * 写点集中在 `services/tool-service/pending-slots.ts`，这里同时验它和真实 handles 的接线。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import toolInteractEvent from '@/events/toolInteractEvent'
import { createUserChoiceHandles } from '@/services/tool-service/user_choice'
import { PendingSlots } from '@/services/tool-service/pending-slots'
import {
  dropPendingInteractions,
  pendingInteractionCount,
  setPendingInteractionCount,
} from '@/ui/store/pendingInteractionStore'

beforeEach(() => {
  setPendingInteractionCount('s1', 0)
  setPendingInteractionCount('s2', 0)
})

describe('PendingSlots：增删清都同步计数', () => {
  it('set / delete / clear 各写一次', () => {
    const slots = new PendingSlots<number>('s1')
    slots.set('a', 1)
    expect(pendingInteractionCount('s1')).toBe(1)

    slots.set('b', 2)
    expect(pendingInteractionCount('s1')).toBe(2)

    slots.delete('a')
    expect(pendingInteractionCount('s1')).toBe(1)

    slots.clear()
    expect(pendingInteractionCount('s1')).toBe(0)
  })

  it('不同会话各自计数，互不影响', () => {
    new PendingSlots<number>('s1').set('a', 1)
    new PendingSlots<number>('s2').set('b', 2)
    expect(pendingInteractionCount('s1')).toBe(1)
    expect(pendingInteractionCount('s2')).toBe(1)
  })
})

describe('user_choice 的真实 handles', () => {
  it('提问挂起 → 1；应答 → 0', async () => {
    const handles = createUserChoiceHandles('s1')
    const seen: string[] = []
    // ⚠️ 先监听再 handler：showChoice 是在 handler 里**同步**抛出的
    const off = toolInteractEvent.on('showChoice', (payload) =>
      seen.push(payload.interactionId),
    )
    const pending = handles.handler('user_choice', {
      toolCallId: 'tc-1',
      question: '继续吗',
      options: ['是', '否'],
      multi: false,
    })
    expect(pendingInteractionCount('s1')).toBe(1)
    expect(seen).toHaveLength(1)

    toolInteractEvent.emit('resolve', 'unknown-id', { content: 'x' })
    // 不匹配的应答不改计数（幂等）
    expect(pendingInteractionCount('s1')).toBe(1)

    toolInteractEvent.emit('resolve', seen[0], { content: '是' })
    await pending
    expect(pendingInteractionCount('s1')).toBe(0)

    off()
    handles.cleanup()
  })

  it('运行结束收敛（cleanup）把计数清零', async () => {
    const handles = createUserChoiceHandles('s1')
    const pending = handles.handler('user_choice', {
      toolCallId: 'tc-2',
      question: '继续吗',
      options: ['是'],
      multi: false,
    })
    expect(pendingInteractionCount('s1')).toBe(1)

    handles.cleanup()
    await expect(pending).rejects.toBeTruthy()
    expect(pendingInteractionCount('s1')).toBe(0)
  })
})

describe('dropPendingInteractions', () => {
  it('只清传入的会话', () => {
    setPendingInteractionCount('s1', 2)
    setPendingInteractionCount('s2', 1)
    dropPendingInteractions(['s1'])
    expect(pendingInteractionCount('s1')).toBe(0)
    expect(pendingInteractionCount('s2')).toBe(1)
  })
})
