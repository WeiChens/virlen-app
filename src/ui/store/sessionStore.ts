/**
 * UI 层会话 Store：持有 observable 的 sessions + CRUD，持久化全委托 SessionRepo。
 */
import { action, makeObservable, observable, runInAction } from 'mobx'
import type { Message, Session } from '@/types'
import type { SessionRepo, UserMessageRef } from '@/infrastructure/sessionRepo'
import { sessionRepo } from '@/infrastructure/sessionRepo'
import { track, trackError, hashText } from '@/utils/telemetry'
import { settingsState } from './settingStore'

/** 每次 SQL 取的原始消息条数（尾部窗口 / 回补步长） */
export const MESSAGE_PAGE_SIZE = 60

/**
 * 每页「可见行」下限：不足则继续向更早取。工具调用密集的页折成一两行，按原始条数给页会看不到新内容。
 */
export const MESSAGE_MIN_VISIBLE = 50

/** 单会话的消息分页状态 */
export interface MessagePaging {
  /** 是否还有更早的消息未加载 */
  hasMoreOlder: boolean
  /** 已加载消息中最旧一条的 rowid（下一页游标） */
  oldestRowid: number | null
}

/** 稳定的空数组引用（保证 useMemo 依赖稳定） */
const EMPTY_USER_INDEX: UserMessageRef[] = []

class SessionStore {
  value: {
    sessions: Session[]
    /** 各会话分页状态（参与 observable，驱动「查看更多」显隐） */
    messagePaging: Record<string, MessagePaging>
    /** 各会话的全量用户消息索引（右侧锚点列表）：只含 id + 摘要 */
    userMessageIndex: Record<string, UserMessageRef[]>
  } = { sessions: [], messagePaging: {}, userMessageIndex: {} }
  /** 已加载过消息的会话 id 集合（避免重复拉取） */
  private loadedMessageIds = new Set<string>()
  /** 已加载过用户消息索引的会话 id 集合 */
  private loadedUserIndexIds = new Set<string>()
  /** 「消息变更」订阅者（UI 镜像同步的兜底）。普通 Set：订阅关系不参与响应式，避免自触发。 */
  private readonly messagesChangedListeners = new Set<
    (sessionId: string) => void
  >()

  constructor(private repo: SessionRepo) {
    makeObservable(this, {
      value: observable,
      saveSession: action,
      updateSession: action,
      touchSession: action,
      deleteSession: action,
      /** 必须声明 action：否则 observer（手机推送 reaction）会报 MobX strict-mode 警告。 */
      deleteSessions: action,
      notifySessionChanged: action,
      clear: action,
    })
  }

  // 初始化

