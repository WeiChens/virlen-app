//! 右侧栏「网页」标签的**原生子 WebView**（`Window::add_child`）。
//!
//! ## 为什么不是 `<iframe>`
//!
//! `X-Frame-Options` / `Content-Security-Policy: frame-ancestors` 约束的是「**被谁嵌入**」。
//! 在 iframe 里遇到它们，浏览器只会给一片空白，拒绝原因只进控制台（`Refused to display ...`），
//! 跨域下连错误对象都拿不到。所以这块**不是靠读响应头能解决的**：
//! 只要还是 iframe，就永远打不开 `X-Frame-Options: SAMEORIGIN` 的站点。
//!
//! Electron 桌面端（DeepSeek Harness 的 `<webview>`）之所以能开，是因为它不是 iframe，
//! 而是一个**独立的浏览上下文**；服务器无从知道它被谁摆在界面哪一格，这套响应头不适用。
//! Tauri 里等价的能力就是本文件的 child webview：同一窗口内的独立 WebView2 实例，
//! 由 `Window::add_child` 创建、`set_bounds` 定位。
//!
//! ## 安全口径（与 dsh 的 `browser-guests.ts` 同一条思路）
//!
//! 这里加载的是**外部网页**，所以四件事必须钉住：
//! 1. **它碰不到本应用的命令**：Tauri 2 对非本地来源发起的 IPC 一律要求显式 `remote`
//!    capability（`tauri/src/webview/mod.rs::on_message` 的 `!is_local` 分支）。本应用的
//!    capabilities 里没有 `remote`，所以命令本来就不通；但拒绝**不是静默的**（页面调一次就留一条
//!    控制台红字），所以在下面再加一道 `REMOTE_LOCKDOWN`：`_blank` 就地导航 + IPC 通道永不落地；
//! 2. **导航只放行 web**：`file:` / `tauri:` / 未知自定义协议一律拒绝，避免网页把视图带到
//!    本地资源或应用自己的协议上；带用户名 / 密码的地址也拒绝（会被写进标签标题与历史）；
//! 3. **新窗口不另开**：`window.open` / `target=_blank` 收进**同一个视图**导航
//!    （返回 `Deny`）。面板只有一个视图，凭空多出一个窗口用户不知道它在哪；
//! 4. **地址栏显示真实地址**：页面自己跳转（含服务端重定向）由 `on_page_load` 回传给主
//!    webview，地址栏与标签标题因此可以跟着换 —— iframe 时代跨域读不到，只能标「已跳转」。
//! 5. **下载一律不落盘**：这块视图浮在 HTML 上，没有浏览器那种下载栏，放行就是
//!    「静默写进系统下载目录」（用户点一下只看到没反应，磁盘上却多了个文件）。
//!    `on_download` 直接取消，只把文件名报回去，由前端出一条提示。
//!    参考实现 dsh 桌面端也是拒绝（`browser-guests.ts` 的 `will-download` → `preventDefault()`），
//!    但它连提示都没有 —— 这里要的是「不静默」，不是「照抄」。

//!
//! ## 坐标
//!
//! 前端传的是**逻辑像素**（DIP）：`getBoundingClientRect()` 量出来的是 CSS 像素，前端已经乘过
//! **已生效的界面缩放**（`setZoom(1.25)` 之后 1 CSS px 占 1.25 DIP，见 `ui/hooks/applied-zoom.ts`）。
//! 这里只交给 `LogicalPosition` / `LogicalSize`，屏幕 DPI 的换算由 Tauri / WebView2 按窗口自己算。
//! ⚠️ 两个容易混的倍率：窗口 DPI（系统缩放 125%）已在 `Logical*` 里面，而 webview 的
//! `setZoom` **不在**——子视图是独立的 WebView2 控制器，不会跟着主 webview 缩放，所以那个倍率
//! 只能前端在传参前乘进来（Rust 侧拿不到主 webview 的 zoom，Tauri 没给 getter）。
//! 症状对照：漏乘 = 视图比占位小一圈且整体往左上收，缩放越大差得越远。
//! ⚠️ 子 WebView 是**原生窗口**，浮在 HTML 之上：位置 / 尺寸 / 显隐都要前端逐帧同步
//! （见 `src/infrastructure/browser/browser-view.ts` 与 `BrowserPane` 的宿主 hook）。
//! 这里的「浮在 HTML 之上」是硬约束 —— 它是窗口的子窗口，`z-index` / portal 都管不了它，
//! 所以上面那些 DOM 浮层（设置页 `.settings-overlay` / `Modal` / 抽屉 / 右键菜单）一打开，
//! 必须由前端把它 `hide` 掉（占位中心点的 `elementFromPoint` 判定，见 `use-native-view.ts`），
//! 而不能指望用层级把它压下去。

