//! 提醒通道 — 系统通知 + 零依赖兜底
//!
//! 「AI 跑完了」的提醒有三层，它们是**叠加**关系，不是互斥的降级链：
//! ① 系统通知（`tauri-plugin-notification`）—— Phase 2 接入，R1 三态实测（dev / 免安装 exe / MSIX）均已通过；
//! ② 任务栏闪烁（`request_user_attention`）—— 仅窗口可见时有意义（隐藏窗口上 FlashWindow 不生效）；
//! ③ 托盘 tooltip + 图标红点 —— 永不失败，最终兜底。
//!
//! ⚠️ **为什么不做「通知失败就降级」**：插件在桌面端把真正的发送丢进
//! `tauri::async_runtime::spawn` 并**丢弃错误**（见 `tauri-plugin-notification` 的
//! `desktop.rs::show`），所以「系统是否真的弹出了卡片」在 Rust 侧拿不到任何反馈。
//! 既然无法判定，就只能叠加：通知照发，②③ 照做（tooltip/红点零成本，闪烁只在可见未聚焦时）。
//!
//! 调用方只依赖 `notify_completed()`，将来增删通道只需改本文件。

use std::sync::atomic::Ordering;

use serde_json::json;
use tauri::AppHandle;
use tauri::Manager;
use tauri_plugin_notification::NotificationExt;

use super::{push_attention, refresh_tray, window_focus, TrayState, MAIN_WINDOW};
use crate::telemetry;

/// 会话标题为空时的通知标题（品牌名，与语言无关，不走 i18n）
const FALLBACK_NOTIFY_TITLE: &str = "Virlen";

/// 一次运行结束的提醒（由前端 `finishWorking()` 触发 —— 两种引擎共用的唯一收口）
///
/// `title` = 会话标题、`preview` = AI 回复正文截断：两者都是**前端**给的
/// （前端在拿不到正文时用 i18n 文案兜底），Rust 这边只声明一个品牌名兜底标题，
/// 避免在原生侧再养一套语言逻辑（铁律 7）。
///
/// `viewing` = **前端**上报的「用户此刻正看着这条回复」（当前会话就是它 + webview 有焦点）。
/// Rust 自己只看得到窗口可见/聚焦，**不知道用户当前停在哪个会话** —— 少这一位，
/// 「窗口激活 + 正好在这个会话里看它回复完」也会被判成需要提醒，
/// 屏幕上就冒出一个**清不掉**的未读红点（用户已在看，不会再触发任何清除动作）。
pub fn notify_completed(
    app: &AppHandle,
    session_id: &str,
    title: Option<&str>,
    preview: Option<&str>,
    status: Option<&str>,
    viewing: bool,
) {
    let state = app.state::<TrayState>();
    let is_error = status == Some("error");
    let enabled = state.notify_on_complete.load(Ordering::SeqCst);
    let force_active = state.force_window_active.load(Ordering::SeqCst);

    // 用户已经看到了（前端上报 / 窗口可见且聚焦）→ 不打扰，也不进未读队列；
    // 「强制激活窗口」开着且窗口还在时，由前端把窗口拎到前台，这里不再重复推通知
    let (visible, focused) = window_focus(app);
    let should_remind = decide_remind(enabled, viewing, visible, focused, force_active);

    let mut notification_ok = false;
    let mut attention_ok = false;

    if should_remind {
        push_attention(state.inner(), session_id);

        // ① 系统通知
        notification_ok = show_notification(app, title, preview);

        // ② 任务栏闪烁：窗口已隐藏时 FlashWindow 无意义，直接跳过（此时只剩通知 + tooltip）
        if visible {
            if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                attention_ok = window
                    .request_user_attention(Some(tauri::UserAttentionType::Informational))
                    .is_ok();
            }
        }

        // ③ tooltip / 未读红点（永不失败）
        refresh_tray(app);
    }

    telemetry::track(
        "tray.notify",
        json!({
            "session_id": telemetry::hash_id(session_id),
            "status": if is_error { "error" } else { "success" },
            "shown": should_remind,
            "force_active": force_active,
            // ⚠️ notification 只代表「插件调用成功」，**不代表系统真的弹了卡片**（见模块头注释）
            "notification": notification_ok,
            "attention": attention_ok,
            "has_title": title.map(|t| !t.is_empty()).unwrap_or(false),
            "preview_len": preview.map(|p| p.chars().count()).unwrap_or(0),
        }),
    );
}

