//! 系统托盘 — 关闭不退出 · 后台持续工作 · 完成提醒
//!
//! 本模块是「关闭窗口 / 真正退出」两个动作的**唯一权威**：前端不做任何拦截，
//! 标题栏关闭按钮走的还是 `window.close()` → `CloseRequested` → 在这里改成 `hide()`。
//!
//! 两类状态的归属必须分清：
//! - **业务状态**（谁在工作 / 谁刚跑完）：真源在**前端** `sessionRuntimeState`
//!   （TS 与 Rust 两种引擎都经过它），前端用 `commands` 里的命令增量推送 —
//!   引擎层零改动（铁律 1/3 不受影响）；
//! - **平台状态**（窗口是否隐藏 / 是否在退出 / 托盘是否可用）：真源在本模块。
//!
//! ⚠️ 托盘创建失败（Linux 缺 appindicator / 无桌面环境）时 `available=false`，
//! `decide_close` 必须回退成「真退出」—— 否则窗口被隐藏又没有托盘 = 用户看不见也退不掉。

pub mod commands;
pub mod notify;

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde_json::json;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Wry};
use tauri_plugin_dialog::DialogExt;

/// 托盘 id（本模块只用于创建；句柄存在 `TrayState` 里，不做 id 查找）
pub const TRAY_ID: &str = "virlen-tray";
/// 主窗口 label（tauri.conf.json 里唯一的窗口）
pub(crate) const MAIN_WINDOW: &str = "main";

/// 菜单项 id
pub const MENU_SHOW: &str = "tray-show";
pub const MENU_STATUS: &str = "tray-status";
pub const MENU_QUIT: &str = "tray-quit";

/// 托盘点击后通知前端「切到某个会话」（raw 事件，不进 AgentEventType 契约 —— 铁律 2）
pub const EVENT_ACTIVATE: &str = "tray:activate-session";

// 托盘菜单是原生菜单，Rust 侧没有语言资源 —— 这里的默认值是中文兜底，
// 前端启动后会立刻用 `tray_sync_settings` 把 i18n 后的文案推来覆盖（见 `TrayLabels`）。
// 数量用 `$__count__` 占位符（与前端 `tpl()` 的模板约定一致），替换在 Rust 侧做。
const DEFAULT_SHOW_TEXT: &str = "显示主窗口";
const DEFAULT_QUIT_TEXT: &str = "退出 Virlen";
const DEFAULT_STATUS_IDLE: &str = "空闲";
const DEFAULT_STATUS_WORKING: &str = "正在工作（$__count__ 个会话）";
const DEFAULT_STATUS_UNREAD: &str = "$__count__ 个会话有新回复";
const DEFAULT_TOOLTIP_IDLE: &str = "Virlen";
const DEFAULT_TOOLTIP_HIDDEN: &str = "Virlen（已隐藏到托盘，右键可退出）";
const DEFAULT_TOOLTIP_WORKING: &str = "Virlen · 正在工作（$__count__）";
const DEFAULT_TOOLTIP_UNREAD: &str = "Virlen ● 有新回复（$__count__）";

/// 「有新回复」未读队列上限（超出丢最早的）
const ATTENTION_LIMIT: usize = 20;
/// 同一会话完成提醒的合并窗口（毫秒）
const NOTIFY_DEDUP_MS: i64 = 5_000;

/// 托盘状态（Tauri managed state）
pub struct TrayState {
    /// 正在工作的会话（sessionId → 标题）；空 = 空闲
    pub(crate) working: Mutex<BTreeMap<String, String>>,
    /// 完成但用户还没看的会话（FIFO：点击托盘时切到最早的未读）
    pub(crate) attention: Mutex<Vec<String>>,
    /// 关闭窗口时隐藏到托盘（Phase 2 由前端设置项推送）
    pub(crate) close_to_tray: AtomicBool,
    /// 完成时是否提醒（Phase 2 由前端设置项推送）
    pub(crate) notify_on_complete: AtomicBool,
    /// 托盘是否创建成功 —— 失败时「关闭窗口」必须回退成真退出
    pub(crate) available: AtomicBool,
    /// 正在真正退出 —— 唯一豁免 `prevent_exit` 的开关
    pub(crate) quitting: AtomicBool,
    /// 当前托盘图标是否已叠红点（避免无谓的 set_icon）
    pub(crate) icon_dot: AtomicBool,
    /// 托盘句柄（tooltip / 图标切换用）
    tray: Mutex<Option<TrayIcon<Wry>>>,
    /// 状态菜单项（disabled，纯展示文案）
    status_item: Mutex<Option<MenuItem<Wry>>>,
    /// 原始托盘图标（叠红点用）
    base_icon: Mutex<Option<Image<'static>>>,
    /// 上次提醒时间（sessionId → ms），用于 `NOTIFY_DEDUP_MS` 窗口内合并
    notify_log: Mutex<BTreeMap<String, i64>>,
    /// 托盘 UI 文案（前端推 i18n 后的字符串；托盘是原生菜单，Rust 侧没有语言资源）
    labels: Mutex<TrayLabels>,
    /// 「显示主窗口」菜单项句柄（文案要跟随语言切换）
    menu_show: Mutex<Option<MenuItem<Wry>>>,
    /// 「退出」菜单项句柄
    menu_quit: Mutex<Option<MenuItem<Wry>>>,
}

