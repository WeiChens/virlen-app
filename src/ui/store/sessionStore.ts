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
import type { SessionRepo, UserMessageRef } from '@/infrastructure/sessionRepo'
import { sessionRepo } from '@/infrastructure/sessionRepo'
import { track, trackError, hashText } from '@/utils/telemetry'

/** 每次加载的消息条数（尾部窗口大小 / 向上回补步长） */
export const MESSAGE_PAGE_SIZE = 60

/** 单会话的消息分页状态 */
export interface MessagePaging {
  /** 是否还有更早的消息未加载（仍在 SQLite 中） */
  hasMoreOlder: boolean
  /** 已加载消息中最旧一条的 rowid（下一页游标） */
  oldestRowid: number | null
}

/** 稳定的空数组引用（未加载索引时共用，保证 useMemo 依赖稳定） */
const EMPTY_USER_INDEX: UserMessageRef[] = []

class SessionStore {
  value: {
    sessions: Session[]
    /** 各会话的消息分页状态（参与 observable，驱动 UI「查看更多」显隐） */
    messagePaging: Record<string, MessagePaging>
    /**
     * 各会话的「全量用户消息索引」（右侧锚点列表用）。
     * 只含 id + 摘要，不含 AI/工具正文，可一次性覆盖整个会话历史。
     */
    userMessageIndex: Record<string, UserMessageRef[]>
  } = { sessions: [], messagePaging: {}, userMessageIndex: {} }
  /** 已加载过消息的会话 id 集合（避免重复拉取） */
  private loadedMessageIds = new Set<string>()
  /** 已加载过用户消息索引的会话 id 集合 */
  private loadedUserIndexIds = new Set<string>()

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

  /** 从 Rust SQLite 加载所有会话元数据（消息懒加载，激活时再拉取） */
  async loadFromDB(): Promise<void> {
    const started = Date.now()
    try {
      const sessions = await this.repo.loadAll()
      // DB 会话消息未加载，切到该会话时懒加载
      this.loadedMessageIds.clear()
      this.loadedUserIndexIds.clear()
      runInAction(() => {
        this.value.sessions = sessions
        this.value.messagePaging = {}
        this.value.userMessageIndex = {}
      })
      // ⚠️ 必须同步更新 _lastSaved 基线，否则 persist() 的 debounced saveDiff
      // 传过去的 oldSessions=[]，导致任何删除操作都无法被识别（diff 认为没有要删的东西）
      // ⚠️ 且必须是「快照」（浅拷贝），不能是 store 自己的活对象：否则对已有会话的
      // 原地修改（如 chat-service 里 `session.updatedAt = Date.now()`）在 diff 时
      // 会与基线指向同一对象，变化被吞掉。
      this._lastSaved = sessions.map((s) => ({ ...s }))
      track('session.load', {
        session_count: sessions.length,
        duration_ms: Date.now() - started,
        status: 'success',
      })
    } catch (err) {
      console.error('[SessionStore] 加载失败:', err)
      runInAction(() => {
        this.value.sessions = []
        this.value.messagePaging = {}
        this.value.userMessageIndex = {}
      })
      this._lastSaved = []
      track('session.load', {
        session_count: 0,
        duration_ms: Date.now() - started,
        status: 'fail',
      })
      trackError('session.load.error', err)
    }
  }

