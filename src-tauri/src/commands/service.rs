//! 后台服务面板（聊天页右上角）的 Tauri 命令层：只做转交，语义全在
//! `virlen_core::agent::native_tools::service::panel`（面板与四个工具同一张注册表、同样会话隔离）。
//! ⚠️ 新增命令必须登记到 `lib.rs` 的 `generate_handler![...]`（铁律 4）。

use serde_json::Value;

use virlen_core::agent::native_tools::{
    ack_service_notice, kill_service_snapshot, list_all_service_snapshots, list_service_snapshots,
    read_service_console, resize_service_console, write_service_console,
};

/// 列出某会话的后台服务（按启动时间升序，含已结束但还在表中的条目）。
/// 面板开时 1s / 关时 5s 轮询，故**不埋点**（会被自己的轮询刷屏）。
#[tauri::command]
pub async fn cmd_list_background_services(session_id: String) -> Vec<Value> {
    list_service_snapshots(&session_id)
}

/// 列出**所有会话**的后台服务（新对话页全局入口；每行多一个 `sessionId` 归属）。
/// ⚠️ 只是界面放开可见范围，模型侧四个工具仍严格会话隔离。
#[tauri::command]
pub async fn cmd_list_all_background_services() -> Vec<Value> {
    list_all_service_snapshots()
}

/// 终止某个后台服务并回它的最新快照。`None` = 本会话没有这个 id（刷新列表即可）；已结束的幂等。
/// ⚠️ 与工具 `kill_background_service` 不同：**不摘条目**（面板「已结束」页要继续显示）。
#[tauri::command]
pub async fn cmd_kill_background_service(session_id: String, id: String) -> Option<Value> {
    kill_service_snapshot(&session_id, &id).await
}

// ==================== 终端弹窗（P3） ====================
// 三条命令只服务用户在弹窗里的交互（与工具无关），同一张注册表、同样按 `session_id` 隔离。

/// 读服务的终端输出（自绝对偏移 `from` 起的增量；`None` = 本会话已无此 id）。
/// `reset` 是**出参**（依 `from` 推导）：`true` = 回的是整个窗口（首次读取 / 环形已丢掉开头），
/// 前端丢掉本地内容整段重放；否则只续接新增部分。
#[tauri::command]
pub async fn cmd_service_console_read(
    session_id: String,
    id: String,
    from: u64,
) -> Option<Value> {
    read_service_console(&session_id, &id, from)
}

/// 把用户键击（或粘贴）写进服务的伪控制台。`false` = 没写进去（非本会话 / 已结束 / 管道模式）。
/// ⚠️ 只记「写没写进去」，**不记内容**（PTY 里敲的常是密码 / token）。
#[tauri::command]
pub async fn cmd_service_console_write(session_id: String, id: String, data: String) -> bool {
    write_service_console(&session_id, &id, &data)
}

/// 调整伪控制台尺寸。`false` = 没有可调的控制台（非本会话 / 已结束 / 管道模式）。
/// 同尺寸重复上报后端会去重，前端可无脑调（`ResizeObserver` 会反复回调）。
#[tauri::command]
pub async fn cmd_service_console_resize(
    session_id: String,
    id: String,
    cols: u16,
    rows: u16,
) -> bool {
    resize_service_console(&session_id, &id, cols, rows)
}

// ==================== 结束通知 ====================

/// 前端确认「这条结束通知已上屏 + 落库」→ Rust 才把它从待注入队列里摘掉（幂等）。
///
/// ⚠️ 不能用 `agent:service-exit` 的 emit 返回值代替：没有监听者（前端未挂监听 / webview 重载 /
/// 窗口已销毁）时 emit 同样成功 —— 按它出队会让这条通知凭空消失（模型与用户都看不到）。
#[tauri::command]
pub async fn cmd_ack_service_notice(id: String) -> bool {
    ack_service_notice(&id)
}