impl Default for TrayState {
    fn default() -> Self {
        Self {
            working: Mutex::new(BTreeMap::new()),
            attention: Mutex::new(Vec::new()),
            close_to_tray: AtomicBool::new(true),
            notify_on_complete: AtomicBool::new(true),
            available: AtomicBool::new(false),
            quitting: AtomicBool::new(false),
            icon_dot: AtomicBool::new(false),
            tray: Mutex::new(None),
            status_item: Mutex::new(None),
            base_icon: Mutex::new(None),
            notify_log: Mutex::new(BTreeMap::new()),
            labels: Mutex::new(TrayLabels::default()),
            menu_show: Mutex::new(None),
            menu_quit: Mutex::new(None),
        }
    }
}

/// 托盘 UI 文案
///
/// i18n 由**前端**负责（托盘菜单是原生菜单，Rust 侧没有语言资源）：
/// 前端用 `t()` 翻译后整包推来，Rust 只负责在数量变化时替换 `$__count__`。
#[derive(Debug, Clone)]
pub struct TrayLabels {
    /// 菜单项「显示主窗口」
    pub show: String,
    /// 菜单项「退出 Virlen」
    pub quit: String,
    /// 状态项：空闲（无数量）
    pub status_idle: String,
    /// 状态项模板，`$__count__` = 正在工作的会话数
    pub status_working: String,
    /// 状态项模板，`$__count__` = 有新回复的会话数
    pub status_unread: String,
    /// 空闲时的 tooltip
    pub tooltip_idle: String,
    /// 已隐藏到托盘时的 tooltip
    pub tooltip_hidden: String,
    /// 工作中的 tooltip 模板
    pub tooltip_working: String,
    /// 有新回复的 tooltip 模板
    pub tooltip_unread: String,
}

impl Default for TrayLabels {
    fn default() -> Self {
        Self {
            show: DEFAULT_SHOW_TEXT.into(),
            quit: DEFAULT_QUIT_TEXT.into(),
            status_idle: DEFAULT_STATUS_IDLE.into(),
            status_working: DEFAULT_STATUS_WORKING.into(),
            status_unread: DEFAULT_STATUS_UNREAD.into(),
            tooltip_idle: DEFAULT_TOOLTIP_IDLE.into(),
            tooltip_hidden: DEFAULT_TOOLTIP_HIDDEN.into(),
            tooltip_working: DEFAULT_TOOLTIP_WORKING.into(),
            tooltip_unread: DEFAULT_TOOLTIP_UNREAD.into(),
        }
    }
}

/// 前端推来的文案补丁：只覆盖 `Some` 且非空的字段，缺省保留旧值（避免刷成空白）
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TrayLabelsPatch {
    pub show: Option<String>,
    pub quit: Option<String>,
    pub status_idle: Option<String>,
    pub status_working: Option<String>,
    pub status_unread: Option<String>,
    pub tooltip_idle: Option<String>,
    pub tooltip_hidden: Option<String>,
    pub tooltip_working: Option<String>,
    pub tooltip_unread: Option<String>,
}

impl TrayState {
    /// 「隐藏到托盘」模式是否生效：托盘可用 + 开关打开 + 不在退出中
    fn hide_mode(&self) -> bool {
        self.available.load(Ordering::SeqCst)
            && self.close_to_tray.load(Ordering::SeqCst)
            && !self.quitting.load(Ordering::SeqCst)
    }
}

/// 「关闭窗口」的语义
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseAction {
    /// 只隐藏窗口，进程与 AI 继续活着
    Hide,
    /// 放行关闭（托盘不可用 / 用户关掉了开关 / 正在退出）
    Exit,
}

