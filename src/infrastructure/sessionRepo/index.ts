/**
 * 会话持久化 Repository（Rust SQLite）。消息落库由 Rust 引擎在聊天循环内完成，
 * 前端只读会话元数据 / 消息，并负责元数据变更写入。非 Tauri 环境全部兜底为空操作。
 */
import { invoke } from '@tauri-apps/api/core'
import type { Session, Message } from '@/types'
import { trackError, hashText } from '@/utils/telemetry'

export interface SessionRepo {
  /** 从 Rust 加载所有会话元数据（不含 messages，按 updatedAt 降序） */
  loadAll(): Promise<Session[]>
  /** 获取会话消息（懒加载：会话激活时调用） */
  getMessages(sessionId: string): Promise<Message[]>
  /**
   * 用 messages 替换会话「指定消息及其之后」的后缀（同一事务），不碰更早的历史；
   * 目标消息不存在时不删任何行。
   */
  replaceMessagesFrom(
    sessionId: string,
    fromMessageId: string,
    messages: Message[],
  ): Promise<void>
  /** 分页获取会话消息（尾部窗口，向上回补更早的历史） */
  getMessagePage(
    sessionId: string,
    opts?: MessagePageOptions,
  ): Promise<MessagePage>
  /** 获取会话内全部用户消息的轻量索引（右侧锚点列表用，不含 AI/工具正文） */
  getUserMessageRefs(sessionId: string): Promise<UserMessageRef[]>
  /** 检索消息（会话内 / 跨会话，分页；按时间倒序） */
  searchMessages(opts: MessageSearchOptions): Promise<MessageSearchPage>
  /**
   * 「消息查询」工具：按锚点取前后 N 条的时序窗口。只覆盖已压缩区间（之后的对话已在上下文里）。
   * 失败返回 null。
   */
  getMessageWindow(
    sessionId: string,
    opts: MessageWindowOptions,
  ): Promise<MessageWindow | null>
  /** 「消息查询」工具：列出已压缩区间的消息时序（升序）；失败返回 null。 */
  getMessageTimeline(
    sessionId: string,
    opts?: MessageTimelineOptions,
  ): Promise<MessageTimelinePage | null>
  /** 批量写入变化的会话，删除不存在的会话 */
  saveDiff(oldSessions: Session[], newSessions: Session[]): void
  /**
   * 删除会话及其消息（立即落库，不经防抖）：不可撤销的动作不能被后续元数据变更合并丢批。
   */
  deleteSessions(ids: string[]): Promise<void>
  /** 直接持久化单个会话元数据 */
  persistSession(session: Session): Promise<void>
  /** 数据库体积快照（设置 → 存储；非 Tauri 环境返回 null） */
  dbStats(): Promise<DbStats | null>
  /** WAL 截断（wal_checkpoint(TRUNCATE)，廉价） */
  dbCheckpoint(): Promise<DbCheckpointResult | null>
  /**
   * 重建数据库（VACUUM）。独占连接、约 2 倍库大小的临时空间，只在用户显式点击时调。
   */
  dbMaintain(): Promise<DbMaintainResult | null>
  /**
   * 回收无引用的图片附件（删消息 / 删会话后的孤儿文件）。
   */
  attachmentsGc(): Promise<AttachmentsGcResult | null>
  /**
   * 收口上一轮的崩溃残留（未定稿回复 / 悬空工具调用）。
   *
   * 读消息**之前**调：进程被杀时库里会留一条带半截正文的未定稿回复，
   * 由它定稿并标「已中断」。幂等，正常会话零写入；非 Tauri 环境返回 null。
   */
  repairTail(sessionId: string): Promise<TailRepair | null>
}

/** 消息分页结果（与 Rust 端 MessagePage 对应） */
export interface MessagePage {
  /** 本页消息（升序） */
  messages: Message[]
  /** 是否还有更早的消息 */
  hasMore: boolean
  /** 本页最旧消息的 rowid（下一页游标） */
  oldestRowid: number | null
}

