//! Agent 引擎模块 — Rust 原生聊天循环（**零 `tauri::` 依赖**）
//!
//! 移植自 `src/domain/engine/`（TS），两者是同一套语义的两份实现（铁律 1：改语义要两侧同步）。
//!
//! ## 与宿主的接口（本模块不出现 `tauri::`）
//!
//! - 事件出口：[`event_sink::EventSink`]（GUI 注入 `TauriEventSink`；CLI / 单测注入自己的实现）
//! - 宿主环境：[`host::HostEnv`]（资源目录 + 数据目录）
//! - 配置：`session_db::SettingsRepo`（`app_settings` 表）
//! - 持久化：`session_db::SessionRepo`（引擎内直落 SQLite，先落库再 emit）
//!
//! Tauri 侧的一切（`#[tauri::command]`、`init_agent_engine`、`TauriEventSink`）都在
//! `virlen-app`（GUI 壳）里，见其 `src/commands/agent.rs`。

pub mod bridge;
pub mod cancellation;
// `compress`：上下文压缩（两种模式）—— 与 TS `domain/engine/compress-*.ts` 同语义
pub mod compress;
pub mod engine;
pub mod event_sink;
pub mod host;
pub mod iteration;
pub mod llm_loop;
pub mod llm_round;
pub mod native_tools;
pub mod process_tree;
pub mod prompts;
pub mod provider;
pub mod run_state;
pub mod storm_breaker;
pub mod tool_defs;
pub mod tool_executor;
pub mod types;
pub mod usage;
pub mod verifier;

/// 快照持久化回调 —— `iteration` / `llm_loop` 的 `persist_snapshot` 字段共用类型。
///
/// 单列成别名只为给 `clippy::type_complexity` 一个名字：形状来自「引擎把当前 `Run`
/// 交给宿主持久化」，两个入口同一语义。
pub(crate) type PersistSnapshotFn<'a> = &'a (dyn Fn(&str, &types::Run) + Sync + Send);

/// 装箱后的持久化闭包 —— `llm_loop` 把 `persist_snapshot` 捕获成本地闭包时用。
///
/// ⚠️ 生命周期参数不可省：它是 trait object 的 **object lifetime**。写在类型别名里时该 bound
/// 会退化成默认的 `'static`（不像 `let` 注解那样可被推断），必须显式带出来；
/// 使用处用 `BoxedPersistSnapshotFn<'_>` 让编译器推断。
pub(crate) type BoxedPersistSnapshotFn<'a> = Box<dyn Fn(&types::Run) + Sync + Send + 'a>;
