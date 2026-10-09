//! `virlen-core` —— Virlen 的核心库（**零 `tauri::` 依赖**），与 GUI（`virlen-app`）和 headless CLI
//! （`virlen-cli`）共用同一份实现：引擎、会话与配置持久化、沙盒、安全判定、RAG、视觉、宿主抽象。
//!
//! ⚠️ 唯一硬约束：不得出现 `tauri::`，一切宿主差异走 [`host::HostEnv`] 注入：
//!
//! | 能力 | 本 crate | `virlen-app`（GUI 壳） |
//! |---|---|---|
//! | 资源 / 数据目录 | [`host::HostEnv`] + [`host::CliHost`] | `TauriHost` |
//! | 事件出口 | [`agent::event_sink::EventSink`] | `TauriEventSink` |
//! | 埋点出口 | [`telemetry`] 的 `TelemetrySink` | `TauriTelemetrySink` |
//! | `#[tauri::command]` | —— | `src/commands/` |
//!
//! 即 GUI 与 CLI 的差异只允许来自宿主注入，不允许来自两份实现。headless CLI 入口在 `virlen-cli`。

pub mod agent;
pub mod doc_parse;
pub mod file_ops;
pub mod host;
pub mod rag;
pub mod sandbox;
pub mod search;
pub mod security;
pub mod session_db;
pub mod telemetry;
pub mod vision;
