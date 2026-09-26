//! `SessionRepo` trait 与 `NoopSessionRepo` 空实现
//!
//! 从原 `session_db.rs` 拆出：trait 是 Rust 引擎与 Tauri 命令共用的持久化接口，
//! 与具体实现（`sqlite.rs`）解耦。

use crate::agent::types::{Message, Session};
use crate::session_db::types::{
    MessagePage, MessageSearchPage, MessageTimelinePage, MessageWindow, SearchCursor,
    SessionStat, UserMessageRef,
};
use crate::session_db::usage::{UsageEntry, UsageQuery, UsageRecordPage, UsageStats};
use async_trait::async_trait;

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

    /// 追加消息，但**会话不存在时跳过**（返回 `Ok(false)`）—— 专供 Agent 引擎落库。
    ///
    /// 为什么需要这道守卫：删除会话与进行中的 run 是天然竞态。会话行（连同消息）被删掉后，
    /// 引擎仍会继续 append（assistant 回复 / 工具结果 / 迭代反馈），而 `messages` 表
    /// 既没有外键约束、也没有级联删除 —— 这些行会变成 `session_id` 指向不存在会话的
    /// **孤儿消息**：任何查询都查不到（跨会话检索是 `JOIN sessions`），也没有清理逻辑，
    /// 只会让数据库文件持续变大。
    ///
    /// `append_messages` 本身的语义不变（写了就是写了，不静默丢弃）；
    /// 默认实现基于 `get_session`，`SqliteSessionRepo` 覆写为「同一把锁 + 同一事务内校验」。
    async fn append_messages_if_alive(
        &self,
        session_id: &str,
        messages: &[Message],
    ) -> Result<bool, String> {
        if self.get_session(session_id).await?.is_none() {
            return Ok(false);
        }
        self.append_messages(session_id, messages).await?;
        Ok(true)
    }

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
    async fn truncate_messages_from(
        &self,
        session_id: &str,
        message_id: &str,
    ) -> Result<(), String>;
    /// 删除会话中「指定消息及其之后」的全部消息，并在**同一事务**内把 `messages` 写入该后缀。
    ///
    /// 用于「内存里只有一段**连续后缀窗口**」时把（修复过的）窗口整体回写：
    /// `replace_messages` 是全量替换，在只加载了尾部窗口时会把**还没加载的更早消息抹掉**；
    /// 本方法只动「从目标消息起」的后缀，前缀（更早的历史）原样保留。
    /// 目标消息不存在时不删除任何行、也不写入（与 `truncate_messages_from` 同一条安全约定）。
    async fn replace_messages_from(
        &self,
        session_id: &str,
        from_message_id: &str,
        messages: &[Message],
    ) -> Result<(), String>;
    /// 列出所有会话（不含 messages，按 updated_at 降序）
    async fn list_sessions(&self) -> Result<Vec<Session>, String>;
    /// 批量取每个会话的统计（消息条数 + 上下文占用 token）
    ///
    /// 专供 `list-session` 的两列。口径不在这里：`context_tokens` 由
    /// [`crate::agent::compress::context_tokens`] 定义（与桌面端 token 环同一个口径），
    /// 实现只需返回「该会话最后一条有 `usage` 或带 `uiData.contextTokens` 的消息」。
    async fn session_stats(&self) -> Result<Vec<SessionStat>, String>;
    /// 获取单个会话元数据（不含 messages）
    async fn get_session(&self, session_id: &str) -> Result<Option<Session>, String>;
    /// 获取会话的全部消息（按插入顺序）
    async fn get_messages(&self, session_id: &str) -> Result<Vec<Message>, String>;

    /// 获取「模型当前上下文」所需的消息：**从最后一条 `summary` 起**（含它）到最新，
    /// 无 `summary` 时返回全部（均按插入顺序升序）。
    ///
    /// 语义等价于「`get_messages` 之后丢掉最后一个 summary 之前的全部消息」——
    /// 请求组装（`agent::provider` 的切片）本就只保留最后一个 summary 及其之后的消息，
    /// 因此断点恢复等「以库为权威回读上下文」的场景无需把已被压缩的旧历史读进内存 /
    /// 反序列化（大历史下正是「继续」要等好几秒的主因之一）。
    ///
    /// ⚠️ 旧消息**仍留在库里**：模型侧查询工具（`list_messages` / `read_messages`）靠它们
    /// 检索「已压缩区间」，删掉会让那两个工具失去意义。本方法只影响「回读进内存的上下文」，
    /// 不影响库内容。
    async fn get_context_messages(&self, session_id: &str) -> Result<Vec<Message>, String>;

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

    /// 兜底回收**孤儿消息**（`session_id` 指向不存在会话的行），返回删除条数。
    ///
    /// 用于清理历史遗留数据（早期版本删除会话时若有 run 在跑，会经由
    /// `append_messages` 写入孤儿消息）。幂等；无孤儿时开销只是一次反连接扫描。
    /// ⚠️ **不动 `usage_ledger`**：用量是已发生消费的事实记录，删会话不清账
    /// （见 `delete_session` 与 docs/token-usage-stats.md）。
    async fn purge_orphan_messages(&self) -> Result<usize, String>;

    /// 是否存在**真实的持久化后端**（`NoopSessionRepo` 覆写为 `false`）。
    ///
    /// 消息查询工具（`list_messages` / `read_messages`）据此给出与 JS 侧一致的
    /// 「本地存储不可用」提示 —— JS 路径是 `invoke(...)` 抛错 → `null` → 同一条文案。
    /// 没有这个探针的话，`NoopSessionRepo` 的空结果会被误报成「该会话还没有消息」。
    fn is_available(&self) -> bool {
        true
    }

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
    fn is_available(&self) -> bool {
        false
    }
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
    async fn replace_messages_from(
        &self,
        _session_id: &str,
        _from_message_id: &str,
        _messages: &[Message],
    ) -> Result<(), String> {
        Ok(())
    }
    async fn list_sessions(&self) -> Result<Vec<Session>, String> {
        Ok(Vec::new())
    }
    async fn session_stats(&self) -> Result<Vec<SessionStat>, String> {
        // 无持久化后端：没有统计数据（调用方按「0 条 / 无占用」展示）
        Ok(Vec::new())
    }
    async fn get_session(&self, _session_id: &str) -> Result<Option<Session>, String> {
        Ok(None)
    }
    async fn get_messages(&self, _session_id: &str) -> Result<Vec<Message>, String> {
        Ok(Vec::new())
    }
    async fn get_context_messages(&self, _session_id: &str) -> Result<Vec<Message>, String> {
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
    async fn purge_orphan_messages(&self) -> Result<usize, String> {
        Ok(0)
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
