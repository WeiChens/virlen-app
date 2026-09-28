/**
 * 通讯类型判定（P2P 直连 / TURN 中继）—— 纯逻辑用例。
 *
 * 为什么值得单测：设置页那枚胶囊是用户判断「手机操作为什么这么卡」的唯一依据，
 * **判错比不显示更糟**（把中继说成直连，用户就会一直找错方向）。而真实 WebRTC 跑不进 CI，
 * 所以把口径钉在「喂 stats 数组」这一层：只看**所选候选对**的两端类型。
 *
 * 钉住的四件事：
 *  1. 任一端 `relay` → 中继（字节确实过了 TURN）；
 *  2. `host` / `srflx` / `prflx` → 直连（同网段或 NAT 打洞成功，都不过服务器）；
 *  3. 没有 `transport` 记录时退回 `nominated + succeeded` 的候选对（老实现）；
 *  4. **拿不到结论就是 `unknown`**：候选对没定型、stats 为空、`getStats()` 抛错 —— 一律不猜。
 *
 * 下半部分钉 `LinkKindWatcher`：**类型会变**（刚打通时先成的是中继，直连候选对胜出后换成直连；
 * 变网后又可能退回去），而 ICE 状态不一定会跟着变 —— 所以巡检必须跟得上，且不能在读不到值时乱闪。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LinkKindWatcher, classifyLinkKind, probeLinkKind } from '@/bridge'

/** 一条 `transport` 记录（`selectedCandidatePairId` 是判定的第一优先来源）。 */
function transportStat(pairId?: string) {
  return pairId
    ? { id: 'T01', type: 'transport', selectedCandidatePairId: pairId }
    : { id: 'T01', type: 'transport' }
}

/** 一份标准形状的 stats：一条候选对 + 两端候选。 */
function statsOf(
  localType: string,
  remoteType: string,
  pair: Record<string, unknown> = {},
  pairId = 'CP1',
) {
  return [
    transportStat(pairId),
    {
      id: 'CP1',
      type: 'candidate-pair',
      state: 'succeeded',
      nominated: true,
      localCandidateId: 'L-1',
      remoteCandidateId: 'R-1',
      ...pair,
    },
    { id: 'L-1', type: 'local-candidate', candidateType: localType },
    { id: 'R-1', type: 'remote-candidate', candidateType: remoteType },
  ]
}

describe('classifyLinkKind —— 所选候选对决定「直连 / 中继」', () => {
  it('本机候选（host）→ 直连：同网段直连，字节不经服务器', () => {
    expect(classifyLinkKind(statsOf('host', 'host'))).toBe('direct')
  })

  it('服务器反射（srflx / prflx）→ 仍是直连：NAT 打洞成功不算中继', () => {
    expect(classifyLinkKind(statsOf('srflx', 'srflx'))).toBe('direct')
    expect(classifyLinkKind(statsOf('prflx', 'host'))).toBe('direct')
    expect(classifyLinkKind(statsOf('host', 'prflx'))).toBe('direct')
  })

  it('任一端是 relay（TURN）→ 中继：字节确实过了服务器', () => {
    expect(classifyLinkKind(statsOf('relay', 'host'))).toBe('relay')
    expect(classifyLinkKind(statsOf('host', 'relay'))).toBe('relay')
    expect(classifyLinkKind(statsOf('relay', 'relay'))).toBe('relay')
  })
})

describe('classifyLinkKind —— 拿不到结论时一律 unknown（不猜）', () => {
  it('没有 transport 记录 → 退回 nominated + succeeded 的候选对', () => {
    const stats = statsOf('srflx', 'srflx').filter((s) => s.type !== 'transport')
    expect(classifyLinkKind(stats)).toBe('direct')
  })

  it('没有 nominated 标记时，取第一条 succeeded 的候选对', () => {
    const stats = [
      {
        id: 'CP1',
        type: 'candidate-pair',
        state: 'succeeded',
        localCandidateId: 'L-1',
        remoteCandidateId: 'R-1',
      },
      { id: 'L-1', type: 'local-candidate', candidateType: 'relay' },
      { id: 'R-1', type: 'remote-candidate', candidateType: 'host' },
    ]
    expect(classifyLinkKind(stats)).toBe('relay')
  })

  it('transport 指向的候选对还没定型（in-progress）→ unknown', () => {
    expect(classifyLinkKind(statsOf('host', 'host', { state: 'in-progress' }))).toBe('unknown')
  })

  it('只有失败的候选对 → unknown', () => {
    expect(classifyLinkKind(statsOf('host', 'host', { state: 'failed' }))).toBe('unknown')
  })

  it('stats 为空 / 只有候选没有候选对 → unknown', () => {
    expect(classifyLinkKind([])).toBe('unknown')
    expect(classifyLinkKind([{ id: 'L-1', type: 'local-candidate', candidateType: 'host' }])).toBe(
      'unknown',
    )
  })

  it('候选记录缺失（只给了 id）→ unknown，而不是当成直连', () => {
    const stats = [
      transportStat('CP1'),
      {
        id: 'CP1',
        type: 'candidate-pair',
        state: 'succeeded',
        localCandidateId: 'L-1',
        remoteCandidateId: 'R-1',
      },
    ]
    expect(classifyLinkKind(stats)).toBe('unknown')
  })

  it('老实现的 `localcandidate` / `remotecandidate` 类型名也认（认不出会白丢一次判定）', () => {
    const stats = [
      transportStat('CP1'),
      {
        id: 'CP1',
        type: 'candidate-pair',
        state: 'succeeded',
        localCandidateId: 'L-1',
        remoteCandidateId: 'R-1',
      },
      { id: 'L-1', type: 'localcandidate', candidateType: 'srflx' },
      { id: 'R-1', type: 'remotecandidate', candidateType: 'srflx' },
    ]
    expect(classifyLinkKind(stats)).toBe('direct')
  })
})

