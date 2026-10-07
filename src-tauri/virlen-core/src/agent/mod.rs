//! Agent 引擎 — Rust 原生聊天循环（**零 `tauri::` 依赖**）。
//!
//! 移植自 TS `src/domain/engine/`，两者是同一套语义的两份实现（改语义须两侧同步）。
//! 与宿主的接口：事件出口 [`event_sink::EventSink`]、宿主环境 [`host::HostEnv`]、
//! 配置 `session_db::SettingsRepo`、持久化 `session_db::SessionRepo`（先落库再 emit）。
//! Tauri 侧（命令 / `TauriEventSink`）全在 `virlen-app` 的 `src/commands/agent.rs`。

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
pub mod memory;
pub mod native_tools;
pub mod process_tree;
pub mod prompts;
pub mod provider;
pub mod run_state;
pub mod storm_breaker;
// `title`：会话标题生成（LLM）—— GUI / CLI 共用（原 TS `domain/engine/generate-title.ts`）
pub mod title;
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
/// 生命周期参数不可省：它是 trait object 的 object lifetime。写在类型别名里时该 bound 会退化
/// 成默认的 `'static`（不像 `let` 注解那样可被推断），必须显式带出来；使用处用
/// `BoxedPersistSnapshotFn<'_>` 让编译器推断。
pub(crate) type BoxedPersistSnapshotFn<'a> = Box<dyn Fn(&types::Run) + Sync + Send + 'a>;