use tauri::{Emitter, LogicalPosition, LogicalSize, Manager, Url};

/// 主窗口 / 主 webview 的 label（`tauri.conf.json` 只声明了一个窗口，没写 label 时默认 `main`）
const MAIN: &str = "main";

/// 远程页面**既碰不到宿主通道，也不走「新窗口请求」那条链路**。
///
/// ### 为什么需要这段脚本
///
/// 在网页里点一个 `<a target="_blank">`，控制台会冒出一条与页面无关的红字：
///
/// ```text
/// Uncaught (in promise) shell.open not allowed on window "main", webview "browser-view-1", URL: https://www.baidu.com/
/// allowed on: [windows: "main", URL: local]  referenced by: capability: default, permission: allow-open
/// ```
///
/// 链路是：Tauri 把 `__TAURI_INTERNALS__`（`invoke`）与 `window.ipc` **注入到每一个 webview**
/// （`tauri/src/manager/webview.rs` 的 `all_initialization_scripts`），远程子视图也不例外；
/// 命令被 capability 拦住（没有 `remote`）—— 但拒绝**不是静默的**，页面调一次就在控制台留一条红字。
///
/// ⚠️ 想「把入口删掉」是行不通的，已经试过：`__TAURI_INTERNALS__` 是
/// `Object.defineProperty(window, …)`（**无 `configurable`**）装的，`window.ipc` 更死（
/// `Object.freeze`）—— 页面上 `delete` / 重定义都是静默失败。所以只能从两个**可控的面**收口：
///
/// 1. **`<a target="_blank">` 在 DOM 层就地导航**：`preventDefault` + `location.href`，
///    WebView2 根本不会发起「新窗口请求」。与已有的 `on_new_window` → `Deny` 同一语义
///    （面板只有一个视图），但走的是普通导航 —— 地址栏 / 历史照常回传，也不碰宿主通道；
/// 2. **把 IPC 的 `fetch` 通道掐成「永不落地」**：`invoke` 的实现在 `ipc-protocol.js` 里先用
///    `fetch('http://ipc.localhost/…')` 发命令，失败才回退 `window.ipc.postMessage`；
///    我们不回退、也不报错，页面就算调 `invoke` 也只会拿到一个永远 pending 的 Promise。
///    用的是**永不 settle** 而不是「报错」：报错会让 `ipc-protocol.js` 回退到 postMessage 那条真的通的路。
///
/// 口径：命令本来就不通（capability 没有 `remote`），这里收的是「噪声」与「不用的面」，
/// 不是唯一的防线。也用了 `_for_all_frames`：iframe 里的 `_blank` 链接一并管住。
const REMOTE_LOCKDOWN: &str = r#"
(function () {
  // ① `<a target="_blank">`（含中键）：就地导航，不交给 WebView2 的新窗口机制
  function follow(e) {
    if (e.defaultPrevented) return
    var el = e.target
    if (el && el.nodeType !== 1) el = el.parentElement
    while (el && el.nodeType === 1 && el.tagName !== 'A') el = el.parentElement
    if (!el || el.tagName !== 'A') return
    if (String(el.target || '').toLowerCase() !== '_blank') return
    var href = el.href || ''
    if (!/^https?:/i.test(href)) return // 其它协议继续交给 on_navigation 拒
    e.preventDefault()
    location.href = href
  }
  document.addEventListener('click', follow, true)
  document.addEventListener('auxclick', follow, true)

  // ② 宿主 IPC 通道：永不落地（见上面的注释，不能改成报错）
  var rawFetch = window.fetch
  if (typeof rawFetch === 'function') {
    window.fetch = function (input) {
      var url = typeof input === 'string' ? input : (input && input.url) || ''
      if (url.indexOf('ipc.localhost') !== -1 || url.indexOf('ipc://') === 0) {
        return new Promise(function () {})
      }
      return rawFetch.apply(this, arguments)
    }
  }
})()
"#;

/// 网页侧状态回传事件：**只发给主 webview**（不能让网页自己收到自己的浏览记录）
pub const NAVIGATE_EVENT: &str = "browser:navigate";