  /**
   * 懒加载会话消息（会话激活时调用）。
   * 已加载过 / 新建会话（内存即真相）直接跳过。
   */
  async ensureMessagesLoaded(sessionId: string): Promise<void> {
    if (this.loadedMessageIds.has(sessionId)) return
    const idx = this.value.sessions.findIndex((s) => s.id === sessionId)
    if (idx === -1) return
    const started = Date.now()
    try {
      // 只拉尾部窗口，避免一次性把数千条消息经 IPC 搬到前端
      const page = await this.repo.getMessagePage(sessionId, {
        limit: MESSAGE_PAGE_SIZE,
      })
      runInAction(() => {
        const i = this.value.sessions.findIndex((s) => s.id === sessionId)
        if (i === -1) return
        const sessions = [...this.value.sessions]
        sessions[i] = { ...sessions[i], messages: page.messages }
        this.value.sessions = sessions
        this.value.messagePaging = {
          ...this.value.messagePaging,
          [sessionId]: {
            hasMoreOlder: page.hasMore,
            oldestRowid: page.oldestRowid,
          },
        }
      })
      this.loadedMessageIds.add(sessionId)
      track('session.messages.lazyload', {
        session_id: hashText(sessionId),
        message_count: page.messages.length,
        duration_ms: Date.now() - started,
        status: 'success',
        has_more: page.hasMore,
        mode: 'tail',
      })
    } catch {
      // 拉取失败不标记，下次激活重试
      track('session.messages.lazyload', {
        session_id: hashText(sessionId),
        message_count: 0,
        duration_ms: Date.now() - started,
        status: 'fail',
        mode: 'tail',
      })
    }
  }

  /** 该会话是否还有更早的消息未加载 */
  hasMoreMessages(sessionId: string): boolean {
    return this.value.messagePaging[sessionId]?.hasMoreOlder ?? false
  }

  /**
   * 该会话的历史消息是否「已全量在内存」（已加载过且没有更早的分页）。
   *
   * 用于判断能否把内存态消息整体回写 SQLite（
   * 未全量加载时整体回写会把还没拉取的旧消息抹掉）。
   */
  isMessagesFullyLoaded(sessionId: string): boolean {
    return (
      this.loadedMessageIds.has(sessionId) && !this.hasMoreMessages(sessionId)
    )
  }

  // ========== 用户消息轻量索引（右侧锚点列表） ==========

  /**
   * 确保会话的「全量用户消息索引」已加载。
   * 只拉 user 消息的 id + 摘要（不含 AI / 工具正文），因此可一次性覆盖整个会话历史，
   * 不会重新引入「切换会话时搬运数千条消息」的卡顿。
   */
  async ensureUserMessageIndex(sessionId: string): Promise<void> {
    if (this.loadedUserIndexIds.has(sessionId)) return
    const idx = this.value.sessions.findIndex((s) => s.id === sessionId)
    if (idx === -1) return
    try {
      const refs = await this.repo.getUserMessageRefs(sessionId)
      runInAction(() => {
        this.value.userMessageIndex = {
          ...this.value.userMessageIndex,
          [sessionId]: refs,
        }
      })
      this.loadedUserIndexIds.add(sessionId)
    } catch {
      // 拉取失败不标记，下次激活重试
    }
  }

  /** 获取会话的全量用户消息索引（未加载时返回稳定的空数组） */
  getUserMessageIndex(sessionId: string): UserMessageRef[] {
    return this.value.userMessageIndex[sessionId] ?? EMPTY_USER_INDEX
  }

  /**
   * 向上回补一页更早的消息（前插到消息列表头部）。
   * 同一会话的并发调用会复用同一个请求，避免把同一页重复前插两次。
   * @returns 是否实际加载到了更早的消息
   */
  loadOlderMessages(sessionId: string): Promise<boolean> {
    const inflight = this.olderLoads.get(sessionId)
    if (inflight) return inflight
    const task = this.loadOlderMessagesInner(sessionId).finally(() => {
      if (this.olderLoads.get(sessionId) === task) {
        this.olderLoads.delete(sessionId)
      }
    })
    this.olderLoads.set(sessionId, task)
    return task
  }

  /** 正在回补更早消息的请求（按会话去重） */
  private olderLoads = new Map<string, Promise<boolean>>()

