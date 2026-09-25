//! 全部 Tauri 命令（GUI 壳）
//!
//! 命令只做「参数兜底 + 转交」—— 业务语义全在 `virlen-core`。
//! 之所以集中在一个目录下：core 不得出现 `tauri::`，因此**所有** `#[tauri::command]`
//! 都必须住在 GUI crate；按域分文件后，core 里对应的模块名与这里一一对应。
//!
//! - [`agent`]：引擎命令 + 桥接回执 + PTY 交互（对应 `virlen_core::agent`）
//! - [`session_db`]：会话 / 消息 / 用量 / 设置 / 库维护（对应 `virlen_core::session_db`）
//! - [`rag`]：知识库（对应 `virlen_core::rag`）
//!
//! ⚠️ 新增命令后必须登记到 `lib.rs` 的 `tauri::generate_handler![...]`（铁律 4）。

pub mod agent;
pub mod rag;
pub mod session_db;