/// `http(s)` 且不带凭据 —— 地址栏能接受的东西，这里才接受。
fn parse_web_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|e| format!("地址无法解析: {e}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("只支持 http / https 地址".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("地址里不能带用户名或密码".to_string());
    }
    Ok(url)
}

/// 导航白名单：web + `about:blank`。
///
/// `about:blank` 是 WebView2 创建时的初始文档（`on_navigation` 会看到它），
/// 拦掉会让视图一直白屏；其余 `about:` / `file:` / `data:` 一律不认。
fn navigation_allowed(url: &Url) -> bool {
    match url.scheme() {
        "http" | "https" => true,
        "about" => url.as_str() == "about:blank",
        _ => false,
    }
}

fn view_of(app: &tauri::AppHandle, label: &str) -> Result<tauri::Webview, String> {
    app.get_webview(label)
        .ok_or_else(|| format!("网页视图不存在: {label}"))
}

/// 把网页侧的变化发给主 webview。
///
/// ⚠️ 不能用 `app.emit`：那是广播，网页自己也会收到（等于把浏览记录回灌给它）。
fn emit_to_main(app: &tauri::AppHandle, payload: serde_json::Value) {
    if let Some(main) = app.get_webview(MAIN) {
        let _ = main.emit(NAVIGATE_EVENT, payload);
    }
}

/// 地址变化（`phase = "location"`）。`about:blank` 不算导航。
fn emit_location(app: &tauri::AppHandle, label: &str, url: &str) {
    if url.is_empty() || url == "about:blank" {
        return;
    }
    emit_to_main(
        app,
        serde_json::json!({ "label": label, "phase": "location", "url": url }),
    );
}

/// 页面标题（`phase = "title"`）。空标题忽略：否则会把标签打回空白。
fn emit_title(app: &tauri::AppHandle, label: &str, title: &str) {
    let title = title.trim();
    if title.is_empty() {
        return;
    }
    emit_to_main(
        app,
        serde_json::json!({ "label": label, "phase": "title", "title": title }),
    );
}

/// 下载建议文件名。
///
/// WebView2 会把「默认下载目录 + 建议文件名」填进 `destination`（`ResultFilePath()`），
/// 正常情况取末段即可；取不到（`blob:` 下载 / 空路径）时退回 URL 最后一段 ——
/// 那里可能是百分号编码，但这段文本只用来**展示**，不参与任何路径拼接。
fn download_name(destination: &std::path::Path, url: &Url) -> Option<String> {
    if let Some(name) = destination.file_name().and_then(|name| name.to_str()) {
        let name = name.trim();
        if !name.is_empty() {
            return Some(name.to_string());
        }
    }
    let segment = url
        .path_segments()?
        .filter(|segment| !segment.is_empty())
        .next_back()?;
    Some(segment.to_string())
}

/// 网页发起的下载（`phase = "download"`）。
///
/// 调用方（`on_download`）随后会**取消**这次下载：本函数只负责把「想下什么」说清楚。
/// `name` 拿不到时是 `null`，前端照样出提示；`url` 只回传 http(s) ——
/// `blob:` / `data:` 的地址换个进程也打不开，没有「在系统浏览器中打开」的意义。
fn emit_download(app: &tauri::AppHandle, label: &str, url: &Url, destination: &std::path::Path) {
    emit_to_main(
        app,
        serde_json::json!({
            "label": label,
            "phase": "download",
            "name": download_name(destination, url),
            "url": matches!(url.scheme(), "http" | "https").then(|| url.as_str()),
        }),
    );
}

