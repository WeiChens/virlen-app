use std::fs;
// `Manager` 现在在所有平台都被用到（退出钩子里的 `try_state`），因此不再按 target 条件编译
use tauri::Manager;

mod agent;
mod clipboard_files;
#[cfg(target_os = "windows")]
mod drag_drop;
mod common_service;
mod deepseek_tokenizer;
mod file_ops;
mod load_env;
mod rag;
mod session_db;
mod vision_service;
mod search;
mod speech_service;
mod task_manager;
mod sandbox;
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
        serde_json::to_value(sandbox::diagnostics())
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
async fn search_files_by_name(
    root: String,
    query: String,
    use_regex: bool,
    max_results: usize,
    task_id: String,
    // 遍历范围（侧边栏搜索框用）：跳过点项 / 依赖·构建目录，
    // keep_dirs 是已展开的那份忽略目录（例外）。详见 search::search_files_by_name 注释。
    include_hidden: bool,
    skip_dir_names: Vec<String>,
    keep_dirs: Vec<String>,
) -> Result<Vec<search::FileSearchResult>, String> {
    let cancel_flag = task_manager::register(&task_id);
    let root_c = root.clone();
    let query_c = query.clone();

    let task = tokio::task::spawn_blocking(move || {
        search::search_files_by_name(
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
        .map_err(|_| format!("Search timed out after 30s"))?
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
) -> Result<Vec<search::TextSearchResult>, String> {
    let cancel_flag = task_manager::register(&task_id);
    let root_c = root.clone();
    let query_c = query.clone();

    let task = tokio::task::spawn_blocking(move || {
        search::search_text_in_files(&root_c, &query_c, max_results, &cancel_flag)
    });

    let result = tokio::time::timeout(std::time::Duration::from_secs(30), task)
        .await
        .map_err(|_| format!("Search timed out after 30s"))?
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
) -> Result<Vec<search::DirEntry>, String> {
    let cancel_flag = task_manager::register(&task_id);

    let task = tokio::task::spawn_blocking(move || {
        search::list_directory(
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
        agent::process_tree::kill_process_tree(pid);
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
async fn read_file_with_hash(path: String) -> Result<file_ops::FileReadResult, String> {
    tokio::task::spawn_blocking(move || {
        file_ops::read_file(&path)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// 规范化路径：展开 ~/%USERPROFILE% → canonicalize → 返回绝对路径
#[tauri::command]
async fn canonicalize_path(path: String) -> Option<String> {
    // 路径展开操作很快，但 canonicalize 可能涉及 I/O
    tokio::task::spawn_blocking(move || {
        let expanded = crate::sandbox::paths::expand_user_path(&path);
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
    edits: Vec<file_ops::EditEntry>,
    expected_hash: String,
) -> Result<file_ops::FileEditMultiResult, String> {
    tokio::task::spawn_blocking(move || {
        file_ops::edit_file_multi(&path, &edits, &expected_hash)
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
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // 回调里拿到的是另一个进程的 argv/cwd——本应用不做文件关联，用不上，直接聚焦窗口。
            #[cfg(desktop)]
            tray::activate_main_window(app, "second_instance");
            #[cfg(not(desktop))]
            let _ = app;
        }));
    }

    builder
        .setup(|app| {
            // 初始化 Rust 侧埋点（panic hook + 事件回传桥）
            telemetry::init(app.handle());

            // 初始化 Agent 引擎（Rust 聊天循环）
            agent::init_agent_engine(app.handle());

            // 初始化 RAG 知识库服务
            if let Err(e) = rag::init_rag_service(app.handle()) {
                eprintln!("[RAG] 初始化失败: {}", e);
            } 
            // else {
            //     println!("[RAG] 知识库服务初始化成功");
            // }

            vision_service::setup_vision(app)?;

            // 系统托盘：关闭窗口改为隐藏（AI 继续在后台跑），托盘菜单提供真正的退出入口
            #[cfg(desktop)]
            {
                app.manage(tray::TrayState::default());
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
            rag::create_knowledge_base,
            rag::list_knowledge_bases,
            rag::delete_knowledge_base,
            rag::add_document_to_knowledge_base,
            rag::remove_document_from_knowledge_base,
            rag::list_knowledge_base_documents,
            rag::query_knowledge_base,
            rag::write_text_to_knowledge_base,
            rag::edit_document_in_knowledge_base,
            rag::edit_text_in_knowledge_base,
            rag::get_knowledge_base_document,
            rag::init_knowledge_bases,
            rag::search_documents_content,
            rag::export_knowledge_base,
            // Agent 引擎（Rust 聊天循环）
            agent::agent_send_message,
            agent::agent_cancel,
            agent::agent_kill_command,
            // PTY 会话交互（Step 1：execute_command 换 ConPTY）
            agent::pty_write,
            agent::pty_resize,
            // 命名控制键（Step 2 ③）
            agent::pty_key,
            // 接管 / 交还（Step 2 ②）
            agent::pty_set_held,
            // TS 引擎路径的原生执行（沙盒 + ConPTY，§7 #14）
            agent::pty_run_command,
            agent::agent_get_run_snapshot,
            agent::agent_clear_run_snapshot,
            agent::agent_dispose,
            agent::agent_tool_response,
            agent::agent_user_interaction_response,
            agent::agent_round_boundary_response,
            agent::agent_provider_stream_event,
            agent::agent_provider_stream_done,
            // 会话持久化（SQLite 直落）
            session_db::commands::cmd_list_sessions,
            session_db::commands::cmd_get_session,
            session_db::commands::cmd_get_messages,
            session_db::commands::cmd_get_message_page,
            session_db::commands::cmd_get_message_window,
            session_db::commands::cmd_get_message_timeline,
            session_db::commands::cmd_get_user_message_refs,
            session_db::commands::cmd_search_messages,
            session_db::commands::cmd_upsert_session,
            session_db::commands::cmd_delete_session,
            session_db::commands::cmd_replace_session_messages,
            session_db::commands::cmd_append_messages,
            session_db::commands::cmd_truncate_session_messages,
            // 用量账本（token 统计）
            session_db::commands::cmd_append_usage,
            session_db::commands::cmd_usage_stats,
            session_db::commands::cmd_usage_query,
            session_db::commands::cmd_usage_clear,
            // 库维护（设置 → 存储：体积快照 / 截断 WAL / 重建数据库）
            session_db::commands::cmd_db_stats,
            session_db::commands::cmd_db_checkpoint,
            session_db::commands::cmd_db_maintain,
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
                tray::destroy(app);
                // 退出前把 WAL 截断回零（实测 `-wal` 长期停在 99 MB 以上，比库碎片大得多）。
                // 幂等；拿不到连接锁就跳过，**绝不等待、绝不拖住退出**。
                if let Some(m) = app.try_state::<std::sync::Arc<session_db::DbMaintenance>>() {
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
