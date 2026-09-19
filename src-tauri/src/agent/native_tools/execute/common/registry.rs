//! 运行中命令注册表 —— 支持前端「终止」按钮（ToolOutput.kill）。
//!
//! `tool_call_id` → [`RunningCommand`]（子进程 pid + kill 请求标志 + 终止器），
//! 前端点击「终止」时经 [`kill_running_command`] 一键杀整棵进程树。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

/// 跨平台强杀进程树（进程 + 全部后代）。
/// 委托给 `process_tree` 模块：Windows 递归 Toolhelp32 枚举后代逐个 taskkill，
/// Unix 递归 `ps` 枚举后代逐个 kill，不依赖进程树关系 / 进程组。
pub(super) fn kill_process_tree(pid: u32) {
    crate::agent::process_tree::kill_process_tree(pid);
}

/// 终止器：一键杀整棵进程树（闭包捕获 Job Object / 沙盒 Job 等）。
pub(super) type Terminator = Arc<dyn Fn() + Send + Sync>;

/// 运行中命令条目：记录子进程 pid、kill 请求标志和终止器
struct RunningCommand {
    pid: u32,
    /// 前端点击「终止」后置位，等待循环检测到后按用户取消处理
    kill_requested: Arc<AtomicBool>,
    /// 终止器：一键杀整棵进程树（无则为 None，仅递归 taskkill 兜底）
    terminator: Option<Terminator>,
}

/// 运行中命令注册表：tool_call_id → RunningCommand
static RUNNING_COMMANDS: LazyLock<Mutex<HashMap<String, RunningCommand>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// 注册一个运行中的命令（run_command_native 内部调用）
pub(super) fn register_running_command(
    tool_call_id: &str,
    pid: u32,
    terminator: Option<Terminator>,
) -> Arc<AtomicBool> {
    let kill_requested = Arc::new(AtomicBool::new(false));
    RUNNING_COMMANDS.lock().unwrap().insert(
        tool_call_id.to_string(),
        RunningCommand {
            pid,
            kill_requested: kill_requested.clone(),
            terminator,
        },
    );
    kill_requested
}

/// 移除已结束的命令
pub(super) fn unregister_running_command(tool_call_id: &str) {
    RUNNING_COMMANDS.lock().unwrap().remove(tool_call_id);
}

/// 按 tool_call_id 终止正在运行的命令（前端 ToolOutput.kill 回调调用）
///
/// 返回是否找到并发送了 kill 请求。
pub(crate) fn kill_running_command(tool_call_id: &str) -> bool {
    let entry = {
        let map = RUNNING_COMMANDS.lock().unwrap();
        map.get(tool_call_id)
            .map(|c| (c.pid, c.kill_requested.clone(), c.terminator.clone()))
    };
    if let Some((pid, kill_requested, terminator)) = entry {
        kill_requested.store(true, Ordering::SeqCst);
        // 优先 Job Object 一键全杀；再递归 taskkill 兜底
        if let Some(t) = &terminator {
            t();
        }
        kill_process_tree(pid);
        true
    } else {
        false
    }
}

/// 等待前端「终止」请求（kill_requested 被置位）
pub(super) async fn wait_for_kill_request(kill_requested: &Arc<AtomicBool>) {
    loop {
        if kill_requested.load(Ordering::SeqCst) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}
