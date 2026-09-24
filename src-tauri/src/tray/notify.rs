//! 提醒通道 — 系统通知 + 零依赖兜底
//!
//! 「AI 跑完了」的提醒有三层，它们是**叠加**关系，不是互斥的降级链：
//! ① 系统通知 —— Phase 2 接入（`tauri-plugin-notification`，R1 三态实测已通过）；
//!    **Windows 上改由本模块自持 handle 发**（`show_owned`）：插件把 handle 丢了，
//!    收不到点击事件；而点击正是「回到那条回复」的唯一入口。
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

        // ① 系统通知（Windows 走自持 handle 的通道，点击能精确回到这条会话）
        notification_ok = show_notification(app, session_id, title, preview);

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
///
/// Windows 上优先走 `show_owned`（自持 handle，能收到点击）；该通道不可用（返回 `None`）
/// 或非 Windows 时，回退 `tauri-plugin-notification`。
fn show_notification(
    app: &AppHandle,
    session_id: &str,
    title: Option<&str>,
    preview: Option<&str>,
) -> bool {
    #[cfg(target_os = "windows")]
    if let Some(ok) = show_owned(app, session_id, title, preview) {
        return ok;
    }
    show_via_plugin(app, title, preview)
}

/// 插件通道 — `tauri-plugin-notification`
///
/// ⚠️ 这条通道**收不到点击**（插件把 `show()` 丢进 spawn 并把 `NotificationHandle` 丢掉），
/// 只用于「自持 handle 那条通道不可用」时兜底：非 Windows，以及 Windows 上没注册 AUMID
/// 的 dev / 免安装 exe。
fn show_via_plugin(app: &AppHandle, title: Option<&str>, preview: Option<&str>) -> bool {
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

/// 声明**进程**的 AppUserModelID（Windows，启动时调一次）
///
/// 通知的归属（名称 / 图标，以及点击后的激活路由）都按 AUMID 找应用：**安装版**由安装器
/// 把同一个 AUMID 写进开始菜单快捷方式（`System.AppUserModel.ID`），这里再把进程也声明成同一个，
/// 让 Windows 认得「这条通知属于 Virlen」。AUMID 的唯一真源是 `tauri.conf.json` 的 `identifier`
/// —— Rust 侧不再养第二份身份字符串。
///
/// 失败不影响通知：安装版里快捷方式已带 AUMID；dev / 免安装 exe 本来就没有，
/// `show_owned` 会回退插件通道（与既有行为一致）。
pub fn init_app_identity(app: &AppHandle) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::ffi::OsStrExt;

        let identifier = app.config().identifier.clone();
        let wide: Vec<u16> = std::ffi::OsStr::new(&identifier)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let hr = unsafe {
            windows_sys::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID(wide.as_ptr())
        };
        crate::telemetry::track("tray.aumid", json!({ "ok": hr >= 0, "hr": hr }));
    }
    #[cfg(not(target_os = "windows"))]
    let _ = app;
}

/// Windows：自己发通知 + 自己收点击（返回 `None` = 本通道不可用，请回退插件）
///
/// ⚠️ **为什么不用插件发**：`tauri-plugin-notification` 的 `show()` 把 `NotificationHandle`
/// **丢掉**（`spawn` + `let _ =`），而 Windows 的点击是**进程内**投递
/// （`tauri-winrt-notification` 在 `show()` 里 `toast_template.Activated(handler)`）——
/// handle 一丢，事件到达 channel 后没人接收，用户看到的现象就是「点通知完全没反应」。
/// 另外：非打包场景不会因为没有 COM 激活器而启动新进程（实测：点完连窗口都不出现），
/// 所以「靠新进程 + 单实例回调」那条路兜不住。
///
/// 自持 handle 的额外收益：**知道这条通知对应哪个会话** ⇒ 点击后精确切过去，
/// 不用像托盘左键那样只能猜「最早那条未读」。
#[cfg(target_os = "windows")]
fn show_owned(
    app: &AppHandle,
    session_id: &str,
    title: Option<&str>,
    preview: Option<&str>,
) -> Option<bool> {
    let mut notification = notify_rust::Notification::new();
    // AUMID 必须与开始菜单快捷方式里的一致，否则 `CreateToastNotifierWithId`
    // 找不到归属应用，`show()` 直接报错（dev / 免安装 exe 就是这种情况）
    notification.app_id(&app.config().identifier);
    notification.summary(
        title
            .filter(|t| !t.is_empty())
            .unwrap_or(FALLBACK_NOTIFY_TITLE),
    );
    if let Some(body) = preview.filter(|p| !p.is_empty()) {
        notification.body(body);
    }
    notification.auto_icon();

    match notification.show() {
        Ok(handle) => {
            let app = app.clone();
            let session_id = session_id.to_string();
            // 单起线程等这一次交互：toast 活着期间一直阻塞，用户「点击 / 关闭 / 等它超时」
            // 后线程自行结束，不会泄漏。
            std::thread::spawn(move || {
                // ⚠️ 必须用 `wait_for_response`（而不是 `wait_for_action`）：后者把
                // 「点击正文」（`Default`）与「通知被关闭 / 超时」（`Closed`）都归一成
                // `"__closed"`，两者分不开 —— 那会让「Toast 自己超时消失」也被当成点击，
                // 凭空把窗口抢到前台。
                let mut clicked = false;
                let _ = handle
                    .wait_for_response(|response: &notify_rust::NotificationResponse| {
                        clicked = is_user_click(response);
                    });
                if !clicked {
                    return;
                }
                super::show_main_window(&app, true);
                super::activate_session(&app, &session_id, "notification_click");
            });
            Some(true)
        }
        Err(error) => {
            // 没有注册 AUMID（dev / 免安装 exe）走这里 → 交给插件通道兜底
            crate::telemetry::track(
                "tray.notify.error",
                json!({ "channel": "owned", "error": error.to_string() }),
            );
            None
        }
    }
}

/// 这次响应算不算「用户点了通知」
///
/// `Default` = 点了通知正文；`Action` = 点了按钮（当前不发按钮，留着不影响语义）。
/// `Closed` 一律不算：通知超时消失、被系统清理都不该抢走用户焦点。
#[cfg(target_os = "windows")]
fn is_user_click(response: &notify_rust::NotificationResponse) -> bool {
    use notify_rust::NotificationResponse as R;
    matches!(response, R::Default | R::Action(_))
}

#[cfg(test)]
mod tests {
    use super::decide_remind;

    /// Windows 上「算不算用户点了通知」：只有**激活**算，关闭/超时都不算
    ///
    /// ⚠️ 这条判定直接决定「通知自己超时消失」会不会把窗口抢到前台，
    /// 所以必须用 `wait_for_response`（能区分）而不是 `wait_for_action`（分不出）。
    #[cfg(target_os = "windows")]
    #[test]
    fn only_activation_counts_as_click() {
        use super::is_user_click;
        use notify_rust::{CloseReason, NotificationResponse};

        assert!(is_user_click(&NotificationResponse::Default));
        assert!(is_user_click(&NotificationResponse::Action("a".into())));
        assert!(!is_user_click(&NotificationResponse::Closed(
            CloseReason::Expired
        )));
        assert!(!is_user_click(&NotificationResponse::Closed(
            CloseReason::Dismissed
        )));
    }

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