/** 消息分页参数 */
export interface MessagePageOptions {
  /** 每次 SQL 取的原始条数 */
  limit?: number
  /** 取该 rowid 之前（更早）的消息；不传则取尾部窗口 */
  beforeRowid?: number | null
  /**
   * 「可见行」下限（> 0 时生效）：不足则继续向更早取。按可见行而非原始条数 ——
   * 一页若大半是被折成一行的工具调用，用户滚到顶几乎看不到新内容。
   */
  minVisible?: number
  /** 折叠开关（设置项 hideToolCallThink），影响可见行计数 */
  fold?: boolean
}

/**
 * 用户消息轻量索引项：只含 id + 摘要，不含 AI / 工具正文（右侧锚点列表一次拉全）。
 */
export interface UserMessageRef {
  id: string
  /** 纯文本摘要（后端已截断） */
  preview: string
}

/** 消息检索结果项（与 Rust 端 `MessageSearchItem` 对应） */
export interface MessageSearchItem {
  id: string
  sessionId: string
  role: string
  /** 命中片段（后端已围绕命中位置截取） */
  text: string
  timestamp: number
  sessionTitle: string
  workspace?: string | null
  agentId?: string | null
  /**
   * 工具名（仅 role='tool'）：后端从发起该调用的 assistant 消息反查得出，前端译成「查看文件」等标签。
   */
  toolName?: string | null
}

/** 消息检索的 keyset 分页游标（与 Rust 端 `SearchCursor` 对应） */
export interface SearchCursor {
  timestamp: number
  rowid: number
}

/** 消息检索分页结果 */
export interface MessageSearchPage {
  items: MessageSearchItem[]
  hasMore: boolean
  /** 下一页游标（hasMore 时给出，keyset 分页） */
  nextCursor: SearchCursor | null
}

/** 消息检索参数 */
export interface MessageSearchOptions {
  query: string
  /** 限定会话；不传 = 跨会话检索 */
  sessionId?: string | null
  /** 限定角色；不传 = user + assistant */
  role?: string | null
  limit?: number
  /** keyset 分页游标（上一页返回的 nextCursor）；首页不传 */
  cursor?: SearchCursor | null
}

// 消息查询（query messages 工具）

/** 工具调用的精简描述（只告诉模型「调用了什么工具 + 关键参数」） */
export interface ToolCallBrief {
  name: string
  /** 参数 JSON 的截断形式（≤ 100 字符） */
  inputBrief: string
  inputTruncated: boolean
}

/** 单条消息的骨架（已剔除深度思考，工具参数已截断） */
export interface MessageBrief {
  /** 1 基时序（会话内插入顺序） */
  seq: number
  id: string
  role: string
  timestamp: number
  /** 正文（仅 text 块拼接，≤ 4000 字符） */
  text: string
  textTruncated: boolean
  /** 是否含图片 / 文件 / 引用 / 技能块 */
  hasAttachments: boolean
  /** assistant 消息调用的工具（参数 ≤ 100 字符） */
  toolCalls: ToolCallBrief[]
  /** tool 消息才有 */
  toolCallId: string | null
  isError: boolean | null
  /** 是否含深度思考（内容永不返回，只给标记） */
  hasReasoning: boolean
}

/** `getMessageWindow` 的返回（时序升序） */
export interface MessageWindow {
  /** 锚点消息是否存在（false = id / seq 无效或已删除） */
  anchorFound: boolean
  anchorSeq: number
  startSeq: number
  endSeq: number
  /** 会话消息总数 */
  total: number
  /** 已压缩区间上界 = 最后一个 summary 的时序；null = 从未压缩 */
  boundarySeq: number | null
  /** 窗口后沿因触及上界而被裁剪 */
  clampedByBoundary: boolean
  messages: MessageBrief[]
}

/** 时序概览项 */
export interface MessageTimelineItem {
  seq: number
  id: string
  role: string
  timestamp: number
  /** 纯文本摘要（≤ 100 字符） */
  preview: string
  /** 该消息调用的工具名（assistant 才有） */
  toolNames: string[]
}

/** `getMessageTimeline` 的返回（时序升序） */
export interface MessageTimelinePage {
  items: MessageTimelineItem[]
  hasMore: boolean
  /** 更早一页的游标 */
  nextCursor: number | null
  total: number
  boundarySeq: number | null
}