/// 「所有窗口已关闭」时是否拦下退出
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitAction {
    Prevent,
    Allow,
}

/// 收到 `WindowEvent::CloseRequested` 的语义（纯函数，便于单测）
pub fn decide_close(state: &TrayState) -> CloseAction {
    if state.hide_mode() {
        CloseAction::Hide
    } else {
        CloseAction::Exit
    }
}

/// 收到 `RunEvent::ExitRequested` 的语义（纯函数，便于单测）
///
/// - `code = Some(..)`：`app.exit()` / 系统关机注销 → **一律放行**，绝不能拦住关机；
/// - `code = None`：所有窗口关闭触发的默认退出 → 隐藏模式下拦下来。
pub fn decide_exit(code: Option<i32>, state: &TrayState) -> ExitAction {
    if code.is_none() && state.hide_mode() {
        ExitAction::Prevent
    } else {
        ExitAction::Allow
    }
}

/// 关闭窗口时是否只隐藏
pub fn should_hide_on_close(app: &AppHandle) -> bool {
    decide_close(app.state::<TrayState>().inner()) == CloseAction::Hide
}

/// 所有窗口都已关闭时，是否拦下退出
///
/// ⚠️ 窗口已被销毁（不是 hide）时放行：那种情况拦下来也打不开窗口，
/// 只会留下一个「没窗口、托盘也打不开界面」的僵尸进程。
pub fn should_prevent_exit(app: &AppHandle, code: Option<i32>) -> bool {
    if decide_exit(code, app.state::<TrayState>().inner()) != ExitAction::Prevent {
        return false;
    }
    app.get_webview_window(MAIN_WINDOW).is_some()
}

/// 创建托盘（在 `setup` 中调用；调用前必须先 `app.manage(TrayState::default())`）
pub fn init(app: &AppHandle) -> tauri::Result<()> {
    // 先按默认（中文）建菜单，前端稍后会用 `tray_sync_settings` 推 i18n 文案覆盖
    let labels = TrayLabels::default();
    let show = MenuItem::with_id(app, MENU_SHOW, &labels.show, true, None::<&str>)?;
    let status = MenuItem::with_id(app, MENU_STATUS, &labels.status_idle, false, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, MENU_QUIT, &labels.quit, true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &status, &separator, &quit])?;

    // 图标直接用窗口图标（tauri 在编译期已把 icons/icon.ico 解成 RGBA，见 tauri-codegen）
    let base_icon: Option<Image<'static>> = app.default_window_icon().map(snapshot_icon);

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip(labels.tooltip_idle.as_str())
        .menu(&menu)
        // 左键单击 = 显示主窗口；右键 = 弹出菜单
        .show_menu_on_left_click(false);
    if let Some(icon) = &base_icon {
        builder = builder.icon(icon.clone());
    }

    let tray = builder
        .on_menu_event(|app, event| match event.id().as_ref() {
            MENU_SHOW => show_main_window(app, true),
            MENU_QUIT => request_quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                on_tray_left_click(tray.app_handle());
            }
        })
        .build(app)?;

    let state = app.state::<TrayState>();
    *state.tray.lock().unwrap() = Some(tray);
    *state.status_item.lock().unwrap() = Some(status);
    *state.menu_show.lock().unwrap() = Some(show);
    *state.menu_quit.lock().unwrap() = Some(quit);
    *state.base_icon.lock().unwrap() = base_icon;
    state.available.store(true, Ordering::SeqCst);

    refresh_tray(app);
    Ok(())
}

/// 窗口事件入口（lib.rs 只做转发）
///
/// ⚠️ 这里是「关闭 ≠ 退出」的唯一落点：拦住 `CloseRequested` 并 `hide()`，
/// 前端标题栏关闭按钮因此**一行都不用改**。
pub fn handle_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        let app = window.app_handle();
        if should_hide_on_close(app) {
            api.prevent_close();
            let _ = window.hide();
            on_window_hidden(app, "close");
        }
    }
}

/// 窗口刚被隐藏到托盘
pub fn on_window_hidden(app: &AppHandle, reason: &str) {
    // tooltip / 状态菜单刷新（空闲时 tooltip 会变成「已隐藏到托盘」提示）
    refresh_tray(app);
    crate::telemetry::track("tray.hide", json!({ "reason": reason }));
}

