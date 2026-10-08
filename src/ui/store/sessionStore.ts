/**
 * UI 层会话 Store：持有 sessions 的 mobx observable + CRUD 方法，持久化全委托给 `SessionRepo`。
 * 不含业务编排（创建会话 / 发消息 → Application Service），也不含 diff / debounce（→ SessionRepo）。
 */
import { action, makeObservable, observable, runInAction } from 'mobx'
import type { Session } from '@/types'
import type { SessionRepo, UserMessageRef } from '@/infrastructure/sessionRepo'
import { sessionRepo } from '@/infrastructure/sessionRepo'
import { track, trackError, hashText } from '@/utils/telemetry'
import { settingsState } from './settingStore'

/** 每次 SQL 取的原始消息条数（尾部窗口大小 / 向上回补步长） */
export const MESSAGE_PAGE_SIZE = 60

/**
 * 每页「可见行」下限（交给 Rust 跳页取数用，见 `cmd_get_message_page`）：不足则继续向更早取。
 *
 * 取 50（略小于原始步长 60）：普通会话一页即达标（仍是一次 IPC）；
 * 工具调用密集的页里，原始 60 条可能折成一两行，只有按可见行补足才不会「滚到顶部却看不到新内容」。
 */
export const MESSAGE_MIN_VISIBLE = 50

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
    /** 各会话的「全量用户消息索引」（右侧锚点列表用）：只含 id + 摘要，可一次性覆盖整个历史。 */
    userMessageIndex: Record<string, UserMessageRef[]>
  } = { sessions: [], messagePaging: {}, userMessageIndex: {} }
  /** 已加载过消息的会话 id 集合（避免重复拉取） */
  private loadedMessageIds = new Set<string>()
  /** 已加载过用户消息索引的会话 id 集合 */
  private loadedUserIndexIds = new Set<string>()
  /** 「消息变更」订阅者（UI 镜像同步的兜底通道）。普通 Set（非 observable）：订阅关系不参与响应式，避免自触发。 */
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
      /** ⚠️ 必须声明 action：本类写 `value.sessions` 的其它路径都走 action / `runInAction`，只剩这两处漏了 —— 单例下看不出，有 observer（手机推送的 reaction）就报 MobX strict-mode 警告。 */
      deleteSessions: action,
      notifySessionChanged: action,
      clear: action,
    })
  }

  // 初始化

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
      // 基线必须同步更新且是浅拷贝快照：否则 debounce 的 saveDiff 拿到空列表或同一引用，删除与原位修改都会被 diff 吞掉
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

  /** 懒加载会话消息（会话激活时调用）；已加载过 / 新建会话（内存即真相）直接跳过。 */
  async ensureMessagesLoaded(sessionId: string): Promise<void> {
    if (this.loadedMessageIds.has(sessionId)) return
    const idx = this.value.sessions.findIndex((s) => s.id === sessionId)
    if (idx === -1) return
    const started = Date.now()
    try {
      // 只拉尾部窗口，避免一次性把数千条消息经 IPC 搬到前端
      const page = await this.repo.getMessagePage(sessionId, {
        limit: MESSAGE_PAGE_SIZE,
        // 按「可见行」补足：工具调用被折叠后，原始条数并不代表屏幕上真正多出来的高度
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

  /** 该会话是否还有更早的消息未加载 */
  hasMoreMessages(sessionId: string): boolean {
    return this.value.messagePaging[sessionId]?.hasMoreOlder ?? false
  }

  /** 历史消息是否「已全量在内存」（已加载过且无更早分页）—— 判断能否把内存态消息整体回写 SQLite（未全量时回写会抹掉还没拉取的旧消息）。 */
  isMessagesFullyLoaded(sessionId: string): boolean {
    return (
      this.loadedMessageIds.has(sessionId) && !this.hasMoreMessages(sessionId)
    )
  }

  // 用户消息轻量索引（右侧锚点列表）

  /**
   * 确保「全量用户消息索引」已加载：只拉 user 消息的 id + 摘要（不含 AI / 工具正文），
   * 可一次性覆盖整个历史，不会重新引入「切会话搬运数千条消息」的卡顿。
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
   * 从「全量用户消息索引」剔除指定用户消息（删除 / 清空消息时调用）。
   * 索引是一次性拉取后缓存的，不会自动失效；不同步剔除，锚点列表会残留已删除消息的圆点。
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
   * 向上回补一页更早的消息（前插到列表头部）；同会话并发调用复用同一请求，避免同页重复前插。
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
        minVisible: MESSAGE_MIN_VISIBLE,
        fold: settingsState.value.hideToolCallThink,
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

  /** 确保「全部」历史消息已加载（发送 / 上下文压缩 / 导出等需完整上下文的场景）；失败安全退出，不阻塞调用方。 */
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
   * 确保「模型当前上下文」已加载：从**最后一条 summary**（含它）到最新。
   *
   * 与 `ensureAllMessagesLoaded` 的差别：窗口里一出现 `summary` 就停止向更早回补 —— 消息是从尾部
   * 连续向前加载的，最后一个 summary 已在内存 ⇒ 它之后全部也在；而请求组装（TS `buildRequest` /
   * Rust `slice_messages`）本就丢掉 summary 之前的部分。无 summary 时退化为全量加载。
   * 发送路径用它，避免为「模型根本看不到」的旧历史付 O(历史) 的加载 + IPC 代价。
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

  /** 已加载消息里是否含 summary（= 最后一个 summary 已在内存） */
  private hasSummaryInMemory(sessionId: string): boolean {
    const s = this.value.sessions.find((x) => x.id === sessionId)
    return !!s?.messages.some((m) => m.role === 'summary')
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

  /** 消息变更后触发防抖持久化（300ms 合并，直接写 SQLite） */
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
   * 订阅「消息变更」，返回取消订阅函数。
   *
   * ⚠️ 存在的理由：`chat-view` 的消息列表是 React 本地镜像（`useState`），过去只由**发起方**的
   * `onMessagesUpdate` 驱动 —— 非组件自己发起的路径（手机 bridge 的 `host.session.send`）改了 store
   * 也刷不到 UI（表现为「手机上发了消息，电脑端要切会话才看到」）。「每个调用方记得通知」是反模式；
   * `messagesChanged` 是消息 CRUD 的唯一收口点，订它即覆盖全部来源（含未来新增）。
   *
   * 与 `onMessagesUpdate` 的分工：那是显式通知（组件自己发送时用，可立即生效），本订阅是兜底通道。
   */
  onMessagesChanged(listener: (sessionId: string) => void): () => void {
    this.messagesChangedListeners.add(listener)
    return () => {
      this.messagesChangedListeners.delete(listener)
    }
  }

  /** 消息变更通知（服务层消息 CRUD 调用此方法）；只持久化，不走 diff，不污染 `_lastSaved` 基线。 */
  messagesChanged(sessionId: string): void {
    this._debouncedPersistSession(sessionId)
    // 广播给订阅者（UI 镜像同步等）；单个订阅者抛错不影响持久化与其它订阅者
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
   * 更新会话部分字段。
   *
   * 不刷新 `updatedAt`：会话时间只由「用户发送消息」刷新（见 `touchSession`），改标题 / 切模型 /
   * 调推理强度 / 置顶都算元数据编辑。
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
   * 刷新「会话时间」（`updatedAt`）—— **只有用户发送消息的那一刻可以调用**。
   *
   * 产品语义：会话时间 = 用户最后一次发言的时间，列表按它倒序。AI 回复 / 工具结果 / 迭代反馈 /
   * 起标题 / 手动改标题 / 切模型 / 置顶都**不能**刷新它，否则列表时间被 AI 活动顶掉、顺序乱跳。
   * 唯一调用点：`chat-service` 的 `sendMessage` / `sendMessageWithGoal` 发送入口。
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
    // 删除不能只靠 persist() 的合并：窗口内的其它变更会把它吞掉（重启后会话复活），故再直接落库一次（删除幂等）
    void this.repo.deleteSessions([id])
    track('session.delete', {
      session_id: hashText(id),
      batch: false,
      count: 1,
    })
    return true
  }

  /** 批量删除会话（只触发一次持久化）。不要在循环里逐个调用 `deleteSession` —— debounce 互相覆盖会丢数据。 */
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