  private async loadOlderMessagesInner(sessionId: string): Promise<boolean> {
    const paging = this.value.messagePaging[sessionId]
    if (!paging || !paging.hasMoreOlder) return false
    const started = Date.now()
    try {
      const page = await this.repo.getMessagePage(sessionId, {
        limit: MESSAGE_PAGE_SIZE,
        beforeRowid: paging.oldestRowid,
      })
      if (page.messages.length === 0) {
        // 游标失效或数据被删：标记无更多，避免反复请求
        runInAction(() => {
          this.value.messagePaging = {
            ...this.value.messagePaging,
            [sessionId]: {
              hasMoreOlder: false,
              oldestRowid: paging.oldestRowid,
            },
          }
        })
        return false
      }
      runInAction(() => {
        const i = this.value.sessions.findIndex((s) => s.id === sessionId)
        if (i === -1) return
        const sessions = [...this.value.sessions]
        sessions[i] = {
          ...sessions[i],
          messages: [...page.messages, ...sessions[i].messages],
        }
        this.value.sessions = sessions
        this.value.messagePaging = {
          ...this.value.messagePaging,
          [sessionId]: {
            hasMoreOlder: page.hasMore,
            oldestRowid: page.oldestRowid ?? paging.oldestRowid,
          },
        }
      })
      track('session.messages.lazyload', {
        session_id: hashText(sessionId),
        message_count: page.messages.length,
        duration_ms: Date.now() - started,
        status: 'success',
        has_more: page.hasMore,
        mode: 'older',
      })
      return true
    } catch {
      track('session.messages.lazyload', {
        session_id: hashText(sessionId),
        message_count: 0,
        duration_ms: Date.now() - started,
        status: 'fail',
        mode: 'older',
      })
      return false
    }
  }

  /**
   * 确保会话「全部」历史消息已加载。
   * 用于发送消息 / 上下文压缩 / 导出等需要完整上下文的场景。
   * 失败时安全退出，不阻塞调用方。
   */
  async ensureAllMessagesLoaded(sessionId: string): Promise<void> {
    await this.ensureMessagesLoaded(sessionId)
    let guard = 0
    // 上限兜底，避免 hasMore 异常导致死循环
    while (this.hasMoreMessages(sessionId) && guard++ < 1000) {
      const loaded = await this.loadOlderMessages(sessionId)
      if (!loaded && this.hasMoreMessages(sessionId)) break
    }
  }

  /** 标记会话消息已全部在内存（如上下文压缩整体替换后） */
  markMessagesFullyLoaded(sessionId: string): void {
    runInAction(() => {
      this.value.messagePaging = {
        ...this.value.messagePaging,
        [sessionId]: { hasMoreOlder: false, oldestRowid: null },
      }
    })
  }

  /** 清理指定会话的分页状态（删除会话时调用） */
  private dropMessagePaging(ids: string[]): void {
    const drop = new Set(ids)
    runInAction(() => {
      const next: Record<string, MessagePaging> = {}
      for (const [id, paging] of Object.entries(this.value.messagePaging)) {
        if (!drop.has(id)) next[id] = paging
      }
      this.value.messagePaging = next
      const nextIndex: Record<string, UserMessageRef[]> = {}
      for (const [id, refs] of Object.entries(this.value.userMessageIndex)) {
        if (!drop.has(id)) nextIndex[id] = refs
      }
      this.value.userMessageIndex = nextIndex
    })
    for (const id of ids) {
      this.loadedMessageIds.delete(id)
      this.loadedUserIndexIds.delete(id)
      this.olderLoads.delete(id)
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
      // 新建会话：内存态即全部消息，标记已加载避免被 DB 空数据覆盖
      this.loadedMessageIds.add(session.id)
      this.loadedUserIndexIds.add(session.id)
      this.value.messagePaging = {
        ...this.value.messagePaging,
        [session.id]: { hasMoreOlder: false, oldestRowid: null },
      }
      this.value.userMessageIndex = {
        ...this.value.userMessageIndex,
        [session.id]: [],
      }
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
    this.dropMessagePaging([id])
    this.persist()
    track('session.delete', {
      session_id: hashText(id),
      batch: false,
      count: 1,
    })
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
    this.dropMessagePaging(ids)
    this.persist()
    track('session.delete', { batch: true, count: deletedCount })
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
    this.value.messagePaging = {}
    this.value.userMessageIndex = {}
    this.loadedMessageIds.clear()
    this.loadedUserIndexIds.clear()
    this.olderLoads.clear()
    this.repo.saveDiff(oldSessions, [])
  }

  /** 别名：与旧版 sessionStorage.updateSession 兼容 */
  updateSessionBySave = this.saveSession
}

/** 全局单例 */
export const sessionStore = new SessionStore(sessionRepo)
