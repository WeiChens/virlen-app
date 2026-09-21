//! 会话持久化 — SQLite 直落（不经过 JS/IndexedDB）
//!
//! 目标：即使前端 WebView JS 卡住/崩溃，会话与消息也能由 Rust 侧直接落库。
//!
//! - `SessionRepo` trait：引擎与 Tauri 命令共用的持久化接口
//! - `SqliteSessionRepo`：rusqlite 实现（WAL + Mutex 单写连接 + spawn_blocking）
//! - `NoopSessionRepo`：测试 / 无 SQLite 环境兜底（不持久化）
//!
//! 表结构：`sessions`（会话元数据）+ `messages`（消息，rowid 排序）拆表。
//! 复杂字段（params / tags / content / tool_calls / ui_data 等）以 JSON 列存储。

use crate::agent::types::{Message, Session};
use async_trait::async_trait;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

// ==================== 分页结果 ====================

/// 会话消息分页结果（尾部窗口加载用）
///
/// 前端切换会话时只取「最近 limit 条」，向上滚动再用 `oldest_rowid` 回补更早的历史，
/// 避免一次性把数千条消息经 IPC 全部搬到前端造成的加载卡顿。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessagePage {
    /// 本页消息（按插入顺序升序）
    pub messages: Vec<Message>,
    /// 是否还有更早的消息可供回补
    pub has_more: bool,
    /// 本页最旧消息的 rowid（作为下一页的 before_rowid）
    pub oldest_rowid: Option<i64>,
}

/// 会话内「用户消息」的轻量索引项（右侧锚点列表用）
///
/// 只包含 id 与纯文本摘要，不含 assistant / tool 消息的大量正文，
/// 因此即使会话有数千条消息，也能一次性取回而不重新引入加载卡顿。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserMessageRef {
    pub id: String,
    /// 纯文本摘要（已截断）
    pub preview: String,
}

/// 消息检索结果项（会话内 / 跨会话通用）
///
/// `text` 是「围绕首个命中位置生成的片段」（超长已省略号截断），
/// 前端直接渲染并对关键词做高亮；来源信息（会话标题 / 工作目录 / Agent）
/// 由 JOIN `sessions` 表带出，供跨会话检索时展示上下文。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageSearchItem {
    pub id: String,
    pub session_id: String,
    pub role: String,
    /// 命中片段（围绕首个命中位置截取，超长已省略）
    pub text: String,
    pub timestamp: i64,
    pub session_title: String,
    pub workspace: Option<String>,
    pub agent_id: Option<String>,
    /// 该消息所属的工具名（仅 `role='tool'` 的消息会解析；前端据此展示「查看文件」等标签）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
}

/// 消息检索的 keyset（游标）分页游标：按 `(timestamp, rowid)` 倒序定位「上一页最后一条」。
///
/// 相比 offset，keyset 不会因检索期间新写入的消息而错位（新消息 timestamp/rowid 更大，
/// 排在已翻页之前，不影响更旧页的定位）。
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchCursor {
    pub timestamp: i64,
    pub rowid: i64,
}

/// 消息检索分页结果（按时间倒序，keyset 游标分页）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageSearchPage {
    pub items: Vec<MessageSearchItem>,
    pub has_more: bool,
    /// 下一页游标（`has_more` 为 true 时给出，否则为 None）
    pub next_cursor: Option<SearchCursor>,
}

// ==================== 消息查询（query messages 工具）====================

/// 「消息查询」工具的硬上限（服务端权威 clamp，防止 JS 侧绕过）
pub const MSG_QUERY_MAX_BACK: usize = 20;
pub const MSG_QUERY_MAX_FWD: usize = 20;
/// 单次窗口最多返回的消息数 - 1（即最多 `MSG_QUERY_MAX_SPAN + 1` 条）
pub const MSG_QUERY_MAX_SPAN: usize = 20;
pub const MSG_QUERY_MAX_LIMIT: usize = 50;
/// 普通消息正文最多返回的字符数
pub const MSG_QUERY_TEXT_MAX_CHARS: usize = 4000;
/// 工具调用参数 / 工具结果最多返回的字符数（需求：详情 ≈100 字符以内）
pub const MSG_QUERY_TOOL_DETAIL_MAX_CHARS: usize = 100;
/// 概览摘要最多返回的字符数
pub const MSG_QUERY_PREVIEW_MAX_CHARS: usize = 100;

/// 工具调用的精简描述（只告诉模型「调用了什么工具 + 关键参数」）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallBrief {
    pub name: String,
    /// 参数 JSON 的截断形式（≤ `MSG_QUERY_TOOL_DETAIL_MAX_CHARS`）
    pub input_brief: String,
    pub input_truncated: bool,
}

/// 「消息查询」工具：单条消息的骨架（已剔除深度思考，工具参数已截断）
///
/// ⚠️ 只有「已压缩区间」（时序 < 最后一个 summary）的消息才会被返回：
/// 该区间之后的对话已在模型当前上下文中，重复下发只会浪费 token。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageBrief {
    /// 1 基时序（会话内消息的插入顺序）
    pub seq: i64,
    pub id: String,
    pub role: String,
    pub timestamp: i64,
    /// 正文（仅 text 块拼接；≤ `MSG_QUERY_TEXT_MAX_CHARS`）
    pub text: String,
    pub text_truncated: bool,
    /// 是否含图片 / 文件 / 引用块（仅提示，不展开内容）
    pub has_attachments: bool,
    /// assistant 消息调用的工具（参数按 `MSG_QUERY_TOOL_DETAIL_MAX_CHARS` 截断）
    pub tool_calls: Vec<ToolCallBrief>,
    /// tool 消息才有（对应 assistant 的 tool_call id）
    pub tool_call_id: Option<String>,
    pub is_error: Option<bool>,
    /// 是否含深度思考 —— 内容**永不返回**，只给这个标记
    pub has_reasoning: bool,
}

/// `get_message_window` 的返回：锚点前后 N 条（时序升序）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageWindow {
    /// 锚点消息是否存在（false = id / seq 无效或已删除）
    pub anchor_found: bool,
    /// 解析出的锚点时序（未找到时为 0）
    pub anchor_seq: i64,
    pub start_seq: i64,
    pub end_seq: i64,
    /// 会话消息总数
    pub total: i64,
    /// 「已压缩区间」上界 = 最后一个 summary 的时序；
    /// `None` = 会话从未压缩（此时没有可查询的历史，全部消息都在上下文中）
    pub boundary_seq: Option<i64>,
    /// 窗口后沿因触及上界而被裁剪
    pub clamped_by_boundary: bool,
    pub messages: Vec<MessageBrief>,
}

/// 时序概览项（list 模式）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageTimelineItem {
    pub seq: i64,
    pub id: String,
    pub role: String,
    pub timestamp: i64,
    /// 纯文本摘要（≤ `MSG_QUERY_PREVIEW_MAX_CHARS`）
    pub preview: String,
    /// 该消息调用的工具名（assistant 才有）
    pub tool_names: Vec<String>,
}

/// `get_message_timeline` 的返回（时序升序）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageTimelinePage {
    pub items: Vec<MessageTimelineItem>,
    pub has_more: bool,
    /// 更早一页的游标（`has_more` 时给出）
    pub next_cursor: Option<i64>,
    pub total: i64,
    /// 同 `MessageWindow::boundary_seq`
    pub boundary_seq: Option<i64>,
}

// ==================== 用量账本（token 统计） ====================
//
// 设计见 `docs/token-usage-stats.md`。一句话：每次 LLM 调用记一条流水，
// 不走 messages 聚合（会话删除不丢历史、能覆盖不产生消息的调用）。

/// 一次 LLM 调用的用量流水（写入单位）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct UsageEntry {
    /// 调用完成时间（Unix ms）；不传则取当前时间
    pub ts: Option<i64>,
    pub session_id: Option<String>,
    /// `chat_round` 的幂等键（assistant 消息 id）
    pub message_id: Option<String>,
    pub model: String,
    pub provider_type: Option<String>,
    pub provider_config_id: Option<String>,
    /// chat_round | compress | title | verify | embedding | legacy
    pub kind: String,
    pub round: Option<i64>,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    /// 缓存读/写（= total - prompt - completion）
    pub cached_tokens: i64,
    pub total_tokens: i64,
    /// 是否为本地估算值（非 API 返回）
    pub estimated: bool,
    pub trace_id: Option<String>,
}

/// 用量查询参数（聚合与明细共用同一套过滤条件）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct UsageQuery {
    pub from_ts: Option<i64>,
    pub to_ts: Option<i64>,
    pub session_id: Option<String>,
    pub model: Option<String>,
    pub kind: Option<String>,
    /// 分桶维度：day | week | month | model | session | kind | provider
    pub group_by: Option<String>,
    /// 明细分页（`usage_records`）
    pub limit: Option<usize>,
    pub offset: Option<usize>,
}

/// 一个聚合桶（`totals` 也复用此结构）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageBucket {
    pub key: String,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub cached_tokens: i64,
    pub total_tokens: i64,
    /// 调用次数
    pub calls: i64,
    /// 其中估算值条数（非 API 返回）
    pub estimated_calls: i64,
}

/// 聚合结果
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageStats {
    pub buckets: Vec<UsageBucket>,
    /// 全部匹配流水的合计（不受 `limit` 影响）
    pub totals: UsageBucket,
    /// 账本内最早 / 最晚流水时间（供 UI 展示数据覆盖范围）
    pub first_ts: Option<i64>,
    pub last_ts: Option<i64>,
}

/// 一条用量明细（表格视图 / 导出用）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageRecord {
    pub id: i64,
    pub ts: i64,
    pub session_id: Option<String>,
    /// 会话标题（JOIN sessions；会话已删除时为 None）
    pub session_title: Option<String>,
    pub message_id: Option<String>,
    pub model: String,
    pub provider_type: Option<String>,
    pub provider_config_id: Option<String>,
    pub kind: String,
    pub round: Option<i64>,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub cached_tokens: i64,
    pub total_tokens: i64,
    pub estimated: bool,
    pub trace_id: Option<String>,
}

/// 明细分页结果
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageRecordPage {
    /// 按时间倒序（新 → 旧）
    pub records: Vec<UsageRecord>,
    /// 匹配总条数（用于分页）
    pub total: i64,
}

// ==================== Trait ====================

#[async_trait]
pub trait SessionRepo: Send + Sync {
    /// 写入/更新会话元数据（幂等，按 id）
    async fn upsert_session(&self, session: &Session) -> Result<(), String>;
    /// 追加消息（事务；按消息 id 幂等，重复写入保留原 rowid，不改变读取顺序）
    ///
    /// ⚠️ **不刷新 `sessions.updated_at`**：会话时间 = 用户最后一次发言的时间，
    /// 只由前端 `sessionStore.touchSession()`（用户点发送的那一瞬间）经 `upsert_session` 写入。
    /// 引擎侧 assistant / tool / 迭代反馈的落库都是 AI 活动，不得改写会话时间。
    async fn append_messages(
        &self,
        session_id: &str,
        messages: &[Message],
    ) -> Result<(), String>;
    /// 整批替换会话的全部消息（事务；用于前端上下文压缩等全量替换场景）
    /// ⚠️ 同样不刷新 `updated_at`（压缩不是用户发言，见 `append_messages`）
    async fn replace_messages(
        &self,
        session_id: &str,
        messages: &[Message],
    ) -> Result<(), String>;
    /// 删除会话中「指定消息及其之后」的全部消息（按 rowid 顺序截断）
    ///
    /// 用于前端删除用户消息（及其连带删除的后续消息）时同步落库，
    /// 保证内存消息列表与 SQLite 一致（否则重启后已删除消息会「复活」）。
    /// 目标消息不存在时不删除任何行（子查询为 NULL → 条件不成立）。
    /// ⚠️ 不刷新 `updated_at`（删除消息不是用户发言）。
    async fn truncate_messages_from(
        &self,
        session_id: &str,
        message_id: &str,
    ) -> Result<(), String>;
    /// 列出所有会话（不含 messages，按 updated_at 降序）
    async fn list_sessions(&self) -> Result<Vec<Session>, String>;
    /// 获取单个会话元数据（不含 messages）
    async fn get_session(&self, session_id: &str) -> Result<Option<Session>, String>;
    /// 获取会话的全部消息（按插入顺序）
    async fn get_messages(&self, session_id: &str) -> Result<Vec<Message>, String>;
    /// 分页获取会话消息（默认取尾部窗口；`before_rowid` 用于向上回补更早的历史）
    async fn get_message_page(
        &self,
        session_id: &str,
        limit: usize,
        before_rowid: Option<i64>,
    ) -> Result<MessagePage, String>;
    /// 获取会话内全部「用户消息」的轻量索引（id + 纯文本摘要，按插入顺序升序）
    async fn get_user_message_refs(&self, session_id: &str) -> Result<Vec<UserMessageRef>, String>;
    /// 检索消息（会话内 / 跨会话，分页）
    ///
    /// - `session_id` 为 `None` 时检索全部会话（跨会话模式）；
    /// - `role` 为 `None` 时检索 `user` + `assistant`（与聊天列表展示一致，排除 tool）；
    /// - 结果按 `timestamp` 倒序（新→旧），`limit` + keyset 游标分页
    ///   （`cursor` 为上一页最后一条的 `(timestamp, rowid)`；首页传 `None`）；
    /// - `query` 为空（trim 后）时不做关键词过滤，直接返回最新的消息
    ///   （供检索弹窗默认展示，`session_id` / `role` / 游标仍生效）；
    /// - 正文为空的消息（仅做深度思考 / 工具调用的 assistant 消息）不进入结果。
    async fn search_messages(
        &self,
        query: &str,
        session_id: Option<&str>,
        role: Option<&str>,
        limit: usize,
        cursor: Option<SearchCursor>,
    ) -> Result<MessageSearchPage, String>;
    /// 消息查询工具：按锚点（id / seq）取「时序窗口」内各条消息的骨架（时序升序）。
    ///
    /// - **只返回「已压缩区间」**（时序 < 最后一个 summary 的时序）内的消息：该区间
    ///   之后的对话已在模型当前上下文中，重复下发只会浪费 token（需求硬约束）；
    /// - 锚点不存在 / 落在已压缩区间外时返回 `anchor_found=false`（不当作错误）；
    /// - 深度思考（`reasoning_content`）**永不返回**，只给 `has_reasoning` 标记；
    /// - `before` / `after` 由实现按 `MSG_QUERY_MAX_*` clamp；正文与工具详情按字符截断。
    async fn get_message_window(
        &self,
        session_id: &str,
        anchor_id: Option<&str>,
        anchor_seq: Option<i64>,
        before: usize,
        after: usize,
    ) -> Result<MessageWindow, String>;

    /// 消息查询工具：列出「已压缩区间」内的消息时序（时序升序）。
    ///
    /// - 只返回时序 < 最后一个 summary 时序 的消息（同 `get_message_window`）；
    /// - `before_seq` 为游标（只返回更早的）；不传则取该区间**最新**的一页；
    /// - `keyword` 非空时按 `text_plain`（LIKE，已转义）过滤；
    /// - `limit` 由实现按 `MSG_QUERY_MAX_LIMIT` clamp。
    async fn get_message_timeline(
        &self,
        session_id: &str,
        keyword: Option<&str>,
        before_seq: Option<i64>,
        limit: usize,
    ) -> Result<MessageTimelinePage, String>;

    /// 删除会话及其全部消息
    async fn delete_session(&self, session_id: &str) -> Result<(), String>;

    // ===== 用量账本（token 统计，见 `docs/token-usage-stats.md`） =====

    /// 追加用量流水（幂等：`message_id` 非空时同 id 只记一条）
    async fn append_usage(&self, entries: &[UsageEntry]) -> Result<(), String>;
    /// 聚合用量（按 `group_by` 分桶 + 合计）
    async fn usage_stats(&self, query: &UsageQuery) -> Result<UsageStats, String>;
    /// 用量明细（时间倒序，分页）
    async fn usage_records(&self, query: &UsageQuery) -> Result<UsageRecordPage, String>;
    /// 清空用量账本，返回删除条数
    async fn clear_usage(&self) -> Result<i64, String>;
}

// ==================== Noop 实现（测试 / 兜底） ====================

/// 不持久化的空实现 — AgentEngine::new 默认使用，保持现有测试行为
#[derive(Default)]
pub struct NoopSessionRepo;

#[async_trait]
impl SessionRepo for NoopSessionRepo {
    async fn upsert_session(&self, _session: &Session) -> Result<(), String> {
        Ok(())
    }
    async fn append_messages(
        &self,
        _session_id: &str,
        _messages: &[Message],
    ) -> Result<(), String> {
        Ok(())
    }
    async fn replace_messages(
        &self,
        _session_id: &str,
        _messages: &[Message],
    ) -> Result<(), String> {
        Ok(())
    }
    async fn truncate_messages_from(
        &self,
        _session_id: &str,
        _message_id: &str,
    ) -> Result<(), String> {
        Ok(())
    }
    async fn list_sessions(&self) -> Result<Vec<Session>, String> {
        Ok(Vec::new())
    }
    async fn get_session(&self, _session_id: &str) -> Result<Option<Session>, String> {
        Ok(None)
    }
    async fn get_messages(&self, _session_id: &str) -> Result<Vec<Message>, String> {
        Ok(Vec::new())
    }
    async fn get_message_page(
        &self,
        _session_id: &str,
        _limit: usize,
        _before_rowid: Option<i64>,
    ) -> Result<MessagePage, String> {
        Ok(MessagePage {
            messages: Vec::new(),
            has_more: false,
            oldest_rowid: None,
        })
    }
    async fn get_user_message_refs(
        &self,
        _session_id: &str,
    ) -> Result<Vec<UserMessageRef>, String> {
        Ok(Vec::new())
    }
    async fn search_messages(
        &self,
        _query: &str,
        _session_id: Option<&str>,
        _role: Option<&str>,
        _limit: usize,
        _cursor: Option<SearchCursor>,
    ) -> Result<MessageSearchPage, String> {
        Ok(MessageSearchPage {
            items: Vec::new(),
            has_more: false,
            next_cursor: None,
        })
    }
    async fn get_message_window(
        &self,
        _session_id: &str,
        _anchor_id: Option<&str>,
        _anchor_seq: Option<i64>,
        _before: usize,
        _after: usize,
    ) -> Result<MessageWindow, String> {
        Ok(MessageWindow {
            anchor_found: false,
            anchor_seq: 0,
            start_seq: 0,
            end_seq: 0,
            total: 0,
            boundary_seq: None,
            clamped_by_boundary: false,
            messages: Vec::new(),
        })
    }
    async fn get_message_timeline(
        &self,
        _session_id: &str,
        _keyword: Option<&str>,
        _before_seq: Option<i64>,
        _limit: usize,
    ) -> Result<MessageTimelinePage, String> {
        Ok(MessageTimelinePage {
            items: Vec::new(),
            has_more: false,
            next_cursor: None,
            total: 0,
            boundary_seq: None,
        })
    }
    async fn delete_session(&self, _session_id: &str) -> Result<(), String> {
        Ok(())
    }
    async fn append_usage(&self, _entries: &[UsageEntry]) -> Result<(), String> {
        Ok(())
    }
    async fn usage_stats(&self, _query: &UsageQuery) -> Result<UsageStats, String> {
        Ok(UsageStats::default())
    }
    async fn usage_records(&self, _query: &UsageQuery) -> Result<UsageRecordPage, String> {
        Ok(UsageRecordPage::default())
    }
    async fn clear_usage(&self) -> Result<i64, String> {
        Ok(0)
    }
}

// ==================== SQLite 实现 ====================

pub struct SqliteSessionRepo {
    conn: Arc<Mutex<Connection>>,
    /// 历史数据迁移（回填 `text_plain` + 重建 FTS）是否已完成。
    /// 未完成时 `search_messages` 回退到旧的 `LIKE content` 路径，保证检索依然正确（略慢）。
    migration_done: Arc<AtomicBool>,
}

