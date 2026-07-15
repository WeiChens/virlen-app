use tauri::AppHandle;
#[cfg(target_os = "windows")]
use tauri::Manager;

/**
 * 授予麦克风和摄像头权限（启动时调用）
 *
 * ## 平台策略
 * - **Windows**: 通过 WebView2 COM API (`ICoreWebView2Profile4`) 将权限预设为 ALLOW
 * - **macOS**: 由 WKWebView 原生权限弹窗处理，需在 Info.plist 配置描述文案
 * - **Linux**: 由 WebKitGTK 权限弹窗处理
 *
 * ## macOS Info.plist 必需配置
 * 需要在 src-tauri/Info.plist 或 tauri.conf.json 中添加：
 * - `NSCameraUsageDescription` — 使用摄像头的目的说明
 * - `NSMicrophoneUsageDescription` — 使用麦克风的目的说明
 */
#[tauri::command]
pub fn grant_permissions(app: AppHandle) {
    #[cfg(target_os = "windows")]
    {
        grant_permissions_windows(&app);
    }

    #[cfg(target_os = "macos")]
    {
        let _ = app;
        // macOS: WKWebView 会自动弹出系统权限对话框，
        // 前提是 Info.plist 已配置 NSCameraUsageDescription / NSMicrophoneUsageDescription
        println!("grant_permissions: macOS — system dialog will handle camera/mic permissions via Info.plist");
    }

    #[cfg(target_os = "linux")]
    {
        let _ = app;
        // Linux: WebKitGTK 通过其权限请求 API 处理，
        // 用户会在首次使用摄像头/麦克风时看到弹窗
        println!("grant_permissions: Linux — WebKitGTK will prompt for camera/mic permissions on first use");
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = app;
        println!("grant_permissions: unsupported platform");
    }
}

/// Windows 平台实现：将麦克风/摄像头权限预设为 ALLOW
#[cfg(target_os = "windows")]
fn grant_permissions_windows(app: &AppHandle) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Profile4, ICoreWebView2_13, COREWEBVIEW2_PERMISSION_KIND_CAMERA,
        COREWEBVIEW2_PERMISSION_KIND_MICROPHONE, COREWEBVIEW2_PERMISSION_STATE_ALLOW,
    };
    use windows_core::{Interface, PCWSTR};

    let webview = match app.get_webview_window("main") {
        Some(w) => w,
        None => {
            eprintln!("grant_permissions: main webview window not found");
            return;
        }
    };

    // 从 Tauri 配置中读取 devUrl，支持自定义端口
    let dev_url = app
        .config()
        .build
        .dev_url
        .as_ref()
        .map(|u| u.to_string())
        .unwrap_or_else(|| "http://localhost:1420".to_string());

    // 支持的 origin 列表（自动包含 devUrl）
    let origins = [
        format!("{}\0", dev_url.trim_end_matches('/')),
        "tauri://localhost\0".to_string(),
        "https://tauri.localhost\0".to_string(),
        "http://tauri.localhost\0".to_string(),
        "*\0".to_string(), // 通配符，允许所有 origin（如果 WebView2 版本支持）
    ];

    webview
        .with_webview(move |webview| unsafe {
            let controller = webview.controller();
            let core = match controller.CoreWebView2() {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("grant_permissions: failed to get CoreWebView2: {}", e);
                    return;
                }
            };
            let core_13 = match Interface::cast::<ICoreWebView2_13>(&core) {
                Ok(c) => c,
                Err(e) => {
                    eprintln!(
                        "grant_permissions: failed to cast to ICoreWebView2_13: {}",
                        e
                    );
                    return;
                }
            };
            let profile = match core_13.Profile() {
                Ok(p) => p,
                Err(e) => {
                    eprintln!("grant_permissions: failed to get Profile: {}", e);
                    return;
                }
            };
            let profile4 = match Interface::cast::<ICoreWebView2Profile4>(&profile) {
                Ok(p) => p,
                Err(e) => {
                    eprintln!(
                        "grant_permissions: failed to cast to ICoreWebView2Profile4: {}",
                        e
                    );
                    return;
                }
            };

            for origin_str in &origins {
                let origin_utf16: Vec<u16> = origin_str.encode_utf16().collect();
                let origin_ptr = PCWSTR::from_raw(origin_utf16.as_ptr());

                // 麦克风 → ALLOW
                if let Err(e) = profile4.SetPermissionState(
                    COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
                    origin_ptr,
                    COREWEBVIEW2_PERMISSION_STATE_ALLOW,
                    None,
                ) {
                    eprintln!(
                        "grant_permissions: failed to set microphone ALLOW for {}: {}",
                        origin_str.trim_end_matches('\0'),
                        e
                    );
                }

                // 摄像头 → ALLOW
                if let Err(e) = profile4.SetPermissionState(
                    COREWEBVIEW2_PERMISSION_KIND_CAMERA,
                    origin_ptr,
                    COREWEBVIEW2_PERMISSION_STATE_ALLOW,
                    None,
                ) {
                    eprintln!(
                        "grant_permissions: failed to set camera ALLOW for {}: {}",
                        origin_str.trim_end_matches('\0'),
                        e
                    );
                }
            }

            println!("grant_permissions: microphone & camera set to ALLOW for all origins");
        })
        .unwrap_or_else(|e| {
            eprintln!("grant_permissions: with_webview failed: {}", e);
        });
}
