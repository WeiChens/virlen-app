/**
 * db.ts — IndexedDB 轻量封装
 *
 * 设计原则：
 * - 按会话粒度读写，避免全量序列化
 * - 异步非阻塞，不阻塞主线程
 * - 自动处理数据库升级/版本管理
 */
import type { Session } from '@/types'

// ==================== 数据库配置 ====================

const DB_NAME = 'virlen-db'
const DB_VERSION = 1

/** 对象存储名称 */
const STORES = {
  SESSIONS: 'sessions', // keyPath: 'id' — 每个会话独立记录
} as const

// ==================== 数据库连接（单例）====================

let dbPromise: Promise<IDBDatabase> | null = null

function getDB(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION)

      request.onupgradeneeded = () => {
        const db = request.result

        // 会话存储：按 id 索引，可按 updatedAt 排序
        if (!db.objectStoreNames.contains(STORES.SESSIONS)) {
          const store = db.createObjectStore(STORES.SESSIONS, {
            keyPath: 'id',
          })
          store.createIndex('updatedAt', 'updatedAt', { unique: false })
        }
      }

      request.onsuccess = () => {
        resolve(request.result)
      }

      request.onerror = () => {
        dbPromise = null
        reject(request.error)
      }
    })
  }
  return dbPromise
}

// ==================== 通用 CRUD 工具 ====================

function waitRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

// ==================== 深拷贝工具 ====================

/**
 * 剥离 MobX observable 代理，返回纯 JSON 对象。
 * IndexedDB 的 Structured Clone 算法无法处理 MobX 代理对象。
 */
function toPlain<T>(data: T): T {
  return JSON.parse(JSON.stringify(data))
}

// ==================== 会话存储 API ====================

/**
 * 获取所有会话（不含额外过滤，由调用方排序）
 */
export async function getAllSessions(): Promise<Session[]> {
  const db = await getDB()
  const tx = db.transaction(STORES.SESSIONS, 'readonly')
  const store = tx.objectStore(STORES.SESSIONS)
  const sessions = await waitRequest<Session[]>(store.getAll())
  return sessions ?? []
}

/**
 * 获取单个会话
 */
export async function getSession(id: string): Promise<Session | undefined> {
  const db = await getDB()
  const tx = db.transaction(STORES.SESSIONS, 'readonly')
  const store = tx.objectStore(STORES.SESSIONS)
  return waitRequest<Session | undefined>(store.get(id))
}

/**
 * 写入单个会话（新增或更新）
 * 这是最常用的 API — 只有变化的会话才会写入
 *
 * ⚠️ 内部使用 toPlain() 剥离 MobX 代理，确保 IndexedDB 可克隆
 */
export async function putSession(session: Session): Promise<void> {
  const db = await getDB()
  const tx = db.transaction(STORES.SESSIONS, 'readwrite')
  const store = tx.objectStore(STORES.SESSIONS)
  await waitRequest(store.put(toPlain(session)))
}

/**
 * 批量写入多个会话
 */
export async function putSessions(sessions: Session[]): Promise<void> {
  if (sessions.length === 0) return
  const db = await getDB()
  const tx = db.transaction(STORES.SESSIONS, 'readwrite')
  const store = tx.objectStore(STORES.SESSIONS)
  for (const session of sessions) {
    store.put(toPlain(session))
  }
  // 等待事务完成（tx.commit() 返回 void，不能直接用 waitRequest）
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.commit()
  })
}

/**
 * 删除单个会话
 */
export async function deleteSession(id: string): Promise<void> {
  const db = await getDB()
  const tx = db.transaction(STORES.SESSIONS, 'readwrite')
  const store = tx.objectStore(STORES.SESSIONS)
  await waitRequest(store.delete(id))
}

/**
 * 删除多个会话
 */
export async function deleteSessions(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  const db = await getDB()
  const tx = db.transaction(STORES.SESSIONS, 'readwrite')
  const store = tx.objectStore(STORES.SESSIONS)
  for (const id of ids) {
    store.delete(id)
  }
  // 等待事务完成
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.commit()
  })
}

/**
 * 清空所有会话
 */
export async function clearAllSessions(): Promise<void> {
  const db = await getDB()
  const tx = db.transaction(STORES.SESSIONS, 'readwrite')
  const store = tx.objectStore(STORES.SESSIONS)
  await waitRequest(store.clear())
}

/**
 * 获取会话总数（用于快速校验）
 */
export async function countSessions(): Promise<number> {
  const db = await getDB()
  const tx = db.transaction(STORES.SESSIONS, 'readonly')
  const store = tx.objectStore(STORES.SESSIONS)
  return waitRequest<number>(store.count())
}