/// 是否需要提醒（纯函数，便于单测）
///
/// 推送条件：`!active && (force_active == false || 窗口已关闭)`，其中
/// `active = 窗口可见且聚焦`、`窗口已关闭 = !visible`（隐藏到托盘；托盘还在，见模块头注释）。
///
/// - 用户关掉了「完成提醒」（`enabled = false`）→ 一律不提醒；
/// - 用户已经看到了这条回复（`viewing`，或窗口可见且聚焦）→ 不打扰，也不进未读队列；
/// - `force_active`（设置里的「强制激活窗口」）开着且窗口还在（仅失焦）→ 由**前端**
///   把窗口拎到前台，这里不再重复推系统通知；只有窗口已关到托盘时才推。
///
/// ⚠️ `viewing` 是**前端**才能给出的信号（只有它知道 `currentSessionId`），
/// 与 `visible && focused` 是**两回事**：后者只能说「用户在看这个应用」，
/// 前者才能说「用户在看**这条回复所在的会话**」。
///
/// ⚠️ `force_active` 与窗口状态是**两个独立来源**：开关在前端设置里（`tray_sync_settings` 同步来），
/// 窗口可见性由 Rust 自己看 —— 两者必须在这里合流，否则会出现
/// 「强制激活已把窗口拉到前台，却又弹一条系统通知」的重复打扰。
pub(crate) fn decide_remind(
    enabled: bool,
    viewing: bool,
    visible: bool,
    focused: bool,
    force_active: bool,
) -> bool {
    if !enabled || viewing || (visible && focused) {
        return false;
    }
    !(force_active && visible)
}

/// 投递系统通知：标题优先用会话标题，正文优先用 AI 回复预览
fn show_notification(app: &AppHandle, title: Option<&str>, preview: Option<&str>) -> bool {
    let mut builder = app
        .notification()
        .builder()
        .title(
            title
                .filter(|t| !t.is_empty())
                .unwrap_or(FALLBACK_NOTIFY_TITLE),
        );
    // 正文为空（模型只调了工具、没输出文本）时不设 body，通知退化成「只有标题」
    if let Some(body) = preview.filter(|p| !p.is_empty()) {
        builder = builder.body(body);
    }
    // ⚠️ `is_ok()` 不代表用户看见了通知：插件内部把发送丢进 spawn 并丢弃错误
    builder.show().is_ok()
}

#[cfg(test)]
mod tests {
    use super::decide_remind;

    #[test]
    fn remind_matrix() {
        // 窗口隐藏（关到托盘后台跑完）→ 必须提醒：这是托盘功能的主场景
        assert!(decide_remind(true, false, false, false, false));
        // 可见但失焦（用户在别的应用里）→ 提醒
        assert!(decide_remind(true, false, true, false, false));
        // 可见且聚焦 → 不打扰
        assert!(!decide_remind(true, false, true, true, false));
        // 前端上报「正在看这条回复」→ 不打扰（否则红点清不掉）
        assert!(!decide_remind(true, true, true, true, false));
        // 即使窗口状态读成隐藏/失焦，只要前端说在看，也不打扰
        assert!(!decide_remind(true, true, false, false, false));
        // 用户关掉「完成提醒」开关 → 一律不提醒
        assert!(!decide_remind(false, false, false, false, false));
        assert!(!decide_remind(false, false, true, false, false));
    }

    /// 「强制激活窗口」开着时：窗口还在（只是失焦）→ 交给前端强制激活，不推通知；
    /// 窗口已关到托盘 → 仍要推（这也是托盘后台工作的主场景）
    #[test]
    fn force_active_skips_remind_only_when_window_still_open() {
        // 窗口可见但失焦 → 前端会强制激活，不再重复推
        assert!(!decide_remind(true, false, true, false, true));
        // 可见且聚焦（用户就在前台）→ 不推
        assert!(!decide_remind(true, false, true, true, true));
        // 窗口已关闭（隐藏到托盘，托盘还在）→ 推
        assert!(decide_remind(true, false, false, false, true));
        // 前置闸门仍然优先：用户正看着 / 关掉了提醒开关
        assert!(!decide_remind(true, true, false, false, true));
        assert!(!decide_remind(false, false, false, false, true));
    }
}
