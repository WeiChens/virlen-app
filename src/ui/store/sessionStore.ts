/**
 * sessionStore — UI 层会话 Store
 *
 * 职责：
 *  - 持有 mobx observable（sessions 列表），供 UI 响应式渲染
 *  - 提供 CRUD 方法，持久化委托给 SessionRepo
 *
 * ⚠️ 不属于此 Store 的职责：
 *  - 业务流程编排（如创建会话、发送消息） → Application Service
 *  - IndexedDB diff / debounce → SessionRepo
 */
import { action, makeObservable, observable, runInAction } from 'mobx'
import type { Session } from '@/types'
import type { SessionRepo } from '@/infrastructure/sessionRepo'
import { sessionRepo } from '@/infrastructure/sessionRepo'

class SessionStore {
  value: { sessions: Session[] } = { sessions: [] }

  constructor(private repo: SessionRepo) {
    makeObservable(this, {
      value: observable,
      saveSession: action,
      updateSession: action,
      deleteSession: action,
      clear: action,
    })
  }

  // ========== 初始化 ==========

  /** 从 IndexedDB 加载所有会话 */
  async loadFromDB(): Promise<void> {
    try {
      const sessions = await this.repo.loadAll()
      runInAction(() => {
        this.value.sessions = sessions
      })
      // ⚠️ 必须同步更新 _lastSaved 基线，否则 persist() 的 debounced saveDiff
      // 传过去的 oldSessions=[]，导致任何删除操作都无法被识别（diff 认为没有要删的东西）
      this._lastSaved = sessions
    } catch (err) {
      console.error('[SessionStore] 加载失败:', err)
      runInAction(() => {
        this.value.sessions = []
      })
      this._lastSaved = []
    }
  }

  // ========== 持久化 ==========

  /** 路径 B/C: 会话元数据变更 → 防抖 + diff */
  private persist(): void {
    this.repo.saveDiff(this._lastSaved, this.value.sessions)
    // 浅拷贝解引用，使下次 diff 能正确检测变化
    this._lastSaved = this.value.sessions.map((s) => ({ ...s }))
  }
  private _lastSaved: Session[] = []

  // ========== 路径 A: 消息变更 → 直接持久化（高频，无 diff，独立 debounce） ==========

  private _messageDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>()

  /** 消息变更后触发防抖持久化（300ms 合并，直接写 IndexedDB） */
  private _debouncedPersistSession(sessionId: string): void {
    const existing = this._messageDebounceTimers.get(sessionId)
    if (existing) clearTimeout(existing)
    this._messageDebounceTimers.set(
      sessionId,
      setTimeout(async () => {
        this._messageDebounceTimers.delete(sessionId)
        const session = this.value.sessions.find((s) => s.id === sessionId)
        if (!session) return
        await this.repo.persistSession(session)
      }, 300),
    )
  }

  /**
   * 消息变更通知（服务层消息 CRUD 调用此方法）
   * 只持久化、不走 diff、不污染 _lastSaved 基线
   */
  messagesChanged(sessionId: string): void {
    this._debouncedPersistSession(sessionId)
  }

  // ========== CRUD ==========

  /** 保存会话（新增或更新） */
  saveSession(session: Session): void {
    const idx = this.value.sessions.findIndex((s) => s.id === session.id)
    if (idx >= 0) {
      const existing = this.value.sessions[idx]
      Object.assign(existing, session)
    } else {
      this.value.sessions = [...this.value.sessions, session]
    }
    this.persist()
  }

  /** 根据 ID 获取会话 */
  getSession(id: string): Session | undefined {
    return this.value.sessions.find((s) => s.id === id)
  }

  /** 获取排序后的会话列表（置顶优先 → updatedAt 倒序） */
  listSessions(): Session[] {
    return [...this.value.sessions].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      return b.updatedAt - a.updatedAt
    })
  }

  /** 更新会话部分字段 */
  updateSession(
    id: string,
    patch: Partial<
      Pick<
        Session,
        | 'title'
        | 'systemPrompt'
        | 'params'
        | 'pinned'
        | 'tags'
        | 'providerConfigId'
        | 'modelId'
      >
    >,
  ): Session | null {
    const idx = this.value.sessions.findIndex((s) => s.id === id)
    if (idx === -1) return null
    const sessions = [...this.value.sessions]
    sessions[idx] = { ...sessions[idx], ...patch, updatedAt: Date.now() }
    this.value.sessions = sessions
    this.persist()
    return sessions[idx]
  }

  /** 更新会话标题 */
  updateSessionTitle(id: string, title: string): Session | null {
    return this.updateSession(id, { title })
  }

  /** 切换置顶状态 */
  toggleSessionPin(id: string): boolean {
    const session = this.getSession(id)
    if (!session) return false
    this.updateSession(id, { pinned: !session.pinned })
    return true
  }

  /** 删除会话 */
  deleteSession(id: string): boolean {
    const idx = this.value.sessions.findIndex((s) => s.id === id)
    if (idx === -1) return false
    const sessions = [...this.value.sessions]
    sessions.splice(idx, 1)
    this.value.sessions = sessions
    this.persist()
    return true
  }

  /**
   * 批量删除会话（只触发一次持久化）
   * ⚠️ 不要在循环中逐个调用 deleteSession，会导致 debounce 覆盖丢失数据
   */
  deleteSessions(ids: string[]): number {
    if (ids.length === 0) return 0
    const idSet = new Set(ids)
    const newSessions = this.value.sessions.filter((s) => !idSet.has(s.id))
    const deletedCount = this.value.sessions.length - newSessions.length
    if (deletedCount === 0) return 0
    this.value.sessions = newSessions
    this.persist()
    return deletedCount
  }

  /** 触发会话更新信号（强制 UI 重渲染） */
  notifySessionChanged(sessionId: string): void {
    const idx = this.value.sessions.findIndex((s) => s.id === sessionId)
    if (idx === -1) return
    const sessions = [...this.value.sessions]
    sessions[idx] = { ...sessions[idx] }
    this.value.sessions = sessions
    // 不触发持久化（只是更新引用）
  }

  /** 清空会话列表 */
  clear(): void {
    const oldSessions = this.value.sessions
    this.value.sessions = []
    this.repo.saveDiff(oldSessions, [])
  }

  /** 别名：与旧版 sessionStorage.updateSession 兼容 */
  updateSessionBySave = this.saveSession
}

/** 全局单例 */
export const sessionStore = new SessionStore(sessionRepo)
