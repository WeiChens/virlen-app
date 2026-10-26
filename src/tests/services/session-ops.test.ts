// @vitest-environment node
/**
 * 会话写操作用例（手机控制 M4）
 *
 * 覆盖 `renameSession` / `setSessionPinned` / `setSessionArchived` —— 这些是**接口层（手机）与桌面侧栏共用的用例入口**。
 * 为什么要有用例层（而不是让 bridge 直接调 store 裸 action）：校验规则（空标题、超长标题、目标态幂等）
 * 只能有一份；两端各写一份必然漂移（见 docs/phone-control-bridge.md §3/§16.1）。
 */
import { describe, it, expect, afterEach } from 'vitest'
import type { Session } from '@/types'
import { DEFAULT_SESSION_PARAMS } from '@/types'
import { sessionStore } from '@/ui/store/sessionStore'
import {
  dropSessionRuntime,
  updateSessionRuntime,
} from '@/ui/store/sessionRuntimeStore'
import { renameSession, setSessionPinned, setSessionArchived, setSessionsArchived, countArchiveBlockedSessions, MAX_SESSION_TITLE_LEN } from '@/services/chat-service'

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
  const ids = created.splice(0)
  // 运行时状态不随 deleteSessions 清（那张表只负责会话元数据），漏了会污染下一条用例
  dropSessionRuntime(ids)
  sessionStore.deleteSessions(ids)
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

describe('setSessionArchived（目标态语义）', () => {
  it('归档 / 取消归档：只改标记，不刷 updatedAt（会话时间只由用户发言刷新）', () => {
    const id = seed({ archived: false })
    const before = sessionStore.getSession(id)?.updatedAt
    expect(setSessionArchived(id, true)).toBe(true)
    expect(sessionStore.getSession(id)?.archived).toBe(true)
    expect(sessionStore.getSession(id)?.updatedAt).toBe(before)
    expect(setSessionArchived(id, false)).toBe(true)
    expect(sessionStore.getSession(id)?.archived).toBe(false)
  })

  it('幂等：重复归档不改任何字段；会话不存在 → false', () => {
    const id = seed({ archived: true })
    expect(setSessionArchived(id, true)).toBe(true)
    expect(sessionStore.getSession(id)?.archived).toBe(true)
    expect(setSessionArchived('no-such-session', true)).toBe(false)
  })

  it('批量（分组「全部归档」）：只改目标态不一致的，返回实际改动数', () => {
    const a = seed({ archived: false })
    const b = seed({ archived: true })
    expect(setSessionsArchived([a, b], true)).toBe(1)
    expect(sessionStore.getSession(a)?.archived).toBe(true)
    expect(setSessionsArchived([a, b], false)).toBe(2)
    expect(setSessionsArchived([], true)).toBe(0)
  })

  it('列表排序：归档的沉到最后 —— 即使它置顶、也更新', () => {
    const archived = seed({ archived: true, pinned: true, updatedAt: Date.now() + 60_000 })
    const active = seed({ archived: false, pinned: false, updatedAt: Date.now() - 60_000 })
    const ids = sessionStore.listSessions().map((s) => s.id)
    expect(ids.indexOf(archived)).toBeGreaterThan(ids.indexOf(active))
  })

  it('归档后只允许取消归档与删除：重命名 / 置顶一律被拒', () => {
    const id = seed({ archived: true, title: '归档中', pinned: true })
    // 被拒的两条：改标题、置顶（取消置顶也算写操作，一并不允许）
    expect(renameSession(id, '想改名')).toBe(false)
    expect(sessionStore.getSession(id)?.title).toBe('归档中')
    expect(setSessionPinned(id, false)).toBe(false)
    expect(sessionStore.getSession(id)?.pinned).toBe(true)

    // 允许的两条：取消归档、删除；取消归档后其它操作自然恢复
    expect(setSessionArchived(id, false)).toBe(true)
    expect(renameSession(id, '取消归档后可以改名')).toBe(true)
    expect(sessionStore.getSession(id)?.title).toBe('取消归档后可以改名')
    expect(sessionStore.deleteSession(id)).toBe(true)
  })
})

describe('归档闸门：有 run 在跑时禁止归档', () => {
  const idle = { working: false, preparing: false, paused: false }

  it('working / preparing / paused 一律拒绝归档，标记不变', () => {
    const id = seed({ archived: false })
    for (const patch of [{ working: true }, { preparing: true }, { paused: true }]) {
      updateSessionRuntime(id, patch)
      expect(setSessionArchived(id, true)).toBe(false)
      expect(sessionStore.getSession(id)?.archived).toBe(false)
      updateSessionRuntime(id, idle)
    }
  })

  it('取消归档不受限制 —— 恢复动作永远允许（哪怕 run 还在跑）', () => {
    const id = seed({ archived: true })
    updateSessionRuntime(id, { working: true })
    expect(setSessionArchived(id, false)).toBe(true)
    expect(sessionStore.getSession(id)?.archived).toBe(false)
  })

  it('批量归档跳过运行中的：其余照常写入，阻塞计数与实际跳过一致', () => {
    const busy = seed({ archived: false })
    const active = seed({ archived: false })
    updateSessionRuntime(busy, { working: true })
    expect(countArchiveBlockedSessions([busy, active])).toBe(1)
    expect(setSessionsArchived([busy, active], true)).toBe(1)
    expect(sessionStore.getSession(busy)?.archived).toBe(false)
    expect(sessionStore.getSession(active)?.archived).toBe(true)
  })

  it('会话不存在不计入阻塞（否则提示条数会凭空多一条）', () => {
    expect(countArchiveBlockedSessions(['no-such-session'])).toBe(0)
  })
})