/// Windows：订阅 WebView2 自己的 `SourceChanged` / `DocumentTitleChanged`。
///
/// 为什么不能只靠 `on_page_load`：SPA 的 `history.pushState` **不触发页面加载**，
/// 但会改 `Source` 并触发 `SourceChanged` —— 地址栏要跟着动就只剩这一条路；
/// 站内路由换标题同理（`DocumentTitleChanged`）。
#[cfg(target_os = "windows")]
fn observe_native_events(app: &tauri::AppHandle, view: &tauri::Webview, label: &str) {
    use webview2_com::{take_pwstr, DocumentTitleChangedEventHandler, SourceChangedEventHandler};
    use windows_core::PWSTR;

    let location_app = app.clone();
    let location_label = label.to_string();
    let title_app = app.clone();
    let title_label = label.to_string();

    let _ = view.with_webview(move |platform| unsafe {
        let Ok(core) = platform.controller().CoreWebView2() else {
            return;
        };
        let mut token = 0i64;

        // 事件源会自己 AddRef，局部 handler 释放后回调仍然有效
        let source_changed = SourceChangedEventHandler::create(Box::new(move |sender, _args| {
            if let Some(core) = sender {
                // WebView2 的这两个属性是 out 参数（*mut PWSTR），不是返回值
                let mut raw = PWSTR::null();
                if core.Source(&mut raw).is_ok() {
                    emit_location(&location_app, &location_label, &take_pwstr(raw));
                }
            }
            Ok(())
        }));
        let _ = core.add_SourceChanged(&source_changed, &mut token);

        let title_changed =
            DocumentTitleChangedEventHandler::create(Box::new(move |sender, _args| {
                if let Some(core) = sender {
                    let mut raw = PWSTR::null();
                    if core.DocumentTitle(&mut raw).is_ok() {
                        emit_title(&title_app, &title_label, &take_pwstr(raw));
                    }
                }
                Ok(())
            }));
        let _ = core.add_DocumentTitleChanged(&title_changed, &mut token);
    });
}

/// 在窗口里创建（或重建）一个网页视图。
///
/// ⚠️ 必须是 `async fn`：`Window::add_child` 内部会 `run_on_main_thread` 并**阻塞等待**
/// 主线程完成。同步命令本身就跑在主线程上，写成 `fn` 会直接死锁。
///
/// 尺寸为 0 时不创建：前端只在量到布局之后才调用（不可见的标签页没有 rect）。
#[tauri::command]
pub async fn browser_view_open(
    app: tauri::AppHandle,
    label: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let parsed = parse_web_url(&url)?;
    if width < 1.0 || height < 1.0 {
        return Err("网页视图尺寸无效".to_string());
    }
    let window = app
        .get_window(MAIN)
        .ok_or_else(|| "主窗口不存在".to_string())?;

    // 同名 label 先收掉旧的：React StrictMode 的「挂载 → 卸载 → 再挂载」与开发期热重载
    // 都会走到这里，否则 `add_child` 直接报 `WebviewLabelAlreadyExists`。
    if let Some(previous) = app.get_webview(&label) {
        let _ = previous.close();
    }

    let load_app = app.clone();
    let load_label = label.clone();
    let title_app = app.clone();
    let title_label = label.clone();
    let popup_app = app.clone();
    let popup_label = label.clone();
    let download_app = app.clone();
    let download_label = label.clone();

    let builder = tauri::webview::WebviewBuilder::new(
        label.clone(),
        tauri::WebviewUrl::External(parsed),
    )
    // 远程页面：`_blank` 就地导航 + 宿主 IPC 通道永不落地（见 `REMOTE_LOCKDOWN` 的注释）
    .initialization_script_for_all_frames(REMOTE_LOCKDOWN)
    .on_navigation(navigation_allowed)
    .on_page_load(move |webview, payload| {
        let phase = match payload.event() {
            tauri::webview::PageLoadEvent::Started => "started",
            tauri::webview::PageLoadEvent::Finished => "finished",
        };
        emit_to_main(
            &load_app,
            serde_json::json!({
                "label": &load_label,
                "url": payload.url().as_str(),
                "phase": phase,
            }),
        );
        // 标题兜底：Windows 有 `DocumentTitleChanged` 原生事件（连 SPA 改标题都能跟），
        // 其他平台只能等主 frame 加载完成后问一次 `document.title`。
        if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
            let app_title = load_app.clone();
            let label_title = load_label.clone();
            let _ = webview.eval_with_callback("document.title", move |result| {
                if let Ok(serde_json::Value::String(title)) =
                    serde_json::from_str::<serde_json::Value>(&result)
                {
                    emit_title(&app_title, &label_title, &title);
                }
            });
        }
    })
    // 标签标题用页面自己的 document.title（比主机名更好认）；地址栏仍以 URL 为准
    .on_document_title_changed(move |_webview, title| {
        emit_title(&title_app, &title_label, &title);
    })
    // `target=_blank` / `window.open`：右侧栏只有一个视图，把这次跳转收进同一个视图
    .on_new_window(move |url, _features| {
        if navigation_allowed(&url) {
            if let Some(view) = popup_app.get_webview(&popup_label) {
                let _ = view.navigate(url);
            }
        }
        tauri::webview::NewWindowResponse::Deny
    })
    // 下载：`false` = 取消这次下载（不落盘），只把文件名报给前端做提示。
    // 不注册这个钩子时 WebView2 会直接写进系统下载目录，面板上一点动静都没有。
    .on_download(move |_webview, event| match event {
        tauri::webview::DownloadEvent::Requested { url, destination } => {
            emit_download(&download_app, &download_label, &url, &*destination);
            false
        }
        // 已经取消的下载不会有 `Finished`；其余（`#[non_exhaustive]`）不该被这里拦
        _ => true,
    });

    let webview = window
        .add_child(
            builder,
            LogicalPosition::new(x, y),
            LogicalSize::new(width, height),
        )
        .map_err(|e| format!("创建网页视图失败: {e}"))?;
    // Windows：真实地址与标题走 WebView2 自己的事件（SPA 的 pushState 只能靠它）
    #[cfg(target_os = "windows")]
    observe_native_events(&app, &webview, &label);
    Ok(())
}

