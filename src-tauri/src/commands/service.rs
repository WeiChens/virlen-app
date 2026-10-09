//! 后台服务**面板**（聊天页右上角，P2）的 Tauri 命令层（GUI 壳）
//!
//! 只做「转交」：语义全在 `virlen-core` 的 `agent::native_tools::service::panel` ——
//! 面板与四个工具看的是**同一张注册表**（会话隔离），因此在面板里终止的服务，
//! 模型下一次 `get` 就会如实看到「被终止」（`kill_requested` 已置位）。
//!
//! P3 增三条**终端弹窗**命令（读合并流 / 写键击 / 改尺寸）：它们只服务用户在弹窗里的交互，
//! 与工具无关，但同样只认本会话的 id。
//!
//! P4（新对话页的全局入口）：`cmd_list_all_background_services` 列出**所有会话**的服务（每行带
//! `sessionId` 归属）—— 其余命令不变，跨会话的终止 / 终端交互由前端带上**行自己的**会话 id。
//!
//! ⚠️ 新增命令必须登记到 `src/lib.rs` 的 `generate_handler![...]`（铁律 4）。
//! `session_id` 由前端给**当前会话** —— 它就是会话隔离的边界。

use serde_json::Value;

use virlen_core::agent::native_tools::{
    kill_service_snapshot, list_all_service_snapshots, list_service_snapshots,
    read_service_console, resize_service_console, write_service_console,
};

/// 列出某个会话的后台服务（面板数据源；按启动时间升序，含已结束但还在表中的条目）
///
/// 面板打开时 1s、关着时 5s 轮询一次，因此**不埋点**（埋点会被自己的轮询刷屏）。
#[tauri::command]
pub async fn cmd_list_background_services(session_id: String) -> Vec<Value> {
    list_service_snapshots(&session_id)
}

/// 列出**所有会话**的后台服务（新对话页的全局入口用；每行多一个 `sessionId` 归属）
///
/// 与上面那条同一张表、同一份字段：只在聊天页**没有选中会话**时被前端调用 —— 服务是活进程，
/// 切到新对话页也得能看到它（并就地终止 / 接管终端）。⚠️ 只是**界面**放开可见范围，
/// 模型侧四个工具仍严格会话隔离。
#[tauri::command]
pub async fn cmd_list_all_background_services() -> Vec<Value> {
    list_all_service_snapshots()
}

/// 终止某个后台服务（面板「终止」按钮）并回它的最新快照
///
/// 返回 `None` = 本会话没有这个 id（多半是 AI 刚把它 kill 掉并清出了注册表）→ 面板刷新列表即可；
/// 已结束的服务**幂等**：不杀、只回现状（按钮在「已结束」页本来就不可点）。
/// ⚠️ 与工具 `kill_background_service` 不同：**不摘条目**（面板「已结束」页要继续显示它）。
#[tauri::command]
pub async fn cmd_kill_background_service(session_id: String, id: String) -> Option<Value> {
    kill_service_snapshot(&session_id, &id).await
}

// ==================== 终端弹窗（P3） ====================
//
// 三条命令只服务**用户**在弹窗里的交互（与工具无关）：键击 / 尺寸 / 读合并输出流。
// 全部走与列表 / 终止同一张注册表，会话隔离边界同样是前端给的 `session_id`。

/// 读服务的终端输出（自绝对偏移 `from` 起的增量；`None` = 本会话已没有这个 id）
///
/// 弹窗打开时约 350ms 一次（运行中）/ 1500ms 一次（已结束），带偏移续接，因此每次只传新增片段。
/// `reset=true` 时回整个窗口（首次读取 / 环形已丢掉客户端持有的开头），前端整段重放。
#[tauri::command]
pub async fn cmd_service_console_read(
    session_id: String,
    id: String,
    from: u64,
) -> Option<Value> {
    read_service_console(&session_id, &id, from)
}

/// 把用户键击（或粘贴内容）写进服务的伪控制台
///
/// `false` = 没写进去（非本会话 / 已结束 / 管道模式）—— 前端据此复位输入状态（不弹错：键击丢失）
/// 不是恶性错误。⚠️ **只记「写没写进去」，不记内容**（PTY 里敲的常是密码 / token）。
#[tauri::command]
pub async fn cmd_service_console_write(session_id: String, id: String, data: String) -> bool {
    write_service_console(&session_id, &id, &data)
}

/// 调整服务伪控制台的尺寸（列×行）
///
/// `false` = 没有可调的控制台（非本会话 / 已结束 / 管道模式）。同尺寸重复上报会被后端去重，
/// 因此前端可以无脑调（`ResizeObserver` 会反复回调）。
#[tauri::command]
pub async fn cmd_service_console_resize(
    session_id: String,
    id: String,
    cols: u16,
    rows: u16,
) -> bool {
    resize_service_console(&session_id, &id, cols, rows)
}
