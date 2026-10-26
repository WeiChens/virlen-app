// @vitest-environment node
/**
 * 闲置会话自动归档（设置 — 聊天 → 自动归档）。
 *
 * 重点不是「天数算没算对」，而是**三类跳过**：运行中 / 置顶 / 当前正在查看的 ——
 * 归档它们是会被用户感知成「凭空消失」的动作。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { Session } from '@/types'
import { DEFAULT_SESSION_PARAMS } from '@/types'
import { sessionStore } from '@/ui/store/sessionStore'
import { chatState, settingsState } from '@/ui/store'
import {
  dropSessionRuntime,
  updateSessionRuntime,
} from '@/ui/store/sessionRuntimeStore'
import {
  AUTO_ARCHIVE_DEFAULT_DAYS,
  AUTO_ARCHIVE_MAX_DAYS,
  AUTO_ARCHIVE_MIN_DAYS,
  resolveAutoArchiveDays,
  runAutoArchiveOnce,
} from '@/services/chat/auto-archive'

const DAY = 24 * 60 * 60 * 1000
/** 固定「现在」：阈值判定必须可重复，不能跟着真实时钟漂 */
const NOW = 1_800_000_000_000

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
    createdAt: NOW,
    updatedAt: NOW,
    pinned: false,
    // 真实库里 archived 总是有值（Rust 行映射给 bool），测试也补上，断言才能用 toBe(false)
    archived: false,
    tags: [],
    ...over,
  }
}

const created: string[] = []
function seed(over: Partial<Session> = {}): string {
  const id = `aa-${created.length}-${Math.random().toString(36).slice(2, 8)}`
  sessionStore.saveSession(makeSession(id, over))
  created.push(id)
  return id
}

/** 相对 NOW 的「n 天前更新」 */
const daysAgo = (n: number) => NOW - n * DAY

const settingsBackup = {
  enabled: settingsState.value.sessionAutoArchiveEnabled,
  days: settingsState.value.sessionAutoArchiveDays,
}

beforeEach(() => {
  chatState.setValue('currentSessionId', null)
  settingsState.setValue('sessionAutoArchiveEnabled', true)
  settingsState.setValue('sessionAutoArchiveDays', 30)
})

afterEach(() => {
  const ids = created.splice(0)
  dropSessionRuntime(ids)
  sessionStore.deleteSessions(ids)
  settingsState.setValue('sessionAutoArchiveEnabled', settingsBackup.enabled)
  settingsState.setValue('sessionAutoArchiveDays', settingsBackup.days)
  chatState.setValue('currentSessionId', null)
})

describe('resolveAutoArchiveDays（天数校正）', () => {
  it('越界夹到 1–3650，小数取整，非法回退默认 30', () => {
    expect(resolveAutoArchiveDays(0)).toBe(AUTO_ARCHIVE_MIN_DAYS)
    expect(resolveAutoArchiveDays(-5)).toBe(AUTO_ARCHIVE_MIN_DAYS)
    expect(resolveAutoArchiveDays(5.6)).toBe(6)
    expect(resolveAutoArchiveDays(99999)).toBe(AUTO_ARCHIVE_MAX_DAYS)
    expect(resolveAutoArchiveDays(Number.NaN)).toBe(AUTO_ARCHIVE_DEFAULT_DAYS)
    expect(resolveAutoArchiveDays(undefined)).toBe(AUTO_ARCHIVE_DEFAULT_DAYS)
    // 老库 / 手改 app_settings 可能塞字符串
    expect(resolveAutoArchiveDays('15')).toBe(15)
  })
})

describe('runAutoArchiveOnce（N 天无更新）', () => {
  it('超过阈值才归档；恰好满 N 天也算（“N 天内无更新”）', () => {
    const old = seed({ updatedAt: daysAgo(31) })
    const exact = seed({ updatedAt: daysAgo(30) })
    const fresh = seed({ updatedAt: daysAgo(29) })

    expect(runAutoArchiveOnce(NOW)).toBe(2)
    expect(sessionStore.getSession(old)?.archived).toBe(true)
    expect(sessionStore.getSession(exact)?.archived).toBe(true)
    expect(sessionStore.getSession(fresh)?.archived).toBe(false)
  })

  it('已归档的会话不重复计入（幂等）', () => {
    seed({ updatedAt: daysAgo(60), archived: true })
    expect(runAutoArchiveOnce(NOW)).toBe(0)
  })

  it('置顶豁免：置顶是用户明确的保留意图', () => {
    const pinned = seed({ updatedAt: daysAgo(60), pinned: true })
    expect(runAutoArchiveOnce(NOW)).toBe(0)
    expect(sessionStore.getSession(pinned)?.archived).toBe(false)
  })

  it('run 还活着的豁免（working / paused 都算）', () => {
    const working = seed({ updatedAt: daysAgo(60) })
    const paused = seed({ updatedAt: daysAgo(60) })
    updateSessionRuntime(working, { working: true })
    updateSessionRuntime(paused, { paused: true })

    expect(runAutoArchiveOnce(NOW)).toBe(0)
    expect(sessionStore.getSession(working)?.archived).toBe(false)
    expect(sessionStore.getSession(paused)?.archived).toBe(false)
  })

  it('当前正在查看的会话豁免（看着看着被归档会把视图踢回开始页）', () => {
    const current = seed({ updatedAt: daysAgo(60) })
    chatState.setValue('currentSessionId', current)
    expect(runAutoArchiveOnce(NOW)).toBe(0)
  })

  it('功能关闭 → 空操作', () => {
    settingsState.setValue('sessionAutoArchiveEnabled', false)
    seed({ updatedAt: daysAgo(60) })
    expect(runAutoArchiveOnce(NOW)).toBe(0)
  })

  it('读取用户设定的天数（7 天）', () => {
    settingsState.setValue('sessionAutoArchiveDays', 7)
    const eightDays = seed({ updatedAt: daysAgo(8) })
    const sixDays = seed({ updatedAt: daysAgo(6) })
    expect(runAutoArchiveOnce(NOW)).toBe(1)
    expect(sessionStore.getSession(eightDays)?.archived).toBe(true)
    expect(sessionStore.getSession(sixDays)?.archived).toBe(false)
  })

  it('归档只改标记：不刷 updatedAt（否则闲置天数会被后台动作自己重置）', () => {
    const id = seed({ updatedAt: daysAgo(60) })
    runAutoArchiveOnce(NOW)
    expect(sessionStore.getSession(id)?.archived).toBe(true)
    expect(sessionStore.getSession(id)?.updatedAt).toBe(daysAgo(60))
  })
})
