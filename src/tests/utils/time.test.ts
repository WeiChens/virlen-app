// @vitest-environment node
/**
 * `formatCommitTime` —— 提交记录的时间展示（提交列表口径，用户定的 2026-10）。
 *
 * ⚠️ 时间戳一律用**本地**构造（`new Date(2026, 9, 16, 10, 30)`）再 `toISOString()`：这样用例
 * 在什么时区跑都是同一组断言（拿固定的 ISO 串去比会在别的时区上飘）。
 * `now` 是**显式参数**（不是 `Date.now()`）—— 相对时间的用例不能依赖 wall clock，否则明天就红。
 *
 * 文案形态与既有 `$__n__分钟前` 一族一致：**数字与单位之间没有空格**（「30分钟前」「4天前」）。
 */
import { describe, expect, it } from 'vitest'
import { formatCommitTime } from '@/utils/time'

/** 本地时间 → 该时刻的 ISO 串（带本机时区偏移，正是 `%aI` 的形态） */
function iso(y: number, m: number, d: number, h = 0, min = 0): string {
  return new Date(y, m - 1, d, h, min).toISOString()
}

/** 固定「现在」：2026-10-16 10:30 本地 */
const NOW = new Date(2026, 9, 16, 10, 30)

/** 某本地时刻相对 NOW 的展示文案 */
const at = (y: number, m: number, d: number, h = 0, min = 0): string =>
  formatCommitTime(iso(y, m, d, h, min), NOW)

describe('提交记录的时间展示', () => {
  it('一分钟内 = 刚刚；一小时内给分钟（向下取整）', () => {
    expect(at(2026, 10, 16, 10, 30)).toBe('刚刚')
    expect(at(2026, 10, 16, 10, 29)).toBe('1分钟前')
    expect(at(2026, 10, 16, 10, 1)).toBe('29分钟前')
    expect(at(2026, 10, 16, 9, 31)).toBe('59分钟前')
  })

  it('同一**日历日**走小时（小时粒度比「0天前」有意义，也不会抢在「昨天」前面）', () => {
    expect(at(2026, 10, 16, 9, 30)).toBe('1小时前')
    expect(at(2026, 10, 16, 7, 30)).toBe('3小时前')
    // 当天 0 点（10.5 小时前）仍然是「小时」，不是「昨天」—— 昨天按日历日算
    expect(at(2026, 10, 16, 0, 0)).toBe('10小时前')
  })

  it('昨天（日历日差 1）：哪怕只过去十几个小时（15 日 23:59 → 16 日 10:30）也算昨天', () => {
    expect(at(2026, 10, 15, 23, 59)).toBe('昨天')
    expect(at(2026, 10, 15, 10, 30)).toBe('昨天')
    expect(at(2026, 10, 15, 0, 0)).toBe('昨天')
  })

  it('2–6 天给「N天前」；满一周（第 7 天）起给完整时间', () => {
    expect(at(2026, 10, 14, 10, 30)).toBe('2天前')
    expect(at(2026, 10, 12, 10, 30)).toBe('4天前')
    expect(at(2026, 10, 10, 10, 30)).toBe('6天前')
    // 第 7 天起 = 超过一周 → 绝对时间（前导零齐，便于与相对文案同宽对齐）
    expect(at(2026, 10, 9, 0, 53)).toBe('2026-10-09 00:53')
    expect(at(2026, 10, 9, 10, 30)).toBe('2026-10-09 10:30')
    expect(at(2025, 1, 2, 3, 4)).toBe('2025-01-02 03:04')
  })

  it('解析不出来 → 空串（调用方退回原文，不编造时间）；未来时间 → 直接给绝对时间', () => {
    expect(formatCommitTime('', NOW)).toBe('')
    expect(formatCommitTime('not-a-date', NOW)).toBe('')
    // 未来：相对时间会算成「-3小时前」，读不通 —— 如实给绝对时间
    expect(formatCommitTime(iso(2026, 10, 16, 13, 30), NOW)).toBe(
      '2026-10-16 13:30',
    )
    expect(formatCommitTime(iso(2027, 1, 1, 0, 0), NOW)).toBe('2027-01-01 00:00')
  })
})