const DDL: &str = r#"
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  provider_config_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  system_prompt TEXT NOT NULL DEFAULT '',
  params TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  tags TEXT NOT NULL DEFAULT '[]',
  workspace TEXT,
  agent_id TEXT,
  allowed_tools TEXT,
  skills TEXT,
  system_prompt_manually_edited INTEGER
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tool_calls TEXT,
  reasoning_content TEXT,
  tool_call_id TEXT,
  is_error INTEGER,
  elapsed_ms INTEGER,
  reasoning_elapsed_ms INTEGER,
  ui_data TEXT,
  timestamp INTEGER NOT NULL,
  streaming INTEGER,
  model TEXT,
  usage TEXT,
  image_vision_analyze_optimize INTEGER,
  image_vision_analyze_result TEXT,
  -- 纯文本正文（由 content JSON 提取；供 LIKE 回退 / 命中片段 / FTS5 索引使用）
  -- NOT NULL DEFAULT ''：任何未显式提供该列的写入都落 ''，不会留下 NULL
  text_plain TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
-- 锚点列表的「用户消息轻量索引」查询：先按 (session_id, role) 定位，避免读取全部正文行
CREATE INDEX IF NOT EXISTS idx_messages_session_role ON messages(session_id, role);
"#;

/// FTS5 全文索引（外部内容表）：索引 `messages.text_plain`，rowid 与 messages.rowid 对齐，
/// 正文本身仍存于 messages，索引不重复存储内容。
/// 使用 trigram 分词器 —— 支持中文等无空格语言的字串匹配（≥3 字符子串；
/// 更短的查询无法走索引，搜索时回退到 `LIKE text_plain`，见 `search_messages`）。
const FTS_DDL: &str = r#"
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  text_plain,
  content='messages',
  content_rowid='rowid',
  tokenize='trigram'
);
"#;

/// FTS 同步触发器（SQLite 官方推荐的外部内容表维护方式）：
/// 随 messages 增删改自动维护索引，无需在每个写路径手动同步。
const FTS_TRIGGERS_DDL: &str = r#"
CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text_plain) VALUES (new.rowid, COALESCE(new.text_plain, ''));
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text_plain) VALUES('delete', old.rowid, COALESCE(old.text_plain, ''));
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text_plain) VALUES('delete', old.rowid, COALESCE(old.text_plain, ''));
  INSERT INTO messages_fts(rowid, text_plain) VALUES (new.rowid, COALESCE(new.text_plain, ''));
END;
"#;

/// 检索的 keyset 排序 / 游标定位索引：(timestamp ASC, rowid ASC) 反向扫描即
/// (timestamp DESC, rowid DESC)，与检索的 ORDER BY 完全一致，避免大库全表排序。
///
/// ⚠️ 不放进静态 `DDL`：老库首次升级时建索引需扫描全表，若在 `open()` 同步执行会阻塞启动。
/// 因此它随「迁移」在后台完成；新建空库 / 已迁移库走 `init_schema` 快速路径
/// （表为空或已有索引，`IF NOT EXISTS` 立即返回，开销可忽略）。
const SEARCH_INDEX_DDL: &str = r#"
CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(timestamp);
"#;

/// 用量账本（token 统计）DDL
///
/// 与 `messages.usage` 的关系：`messages.usage` 是「消息自带的用量」，只覆盖
/// 产生消息的 LLM 调用；账本是**每次 LLM 调用一条流水**，因此
/// （1）能覆盖标题生成 / 迭代校验等不产生消息的调用；
/// （2）独立于会话生命周期 —— 删除会话不清账，历史总量不会缩水。
/// 详见 `docs/token-usage-stats.md`。
const USAGE_LEDGER_DDL: &str = r#"
CREATE TABLE IF NOT EXISTS usage_ledger (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                 INTEGER NOT NULL,
  session_id         TEXT,
  message_id         TEXT,
  model              TEXT NOT NULL DEFAULT '',
  provider_type      TEXT,
  provider_config_id TEXT,
  kind               TEXT NOT NULL,
  round              INTEGER,
  prompt_tokens      INTEGER NOT NULL DEFAULT 0,
  completion_tokens  INTEGER NOT NULL DEFAULT 0,
  -- 缓存读/写：= total - prompt - completion（Anthropic 把 cache 计入 total；OpenAI 口径恒为 0）
  cached_tokens      INTEGER NOT NULL DEFAULT 0,
  total_tokens       INTEGER NOT NULL DEFAULT 0,
  -- 1 = 本地估算值（非 API 返回），如上下文压缩的 DeepSeek BPE 估算
  estimated          INTEGER NOT NULL DEFAULT 0,
  trace_id           TEXT
);
CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_ledger(ts);
CREATE INDEX IF NOT EXISTS idx_usage_session ON usage_ledger(session_id, ts);
-- chat_round 以 assistant 消息 id 作幂等键：流式重试 / 重放不会重复记账
-- （compress/title/verify 无 message_id，每次都是新调用，不受影响）
CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_message ON usage_ledger(message_id)
  WHERE message_id IS NOT NULL;
"#;

/// 当前 schema 版本（存于 `PRAGMA user_version`）。递增后由 `migrate()` 执行迁移
/// （`open()` 只做快速初始化，耗时迁移在后台完成）。
///
/// v2：新增 `usage_ledger` 表，并从 `messages.usage` 一次性回填历史用量。
/// v3：修补历史流水的 `model`（回填时 `messages.model` 其实是空的，导致历史用量费用恒为 0）。
const SCHEMA_VERSION: i64 = 3;

impl SqliteSessionRepo {
    /// 打开（或创建）数据库并初始化表结构（**不做耗时迁移**）
    ///
    /// 快速的 schema 初始化（建表 / 补列 / 建 FTS 表 / 空库建检索索引）同步完成；
    /// 历史数据的大批量回填与索引重建由 `migrate()` 在后台执行，
    /// 避免超大库首次启动时卡住。
    pub fn open(db_path: &std::path::Path) -> Result<Self, String> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建数据目录失败: {}", e))?;
        }
        let conn = Connection::open(db_path).map_err(|e| format!("打开 SQLite 失败: {}", e))?;
        // WAL：读不阻塞写，适合「JS 只读 + Rust 写」并发场景
        let _ = conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
        let migration_done = init_schema(&conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            migration_done: Arc::new(AtomicBool::new(migration_done)),
        })
    }

    /// 后台迁移是否已完成（未完成时检索回退到旧的 `LIKE content` 路径）
    pub fn migration_done(&self) -> bool {
        self.migration_done.load(Ordering::Acquire)
    }

    /// 执行历史数据迁移：回填 `text_plain` 并重建 FTS 索引（幂等、可重入）。
    ///
    /// 由 `init_session_db` 在后台任务里调用。耗时的回填按批进行并在批间释放连接锁，
    /// 不会长时间阻塞其它 DB 操作；「建检索索引 + 重建 FTS + 建触发器 + 落版本号」放在
    /// 同一把锁内原子完成，避免新写入漏建索引。
    pub async fn migrate(&self) -> Result<(), String> {
        if self.migration_done() {
            return Ok(());
        }
        let conn = self.conn.clone();
        let done = self.migration_done.clone();
        tokio::task::spawn_blocking(move || -> Result<(), String> {
            backfill_text_plain(&conn)?;
            // v1 → v2：从 messages.usage 回填历史用量（幂等；否则老用户升级后统计从 0 开始）
            backfill_usage_ledger(&conn)?;
            // v2 → v3：修补历史流水的 model（回填早于本修补的用户，历史用量费用会是 0）
            repair_usage_ledger_model(&conn)?;
            {
                let c = conn.lock().unwrap();
                c.execute_batch(SEARCH_INDEX_DDL)
                    .map_err(|e| format!("初始化检索索引失败: {}", e))?;
                c.execute("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')", [])
                    .map_err(|e| format!("重建 FTS 索引失败: {}", e))?;
                c.execute_batch(FTS_TRIGGERS_DDL)
                    .map_err(|e| format!("初始化 FTS 触发器失败: {}", e))?;
                c.pragma_update(None, "user_version", SCHEMA_VERSION)
                    .map_err(|e| format!("更新 schema 版本失败: {}", e))?;
            }
            done.store(true, Ordering::Release);
            Ok(())
        })
        .await
        .map_err(|e| format!("DB task join error: {}", e))?
    }
}

/// 快速的 schema 初始化（幂等）。返回「迁移是否已完成」。
///
/// - 建表 / 补 `text_plain` 列 / 建 FTS 虚表都是元数据级操作，开销可忽略；
/// - 是否需要大规模迁移，取决于 `PRAGMA user_version` 与表内是否已有历史数据：
///   * 已是当前版本 → 建检索索引 + 触发器，返回 true；
///   * 空表（全新库）→ 无历史数据可迁，落版本号 + 建索引 + 触发器，返回 true；
///   * 存在 `text_plain IS NULL` 的历史行（旧构建漏写）→ 返回 false，由 `migrate()` 自愈回填；
///   * 否则 → 返回 false（回填 / 建索引 / 重建 FTS / 建触发器由 `migrate()` 完成）。
fn init_schema(conn: &Connection) -> Result<bool, String> {
    conn.execute_batch(DDL)
        .map_err(|e| format!("初始化表结构失败: {}", e))?;
    ensure_text_plain_column(conn)?;
    conn.execute_batch(FTS_DDL)
        .map_err(|e| format!("初始化 FTS 索引失败: {}", e))?;
    // 用量账本：纯建表 + 建索引，元数据级开销，可放在快速路径
    conn.execute_batch(USAGE_LEDGER_DDL)
        .map_err(|e| format!("初始化用量账本失败: {}", e))?;

    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap_or(0);
    let has_rows: bool = conn
        .query_row("SELECT EXISTS(SELECT 1 FROM messages)", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap_or(0)
        != 0;
    // 是否还有未回填的行（`text_plain IS NULL`）：历史旧构建可能漏写 `text_plain`
    // 而把值留成 NULL，且 `user_version` 已是当前版本时不会再自动触发迁移 ——
    // 这里显式检测，保证能自愈回填（否则这些行既搜不全、又可能以空正文漏出）。
    let has_null_text_plain: bool = has_rows
        && conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM messages WHERE text_plain IS NULL)",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap_or(0)
            != 0;

    if (version >= SCHEMA_VERSION || !has_rows) && !has_null_text_plain {
        // 无需迁移：建检索索引 + 触发器（保证后续写入即索引），并补齐版本号
        conn.execute_batch(SEARCH_INDEX_DDL)
            .map_err(|e| format!("初始化检索索引失败: {}", e))?;
        conn.execute_batch(FTS_TRIGGERS_DDL)
            .map_err(|e| format!("初始化 FTS 触发器失败: {}", e))?;
        if version < SCHEMA_VERSION {
            conn.pragma_update(None, "user_version", SCHEMA_VERSION)
                .map_err(|e| format!("更新 schema 版本失败: {}", e))?;
        }
        return Ok(true);
    }
    Ok(false)
}

/// 老库补 `text_plain` 列（新库由 DDL 直接建出，这里检测后跳过）
fn ensure_text_plain_column(conn: &Connection) -> Result<(), String> {
    let exists = {
        let mut stmt = conn
            .prepare("PRAGMA table_info(messages)")
            .map_err(|e| format!("读取 messages 表结构失败: {}", e))?;
        let mut has = false;
        {
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(1))
                .map_err(|e| e.to_string())?;
            for name in rows {
                if let Ok(n) = name {
                    if n == "text_plain" {
                        has = true;
                        break;
                    }
                }
            }
        }
        has
    };
    if !exists {
        conn.execute("ALTER TABLE messages ADD COLUMN text_plain TEXT", [])
            .map_err(|e| format!("添加 text_plain 列失败: {}", e))?;
    }
    Ok(())
}