describe('probeLinkKind —— 从 getStats() 的报告里取样', () => {
  it('把 `RTCStatsReport`（Map 形状）摊开交给分类器', async () => {
    const entries = statsOf('srflx', 'host')
    const report = {
      forEach(cb: (entry: unknown) => void) {
        for (const e of entries) cb(e)
      },
    }
    expect(await probeLinkKind({ getStats: async () => report })).toBe('direct')
  })

  it('getStats() 抛错 → 原样抛给调用方（由它决定重试，而不是悄悄算成直连）', async () => {
    const pc = {
      getStats: async () => {
        throw new Error('boom')
      },
    }
    await expect(probeLinkKind(pc)).rejects.toThrow('boom')
  })
})

/** 可切换的假 PC：`set()` 之后 `getStats()` 就返回新的那份 stats。 */
function fakePc(initial: Array<Record<string, unknown>>) {
  let current = initial
  let calls = 0
  return {
    set(next: Array<Record<string, unknown>>) {
      current = next
    },
    get calls() {
      return calls
    },
    async getStats() {
      calls += 1
      return {
        forEach(cb: (entry: unknown) => void) {
          for (const entry of current) cb(entry)
        },
      }
    },
  }
}

describe('LinkKindWatcher —— 链路开着期间要跟得上变化', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('先中继（打洞还没探完）→ 直连候选对胜出 → 会跟着报（就是「刚才是 TURN、打通后是 P2P」）', async () => {
    vi.useFakeTimers()
    const pc = fakePc(statsOf('relay', 'host'))
    const seen: string[] = []
    const watcher = new LinkKindWatcher((kind) => seen.push(kind), 1000)

    watcher.watch(pc)
    await vi.advanceTimersByTimeAsync(10) // watch 内的「立刻先问一次」
    expect(seen).toEqual(['relay'])

    // 直连候选对胜出（ICE 重新提名）—— 注意：这一步**不一定**伴随 ICE 状态变化
    pc.set(statsOf('srflx', 'srflx'))
    await vi.advanceTimersByTimeAsync(1000)

    expect(seen).toEqual(['relay', 'direct'])
    expect(watcher.kind).toBe('direct')

    watcher.stop()
  })

  it('巡检期间恰好读不到结论 → 保留上次（不在直连/中继之间闪）', async () => {
    vi.useFakeTimers()
    const pc = fakePc(statsOf('host', 'host'))
    const seen: string[] = []
    const watcher = new LinkKindWatcher((kind) => seen.push(kind), 1000)

    watcher.watch(pc)
    await vi.advanceTimersByTimeAsync(10)
    expect(seen).toEqual(['direct'])

    pc.set([]) // 正在重协商 / stats 没填好
    await vi.advanceTimersByTimeAsync(3000)

    expect(seen).toEqual(['direct'])
    expect(watcher.kind).toBe('direct')

    watcher.stop()
  })

  it('stop()：巡检停、结论归零并广播（UI 据此收起胶囊）', async () => {
    vi.useFakeTimers()
    const pc = fakePc(statsOf('relay', 'relay'))
    const seen: string[] = []
    const watcher = new LinkKindWatcher((kind) => seen.push(kind), 1000)

    watcher.watch(pc)
    await vi.advanceTimersByTimeAsync(10)
    watcher.stop()

    expect(seen).toEqual(['relay', 'unknown'])
    expect(watcher.kind).toBe('unknown')

    // 停了就不再问：即便链路又变成中继，也不该再上报
    pc.set(statsOf('relay', 'relay'))
    await vi.advanceTimersByTimeAsync(5000)
    expect(seen).toEqual(['relay', 'unknown'])
    expect(pc.calls).toBe(1)
  })

  it('换链路（watch 新 PC）会先作废旧结论：不残留上一条链路的类型', async () => {
    vi.useFakeTimers()
    const first = fakePc(statsOf('relay', 'host'))
    const second = fakePc(statsOf('srflx', 'host'))
    const seen: string[] = []
    const watcher = new LinkKindWatcher((kind) => seen.push(kind), 1000)

    watcher.watch(first)
    await vi.advanceTimersByTimeAsync(10)
    watcher.watch(second)
    await vi.advanceTimersByTimeAsync(10)

    expect(seen).toEqual(['relay', 'unknown', 'direct'])
    watcher.stop()
  })

  it('getStats() 抛错 → 不算结论、不广播（宁可没有，也不猜）', async () => {
    vi.useFakeTimers()
    const seen: string[] = []
    const watcher = new LinkKindWatcher((kind) => seen.push(kind), 1000)
    const broken = {
      async getStats(): Promise<never> {
        throw new Error('boom')
      },
    }

    watcher.watch(broken)
    await vi.advanceTimersByTimeAsync(3000)
    watcher.stop()

    expect(seen).toEqual([])
  })

  it('链路还开着时不会重复上报同一个结论（去重）', async () => {
    vi.useFakeTimers()
    const pc = fakePc(statsOf('host', 'host'))
    const seen: string[] = []
    const watcher = new LinkKindWatcher((kind) => seen.push(kind), 1000)

    watcher.watch(pc)
    await vi.advanceTimersByTimeAsync(5000) // 跑满 5 个巡检周期

    expect(pc.calls).toBeGreaterThan(3)
    expect(seen).toEqual(['direct'])
    expect(watcher.kind).toBe('direct')

    watcher.stop()
  })
})
