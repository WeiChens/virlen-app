//! service — 后台服务分类（分类 id: service）：**常驻**命令（dev server / watch / 长跑任务）。
//!
//! 与 `execute` 分类的区别只有一条，但很关键：**工具返回后进程继续活着**。
//! 因此这里不写「超时即杀」那套，而是把进程交给常驻任务（`runner::supervise`），
//! 由四个工具管理它的输出与寿命：
//!
//! | 工具 | 作用 |
//! |---|---|
//! | `start_background_service` | 起服务（审批链与 `execute_command` 同源；返回时带一段启动输出） |
//! | `get_background_service` | 读状态 / 新输出 / 退出码（支持 `waitMs` / `waitFor`） |
//! | `kill_background_service` | 杀整棵进程树，拿收尾输出 |
//! | `list_background_services` | 列**本会话**的服务 |
//!
//! 另有一条**给界面用**的出口（不是工具）：`panel.rs` —— 聊天页右上角「后台服务」面板（P2）
//! 经 Tauri 命令读同一张注册表（列表 / 终止 / **终端弹窗的读写与尺寸**，P3）。
//!
//! **会话隔离**：注册表（`registry.rs`）按 `session_id` 归属，四个工具只在本会话内查找；
//! 会话删除 / 应用退出 / 引擎销毁 / CLI 结束都会把服务一并清掉（见 `kill_session_services` /
//! `kill_all_services`），进程层面另有 Job Object 的 `KILL_ON_JOB_CLOSE` 兜底（崩溃不留孤儿）。
//!
//! **结束通知**（`notice.rs`）：服务一结束就把这件事告诉 AI（在跑 → 下一次 LLM 请求前追加；
//! 空闲 → 立刻落一条 feedback 消息，界面可见），用户手动终止也算。「什么时候发、发给谁、
//! 发什么」全在那个文件里，本模块其余部分只负责把「进程真退出了」这个事实转给它。
//!
//! **交互控制台**（P3）：Windows 上服务跑在伪控制台（ConPTY）里（`runner.rs` 的 PTY 路径），
//! 句柄（输入写端 + `HPCON`）挂在条目上（`pty.rs`），用户在面板弹窗里直接敲键盘 / 改尺寸。
//! 非 Windows 保持匿名管道（弹窗只能只读回放）。

mod common;
mod get;
mod kill;
mod list;
mod notice;
mod panel;
mod pty;
mod registry;
mod runner;
mod start;

pub(crate) use get::get_background_service_tool;
pub(crate) use kill::kill_background_service_tool;
pub(crate) use list::list_background_services_tool;
pub(crate) use start::start_background_service_tool;

// 「服务结束通知」的宿主出口 + 会话活跃标记（引擎 / 轮次边界用，见 `notice.rs`）。
pub use notice::{
    attach_host as attach_service_notice_host, inject_pending as inject_service_notices,
    mark_session_active, mark_session_idle, ServiceNoticeHost,
};

// 生命周期清理：会话删除 / 应用退出 / 引擎销毁 / CLI 结束（供命令层与引擎调用）。
pub use registry::{kill_all_services, kill_session_services};
// 面板（聊天页右上角）的数据出口：与四个工具同表，但只读 + 不摘条目（见 `panel.rs`）；
// 另含终端弹窗（P3）的读 / 写 / 改尺寸三条 + 新对话页的跨会话全局视图（P4）。
pub use panel::{
    kill_service_snapshot, list_all_service_snapshots, list_service_snapshots,
    read_service_console, resize_service_console, write_service_console,
};

#[cfg(test)]
mod tests;
