/**
 * format — 记忆时间戳的展示格式化（纯函数，便于单测）
 *
 * 为什么要有它：Rust 侧给了三个时间字段（`createdAt` / `updatedAt` / `lastUsedAt`，epoch 毫秒），
 * 而「记忆是什么时候记下的」是用户判断「这条还新不新 / 该不该清」的第一依据（记忆逐日累积）。
 * 列表表格里只放得下**日期**（列头本身就是「记录」），精确到分钟的时间进 `title`（悬停可看）。
 *
 * 一律按**本地**时区格式化：与整理口径（`source_day` 是本地日）保持一致 —— 用户看到的日期
 * 与他自己的日历对得上，比与服务端时区对得上重要。
 *
 * ⚠️ `createdAt` 可能缺失或为 0（老数据 / 非 Tauri 的桩数据）：那时**不编造日期**，
 * 返回空串让调用方自己决定显示什么（表格里显示「—」，而不是一个假日期）。
 */
import { tpl } from '@/ui/i18n'
import type { MemoryRecord } from '@/domain/memory'

const pad = (n: number) => String(n).padStart(2, '0')

/** 合法时间戳 → `Date`；0 / 缺失 / NaN 都算「没有这个时间」 */
function toDate(ms?: number | null): Date | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return null
  return new Date(ms)
}

/** epoch 毫秒 → 本地 `YYYY-MM-DD`；无有效值 → 空串 */
export function formatMemoryDay(ms?: number | null): string {
  const d = toDate(ms)
  if (!d) return ''
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** epoch 毫秒 → 本地 `YYYY-MM-DD HH:mm`；无有效值 → 空串 */
export function formatMemoryMinute(ms?: number | null): string {
  const d = toDate(ms)
  if (!d) return ''
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`
}

/** 悬停提示：`记录 2026-10-05 14:20 · 更新 2026-10-06 09:02`（没真正更新过就不写「更新」） */
export function memoryDateTitle(item: MemoryRecord): string {
  const created = formatMemoryMinute(item.createdAt)
  if (!created) return ''
  const parts = [tpl('记录 $__at__', { at: created })]
  const updated = formatMemoryMinute(item.updatedAt)
  if (updated && updated !== created) {
    parts.push(tpl('更新 $__at__', { at: updated }))
  }
  return parts.join(' · ')
}
