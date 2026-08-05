/**
 * sessionRepo — 会话持久化 Repository（Rust SQLite 直落）
 *
 * 数据源从 IndexedDB 迁移到 Rust 侧 SQLite（src-tauri/src/session_db.rs）：
 * - 消息落库由 Rust 引擎在聊天循环内完成（用户消息发送即写、assistant/tool 完成时写）
 * - 前端只负责：启动时从 Rust 读全部会话、会话元数据变更（标题/pin/参数）写 Rust
 * - 即使 JS 卡住/崩溃，Rust 引擎照常落库，数据不丢
 *
 * 非 Tauri 环境（vitest）下 invoke 会抛错，全部 catch 兜底为空操作。
 */
import { invoke } from '@tauri-apps/api/core'
import type { Session, Message } from '@/types'
import { debounce } from '@/utils/common'

export interface SessionRepo {
  /** 从 Rust SQLite 加载所有会话元数据（不含 messages，按 updatedAt 降序） */
  loadAll(): Promise<Session[]>
  /** 获取会话消息（懒加载：会话激活时调用） */
  getMessages(sessionId: string): Promise<Message[]>
  /** 批量写入变化的会话，删除不存在的会话 */
  saveDiff(oldSessions: Session[], newSessions: Session[]): void
  /** 直接持久化单个会话元数据 */
  persistSession(session: Session): Promise<void>
}

class SessionRepoImpl implements SessionRepo {
  async loadAll(): Promise<Session[]> {
    try {
      const sessions = await invoke<Session[]>('cmd_list_sessions')
      // 懒加载：只加载元数据，消息在会话激活时再拉取
      // （见 sessionStore.ensureMessagesLoaded，避免启动时 N+1 全量拉消息）
      const metas = sessions.map((s) => ({ ...s, messages: [] as Message[] }))
      metas.sort((a, b) => b.updatedAt - a.updatedAt)
      return metas
    } catch {
      return []
    }
  }

  /** 获取会话消息（懒加载用） */
  async getMessages(sessionId: string): Promise<Message[]> {
    try {
      return await invoke<Message[]>('cmd_get_messages', { sessionId })
    } catch {
      return []
    }
  }

  /** 直接持久化单个会话元数据（消息落库由 Rust 引擎负责） */
  async persistSession(session: Session): Promise<void> {
    try {
      await invoke('cmd_upsert_session', { session })
    } catch {
      // 非 Tauri 环境忽略
    }
  }

  /** 防抖持久化（800ms 合并）：元数据变更写 Rust，删除走 Rust */
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

        await Promise.all([
          ...toPut.map((s) => invoke('cmd_upsert_session', { session: s })),
          ...toDelete.map((id) =>
            invoke('cmd_delete_session', { sessionId: id }),
          ),
        ])
      } catch (err) {
        console.error('[SessionRepo] 持久化失败:', err)
      }
    },
    800,
  )
}

export const sessionRepo: SessionRepo = new SessionRepoImpl()
