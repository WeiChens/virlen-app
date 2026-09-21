/**
 * sessionRepo — 会话持久化 Repository（Rust SQLite 直落）
 *
 * 数据源从 IndexedDB 迁移到 Rust 侧 SQLite（src-tauri/src/session_db/）：
 * - 消息落库由 Rust 引擎在聊天循环内完成（用户消息发送即写、assistant/tool 完成时写）
 * - 前端只负责：启动时从 Rust 读全部会话、会话元数据变更（标题/pin/参数）写 Rust
 * - 即使 JS 卡住/崩溃，Rust 引擎照常落库，数据不丢
 *
 * 非 Tauri 环境（vitest）下 invoke 会抛错，全部 catch 兜底为空操作。
 */
import { invoke } from '@tauri-apps/api/core'
import type { Session, Message } from '@/types'
import { debounce } from '@/utils/common'
import { trackError, hashText } from '@/utils/telemetry'

export interface SessionRepo {
  /** 从 Rust SQLite 加载所有会话元数据（不含 messages，按 updatedAt 降序） */
  loadAll(): Promise<Session[]>
  /** 获取会话消息（懒加载：会话激活时调用） */
  getMessages(sessionId: string): Promise<Message[]>
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
   * 「消息查询」工具：按锚点（id / seq）取前后 N 条的时序窗口。
   *
   * ⚠️ **只覆盖「已压缩区间」**（时序 < 最后一个 summary）：该区间之后的对话
   * 已在模型当前上下文中，重复下发只会浪费 token。
   *
   * 失败（非 Tauri 环境 / DB 异常）返回 `null`，由调用方转成提示。
   */
  getMessageWindow(
    sessionId: string,
    opts: MessageWindowOptions,
  ): Promise<MessageWindow | null>
  /**
   * 「消息查询」工具：列出「已压缩区间」的消息时序（升序）。
   * 失败（非 Tauri 环境 / DB 异常）返回 `null`。
   */
  getMessageTimeline(
    sessionId: string,
    opts?: MessageTimelineOptions,
  ): Promise<MessageTimelinePage | null>
  /** 批量写入变化的会话，删除不存在的会话 */
  saveDiff(oldSessions: Session[], newSessions: Session[]): void
  /** 直接持久化单个会话元数据 */
  persistSession(session: Session): Promise<void>
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
  /** 每页条数 */
  limit?: number
  /** 取该 rowid 之前（更早）的消息；不传则取尾部窗口 */
  beforeRowid?: number | null
}

/**
 * 用户消息轻量索引项（与 Rust 端 `UserMessageRef` 对应）
 *
 * 只含 id + 纯文本摘要，不含 assistant / tool 消息的正文，
 * 用于一次性拉回全量用户消息供右侧锚点列表渲染。
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
  /** 命中片段（后端已围绕命中位置截取，超长带省略号） */
  text: string
  timestamp: number
  sessionTitle: string
  workspace?: string | null
  agentId?: string | null
  /**
   * 工具名（仅 role='tool' 的消息有；如 `read_file` / `edit_file`）。
   * 后端从「发起该调用的 assistant 消息」的 tool_calls 里反查得出，
   * 前端用 `getToolCallMessage(name).getToolLabel(name)` 译成「查看文件」等标签。
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
  /** 下一页游标（hasMore 为 true 时给出，用于 keyset 分页） */
  nextCursor: SearchCursor | null
}

/** 消息检索参数 */
export interface MessageSearchOptions {
  query: string
  /** 限定会话；不传 = 跨会话检索 */
  sessionId?: string | null
  /**
   * 限定角色；不传 = user + assistant（聊天列表展示的两类）。
   * `'tool'` = 工具调用结果消息（role='tool'）。
   */
  role?: string | null
  limit?: number
  /** keyset 分页游标（上一页返回的 nextCursor）；首页不传 */
  cursor?: SearchCursor | null
}

// ==================== 消息查询（query messages 工具）====================

/** 工具调用的精简描述（只告诉模型「调用了什么工具 + 关键参数」） */
export interface ToolCallBrief {
  name: string
  /** 参数 JSON 的截断形式（≤ 100 字符） */
  inputBrief: string
  inputTruncated: boolean
}

