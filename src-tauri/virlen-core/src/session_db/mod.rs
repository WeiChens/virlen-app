//! 会话持久化 — SQLite 直落（不经过 JS/IndexedDB），即使前端 WebView 卡住 / 崩溃也能落库。
//!
//! 模块划分（原单文件 4200+ 行）：`types`（IPC DTO）、`repo`（`SessionRepo` + `NoopSessionRepo`）、
//! `schema`（DDL + 初始化 + 迁移）、`row`（JSON 辅助 + 行映射）、`message_query`、`usage`（用量账本）、
//! `settings`（`app_settings` + `SettingsRepo`）、`memory`（`memories` / `memory_runs` + `MemoryRepo`）、
//! `sqlite`（rusqlite：WAL + Mutex 单写连接 + `spawn_blocking`）、`maintenance`、`open`。
//!
//! ⚠️ 全部 `cmd_*` 与 `init_session_db` / `manage_noop_settings` 需要 `tauri::AppHandle`，住在
//! `virlen-app` 的 `src/commands/session_db.rs`。
//!
//! `sessions` + `messages`（rowid 排序）拆表；复杂字段（params / tags / content / tool_calls / ui_data 等）以 JSON 列存储。

pub(crate) mod open;
pub(crate) mod maintenance;
mod memory;
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
// 长期记忆（记忆功能 P0/P2）：`memories` / `memory_runs` 两张表 —— 与会话 / 配置同一个 `virlen.db`
pub use memory::{
    decide_claim, ClaimDecision, ClaimOptions, MemoryRecord, MemoryRepo, MemoryRun, NoopMemoryRepo,
    SqliteMemoryRepo, MEMORY_KIND_PROJECT, MEMORY_LEVEL_NORMAL, MEMORY_LEVEL_PERMANENT,
    MEMORY_ORIGIN_DISTILL, MEMORY_RUN_DONE, MEMORY_RUN_FAILED, MEMORY_RUN_PARTIAL,
    MEMORY_RUN_RUNNING, MEMORY_RUN_SKIPPED,
};
// 库维护（GUI 命令 `cmd_db_*` 需要）
pub use maintenance::{total_bytes, CheckpointResult, DbMaintenance, DbStats, MaintainResult};
pub use repo::{NoopSessionRepo, SessionRepo};
pub use settings::{NoopSettingsRepo, SettingsRepo, SqliteSettingsRepo};
// IPC DTO：GUI 的 `cmd_*` 命令签名用到（core 内部的原生工具同样使用）
pub use types::{
    MessagePage, MessageSearchPage, MessageTimelinePage, MessageWindow, ModelUsageCount,
    SearchCursor, SessionMaterial, SessionStat, UserMessageRef, MSG_QUERY_MAX_LIMIT,
};
/// 仅供测试构造 DTO（生产路径只读不构造）
#[cfg(test)]
pub(crate) use types::{MessageBrief, MessageTimelineItem, ToolCallBrief};
pub use usage::{UsageEntry, UsageQuery, UsageRecordPage, UsageStats};
