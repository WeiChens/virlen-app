//! `virlen-core` —— Virlen 的核心库（**零 `tauri::` 依赖**）
//!
//! 与 GUI（`virlen-app`）和 headless CLI（`virlen-cli`）**共用同一份实现**：
//! 引擎、会话与配置持久化、沙盒、安全判定、RAG、视觉、宿主抽象都在这里。
//!
//! ## 边界（本 crate 的唯一硬约束）
//!
//! **不得出现 `tauri::`。** 一切宿主差异走 [`host::HostEnv`] 注入：
//!
//! | 能力 | 本 crate（core） | `virlen-app`（GUI 壳） |
//! |---|---|---|
//! | 资源目录 / 数据目录 | [`host::HostEnv`] trait + [`host::CliHost`] | `TauriHost`（`app.path()`） |
//! | 事件出口 | [`agent::event_sink::EventSink`] trait | `TauriEventSink`（`app.emit`） |
//! | 埋点出口 | [`telemetry`] 的 `TelemetrySink` + 可插拔注册 | `TauriTelemetrySink` |
//! | 全部 `#[tauri::command]` | —— | `virlen-app` 的 `src/commands/` |
//!
//! 换句话说：**GUI 与 CLI 的行为差异只允许来自「宿主注入」，不允许来自「两份实现」**
//! （铁律 1 在 crate 层面的落地 —— 以前靠注释约定，现在由编译器强制）。
//!
//! ## 模块
//!
//! - [`agent`]：Agent 引擎（Rust 原生聊天循环，镜像 TS `src/domain/engine/`）
//! - [`session_db`]：会话 + 应用配置持久化（SQLite，WAL，单写连接）
//! - [`sandbox`]：跨平台沙盒（Windows：Job Object + 受限令牌 + ACL；Linux：Landlock）
//! - [`security`]：安全域（「忽略沙盒命令」规则的**权威**匹配 + `js` 规则内嵌求值）
//! - [`rag`]：知识库（turbovec 向量索引）
//! - [`vision`]：端侧视觉（quasivision，图片不出本机）
//! - [`host`]：宿主抽象（资源目录 + 数据目录）
//! - [`telemetry`]：埋点出口（可插拔 sink）
//! - [`file_ops`] / [`search`]：文件读写与文件搜索的底层实现
//!
//! ⚠️ headless CLI 入口**不在本 crate**：命令实现（`config` / `run` / `list-session` /
//! `list-agent`）与（规划的）TUI 都在 `virlen-cli`（它**只依赖本 crate**）—— 这样 core
//! 只管「引擎 + 持久化」，入口形态可以独立演进。

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
