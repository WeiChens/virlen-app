/**
 * sessionRepo.saveDiff — 会话元数据「按差异回写」回归测试
 *
 * 回归背景（virlen-telemetry-20260916-203756）：
 * 早期 saveDiff 的条件是 `!old || old.updatedAt !== session.updatedAt || old !== session`。
 * oldSessions 来自 sessionStore.persist() 的浅拷贝快照（`map(s => ({ ...s }))`），
 * 与 store 里的活对象永远不是同一引用 → `old !== session` **恒为 true** →
 * 每次 persist() 都把全部会话回写一遍：实测 152 个会话、306/358 条 rust.db.op
 * （85.5%）、88.7% 的 SQLite 耗时，都来自「改 1 个标题写了 152 个会话」。
 *
 * 现在改为按 Rust 端实际落库的列做值比较（签名），只有真正变化的会话才写。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { sessionRepo } from '@/infrastructure/sessionRepo'
import type { Session, SessionParams } from '@/types'

const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>

function makeSession(id: string, over: Partial<Session> = {}): Session {
  return {
    id,
    title: `t-${id}`,
    messages: [],
    providerConfigId: 'p1',
    modelId: 'm1',
    systemPrompt: 'sp',
    params: { temperature: 0.7, topP: 1, maxTokens: 1024, stream: true },
    createdAt: 1,
    updatedAt: 1,
    pinned: false,
    tags: [],
    ...over,
  }
}

/** 与 sessionStore.persist() 的基线语义一致：浅拷贝快照 */
const snapshot = (list: Session[]) => list.map((s) => ({ ...s }))

/** 推进防抖（saveDiff 内置 800ms）并等异步调用结算 */
const flushDebounce = () => vi.advanceTimersByTimeAsync(900)

