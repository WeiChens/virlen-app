//! 托盘命令 — 前端的唯一接口
//!
//! ⚠️ 新增命令必须注册进 `lib.rs` 的 `generate_handler![]`（铁律 4），否则前端 `invoke` 静默 404。
//! 这些都是「应用自有命令」，不需要 `capabilities/default.json` 里的权限条目（窗口可见性/焦点判定
//! 都在 Rust 内做，前端不需要 window 权限）。
//!
//! 约定：托盘是增强能力，任何失败都不能影响聊天主流程 —— 所以这里的命令一律不返回错误（前端也是
//! fire-and-forget）。

use tauri::AppHandle;

use super::notify;

/// 会话开始/结束工作（幂等增量；前端 `tray-service` 的状态 reaction 推送）
#[tauri::command]
pub fn tray_set_working(
    app: AppHandle,
    session_id: String,
    working: bool,
    title: Option<String>,
) {
    super::set_working(&app, &session_id, working, title);
}

/// 设置同步（启动 + 变更时由前端推送；全部项都不传 = 无操作）
///
/// `force_window_active`：前端「强制激活窗口」开关。开着时窗口只要还在（只是失焦），
/// 前端会自己把窗口拎到前台，Rust 侧就不再多推一条系统通知（见 `notify::decide_remind`）。
///
/// `labels` 是 i18n 后的托盘菜单/提示文案补丁 —— 托盘菜单是原生菜单，
/// 语言资源在前端，Rust 侧只负责替换文案里的 `$__count__` 占位符。
#[tauri::command]
pub fn tray_sync_settings(
    app: AppHandle,
    close_to_tray: Option<bool>,
    notify_on_complete: Option<bool>,
    force_window_active: Option<bool>,
    labels: Option<super::TrayLabelsPatch>,
) {
    super::sync_settings(
        &app,
        close_to_tray,
        notify_on_complete,
        force_window_active,
        labels,
    );
}

/// 一次运行结束的提醒（由 `chat/event-handler.ts::finishWorking` 触发）
///
/// `viewing`：前端上报的「用户此刻正看着这条回复」（当前会话 == 该会话 + webview 有焦点）。
/// 不传 = false（按「没看到」处理，宁肯多提醒）。
#[tauri::command]
pub fn tray_notify_completed(
    app: AppHandle,
    session_id: String,
    title: Option<String>,
    preview: Option<String>,
    status: Option<String>,
    viewing: Option<bool>,
) {
    notify::notify_completed(
        &app,
        &session_id,
        title.as_deref(),
        preview.as_deref(),
        status.as_deref(),
        viewing.unwrap_or(false),
    );
}

/// 清除未读（`session_id` 省略 = 全清）；前端切到会话时调用
#[tauri::command]
pub fn tray_clear_attention(app: AppHandle, session_id: Option<String>) {
    super::clear_attention(&app, session_id.as_deref());
}

/// 显示主窗口（隐藏期间需要用户交互时由前端调用）
#[tauri::command]
pub fn tray_show_window(app: AppHandle, focus: Option<bool>) {
    super::show_main_window(&app, focus.unwrap_or(false));
}

/// 真正退出（唯一入口；有会话在跑时先二次确认）
#[tauri::command]
pub fn tray_quit(app: AppHandle) {
    super::request_quit(&app);
}
