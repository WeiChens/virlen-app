/**
 * sessionRepo — 会话持久化 Repository
 *
 * 职责：IndexedDB 粒度高效率读写 + diff + debounce 合并
 *
 * ⚠️ 不属于此 Repo 的职责：
 *  - mobx observable（UI 响应式） → UI Store
 *  - 排序、筛选等展示逻辑 → UI Store
 */
import type { Session } from '@/types'
import { debounce } from '@/utils/common'
import * as db from '@/utils/db'

export interface SessionRepo {
  /** 从 IndexedDB 加载所有会话（按 updatedAt 降序） */
  loadAll(): Promise<Session[]>
  /** 批量写入变化的会话，删除不存在的会话 */
  saveDiff(oldSessions: Session[], newSessions: Session[]): void
  /** 直接持久化单个会话（无 diff、无 debounce，高频消息专用） */
  persistSession(session: Session): Promise<void>
}

class SessionRepoImpl implements SessionRepo {
  async loadAll(): Promise<Session[]> {
    const sessions = await db.getAllSessions()
    sessions.sort((a, b) => b.updatedAt - a.updatedAt)
    return sessions
  }

  /** 直接持久化单个会话 */
  async persistSession(session: Session): Promise<void> {
    await db.putSession(session)
  }

  /** 防抖持久化（800ms 合并） */
  saveDiff = debounce(
    async (oldSessions: Session[], newSessions: Session[]) => {
      try {
        const oldMap = new Map(oldSessions.map((s) => [s.id, s]))
        const newMap = new Map(newSessions.map((s) => [s.id, s]))

        const toPut: Session[] = []
        const toDelete: string[] = []

        for (const [id, session] of newMap) {
          const old = oldMap.get(id)
          if (!old || old.updatedAt !== session.updatedAt || old !== session) {
            toPut.push(session)
          }
        }

        for (const id of oldMap.keys()) {
          if (!newMap.has(id)) {
            toDelete.push(id)
          }
        }

        const promises: Promise<void>[] = []
        if (toPut.length > 0) promises.push(db.putSessions(toPut))
        if (toDelete.length > 0) promises.push(db.deleteSessions(toDelete))
        await Promise.all(promises)
      } catch (err) {
        console.error('[SessionRepo] 持久化失败:', err)
      }
    },
    800,
  )
}

export const sessionRepo: SessionRepo = new SessionRepoImpl()