describe('sessionRepo.saveDiff', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    invokeMock.mockResolvedValue(undefined)
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('没有任何会话变化 → 一条写请求都不发', async () => {
    const a = makeSession('a')
    const b = makeSession('b')
    sessionRepo.saveDiff(snapshot([a, b]), [a, b])
    await flushDebounce()
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('只有一个会话的标题变化 → 只回写该会话（回归核心）', async () => {
    const a = makeSession('a')
    const b = makeSession('b')
    const c = makeSession('c')
    const baseline = snapshot([a, b, c])
    // 模拟 updateSession：整对象替换 + updatedAt 变化
    const changed = { ...b, title: 'AI 起的标题', updatedAt: 2 }

    sessionRepo.saveDiff(baseline, [a, changed, c])
    await flushDebounce()

    expect(invokeMock).toHaveBeenCalledTimes(1)
    expect(invokeMock.mock.calls[0][0]).toBe('cmd_upsert_session')
    expect(invokeMock.mock.calls[0][1].session.id).toBe('b')
  })

  it('params 键序不同但内容相同 → 不算变化', async () => {
    const a = makeSession('a')
    const baseline = snapshot([a])
    const reordered: SessionParams = {
      stream: true,
      maxTokens: 1024,
      topP: 1,
      temperature: 0.7,
    }

    sessionRepo.saveDiff(baseline, [{ ...a, params: reordered }])
    await flushDebounce()

    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('原地修改活对象（updatedAt 变化）→ 能被检测到', async () => {
    const a = makeSession('a')
    const baseline = snapshot([a])

    a.updatedAt = Date.now()

    sessionRepo.saveDiff(baseline, [a])
    await flushDebounce()

    expect(invokeMock).toHaveBeenCalledTimes(1)
    expect(invokeMock.mock.calls[0][1].session.id).toBe('a')
  })

  it('新增会话 → 回写一次', async () => {
    const a = makeSession('a')
    const fresh = makeSession('fresh')

    sessionRepo.saveDiff(snapshot([a]), [a, fresh])
    await flushDebounce()

    expect(invokeMock).toHaveBeenCalledTimes(1)
    expect(invokeMock.mock.calls[0][0]).toBe('cmd_upsert_session')
    expect(invokeMock.mock.calls[0][1].session.id).toBe('fresh')
  })

  it('被删除的会话 → 走 cmd_delete_session，其它会话不回写', async () => {
    const a = makeSession('a')
    const b = makeSession('b')

    sessionRepo.saveDiff(snapshot([a, b]), [a])
    await flushDebounce()

    expect(invokeMock).toHaveBeenCalledTimes(1)
    expect(invokeMock.mock.calls[0][0]).toBe('cmd_delete_session')
    expect(invokeMock.mock.calls[0][1].sessionId).toBe('b')
  })

  it('清空列表（saveDiff(old, [])）→ 全部走删除', async () => {
    const a = makeSession('a')
    const b = makeSession('b')

    sessionRepo.saveDiff(snapshot([a, b]), [])
    await flushDebounce()

    expect(invokeMock).toHaveBeenCalledTimes(2)
    expect(invokeMock.mock.calls.map((c) => c[0]).sort()).toEqual([
      'cmd_delete_session',
      'cmd_delete_session',
    ])
  })

  it('删除后防抖窗口内又有变更 → 删除不被吞掉（回归）', async () => {
    // 回归：旧实现把差集计算放在 debounce 回调里，而 debounce 只保留最后一次调用的
    // 实参 —— 删除后 800ms 内再来一次 persist（发消息 / 改标题 / AI 起标题完成…），
    // 这次删除就永久丢失（sessionStore 已同步前移基线，不会补发），
    // 会话连同消息在下次启动「复活」。
    const a = makeSession('a')
    const b = makeSession('b')
    const c = makeSession('c')

    sessionRepo.saveDiff(snapshot([a, b]), [a]) // 删除 b
    sessionRepo.saveDiff(snapshot([a]), [a, c]) // 窗口内新增 c
    await flushDebounce()

    const calls = invokeMock.mock.calls.map((call) => call[0])
    expect(calls).toContain('cmd_delete_session')
    expect(calls).toContain('cmd_upsert_session')
    const deleted = invokeMock.mock.calls
      .filter((call) => call[0] === 'cmd_delete_session')
      .map((call) => call[1].sessionId)
    expect(deleted).toEqual(['b'])
  })

  it('deleteSessions → 立即发送删除，不等防抖', async () => {
    await sessionRepo.deleteSessions(['x', 'y'])

    // 未推进定时器（800ms 未到）就已发出
    expect(invokeMock).toHaveBeenCalledTimes(2)
    expect(invokeMock.mock.calls.map((call) => call[0])).toEqual([
      'cmd_delete_session',
      'cmd_delete_session',
    ])
    expect(invokeMock.mock.calls.map((call) => call[1].sessionId)).toEqual([
      'x',
      'y',
    ])
  })
})

describe('sessionRepo 库维护（设置 → 存储）', () => {
  beforeEach(() => {
    invokeMock.mockReset()
  })

  function makeStats(dbBytes: number, walBytes: number) {
    return {
      dbBytes,
      walBytes,
      shmBytes: 32768,
      pageBytes: 4096,
      pageSize: 4096,
      pageCount: 1,
      freelistPages: 0,
      autoVacuum: 2,
      journalSizeLimit: 16777216,
      sessionCount: 3,
      messageCount: 9,
    }
  }

  it('dbStats 透传 Rust 侧体积快照', async () => {
    const stats = makeStats(1024, 2048)
    invokeMock.mockResolvedValueOnce(stats)

    await expect(sessionRepo.dbStats()).resolves.toEqual(stats)
    expect(invokeMock.mock.calls[0][0]).toBe('cmd_db_stats')
  })

  it('dbMaintain 返回 before/after（UI 靠二者之差算回收量）', async () => {
    invokeMock.mockResolvedValueOnce({
      checkpoint: { busy: false, beforeBytes: 4096, afterBytes: 0 },
      vacuumMs: 12,
      before: makeStats(4000, 4096),
      after: makeStats(600, 0),
    })

    const result = await sessionRepo.dbMaintain()

    expect(invokeMock.mock.calls[0][0]).toBe('cmd_db_maintain')
    expect(result?.vacuumMs).toBe(12)
    // 回收量 = 前后总占用之差（主库 + WAL）
    expect(result!.before.dbBytes + result!.before.walBytes).toBe(8096)
    expect(result!.after.dbBytes + result!.after.walBytes).toBe(600)
  })

  it('非 Tauri 环境 / 命令失败 → 返回 null，绝不把异常抛给 UI', async () => {
    invokeMock.mockRejectedValue(new Error('no tauri'))

    await expect(sessionRepo.dbStats()).resolves.toBeNull()
    await expect(sessionRepo.dbCheckpoint()).resolves.toBeNull()
    await expect(sessionRepo.dbMaintain()).resolves.toBeNull()
  })
})