/// 同步位置 / 尺寸 / 显隐（前端逐帧调用，只在真的变了时才发）。
///
/// 三件事合成**一条命令**：分开的 `set_bounds` / `show` 是并发执行的 async 命令，
/// 从「隐藏」恢复时可能「先显示、后定位」，用户会看到视图在旧位置闪一下。
///
/// 视图还没创建（或刚被关掉）时**静默放过**：调用方在下一帧会重新量、重新建，
/// 这里报错只会把一次正常的时序竞争变成一条红色日志。
#[tauri::command]
pub fn browser_view_apply(
    app: tauri::AppHandle,
    label: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    visible: bool,
) -> Result<(), String> {
    let Some(view) = app.get_webview(&label) else {
        return Ok(());
    };
    // 0 尺寸在 WebView2 上是非法参数；不可见时一律先藏起来
    if !visible || width < 1.0 || height < 1.0 {
        let _ = view.hide();
        return Ok(());
    }
    // 顺序不能反：从隐藏恢复时先定位、再显示
    view.set_position(LogicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    view.set_size(LogicalSize::new(width, height))
        .map_err(|e| e.to_string())?;
    let _ = view.show();
    Ok(())
}

/// 发起一次导航（地址栏回车、后退 / 前进、刷新都走这里）。
#[tauri::command]
pub async fn browser_view_navigate(
    app: tauri::AppHandle,
    label: String,
    url: String,
) -> Result<(), String> {
    let view = view_of(&app, &label)?;
    let parsed = parse_web_url(&url)?;
    view.navigate(parsed).map_err(|e| e.to_string())
}

/// 重新加载当前页面（地址不变也要真的重载）。
#[tauri::command]
pub async fn browser_view_reload(app: tauri::AppHandle, label: String) -> Result<(), String> {
    let view = view_of(&app, &label)?;
    view.reload().map_err(|e| e.to_string())
}

/// 后退 / 前进。
///
/// Tauri 没有暴露 `canGoBack` / `goBack`，但面板自己维护着一条历史（`browser/url.ts`）：
/// 我们发起的每次导航都会同时进 WebView2 的历史栈，所以这里执行网页自己的
/// `history.back()` 与那条历史是同一个方向。
#[tauri::command]
pub async fn browser_view_history(
    app: tauri::AppHandle,
    label: String,
    direction: String,
) -> Result<(), String> {
    let view = view_of(&app, &label)?;
    let script = match direction.as_str() {
        "back" => "history.back()",
        "forward" => "history.forward()",
        other => return Err(format!("未知的历史方向: {other}")),
    };
    view.eval(script).map_err(|e| e.to_string())
}

/// 当前真实地址（`null` = 视图不存在）。
///
/// 走 WebView2 自己的 `Source`：页面内部跳转、服务端重定向之后，它比我们的历史栈更准。
#[tauri::command]
pub async fn browser_view_current_url(
    app: tauri::AppHandle,
    label: String,
) -> Result<Option<String>, String> {
    match app.get_webview(&label) {
        Some(view) => Ok(view.url().ok().map(|url| url.to_string())),
        None => Ok(None),
    }
}

/// 销毁视图（关标签 / 组件卸载）。不存在的 label 直接当作成功 —— 卸载路径不该报错。
#[tauri::command]
pub async fn browser_view_close(app: tauri::AppHandle, label: String) -> Result<(), String> {
    if let Some(view) = app.get_webview(&label) {
        let _ = view.close();
    }
    Ok(())
}