/// 显示（并可选聚焦）主窗口
pub fn show_main_window(app: &AppHandle, focus: bool) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        // 先 unminimize 再 show：最小化状态下直接 show 不会还原
        let _ = window.unminimize();
        let _ = window.show();
        if focus {
            let _ = window.set_focus();
        }
    }
    refresh_tray(app);
}

/// 从「应用外部」把主窗口捞回来并聚焦
///
/// 两个调用方（都意味着「用户想看到窗口」）：
/// - **第二个实例被启动**：`tauri_plugin_single_instance` 已经把那个进程杀掉了（见 `lib.rs`），
///   这里只需在第一实例里响应；
/// - **macOS 重新打开**：点 Dock 图标 / 双击 Finder 里的 app（`RunEvent::Reopen`）——
///   窗口藏进托盘后不处理这个事件，用户会觉得「点了没反应」。
///
/// 此时窗口可能藏在托盘里（`CloseRequested` → `hide()`）、被最小化、或被其它窗口盖住，
/// `show_main_window` 三种情况都覆盖；顺带 `refresh_tray` 把 tooltip 从
/// 「已隐藏到托盘，右键可退出」纠正回来。
///
pub fn activate_main_window(app: &AppHandle, reason: &str) {
    if app.try_state::<TrayState>().is_none() {
        return;
    }
    let (visible, _) = window_focus(app);
    show_main_window(app, true);
    crate::telemetry::track(
        "app.activate_window",
        json!({ "reason": reason, "was_visible": visible }),
    );
}

/// 前端推送的「某会话开始/结束工作」（幂等）
pub fn set_working(app: &AppHandle, session_id: &str, working: bool, title: Option<String>) {
    apply_working(app.state::<TrayState>().inner(), session_id, working, title);
    refresh_tray(app);
}

/// 前端推送设置（启动 + 变更；三项都不传 = 无操作）
pub fn sync_settings(
    app: &AppHandle,
    close_to_tray: Option<bool>,
    notify_on_complete: Option<bool>,
    labels: Option<TrayLabelsPatch>,
) {
    let state = app.state::<TrayState>();
    if let Some(v) = close_to_tray {
        state.close_to_tray.store(v, Ordering::SeqCst);
    }
    if let Some(v) = notify_on_complete {
        state.notify_on_complete.store(v, Ordering::SeqCst);
    }
    if let Some(patch) = labels {
        apply_labels(state.inner(), patch);
    }
    // 文案/状态可能变了，统一由 refresh_tray 重算菜单项与 tooltip
    refresh_tray(app);
}

/// 清除未读（`None` = 全清）：前端切到会话 / 托盘点击后调用
pub fn clear_attention(app: &AppHandle, session_id: Option<&str>) {
    clear_attention_in(app.state::<TrayState>().inner(), session_id);
    refresh_tray(app);
}

/// 请求退出：有任务在跑时先二次确认（D2 决策，2026-09）
pub fn request_quit(app: &AppHandle) {
    let state = app.state::<TrayState>();
    if state.quitting.load(Ordering::SeqCst) {
        return;
    }
    let working = state.working.lock().unwrap().len();
    if working == 0 {
        quit_now(app);
        return;
    }

    // ⚠️ 非阻塞 show：回调在主线程之外执行，绝不能阻塞事件循环
    let app_cb = app.clone();
    app.dialog()
        .message(format!(
            "还有 {} 个会话正在工作，退出会中断它们。确定退出吗？",
            working
        ))
        .title("退出 Virlen")
        .kind(tauri_plugin_dialog::MessageDialogKind::Warning)
        .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancelCustom(
            "退出".into(),
            "取消".into(),
        ))
        .show(move |confirmed| {
            if confirmed {
                quit_now(&app_cb);
            }
        });
}

/// 真正退出（唯一入口）
fn quit_now(app: &AppHandle) {
    let state = app.state::<TrayState>();
    if state.quitting.swap(true, Ordering::SeqCst) {
        return; // 已在退出流程（菜单被连点两次 / 弹窗重复回调）
    }
    let working = state.working.lock().unwrap().len();
    crate::telemetry::track("tray.quit", json!({ "working_count": working }));
    // 托盘图标的销毁不在这里做：`app.exit()` 会发 `ExitRequested`，
    // 由 `lib.rs` 在那个分支统一调 `destroy()`（这样「直接关窗退出」也走同一条清理路径）
    app.exit(0);
}