/** `getMessageWindow` 参数 */
export interface MessageWindowOptions {
  /** 锚点消息 id（优先） */
  anchorId?: string
  /** 锚点时序（备选；都不传时取区间最新一条） */
  anchorSeq?: number
  /** 锚点之前取多少条 */
  before?: number
  /** 锚点之后取多少条 */
  after?: number
}

/** `getMessageTimeline` 参数 */
export interface MessageTimelineOptions {
  /** 关键词过滤（在纯文本正文上匹配） */
  keyword?: string
  /** 向前翻页游标（只返回更早的） */
  beforeSeq?: number
  limit?: number
}

/** 键序无关的 JSON 序列化（仅用于签名比较，不用于落库） */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'undefined'
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`
  }
  const obj = value as Record<string, unknown>
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`)
    .join(',')}}`
}

/**
 * 会话「落库列」签名 —— 只覆盖 Rust sessions 表实际写入的列，messages 不参与（由引擎 append）。
 */
function persistedSignature(session: Session): string {
  return stableJson([
    session.title,
    session.providerConfigId,
    session.modelId,
    session.systemPrompt,
    session.params,
    session.createdAt,
    session.updatedAt,
    session.pinned,
    session.archived ?? false,
    session.tags ?? [],
    session.workspace ?? null,
    session.agentId ?? null,
    session.allowedTools ?? null,
    session.skills ?? null,
    session.systemPromptManuallyEdited ?? false,
  ])
}

class SessionRepoImpl implements SessionRepo {
  /** 待写入的会话元数据（按 id 去重，后写覆盖先写） */
  private pendingPuts = new Map<string, Session>()
  /** 待删除的会话 id */
  private pendingDeletes = new Set<string>()
  /** 合并发送的定时器 */
  private flushTimer: ReturnType<typeof setTimeout> | null = null

  async loadAll(): Promise<Session[]> {
    try {
      const sessions = await invoke<Session[]>('cmd_list_sessions')
      // 懒加载：只取元数据，消息在会话激活时再拉（避免启动 N+1）
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

  /** 用 messages 替换「指定消息及之后」的后缀（不碰更早的历史） */
  async replaceMessagesFrom(
    sessionId: string,
    fromMessageId: string,
    messages: Message[],
  ): Promise<void> {
    try {
      await invoke('cmd_replace_session_messages_from', {
        sessionId,
        fromMessageId,
        messages,
      })
    } catch (err) {
      trackError('session.save.error', err, {
        props: { session_id: hashText(sessionId), op: 'replace_from' },
      })
    }
  }

  /** 分页获取会话消息（尾部窗口 / 向上回补） */
  async getMessagePage(
    sessionId: string,
    opts?: MessagePageOptions,
  ): Promise<MessagePage> {
    try {
      return await invoke<MessagePage>('cmd_get_message_page', {
        sessionId,
        limit: opts?.limit ?? null,
        beforeRowid: opts?.beforeRowid ?? null,
        minVisible: opts?.minVisible ?? null,
        fold: opts?.fold ?? null,
      })
    } catch {
      return { messages: [], hasMore: false, oldestRowid: null }
    }
  }

  /** 获取会话内全部用户消息的轻量索引（id + 摘要） */
  async getUserMessageRefs(sessionId: string): Promise<UserMessageRef[]> {
    try {
      return await invoke<UserMessageRef[]>('cmd_get_user_message_refs', {
        sessionId,
      })
    } catch {
      return []
    }
  }

  /** 检索消息（会话内 / 跨会话，keyset 分页） */
  async searchMessages(opts: MessageSearchOptions): Promise<MessageSearchPage> {
    try {
      return await invoke<MessageSearchPage>('cmd_search_messages', {
        query: opts.query,
        sessionId: opts.sessionId ?? null,
        role: opts.role ?? null,
        limit: opts.limit ?? null,
        cursor: opts.cursor ?? null,
      })
    } catch {
      return { items: [], hasMore: false, nextCursor: null }
    }
  }

  /** 「消息查询」工具：按锚点取时序窗口 */
  async getMessageWindow(
    sessionId: string,
    opts: MessageWindowOptions,
  ): Promise<MessageWindow | null> {
    try {
      return await invoke<MessageWindow>('cmd_get_message_window', {
        sessionId,
        anchorId: opts.anchorId ?? null,
        anchorSeq: opts.anchorSeq ?? null,
        before: opts.before ?? 5,
        after: opts.after ?? 5,
      })
    } catch {
      return null
    }
  }

  /** 「消息查询」工具：列出已压缩区间的消息时序 */
  async getMessageTimeline(
    sessionId: string,
    opts: MessageTimelineOptions = {},
  ): Promise<MessageTimelinePage | null> {
    try {
      return await invoke<MessageTimelinePage>('cmd_get_message_timeline', {
        sessionId,
        keyword: opts.keyword ?? null,
        beforeSeq: opts.beforeSeq ?? null,
        limit: opts.limit ?? 30,
      })
    } catch {
      return null
    }
  }

  /** 直接持久化单个会话元数据 */
  async persistSession(session: Session): Promise<void> {
    try {
      await invoke('cmd_upsert_session', { session })
    } catch (err) {
      // 非 Tauri 环境忽略
      trackError('session.save.error', err, {
        props: { session_id: hashText(session.id) },
      })
    }
  }

  /**
   * 批量写入变化的会话，删除不存在的会话。差集必须当场算完，只有「发送」被 800ms 合并：
   * 若把差集放在回调节省，中途那次的删除会永久丢失（store 已前移 _lastSaved 基线）。
   */
  saveDiff(oldSessions: Session[], newSessions: Session[]): void {
    const oldMap = new Map(oldSessions.map((s) => [s.id, s]))
    const newMap = new Map(newSessions.map((s) => [s.id, s]))

    for (const [id, session] of newMap) {
      const old = oldMap.get(id)
      // 只能比值：oldSessions 是浅拷贝快照，引用永远不等（早先用引用兜底 → 每次全量回写）
      if (!old || persistedSignature(old) !== persistedSignature(session)) {
        this.pendingPuts.set(id, session)
        // 同一 id 又被写回来（如删除后撤销）→ 不要再删
        this.pendingDeletes.delete(id)
      }
    }

    for (const id of oldMap.keys()) {
      if (!newMap.has(id)) {
        this.pendingDeletes.add(id)
        // 已排队等写入的会话被删掉 → 不要再写，否则会和删除互相抢先后
        this.pendingPuts.delete(id)
      }
    }

    this.scheduleFlush()
  }

  /** 立即删除会话及其消息（不等防抖） */
  async deleteSessions(ids: string[]): Promise<void> {
    if (ids.length === 0) return
    for (const id of ids) {
      this.pendingPuts.delete(id)
      this.pendingDeletes.add(id)
    }
    await this.flushNow()
  }

  /** 数据库体积快照（设置 → 存储；纯读，毫秒级） */
  async dbStats(): Promise<DbStats | null> {
    try {
      return await invoke<DbStats>('cmd_db_stats')
    } catch {
      // 非 Tauri 环境没有库，静默返回 null
      return null
    }
  }

  /** 截断 WAL（把已提交页搬回主库后截断 -wal） */
  async dbCheckpoint(): Promise<DbCheckpointResult | null> {
    try {
      return await invoke<DbCheckpointResult>('cmd_db_checkpoint')
    } catch (err) {
      trackError('session.db.checkpoint.error', err)
      return null
    }
  }

  /** 重建数据库（VACUUM，独占连接） */
  async dbMaintain(): Promise<DbMaintainResult | null> {
    try {
      return await invoke<DbMaintainResult>('cmd_db_maintain')
    } catch (err) {
      trackError('session.db.maintain.error', err)
      return null
    }
  }

  /**
   * 回收无引用的图片附件（删消息 / 删会话后留下的孤儿文件）。
   *
   * 只动附件目录，不碰数据库；刚写入（30 分钟内）的文件即使暂时没被引用也会跳过 ——
   * 引擎是“先落盘、再写库”，没有这道阀会删掉正在发送的图。
   */
  async attachmentsGc(): Promise<AttachmentsGcResult | null> {
    try {
      return await invoke<AttachmentsGcResult>('cmd_attachments_gc')
    } catch (err) {
      trackError('session.attachments.gc.error', err)
      return null
    }
  }

  /** 收口上一轮的崩溃残留（见 `SessionRepo::repair_tail` 的契约） */
  async repairTail(sessionId: string): Promise<TailRepair | null> {
    try {
      return await invoke<TailRepair>('cmd_repair_session_tail', { sessionId })
    } catch (err) {
      // 非 Tauri（vitest / 手机宿主没这命令）：静默降级，不影响消息读取
      trackError('session.repair_tail.error', err)
      return null
    }
  }

  /** 800ms 合并窗口：期间的新变更会合并进同一个批次 */
  private scheduleFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.flushNow()
    }, 800)
  }

  /**
   * 立即发送全部待处理变更并清空队列；失败不回滚队列（等下一次变更重新带上）。
   */
  private async flushNow(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    const puts = [...this.pendingPuts.values()]
    const deletes = [...this.pendingDeletes]
    this.pendingPuts.clear()
    this.pendingDeletes.clear()
    if (puts.length === 0 && deletes.length === 0) return
    try {
      await Promise.all([
        ...puts.map((s) => invoke('cmd_upsert_session', { session: s })),
        ...deletes.map((id) => invoke('cmd_delete_session', { sessionId: id })),
      ])
    } catch (err) {
      console.error('[SessionRepo] 持久化失败:', err)
      trackError('session.save.error', err)
    }
  }
}

export const sessionRepo: SessionRepo = new SessionRepoImpl()

// 库维护 DTO（与 Rust session_db::maintenance 一一对应）

/** 数据库体积快照（字节，字段名对应 Rust 的 camelCase） */
export interface DbStats {
  /** 主库物理大小（VACUUM 后要等一次 checkpoint 才变小） */
  dbBytes: number
  /** `-wal` 的物理大小 */
  walBytes: number
  /** shm 物理大小（固定 32 KB） */
  shmBytes: number
  /** pageCount * pageSize：SQLite 视角的逻辑大小 */
  pageBytes: number
  pageSize: number
  pageCount: number
  /** 空闲页数（可被 VACUUM 回收） */
  freelistPages: number
  /** auto_vacuum 模式：0=off 1=full 2=incremental */
  autoVacuum: number
  /** WAL checkpoint 后的封顶大小（-1 = 不限制） */
  journalSizeLimit: number
  sessionCount: number
  messageCount: number
  /** 图片附件目录的占用（字节） */
  attachmentsBytes: number
  /** 图片附件文件数 */
  attachmentsFiles: number
}

/** 一次 WAL 截断的结果 */
export interface DbCheckpointResult {
  /** 有其它连接占用 WAL 时无法截断（文件不会变小） */
  busy: boolean
  beforeBytes: number
  afterBytes: number
}

/** 「重建数据库」的结果（before / after 用于展示回收量） */
export interface DbMaintainResult {
  checkpoint: DbCheckpointResult
  /** VACUUM 本身的耗时（不含前后 checkpoint） */
  vacuumMs: number
  before: DbStats
  after: DbStats
}

/** 无引用图片附件的回收结果（与 Rust `AttachmentsGcResult` 一一对应） */
export interface AttachmentsGcResult {
  /** 删掉的孤儿附件个数 */
  removed: number
  /** 删掉的临时文件（`.part`）个数 */
  removedParts: number
  /** 释放的字节数 */
  freedBytes: number
  /** 仍被引用的个数 */
  kept: number
  /** 写入太新（30 分钟内）而跳过的个数 */
  skippedYoung: number
  /** 元数据读取 / 删除失败而跳过的个数 */
  skippedUnknown: number
}

/**
 * 一次「尾部崩溃修复」的结果（与 Rust `TailRepair` 一一对应）。
 *
 * 引擎每轮开始会先落一条未定稿占位（`pending`），结算时整行覆盖；因此库里还带着
 * `pending` 标记的行只可能来自「进程在轮次中途退出」。
 */
export interface TailRepair {
  /** 清掉 `streaming` 标记（含被判为中断）的条数 */
  finalized: number
  /** 崩在首字之前、正文为空而删掉的条数 */
  dropped: number
  /** 补出的「程序中断」工具结果条数 */
  toolResults: number
}
