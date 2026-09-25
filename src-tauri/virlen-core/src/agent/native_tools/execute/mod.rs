//! execute — 代码执行分类（分类 id: execute）
//!
//! 一个工具一个文件：
//! - `execute_command`：shell 命令执行（风险分类 → 审批 → 原生 spawn + 超时/取消）
//! - `execute_script`：写脚本文件并执行（可选执行后删除）
//!
//! - `common/` 为分类内公共（按职责拆分为子模块）：终端输出解码 / 命令解析与风险分类 /
//!   运行中命令注册表 / 终端输出处理 / 统一运行器 `run_command_native`（沙盒 + 裸跑两条路径）。
//! - `pty_session.rs` 为 PTY 会话注册表：`tool_call_id` → 伪控制台输入通道，
//!   支撑前端 `pty_write` / `pty_resize`（用户中途插键盘）。

mod common;
mod execute_command;
mod execute_script;
mod pty_session;

pub use common::kill_running_command;
// `run_command_native`：供 TS 引擎路径经 `pty_run_command` Tauri 命令复用
// 「沙盒 + ConPTY」运行器（docs/pty-research.md §7 #14）
pub(crate) use common::run_command_native;
pub(crate) use execute_command::execute_command_tool;
pub(crate) use execute_script::execute_script_tool;
// PTY 会话交互入口（供 `agent/mod.rs` 的 `pty_write` / `pty_resize` / `pty_key` / `pty_set_held` Tauri 命令转调）
pub use pty_session::{pty_key, pty_resize, pty_set_held, pty_write};