  /** 从 Rust 加载所有会话元数据（消息懒加载） */
  async loadFromDB(): Promise<void> {
    const started = Date.now()
    try {
      const sessions = await this.repo.loadAll()
      // 消息未加载，切到该会话时懒加载
      this.loadedMessageIds.clear()
      this.loadedUserIndexIds.clear()
      runInAction(() => {
        this.value.sessions = sessions
        this.value.messagePaging = {}
        this.value.userMessageIndex = {}
      })
      // 基线必须同步更新且为浅拷贝：否则 saveDiff 会吞掉删除与原位修改
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

  /** 懒加载会话消息；已加载过 / 新建会话直接跳过。 */
  async ensureMessagesLoaded(sessionId: string): Promise<void> {
    if (this.loadedMessageIds.has(sessionId)) return
    const idx = this.value.sessions.findIndex((s) => s.id === sessionId)
    if (idx === -1) return
    const started = Date.now()
    try {
      // 只拉尾部窗口，避免一次性把数千条消息经 IPC 搬到前端
      const page = await this.repo.getMessagePage(sessionId, {
        limit: MESSAGE_PAGE_SIZE,
        // 按可见行补足：工具调用被折叠后，原始条数不代表屏幕高度
        minVisible: MESSAGE_MIN_VISIBLE,
        fold: settingsState.value.hideToolCallThink,
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

  /**
   * 该会话的尾部消息窗口是否已在内存（新消息可追加）。与 isMessagesFullyLoaded 不同：
   * 没加载过时只该落库，往空列表追加会只剩孤零零一条。
   */
  isMessagesLoaded(sessionId: string): boolean {
    return this.loadedMessageIds.has(sessionId)
  }

  /** 该会话是否还有更早的消息未加载 */
  hasMoreMessages(sessionId: string): boolean {
    return this.value.messagePaging[sessionId]?.hasMoreOlder ?? false
  }

  /** 历史是否已全量在内存（可整体回写 SQLite；未全量时回写会抹掉尚未拉取的旧消息） */
  isMessagesFullyLoaded(sessionId: string): boolean {
    return (
      this.loadedMessageIds.has(sessionId) && !this.hasMoreMessages(sessionId)
    )
  }

  // 用户消息轻量索引（右侧锚点列表）

  /**
   * 确保全量用户消息索引已加载：只拉 user 的 id + 摘要，可一次覆盖整个历史。
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

  /** 获取全量用户消息索引（未加载时返回稳定的空数组） */
  getUserMessageIndex(sessionId: string): UserMessageRef[] {
    return this.value.userMessageIndex[sessionId] ?? EMPTY_USER_INDEX
  }

  /**
   * 从索引剔除已删除的用户消息（索引是缓存，不会自动失效，不剔除会残留锚点圆点）。
   */
  dropUserMessagesFromIndex(sessionId: string, ids: Iterable<string>): void {
    const refs = this.value.userMessageIndex[sessionId]
    if (!refs || refs.length === 0) return
    const drop = new Set(ids)
    if (drop.size === 0) return
    const next = refs.filter((r) => !drop.has(r.id))
    if (next.length === refs.length) return
    runInAction(() => {
      this.value.userMessageIndex = {
        ...this.value.userMessageIndex,
        [sessionId]: next,
      }
    })
  }

  /**
   * 回补一页更早消息（前插）；并发调用复用同一请求。
   * @returns 是否真加载到了更早的消息
   */
  async loadOlderMessages(sessionId: string): Promise<boolean> {
    const before = this.getSession(sessionId)?.messages.length ?? 0
    const after = await this.loadOlderMessagesUntil(sessionId, undefined, 1)
    return (after?.length ?? 0) > before
  }

  /** 正在回补更早消息的请求（按会话去重，见 `loadOlderMessagesUntil`） */
  private olderLoads = new Map<string, Promise<Message[] | null>>()

  /**
   * 向更早回补，直到 until 命中 / 没有更多 / 触 maxPages；只在末尾提交一次。
   *
   * 一次提交：每回补一页都换掉 messages 引用，逐页提交会让侧栏 / 锚点 / token 环每页重渲染一轮。
   * 并发调用复用同一请求：既省 IPC，也避免同一段消息被前插两次。
   * @param until 对「本页取完后将成为消息列表的内容」（升序）求值，为真即停
   * @param shouldStop 每页取完后询问是否放弃（如用户已切走会话）
   */
  loadOlderMessagesUntil(
    sessionId: string,
    until?: (messages: Message[]) => boolean,
    maxPages = 1,
    shouldStop?: () => boolean,
  ): Promise<Message[] | null> {
    const inflight = this.olderLoads.get(sessionId)
    if (inflight) return inflight
    const task = this.loadOlderMessagesCore(
      sessionId,
      until,
      maxPages,
      shouldStop,
    ).finally(() => {
      if (this.olderLoads.get(sessionId) === task) {
        this.olderLoads.delete(sessionId)
      }
    })
    this.olderLoads.set(sessionId, task)
    return task
  }

  private async loadOlderMessagesCore(
    sessionId: string,
    until: ((messages: Message[]) => boolean) | undefined,
    maxPages: number,
    shouldStop?: () => boolean,
  ): Promise<Message[] | null> {
    const session = this.getSession(sessionId)
    if (!session) return null
    const paging = this.value.messagePaging[sessionId]
    // 没有更早的了：内存即权威
    if (!paging || !paging.hasMoreOlder) return session.messages

    const started = Date.now()
    /** 本页起点游标 */
    let cursor = paging.oldestRowid
    /** 本次新取到的更早消息（升序）；每取一页补到它前面 */
    let window: Message[] = []
    let hasMore = false
    let oldestRowid = cursor
    let loaded = 0
    /**
     * 每页重新取内存列表，不用回补开始时的快照：期间流式回答 / 工具结果会往尾部追加。
     */
    const inMemory = (): Message[] => this.getSession(sessionId)?.messages ?? []
    try {
      for (let page = 0; page < maxPages; page++) {
        const res = await this.repo.getMessagePage(sessionId, {
          limit: MESSAGE_PAGE_SIZE,
          beforeRowid: cursor,
          minVisible: MESSAGE_MIN_VISIBLE,
          fold: settingsState.value.hideToolCallThink,
        })
        // 空页 = 游标失效 / 数据被删：当作到底
        if (res.messages.length === 0) {
          hasMore = false
          break
        }
        window = res.messages.concat(window)
        loaded += res.messages.length
        hasMore = res.hasMore
        oldestRowid = res.oldestRowid ?? oldestRowid
        if (!hasMore) break
        // until 收到的是「这页取完后会成为消息列表的内容」（升序）
        if (until?.(window.concat(inMemory()))) break
        if (shouldStop?.()) break
        if (oldestRowid === null) break
        cursor = oldestRowid
      }
      const committed = runInAction(() => {
        const i = this.value.sessions.findIndex((s) => s.id === sessionId)
        if (i === -1) return null
        const sessions = [...this.value.sessions]
        const messages =
          window.length === 0
            ? sessions[i].messages
            : window.concat(sessions[i].messages)
        sessions[i] = { ...sessions[i], messages }
        this.value.sessions = sessions
        this.value.messagePaging = {
          ...this.value.messagePaging,
          [sessionId]: { hasMoreOlder: hasMore, oldestRowid },
        }
        return messages
      })
      track('session.messages.lazyload', {
        session_id: hashText(sessionId),
        message_count: loaded,
        duration_ms: Date.now() - started,
        status: 'success',
        has_more: hasMore,
        mode: 'older',
      })
      return committed
    } catch {
      track('session.messages.lazyload', {
        session_id: hashText(sessionId),
        message_count: 0,
        duration_ms: Date.now() - started,
        status: 'fail',
        mode: 'older',
      })
      return null
    }
  }

  /** 确保全部历史已加载（发送 / 压缩 / 导出等需完整上下文的场景） */
  async ensureAllMessagesLoaded(sessionId: string): Promise<void> {
    await this.ensureMessagesLoaded(sessionId)
    let guard = 0
    // 上限兜底，避免 hasMore 异常导致死循环
    while (this.hasMoreMessages(sessionId) && guard++ < 1000) {
      const loaded = await this.loadOlderMessages(sessionId)
      if (!loaded && this.hasMoreMessages(sessionId)) break
    }
  }

  /**
   * 确保模型当前上下文已加载：从最后一条 summary（含）到最新。
   * 请求组装本就丢掉 summary 之前的部分，无 summary 时退化为全量。
   */
  async ensureContextLoaded(sessionId: string): Promise<void> {
    await this.ensureMessagesLoaded(sessionId)
    let guard = 0
    // 上限兜底，避免 hasMore 异常导致死循环
    while (
      this.hasMoreMessages(sessionId) &&
      !this.hasSummaryInMemory(sessionId) &&
      guard++ < 1000
    ) {
      const loaded = await this.loadOlderMessages(sessionId)
      if (!loaded && this.hasMoreMessages(sessionId)) break
    }
  }

  /** 已加载消息里是否含 summary */
  private hasSummaryInMemory(sessionId: string): boolean {
    const s = this.value.sessions.find((x) => x.id === sessionId)
    return !!s?.messages.some((m) => m.role === 'summary')
  }

  /** 标记消息已全部在内存（如压缩后整体替换） */
  markMessagesFullyLoaded(sessionId: string): void {
    runInAction(() => {
      this.value.messagePaging = {
        ...this.value.messagePaging,
        [sessionId]: { hasMoreOlder: false, oldestRowid: null },
      }
    })
  }

  /** 清理分页状态（删除会话时） */
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

  // 持久化

  /** 会话元数据变更 → 防抖 + diff */
  private persist(): void {
    this.repo.saveDiff(this._lastSaved, this.value.sessions)
    // 浅拷贝解引用，使下次 diff 能正确检测变化
    this._lastSaved = this.value.sessions.map((s) => ({ ...s }))
  }
  private _lastSaved: Session[] = []

  // 消息变更 → 直接持久化（高频，无 diff，独立 debounce）

  private _messageDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>()

  /** 消息变更后防抖持久化（300ms，直接写 SQLite） */
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
   * 订阅消息变更，返回取消订阅函数。
   * 存在的理由：chat-view 的列表是 React 本地镜像，非组件发起的路径（手机 bridge）改 store 刷不到 UI；
   * messagesChanged 是消息 CRUD 的唯一收口点，订它即覆盖全部来源。
   */
  onMessagesChanged(listener: (sessionId: string) => void): () => void {
    this.messagesChangedListeners.add(listener)
    return () => {
      this.messagesChangedListeners.delete(listener)
    }
  }

  /** 消息变更通知：只持久化，不走 diff、不污染 _lastSaved */
  messagesChanged(sessionId: string): void {
    this._debouncedPersistSession(sessionId)
    // 广播给订阅者；单个抛错不影响持久化与其它订阅者
    for (const listener of this.messagesChangedListeners) {
      try {
        listener(sessionId)
      } catch (err) {
        console.error('[sessionStore] 消息变更订阅者抛错:', err)
      }
    }
  }

  // CRUD

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
  getSession(id: string | null): Session | undefined {
    if (!id) return undefined
    return this.value.sessions.find((s) => s.id === id)
  }

  /** 获取排序后的会话列表（置顶优先 → updatedAt 倒序） */
  listSessions(): Session[] {
    return [...this.value.sessions].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      return b.updatedAt - a.updatedAt
    })
  }

  /**
   * 更新会话部分字段。不刷新 updatedAt：会话时间只由用户发消息刷新（见 touchSession）。
   */
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
    sessions[idx] = { ...sessions[idx], ...patch }
    this.value.sessions = sessions
    this.persist()
    return sessions[idx]
  }

  /**
   * 刷新 updatedAt —— 只有用户发消息时才能调。AI 回复 / 工具结果 / 起标题 / 切模型 / 置顶都不算。
   */
  touchSession(id: string): void {
    const idx = this.value.sessions.findIndex((s) => s.id === id)
    if (idx === -1) return
    const sessions = [...this.value.sessions]
    sessions[idx] = { ...sessions[idx], updatedAt: Date.now() }
    this.value.sessions = sessions
    this.persist()
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
    // 删除不能只靠防抖：窗口内其它变更会把它吞掉（重启后会话复活），再直接落库一次（幂等）
    void this.repo.deleteSessions([id])
    track('session.delete', {
      session_id: hashText(id),
      batch: false,
      count: 1,
    })
    return true
  }

  /** 批量删除（只触发一次持久化）；不要在循环里调 deleteSession —— 防抖互相覆盖会丢数据。 */
  deleteSessions(ids: string[]): number {
    if (ids.length === 0) return 0
    const idSet = new Set(ids)
    const newSessions = this.value.sessions.filter((s) => !idSet.has(s.id))
    const deletedCount = this.value.sessions.length - newSessions.length
    if (deletedCount === 0) return 0
    this.value.sessions = newSessions
    this.dropMessagePaging(ids)
    this.persist()
    // 同 deleteSession：立即落库，免得被防抖合并吞掉
    void this.repo.deleteSessions(ids)
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