/** 单条消息的骨架（已剔除深度思考，工具参数已截断） */
export interface MessageBrief {
  /** 1 基时序（会话内消息的插入顺序） */
  seq: number
  id: string
  role: string
  timestamp: number
  /** 正文（仅 text 块拼接；≤ 4000 字符） */
  text: string
  textTruncated: boolean
  /** 是否含图片 / 文件 / 引用块（仅提示，不展开内容） */
  hasAttachments: boolean
  /** assistant 消息调用的工具（参数 ≤ 100 字符） */
  toolCalls: ToolCallBrief[]
  /** tool 消息才有 */
  toolCallId: string | null
  isError: boolean | null
  /** 是否含深度思考 —— 内容**永不返回**，只给这个标记 */
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
  /**
   * 「已压缩区间」上界 = 最后一个 summary 的时序；
   * `null` = 会话从未压缩（此时没有可查询的历史）
   */
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
  /** 更早一页的游标（`hasMore` 时给出） */
  nextCursor: number | null
  total: number
  boundarySeq: number | null
}

/** `getMessageWindow` 参数 */
export interface MessageWindowOptions {
  /** 锚点消息 id（优先） */
  anchorId?: string
  /** 锚点时序（备选；锚点都不传时取区间最新一条） */
  anchorSeq?: number
  /** 锚点之前取多少条 */
  before?: number
  /** 锚点之后取多少条 */
  after?: number
}

/** `getMessageTimeline` 参数 */
export interface MessageTimelineOptions {
  /** 关键词过滤（在纯文本正文字段上匹配） */
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
 * 会话「落库列」签名 —— 只覆盖 Rust 端 sessions 表实际写入的列
 * （见 src-tauri/src/session_db/row.rs 的 `session_insert_params`）。
 *
 * messages 不参与：消息落库由 Rust 引擎负责（append_messages），
 * 这里只判断会话元数据是否变化。
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
    session.tags ?? [],
    session.workspace ?? null,
    session.agentId ?? null,
    session.allowedTools ?? null,
    session.skills ?? null,
    session.systemPromptManuallyEdited ?? false,
  ])
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
      })
    } catch {
      return { messages: [], hasMore: false, oldestRowid: null }
    }
  }

  /** 获取会话内全部用户消息的轻量索引（id + 摘要，不含 AI/工具正文） */
  async getUserMessageRefs(sessionId: string): Promise<UserMessageRef[]> {
    try {
      return await invoke<UserMessageRef[]>('cmd_get_user_message_refs', {
        sessionId,
      })
    } catch {
      return []
    }
  }

  /** 检索消息（会话内 / 跨会话，keyset 游标分页） */
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

  /** 「消息查询」工具：按锚点取时序窗口（只覆盖「已压缩区间」） */
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

  /** 「消息查询」工具：列出「已压缩区间」的消息时序 */
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

  /** 直接持久化单个会话元数据（消息落库由 Rust 引擎负责） */
  async persistSession(session: Session): Promise<void> {
    try {
      await invoke('cmd_upsert_session', { session })
    } catch (err) {
      // 非 Tauri 环境忽略（埋点开关关闭时为 no-op）
      trackError('session.save.error', err, {
        props: { session_id: hashText(session.id) },
      })
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
          // ⚠️ 只能比「值」：oldSessions 是 store 传入的浅拷贝快照（persist() 里
          // `map(s => ({ ...s }))`），与 store 里的活对象永远不是同一引用。
          // 早期版本用 `|| old !== session` 兜底 → 恒为 true → 每次 persist() 都把
          // 全部会话回写一遍（实测 152 个会话：改 1 个标题写了 152 次 SQLite，
          // 占 rust.db.op 的 85%、SQLite 耗时的 88.7%）。
          if (!old || persistedSignature(old) !== persistedSignature(session)) {
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
        trackError('session.save.error', err)
      }
    },
    800,
  )
}

export const sessionRepo: SessionRepo = new SessionRepoImpl()