/// 销毁托盘图标 —— **退出前必调**（`lib.rs` 的 `ExitRequested` / `Exit` 两处调用）
///
/// ⚠️ 不调会留下 Windows 的「幽灵图标」：托盘图标挂在进程的 message-only window 上，
/// Shell 不会因为进程死亡自动清掉它，必须显式 `Shell_NotifyIconW(NIM_DELETE)`
/// （由 `tray-icon` 的 `Drop` 发出，见 `tray-icon/src/platform_impl/windows/mod.rs`）。
/// 而底层是 `Rc<RefCell<platform_impl::TrayIcon>>` —— **最后一份引用 Drop 时才发删除消息**，
/// 恰恰这里有两份引用在互相续命：
///   ① `TrayState.tray`（我们自己的克隆）；
///   ② tauri 资源表里的那份。
/// 更麻烦的是 `TrayState → TrayIcon → AppHandle → AppManager → TrayState` 构成**引用环**，
/// 托管状态根本不会被 Drop —— 于是 `cleanup_before_exit()` 清完资源表后仍有一份活着，
/// `NIM_DELETE` 永远发不出去，图标一直挂在通知区域，直到鼠标划过才被 Shell 清掉。
/// 所以必须把两份引用**都显式丢掉**：只丢一份（无论哪份）都不够。
///
/// 幂等：第二次调用直接返回（退出路径有两个调用点，且可能在 `ExitRequested` 已清过）。
/// 副作用：`available` 置 false → `close_to_tray` 随之失效，销毁后关闭窗口一律真退出
/// （托盘都没了，再隐藏窗口就会变成「没窗口也退不掉」的僵尸进程）。
pub fn destroy(app: &AppHandle) {
    let state = app.state::<TrayState>();
    if !mark_destroyed(state.inner()) {
        return;
    }
    // ① 我们的克隆；② 资源表里的那份（`remove_tray_by_id` 顺带把它从 tauri 的图标表摘掉）
    let ours = state.tray.lock().unwrap().take();
    let from_table = app.remove_tray_by_id(TRAY_ID);
    // 菜单项句柄一并释放（`MenuItem` 的 Drop 会自己切回主线程，见 tauri `menu/mod.rs`）
    *state.status_item.lock().unwrap() = None;
    *state.menu_show.lock().unwrap() = None;
    *state.menu_quit.lock().unwrap() = None;
    // 最后两份 Rc 在这里归零 → 发 NIM_DELETE + DestroyWindow
    drop(ours);
    drop(from_table);
    crate::telemetry::track("tray.destroy", json!({ "reason": "app_exit" }));
}

// ==================== 内部实现（不依赖 AppHandle，可单测） ====================

/// 标记托盘已销毁；返回「是否首次销毁」（幂等，见 `destroy`）
fn mark_destroyed(state: &TrayState) -> bool {
    state.available.swap(false, Ordering::SeqCst)
}

/// 覆盖单个文案（`None` / 空串视为「未提供」，避免前端漏传把菜单刷成空白）
fn set_label(slot: &mut String, value: Option<String>) {
    if let Some(v) = value {
        if !v.is_empty() {
            *slot = v;
        }
    }
}

/// 应用文案补丁
fn apply_labels(state: &TrayState, patch: TrayLabelsPatch) {
    let mut labels = state.labels.lock().unwrap();
    set_label(&mut labels.show, patch.show);
    set_label(&mut labels.quit, patch.quit);
    set_label(&mut labels.status_idle, patch.status_idle);
    set_label(&mut labels.status_working, patch.status_working);
    set_label(&mut labels.status_unread, patch.status_unread);
    set_label(&mut labels.tooltip_idle, patch.tooltip_idle);
    set_label(&mut labels.tooltip_hidden, patch.tooltip_hidden);
    set_label(&mut labels.tooltip_working, patch.tooltip_working);
    set_label(&mut labels.tooltip_unread, patch.tooltip_unread);
}

/// 把文案模板里的 `$__count__` 换成数量
///
/// 用与前端 `tpl()` 相同的占位符约定（铁律 7）：英文文案可以自由调语序，
/// Rust 侧只做替换 —— 不需要第二套语言逻辑。
fn fill_count(tpl: &str, n: usize) -> String {
    tpl.replace("$__count__", &n.to_string())
}

/// 会话工作状态（幂等）
fn apply_working(state: &TrayState, session_id: &str, working: bool, title: Option<String>) {
    let mut map = state.working.lock().unwrap();
    if working {
        map.insert(session_id.to_string(), title.unwrap_or_default());
    } else {
        map.remove(session_id);
    }
}

