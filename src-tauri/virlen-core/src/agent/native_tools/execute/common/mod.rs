//! execute — 代码执行分类公共模块（分类 id: execute）
//!
//! 供本分类下的 `execute_command` / `execute_script` 复用，按职责拆分为子模块：
//!   1. [`decode`]   终端输出解码（UTF-8 优先、GBK 兜底；跨 8KB 分块安全）
//!   2. [`classify`] 命令解析与风险分类（safe | install | dangerous）+ 风险文案
//!   3. [`registry`] 运行中命令注册表（前端 ToolOutput.kill → 终止整棵进程树）
//!   4. [`terminal`] 终端输出处理（\r 覆盖 / ANSI 转义序列）
//!   5. [`runner`]   统一运行器 run_command_native（沙盒优先，失败降级裸跑；`bypass_sandbox` 时直接裸跑）
//!   6. [`rules`]    「忽略沙盒命令」规则：命中的命令免脱壳审批 + 强制无沙盒执行
//!                   （**Rust 侧本地判定**：text / regex 原生，js 交内嵌 QuickJS）

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
    PERM_SCRIPT,
};
// `SANDBOX_BYPASS_HINT` 仅在 execute_command 的测试里经 `super::common::…` 直接断言，
// 非测试构建下本重导出“未被使用”，故显式 allow。
#[allow(unused_imports)]
pub(crate) use classify::SANDBOX_BYPASS_HINT;
// `PERM_TERMINAL_*` 仅在测试里使用，非测试构建“未被使用”，显式 allow。
#[allow(unused_imports)]
pub(crate) use classify::{PERM_TERMINAL_DANGEROUS, PERM_TERMINAL_INSTALL, PERM_TERMINAL_NORMAL};
pub(crate) use runner::{pty_available, sandbox_mode, SandboxMode};

// 「忽略沙盒命令」规则（execute_command / execute_script 共用）
// 原「经内部交互 sandbox_rule_check 问 JS」已删除：规则随 security 快照下发，Rust 侧本地判定。
pub(crate) use rules::{apply_rule_clearance, match_sandbox_ignore_rule, with_rule_hint};

// `kill_running_command` / `run_command_native`：供 `execute::mod` 再导出，
// `run_command_native` 另供 TS 引擎路径经 `pty_run_command` 复用。
pub use registry::kill_running_command;
pub(crate) use runner::run_command_native;
