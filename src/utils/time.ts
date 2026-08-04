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
