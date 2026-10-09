//! execute — 代码执行分类公共模块（分类 id: execute），供 `execute_command` / `execute_script`
//! 复用，按职责拆子模块：`decode`（输出解码：UTF-8 优先 / GBK 兜底）、`classify`（命令解析与
//! 风险分类 + 文案）、`registry`（运行中命令注册表）、`terminal`（\r 覆盖 / ANSI）、`runner`
//! （统一运行器 `run_command_native`：沙盒优先、失败降级裸跑）、`rules`（「忽略沙盒命令」规则：
//! Rust 本地判定，text / regex 原生，js 交内嵌 QuickJS）。

mod classify;
mod decode;
mod registry;
mod rules;
mod runner;
mod terminal;

// ==================== 对外 API ====================
// 保持既有调用路径不变：`super::common::{...}`（供 execute_command / execute_script 使用）

pub(crate) use classify::{
    classify_command, command_decision, permission_for_risk, permission_label, resolve_decision,
    risk_info, with_bypass_hint, PermissionDecision, PERM_SANDBOX_COMMAND, PERM_SANDBOX_SCRIPT,
    PERM_SCRIPT, PERM_TERMINAL_BACKGROUND,
};
// 以下两项仅在测试里使用 → 非测试构建显式 allow(unused_imports)。
#[allow(unused_imports)]
pub(crate) use classify::SANDBOX_BYPASS_HINT;
#[allow(unused_imports)]
pub(crate) use classify::{PERM_TERMINAL_DANGEROUS, PERM_TERMINAL_INSTALL, PERM_TERMINAL_NORMAL};
pub(crate) use runner::{pty_available, sandbox_mode, SandboxMode};

// 后台服务（`native_tools/service`）复用项：沙盒会话准备 / 实际沙盒模式下发 / 终端输出处理 /
// 流式解码器 / 运行中命令注册（前端「终止」按钮）/ 进程树强杀 / 终止器。
// 服务与命令走**同一份**实现，避免「两套沙盒 / 两套 ANSI 处理 / 两套解码」（铁律 1）。
pub(crate) use decode::TerminalDecoder;
pub(crate) use registry::{
    kill_process_tree, register_running_command, unregister_running_command, Terminator,
};
pub(crate) use runner::{emit_sandbox_env, prepare_sandbox_session};
pub(crate) use terminal::process_terminal_output;

// 「忽略沙盒命令」规则（随 security 快照下发，Rust 本地判定；原「问 JS」路径已删除）。
pub(crate) use rules::{apply_rule_clearance, match_sandbox_ignore_rule, with_rule_hint};

// 供 `execute::mod` 再导出；`run_command_native` 另供 TS 引擎路径复用。
pub use registry::kill_running_command;
pub(crate) use runner::run_command_native;
// 跨 crate 供 TS 引擎入口 `run_command_for_ts_engine` 构造。
pub use runner::SandboxBypass;