/// 入队「有新回复」：幂等 + 同会话 5 秒内合并 + 上限裁剪
fn push_attention(state: &TrayState, session_id: &str) -> bool {
    let now = crate::telemetry::now_ms();
    {
        let mut log = state.notify_log.lock().unwrap();
        let fresh = log
            .get(session_id)
            .map(|last| now - *last >= NOTIFY_DEDUP_MS)
            .unwrap_or(true);
        log.insert(session_id.to_string(), now);
        // 顺带清理过期记录，避免长期运行后无限增长
        log.retain(|_, last| now - *last < NOTIFY_DEDUP_MS);
        if !fresh {
            return false;
        }
    }

    let mut list = state.attention.lock().unwrap();
    if list.iter().any(|s| s == session_id) {
        return false;
    }
    list.push(session_id.to_string());
    if list.len() > ATTENTION_LIMIT {
        let overflow = list.len() - ATTENTION_LIMIT;
        list.drain(0..overflow);
    }
    true
}

/// 清未读
fn clear_attention_in(state: &TrayState, session_id: Option<&str>) {
    match session_id {
        Some(id) => {
            state.attention.lock().unwrap().retain(|s| s != id);
            // 一并清掉合并窗口记录：用户已经看过了，下次完成应当重新提醒
            state.notify_log.lock().unwrap().remove(id);
        }
        None => {
            state.attention.lock().unwrap().clear();
            state.notify_log.lock().unwrap().clear();
        }
    }
}

/// 窗口可见 / 聚焦状态（窗口不存在时都算 false）
pub(crate) fn window_focus(app: &AppHandle) -> (bool, bool) {
    match app.get_webview_window(MAIN_WINDOW) {
        Some(window) => (
            window.is_visible().unwrap_or(false),
            window.is_focused().unwrap_or(false),
        ),
        None => (false, false),
    }
}

/// 左侧托盘图标被单击
fn on_tray_left_click(app: &AppHandle) {
    let (visible, focused) = window_focus(app);
    let next_unread = app
        .state::<TrayState>()
        .attention
        .lock()
        .unwrap()
        .first()
        .cloned();
    let had_unread = next_unread.is_some();

    if visible && focused {
        // 已经在前台 → 最小化（托盘图标的常见 toggle 行为）
        if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
            let _ = window.minimize();
        }
    } else {
        show_main_window(app, true);
    }

    if let Some(session_id) = next_unread {
        clear_attention(app, Some(&session_id));
        // 让前端切到该会话（raw 事件，不污染 AgentEventType —— 铁律 2）
        let _ = app.emit(EVENT_ACTIVATE, json!({ "sessionId": session_id }));
    }
    crate::telemetry::track(
        "tray.show",
        json!({ "reason": "tray_click", "unread": had_unread, "focus": true }),
    );
}

/// 刷新 tooltip / 状态菜单项 / 未读红点图标
pub fn refresh_tray(app: &AppHandle) {
    let state = app.state::<TrayState>();
    let working = state.working.lock().unwrap().len();
    let unread = state.attention.lock().unwrap().len();
    let labels = state.labels.lock().unwrap().clone();
    let (visible, _) = window_focus(app);

    let tooltip = if unread > 0 {
        fill_count(&labels.tooltip_unread, unread)
    } else if working > 0 {
        fill_count(&labels.tooltip_working, working)
    } else if !visible {
        labels.tooltip_hidden.clone()
    } else {
        labels.tooltip_idle.clone()
    };
    let status_text = if unread > 0 {
        fill_count(&labels.status_unread, unread)
    } else if working > 0 {
        fill_count(&labels.status_working, working)
    } else {
        labels.status_idle.clone()
    };

    // ⚠️ 先取出句柄并释放锁，再调 UI：`set_tooltip` / `set_text` 在非主线程上会
    // 切到主线程并**阻塞等待**；持锁等待期间主线程若正好在托盘事件里取同一把锁 → 互锁
    let tray = state.tray.lock().unwrap().clone();
    let status_item = state.status_item.lock().unwrap().clone();
    let menu_show = state.menu_show.lock().unwrap().clone();
    let menu_quit = state.menu_quit.lock().unwrap().clone();

    // 语言切换后菜单项文案要跟着变
    if let Some(item) = menu_show {
        let _ = item.set_text(&labels.show);
    }
    if let Some(item) = menu_quit {
        let _ = item.set_text(&labels.quit);
    }
    if let Some(item) = status_item {
        let _ = item.set_text(status_text);
    }

    let Some(tray) = tray else { return };
    let _ = tray.set_tooltip(Some(tooltip.as_str()));

    // 未读 > 0 → 图标叠红点；恢复 → 还原（仅在状态变化时 set_icon，避免闪烁）
    let want_dot = unread > 0;
    if state.icon_dot.load(Ordering::SeqCst) != want_dot {
        let icon = {
            let base = state.base_icon.lock().unwrap();
            match (want_dot, base.as_ref()) {
                (true, Some(base)) => Some(icon_with_dot(base)),
                (false, Some(base)) => Some(base.clone()),
                _ => None,
            }
        };
        if let Some(icon) = icon {
            if tray.set_icon(Some(icon)).is_ok() {
                state.icon_dot.store(want_dot, Ordering::SeqCst);
            }
        }
    }
}

