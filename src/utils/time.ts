import { t, tpl } from '@/ui/i18n'

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