/// 回填 `text_plain`（仅处理 NULL 行；按批处理并在批间释放连接锁，避免长时间占用）。
fn backfill_text_plain(conn: &Arc<Mutex<Connection>>) -> Result<(), String> {
    const BATCH: i64 = 500;
    loop {
        let guard = conn.lock().unwrap();
        let tx = guard
            .unchecked_transaction()
            .map_err(|e| format!("开启迁移事务失败: {}", e))?;
        let batch: Vec<(String, String)> = {
            let mut stmt = tx
                .prepare(
                    "SELECT id, content FROM messages \
                     WHERE text_plain IS NULL ORDER BY rowid LIMIT ?1",
                )
                .map_err(|e| format!("准备回填查询失败: {}", e))?;
            let rows = stmt
                .query_map(params![BATCH], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?
        };
        if batch.is_empty() {
            break;
        }
        {
            let mut upd = tx
                .prepare("UPDATE messages SET text_plain=?1 WHERE id=?2")
                .map_err(|e| format!("准备回填写入失败: {}", e))?;
            for (id, content_json) in &batch {
                let content: serde_json::Value =
                    serde_json::from_str(content_json).unwrap_or(serde_json::Value::Null);
                upd.execute(params![content_plain_text(&content), id])
                    .map_err(|e| format!("回填 text_plain 失败: {}", e))?;
            }
        }
        tx.commit().map_err(|e| format!("提交迁移事务失败: {}", e))?;
        // guard 在此迭代结束时释放 → 批间归还连接锁，其它 DB 操作可穿插执行
        if (batch.len() as i64) < BATCH {
            break;
        }
    }
    Ok(())
}

/// 从 `messages.usage` 回填历史用量到 `usage_ledger`（v1 → v2 迁移，幂等）。
///
/// - 幂等键是 `message_id`（唯一索引 + `INSERT OR IGNORE`）：重复执行不会产生重复流水；
/// - 历史数据无法区分调用类型，统一记为 `legacy`，避免污染新口径
///   （`summary` 消息是上下文压缩产物，记为 `compress` 并标 `estimated=1`，因为它是本地估算值）；
/// - 模型名优先取 `messages.model`，为空时回退到会话的 `model_id`
///   （保存消息时从未写过 `messages.model`，不回退的话历史流水全是空模型 → 无处取价 → 费用恒为 0）；
/// - 单条 SQL 完成（`INSERT ... SELECT`），不逐行循环，避免大库首次升级时拖慢启动。
fn backfill_usage_ledger(conn: &Arc<Mutex<Connection>>) -> Result<(), String> {
    // 账本已有内容（用户已用过新版）→ 不重复回填
    let guard = conn.lock().unwrap();
    let already: bool = guard
        .query_row("SELECT EXISTS(SELECT 1 FROM usage_ledger)", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap_or(0)
        != 0;
    if already {
        return Ok(());
    }
    guard
        .execute(
            r#"
INSERT OR IGNORE INTO usage_ledger (
  ts, session_id, message_id, model, kind,
  prompt_tokens, completion_tokens, total_tokens, estimated
)
SELECT m.timestamp,
       m.session_id,
       m.id,
       COALESCE(NULLIF(m.model, ''), s.model_id, ''),
       CASE m.role WHEN 'summary' THEN 'compress' ELSE 'legacy' END,
       COALESCE(json_extract(m.usage, '$.promptTokens'), 0),
       COALESCE(json_extract(m.usage, '$.completionTokens'), 0),
       COALESCE(json_extract(m.usage, '$.totalTokens'), 0),
       CASE m.role WHEN 'summary' THEN 1 ELSE 0 END
FROM messages m
LEFT JOIN sessions s ON s.id = m.session_id
WHERE m.usage IS NOT NULL AND m.usage != 'null'
"#,
            [],
        )
        .map_err(|e| format!("回填用量账本失败: {}", e))?;
    Ok(())
}

/// v2 → v3：修补 `usage_ledger.model` 为空的流水。
///
/// 背景：保存消息时从未写过 `messages.model`，所以 v2 回填出来的历史流水 `model` 全是空串
/// —— 明细里模型显 '-'、预算取不到单价 → **历史用量的费用恒为 0**
/// （用户看到的现象：“恢复内置价之后全是 0”）。会话的 `model_id` 就是当时用的模型，用它兜底。
///
/// 幂等：只动 `model = ''` 的行；会话已删除的流水永远补不上（`model` 保持空，详见已知局限）。
fn repair_usage_ledger_model(conn: &Arc<Mutex<Connection>>) -> Result<(), String> {
    let guard = conn.lock().unwrap();
    guard
        .execute(
            r#"
UPDATE usage_ledger
   SET model = (
         SELECT s.model_id FROM sessions s WHERE s.id = usage_ledger.session_id
       )
 WHERE model = ''
   AND session_id IS NOT NULL
   AND EXISTS (
         SELECT 1 FROM sessions s
          WHERE s.id = usage_ledger.session_id AND COALESCE(s.model_id, '') != ''
       )
"#,
            [],
        )
        .map_err(|e| format!("修补用量流水的模型名失败: {}", e))?;
    Ok(())
}

// ==================== JSON 序列化辅助 ====================

fn to_json<T: Serialize>(v: &T) -> Result<String, String> {
    serde_json::to_string(v).map_err(|e| format!("序列化失败: {}", e))
}

fn opt_to_json<T: Serialize>(v: &Option<T>) -> Result<Option<String>, String> {
    v.as_ref().map(to_json).transpose()
}

fn from_json<T: DeserializeOwned>(s: &str) -> Result<T, String> {
    serde_json::from_str(s).map_err(|e| format!("反序列化失败: {}", e))
}

fn opt_from_json<T: DeserializeOwned>(s: Option<String>) -> Result<Option<T>, String> {
    s.map(|v| from_json(&v)).transpose()
}

// ==================== 用量账本查询辅助 ====================

/// 构造用量查询的 WHERE 子句（含前导空格）与绑定参数。
///
/// `alias` 为表别名（聚合查询传 `usage_ledger`，明细 JOIN 查询传 `u`），
/// 显式加前缀避免 JOIN 后的列名歧义；所有值均走绑定参数，不拼接字面量。
fn usage_where(
    query: &UsageQuery,
    alias: &str,
) -> (String, Vec<Box<dyn rusqlite::ToSql + Send>>) {
    let mut clauses: Vec<String> = Vec::new();
    let mut params: Vec<Box<dyn rusqlite::ToSql + Send>> = Vec::new();

    if let Some(from) = query.from_ts {
        params.push(Box::new(from));
        clauses.push(format!("{}.ts >= ?{}", alias, params.len()));
    }
    if let Some(to) = query.to_ts {
        params.push(Box::new(to));
        clauses.push(format!("{}.ts <= ?{}", alias, params.len()));
    }
    if let Some(sid) = query.session_id.as_deref().filter(|s| !s.is_empty()) {
        params.push(Box::new(sid.to_string()));
        clauses.push(format!("{}.session_id = ?{}", alias, params.len()));
    }
    if let Some(model) = query.model.as_deref().filter(|s| !s.is_empty()) {
        params.push(Box::new(model.to_string()));
        clauses.push(format!("{}.model = ?{}", alias, params.len()));
    }
    if let Some(kind) = query.kind.as_deref().filter(|s| !s.is_empty()) {
        params.push(Box::new(kind.to_string()));
        clauses.push(format!("{}.kind = ?{}", alias, params.len()));
    }

    if clauses.is_empty() {
        (String::new(), params)
    } else {
        (format!(" WHERE {}", clauses.join(" AND ")), params)
    }
}

/// 用量分桶表达式（白名单匹配，绝不把用户输入拼进 SQL）。
///
/// 时间桶用 `'localtime'`：`ts` 是 Unix ms，不转本地时区的话「今日」会按 UTC 切分。
fn usage_group_expr(group_by: Option<&str>) -> &'static str {
    match group_by.unwrap_or("day") {
        "week" => "strftime('%Y-%W', ts / 1000, 'unixepoch', 'localtime')",
        "month" => "strftime('%Y-%m', ts / 1000, 'unixepoch', 'localtime')",
        "model" => "model",
        "session" => "COALESCE(session_id, '')",
        "kind" => "kind",
        "provider" => "COALESCE(provider_type, provider_config_id, '')",
        _ => "strftime('%Y-%m-%d', ts / 1000, 'unixepoch', 'localtime')",
    }
}

// ==================== Row → 领域对象 ====================

/// 将领域层 String 错误包装为 rusqlite::Error（query_map 要求）
fn row_err(e: String) -> rusqlite::Error {
    rusqlite::Error::InvalidColumnName(e)
}

fn session_from_row(row: &Row) -> Result<Session, String> {
    let params_json: String = row.get("params").map_err(|e| e.to_string())?;
    let tags_json: String = row.get("tags").map_err(|e| e.to_string())?;
    Ok(Session {
        id: row.get("id").map_err(|e| e.to_string())?,
        title: row.get("title").map_err(|e| e.to_string())?,
        messages: Vec::new(), // 拆表，消息单独加载
        provider_config_id: row.get("provider_config_id").map_err(|e| e.to_string())?,
        model_id: row.get("model_id").map_err(|e| e.to_string())?,
        system_prompt: row.get("system_prompt").map_err(|e| e.to_string())?,
        params: from_json(&params_json)?,
        created_at: row.get("created_at").map_err(|e| e.to_string())?,
        updated_at: row.get("updated_at").map_err(|e| e.to_string())?,
        pinned: row.get::<_, i64>("pinned").map_err(|e| e.to_string())? != 0,
        tags: from_json(&tags_json)?,
        workspace: row.get("workspace").map_err(|e| e.to_string())?,
        agent_id: row.get("agent_id").map_err(|e| e.to_string())?,
        allowed_tools: opt_from_json(row.get("allowed_tools").map_err(|e| e.to_string())?)?,
        skills: opt_from_json(row.get("skills").map_err(|e| e.to_string())?)?,
        system_prompt_manually_edited: row
            .get::<_, Option<i64>>("system_prompt_manually_edited")
            .map_err(|e| e.to_string())?
            .map(|v| v != 0),
    })
}

fn message_from_row(row: &Row) -> Result<Message, String> {
    let content_json: String = row.get("content").map_err(|e| e.to_string())?;
    Ok(Message {
        id: row.get("id").map_err(|e| e.to_string())?,
        role: row.get("role").map_err(|e| e.to_string())?,
        content: from_json(&content_json)?,
        tool_calls: opt_from_json(row.get("tool_calls").map_err(|e| e.to_string())?)?,
        reasoning_content: row.get("reasoning_content").map_err(|e| e.to_string())?,
        tool_call_id: row.get("tool_call_id").map_err(|e| e.to_string())?,
        is_error: row
            .get::<_, Option<i64>>("is_error")
            .map_err(|e| e.to_string())?
            .map(|v| v != 0),
        elapsed_ms: row.get("elapsed_ms").map_err(|e| e.to_string())?,
        reasoning_elapsed_ms: row.get("reasoning_elapsed_ms").map_err(|e| e.to_string())?,
        ui_data: opt_from_json(row.get("ui_data").map_err(|e| e.to_string())?)?,
        timestamp: row.get("timestamp").map_err(|e| e.to_string())?,
        streaming: row
            .get::<_, Option<i64>>("streaming")
            .map_err(|e| e.to_string())?
            .map(|v| v != 0),
        model: row.get("model").map_err(|e| e.to_string())?,
        usage: opt_from_json(row.get("usage").map_err(|e| e.to_string())?)?,
        image_vision_analyze_optimize: row
            .get::<_, Option<i64>>("image_vision_analyze_optimize")
            .map_err(|e| e.to_string())?
            .map(|v| v != 0),
        image_vision_analyze_result: row
            .get("image_vision_analyze_result")
            .map_err(|e| e.to_string())?,
    })
}

/// 读取一行消息并附带其 rowid（分页游标）
fn message_from_row_with_id(row: &Row) -> Result<(i64, Message), String> {
    let rowid: i64 = row.get("message_rowid").map_err(|e| e.to_string())?;
    Ok((rowid, message_from_row(row)?))
}

/// 从消息 content 中提取纯文本（content 为字符串或 `[{type:"text",text}]` 块数组）。
/// 图片 / 文件 / 引用块直接忽略：图片不含可检索文本，文件只有路径，
/// 引用正文来自另一条消息（重复进索引会让同一段落命中两次）。不截断。
fn content_plain_text(content: &serde_json::Value) -> String {
    match content {
        serde_json::Value::String(s) => s.clone(),
        // 文本块之间用换行分隔：直接首尾相接会把相邻块拼成一个词，
        // 导致「跨块短语」被误命中（如 "你" + "好" 被拼成 "你好"）。
        serde_json::Value::Array(blocks) => blocks
            .iter()
            .filter_map(|block| {
                if block.get("type").and_then(|v| v.as_str()) == Some("text") {
                    block.get("text").and_then(|v| v.as_str())
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// 从消息 content 中提取纯文本，并截断到 `max_chars` 个字符
///（供锚点列表摘要用，避免把图片 base64 等大字段带出去）。
fn content_text_preview(content: &serde_json::Value, max_chars: usize) -> String {
    content_plain_text(content).chars().take(max_chars).collect()
}

/// 按字符数截断（超出追加省略号）
fn truncate_chars(chars: &[char], max: usize) -> String {
    if chars.len() <= max {
        chars.iter().collect()
    } else {
        let mut s: String = chars.iter().take(max).collect();
        s.push('…');
        s
    }
}

// ==================== 消息查询辅助 ====================

/// 按字符截断，返回 (文本, 是否被截断)
fn truncate_with_flag(text: &str, max: usize) -> (String, bool) {
    let count = text.chars().count();
    if count <= max {
        return (text.to_string(), false);
    }
    let head: String = text.chars().take(max).collect();
    (format!("{}…", head), true)
}

/// content 是否含图片 / 文件 / 引用块（仅用于提示「有附件」，不展开内容）
fn content_has_attachments(content: &serde_json::Value) -> bool {
    match content {
        serde_json::Value::Array(blocks) => blocks.iter().any(|b| {
            matches!(
                b.get("type").and_then(|v| v.as_str()),
                Some("image_url") | Some("file") | Some("quote")
            )
        }),
        _ => false,
    }
}

/// 把 (before, after) 收敛到工具上限内（按比例缩放，保证锚点前后都保留）
fn clamp_window(before: usize, after: usize) -> (usize, usize) {
    let b = before.min(MSG_QUERY_MAX_BACK);
    let a = after.min(MSG_QUERY_MAX_FWD);
    if b + a <= MSG_QUERY_MAX_SPAN {
        return (b, a);
    }
    let total = b + a;
    let nb = (b * MSG_QUERY_MAX_SPAN) / total;
    (nb, MSG_QUERY_MAX_SPAN - nb)
}

/// 会话消息总数
fn session_message_count(conn: &Connection, session_id: &str) -> Result<i64, String> {
    conn.query_row(
        "SELECT COUNT(*) FROM messages WHERE session_id=?1",
        params![session_id],
        |row| row.get(0),
    )
    .map_err(|e| format!("统计会话消息数失败: {}", e))
}

/// 某个 rowid 对应的 1 基时序
fn seq_of_rowid(conn: &Connection, session_id: &str, rowid: i64) -> Result<i64, String> {
    conn.query_row(
        "SELECT COUNT(*) FROM messages WHERE session_id=?1 AND rowid <= ?2",
        params![session_id, rowid],
        |row| row.get(0),
    )
    .map_err(|e| format!("计算消息时序失败: {}", e))
}

/// 「已压缩区间」上界 = 最后一个 summary 消息的 1 基时序；无 summary 时返回 None。
///
/// 与 Provider 的切片语义严格一致（`provider.rs::last_summary_index` / TS
/// `getLastSummaryMessageIndex`）：最后一个 summary 及其之后的消息都已进入模型
/// 当前上下文，因此**不可查询**。
fn boundary_seq(conn: &Connection, session_id: &str) -> Result<Option<i64>, String> {
    let rowid: Option<i64> = conn
        .query_row(
            "SELECT rowid FROM messages WHERE session_id=?1 AND role='summary' \
             ORDER BY rowid DESC LIMIT 1",
            params![session_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("查询压缩边界失败: {}", e))?;
    match rowid {
        None => Ok(None),
        Some(rid) => seq_of_rowid(conn, session_id, rid).map(Some),
    }
}

/// 从查询行构造 `MessageBrief`（正文 / 工具详情按上限截断；剔除深度思考）
fn message_brief_from_row(row: &Row) -> Result<MessageBrief, String> {
    let role: String = row.get("role").map_err(|e| e.to_string())?;
    let content_json: String = row.get("content").map_err(|e| e.to_string())?;
    let content: serde_json::Value =
        serde_json::from_str(&content_json).unwrap_or(serde_json::Value::Null);

    let raw_text = content_plain_text(&content);
    // tool 消息的正文就是「工具结果详情」——与工具调用参数同口径截断；
    // 其它角色（user / assistant）保留较长正文（仍设上限，防止单条撑爆上下文）
    let text_limit = if role == "tool" {
        MSG_QUERY_TOOL_DETAIL_MAX_CHARS
    } else {
        MSG_QUERY_TEXT_MAX_CHARS
    };
    let (text, text_truncated) = truncate_with_flag(&raw_text, text_limit);

    let mut tool_calls: Vec<ToolCallBrief> = Vec::new();
    if let Some(json) = row
        .get::<_, Option<String>>("tool_calls")
        .map_err(|e| e.to_string())?
    {
        if let Ok(list) = serde_json::from_str::<Vec<crate::agent::types::ToolUseContent>>(&json) {
            for tc in list {
                let raw = serde_json::to_string(&tc.input).unwrap_or_default();
                let (input_brief, input_truncated) =
                    truncate_with_flag(&raw, MSG_QUERY_TOOL_DETAIL_MAX_CHARS);
                tool_calls.push(ToolCallBrief {
                    name: tc.name,
                    input_brief,
                    input_truncated,
                });
            }
        }
    }

    Ok(MessageBrief {
        seq: row.get("idx").map_err(|e| e.to_string())?,
        id: row.get("id").map_err(|e| e.to_string())?,
        role,
        timestamp: row.get("timestamp").map_err(|e| e.to_string())?,
        text,
        text_truncated,
        has_attachments: content_has_attachments(&content),
        tool_calls,
        tool_call_id: row.get("tool_call_id").map_err(|e| e.to_string())?,
        is_error: row
            .get::<_, Option<i64>>("is_error")
            .map_err(|e| e.to_string())?
            .map(|v| v != 0),
        has_reasoning: row
            .get::<_, i64>("has_reasoning")
            .map_err(|e| e.to_string())?
            != 0,
    })
}

/// 取 [start_seq, end_seq]（含端点，1 基时序）的消息骨架（时序升序）
///
/// ⚠️ 不 select `reasoning_content`：深度思考量最大且绝不允许下发给模型。
fn fetch_message_briefs(
    conn: &Connection,
    session_id: &str,
    start_seq: i64,
    end_seq: i64,
) -> Result<Vec<MessageBrief>, String> {
    let mut stmt = conn
        .prepare(
            "WITH ordered AS ( \
               SELECT rowid AS rid, ROW_NUMBER() OVER (ORDER BY rowid) AS idx \
               FROM messages WHERE session_id = ?1 \
             ) \
             SELECT m.id AS id, m.role AS role, m.content AS content, \
                    m.tool_calls AS tool_calls, m.tool_call_id AS tool_call_id, \
                    m.is_error AS is_error, m.timestamp AS timestamp, o.idx AS idx, \
                    (m.reasoning_content IS NOT NULL AND length(m.reasoning_content) > 0) AS has_reasoning \
             FROM ordered o JOIN messages m ON m.rowid = o.rid \
             WHERE o.idx BETWEEN ?2 AND ?3 \
             ORDER BY o.idx ASC",
        )
        .map_err(|e| format!("准备消息窗口查询失败: {}", e))?;
    let rows = stmt
        .query_map(params![session_id, start_seq, end_seq], |row| {
            message_brief_from_row(row).map_err(row_err)
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// 生成检索命中片段：围绕首个命中位置向两侧取窗口，命中落在很靠后的位置时
/// 也能看到关键词（否则前 200 字截断会让人以为「没搜到」）。
/// 大小写不敏感；`to_lowercase` 可能改变个别字符长度，长度不一致时退化为从头截断。
///
/// 直接作用于「纯文本」：调用方从 `messages.text_plain`（或从 content JSON 提取）取到。
fn search_snippet_text(text: &str, query: &str, max_chars: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    let q = query.trim();
    if q.is_empty() {
        return truncate_chars(&chars, max_chars);
    }
    let lq: Vec<char> = q.to_lowercase().chars().collect();
    let lc: Vec<char> = text.to_lowercase().chars().collect();
    let pos = if !lq.is_empty() && lc.len() == chars.len() {
        lc.windows(lq.len()).position(|w| w == lq.as_slice())
    } else {
        None
    };
    match pos {
        Some(p) => {
            let start = p.saturating_sub(30);
            let end = (p + lq.len() + 160).min(chars.len());
            let mut s = String::new();
            if start > 0 {
                s.push('…');
            }
            s.extend(chars[start..end].iter());
            if end < chars.len() {
                s.push('…');
            }
            s
        }
        None => truncate_chars(&chars, max_chars),
    }
}

/// 反查工具名时，往前最多扫描的「带 tool_calls 的 assistant 消息」条数。
/// 并行工具调用会把宿主 assistant 隔开若干条结果消息，正常远小于这个上限。
const TOOL_HOST_SCAN: usize = 20;

/// 从「工具结果消息」反查发起该调用的工具名（如 `read_file` / `edit_file`）。
///
/// tool 消息只存结果与 `tool_call_id`，工具名在同会话、rowid 更小的 assistant
/// 消息的 `tool_calls` JSON 里（[`crate::agent::types::ToolUseContent`]）。
/// 单页最多 `limit` 次调用（每次 2 条走索引的查询），开销与检索本身同量级。
/// 任何一步失败都退化为 `None`（前端只是不展示工具标签，不影响检索结果）。
fn tool_name_of_tool_message(
    conn: &Connection,
    session_id: &str,
    tool_rowid: i64,
) -> Option<String> {
    let tool_call_id: String = conn
        .query_row(
            "SELECT tool_call_id FROM messages WHERE rowid=?1 AND tool_call_id IS NOT NULL",
            params![tool_rowid],
            |row| row.get(0),
        )
        .optional()
        .ok()??;
    let mut stmt = conn
        .prepare(
            "SELECT tool_calls FROM messages \
             WHERE session_id=?1 AND role='assistant' AND tool_calls IS NOT NULL AND rowid<?2 \
             ORDER BY rowid DESC LIMIT ?3",
        )
        .ok()?;
    let rows = stmt
        .query_map(
            params![session_id, tool_rowid, TOOL_HOST_SCAN as i64],
            |row| row.get::<_, String>(0),
        )
        .ok()?;
    for json in rows.flatten() {
        if let Ok(list) = serde_json::from_str::<Vec<crate::agent::types::ToolUseContent>>(&json) {
            if let Some(tc) = list.into_iter().find(|t| t.id == tool_call_id) {
                return Some(tc.name);
            }
        }
    }
    None
}

// ==================== 参数序列化 ====================

fn session_insert_params(session: &Session) -> Result<Vec<Box<dyn rusqlite::ToSql + Send>>, String> {
    Ok(vec![
        Box::new(session.id.clone()),
        Box::new(session.title.clone()),
        Box::new(session.provider_config_id.clone()),
        Box::new(session.model_id.clone()),
        Box::new(session.system_prompt.clone()),
        Box::new(to_json(&session.params)?),
        Box::new(session.created_at),
        Box::new(session.updated_at),
        Box::new(if session.pinned { 1 } else { 0 }),
        Box::new(to_json(&session.tags)?),
        Box::new(session.workspace.clone()),
        Box::new(session.agent_id.clone()),
        Box::new(opt_to_json(&session.allowed_tools)?),
        Box::new(opt_to_json(&session.skills)?),
        Box::new(
            session
                .system_prompt_manually_edited
                .map(|v| if v { 1 } else { 0 }),
        ),
    ])
}

fn message_insert_params(
    session_id: &str,
    message: &Message,
) -> Result<Vec<Box<dyn rusqlite::ToSql + Send>>, String> {
    Ok(vec![
        Box::new(message.id.clone()),
        Box::new(session_id.to_string()),
        Box::new(message.role.clone()),
        Box::new(to_json(&message.content)?),
        Box::new(opt_to_json(&message.tool_calls)?),
        Box::new(message.reasoning_content.clone()),
        Box::new(message.tool_call_id.clone()),
        Box::new(message.is_error.map(|v| if v { 1 } else { 0 })),
        Box::new(message.elapsed_ms),
        Box::new(message.reasoning_elapsed_ms),
        Box::new(opt_to_json(&message.ui_data)?),
        Box::new(message.timestamp),
        Box::new(message.streaming.map(|v| if v { 1 } else { 0 })),
        Box::new(message.model.clone()),
        Box::new(opt_to_json(&message.usage)?),
        Box::new(message.image_vision_analyze_optimize.map(|v| if v { 1 } else { 0 })),
        Box::new(message.image_vision_analyze_result.clone()),
        // 纯文本正文：供 FTS5 索引 / LIKE 回退 / 命中片段（避免扫描 JSON 键名）
        Box::new(content_plain_text(&message.content)),
    ])
}

// ==================== SessionRepo 实现 ====================

#[async_trait]
impl SessionRepo for SqliteSessionRepo {
    async fn upsert_session(&self, session: &Session) -> Result<(), String> {
        let conn = self.conn.clone();
        let session = session.clone();
        tokio::task::spawn_blocking(move || -> Result<(), String> {
            let conn = conn.lock().unwrap();
            let params = session_insert_params(&session)?;
            conn.execute(
                r#"
INSERT INTO sessions (
  id, title, provider_config_id, model_id, system_prompt, params,
  created_at, updated_at, pinned, tags, workspace, agent_id,
  allowed_tools, skills, system_prompt_manually_edited
) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)
ON CONFLICT(id) DO UPDATE SET
  title=excluded.title,
  provider_config_id=excluded.provider_config_id,
  model_id=excluded.model_id,
  system_prompt=excluded.system_prompt,
  params=excluded.params,
  updated_at=excluded.updated_at,
  pinned=excluded.pinned,
  tags=excluded.tags,
  workspace=excluded.workspace,
  agent_id=excluded.agent_id,
  allowed_tools=excluded.allowed_tools,
  skills=excluded.skills,
  system_prompt_manually_edited=excluded.system_prompt_manually_edited
"#,
                rusqlite::params_from_iter(params.iter().map(|p| p.as_ref())),
            )
            .map_err(|e| format!("写入会话失败: {}", e))?;
            Ok(())
        })
        .await
        .map_err(|e| format!("DB task join error: {}", e))?
    }

    async fn append_messages(
        &self,
        session_id: &str,
        messages: &[Message],
    ) -> Result<(), String> {
        let conn = self.conn.clone();
        let session_id = session_id.to_string();
        let messages = messages.to_vec();
        tokio::task::spawn_blocking(move || -> Result<(), String> {
            let conn = conn.lock().unwrap();
            let tx = conn
                .unchecked_transaction()
                .map_err(|e| format!("开启事务失败: {}", e))?;
            {
                let mut stmt = tx
                    .prepare(
                        r#"
INSERT INTO messages (
  id, session_id, role, content, tool_calls, reasoning_content, tool_call_id,
  is_error, elapsed_ms, reasoning_elapsed_ms, ui_data, timestamp, streaming,
  model, usage, image_vision_analyze_optimize, image_vision_analyze_result, text_plain
) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)
ON CONFLICT(id) DO UPDATE SET
  role=excluded.role,
  content=excluded.content,
  tool_calls=excluded.tool_calls,
  reasoning_content=excluded.reasoning_content,
  tool_call_id=excluded.tool_call_id,
  is_error=excluded.is_error,
  elapsed_ms=excluded.elapsed_ms,
  reasoning_elapsed_ms=excluded.reasoning_elapsed_ms,
  ui_data=excluded.ui_data,
  timestamp=excluded.timestamp,
  streaming=excluded.streaming,
  model=excluded.model,
  usage=excluded.usage,
  image_vision_analyze_optimize=excluded.image_vision_analyze_optimize,
  image_vision_analyze_result=excluded.image_vision_analyze_result,
  text_plain=excluded.text_plain
"#,
                    )
                    .map_err(|e| format!("准备消息写入失败: {}", e))?;
                for m in &messages {
                    let params = message_insert_params(&session_id, m)?;
                    stmt.execute(rusqlite::params_from_iter(params.iter().map(|p| p.as_ref())))
                        .map_err(|e| format!("写入消息失败: {}", e))?;
                }
            }
            tx.commit().map_err(|e| format!("提交事务失败: {}", e))?;
            Ok(())
        })
        .await
        .map_err(|e| format!("DB task join error: {}", e))?
    }

    async fn replace_messages(
        &self,
        session_id: &str,
        messages: &[Message],
    ) -> Result<(), String> {
        let conn = self.conn.clone();
        let session_id = session_id.to_string();
        let messages = messages.to_vec();
        tokio::task::spawn_blocking(move || -> Result<(), String> {
            let conn = conn.lock().unwrap();
            let tx = conn
                .unchecked_transaction()
                .map_err(|e| format!("开启事务失败: {}", e))?;
            tx.execute(
                "DELETE FROM messages WHERE session_id=?1",
                params![session_id],
            )
            .map_err(|e| format!("清空消息失败: {}", e))?;
            {
                let mut stmt = tx
                    .prepare(
                        r#"
INSERT INTO messages (
  id, session_id, role, content, tool_calls, reasoning_content, tool_call_id,
  is_error, elapsed_ms, reasoning_elapsed_ms, ui_data, timestamp, streaming,
  model, usage, image_vision_analyze_optimize, image_vision_analyze_result, text_plain
) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)
"#,
                    )
                    .map_err(|e| format!("准备消息写入失败: {}", e))?;
                for m in &messages {
                    let params = message_insert_params(&session_id, m)?;
                    stmt.execute(rusqlite::params_from_iter(params.iter().map(|p| p.as_ref())))
                        .map_err(|e| format!("写入消息失败: {}", e))?;
                }
            }
            tx.commit().map_err(|e| format!("提交事务失败: {}", e))?;
            Ok(())
        })
        .await
        .map_err(|e| format!("DB task join error: {}", e))?
    }

    async fn truncate_messages_from(
        &self,
        session_id: &str,
        message_id: &str,
    ) -> Result<(), String> {
        let conn = self.conn.clone();
        let session_id = session_id.to_string();
        let message_id = message_id.to_string();
        tokio::task::spawn_blocking(move || -> Result<(), String> {
            let conn = conn.lock().unwrap();
            // 删除目标消息及其之后（rowid >= 目标）的全部消息。
            // 目标不存在时子查询为 NULL → 条件不成立 → 不删除任何行（安全幂等）。
            conn.execute(
                "DELETE FROM messages \
                 WHERE session_id=?1 \
                   AND rowid >= (SELECT rowid FROM messages WHERE id=?2 AND session_id=?1)",
                params![session_id, message_id],
            )
            .map_err(|e| format!("删除消息失败: {}", e))?;
            Ok(())
        })
        .await
        .map_err(|e| format!("DB task join error: {}", e))?
    }

    async fn list_sessions(&self) -> Result<Vec<Session>, String> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> Result<Vec<Session>, String> {
            let conn = conn.lock().unwrap();
            let mut stmt = conn
                .prepare("SELECT * FROM sessions ORDER BY updated_at DESC")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |row| session_from_row(row).map_err(row_err))
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| format!("DB task join error: {}", e))?
    }

    async fn get_session(&self, session_id: &str) -> Result<Option<Session>, String> {
        let conn = self.conn.clone();
        let session_id = session_id.to_string();
        tokio::task::spawn_blocking(move || -> Result<Option<Session>, String> {
            let conn = conn.lock().unwrap();
            let mut stmt = conn
                .prepare("SELECT * FROM sessions WHERE id=?1")
                .map_err(|e| e.to_string())?;
            let mut rows = stmt
                .query_map(params![session_id], |row| {
                    session_from_row(row).map_err(row_err)
                })
                .map_err(|e| e.to_string())?;
            rows.next().transpose().map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| format!("DB task join error: {}", e))?
    }

    async fn get_messages(&self, session_id: &str) -> Result<Vec<Message>, String> {
        let conn = self.conn.clone();
        let session_id = session_id.to_string();
        tokio::task::spawn_blocking(move || -> Result<Vec<Message>, String> {
            let conn = conn.lock().unwrap();
            let mut stmt = conn
                .prepare("SELECT * FROM messages WHERE session_id=?1 ORDER BY rowid ASC")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![session_id], |row| {
                    message_from_row(row).map_err(row_err)
                })
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| format!("DB task join error: {}", e))?
    }

    async fn get_message_page(
        &self,
        session_id: &str,
        limit: usize,
        before_rowid: Option<i64>,
    ) -> Result<MessagePage, String> {
        let conn = self.conn.clone();
        let session_id = session_id.to_string();
        let limit = limit.max(1);
        tokio::task::spawn_blocking(move || -> Result<MessagePage, String> {
            let conn = conn.lock().unwrap();
            // 多取 1 条用于判断「是否还有更早的消息」
            let probe = (limit + 1) as i64;
            let mut rows_buf: Vec<(i64, Message)> = Vec::new();
            match before_rowid {
                Some(before) => {
                    let mut stmt = conn
                        .prepare(
                            "SELECT rowid AS message_rowid, * FROM messages \
                             WHERE session_id=?1 AND rowid < ?2 ORDER BY rowid DESC LIMIT ?3",
                        )
                        .map_err(|e| format!("准备分页查询失败: {}", e))?;
                    let rows = stmt
                        .query_map(params![session_id, before, probe], |row| {
                            message_from_row_with_id(row).map_err(row_err)
                        })
                        .map_err(|e| e.to_string())?;
                    for r in rows {
                        rows_buf.push(r.map_err(|e| e.to_string())?);
                    }
                }
                None => {
                    let mut stmt = conn
                        .prepare(
                            "SELECT rowid AS message_rowid, * FROM messages \
                             WHERE session_id=?1 ORDER BY rowid DESC LIMIT ?2",
                        )
                        .map_err(|e| format!("准备分页查询失败: {}", e))?;
                    let rows = stmt
                        .query_map(params![session_id, probe], |row| {
                            message_from_row_with_id(row).map_err(row_err)
                        })
                        .map_err(|e| e.to_string())?;
                    for r in rows {
                        rows_buf.push(r.map_err(|e| e.to_string())?);
                    }
                }
            }
            let has_more = rows_buf.len() > limit;
            if has_more {
                rows_buf.truncate(limit);
            }
            // 查询为 rowid DESC（新→旧），反转为升序（旧→新）
            rows_buf.reverse();
            let oldest_rowid = rows_buf.first().map(|(rid, _)| *rid);
            Ok(MessagePage {
                messages: rows_buf.into_iter().map(|(_, m)| m).collect(),
                has_more,
                oldest_rowid,
            })
        })
        .await
        .map_err(|e| format!("DB task join error: {}", e))?
    }

    async fn get_user_message_refs(
        &self,
        session_id: &str,
    ) -> Result<Vec<UserMessageRef>, String> {
        let conn = self.conn.clone();
        let session_id = session_id.to_string();
        tokio::task::spawn_blocking(move || -> Result<Vec<UserMessageRef>, String> {
            let conn = conn.lock().unwrap();
            let mut stmt = conn
                .prepare(
                    "SELECT id, content FROM messages \
                     WHERE session_id=?1 AND role='user' ORDER BY rowid ASC",
                )
                .map_err(|e| format!("准备用户消息索引查询失败: {}", e))?;
            let rows = stmt
                .query_map(params![session_id], |row| {
                    let id: String = row.get("id")?;
                    let content_json: String = row.get("content")?;
                    let content: serde_json::Value = serde_json::from_str(&content_json)
                        .map_err(|e| row_err(format!("反序列化消息内容失败: {}", e)))?;
                    Ok(UserMessageRef {
                        id,
                        preview: content_text_preview(&content, 420),
                    })
                })
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| format!("DB task join error: {}", e))?
    }

    async fn get_message_window(
        &self,
        session_id: &str,
        anchor_id: Option<&str>,
        anchor_seq: Option<i64>,
        before: usize,
        after: usize,
    ) -> Result<MessageWindow, String> {
        let conn = self.conn.clone();
        let session_id = session_id.to_string();
        let anchor_id = anchor_id.map(|s| s.to_string());
        let (before, after) = clamp_window(before, after);
        tokio::task::spawn_blocking(move || -> Result<MessageWindow, String> {
            let conn = conn.lock().unwrap();
            let total = session_message_count(&conn, &session_id)?;
            let boundary = boundary_seq(&conn, &session_id)?;
            // 可查询区间的最后一条时序（无 summary → 该区间为空）
            let last_queryable = boundary.map(|b| b - 1).unwrap_or(0);

            // 解析锚点时序（优先 id，其次 seq；都不传则取区间最新一条）
            let mut anchor_found = true;
            let anchor: i64 = if let Some(id) = anchor_id.as_deref() {
                let rid: Option<i64> = conn
                    .query_row(
                        "SELECT rowid FROM messages WHERE session_id=?1 AND id=?2",
                        params![session_id, id],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(|e| format!("查询锚点消息失败: {}", e))?;
                match rid {
                    None => {
                        anchor_found = false;
                        0
                    }
                    Some(r) => seq_of_rowid(&conn, &session_id, r)?,
                }
            } else if let Some(s) = anchor_seq {
                if s >= 1 && s <= total {
                    s
                } else {
                    anchor_found = false;
                    0
                }
            } else {
                last_queryable
            };

            // 锚点未找到 / 区间为空 / 锚点落在「已在上下文」的区间 → 返回空窗口
            // （由调用方转成提示，不当成错误）
            if !anchor_found || last_queryable < 1 || anchor < 1 || anchor > last_queryable {
                return Ok(MessageWindow {
                    anchor_found,
                    anchor_seq: anchor.max(0),
                    start_seq: 0,
                    end_seq: 0,
                    total,
                    boundary_seq: boundary,
                    clamped_by_boundary: true,
                    messages: Vec::new(),
                });
            }

            let start = (anchor - before as i64).max(1);
            let mut end = anchor + after as i64;
            let mut clamped = false;
            if end > last_queryable {
                end = last_queryable;
                clamped = true;
            }

            let messages = fetch_message_briefs(&conn, &session_id, start, end)?;
            Ok(MessageWindow {
                anchor_found: true,
                anchor_seq: anchor,
                start_seq: start,
                end_seq: end,
                total,
                boundary_seq: boundary,
                clamped_by_boundary: clamped,
                messages,
            })
        })
        .await
        .map_err(|e| format!("DB task join error: {}", e))?
    }

    async fn get_message_timeline(
        &self,
        session_id: &str,
        keyword: Option<&str>,
        before_seq: Option<i64>,
        limit: usize,
    ) -> Result<MessageTimelinePage, String> {
        let conn = self.conn.clone();
        let session_id = session_id.to_string();
        let keyword = keyword
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let limit = limit.clamp(1, MSG_QUERY_MAX_LIMIT);
        tokio::task::spawn_blocking(move || -> Result<MessageTimelinePage, String> {
            let conn = conn.lock().unwrap();
            let total = session_message_count(&conn, &session_id)?;
            let boundary = boundary_seq(&conn, &session_id)?;
            let last_queryable = boundary.map(|b| b - 1).unwrap_or(0);
            if last_queryable < 1 {
                return Ok(MessageTimelinePage {
                    items: Vec::new(),
                    has_more: false,
                    next_cursor: None,
                    total,
                    boundary_seq: boundary,
                });
            }

            // 全部匿名 `?`：与 args 压入顺序严格一致
            let mut sql = String::from(
                "WITH ordered AS ( \
                   SELECT rowid AS rid, ROW_NUMBER() OVER (ORDER BY rowid) AS idx \
                   FROM messages WHERE session_id = ? \
                 ) \
                 SELECT m.id AS id, m.role AS role, m.tool_calls AS tool_calls, \
                        m.timestamp AS timestamp, o.idx AS idx, \
                        COALESCE(m.text_plain, '') AS text_plain \
                 FROM ordered o JOIN messages m ON m.rowid = o.rid \
                 WHERE o.idx <= ?",
            );
            let mut args: Vec<Box<dyn rusqlite::ToSql>> =
                vec![Box::new(session_id.clone()), Box::new(last_queryable)];
            if let Some(cursor) = before_seq {
                sql.push_str(" AND o.idx < ?");
                args.push(Box::new(cursor));
            }
            if let Some(kw) = &keyword {
                // 转义 LIKE 通配符，避免关键词里的 % _ \ 改变语义
                let escaped = kw
                    .replace('\\', "\\\\")
                    .replace('%', "\\%")
                    .replace('_', "\\_");
                sql.push_str(" AND COALESCE(m.text_plain, '') LIKE ? ESCAPE '\\'");
                args.push(Box::new(format!("%{}%", escaped)));
            }
            sql.push_str(" ORDER BY o.idx DESC LIMIT ?");
            args.push(Box::new((limit + 1) as i64));

            let mut stmt = conn
                .prepare(&sql)
                .map_err(|e| format!("准备消息时序查询失败: {}", e))?;
            let rows = stmt
                .query_map(
                    rusqlite::params_from_iter(args.iter().map(|p| p.as_ref())),
                    |row| {
                        let text_plain: String = row.get("text_plain")?;
                        let (preview, _) =
                            truncate_with_flag(&text_plain, MSG_QUERY_PREVIEW_MAX_CHARS);
                        let mut tool_names: Vec<String> = Vec::new();
                        if let Some(json) = row.get::<_, Option<String>>("tool_calls")? {
                            if let Ok(list) = serde_json::from_str::<
                                Vec<crate::agent::types::ToolUseContent>,
                            >(&json)
                            {
                                tool_names = list.into_iter().map(|t| t.name).collect();
                            }
                        }
                        Ok(MessageTimelineItem {
                            seq: row.get("idx")?,
                            id: row.get("id")?,
                            role: row.get("role")?,
                            timestamp: row.get("timestamp")?,
                            preview,
                            tool_names,
                        })
                    },
                )
                .map_err(|e| e.to_string())?;
            let mut items: Vec<MessageTimelineItem> = Vec::new();
            for r in rows {
                items.push(r.map_err(|e| e.to_string())?);
            }
            let has_more = items.len() > limit;
            if has_more {
                items.truncate(limit);
            }
            // 查询为时序倒序 → 反转为升序（与 read 工具一致，便于模型阅读）
            items.reverse();
            let next_cursor = if has_more {
                items.first().map(|i| i.seq)
            } else {
                None
            };
            Ok(MessageTimelinePage {
                items,
                has_more,
                next_cursor,
                total,
                boundary_seq: boundary,
            })
        })
        .await
        .map_err(|e| format!("DB task join error: {}", e))?
    }

    async fn search_messages(
        &self,
        query: &str,
        session_id: Option<&str>,
        role: Option<&str>,
        limit: usize,
        cursor: Option<SearchCursor>,
    ) -> Result<MessageSearchPage, String> {
        let conn = self.conn.clone();
        // 空查询 = 不按关键词过滤，直接返回最新消息（见下方分支）。
        let query = query.trim().to_string();
        let session_id = session_id.map(|s| s.to_string());
        let role = role.map(|s| s.to_string());
        let limit = limit.max(1);
        // 迁移是否完成：未完成时 text_plain 尚未回填，检索需回退到旧的 content 路径
        let migrated = self.migration_done.load(Ordering::Acquire);
        tokio::task::spawn_blocking(move || -> Result<MessageSearchPage, String> {
            let conn = conn.lock().unwrap();

            // 空查询不做关键词过滤（返回最新消息）；非空查询再按长度分流：
            // ≥3 字符走 FTS5（trigram，走索引）；更短的查询 trigram 无法命中，
            // 回退到对纯文本列 `text_plain` 的 LIKE —— 短查询虽仍是扫描，但已不再误命中 JSON 键名。
            // 迁移未完成时改走 COALESCE(text_plain, content) 的 LIKE（见下方分支），短查询仍可命中。
            let has_query = !query.is_empty();
            let use_fts = has_query && migrated && query.chars().count() >= 3;

            // 目标条数：多取 1 条以判断是否还有下一页；正文为空的行会被跳过，
            // 因此可能需要向后多扫几批才能凑够一页（见下方循环）。
            let want = limit + 1;
            let mut collected: Vec<(MessageSearchItem, i64)> = Vec::new();
            let mut scan = cursor;

            loop {
                let remaining = want - collected.len();
                if remaining == 0 {
                    break;
                }

                // 匿名 `?` 按出现顺序编号，参数顺序与拼接顺序严格一致
                let mut sql: String;
                let mut args: Vec<Box<dyn rusqlite::ToSql>>;
                if use_fts {
                    // 整体加引号作为短语查询；内部双引号翻倍转义，避免 FTS5 语法注入
                    let fts_query = format!("\"{}\"", query.replace('"', "\"\""));
                    sql = String::from(
                        "SELECT m.id AS id, m.session_id AS session_id, m.role AS role, \
                         m.text_plain AS text_plain, m.content AS content, m.timestamp AS timestamp, \
                         m.rowid AS message_rowid, \
                         s.title AS session_title, s.workspace AS workspace, s.agent_id AS agent_id \
                         FROM messages_fts \
                         JOIN messages m ON m.rowid = messages_fts.rowid \
                         JOIN sessions s ON s.id = m.session_id \
                         WHERE messages_fts MATCH ?",
                    );
                    args = vec![Box::new(fts_query)];
                } else if has_query {
                    // LIKE 模式：转义 % _ \ ，避免用户输入里的通配符改变语义
                    let escaped = query
                        .replace('\\', "\\\\")
                        .replace('%', "\\%")
                        .replace('_', "\\_");
                    let like = format!("%{}%", escaped);
                    // 优先匹配纯文本列；仅「未回填的旧行」text_plain 为 NULL →
                    // 才回退到 content（否则那部分行会完全搜不到）。
                    sql = String::from(
                        "SELECT m.id AS id, m.session_id AS session_id, m.role AS role, \
                         m.text_plain AS text_plain, m.content AS content, m.timestamp AS timestamp, \
                         m.rowid AS message_rowid, \
                         s.title AS session_title, s.workspace AS workspace, s.agent_id AS agent_id \
                         FROM messages m JOIN sessions s ON s.id = m.session_id \
                         WHERE COALESCE(m.text_plain, m.content) LIKE ? ESCAPE '\\'",
                    );
                    args = vec![Box::new(like)];
                } else {
                    // 空查询：不做关键词过滤，仅按 role / session / 游标取最新消息。
                    sql = String::from(
                        "SELECT m.id AS id, m.session_id AS session_id, m.role AS role, \
                         m.text_plain AS text_plain, m.content AS content, m.timestamp AS timestamp, \
                         m.rowid AS message_rowid, \
                         s.title AS session_title, s.workspace AS workspace, s.agent_id AS agent_id \
                         FROM messages m JOIN sessions s ON s.id = m.session_id \
                         WHERE 1=1",
                    );
                    args = Vec::new();
                }
                // 先剔除「非 NULL 的空 / 空白」（如 '' / 纯空白）；
                // text_plain 为 NULL 的历史行交给下方 Rust 侧按实际正文判定。
                sql.push_str(
                    " AND (m.text_plain IS NULL OR \
                     LENGTH(TRIM(m.text_plain, char(32,9,10,13))) > 0)",
                );
                match role.as_deref() {
                    Some(r) => {
                        sql.push_str(" AND m.role = ?");
                        args.push(Box::new(r.to_string()));
                    }
                    // 未指定角色时只检索聊天列表真正展示的两类，排除 tool / summary / feedback
                    None => sql.push_str(" AND m.role IN ('user','assistant')"),
                }
                if let Some(sid) = session_id.as_deref() {
                    sql.push_str(" AND m.session_id = ?");
                    args.push(Box::new(sid.to_string()));
                }
                // keyset 游标：只取「严格排在已扫描最后一条之后」的消息（同一 timestamp 用 rowid 破平）
                if let Some(c) = scan {
                    sql.push_str(" AND (m.timestamp < ? OR (m.timestamp = ? AND m.rowid < ?))");
                    args.push(Box::new(c.timestamp));
                    args.push(Box::new(c.timestamp));
                    args.push(Box::new(c.rowid));
                }
                sql.push_str(" ORDER BY m.timestamp DESC, m.rowid DESC LIMIT ?");
                args.push(Box::new(remaining as i64));

                let mut stmt = conn
                    .prepare(&sql)
                    .map_err(|e| format!("准备检索查询失败: {}", e))?;
                let rows = stmt
                    .query_map(
                        rusqlite::params_from_iter(args.iter().map(|p| p.as_ref())),
                        |row| {
                            // text_plain 为新列（迁移后必有值）；为空时兜底从 content 提取
                            let plain: Option<String> = row.get("text_plain")?;
                            let plain = match plain {
                                Some(t) => t,
                                None => {
                                    let content_json: String = row.get("content")?;
                                    let content: serde_json::Value =
                                        serde_json::from_str(&content_json).map_err(|e| {
                                            row_err(format!("反序列化消息内容失败: {}", e))
                                        })?;
                                    content_plain_text(&content)
                                }
                            };
                            // 正文为空（含纯空白）→ 仅做思考 / 工具调用，不纳入检索
                            let blank = plain.trim().is_empty();
                            let rowid: i64 = row.get("message_rowid")?;
                            let item = MessageSearchItem {
                                id: row.get("id")?,
                                session_id: row.get("session_id")?,
                                role: row.get("role")?,
                                text: search_snippet_text(&plain, &query, 200),
                                timestamp: row.get("timestamp")?,
                                session_title: row.get("session_title")?,
                                workspace: row.get("workspace")?,
                                agent_id: row.get("agent_id")?,
                                // 工具名在下方按 rowid 反查后才回填
                                tool_name: None,
                            };
                            Ok((item, rowid, blank))
                        },
                    )
                    .map_err(|e| e.to_string())?;
                let mut raw: Vec<(MessageSearchItem, i64, bool)> = Vec::new();
                for r in rows {
                    raw.push(r.map_err(|e| e.to_string())?);
                }
                if raw.is_empty() {
                    break;
                }
                let scanned = raw.len();
                // 游标推进到本批扫到的最后一行，下一批从它之后继续（不重复扫描）
                if let Some((it, rid, _)) = raw.last() {
                    scan = Some(SearchCursor {
                        timestamp: it.timestamp,
                        rowid: *rid,
                    });
                }
                for (item, rid, blank) in raw {
                    if !blank {
                        collected.push((item, rid));
                    }
                }
                // 本批没取满 → 后面没有更多行了
                if scanned < remaining {
                    break;
                }
            }

            let has_more = collected.len() > limit;
            if has_more {
                collected.truncate(limit);
            }
            let next_cursor = if has_more {
                collected.last().map(|(it, rid)| SearchCursor {
                    timestamp: it.timestamp,
                    rowid: *rid,
                })
            } else {
                None
            };
            // tool 结果行反查工具名：前端据此在命中条目前展示「查看文件 / 编辑文件」等标签
            let items = collected
                .into_iter()
                .map(|(mut it, rid)| {
                    if it.role == "tool" {
                        let name = tool_name_of_tool_message(&conn, &it.session_id, rid);
                        it.tool_name = name;
                    }
                    it
                })
                .collect();
            Ok(MessageSearchPage {
                items,
                has_more,
                next_cursor,
            })
        })
        .await
        .map_err(|e| format!("DB task join error: {}", e))?
    }

    async fn delete_session(&self, session_id: &str) -> Result<(), String> {
        let conn = self.conn.clone();
        let session_id = session_id.to_string();
        tokio::task::spawn_blocking(move || -> Result<(), String> {
            let conn = conn.lock().unwrap();
            let tx = conn
                .unchecked_transaction()
                .map_err(|e| format!("开启事务失败: {}", e))?;
            tx.execute(
                "DELETE FROM messages WHERE session_id=?1",
                params![session_id],
            )
            .map_err(|e| format!("删除消息失败: {}", e))?;
            tx.execute("DELETE FROM sessions WHERE id=?1", params![session_id])
                .map_err(|e| format!("删除会话失败: {}", e))?;
            // ⚠️ 刻意**不**删除 usage_ledger 中该会话的流水：
            // 用量是「已发生过的消费」的事实记录，删会话只删对话内容。
            // 标题在明细里 JOIN 不到时显示为「已删除会话」，总量不会缩水（见 docs/token-usage-stats.md）。
            tx.commit().map_err(|e| format!("提交事务失败: {}", e))?;
            Ok(())
        })
        .await
        .map_err(|e| format!("DB task join error: {}", e))?
    }

    // ===== 用量账本（token 统计） =====

    async fn append_usage(&self, entries: &[UsageEntry]) -> Result<(), String> {
        if entries.is_empty() {
            return Ok(());
        }
        let conn = self.conn.clone();
        let entries = entries.to_vec();
        tokio::task::spawn_blocking(move || -> Result<(), String> {
            let conn = conn.lock().unwrap();
            let tx = conn
                .unchecked_transaction()
                .map_err(|e| format!("开启事务失败: {}", e))?;
            {
                let mut stmt = tx
                    .prepare(
                        r#"
INSERT OR IGNORE INTO usage_ledger (
  ts, session_id, message_id, model, provider_type, provider_config_id,
  kind, round, prompt_tokens, completion_tokens, cached_tokens, total_tokens,
  estimated, trace_id
) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)
"#,
                    )
                    .map_err(|e| format!("准备用量写入失败: {}", e))?;
                for e in &entries {
                    stmt.execute(params![
                        e.ts.unwrap_or_else(crate::telemetry::now_ms),
                        e.session_id,
                        e.message_id,
                        e.model,
                        e.provider_type,
                        e.provider_config_id,
                        e.kind,
                        e.round,
                        e.prompt_tokens,
                        e.completion_tokens,
                        e.cached_tokens,
                        e.total_tokens,
                        e.estimated as i64,
                        e.trace_id,
                    ])
                    .map_err(|err| format!("写入用量流水失败: {}", err))?;
                }
            }
            tx.commit().map_err(|e| format!("提交事务失败: {}", e))?;
            Ok(())
        })
        .await
        .map_err(|e| format!("DB task join error: {}", e))?
    }

    async fn usage_stats(&self, query: &UsageQuery) -> Result<UsageStats, String> {
        let conn = self.conn.clone();
        let query = query.clone();
        tokio::task::spawn_blocking(move || -> Result<UsageStats, String> {
            let conn = conn.lock().unwrap();
            let (where_sql, filter_params) = usage_where(&query, "usage_ledger");
            let key_expr = usage_group_expr(query.group_by.as_deref());

            // 分桶聚合
            let sql = format!(
                r#"
SELECT {key_expr} AS bucket_key,
       COALESCE(SUM(prompt_tokens), 0),
       COALESCE(SUM(completion_tokens), 0),
       COALESCE(SUM(cached_tokens), 0),
       COALESCE(SUM(total_tokens), 0),
       COUNT(*),
       COALESCE(SUM(estimated), 0)
FROM usage_ledger{where_sql}
GROUP BY bucket_key
ORDER BY bucket_key ASC
"#
            );
            let mut buckets: Vec<UsageBucket> = Vec::new();
            {
                let mut stmt = conn
                    .prepare(&sql)
                    .map_err(|e| format!("准备用量聚合失败: {}", e))?;
                let rows = stmt
                    .query_map(
                        rusqlite::params_from_iter(filter_params.iter().map(|p| p.as_ref())),
                        |row| {
                            Ok(UsageBucket {
                                key: row.get::<_, Option<String>>(0)?.unwrap_or_default(),
                                prompt_tokens: row.get(1)?,
                                completion_tokens: row.get(2)?,
                                cached_tokens: row.get(3)?,
                                total_tokens: row.get(4)?,
                                calls: row.get(5)?,
                                estimated_calls: row.get(6)?,
                            })
                        })
                    .map_err(|e| e.to_string())?;
                for b in rows {
                    buckets.push(b.map_err(|e| e.to_string())?);
                }
            }

            // 合计（不受分组 / 分页影响）
            let totals_sql = format!(
                r#"
SELECT COALESCE(SUM(prompt_tokens), 0),
       COALESCE(SUM(completion_tokens), 0),
       COALESCE(SUM(cached_tokens), 0),
       COALESCE(SUM(total_tokens), 0),
       COUNT(*),
       COALESCE(SUM(estimated), 0)
FROM usage_ledger{where_sql}
"#
            );
            let totals = conn
                .query_row(
                    &totals_sql,
                    rusqlite::params_from_iter(filter_params.iter().map(|p| p.as_ref())),
                    |row| {
                        Ok(UsageBucket {
                            key: String::new(),
                            prompt_tokens: row.get(0)?,
                            completion_tokens: row.get(1)?,
                            cached_tokens: row.get(2)?,
                            total_tokens: row.get(3)?,
                            calls: row.get(4)?,
                            estimated_calls: row.get(5)?,
                        })
                    },
                )
                .map_err(|e| format!("读取用量合计失败: {}", e))?;

            // 账本数据覆盖范围（不看过滤条件，供 UI 提示「数据自 X 起」）
            let (first_ts, last_ts): (Option<i64>, Option<i64>) = conn
                .query_row("SELECT MIN(ts), MAX(ts) FROM usage_ledger", [], |row| {
                    Ok((row.get(0)?, row.get(1)?))
                })
                .unwrap_or((None, None));

            Ok(UsageStats {
                buckets,
                totals,
                first_ts,
                last_ts,
            })
        })
        .await
        .map_err(|e| format!("DB task join error: {}", e))?
    }

    async fn usage_records(&self, query: &UsageQuery) -> Result<UsageRecordPage, String> {
        let conn = self.conn.clone();
        let query = query.clone();
        tokio::task::spawn_blocking(move || -> Result<UsageRecordPage, String> {
            let conn = conn.lock().unwrap();
            let (where_sql, filter_params) = usage_where(&query, "u");
            let limit = query.limit.unwrap_or(200).clamp(1, 5000) as i64;
            let offset = query.offset.unwrap_or(0) as i64;

            // ⚠️ COUNT 的表**必须与 `usage_where` 用的别名一致**：过滤条件里的列都写成
            // `u.ts` / `u.session_id`（明细查询有 JOIN，必须带前缀）。若这里写
            // `FROM usage_ledger`（无别名），只要带了任何过滤条件，SQLite 就会报
            // `no such column: u.ts` → 明细与 CSV 导出在「今日 / 近 7 天 / 近 30 天」下
            // 全部空白（只有「全部」不过滤才正常）。
            let total: i64 = conn
                .query_row(
                    &format!("SELECT COUNT(*) FROM usage_ledger u{where_sql}"),
                    rusqlite::params_from_iter(filter_params.iter().map(|p| p.as_ref())),
                    |row| row.get(0),
                )
                .map_err(|e| format!("读取用量条数失败: {}", e))?;

            // 会话标题在会话已删除时为 NULL（流水保留，标题置空）
            let sql = format!(
                r#"
SELECT u.id, u.ts, u.session_id, s.title, u.message_id, u.model,
       u.provider_type, u.provider_config_id, u.kind, u.round,
       u.prompt_tokens, u.completion_tokens, u.cached_tokens, u.total_tokens,
       u.estimated, u.trace_id
FROM usage_ledger u
LEFT JOIN sessions s ON s.id = u.session_id{where_sql}
ORDER BY u.ts DESC, u.id DESC
LIMIT ?{limit_idx} OFFSET ?{offset_idx}
"#,
                limit_idx = filter_params.len() + 1,
                offset_idx = filter_params.len() + 2,
            );
            let mut all_params = filter_params;
            all_params.push(Box::new(limit));
            all_params.push(Box::new(offset));

            let mut records: Vec<UsageRecord> = Vec::new();
            {
                let mut stmt = conn
                    .prepare(&sql)
                    .map_err(|e| format!("准备用量明细查询失败: {}", e))?;
                let rows = stmt
                    .query_map(
                        rusqlite::params_from_iter(all_params.iter().map(|p| p.as_ref())),
                        |row| {
                            Ok(UsageRecord {
                                id: row.get(0)?,
                                ts: row.get(1)?,
                                session_id: row.get(2)?,
                                session_title: row.get(3)?,
                                message_id: row.get(4)?,
                                model: row.get(5)?,
                                provider_type: row.get(6)?,
                                provider_config_id: row.get(7)?,
                                kind: row.get(8)?,
                                round: row.get(9)?,
                                prompt_tokens: row.get(10)?,
                                completion_tokens: row.get(11)?,
                                cached_tokens: row.get(12)?,
                                total_tokens: row.get(13)?,
                                estimated: row.get::<_, i64>(14)? != 0,
                                trace_id: row.get(15)?,
                            })
                        })
                    .map_err(|e| e.to_string())?;
                for r in rows {
                    records.push(r.map_err(|e| e.to_string())?);
                }
            }
            Ok(UsageRecordPage { records, total })
        })
        .await
        .map_err(|e| format!("DB task join error: {}", e))?
    }

    async fn clear_usage(&self) -> Result<i64, String> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> Result<i64, String> {
            let conn = conn.lock().unwrap();
            let n = conn
                .execute("DELETE FROM usage_ledger", [])
                .map_err(|e| format!("清空用量账本失败: {}", e))?;
            Ok(n as i64)
        })
        .await
        .map_err(|e| format!("DB task join error: {}", e))?
    }
}

// ==================== 初始化 ====================

/// 初始化 SQLite 会话存储（应用启动时调用），返回可管理的 repo
pub fn init_session_db(
    app: &tauri::AppHandle,
) -> Result<Arc<dyn SessionRepo>, String> {
    use tauri::Manager;
    let data_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."));
    let db_path = data_dir.join("virlen.db");
    let repo = Arc::new(SqliteSessionRepo::open(&db_path)?);
    // 历史数据迁移（回填 text_plain + 重建 FTS 索引）放后台执行，避免超大库首次启动卡顿。
    // 迁移完成前，检索自动回退到旧的 LIKE content 路径，结果依然正确。
    if !repo.migration_done() {
        let r = repo.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = r.migrate().await {
                eprintln!("[session_db] 后台迁移失败（检索将暂时回退旧路径）: {}", e);
            }
        });
    }
    Ok(repo)
}

// ==================== Tauri 命令 ====================

/// 记录一次 SQLite 操作（§12.13 rust.db.op / rust.db.error）
fn track_db(
    op: &str,
    session_id: Option<&str>,
    started: i64,
    rows: Option<usize>,
    error: Option<&str>,
) {
    let mut props = serde_json::json!({
        "op": op,
        "duration_ms": crate::telemetry::now_ms() - started,
        "status": if error.is_some() { "fail" } else { "success" },
    });
    if let Some(map) = props.as_object_mut() {
        if let Some(id) = session_id {
            map.insert(
                "session_id".into(),
                serde_json::json!(crate::telemetry::hash_id(id)),
            );
        }
        if let Some(r) = rows {
            map.insert("rows".into(), serde_json::json!(r));
        }
    }
    crate::telemetry::track("rust.db.op", props);
    if let Some(e) = error {
        crate::telemetry::track(
            "rust.db.error",
            serde_json::json!({ "op": op, "error": e }),
        );
    }
}

/// 列出所有会话（不含 messages）
#[tauri::command]
pub async fn cmd_list_sessions(
    state: tauri::State<'_, Arc<dyn SessionRepo>>,
) -> Result<Vec<Session>, String> {
    let started = crate::telemetry::now_ms();
    let result = state.list_sessions().await;
    track_db(
        "list",
        None,
        started,
        result.as_ref().ok().map(|v| v.len()),
        result.as_ref().err().map(|s| s.as_str()),
    );
    result
}

/// 获取单个会话元数据
#[tauri::command]
pub async fn cmd_get_session(
    state: tauri::State<'_, Arc<dyn SessionRepo>>,
    session_id: String,
) -> Result<Option<Session>, String> {
    let started = crate::telemetry::now_ms();
    let result = state.get_session(&session_id).await;
    track_db(
        "get_session",
        Some(&session_id),
        started,
        result.as_ref().ok().map(|o| o.is_some() as usize),
        result.as_ref().err().map(|s| s.as_str()),
    );
    result
}

/// 获取会话的全部消息
#[tauri::command]
pub async fn cmd_get_messages(
    state: tauri::State<'_, Arc<dyn SessionRepo>>,
    session_id: String,
) -> Result<Vec<Message>, String> {
    let started = crate::telemetry::now_ms();
    let result = state.get_messages(&session_id).await;
    track_db(
        "get_messages",
        Some(&session_id),
        started,
        result.as_ref().ok().map(|v| v.len()),
        result.as_ref().err().map(|s| s.as_str()),
    );
    result
}

/// 分页获取会话消息（尾部窗口加载：只取最近 N 条，向上滚动时按 before_rowid 回补）
#[tauri::command]
pub async fn cmd_get_message_page(
    state: tauri::State<'_, Arc<dyn SessionRepo>>,
    session_id: String,
    limit: Option<usize>,
    before_rowid: Option<i64>,
) -> Result<MessagePage, String> {
    let started = crate::telemetry::now_ms();
    let limit = limit.unwrap_or(60).clamp(1, 1000);
    let result = state.get_message_page(&session_id, limit, before_rowid).await;
    track_db(
        "get_messages_page",
        Some(&session_id),
        started,
        result.as_ref().ok().map(|p| p.messages.len()),
        result.as_ref().err().map(|s| s.as_str()),
    );
    result
}

/// 消息查询工具：按锚点（id / seq）取时序窗口（只覆盖「已压缩区间」）
#[tauri::command]
pub async fn cmd_get_message_window(
    state: tauri::State<'_, Arc<dyn SessionRepo>>,
    session_id: String,
    anchor_id: Option<String>,
    anchor_seq: Option<i64>,
    before: Option<usize>,
    after: Option<usize>,
) -> Result<MessageWindow, String> {
    let started = crate::telemetry::now_ms();
    let before = before.unwrap_or(5);
    let after = after.unwrap_or(5);
    let result = state
        .get_message_window(&session_id, anchor_id.as_deref(), anchor_seq, before, after)
        .await;
    track_db(
        "get_message_window",
        Some(&session_id),
        started,
        result.as_ref().ok().map(|w| w.messages.len()),
        result.as_ref().err().map(|s| s.as_str()),
    );
    result
}

/// 消息查询工具：列出「已压缩区间」的消息时序（可按关键词过滤 / 向前翻页）
#[tauri::command]
pub async fn cmd_get_message_timeline(
    state: tauri::State<'_, Arc<dyn SessionRepo>>,
    session_id: String,
    keyword: Option<String>,
    before_seq: Option<i64>,
    limit: Option<usize>,
) -> Result<MessageTimelinePage, String> {
    let started = crate::telemetry::now_ms();
    let limit = limit.unwrap_or(30).clamp(1, MSG_QUERY_MAX_LIMIT);
    let result = state
        .get_message_timeline(&session_id, keyword.as_deref(), before_seq, limit)
        .await;
    track_db(
        "get_message_timeline",
        Some(&session_id),
        started,
        result.as_ref().ok().map(|p| p.items.len()),
        result.as_ref().err().map(|s| s.as_str()),
    );
    result
}

/// 获取会话内全部用户消息的轻量索引（右侧锚点列表用，不含 AI / 工具正文）
#[tauri::command]
pub async fn cmd_get_user_message_refs(
    state: tauri::State<'_, Arc<dyn SessionRepo>>,
    session_id: String,
) -> Result<Vec<UserMessageRef>, String> {
    let started = crate::telemetry::now_ms();
    let result = state.get_user_message_refs(&session_id).await;
    track_db(
        "get_user_message_refs",
        Some(&session_id),
        started,
        result.as_ref().ok().map(|v| v.len()),
        result.as_ref().err().map(|s| s.as_str()),
    );
    result
}

/// 检索消息（会话内 / 跨会话，分页）
#[tauri::command]
pub async fn cmd_search_messages(
    state: tauri::State<'_, Arc<dyn SessionRepo>>,
    query: String,
    session_id: Option<String>,
    role: Option<String>,
    limit: Option<usize>,
    cursor: Option<SearchCursor>,
) -> Result<MessageSearchPage, String> {
    let started = crate::telemetry::now_ms();
    let limit = limit.unwrap_or(40).clamp(1, 200);
    let result = state
        .search_messages(&query, session_id.as_deref(), role.as_deref(), limit, cursor)
        .await;
    track_db(
        "search_messages",
        session_id.as_deref(),
        started,
        result.as_ref().ok().map(|p| p.items.len()),
        result.as_ref().err().map(|s| s.as_str()),
    );
    result
}

/// 写入/更新会话元数据（前端创建/改名/pin 时调用）
#[tauri::command]
pub async fn cmd_upsert_session(
    state: tauri::State<'_, Arc<dyn SessionRepo>>,
    session: Session,
) -> Result<(), String> {
    let started = crate::telemetry::now_ms();
    let result = state.upsert_session(&session).await;
    track_db(
        "upsert",
        Some(&session.id),
        started,
        None,
        result.as_ref().err().map(|s| s.as_str()),
    );
    result
}

/// 删除会话及其消息
#[tauri::command]
pub async fn cmd_delete_session(
    state: tauri::State<'_, Arc<dyn SessionRepo>>,
    session_id: String,
) -> Result<(), String> {
    let started = crate::telemetry::now_ms();
    let result = state.delete_session(&session_id).await;
    track_db(
        "delete",
        Some(&session_id),
        started,
        None,
        result.as_ref().err().map(|s| s.as_str()),
    );
    result
}

/// 整批替换会话的全部消息（前端上下文压缩等全量替换场景）
/// ⚠️ 不刷新会话时间（压缩不是用户发言）
#[tauri::command]
pub async fn cmd_replace_session_messages(
    state: tauri::State<'_, Arc<dyn SessionRepo>>,
    session_id: String,
    messages: Vec<Message>,
) -> Result<(), String> {
    let started = crate::telemetry::now_ms();
    let rows = messages.len();
    let result = state.replace_messages(&session_id, &messages).await;
    track_db(
        "replace",
        Some(&session_id),
        started,
        Some(rows),
        result.as_ref().err().map(|s| s.as_str()),
    );
    result
}

/// 追加消息（前端 TS 引擎路径落库用；Rust 引擎路径由引擎内部直落）
/// ⚠️ 不刷新会话时间（AI 回复 / 工具结果 / 用户消息都由会话元数据的那次 upsert 定时间）
#[tauri::command]
pub async fn cmd_append_messages(
    state: tauri::State<'_, Arc<dyn SessionRepo>>,
    session_id: String,
    messages: Vec<Message>,
) -> Result<(), String> {
    let started = crate::telemetry::now_ms();
    let rows = messages.len();
    let result = state.append_messages(&session_id, &messages).await;
    track_db(
        "append",
        Some(&session_id),
        started,
        Some(rows),
        result.as_ref().err().map(|s| s.as_str()),
    );
    result
}

/// 删除会话中「指定消息及其之后」的全部消息（前端删除消息时同步落库）
/// ⚠️ 不刷新会话时间（删除消息不是用户发言）
#[tauri::command]
pub async fn cmd_truncate_session_messages(
    state: tauri::State<'_, Arc<dyn SessionRepo>>,
    session_id: String,
    message_id: String,
) -> Result<(), String> {
    let started = crate::telemetry::now_ms();
    let result = state.truncate_messages_from(&session_id, &message_id).await;
    track_db(
        "truncate",
        Some(&session_id),
        started,
        None,
        result.as_ref().err().map(|s| s.as_str()),
    );
    result
}

// ==================== 用量账本命令（token 统计） ====================

/// 追加用量流水（TS 引擎 / 前端非消息型调用走此命令；Rust 引擎内部直落不经 IPC）
#[tauri::command]
pub async fn cmd_append_usage(
    state: tauri::State<'_, Arc<dyn SessionRepo>>,
    entries: Vec<UsageEntry>,
) -> Result<(), String> {
    let started = crate::telemetry::now_ms();
    let rows = entries.len();
    let result = state.append_usage(&entries).await;
    track_db(
        "usage_append",
        None,
        started,
        Some(rows),
        result.as_ref().err().map(|s| s.as_str()),
    );
    result
}

/// 聚合用量统计（按时间 / 模型 / 会话 / 调用类型分桶 + 合计）
///
/// 只返回 token 数，**不返回费用**：单价是用户可编辑的设置项，
/// 算在 SQL 里会导致「改一次单价就要回填整张表」，因此费用一律由前端计算。
#[tauri::command]
pub async fn cmd_usage_stats(
    state: tauri::State<'_, Arc<dyn SessionRepo>>,
    query: Option<UsageQuery>,
) -> Result<UsageStats, String> {
    let started = crate::telemetry::now_ms();
    let query = query.unwrap_or_default();
    let result = state.usage_stats(&query).await;
    track_db(
        "usage_stats",
        query.session_id.as_deref(),
        started,
        result.as_ref().ok().map(|s| s.buckets.len()),
        result.as_ref().err().map(|s| s.as_str()),
    );
    result
}

/// 用量明细（时间倒序，分页；表格视图与 CSV 导出用）
#[tauri::command]
pub async fn cmd_usage_query(
    state: tauri::State<'_, Arc<dyn SessionRepo>>,
    query: Option<UsageQuery>,
) -> Result<UsageRecordPage, String> {
    let started = crate::telemetry::now_ms();
    let query = query.unwrap_or_default();
    let result = state.usage_records(&query).await;
    track_db(
        "usage_query",
        query.session_id.as_deref(),
        started,
        result.as_ref().ok().map(|p| p.records.len()),
        result.as_ref().err().map(|s| s.as_str()),
    );
    result
}

/// 清空用量账本（返回删除条数）
#[tauri::command]
pub async fn cmd_usage_clear(
    state: tauri::State<'_, Arc<dyn SessionRepo>>,
) -> Result<i64, String> {
    let started = crate::telemetry::now_ms();
    let result = state.clear_usage().await;
    track_db(
        "usage_clear",
        None,
        started,
        result.as_ref().ok().map(|n| *n as usize),
        result.as_ref().err().map(|s| s.as_str()),
    );
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::types::SessionParams;
    use serde_json::json;

    fn test_session(id: &str, title: &str, updated_at: i64) -> Session {
        Session {
            id: id.to_string(),
            title: title.to_string(),
            messages: vec![],
            provider_config_id: "p1".into(),
            model_id: "gpt-4o".into(),
            system_prompt: "sys".into(),
            params: SessionParams {
                temperature: 0.7,
                top_p: 1.0,
                max_tokens: 1000,
                stream: true,
                reasoning_effort: None,
            },
            created_at: 1,
            updated_at,
            pinned: false,
            tags: vec!["tag1".into()],
            workspace: Some("/ws".into()),
            agent_id: None,
            allowed_tools: Some(vec!["read_file".into()]),
            skills: None,
            system_prompt_manually_edited: Some(true),
        }
    }

    fn test_message(id: &str, role: &str) -> Message {
        Message {
            id: id.to_string(),
            role: role.to_string(),
            content: json!("hello"),
            tool_calls: None,
            reasoning_content: None,
            tool_call_id: None,
            is_error: None,
            elapsed_ms: None,
            reasoning_elapsed_ms: None,
            ui_data: None,
            timestamp: 10,
            streaming: None,
            model: None,
            usage: None,
            image_vision_analyze_optimize: None,
            image_vision_analyze_result: None,
        }
    }

    fn open_tmp() -> SqliteSessionRepo {
        let dir = std::env::temp_dir().join(format!("virlen_test_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        SqliteSessionRepo::open(&dir.join("test.db")).unwrap()
    }

    #[tokio::test]
    async fn upsert_and_read_roundtrip() {
        let repo = open_tmp();
        let s = test_session("s1", "title", 100);
        repo.upsert_session(&s).await.unwrap();

        let loaded = repo.get_session("s1").await.unwrap().unwrap();
        assert_eq!(loaded.id, "s1");
        assert_eq!(loaded.title, "title");
        assert_eq!(loaded.model_id, "gpt-4o");
        assert_eq!(loaded.tags, vec!["tag1".to_string()]);
        assert_eq!(loaded.allowed_tools, Some(vec!["read_file".to_string()]));
        assert_eq!(loaded.system_prompt_manually_edited, Some(true));
        assert_eq!(loaded.params.max_tokens, 1000);
    }

    #[tokio::test]
    async fn upsert_is_idempotent() {
        let repo = open_tmp();
        repo.upsert_session(&test_session("s1", "v1", 100)).await.unwrap();
        repo.upsert_session(&test_session("s1", "v2", 200)).await.unwrap();
        let loaded = repo.get_session("s1").await.unwrap().unwrap();
        assert_eq!(loaded.title, "v2");
        assert_eq!(loaded.updated_at, 200);
    }

    #[tokio::test]
    async fn append_and_get_messages_ordered() {
        let repo = open_tmp();
        repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
        repo.append_messages(
            "s1",
            &[test_message("m1", "user"), test_message("m2", "assistant")],
        )
        .await
        .unwrap();

        let msgs = repo.get_messages("s1").await.unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].id, "m1");
        assert_eq!(msgs[1].id, "m2");
        // 会话时间不变：落库消息（AI 回复 / 工具结果）不得刷新 updated_at，
        // 它只由前端「用户发送消息」那一次 upsert_session 写入。
        let s = repo.get_session("s1").await.unwrap().unwrap();
        assert_eq!(s.updated_at, 100, "写消息不应刷新会话时间");
    }

    #[tokio::test]
    async fn message_writes_never_refresh_session_time() {
        // 回归（产品语义）：会话时间 = 用户最后一次发言的时间。
        // AI 回复 / 工具结果 / 迭代反馈的落库都不得改写 updated_at，
        // 只有前端「用户发送消息」那一瞬间的 upsert_session 会写它。
        let repo = open_tmp();
        repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
        repo.append_messages(
            "s1",
            &[
                test_message("m1", "user"),
                test_message("m2", "assistant"),
                test_message("m3", "tool"),
            ],
        )
        .await
        .unwrap();
        repo.append_messages("s1", &[test_message("m4", "assistant")])
            .await
            .unwrap();
        let s = repo.get_session("s1").await.unwrap().unwrap();
        assert_eq!(s.updated_at, 100, "写消息不应刷新会话时间");

        // 只有 upsert_session（用户发言时前端调用）才刷新
        repo.upsert_session(&test_session("s1", "t", 500))
            .await
            .unwrap();
        let s2 = repo.get_session("s1").await.unwrap().unwrap();
        assert_eq!(s2.updated_at, 500);
    }

    #[tokio::test]
    async fn append_messages_idempotent() {
        let repo = open_tmp();
        repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
        repo.append_messages("s1", &[test_message("m1", "user")]).await.unwrap();
        repo.append_messages("s1", &[test_message("m1", "user")]).await.unwrap();
        let msgs = repo.get_messages("s1").await.unwrap();
        assert_eq!(msgs.len(), 1, "重复写入同一 id 应幂等");
    }

    #[tokio::test]
    async fn reappend_keeps_message_order() {
        // 回归：重复写入已存在的“中间消息”不得改变读取顺序（保留原 rowid）
        let repo = open_tmp();
        repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
        repo.append_messages("s1", &[test_message("m1", "user")]).await.unwrap();
        repo.append_messages(
            "s1",
            &[test_message("m2", "assistant"), test_message("m3", "tool")],
        )
        .await
        .unwrap();
        repo.append_messages("s1", &[test_message("m1", "user")]).await.unwrap();
        let msgs = repo.get_messages("s1").await.unwrap();
        let ids: Vec<&str> = msgs.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, vec!["m1", "m2", "m3"], "重复写入同 id 不应把消息挪到末尾");
    }

    #[tokio::test]
    async fn replace_messages_swaps_all() {
        let repo = open_tmp();
        repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
        repo.append_messages(
            "s1",
            &[test_message("m1", "user"), test_message("m2", "assistant")],
        )
        .await
        .unwrap();
        // 压缩后整体替换为新的消息列表
        repo.replace_messages(
            "s1",
            &[test_message("m9", "user"), test_message("m10", "assistant")],
        )
        .await
        .unwrap();
        let msgs = repo.get_messages("s1").await.unwrap();
        assert_eq!(msgs.len(), 2, "替换后不应残留旧消息");
        assert_eq!(msgs[0].id, "m9");
        assert_eq!(msgs[1].id, "m10");
        // 压缩（整批替换）也不是用户发言 → 会话时间保持原值
        let s = repo.get_session("s1").await.unwrap().unwrap();
        assert_eq!(s.updated_at, 100, "整批替换消息不应刷新会话时间");
    }

    #[tokio::test]
    async fn delete_removes_session_and_messages() {
        let repo = open_tmp();
        repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
        repo.append_messages("s1", &[test_message("m1", "user")]).await.unwrap();
        repo.delete_session("s1").await.unwrap();
        assert!(repo.get_session("s1").await.unwrap().is_none());
        assert!(repo.get_messages("s1").await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn truncate_removes_target_and_after() {
        // 回归：前端删除用户消息时，DB 必须同步删除该消息及其之后的全部消息，
        // 否则重启后已删除消息会从 SQLite「复活」。
        let repo = open_tmp();
        repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
        let msgs: Vec<Message> = (1..=5)
            .map(|i| test_message(&format!("m{}", i), "user"))
            .collect();
        repo.append_messages("s1", &msgs).await.unwrap();

        repo.truncate_messages_from("s1", "m3").await.unwrap();

        let ids: Vec<String> = repo
            .get_messages("s1")
            .await
            .unwrap()
            .into_iter()
            .map(|m| m.id)
            .collect();
        assert_eq!(ids, vec!["m1", "m2"], "应删除目标及其之后的消息");
        // 删除消息不是用户发言 → 会话时间不变
        assert_eq!(
            repo.get_session("s1").await.unwrap().unwrap().updated_at,
            100,
            "删除消息不应刷新会话时间"
        );
    }

    #[tokio::test]
    async fn truncate_missing_message_is_noop() {
        let repo = open_tmp();
        repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
        repo.append_messages(
            "s1",
            &[test_message("m1", "user"), test_message("m2", "assistant")],
        )
        .await
        .unwrap();

        // 目标不存在：子查询为 NULL → 不应误删任何行
        repo.truncate_messages_from("s1", "nope").await.unwrap();

        assert_eq!(repo.get_messages("s1").await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn truncate_does_not_touch_other_sessions() {
        let repo = open_tmp();
        repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
        repo.upsert_session(&test_session("s2", "t", 100)).await.unwrap();
        repo.append_messages(
            "s1",
            &[test_message("a1", "user"), test_message("a2", "assistant")],
        )
        .await
        .unwrap();
        repo.append_messages(
            "s2",
            &[test_message("b1", "user"), test_message("b2", "assistant")],
        )
        .await
        .unwrap();

        repo.truncate_messages_from("s1", "a1").await.unwrap();

        assert!(repo.get_messages("s1").await.unwrap().is_empty());
        let other: Vec<String> = repo
            .get_messages("s2")
            .await
            .unwrap()
            .into_iter()
            .map(|m| m.id)
            .collect();
        assert_eq!(other, vec!["b1", "b2"], "不应影响其它会话");
    }

    #[tokio::test]
    async fn list_sessions_sorted_desc() {
        let repo = open_tmp();
        repo.upsert_session(&test_session("a", "A", 100)).await.unwrap();
        repo.upsert_session(&test_session("b", "B", 300)).await.unwrap();
        repo.upsert_session(&test_session("c", "C", 200)).await.unwrap();
        let list = repo.list_sessions().await.unwrap();
        let ids: Vec<&str> = list.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, vec!["b", "c", "a"]);
    }

    #[tokio::test]
    async fn page_returns_tail_window_in_order() {
        let repo = open_tmp();
        repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
        let msgs: Vec<Message> = (1..=10)
            .map(|i| test_message(&format!("m{}", i), "user"))
            .collect();
        repo.append_messages("s1", &msgs).await.unwrap();

        // 尾部窗口：最后 4 条（且为升序）
        let p1 = repo.get_message_page("s1", 4, None).await.unwrap();
        let ids1: Vec<&str> = p1.messages.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids1, vec!["m7", "m8", "m9", "m10"]);
        assert!(p1.has_more);
        let cursor1 = p1.oldest_rowid.expect("尾部页应有 oldest_rowid");

        // 向上回补：再取 4 条
        let p2 = repo.get_message_page("s1", 4, Some(cursor1)).await.unwrap();
        let ids2: Vec<&str> = p2.messages.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids2, vec!["m3", "m4", "m5", "m6"]);
        assert!(p2.has_more);
        let cursor2 = p2.oldest_rowid.unwrap();

        // 最后一页：只剩 2 条，无更多
        let p3 = repo.get_message_page("s1", 4, Some(cursor2)).await.unwrap();
        let ids3: Vec<&str> = p3.messages.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids3, vec!["m1", "m2"]);
        assert!(!p3.has_more);
    }

    #[tokio::test]
    async fn page_marks_no_more_when_session_smaller_than_limit() {
        let repo = open_tmp();
        repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
        repo.append_messages(
            "s1",
            &[test_message("m1", "user"), test_message("m2", "assistant")],
        )
        .await
        .unwrap();
        let p = repo.get_message_page("s1", 60, None).await.unwrap();
        assert_eq!(p.messages.len(), 2);
        assert!(!p.has_more, "消息数少于 limit 时不应标记 has_more");
    }

    #[tokio::test]
    async fn page_is_empty_for_missing_session() {
        let repo = open_tmp();
        let p = repo.get_message_page("nope", 60, None).await.unwrap();
        assert!(p.messages.is_empty());
        assert!(!p.has_more);
        assert!(p.oldest_rowid.is_none());
    }

    #[tokio::test]
    async fn user_message_refs_only_returns_user_messages_in_order() {
        let repo = open_tmp();
        repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
        let mut assistant = test_message("m2", "assistant");
        assistant.content = json!("assistant reply");
        // 带图片块 + 文本块的 user 消息：摘要应只取 text 块
        let mut with_image = test_message("m3", "user");
        with_image.content = json!([
            { "type": "image_url", "image_url": { "url": "data:image/png;base64,AAAA" } },
            { "type": "text", "text": "看看这张图" }
        ]);
        repo.append_messages(
            "s1",
            &[
                test_message("m1", "user"),
                assistant,
                with_image,
                test_message("m4", "tool"),
            ],
        )
        .await
        .unwrap();

        let refs = repo.get_user_message_refs("s1").await.unwrap();
        let ids: Vec<&str> = refs.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["m1", "m3"], "只返回 user 消息且保持插入顺序");
        assert_eq!(refs[0].preview, "hello");
        assert_eq!(refs[1].preview, "看看这张图");
    }

    #[tokio::test]
    async fn user_message_refs_truncates_preview_to_420_chars() {
        let repo = open_tmp();
        repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
        let mut long = test_message("m1", "user");
        long.content = json!("字".repeat(600));
        repo.append_messages("s1", &[long]).await.unwrap();

        let refs = repo.get_user_message_refs("s1").await.unwrap();
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].preview.chars().count(), 420);
    }

    #[tokio::test]
    async fn search_matches_across_sessions_and_snippets() {
        let repo = open_tmp();
        repo.upsert_session(&test_session("s1", "会话一", 100)).await.unwrap();
        repo.upsert_session(&test_session("s2", "会话二", 200)).await.unwrap();

        let mut a = test_message("m1", "assistant");
        a.timestamp = 10;
        a.content = json!("请检查一下沙盒模式下的端口占用问题");
        let mut b = test_message("m2", "user");
        b.timestamp = 20;
        b.content = json!("沙盒里跑 vitest 报 EPERM");
        let mut c = test_message("m3", "tool");
        c.timestamp = 15;
        c.content = json!("沙盒工具结果不应被检索");
        let mut d = test_message("m4", "user");
        d.timestamp = 30;
        d.content = json!("确认图片文本块里的沙盒二字也能命中");
        repo.append_messages("s1", &[a, b]).await.unwrap();
        repo.append_messages("s2", &[c, d]).await.unwrap();

        // 跨会话：只命中 user/assistant（tool 排除），按时间倒序
        let page = repo.search_messages("沙盒", None, None, 10, None).await.unwrap();
        let ids: Vec<&str> = page.items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, vec!["m4", "m2", "m1"]);
        assert!(!page.has_more);
        // 来源信息由 JOIN sessions 带出
        assert_eq!(page.items[0].session_title, "会话二");
        // 摘要围绕命中位置生成，命中词保留在片段内
        assert!(page.items[1].text.contains("沙盒"));

        // 限定会话
        let page = repo.search_messages("沙盒", Some("s1"), None, 10, None).await.unwrap();
        let ids: Vec<&str> = page.items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, vec!["m2", "m1"]);

        // 角色过滤
        let page = repo.search_messages("沙盒", None, Some("user"), 10, None).await.unwrap();
        let ids: Vec<&str> = page.items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, vec!["m4", "m2"]);

        // 空查询：不做关键词过滤，返回最新消息（排除 tool，按时间倒序）
        let page = repo.search_messages("   ", None, None, 10, None).await.unwrap();
        let ids: Vec<&str> = page.items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, vec!["m4", "m2", "m1"]);
    }

    // 「工具调用」分类：`role='tool'` 只返回工具结果，并从宿主 assistant 的
    // `tool_calls` 里反查出工具名（供前端展示「查看文件」等标签）。
    #[tokio::test]
    async fn search_tool_role_resolves_tool_name() {
        let repo = open_tmp();
        repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();

        // m1：assistant 一次发起两个并行工具调用
        let mut m1 = test_message("m1", "assistant");
        m1.timestamp = 10;
        m1.content = json!("");
        m1.tool_calls = Some(vec![
            crate::agent::types::ToolUseContent {
                type_: "tool_use".into(),
                id: "call_read".into(),
                name: "read_file".into(),
                input: json!({ "path": "a.ts" }),
            },
            crate::agent::types::ToolUseContent {
                type_: "tool_use".into(),
                id: "call_edit".into(),
                name: "edit_file".into(),
                input: json!({ "path": "a.ts" }),
            },
        ]);
        // m2 / m3：两个工具结果（正文含关键词「沙盒」）
        let mut m2 = test_message("m2", "tool");
        m2.timestamp = 11;
        m2.content = json!("沙盒结果一");
        m2.tool_call_id = Some("call_read".into());
        let mut m3 = test_message("m3", "tool");
        m3.timestamp = 12;
        m3.content = json!("沙盒结果二");
        m3.tool_call_id = Some("call_edit".into());
        repo.append_messages("s1", &[m1, m2, m3]).await.unwrap();

        // 默认（不限定角色）不含 tool
        let page = repo.search_messages("沙盒", None, None, 10, None).await.unwrap();
        assert!(page.items.is_empty(), "tool 结果不在默认检索范围内");

        // role='tool' → 只返回工具结果，且各自带上宿主工具名
        let page = repo
            .search_messages("沙盒", None, Some("tool"), 10, None)
            .await
            .unwrap();
        let got: Vec<(&str, Option<&str>)> = page
            .items
            .iter()
            .map(|i| (i.id.as_str(), i.tool_name.as_deref()))
            .collect();
        assert_eq!(
            got,
            vec![("m3", Some("edit_file")), ("m2", Some("read_file"))],
            "时间倒序，且能跨过工具结果行反查到宿主"
        );

        // 宿主缺失（tool_call_id 对不上）→ 工具名为 None，但结果照常返回
        let mut orphan = test_message("m4", "tool");
        orphan.timestamp = 20;
        orphan.content = json!("沙盒孤立结果");
        orphan.tool_call_id = Some("call_missing".into());
        repo.append_messages("s1", &[orphan]).await.unwrap();
        let page = repo
            .search_messages("沙盒", None, Some("tool"), 10, None)
            .await
            .unwrap();
        assert_eq!(page.items[0].id, "m4");
        assert_eq!(page.items[0].tool_name, None);
    }

    // 空查询（检索弹窗默认态）：不过滤关键词、返回最新消息，role / session / 游标仍生效。
    #[tokio::test]
    async fn empty_query_returns_latest_messages() {
        let repo = open_tmp();
        repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
        let msgs: Vec<Message> = (0..5)
            .map(|i| {
                let role = if i % 2 == 0 { "user" } else { "assistant" };
                let mut m = test_message(&format!("m{}", i), role);
                m.timestamp = i as i64;
                m.content = json!(format!("消息 {}", i));
                m
            })
            .collect();
        repo.append_messages("s1", &msgs).await.unwrap();

        // 空串 / 纯空白 → 视为空查询，返回最新消息（时间倒序）
        for q in ["", "   "] {
            let page = repo.search_messages(q, None, None, 10, None).await.unwrap();
            let ids: Vec<&str> = page.items.iter().map(|i| i.id.as_str()).collect();
            assert_eq!(ids, vec!["m4", "m3", "m2", "m1", "m0"], "空查询返回最新消息");
        }

        // role 过滤仍生效
        let page = repo.search_messages("", None, Some("user"), 10, None).await.unwrap();
        let ids: Vec<&str> = page.items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, vec!["m4", "m2", "m0"]);

        // keyset 游标分页仍生效
        let first = repo.search_messages("", None, None, 2, None).await.unwrap();
        assert_eq!(first.items.len(), 2);
        assert!(first.has_more);
        assert_eq!(first.items[0].id, "m4");
        let second = repo
            .search_messages("", None, None, 2, first.next_cursor)
            .await
            .unwrap();
        assert_eq!(second.items[0].id, "m2", "空查询下游标翻页仍正确");
    }

    // 正文为空的消息（仅做深度思考 / 工具调用）不进入检索结果。
    #[tokio::test]
    async fn search_excludes_empty_body_messages() {
        let repo = open_tmp();
        repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();

        // m1：空字符串正文（仅有工具调用 / 思考）
        let mut m1 = test_message("m1", "assistant");
        m1.timestamp = 10;
        m1.content = json!("");
        m1.reasoning_content = Some("只想不做".into());
        // m2：空文本块（正文仍为空）
        let mut m2 = test_message("m2", "assistant");
        m2.timestamp = 20;
        m2.content = json!([{ "type": "text", "text": "" }]);
        // m3：纯空白正文
        let mut m3 = test_message("m3", "assistant");
        m3.timestamp = 30;
        m3.content = json!("   ");
        // m4：多个空文本块（拼出 "\n"，仅空白）
        let mut m4 = test_message("m4", "assistant");
        m4.timestamp = 40;
        m4.content = json!([
            { "type": "text", "text": "" },
            { "type": "text", "text": "" }
        ]);
        // m5：真正的正文
        let mut m5 = test_message("m5", "assistant");
        m5.timestamp = 50;
        m5.content = json!("这是真正的回复正文");
        repo.append_messages("s1", &[m1, m2, m3, m4, m5]).await.unwrap();

        // 空查询默认视图：只保留有正文的消息
        let page = repo.search_messages("", None, None, 10, None).await.unwrap();
        let ids: Vec<&str> = page.items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, vec!["m5"], "空正文消息不应出现在默认视图");

        // 有关键词时（4 字 → FTS 路径）也只命中真正有正文的消息
        let page = repo.search_messages("回复正文", None, None, 10, None).await.unwrap();
        let ids: Vec<&str> = page.items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, vec!["m5"]);
    }

    // 回归：历史旧构建可能把 text_plain 写成 NULL（未回填），且 user_version 已是最新版本，
    // 迁移不会自动重跑。此时：①检索不应显示这些 NULL 行里的空正文；
    // ②启动时 init_schema 应检测到 NULL 行 → 返回「需迁移」以触发自愈回填。
    #[tokio::test]
    async fn search_excludes_null_text_plain_and_self_heals() {
        let dir = std::env::temp_dir().join(format!("virlen_null_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("null.db");

        {
            let conn = rusqlite::Connection::open(&db).unwrap();
            conn.execute_batch(
                r#"
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, provider_config_id TEXT NOT NULL,
  model_id TEXT NOT NULL, system_prompt TEXT NOT NULL DEFAULT '', params TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, pinned INTEGER NOT NULL DEFAULT 0,
  tags TEXT NOT NULL DEFAULT '[]', workspace TEXT, agent_id TEXT, allowed_tools TEXT,
  skills TEXT, system_prompt_manually_edited INTEGER
);
CREATE TABLE messages (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
  tool_calls TEXT, reasoning_content TEXT, tool_call_id TEXT, is_error INTEGER,
  elapsed_ms INTEGER, reasoning_elapsed_ms INTEGER, ui_data TEXT, timestamp INTEGER NOT NULL,
  streaming INTEGER, model TEXT, usage TEXT, image_vision_analyze_optimize INTEGER,
  image_vision_analyze_result TEXT
);
INSERT INTO sessions (id, title, provider_config_id, model_id, system_prompt, params, created_at, updated_at)
  VALUES ('s1', 't', 'p1', 'gpt-4o', '', '{}', 1, 100);
-- 模拟旧构建漏写 text_plain：两行都是 NULL（一空正文、一有正文）
INSERT INTO messages (id, session_id, role, content, timestamp) VALUES
  ('m_blank', 's1', 'assistant', '""', 10),
  ('m_real',  's1', 'assistant', '"hello world"', 20);
PRAGMA user_version = 1;
"#,
            )
            .unwrap();
        }

        let repo = SqliteSessionRepo::open(&db).unwrap();
        // 存在 NULL 行 → 不能走快速路径，需迁移自愈
        assert!(
            !repo.migration_done(),
            "存在 text_plain IS NULL 行时应触发迁移"
        );
        // 迁移前：NULL 且空正文的行被 Rust 侧按实际正文过滤掉
        let page = repo.search_messages("", None, None, 10, None).await.unwrap();
        let ids: Vec<&str> = page.items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, vec!["m_real"], "NULL 且空正文的行不应出现");

        // 自愈回填
        repo.migrate().await.unwrap();
        assert!(repo.migration_done());
        // 回填后：关键字检索（FTS 路径）能命中真实正文
        let page = repo.search_messages("hello", None, None, 10, None).await.unwrap();
        let ids: Vec<&str> = page.items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, vec!["m_real"]);
        // 空正文行仍不出现
        let page = repo.search_messages("", None, None, 10, None).await.unwrap();
        let ids: Vec<&str> = page.items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, vec!["m_real"]);
    }

    #[tokio::test]
    async fn search_paginates_with_cursor() {
        let repo = open_tmp();
        repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
        let msgs: Vec<Message> = (0..5)
            .map(|i| {
                let mut m = test_message(&format!("m{}", i), "user");
                m.timestamp = i as i64;
                m.content = json!(format!("keyword {}", i));
                m
            })
            .collect();
        repo.append_messages("s1", &msgs).await.unwrap();

        let first = repo.search_messages("keyword", None, None, 2, None).await.unwrap();
        assert_eq!(first.items.len(), 2);
        assert!(first.has_more);
        assert_eq!(first.items[0].id, "m4", "按时间倒序（新→旧）");
        assert_eq!(first.items[1].id, "m3");
        assert!(first.next_cursor.is_some());

        let second = repo
            .search_messages("keyword", None, None, 2, first.next_cursor)
            .await
            .unwrap();
        assert_eq!(second.items[0].id, "m2");
        assert!(second.has_more);

        let third = repo
            .search_messages("keyword", None, None, 2, second.next_cursor)
            .await
            .unwrap();
        assert_eq!(third.items.len(), 1);
        assert!(!third.has_more);
        assert!(third.next_cursor.is_none(), "无更多时不应给出游标");

        // keyset 抗「检索期间新增」：取完首页后插入一条更新的消息，
        // 用旧游标翻下一页应仍从 m2 继续（不重复、不跳过）
        let mut extra = test_message("m9", "user");
        extra.timestamp = 99;
        extra.content = json!("keyword extra");
        repo.append_messages("s1", &[extra]).await.unwrap();
        let second_after = repo
            .search_messages("keyword", None, None, 2, first.next_cursor)
            .await
            .unwrap();
        assert_eq!(second_after.items[0].id, "m2", "新写入不影响旧游标定位");
    }

    // 新实现：检索基于 text_plain（而非 content JSON），不再误命中 JSON 键名；
    // ≥3 字符走 FTS5，更短的走 LIKE 回退。
    #[tokio::test]
    async fn search_matches_plain_text_not_json_keys() {
        let repo = open_tmp();
        repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
        let mut m = test_message("m1", "user");
        m.content = json!([
            { "type": "image_url", "image_url": { "url": "data:image/png;base64,AAAA" } },
            { "type": "text", "text": "登录失败请重试" }
        ]);
        repo.append_messages("s1", &[m]).await.unwrap();

        // 旧实现直接 LIKE content JSON，会误命中键名；改用 text_plain 后不应命中
        for key in ["image_url", "type", "url"] {
            let page = repo.search_messages(key, None, None, 10, None).await.unwrap();
            assert!(page.items.is_empty(), "不应命中 JSON 键名: {}", key);
        }
        // 正文可命中：2 字 → LIKE 回退路径
        let page = repo.search_messages("登录", None, None, 10, None).await.unwrap();
        assert_eq!(page.items.len(), 1);
        // 3 字以上 → FTS5（trigram）路径，命中片段保留关键词
        let page = repo.search_messages("登录失败", None, None, 10, None).await.unwrap();
        assert_eq!(page.items.len(), 1);
        assert!(page.items[0].text.contains("登录失败"));
    }

    // 回归（优化 2）：相邻文本块之间应以分隔符隔开，避免被拼成一个词导致跨块误命中。
    #[tokio::test]
    async fn search_does_not_match_across_text_blocks() {
        let repo = open_tmp();
        repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
        let mut m = test_message("m1", "user");
        m.content = json!([
            { "type": "text", "text": "你好" },
            { "type": "text", "text": "世界" }
        ]);
        repo.append_messages("s1", &[m]).await.unwrap();

        // "你好世界" 跨越两个独立文本块（中间有分隔符）→ 不应命中（4 字 → FTS 路径）
        let page = repo.search_messages("你好世界", None, None, 10, None).await.unwrap();
        assert!(page.items.is_empty(), "跨块短语不应命中");
        // 单块内仍可命中（2 字 → LIKE 路径）
        let page = repo.search_messages("你好", None, None, 10, None).await.unwrap();
        assert_eq!(page.items.len(), 1);
    }

    // 触发器应保证 FTS 索引随 messages 增/改/删自动同步。
    #[tokio::test]
    async fn search_index_in_sync_on_update_and_delete() {
        let repo = open_tmp();
        repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
        let mut m = test_message("m1", "user");
        m.content = json!("第一版内容 alpha");
        repo.append_messages("s1", &[m.clone()]).await.unwrap();
        assert_eq!(
            repo.search_messages("alpha", None, None, 10, None)
                .await
                .unwrap()
                .items
                .len(),
            1
        );

        // 同 id 更新正文 → 索引应刷新（旧文本消失、新文本命中）
        m.content = json!("第二版内容 beta");
        repo.append_messages("s1", &[m.clone()]).await.unwrap();
        assert!(
            repo.search_messages("alpha", None, None, 10, None)
                .await
                .unwrap()
                .items
                .is_empty(),
            "更新后旧文本不应命中"
        );
        assert_eq!(
            repo.search_messages("beta", None, None, 10, None)
                .await
                .unwrap()
                .items
                .len(),
            1
        );

        // 截断删除 → 索引应清理
        repo.truncate_messages_from("s1", "m1").await.unwrap();
        assert!(
            repo.search_messages("beta", None, None, 10, None)
                .await
                .unwrap()
                .items
                .is_empty(),
            "删除后不应命中"
        );
    }

    // 验证老库迁移：旧 schema 没有 text_plain 列，open() 应自动补列、回填并建 FTS 索引。
    #[tokio::test]
    async fn migrates_legacy_db_without_text_plain() {
        let dir = std::env::temp_dir().join(format!("virlen_legacy_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("legacy.db");

        // 构造「旧版」库：messages 表无 text_plain 列、无 FTS、user_version=0
        {
            let conn = rusqlite::Connection::open(&db).unwrap();
            conn.execute_batch(
                r#"
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, provider_config_id TEXT NOT NULL,
  model_id TEXT NOT NULL, system_prompt TEXT NOT NULL DEFAULT '', params TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, pinned INTEGER NOT NULL DEFAULT 0,
  tags TEXT NOT NULL DEFAULT '[]', workspace TEXT, agent_id TEXT, allowed_tools TEXT,
  skills TEXT, system_prompt_manually_edited INTEGER
);
CREATE TABLE messages (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
  tool_calls TEXT, reasoning_content TEXT, tool_call_id TEXT, is_error INTEGER,
  elapsed_ms INTEGER, reasoning_elapsed_ms INTEGER, ui_data TEXT, timestamp INTEGER NOT NULL,
  streaming INTEGER, model TEXT, usage TEXT, image_vision_analyze_optimize INTEGER,
  image_vision_analyze_result TEXT
);
INSERT INTO sessions (id, title, provider_config_id, model_id, system_prompt, params, created_at, updated_at)
  VALUES ('s1', '旧会话', 'p1', 'gpt-4o', '', '{}', 1, 100);
"#,
            )
            .unwrap();
            let content = serde_json::to_string("旧的沙盒消息内容").unwrap();
            conn.execute(
                "INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?1,?2,?3,?4,?5)",
                params!["m1", "s1", "user", content, 10i64],
            )
            .unwrap();
        }

        // open 只做快速初始化；有历史数据时迁移推迟到后台（此处显式触发）
        let repo = SqliteSessionRepo::open(&db).unwrap();
        assert!(!repo.migration_done(), "有历史数据时迁移应推迟到后台");

        // 迁移完成前：回退到旧的 content LIKE 路径，检索结果依然正确
        let page = repo.search_messages("沙盒", None, None, 10, None).await.unwrap();
        assert_eq!(page.items.len(), 1, "迁移前回退路径仍可检索");

        // 执行迁移（等价于生产环境的后台任务）
        repo.migrate().await.unwrap();
        assert!(repo.migration_done());

        // 迁移后：2 字走 LIKE text_plain、4 字走 FTS5
        let page = repo.search_messages("沙盒", None, None, 10, None).await.unwrap();
        assert_eq!(page.items.len(), 1, "迁移后应能检索到旧数据");
        let page = repo.search_messages("消息内容", None, None, 10, None).await.unwrap();
        assert_eq!(page.items.len(), 1, "FTS 索引应覆盖迁移回填的旧数据");
    }

    // 全新库无历史数据 → 无需迁移，直接可用
    #[tokio::test]
    async fn fresh_db_needs_no_migration() {
        let repo = open_tmp();
        assert!(repo.migration_done(), "全新库无需迁移");
        // 幂等：重复 migrate 无副作用
        repo.migrate().await.unwrap();
        assert!(repo.migration_done());
    }

    /// messages 表上是否存在指定索引
    fn has_index(repo: &SqliteSessionRepo, name: &str) -> bool {
        let conn = repo.conn.lock().unwrap();
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name=?1)",
            params![name],
            |row| row.get::<_, i64>(0),
        )
        .unwrap()
            != 0
    }

    // 回归（优化 3）：检索排序索引不应落在 open() 同步路径上 ——
    // 空库（无历史数据）open 即建好；老库推迟到后台 migrate() 后建好。
    #[tokio::test]
    async fn search_index_stays_off_startup_path_for_legacy_db() {
        // 新建库：空表快速路径，open 后索引即存在
        let fresh = open_tmp();
        assert!(has_index(&fresh, "idx_messages_ts"), "空库应建检索索引");

        // 构造「旧版」有数据的库
        let dir = std::env::temp_dir().join(format!("virlen_idx_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("legacy.db");
        {
            let conn = rusqlite::Connection::open(&db).unwrap();
            conn.execute_batch(
                r#"
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, provider_config_id TEXT NOT NULL,
  model_id TEXT NOT NULL, system_prompt TEXT NOT NULL DEFAULT '', params TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, pinned INTEGER NOT NULL DEFAULT 0,
  tags TEXT NOT NULL DEFAULT '[]', workspace TEXT, agent_id TEXT, allowed_tools TEXT,
  skills TEXT, system_prompt_manually_edited INTEGER
);
CREATE TABLE messages (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
  tool_calls TEXT, reasoning_content TEXT, tool_call_id TEXT, is_error INTEGER,
  elapsed_ms INTEGER, reasoning_elapsed_ms INTEGER, ui_data TEXT, timestamp INTEGER NOT NULL,
  streaming INTEGER, model TEXT, usage TEXT, image_vision_analyze_optimize INTEGER,
  image_vision_analyze_result TEXT
);
"#,
            )
            .unwrap();
            conn.execute(
                "INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?1,?2,?3,?4,?5)",
                params!["m1", "s1", "user", serde_json::to_string("x").unwrap(), 10i64],
            )
            .unwrap();
        }

        let repo = SqliteSessionRepo::open(&db).unwrap();
        assert!(!repo.migration_done(), "老库需迁移");
        assert!(
            !has_index(&repo, "idx_messages_ts"),
            "老库迁移前不应在启动路径同步建索引"
        );

        repo.migrate().await.unwrap();
        assert!(has_index(&repo, "idx_messages_ts"), "迁移后应建好检索索引");
    }

    // ==================== 消息查询（query messages）====================

    /// 造一条带 tool_calls + 深度思考的 assistant 消息
    fn assistant_with_tool(id: &str, text: &str, tool: &str, args: serde_json::Value) -> Message {
        let mut m = test_message(id, "assistant");
        m.content = json!(text);
        m.reasoning_content = Some("SECRET_REASONING_绝不外泄".into());
        m.tool_calls = Some(vec![crate::agent::types::ToolUseContent {
            type_: "function".into(),
            id: format!("tc_{}", id),
            name: tool.into(),
            input: args,
        }]);
        m
    }

    /// 追加一条 summary，作为「压缩边界」
    fn summary_message(id: &str) -> Message {
        let mut m = test_message(id, "summary");
        m.content = json!("[summary] 之前的对话已压缩");
        m
    }

    fn user_msg(id: &str, text: &str) -> Message {
        let mut m = test_message(id, "user");
        m.content = json!(text);
        m
    }

    #[tokio::test]
    async fn message_window_returns_before_and_after_ascending() {
        let repo = open_tmp();
        repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
        let msgs: Vec<Message> = (1..=10)
            .map(|i| user_msg(&format!("m{}", i), &format!("消息 {}", i)))
            .collect();
        repo.append_messages("s1", &msgs).await.unwrap();
        repo.append_messages("s1", &[summary_message("s")]).await.unwrap();

        let w = repo
            .get_message_window("s1", Some("m5"), None, 2, 2)
            .await
            .unwrap();
        assert!(w.anchor_found);
        assert_eq!(w.anchor_seq, 5);
        assert_eq!(w.boundary_seq, Some(11));
        assert_eq!(w.total, 11);
        let ids: Vec<&str> = w.messages.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, vec!["m3", "m4", "m5", "m6", "m7"]);
        assert_eq!(w.messages[0].seq, 3);
        assert!(!w.clamped_by_boundary);
    }

    #[tokio::test]
    async fn message_window_clamps_at_boundary_and_never_returns_known_tail() {
        let repo = open_tmp();
        repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
        let msgs: Vec<Message> = (1..=10)
            .map(|i| user_msg(&format!("m{}", i), &format!("消息 {}", i)))
            .collect();
        repo.append_messages("s1", &msgs).await.unwrap();
        repo.append_messages("s1", &[summary_message("s")]).await.unwrap();
        // 边界之后还有「已知」消息：绝不能被查询返回
        let mut known = test_message("m11", "assistant");
        known.content = json!("已知回复");
        repo.append_messages("s1", &[known]).await.unwrap();

        let w = repo
            .get_message_window("s1", Some("m9"), None, 0, 10)
            .await
            .unwrap();
        let ids: Vec<&str> = w.messages.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, vec!["m9", "m10"], "只返回压缩区间内的消息");
        assert!(w.clamped_by_boundary);
        assert!(!ids.contains(&"m11"));
        assert!(!ids.contains(&"s"));
    }

    #[tokio::test]
    async fn message_window_anchor_in_visible_region_returns_empty() {
        let repo = open_tmp();
        repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
        let msgs: Vec<Message> = (1..=5)
            .map(|i| test_message(&format!("m{}", i), "user"))
            .collect();
        repo.append_messages("s1", &msgs).await.unwrap();
        repo.append_messages("s1", &[summary_message("s")]).await.unwrap();

        // 锚点 = summary（在「已知区间」）→ 空窗口
        let w = repo
            .get_message_window("s1", Some("s"), None, 5, 5)
            .await
            .unwrap();
        assert!(w.anchor_found);
        assert!(w.messages.is_empty());
    }

    #[tokio::test]
    async fn message_window_without_summary_has_nothing_queryable() {
        let repo = open_tmp();
        repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
        let msgs: Vec<Message> = (1..=5)
            .map(|i| test_message(&format!("m{}", i), "user"))
            .collect();
        repo.append_messages("s1", &msgs).await.unwrap();

        let w = repo
            .get_message_window("s1", Some("m3"), None, 5, 5)
            .await
            .unwrap();
        assert_eq!(w.boundary_seq, None);
        assert!(w.messages.is_empty(), "未压缩 → 无可查询历史");
    }

    #[tokio::test]
    async fn message_window_anchor_not_found() {
        let repo = open_tmp();
        repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
        repo.append_messages("s1", &[test_message("m1", "user"), summary_message("s")])
            .await
            .unwrap();
        let w = repo
            .get_message_window("s1", Some("nope"), None, 5, 5)
            .await
            .unwrap();
        assert!(!w.anchor_found);
        assert!(w.messages.is_empty());
    }

    #[tokio::test]
    async fn message_window_never_exposes_reasoning() {
        let repo = open_tmp();
        repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
        repo.append_messages(
            "s1",
            &[
                assistant_with_tool("m1", "正文", "read_file", json!({ "path": "a.txt" })),
                summary_message("s"),
            ],
        )
        .await
        .unwrap();

        let w = repo
            .get_message_window("s1", Some("m1"), None, 0, 0)
            .await
            .unwrap();
        assert_eq!(w.messages.len(), 1);
        assert!(w.messages[0].has_reasoning, "应标记「含思考」");
        let serialized = serde_json::to_string(&w).unwrap();
        assert!(
            !serialized.contains("SECRET_REASONING"),
            "深度思考内容绝不能出现在返回里"
        );
        assert!(!serialized.contains("reasoning_content"));
    }

    #[tokio::test]
    async fn message_window_truncates_tool_details_and_tool_result() {
        let repo = open_tmp();
        repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
        let long_arg = "x".repeat(500);
        let mut tool_result = test_message("m2", "tool");
        tool_result.content = json!("y".repeat(500));
        tool_result.tool_call_id = Some("tc_m1".into());
        repo.append_messages(
            "s1",
            &[
                assistant_with_tool("m1", "正文", "read_file", json!({ "path": long_arg })),
                tool_result,
                summary_message("s"),
            ],
        )
        .await
        .unwrap();

        let w = repo
            .get_message_window("s1", Some("m1"), None, 5, 5)
            .await
            .unwrap();
        let a = &w.messages[0];
        assert_eq!(a.tool_calls.len(), 1);
        assert_eq!(a.tool_calls[0].name, "read_file");
        assert!(a.tool_calls[0].input_truncated);
        assert!(
            a.tool_calls[0].input_brief.chars().count()
                <= MSG_QUERY_TOOL_DETAIL_MAX_CHARS + 1
        );
        let tr = &w.messages[1];
        assert_eq!(tr.role, "tool");
        assert!(tr.text_truncated);
        assert!(tr.text.chars().count() <= MSG_QUERY_TOOL_DETAIL_MAX_CHARS + 1);
    }

    #[tokio::test]
    async fn message_window_clamps_span() {
        let repo = open_tmp();
        repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
        let msgs: Vec<Message> = (1..=100)
            .map(|i| test_message(&format!("m{}", i), "user"))
            .collect();
        repo.append_messages("s1", &msgs).await.unwrap();
        repo.append_messages("s1", &[summary_message("s")]).await.unwrap();

        let w = repo
            .get_message_window("s1", Some("m50"), None, 999, 999)
            .await
            .unwrap();
        assert!(w.messages.len() <= MSG_QUERY_MAX_SPAN + 1);
        assert!(w.messages.len() > 1, "应按比例保留锚点前后");
    }

    #[tokio::test]
    async fn message_timeline_lists_queryable_only_and_pages_backwards() {
        let repo = open_tmp();
        repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
        let msgs: Vec<Message> = (1..=10)
            .map(|i| user_msg(&format!("m{}", i), &format!("消息 {}", i)))
            .collect();
        repo.append_messages("s1", &msgs).await.unwrap();
        repo.append_messages("s1", &[summary_message("s")]).await.unwrap();
        let mut known = test_message("m11", "assistant");
        known.content = json!("已知回复");
        repo.append_messages("s1", &[known]).await.unwrap();

        // 首页：可查询区间最新 4 条（#7..#10），不含 summary / m11
        let p1 = repo.get_message_timeline("s1", None, None, 4).await.unwrap();
        let ids: Vec<&str> = p1.items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, vec!["m7", "m8", "m9", "m10"]);
        assert_eq!(p1.boundary_seq, Some(11));
        assert!(p1.has_more);

        // 翻更早
        let p2 = repo
            .get_message_timeline("s1", None, p1.next_cursor, 4)
            .await
            .unwrap();
        let ids2: Vec<&str> = p2.items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids2, vec!["m3", "m4", "m5", "m6"]);
    }

    #[tokio::test]
    async fn message_timeline_keyword_filter_and_empty_when_uncompressed() {
        let repo = open_tmp();
        repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
        repo.append_messages("s1", &[user_msg("m1", "关于沙盒的讨论"), user_msg("m2", "关于网络的讨论")])
            .await
            .unwrap();

        // 未压缩 → 无可查询
        let p = repo.get_message_timeline("s1", None, None, 10).await.unwrap();
        assert!(p.items.is_empty());
        assert_eq!(p.boundary_seq, None);

        repo.append_messages("s1", &[summary_message("s")]).await.unwrap();
        let p = repo
            .get_message_timeline("s1", Some("沙盒"), None, 10)
            .await
            .unwrap();
        let ids: Vec<&str> = p.items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, vec!["m1"]);
        assert!(p.items[0].preview.contains("沙盒"));
    }

    // ===== 用量账本（token 统计） =====

    fn usage_entry(id: Option<&str>, ts: i64, kind: &str, total: i64) -> UsageEntry {
        UsageEntry {
            ts: Some(ts),
            session_id: Some("s1".into()),
            message_id: id.map(String::from),
            model: "gpt-4o".into(),
            provider_type: Some("openai".into()),
            provider_config_id: Some("p1".into()),
            kind: kind.into(),
            round: Some(1),
            prompt_tokens: total - 20,
            completion_tokens: 20,
            cached_tokens: 0,
            total_tokens: total,
            estimated: false,
            trace_id: None,
        }
    }

    #[tokio::test]
    async fn usage_append_is_idempotent_by_message_id() {
        let repo = open_tmp();
        repo.append_usage(&[usage_entry(Some("m1"), 1000, "chat_round", 100)])
            .await
            .unwrap();
        // 同一 message_id 重复写入（流式重试 / 重放）→ 不产生新流水
        repo.append_usage(&[usage_entry(Some("m1"), 1000, "chat_round", 100)])
            .await
            .unwrap();
        // 无 message_id 的调用（title / verify）每次都单独记账
        repo.append_usage(&[
            usage_entry(None, 1000, "title", 10),
            usage_entry(None, 1000, "title", 10),
        ])
        .await
        .unwrap();

        let stats = repo.usage_stats(&UsageQuery::default()).await.unwrap();
        assert_eq!(stats.totals.calls, 3);
        assert_eq!(stats.totals.total_tokens, 120);
        assert_eq!(stats.totals.estimated_calls, 0);
    }

    #[tokio::test]
    async fn usage_stats_groups_and_filters() {
        let repo = open_tmp();
        repo.upsert_session(&test_session("s1", "会话一", 100)).await.unwrap();
        repo.append_usage(&[
            usage_entry(Some("m1"), 1_700_000_000_000, "chat_round", 100),
            usage_entry(Some("m2"), 1_700_000_000_000, "chat_round", 200),
            usage_entry(None, 1_700_100_000_000, "verify", 50),
        ])
        .await
        .unwrap();

        // 按类型分桶
        let by_kind = repo
            .usage_stats(&UsageQuery {
                group_by: Some("kind".into()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(by_kind.buckets.len(), 2);
        assert_eq!(by_kind.totals.total_tokens, 350);
        assert_eq!(by_kind.first_ts, Some(1_700_000_000_000));

        // 按时间过滤 + 按会话分桶（只命中前两条）
        let by_session = repo
            .usage_stats(&UsageQuery {
                to_ts: Some(1_700_000_000_001),
                group_by: Some("session".into()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(by_session.totals.total_tokens, 300);
        assert_eq!(by_session.buckets.len(), 1);
        assert_eq!(by_session.buckets[0].key, "s1");
        assert_eq!(by_session.buckets[0].calls, 2);

        // 按天分桶（tz-dependent：只断言桶数与合计，不写死日期）
        let by_day = repo
            .usage_stats(&UsageQuery {
                group_by: Some("day".into()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert!(!by_day.buckets.is_empty());
        assert_eq!(by_day.buckets.iter().map(|b| b.calls).sum::<i64>(), 3);
    }

    #[tokio::test]
    async fn usage_records_join_session_title_and_survive_session_delete() {
        let repo = open_tmp();
        repo.upsert_session(&test_session("s1", "会话一", 100)).await.unwrap();
        repo.append_usage(&[usage_entry(Some("m1"), 2000, "chat_round", 100)])
            .await
            .unwrap();

        let page = repo.usage_records(&UsageQuery::default()).await.unwrap();
        assert_eq!(page.total, 1);
        assert_eq!(page.records[0].session_title.as_deref(), Some("会话一"));

        // 删会话只删对话内容，用量流水保留（口径见 docs/token-usage-stats.md）
        repo.delete_session("s1").await.unwrap();
        let page = repo.usage_records(&UsageQuery::default()).await.unwrap();
        assert_eq!(page.total, 1, "删会话后用量记录仍保留");
        assert_eq!(page.records[0].session_title, None);
    }

    /// 回归：带过滤条件时，COUNT 与明细查询必须用**同一张表别名**。
    ///
    /// 曾经 COUNT 写成 `FROM usage_ledger`（无别名）却复用了 `u.ts >= ?` 的 WHERE，
    /// SQLite 直接报 `no such column: u.ts` → 明细/导出在有时间过滤时全空。
    #[tokio::test]
    async fn usage_records_with_filters_matches_count() {
        let repo = open_tmp();
        repo.upsert_session(&test_session("s1", "会话一", 100)).await.unwrap();
        repo.append_usage(&[
            usage_entry(Some("m1"), 1_000, "chat_round", 100),
            usage_entry(Some("m2"), 5_000, "chat_round", 200),
        ])
        .await
        .unwrap();

        // 时间下界过滤
        let page = repo
            .usage_records(&UsageQuery {
                from_ts: Some(2_000),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(page.total, 1);
        assert_eq!(page.records.len(), 1);
        assert_eq!(page.records[0].total_tokens, 200);

        // 会话过滤（同样走 WHERE，同样会踩到别名问题）
        let page = repo
            .usage_records(&UsageQuery {
                session_id: Some("s1".into()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(page.total, 2);
        assert_eq!(page.records.len(), 2);

        // 分页参数编号必须在过滤参数之后（否则 LIMIT 会吃掉过滤值）
        let page = repo
            .usage_records(&UsageQuery {
                from_ts: Some(0),
                limit: Some(1),
                offset: Some(1),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(page.total, 2);
        assert_eq!(page.records.len(), 1);
        assert_eq!(page.records[0].total_tokens, 100, "按 ts DESC 取第二页 = 更早的一条");
    }

    #[tokio::test]
    async fn usage_estimated_flag_and_clear() {
        let repo = open_tmp();
        let mut entry = usage_entry(Some("m1"), 3000, "compress", 80);
        entry.estimated = true;
        repo.append_usage(&[entry]).await.unwrap();

        let stats = repo.usage_stats(&UsageQuery::default()).await.unwrap();
        assert_eq!(stats.totals.estimated_calls, 1);

        let n = repo.clear_usage().await.unwrap();
        assert_eq!(n, 1);
        let stats = repo.usage_stats(&UsageQuery::default()).await.unwrap();
        assert_eq!(stats.totals.calls, 0);
        assert_eq!(stats.first_ts, None);
    }

    #[tokio::test]
    async fn usage_backfill_from_messages_is_idempotent() {
        let repo = open_tmp();
        repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
        let mut with_usage = test_message("m1", "assistant");
        with_usage.usage = Some(serde_json::from_value(json!({
            "promptTokens": 10,
            "completionTokens": 5,
            "totalTokens": 15
        }))
        .unwrap());
        repo.append_messages("s1", &[with_usage]).await.unwrap();

        // 模拟升级迁移：从 messages.usage 回填（幂等，跑两次不翻倍）
        backfill_usage_ledger(&repo.conn).unwrap();
        backfill_usage_ledger(&repo.conn).unwrap();

        let stats = repo.usage_stats(&UsageQuery::default()).await.unwrap();
        assert_eq!(stats.totals.calls, 1);
        assert_eq!(stats.totals.total_tokens, 15);
        let page = repo.usage_records(&UsageQuery::default()).await.unwrap();
        assert_eq!(page.records[0].kind, "legacy");
        // 消息本身没存过 model（生产环境同此）→ 回退到会话的 model_id，
        // 否则历史流水取不到单价、费用恒为 0
        assert_eq!(page.records[0].model, "gpt-4o");
    }

    /// v2 → v3 修补：早于本修补的用户，历史流水的 model 是空串 → 费用恒为 0。
    #[tokio::test]
    async fn repair_usage_ledger_model_fills_from_session() {
        let repo = open_tmp();
        repo.upsert_session(&test_session("s1", "会话一", 100)).await.unwrap();

        let mut legacy = usage_entry(Some("m1"), 1_000, "legacy", 100);
        legacy.model = String::new(); // 模拟 v2 回填出来的空模型
        let mut orphan = usage_entry(Some("m2"), 2_000, "legacy", 100);
        orphan.model = String::new();
        orphan.session_id = Some("gone".into()); // 会话已删 → 无法补齐
        repo.append_usage(&[legacy, orphan]).await.unwrap();

        // 跑两次（迁移可重入）：结果必须一致，不得把已补好的值写坏
        repair_usage_ledger_model(&repo.conn).unwrap();
        repair_usage_ledger_model(&repo.conn).unwrap();

        let page = repo.usage_records(&UsageQuery::default()).await.unwrap();
        let by_id: std::collections::HashMap<String, String> = page
            .records
            .iter()
            .map(|r| (r.message_id.clone().unwrap_or_default(), r.model.clone()))
            .collect();
        assert_eq!(by_id["m1"], "gpt-4o");
        assert_eq!(by_id["m2"], "", "会话已删的流水补不上，保持空串");
    }
}