/// 在工作区图标右下角叠一个红点 —— 托盘上「有新回复」的可见提示
///
/// Phase 1 零美术资源：直接改 RGBA 像素。Phase 3 再换成正式的两态图标。
///
/// ⚠️ 参数必须是 `&'a Image<'a>`：`Image::rgba()` 的签名是 `fn rgba(&'a self) -> &'a [u8]`
/// （`'a` 就是 `Image` 自己的 lifetime 参数），只能对「引用与其 lifetime 参数一致」的值调用。
fn icon_with_dot<'a>(base: &'a Image<'a>) -> Image<'static> {
    let (w, h) = (base.width(), base.height());
    let mut rgba = base.rgba().to_vec();
    let r = (w.min(h) / 4).max(3) as i32;
    let (cx, cy) = (w as i32 - r - 1, h as i32 - r - 1);
    for y in 0..h as i32 {
        for x in 0..w as i32 {
            let (dx, dy) = (x - cx, y - cy);
            if dx * dx + dy * dy <= r * r {
                let i = (y as u32 * w + x as u32) as usize * 4;
                rgba[i] = 0xF2;
                rgba[i + 1] = 0x4D;
                rgba[i + 2] = 0x4D;
                rgba[i + 3] = 0xFF;
            }
        }
    }
    Image::new(&rgba, w, h).to_owned()
}

