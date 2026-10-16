import { t, tpl } from '@/ui/i18n'

/** 格式化耗时（如 850ms / 5.2s / 1m 05s），用于展示思考/工具执行耗时 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return `${m}m ${s}s`
}

export const timeFormat = (time: number) => {
  const nowDate = new Date()
  const now = nowDate.getTime()
  const date = new Date(time)
  const diff = now - time

  if (diff < 60 * 1000) {
    return t('刚刚')
  }
  if (diff < 60 * 60 * 1000) {
    return tpl('$__n__分钟前', { n: Math.floor(diff / (60 * 1000)) })
  }
  if (diff < 12 * 60 * 60 * 1000) {
    return tpl('$__n__小时前', { n: Math.floor(diff / (60 * 60 * 1000)) })
  }
  if (date.toDateString() === nowDate.toDateString()) {
    return tpl('$__n__小时前', { n: Math.floor(diff / (60 * 60 * 1000)) })
  }
  // 昨天
  if (
    date.getFullYear() === nowDate.getFullYear() &&
    date.getMonth() === nowDate.getMonth() &&
    date.getDate() === nowDate.getDate() - 1
  ) {
    return `${t('昨天')} ${date.getHours()}:${date.getMinutes().toString().padStart(2, '0')}`
  }
  if (date.getFullYear() === nowDate.getFullYear()) {
    return `${date.getMonth() + 1}/${date.getDate()} ${date.getHours()}:${date.getMinutes().toString().padStart(2, '0')}`
  }
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** 本地 `YYYY-MM-DD HH:mm`（等宽：前导零齐，列表里好对齐） */
function absoluteMinute(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(
    d.getHours(),
  )}:${pad2(d.getMinutes())}`
}

/** 两个时间点相差几个**本地日历日**（用本地 0 点算，`Math.round` 兼顾夏令时少/多一小时的那天） */
function calendarDayDiff(now: Date, then: Date): number {
  const day = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  return Math.round((day(now) - day(then)) / 86400000)
}

/**
 * 提交记录的时间展示：`%aI` → **相对时间**，超过一周才给完整时间（口径由用户定，2026-10）。
 *
 * 时间轴：`刚刚` → `N 分钟前` → `N 小时前`（**同一天**一律走小时，所以「昨天」不会提前出现）
 * → `昨天` → `N 天前`（2–6 天）→ `YYYY-MM-DD HH:mm`（≥ 7 天）。
 *
 * ⚠️ 与上面的 `timeFormat` 是**两条口径**（不是重复实现）：`timeFormat` 服务消息气泡 / 搜索结果的
 * 「发送时间」（天级显示 `10/9 14:20`、昨天带时分），本函数服务提交列表（天级显示 `N 天前`、
 * 超过一周给带前导零的完整时间）。两者都不许在别处再写第三份 —— 要统一时就在这里改。
 *
 * - `%aI` 带的是**作者当时**的时区偏移，这里一律换成**本地**时间再比（用户看的是自己的日历）；
 * - 解析不出来（空串 / 异常值）→ 回**空串**，调用方退回原文（**不编造时间**）；
 * - 作者时间在未来（rebase / 本机时钟偏）→ 直接给绝对时间，不显示「-3 小时前」这种东西。
 */
export function formatCommitTime(iso: string, now: Date = new Date()): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const diff = now.getTime() - date.getTime()
  // 未来时间：相对时间会得到「负数小时前」这种读不通的东西，如实给绝对时间
  if (diff < 0) return absoluteMinute(date)
  if (diff < 60 * 1000) return t('刚刚')
  if (diff < 60 * 60 * 1000) {
    return tpl('$__n__分钟前', { n: Math.floor(diff / (60 * 1000)) })
  }
  const days = calendarDayDiff(now, date)
  // 同一天用小时：小时粒度比「0 天前」有意义，也不会抢在「昨天」前面（后者按日历日算）
  if (days <= 0) {
    return tpl('$__n__小时前', { n: Math.floor(diff / (60 * 60 * 1000)) })
  }
  if (days === 1) return t('昨天')
  if (days < 7) return tpl('$__n__天前', { n: days })
  return absoluteMinute(date)
}
