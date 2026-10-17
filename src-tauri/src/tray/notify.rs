//! 提醒通道：系统通知 + 任务栏闪烁 + tooltip / 红点，三层叠加而非降级。
//! 不降级的原因：插件把发送丢进 spawn 并丢弃错误，Rust 侧拿不到「是否真弹了卡片」。

use std::sync::atomic::Ordering;
#[cfg(target_os = "windows")]
use std::sync::atomic::AtomicI64;

use serde_json::json;
use tauri::AppHandle;
use tauri::Manager;
use tauri_plugin_notification::NotificationExt;

use super::{push_attention, refresh_tray, window_focus, TrayState, MAIN_WINDOW};
use crate::telemetry;

/// 会话标题为空时的通知标题（品牌名，不跟语言）
const FALLBACK_NOTIFY_TITLE: &str = "Virlen";

/// 最近一次进程内收到点击的时戳（ms；0 = 从未）。一次点击可能走进程内事件与 COM 激活两条路，
/// 用它让 COM 在窗口内退让（见 toast_activator）。
#[cfg(target_os = "windows")]
static LAST_CLICK_MS: AtomicI64 = AtomicI64::new(0);

/// 记一笔「进程内已处理这次点击」（show_owned 判定为用户点击后调）
#[cfg(target_os = "windows")]
pub(crate) fn mark_click_handled() {
    LAST_CLICK_MS.store(crate::telemetry::now_ms(), Ordering::SeqCst);
}

/// `window_ms` 内是否刚在进程内处理过点击（`toast_activator` 去重用）
#[cfg(target_os = "windows")]
pub(crate) fn click_handled_within(window_ms: i64) -> bool {
    let last = LAST_CLICK_MS.load(Ordering::SeqCst);
    last != 0 && crate::telemetry::now_ms() - last < window_ms
}

/// 一次运行结束的提醒（由前端 finishWorking 触发）。
/// title / preview 由前端给（拿不到正文时前端用 i18n 兜底），这里只留品牌名兜底。
/// viewing = 前端上报「用户正看着这条回复」：Rust 看不到当前会话，少这一位会冒出清不掉的未读红点。
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

    // 用户已经看到（前端上报 / 可见且聚焦）就不打扰；强制激活开着且窗口还在时也不再重复推
    let (visible, focused) = window_focus(app);
    let should_remind = decide_remind(enabled, viewing, visible, focused, force_active);

    let mut notification_ok = false;
    let mut attention_ok = false;

    if should_remind {
        push_attention(state.inner(), session_id);

        // ① 系统通知（Windows 走自持 handle，点击能精确回到这条会话）
        notification_ok = show_notification(app, session_id, title, preview);

        // ② 任务栏闪烁：窗口隐藏时 FlashWindow 无意义，跳过
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
            // notification 只代表插件调用成功，不代表系统真弹了卡片
            "notification": notification_ok,
            "attention": attention_ok,
            "has_title": title.map(|t| !t.is_empty()).unwrap_or(false),
            "preview_len": preview.map(|p| p.chars().count()).unwrap_or(0),
        }),
    );
}

/// 是否需要提醒（纯函数，便于单测）
///
/// 推送条件：!enabled / viewing / (visible && focused) 任一不推；force_active 且窗口还在也不推。
/// viewing 只有前端能给（它才知道 currentSessionId），与 visible && focused 是两回事。
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
/// Windows 优先 show_owned（自持 handle 能收到点击）；不可用或非 Windows 回退插件。
fn show_notification(
    app: &AppHandle,
    session_id: &str,
    title: Option<&str>,
    preview: Option<&str>,
) -> bool {
    // 非 Windows 用不到会话 id
    #[cfg(not(target_os = "windows"))]
    let _ = session_id;
    #[cfg(target_os = "windows")]
    if let Some(ok) = show_owned(app, session_id, title, preview) {
        return ok;
    }
    show_via_plugin(app, title, preview)
}

/// 插件通道：收不到点击（handle 被丢弃），只用于兜底（非 Windows / 未注册 AUMID）。
fn show_via_plugin(app: &AppHandle, title: Option<&str>, preview: Option<&str>) -> bool {
    let mut builder = app
        .notification()
        .builder()
        .title(
            title
                .filter(|t| !t.is_empty())
                .unwrap_or(FALLBACK_NOTIFY_TITLE),
        );
    // 正文为空（只调了工具没输出文本）时不设 body，退化成只有标题
    if let Some(body) = preview.filter(|p| !p.is_empty()) {
        builder = builder.body(body);
    }
    // is_ok() 不代表用户看见了：插件内部丢错误
    builder.show().is_ok()
}

/// MSIX 清单里 `<Application Id>` 的值，必须逐字一致（AUMID = <PFN>!<AppId>）。
/// 清单模板只在 store-version 分支，故无对应单测。
#[cfg(target_os = "windows")]
const PACKAGE_APP_ID: &str = "App";

/// 传给 CreateToastNotifierWithId 的应用标识：打包版传裸 AppId（平台会补 <PFN>!），
/// 未打包版传 identifier（安装器已写进快捷方式的 System.AppUserModel.ID）。
/// 打包版传 identifier 会被补成 <PFN>!identifier，系统没这个入口 —— 投递成功但永不显示。
#[cfg(target_os = "windows")]
pub fn toast_app_id(app: &AppHandle) -> String {
    #[cfg(target_os = "windows")]
    if is_packaged() {
        return PACKAGE_APP_ID.to_string();
    }
    app.config().identifier.clone()
}

