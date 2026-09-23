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
//! - `sqlite`：`SqliteSessionRepo`（rusqlite 实现：WAL + Mutex 单写连接 + spawn_blocking）
//! - `maintenance`：库维护（体积统计 / WAL 截断 / VACUUM，设置 → 存储用）
//! - `commands`：`init_session_db` 与全部 Tauri 命令
//!
//! 表结构：`sessions`（会话元数据）+ `messages`（消息，rowid 排序）拆表。
//! 复杂字段（params / tags / content / tool_calls / ui_data 等）以 JSON 列存储。

pub(crate) mod commands;
pub(crate) mod maintenance;
mod message_query;
mod repo;
mod row;
mod schema;
mod sqlite;
mod types;
mod usage;

#[cfg(test)]
mod tests;

// `#[tauri::command]` 把命令注册在「定义它的模块」路径下（lib.rs 按 `session_db::commands::cmd_*` 引用），
// 因此这里不重导出命令，只导出 `init_session_db`（普通函数，可安全重导出）。
pub use commands::init_session_db;
pub use maintenance::DbMaintenance;
pub use repo::{NoopSessionRepo, SessionRepo};
pub use usage::UsageEntry;
