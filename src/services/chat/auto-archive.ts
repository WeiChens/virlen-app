/**
 * chat/auto-archive — 闲置会话的自动归档。
 *
 * 触发时机 = 应用启动 + 每 10 分钟一次。只在桌面端跑：CLI / 手机不参与，
 * 它们读到的 `archived` 是这里落库后的结果。
 *
 * 判定：`now - updatedAt >= 天数 * 一天`，且**未归档**。
 * ⚠️ 三类必须跳过（都是「归档会误伤」的场景）：
 *   ① run 还活着（在跑 / 本地前置准备 / 暂停等你回答）；
 *   ② 置顶 —— 置顶是用户明确的保留意图；
 *   ③ 当前正在查看的会话 —— 看着看着被归档，视图会被踢回开始页。
 * 归档只改标记：不删消息、不刷 `updatedAt`（只有用户发消息才刷新，
 * 否则「闲置天数」会被后台动作自己重置，永远归档不了）。
 */
import {
  chatState,
  sessionRuntimeState,
  isSessionRunActive,
  sessionStore,
  settingsState,
} from '@/ui/store'
import { track } from '@/utils/telemetry'
import { setSessionsArchived } from './session'

/** 检查周期：闲置以「天」计，10 分钟足够灵敏，开销只是一次内存遍历 */
export const AUTO_ARCHIVE_INTERVAL_MS = 10 * 60 * 1000

/** 天数范围（设置页输入校正与执行器共用同一套，避免两边各写一份） */
export const AUTO_ARCHIVE_MIN_DAYS = 1
export const AUTO_ARCHIVE_MAX_DAYS = 3650

/** 默认闲置天数（与 SettingsStore 默认值一致） */
export const AUTO_ARCHIVE_DEFAULT_DAYS = 30

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 设置里的天数 → 合法值：缺失 / 非法 → 默认 30；越界 → 夹到 1–3650 并取整。
 * 入参放宽成 unknown：老库 / 手改 app_settings 可能塞进字符串。
 */
export function resolveAutoArchiveDays(
  value: unknown,
  fallback = AUTO_ARCHIVE_DEFAULT_DAYS,
): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  const days = Math.round(n)
  if (days < AUTO_ARCHIVE_MIN_DAYS) return AUTO_ARCHIVE_MIN_DAYS
  if (days > AUTO_ARCHIVE_MAX_DAYS) return AUTO_ARCHIVE_MAX_DAYS
  return days
}

/**
 * 跑一次自动归档。
 * @returns 本次归档条数（0 = 功能关闭 / 没有到期的）
 */
export function runAutoArchiveOnce(now = Date.now()): number {
  if (!settingsState.value.sessionAutoArchiveEnabled) return 0
  const days = resolveAutoArchiveDays(
    settingsState.value.sessionAutoArchiveDays,
  )
  const cutoff = now - days * DAY_MS
  const currentId = chatState.value.currentSessionId
  const ids = sessionStore.value.sessions
    .filter((s) => {
      if (s.archived || s.pinned) return false
      if (s.id === currentId) return false
      if (s.updatedAt > cutoff) return false
      // 没跑过的会话没有运行时条目：不调 getSessionRuntime（它会建空条目，白开内存）
      const rt = sessionRuntimeState.value.sessions[s.id]
      if (rt && isSessionRunActive(rt)) return false
      return true
    })
    .map((s) => s.id)
  if (ids.length === 0) return 0
  // 走用例入口而不是 store 裸 action：运行中过滤等规则只留一份（见 services/chat/session.ts）
  const changed = setSessionsArchived(ids, true)
  if (changed > 0) track('session.auto_archive', { count: changed, days })
  return changed
}

/**
 * 启动自动归档：先立即跑一次（把上次运行期间攒下的闲置会话一次清掉），之后定时检查。
 * 调用点必须在 `sessionStore.loadFromDB()` 之后，否则扫到的是空列表。
 * @returns 停止函数（测试 / 退出用）
 */
export function initSessionAutoArchive(): () => void {
  runAutoArchiveOnce()
  const timer = setInterval(() => runAutoArchiveOnce(), AUTO_ARCHIVE_INTERVAL_MS)
  return () => clearInterval(timer)
}