/// 复制一份像素，得到 `Image<'static>`（可长期存在 `TrayState` 里）
fn snapshot_icon<'a>(icon: &'a Image<'a>) -> Image<'static> {
    Image::new(icon.rgba(), icon.width(), icon.height()).to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(available: bool, close_to_tray: bool, quitting: bool) -> TrayState {
        let s = TrayState::default();
        s.available.store(available, Ordering::SeqCst);
        s.close_to_tray.store(close_to_tray, Ordering::SeqCst);
        s.quitting.store(quitting, Ordering::SeqCst);
        s
    }

    #[test]
    fn close_action_truth_table() {
        // 只有「托盘可用 + 开关打开 + 不在退出」才隐藏
        assert_eq!(decide_close(&state(true, true, false)), CloseAction::Hide);
        assert_eq!(decide_close(&state(true, true, true)), CloseAction::Exit);
        assert_eq!(decide_close(&state(true, false, false)), CloseAction::Exit);
        assert_eq!(decide_close(&state(false, true, false)), CloseAction::Exit);
        assert_eq!(decide_close(&state(false, false, false)), CloseAction::Exit);
    }

    #[test]
    fn exit_action_lets_os_shutdown_through() {
        let hide_mode = state(true, true, false);
        // code = Some（app.exit / 系统关机）一律放行
        assert_eq!(decide_exit(Some(0), &hide_mode), ExitAction::Allow);
        assert_eq!(decide_exit(Some(1), &hide_mode), ExitAction::Allow);
        // code = None 且隐藏模式生效 → 拦下来
        assert_eq!(decide_exit(None, &hide_mode), ExitAction::Prevent);
        // 托盘不可用 / 关闭开关打开 / 正在退出 → 放行
        assert_eq!(decide_exit(None, &state(false, true, false)), ExitAction::Allow);
        assert_eq!(decide_exit(None, &state(true, false, false)), ExitAction::Allow);
        assert_eq!(decide_exit(None, &state(true, true, true)), ExitAction::Allow);
    }

    #[test]
    fn working_is_idempotent_and_tracks_title() {
        let s = TrayState::default();
        apply_working(&s, "s1", true, Some("标题 A".into()));
        apply_working(&s, "s1", true, Some("标题 B".into()));
        assert_eq!(s.working.lock().unwrap().len(), 1);
        assert_eq!(
            s.working.lock().unwrap().get("s1").map(String::as_str),
            Some("标题 B")
        );

        apply_working(&s, "s2", true, None);
        assert_eq!(s.working.lock().unwrap().len(), 2);

        apply_working(&s, "s1", false, None);
        apply_working(&s, "s1", false, None);
        let map = s.working.lock().unwrap();
        assert_eq!(map.len(), 1);
        assert!(!map.contains_key("s1"));
    }

    #[test]
    fn attention_is_deduped_and_capped() {
        let s = TrayState::default();
        assert!(push_attention(&s, "s1"));
        // 已在队列里 → 不重复入队（FIFO 顺序保持）
        assert!(!push_attention(&s, "s1"));
        assert_eq!(s.attention.lock().unwrap().len(), 1);

        // 上限裁剪：超出的丢最早的（含先前入队的 s1）
        for i in 0..(ATTENTION_LIMIT + 5) {
            push_attention(&s, &format!("sess-{}", i));
        }
        let list = s.attention.lock().unwrap();
        assert_eq!(list.len(), ATTENTION_LIMIT);
        assert_eq!(list.first().map(String::as_str), Some("sess-5"));
        assert_eq!(list.last().map(String::as_str), Some("sess-24"));
    }

    #[test]
    fn attention_dedupe_window_resets_after_clear() {
        let s = TrayState::default();
        assert!(push_attention(&s, "s1"));
        // 5 秒内再完成 → 合并（不再入队）
        assert!(!push_attention(&s, "s1"));

        // 用户看过（清未读）→ 立刻重新完成应当能再次提醒
        clear_attention_in(&s, Some("s1"));
        assert!(s.attention.lock().unwrap().is_empty());
        assert!(push_attention(&s, "s1"));

        clear_attention_in(&s, None);
        assert!(s.attention.lock().unwrap().is_empty());
        assert!(s.notify_log.lock().unwrap().is_empty());
    }

    #[test]
    fn count_placeholder_is_filled() {
        assert_eq!(
            fill_count("正在工作（$__count__ 个会话）", 2),
            "正在工作（2 个会话）"
        );
        // 没有占位符时原样返回
        assert_eq!(fill_count("空闲", 3), "空闲");
    }

    #[test]
    fn labels_patch_skips_empty_and_keeps_old_value() {
        let s = TrayState::default();
        apply_labels(
            &s,
            TrayLabelsPatch {
                quit: Some("Quit Virlen".into()),
                show: Some(String::new()), // 空串 = 未提供
                ..Default::default()
            },
        );
        let labels = s.labels.lock().unwrap();
        assert_eq!(labels.quit, "Quit Virlen");
        assert_eq!(labels.show, DEFAULT_SHOW_TEXT);
    }

    #[test]
    fn destroy_is_idempotent_and_disables_hide_mode() {
        let s = state(true, true, false);
        assert!(s.hide_mode());
        assert!(mark_destroyed(&s));
        // 第二次调用不再重复清理（退出路径有两个调用点）
        assert!(!mark_destroyed(&s));
        // ⚠️ 托盘没了就不能再「关闭即隐藏」，否则窗口会被藏进一个不存在的托盘里
        assert!(!s.hide_mode());
        assert_eq!(decide_close(&s), CloseAction::Exit);
        assert_eq!(decide_exit(None, &s), ExitAction::Allow);
    }

    #[test]
    fn icon_with_dot_keeps_size_and_paints_bottom_right() {
        let base: Vec<u8> = vec![0u8; 32 * 32 * 4];
        let image = Image::new(&base, 32, 32);
        let dotted = icon_with_dot(&image);
        assert_eq!((dotted.width(), dotted.height()), (32, 32));

        let px = |x: u32, y: u32| {
            let i = (y * 32 + x) as usize * 4;
            [
                dotted.rgba()[i],
                dotted.rgba()[i + 1],
                dotted.rgba()[i + 2],
                dotted.rgba()[i + 3],
            ]
        };
        // 红点圆心：右下角留 1px 边距、半径 = min(w,h)/4
        let r = (32 / 4) as i32;
        let c = 32 - r - 1;
        assert_eq!(px(c as u32, c as u32), [0xF2, 0x4D, 0x4D, 0xFF]);
        // 左上角保持原样
        assert_eq!(px(0, 0), [0, 0, 0, 0]);
    }
}
