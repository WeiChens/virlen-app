/**
 * 提问草稿缓存（`modals/choice-drafts.ts`）纯函数用例。
 *
 * 守「暂存 → 恢复」这条路上草稿的生命周期：按 `sessionId|toolCallId` 存、取用**不删除**（恢复后
 * 若再次暂存还要再带回来一次）、空键（异常载荷没有 toolCallId）整体降级为不缓存。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearAllChoiceDrafts,
  clearChoiceDraft,
  draftKey,
  getChoiceDraft,
  saveChoiceDraft,
  type ChoiceDraft,
} from '@/ui/pages/chat/components/modals/choice-drafts'

const draft: ChoiceDraft = {
  selected: ['继续'],
  customReply: '补充说明',
  showCustom: true,
}

beforeEach(() => {
  clearAllChoiceDrafts()
})

describe('choice-drafts：键与生命周期', () => {
  it('键 = sessionId|toolCallId；没有 toolCallId（异常载荷）返回空键', () => {
    expect(draftKey('s1', 'tc-1')).toBe('s1|tc-1')
    // interactionId 每次都换，绝不能当键 —— 这里只接受稳定的 toolCallId
    expect(draftKey('s1', '')).toBe('')
  })

  it('存 / 取往返；取用不删除（恢复后的弹窗若再被暂存，草稿还要再带回来一次）', () => {
    const key = draftKey('s1', 'tc-1')
    expect(getChoiceDraft(key)).toBeUndefined()
    saveChoiceDraft(key, draft)
    expect(getChoiceDraft(key)).toEqual(draft)
    // 再取一次仍在
    expect(getChoiceDraft(key)).toEqual(draft)
  })

  it('不同会话 / 不同 toolCallId 互不影响', () => {
    saveChoiceDraft(draftKey('s1', 'tc-1'), draft)
    expect(getChoiceDraft(draftKey('s2', 'tc-1'))).toBeUndefined()
    expect(getChoiceDraft(draftKey('s1', 'tc-2'))).toBeUndefined()
  })

  it('清理：应答 / 取消 / 收敛后调用；重复清理幂等', () => {
    const key = draftKey('s1', 'tc-1')
    saveChoiceDraft(key, draft)
    clearChoiceDraft(key)
    expect(getChoiceDraft(key)).toBeUndefined()
    clearChoiceDraft(key) // 再清一次不抛错
  })

  it('空键：存 / 取 / 清都不抛错，也不产生任何条目（草稿能力降级，不影响应答）', () => {
    saveChoiceDraft('', draft)
    expect(getChoiceDraft('')).toBeUndefined()
    clearChoiceDraft('')
    // 再存一个正常键，确认前面的空键没有污染
    saveChoiceDraft(draftKey('s1', 'tc-1'), draft)
    expect(getChoiceDraft(draftKey('s1', 'tc-1'))).toEqual(draft)
  })
})
