//! `virlen-core` —— Virlen 的核心库（零 `tauri::` 依赖）
//!
//! 与 GUI（`virlen-app`）和 headless CLI（`virlen-cli`）共用同一份实现：引擎、会话与配置持久化、
//! 沙盒、安全判定、RAG、视觉、宿主抽象。
//!
//! ## 边界（本 crate 的唯一硬约束）
//!
//! ⚠️ 不得出现 `tauri::`。一切宿主差异走 [`host::HostEnv`] 注入：
//!
//! | 能力 | 本 crate（core） | `virlen-app`（GUI 壳） |
//! |---|---|---|
//! | 资源目录 / 数据目录 | [`host::HostEnv`] trait + [`host::CliHost`] | `TauriHost`（`app.path()`） |
//! | 事件出口 | [`agent::event_sink::EventSink`] trait | `TauriEventSink`（`app.emit`） |
//! | 埋点出口 | [`telemetry`] 的 `TelemetrySink` | `TauriTelemetrySink` |
//! | 全部 `#[tauri::command]` | —— | `virlen-app` 的 `src/commands/` |
//!
//! 换句话说：GUI 与 CLI 的行为差异只允许来自「宿主注入」，不允许来自「两份实现」（铁律 1 在 crate
//! 层面的落地 —— 由编译器强制）。
//!
//! ⚠️ headless CLI 入口不在本 crate（在 `virlen-cli`，它只依赖本 crate）：core 只管「引擎 + 持久化」，
//! 入口形态可以独立演进。

pub mod agent;
pub mod file_ops;
pub mod host;
pub mod rag;
pub mod sandbox;
pub mod search;
pub mod security;
pub mod session_db;
pub mod telemetry;
pub mod vision;
