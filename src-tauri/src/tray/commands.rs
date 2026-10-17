//! 托盘命令 —— 前端唯一接口。⚠️ 新增命令必须注册进 `lib.rs` 的 `generate_handler![]`（铁律 4），
//! 否则 `invoke` 静默 404。这些是应用自有命令，不需要 `capabilities` 权限条目。
//! 约定：托盘是增强能力，命令一律不返回错误（前端 fire-and-forget），失败不得影响聊天主流程。

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

/// 设置同步（启动 + 变更时由前端推；全不传 = 无操作）。
/// `force_window_active`：开着时窗口只是失焦就不另推系统通知（判定在 `notify::decide_remind`）。
/// `labels`：i18n 后的菜单 / 提示文案补丁，Rust 只替换 `$__count__` 占位符。
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

/// 一次运行结束的提醒（由 `chat/event-handler.ts::finishWorking` 触发）。
/// `viewing` = 用户此刻正看着这条回复；不传按「没看到」处理（宁肯多提醒）。
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
