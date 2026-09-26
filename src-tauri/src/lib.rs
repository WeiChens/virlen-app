use std::fs;
// `Manager` 现在在所有平台都被用到（退出钩子里的 `try_state`），因此不再按 target 条件编译
use tauri::Manager;

mod clipboard_files;
/// 全部 `#[tauri::command]`（GUI 壳）—— 业务语义在 `virlen-core`
mod commands;
#[cfg(target_os = "windows")]
mod drag_drop;
mod common_service;
mod deepseek_tokenizer;
/// GUI 宿主实现（`TauriHost`）；`HostEnv` trait 与 `CliHost` 在 `virlen-core::host`
mod host;
mod load_env;
mod vision_service;
mod speech_service;
mod task_manager;
/// GUI 侧埋点出口（Tauri emit + panic 拉取命令）；其余在 `virlen-core::telemetry`
mod telemetry;
#[cfg(desktop)]
mod tray;

/// 将文件或目录移动到系统回收站（跨平台）
#[tauri::command]
async fn move_to_trash(path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        trash::delete(&path).map_err(|e| format!("移动到回收站失败: {}", e))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// 沙盒诊断：Windows 返回状态目录/能力 SID/环境变量覆盖；其它平台返回接入说明。
#[tauri::command]
fn sandbox_diagnostics() -> serde_json::Value {
    #[cfg(target_os = "windows")]
    {
        serde_json::to_value(virlen_core::sandbox::diagnostics())
            .unwrap_or_else(|e| serde_json::json!({ "error": e.to_string() }))
    }
    #[cfg(not(target_os = "windows"))]
    {
        serde_json::json!({
            "platform": std::env::consts::OS,
            "note": "sandbox integrated (Landlock on Linux / sandbox-exec on macOS)"
        })
    }
}

#[tauri::command]
fn os_platform() -> String {
    std::env::consts::OS.to_string()
}

#[tauri::command]
async fn save_file_to_path(buffer: Vec<u8>, path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        fs::write(&path, &buffer)
            .map_err(|e| format!("写入文件失败: {}: {}", path, e))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
// ⚠️ `#[allow(too_many_arguments)]`：Tauri 命令参数逐个从 JS 传，收结构体会要求前端改调用形状。
#[allow(clippy::too_many_arguments)]
async fn search_files_by_name(
    root: String,
    query: String,
    use_regex: bool,
    max_results: usize,
    task_id: String,
    // 遍历范围（侧边栏搜索框用）：跳过点项 / 依赖·构建目录，
    // keep_dirs 是已展开的那份忽略目录（例外）。详见 virlen_core::search::search_files_by_name 注释。
    include_hidden: bool,
    skip_dir_names: Vec<String>,
    keep_dirs: Vec<String>,
) -> Result<Vec<virlen_core::search::FileSearchResult>, String> {
    let cancel_flag = task_manager::register(&task_id);
    let root_c = root.clone();
    let query_c = query.clone();

    let task = tokio::task::spawn_blocking(move || {
        virlen_core::search::search_files_by_name(
            &root_c,
            &query_c,
            use_regex,
            max_results,
            &cancel_flag,
            include_hidden,
            &skip_dir_names,
            &keep_dirs,
        )
    });

    let result = tokio::time::timeout(std::time::Duration::from_secs(30), task)
        .await
        .map_err(|_| "Search timed out after 30s".to_string())?
        .map_err(|e| format!("Search failed: {}", e))?;

    task_manager::unregister(&task_id);
    Ok(result)
}

#[tauri::command]
async fn search_text_in_files(
    root: String,
    query: String,
    max_results: usize,
    task_id: String,
) -> Result<Vec<virlen_core::search::TextSearchResult>, String> {
    let cancel_flag = task_manager::register(&task_id);
    let root_c = root.clone();
    let query_c = query.clone();

    let task = tokio::task::spawn_blocking(move || {
        virlen_core::search::search_text_in_files(&root_c, &query_c, max_results, &cancel_flag)
    });

    let result = tokio::time::timeout(std::time::Duration::from_secs(30), task)
        .await
        .map_err(|_| "Search timed out after 30s".to_string())?
        .map_err(|e| format!("Search failed: {}", e))?;

    task_manager::unregister(&task_id);
    Ok(result)
}

#[tauri::command]
async fn list_directory(
    root: String,
    recursive: bool,
    include_hidden: bool,
    max_depth: usize,
    skip_each_dirs: Vec<String>,
    task_id: String,
) -> Result<Vec<virlen_core::search::DirEntry>, String> {
    let cancel_flag = task_manager::register(&task_id);

    let task = tokio::task::spawn_blocking(move || {
        virlen_core::search::list_directory(
            &root,
            recursive,
            include_hidden,
            max_depth,
            &skip_each_dirs,
            &cancel_flag,
        )
    });

    let result = tokio::time::timeout(std::time::Duration::from_secs(30), task)
        .await
        .map_err(|_| "Directory listing timed out after 30s".to_string())?
        .map_err(|e| format!("Directory listing failed: {}", e))?;

    task_manager::unregister(&task_id);
    Ok(result)
}

/// 停止一个正在运行的任务
/// 返回 true 表示任务已被标记取消；false 表示没有找到该任务
#[tauri::command]
fn stop_task(task_id: String) -> bool {
    task_manager::stop(&task_id)
}

/// 跨平台强制杀进程树（进程 + 所有子进程）
/// - Windows: Job Object / 递归 Toolhelp32 枚举后代逐个 taskkill（不依赖树关系）
/// - Linux/macOS: 递归 ps 枚举后代逐个 kill（不依赖进程组）
#[tauri::command]
async fn kill_process_tree(pid: u32) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        virlen_core::agent::process_tree::kill_process_tree(pid);
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?;

    telemetry::track(
        "rust.command.kill",
        serde_json::json!({ "pid": pid, "reason": "user" }),
    );
    Ok(())
}

#[tauri::command]
async fn read_file_with_hash(path: String) -> Result<virlen_core::file_ops::FileReadResult, String> {
    tokio::task::spawn_blocking(move || {
        virlen_core::file_ops::read_file(&path)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// 路径元信息（不存在时 `stat_path` 返回 None，不报错）
#[derive(serde::Serialize)]
pub struct PathStat {
    pub exists: bool,
    pub is_file: bool,
    pub size: u64,
}

/// 探测路径是否存在、是否文件、多大。
///
/// 给「先探测再读取」的场景用：会话创建时读取项目规则文件（`AGENTS.md` 等），
/// 需要先判断体积是否超限 —— 有了它就不必把超大文件整个读进内存才发现该拒绝。
#[tauri::command]
async fn stat_path(path: String) -> Result<Option<PathStat>, String> {
    let expanded = virlen_core::sandbox::paths::expand_user_path(&path);
    tokio::task::spawn_blocking(move || {
        let p = std::path::Path::new(&expanded);
        match std::fs::metadata(p) {
            Ok(m) => Ok(Some(PathStat {
                exists: true,
                is_file: m.is_file(),
                size: m.len(),
            })),
            // 不存在（含父目录不存在）是「正常结果」，不是错误
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("Cannot stat '{}': {}", expanded, e)),
        }
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// 规范化路径：展开 ~/%USERPROFILE% → canonicalize → 返回绝对路径
#[tauri::command]
async fn canonicalize_path(path: String) -> Option<String> {
    // 路径展开操作很快，但 canonicalize 可能涉及 I/O
    tokio::task::spawn_blocking(move || {
        let expanded = virlen_core::sandbox::paths::expand_user_path(&path);
        let p = std::path::Path::new(&expanded);
        p.canonicalize()
            .ok()
            .map(|c| c.to_string_lossy().to_string().replace('\\', "/"))
    })
    .await
    .ok()
    .flatten()
}

/// 检查路径是否是一个有效的目录
#[tauri::command]
async fn check_is_directory(path: String) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || {
        let p = std::path::Path::new(&path);
        if !p.exists() {
            return Err(format!("路径不存在: {}", path));
        }
        if !p.is_dir() {
            return Err(format!("不是目录: {}", path));
        }
        Ok(true)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
async fn edit_file_multi_in_place(
    path: String,
    edits: Vec<virlen_core::file_ops::EditEntry>,
    expected_hash: String,
) -> Result<virlen_core::file_ops::FileEditMultiResult, String> {
    tokio::task::spawn_blocking(move || {
        virlen_core::file_ops::edit_file_multi(&path, &edits, &expected_hash)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // ⚠️ 单实例必须**第一个**注册（插件的 setup 按注册顺序执行，且在 `App::build()` 内、
    // 早于下方 `.setup()` 与窗口创建）：这样第二个实例才能在「建窗口 / 建托盘 / 连数据库」
    // 之前就退出，不会多出一个托盘图标或半初始化的进程。
    //
    // **dev 下不启用**（`tauri dev` 跑 devUrl 的开发模式）：开发时允许并存多个实例 ——
    // 否则上一次没关干净的 dev 实例（关窗口只是隐藏到托盘，进程还在）会把新起的那次顶掉，
    // 表现为「`pnpm tauri dev` 跑完什么都没出现」（参数交给旧进程后自己退了）。
    // 判定用 `tauri::is_dev()`：它由 tauri 的 build script 写成 `DEP_TAURI_DEV`
    // （生产构建会启用 `tauri/custom-protocol`），与「是不是开发模式」严格一致；
    // 注意**不要**自己写 `cfg!(feature = "custom-protocol")` —— 本包没声明这个 feature。
    let mut builder = tauri::Builder::default();
    if !tauri::is_dev() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // 回调里拿到的是另一个进程的 argv/cwd。本应用不做文件关联，但有一条 argv
            // 语义必须接住：MSIX 清单 `com:ExeServer@Arguments` 的 `-ToastActivated`
            // —— 点击通知时系统按 CLSID 拉起**新**进程，而那个进程在把自己的 COM
            // 类对象注册上之前就被本插件拦下，于是「点通知」退化成「只是聚焦窗口」。
            #[cfg(desktop)]
            {
                let reason = if tray::toast_activator::is_toast_activated(&argv) {
                    "toast_activated"
                } else {
                    "second_instance"
                };
                tray::activate_main_window(app, reason);
            }
            #[cfg(not(desktop))]
            let _ = (app, argv);
        }));
    }

    builder
        .setup(|app| {
            // 初始化 Rust 侧埋点（panic hook + 事件回传桥）
            telemetry::init(app.handle());

            // 初始化 Agent 引擎（Rust 聊天循环）
            commands::agent::init_agent_engine(app.handle());

            // 初始化 RAG 知识库服务
            if let Err(e) = commands::rag::init_rag_service(app.handle()) {
                eprintln!("[RAG] 初始化失败: {}", e);
            } 
            // else {
            //     println!("[RAG] 知识库服务初始化成功");
            // }

            // 视觉模型按需懒加载（`vision::analyze*` 内部管引用计数），启动期无需初始化

            // 系统托盘：关闭窗口改为隐藏（AI 继续在后台跑），托盘菜单提供真正的退出入口
            #[cfg(desktop)]
            {
                app.manage(tray::TrayState::default());
                // Windows：把**进程**声明成与开始菜单快捷方式相同的 AUMID
                // （通知的归属/图标，以及点击激活都按它来，见 tray::notify）
                tray::notify::init_app_identity(app.handle());
                // 注册 toast 点击的 COM 激活器（CLSID 与 MSIX 清单一致，见 tray::toast_activator）：
                // 放在托盘创建之前 —— 「被点击通知拉起」的进程要让类对象尽快挂上（系统有超时）
                tray::toast_activator::init(app.handle());
                if let Err(e) = tray::init(app.handle()) {
                    // 托盘不可用 → decide_close 会回退成「关闭即退出」，
                    // 不会出现「窗口被隐藏、又没有托盘」的死局
                    eprintln!("[tray] 托盘初始化失败，关闭窗口将直接退出: {}", e);
                }
            }

            // Windows：把拖放换成自定义 OLE 目标（比 wry 多认 VS Code 的拖拽格式）
            #[cfg(target_os = "windows")]
            drag_drop::init(app.handle());

            // 预热 DeepSeek tokenizer（后台线程解析，不阻塞启动；失败静默）
            deepseek_tokenizer::prewarm(app.handle());

            // macOS: visible=false 会阻止 WKWebView 加载 JS，导致窗口永远无法通过 JS show()
            // 因此 macOS 上不做白屏优化，直接显示窗口
            #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                // 窗口已显示 → 刷新一次托盘（否则 tooltip 会停留在
                // 「已隐藏到托盘，右键可退出」，要等下一次工作/完成事件才纠正）
                #[cfg(desktop)]
                tray::refresh_tray(app.handle());
            }
            Ok(())
        })
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // 系统通知（Phase 2）：完成提醒的优先通道，降级链见 `tray::notify`
        .plugin(tauri_plugin_notification::init())
        // 托盘的「关闭 ≠ 退出」在此收口：前端标题栏关闭按钮因此一行都不用改
        .on_window_event(|window, event| {
            #[cfg(desktop)]
            tray::handle_window_event(window, event);
            #[cfg(not(desktop))]
            let _ = (window, event);
        })
        .invoke_handler(tauri::generate_handler![
            os_platform,
            // 剪贴板里的文件路径（粘贴文件用，Windows: CF_HDROP）
            clipboard_files::read_clipboard_file_paths,
            // 剪贴板纯文本（PTY 终端右键粘贴用，Windows: CF_UNICODETEXT）
            clipboard_files::read_clipboard_text,
            // 写图片进剪贴板（右键「复制图片」用，Windows: CF_DIB）
            clipboard_files::write_clipboard_image,
            save_file_to_path,
            search_files_by_name,
            search_text_in_files,
            list_directory,
            stop_task,
            read_file_with_hash,
            stat_path,
            edit_file_multi_in_place,
            kill_process_tree,
            canonicalize_path,
            check_is_directory,
            move_to_trash,
            sandbox_diagnostics,
            load_env::get_env_info,
            common_service::grant_permissions,
            vision_service::vision_analyze,
            vision_service::vision_analyze_base64,
            // RAG 知识库命令
            commands::rag::create_knowledge_base,
            commands::rag::list_knowledge_bases,
            commands::rag::delete_knowledge_base,
            commands::rag::add_document_to_knowledge_base,
            commands::rag::remove_document_from_knowledge_base,
            commands::rag::list_knowledge_base_documents,
            commands::rag::query_knowledge_base,
            commands::rag::write_text_to_knowledge_base,
            commands::rag::edit_document_in_knowledge_base,
            commands::rag::edit_text_in_knowledge_base,
            commands::rag::get_knowledge_base_document,
            commands::rag::init_knowledge_bases,
            commands::rag::search_documents_content,
            commands::rag::export_knowledge_base,
            // Agent 引擎（Rust 聊天循环）
            commands::agent::agent_send_message,
            commands::agent::agent_cancel,
            commands::agent::agent_kill_command,
            // PTY 会话交互（Step 1：execute_command 换 ConPTY）
            commands::agent::pty_write,
            commands::agent::pty_resize,
            // 命名控制键（Step 2 ③）
            commands::agent::pty_key,
            // 接管 / 交还（Step 2 ②）
            commands::agent::pty_set_held,
            // TS 引擎路径的原生执行（沙盒 + ConPTY，§7 #14）
            commands::agent::pty_run_command,
            commands::agent::agent_get_run_snapshot,
            commands::agent::agent_clear_run_snapshot,
            commands::agent::agent_dispose,
            // 工具定义权威源（机制 C：前端 toolRegistry 经此取值）
            commands::agent::cmd_list_tool_definitions,
            // 提示词权威源（同上：提示词 md 存在 core，前端经此取值）
            commands::agent::cmd_agent_prompts,
            // 供应商目录（模板表 + 推理档位表；CLI 与 GUI 同一份 core 数据）
            commands::agent::cmd_provider_catalog,
            // 上下文压缩（GUI）：与 CLI 共用 core 同一份实现
            commands::agent::cmd_compress_context,
            commands::agent::agent_tool_response,
            commands::agent::agent_user_interaction_response,
            commands::agent::agent_round_boundary_response,
            commands::agent::agent_provider_stream_event,
            commands::agent::agent_provider_stream_done,
            // 会话持久化（SQLite 直落）
            commands::session_db::cmd_list_sessions,
            commands::session_db::cmd_get_session,
            commands::session_db::cmd_get_messages,
            commands::session_db::cmd_get_message_page,
            commands::session_db::cmd_get_message_window,
            commands::session_db::cmd_get_message_timeline,
            commands::session_db::cmd_get_user_message_refs,
            commands::session_db::cmd_search_messages,
            commands::session_db::cmd_upsert_session,
            commands::session_db::cmd_delete_session,
            commands::session_db::cmd_replace_session_messages,
            commands::session_db::cmd_replace_session_messages_from,
            commands::session_db::cmd_append_messages,
            commands::session_db::cmd_truncate_session_messages,
            // 应用设置（配置下沉 D3）
            commands::session_db::cmd_settings_get_all,
            commands::session_db::cmd_settings_upsert,
            commands::session_db::cmd_settings_import,
            // 用量账本（token 统计）
            commands::session_db::cmd_append_usage,
            commands::session_db::cmd_usage_stats,
            commands::session_db::cmd_usage_query,
            commands::session_db::cmd_usage_clear,
            // 库维护（设置 → 存储：体积快照 / 截断 WAL / 重建数据库）
            commands::session_db::cmd_db_stats,
            commands::session_db::cmd_db_checkpoint,
            commands::session_db::cmd_db_maintain,
            // DeepSeek tokenizer（token 计数）
            deepseek_tokenizer::cmd_count_tokens,
            // 埋点：前端就绪后拉取落盘的历史 panic
            telemetry::telemetry_drain_panics,
            // 托盘命令（铁律 4：新增命令必须在此注册，否则前端 invoke 静默 404）
            #[cfg(desktop)]
            tray::commands::tray_set_working,
            #[cfg(desktop)]
            tray::commands::tray_sync_settings,
            #[cfg(desktop)]
            tray::commands::tray_notify_completed,
            #[cfg(desktop)]
            tray::commands::tray_clear_attention,
            #[cfg(desktop)]
            tray::commands::tray_show_window,
            #[cfg(desktop)]
            tray::commands::tray_quit,
            // macOS 离线语音识别（SFSpeechRecognizer）
            speech_service::macos_request_speech_authorization,
            speech_service::macos_transcribe_speech,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            tauri::RunEvent::ExitRequested { api, code, .. } => {
                // 只有「所有窗口已关闭」触发的默认退出（code = None）才拦；
                // code = Some（托盘退出 / 系统关机注销）一律放行，绝不拦住关机。
                #[cfg(desktop)]
                {
                    if tray::should_prevent_exit(app, code) {
                        api.prevent_exit();
                    } else {
                        // ⚠️ 退出前必须显式销毁托盘图标，否则通知区域会留下「幽灵图标」
                        // （鼠标划过才消失）—— 托管状态与托盘句柄构成引用环，
                        // 底层 NIM_DELETE 在 `cleanup_before_exit` 里发不出去。详见 `tray::destroy`。
                        tray::destroy(app);
                    }
                }
                #[cfg(not(desktop))]
                let _ = (api, code);
            }
            tauri::RunEvent::Exit => {
                // 兜底：任何走到 Exit 的退出路径都确保托盘已清理（幂等）
                #[cfg(desktop)]
                {
                    tray::destroy(app);
                    // COM 类对象显式撤销（进程退出本来也会清，这里让「注册/撤销」对称）
                    tray::toast_activator::shutdown();
                }
                // 退出前把 WAL 截断回零（实测 `-wal` 长期停在 99 MB 以上，比库碎片大得多）。
                // 幂等；拿不到连接锁就跳过，**绝不等待、绝不拖住退出**。
                if let Some(m) = app.try_state::<std::sync::Arc<virlen_core::session_db::DbMaintenance>>() {
                    let _ = m.try_checkpoint_truncate();
                }
                telemetry::on_exit();
            }
            // macOS 专属：点 Dock 图标 / 重新打开 app 时把窗口捞回来
            // （关到托盘后窗口是隐藏的，不处理这个事件用户会觉得「点了没反应」）
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => tray::activate_main_window(app, "reopen"),
            _ => {}
        });
}