/// 当前进程是否运行在 MSIX 包上下文里
#[cfg(target_os = "windows")]
pub fn is_packaged() -> bool {
    package_family_name().is_some()
}

/// 当前进程所属包的 PackageFamilyName；未打包返回 None。
/// 用 GetCurrentPackageFamilyName 而非 GetCurrentApplicationUserModelId：后者可能被显式覆盖。
#[cfg(target_os = "windows")]
fn package_family_name() -> Option<String> {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::{ERROR_INSUFFICIENT_BUFFER, ERROR_SUCCESS};
    use windows::Win32::Storage::Packaging::Appx::GetCurrentPackageFamilyName;

    unsafe {
        // 两次调用：第一次只要长度（必然 ERROR_INSUFFICIENT_BUFFER），未打包返回 15700
        let mut len = 0u32;
        if GetCurrentPackageFamilyName(&mut len, None) != ERROR_INSUFFICIENT_BUFFER || len == 0 {
            return None;
        }
        let mut buffer = vec![0u16; len as usize];
        if GetCurrentPackageFamilyName(&mut len, Some(PWSTR(buffer.as_mut_ptr()))) != ERROR_SUCCESS {
            return None;
        }
        // `len` 含结尾 NUL
        buffer.truncate((len as usize).saturating_sub(1));
        String::from_utf16(&buffer).ok()
    }
}

/// 声明进程的 AUMID（Windows，启动时调一次；仅未打包场景）。
/// 打包版跳过：包清单已决定进程身份，再覆盖会让进程 AUMID 与通知 AUMID 分叉。
pub fn init_app_identity(app: &AppHandle) {
    #[cfg(target_os = "windows")]
    {
        if is_packaged() {
            crate::telemetry::track(
                "tray.aumid",
                json!({ "skipped": "packaged", "toast_app_id": toast_app_id(app) }),
            );
            return;
        }
        use std::os::windows::ffi::OsStrExt;

        let identifier = app.config().identifier.clone();
        let wide: Vec<u16> = std::ffi::OsStr::new(&identifier)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let hr = unsafe {
            windows_sys::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID(wide.as_ptr())
        };
        crate::telemetry::track(
            "tray.aumid",
            json!({ "ok": hr >= 0, "hr": hr, "aumid": identifier }),
        );
    }
    #[cfg(not(target_os = "windows"))]
    let _ = app;
}

/// Windows：自己发通知 + 自己收点击（None = 本通道不可用，回退插件）。
/// 不用插件发：它丢弃 handle，而 Windows 的点击是进程内投递，handle 一丢就收不到。
#[cfg(target_os = "windows")]
fn show_owned(
    app: &AppHandle,
    session_id: &str,
    title: Option<&str>,
    preview: Option<&str>,
) -> Option<bool> {
    let mut notification = notify_rust::Notification::new();
    // 必须走 toast_app_id（打包版平台会补 <PFN>!App），否则投递成功但永不显示
    notification.app_id(&toast_app_id(app));
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
            // 单起线程阻塞等这一次交互，用户点击 / 关闭 / 超时后线程自行结束
            std::thread::spawn(move || {
                // 必须用 wait_for_response：wait_for_action 会把点击与超时都归一成 "__closed"，
                // 那会让 toast 超时也被当成点击，凭空把窗口抢到前台
                let mut clicked = false;
                let _ = handle
                    .wait_for_response(|response: &notify_rust::NotificationResponse| {
                        clicked = is_user_click(response);
                    });
                if !clicked {
                    return;
                }
                // 记一笔「进程内已处理」：同一次点击若也触发 COM 激活，让它不要再切「最早未读」
                mark_click_handled();
                super::show_main_window(&app, true);
                super::activate_session(&app, &session_id, "notification_click");
            });
            Some(true)
        }
        Err(error) => {
            // 没注册 AUMID（dev / 免安装 exe）→ 交插件通道兜底
            crate::telemetry::track(
                "tray.notify.error",
                json!({ "channel": "owned", "error": error.to_string() }),
            );
            None
        }
    }
}

/// 这次响应算不算用户点了通知。Closed（超时消失 / 被系统清理）一律不算，不该抢焦点。
#[cfg(target_os = "windows")]
fn is_user_click(response: &notify_rust::NotificationResponse) -> bool {
    use notify_rust::NotificationResponse as R;
    matches!(response, R::Default | R::Action(_))
}

#[cfg(test)]
mod tests {
    use super::decide_remind;

    /// 只有激活算点击；关闭 / 超时都不算（决定会不会把窗口抢到前台）
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

    /// 「进程内刚处理过点击」的去重窗口：没点过或窗口为 0 都不算
    #[cfg(target_os = "windows")]
    #[test]
    fn click_dedup_window_marks_only_after_click() {
        use super::{click_handled_within, mark_click_handled};

        assert!(!click_handled_within(0));
        mark_click_handled();
        assert!(click_handled_within(60_000));
        assert!(!click_handled_within(0));
    }

    #[test]
    fn remind_matrix() {
        // 窗口隐藏（关到托盘后台跑完）→ 必须提醒，这是主场景
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

    /// 强制激活开着时：窗口还在 → 交给前端强制激活；已关到托盘 → 仍要推
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
