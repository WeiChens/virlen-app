/**
 * StormBreaker 测试 — 工具调用风暴防护
 *
 * 覆盖场景：
 * - 正常调用不超过阈值 → 不拦截
 * - 相同工具+参数重复达到阈值 → 拦截
 * - 不同参数不视为重复
 * - 调用历史清除后重新计数
 * - 跨会话隔离（不同 sessionId 互不影响）
 * - 清理所有历史
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  checkToolCallStorm,
  clearToolCallHistory,
  clearAllToolCallHistories,
} from '@/domain/engine/storm-breaker'

describe('StormBreaker', () => {
  beforeEach(() => {
    clearAllToolCallHistories()
  })

  it('应该允许低频工具调用（不触发风暴）', () => {
    const sessionId = 'session-1'

    const r1 = checkToolCallStorm(sessionId, 'read_file', { path: '/a.txt' })
    const r2 = checkToolCallStorm(sessionId, 'read_file', { path: '/b.txt' })
    const r3 = checkToolCallStorm(sessionId, 'write_file', { path: '/a.txt' })

    expect(r1).toBe(false)
    expect(r2).toBe(false)
    expect(r3).toBe(false)
  })

  it('相同工具+参数连续调用3次应触发风暴', () => {
    const sessionId = 'session-2'

    const r1 = checkToolCallStorm(sessionId, 'read_file', { path: '/a.txt' })
    const r2 = checkToolCallStorm(sessionId, 'read_file', { path: '/a.txt' })
    const r3 = checkToolCallStorm(sessionId, 'read_file', { path: '/a.txt' })

    expect(r1).toBe(false)
    expect(r2).toBe(false)
    expect(r3).toBe(true) // 第3次触发
  })

  it('前2次放行后混入其他调用再回原模式 → 窗口内累计达到3次应触发', () => {
    const sessionId = 'session-3'

    checkToolCallStorm(sessionId, 'read_file', { path: '/a.txt' }) // 1
    checkToolCallStorm(sessionId, 'read_file', { path: '/a.txt' }) // 2
    checkToolCallStorm(sessionId, 'write_file', { path: '/b.txt' }) // 不同工具
    const r4 = checkToolCallStorm(sessionId, 'read_file', { path: '/a.txt' })
    // 窗口最后4条: [a1, a2, w, a4] → read_file(/a.txt) 出现3次 → 触发
    expect(r4).toBe(true)
  })

  it('参数不同不应视为重复调用', () => {
    const sessionId = 'session-4'

    checkToolCallStorm(sessionId, 'search_files', { query: 'abc' })
    checkToolCallStorm(sessionId, 'search_files', { query: 'def' })
    checkToolCallStorm(sessionId, 'search_files', { query: 'ghi' })

    // 3次不同参数，每次签名不同，不触发
    const r4 = checkToolCallStorm(sessionId, 'search_files', { query: 'abc' })
    expect(r4).toBe(false)

    // 现在 abc 出现了2次（第1和第4），但还没到3次
    const r5 = checkToolCallStorm(sessionId, 'search_files', { query: 'abc' })
    expect(r5).toBe(true) // 第3次 abc
  })

  it('清除单会话历史后应重新计数', () => {
    const sessionId = 'session-5'

    checkToolCallStorm(sessionId, 'read_file', { path: '/a.txt' })
    checkToolCallStorm(sessionId, 'read_file', { path: '/a.txt' })

    clearToolCallHistory(sessionId)

    const r1 = checkToolCallStorm(sessionId, 'read_file', { path: '/a.txt' })
    expect(r1).toBe(false) // 清除后重新计数，第1次不触发
  })

  it('不同会话间的调用历史互不影响', () => {
    clearToolCallHistory('session-a')
    clearToolCallHistory('session-b')

    // session-a 触发风暴
    checkToolCallStorm('session-a', 'tool_x', {})
    checkToolCallStorm('session-a', 'tool_x', {})
    const a3 = checkToolCallStorm('session-a', 'tool_x', {})
    expect(a3).toBe(true)

    // session-b 才1次，不触发
    const b1 = checkToolCallStorm('session-b', 'tool_x', {})
    expect(b1).toBe(false)
  })

  it('滑动窗口只保留最近6条记录', () => {
    const sessionId = 'session-6'

    // 连续6次不同调用
    for (let i = 0; i < 6; i++) {
      checkToolCallStorm(sessionId, 'tool', { n: i })
    }

    // 再来3次相同调用 — 但窗口里只有1次 n=0（被挤出去了）
    // 实际上窗口里最后6个是 n=1..5 和 n=6
    const r1 = checkToolCallStorm(sessionId, 'tool', { n: 0 })
    expect(r1).toBe(false) // n=0 不在窗口中

    // 连续3次 n=999 会触发
    checkToolCallStorm(sessionId, 'tool', { n: 999 })
    checkToolCallStorm(sessionId, 'tool', { n: 999 })
    const r4 = checkToolCallStorm(sessionId, 'tool', { n: 999 })
    expect(r4).toBe(true)
  })

  it('clearAllToolCallHistories 应清空所有会话历史', () => {
    checkToolCallStorm('s1', 'tool', {})
    checkToolCallStorm('s2', 'tool', {})

    clearAllToolCallHistories()

    // 两个会话都从0开始计数
    expect(checkToolCallStorm('s1', 'tool', {})).toBe(false)
    expect(checkToolCallStorm('s2', 'tool', {})).toBe(false)
  })
})
