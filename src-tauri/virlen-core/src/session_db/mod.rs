//! 会话持久化 — SQLite 直落（不经过 JS/IndexedDB）
//!
//! 目标：即使前端 WebView JS 卡住/崩溃，会话与消息也能由 Rust 侧直接落库。
//!
//! 模块划分（原单文件 `session_db.rs` 4200+ 行，按职责拆分）：
//! - `types`：IPC 传输的 DTO（分页 / 检索 / 消息查询）
//! - `repo`：`SessionRepo` trait + `NoopSessionRepo`（测试 / 无 SQLite 环境兜底）
//! - `schema`：DDL 常量 + 快速 schema 初始化 + 历史数据迁移（回填 `text_plain` / 用量账本）
//! - `row`：JSON 辅助 + `Row -> 领域对象` 映射 + 写入参数序列化
//! - `message_query`：消息查询工具（窗口 / 时序）与消息检索的查询辅助
//! - `usage`：用量账本（token 统计）的 DTO / 写入 / 聚合 / 明细 / 回填
//! - `settings`：应用设置（配置下沉 D3）—— `app_settings` 表 + `SettingsRepo`
//! - `sqlite`：`SqliteSessionRepo`（rusqlite 实现：WAL + Mutex 单写连接 + spawn_blocking）
//! - `maintenance`：库维护（体积统计 / WAL 截断 / VACUUM，设置 → 存储用）
//! - `open`：`open_session_db`（**零 `tauri::`** —— GUI 与 CLI 共用的同一份打开路径）
//!
//! ⚠️ 全部 `#[tauri::command]`（`cmd_*`）与 `init_session_db` / `manage_noop_settings`
//! 不在本 crate：它们需要 `tauri::AppHandle`，因此住在 `virlen-app` 的
//! `src/commands/session_db.rs`。
//!
//! 表结构：`sessions`（会话元数据）+ `messages`（消息，rowid 排序）拆表。
//! 复杂字段（params / tags / content / tool_calls / ui_data 等）以 JSON 列存储。

pub(crate) mod open;
pub(crate) mod maintenance;
mod message_query;
mod repo;
mod row;
mod schema;
mod settings;
mod sqlite;
mod types;
mod usage;

#[cfg(test)]
pub(crate) mod tests;

// `open_session_db` / `SessionDb` / `Spawner` 是 GUI（`virlen-app`）与 CLI（`virlen-cli`）
// 共用**同一条**库路径推导链的唯一入口，因此在这里公开重导出。
pub use open::{open_session_db, SessionDb, Spawner};
// 库维护（GUI 命令 `cmd_db_*` 需要）
pub use maintenance::{total_bytes, CheckpointResult, DbMaintenance, DbStats, MaintainResult};
pub use repo::{NoopSessionRepo, SessionRepo};
pub use settings::{NoopSettingsRepo, SettingsRepo, SqliteSettingsRepo};
// IPC DTO：GUI 的 `cmd_*` 命令签名用到（core 内部的原生工具同样使用）
pub use types::{
    MessagePage, MessageSearchPage, MessageTimelinePage, MessageWindow, SearchCursor,
    UserMessageRef, MSG_QUERY_MAX_LIMIT,
};
/// 仅供测试构造 DTO（生产路径只读不构造）
#[cfg(test)]
pub(crate) use types::{MessageBrief, MessageTimelineItem, ToolCallBrief};
pub use usage::{UsageEntry, UsageQuery, UsageRecordPage, UsageStats};
