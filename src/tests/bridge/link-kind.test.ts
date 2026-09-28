/**
 * 电脑端链路类型判定 —— **再导出守卫**。
 *
 * 判定逻辑与其**完整**单测已在共享包：
 *   - 实现：`virlen-remote/src/transport/link-kind.ts`
 *   - 用例：`virlen-remote/tests/link-kind.test.ts`
 * 本文件不再重复那套用例（重复口径正是我们要消灭的东西），只钉住一件**电脑端特有**的事：
 * `@/bridge` 导出的必须是共享包**同一份实现**（引用相等）—— 防止哪天有人又把逻辑抄回本地。
 */
import { describe, expect, it } from 'vitest'
import * as bridge from '@/bridge'
import {
  classifyLinkKind as sharedClassify,
  probeLinkKind as sharedProbe,
  LinkKindWatcher as SharedWatcher,
} from 'virlen-remote'

/** 一份标准形状的 stats：一条候选对 + 两端候选。 */
function statsOf(localType: string, remoteType: string) {
  return [
    { id: 'T01', type: 'transport', selectedCandidatePairId: 'CP1' },
    {
      id: 'CP1',
      type: 'candidate-pair',
      state: 'succeeded',
      nominated: true,
      localCandidateId: 'L-1',
      remoteCandidateId: 'R-1',
    },
    { id: 'L-1', type: 'local-candidate', candidateType: localType },
    { id: 'R-1', type: 'remote-candidate', candidateType: remoteType },
  ]
}

describe('@/bridge 的链路类型判定 —— 必须是共享包实现', () => {
  it('classifyLinkKind / probeLinkKind / LinkKindWatcher 与共享包引用相等', () => {
    expect(bridge.classifyLinkKind).toBe(sharedClassify)
    expect(bridge.probeLinkKind).toBe(sharedProbe)
    expect(bridge.LinkKindWatcher).toBe(SharedWatcher)
  })

  it('口径仍与共享包一致（冒烟：中继 / 直连 / 拿不到结论）', () => {
    expect(bridge.classifyLinkKind(statsOf('relay', 'host'))).toBe('relay')
    expect(bridge.classifyLinkKind(statsOf('host', 'srflx'))).toBe('direct')
    expect(bridge.classifyLinkKind([])).toBe('unknown')
  })
})
