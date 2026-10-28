use std::fs;
use tauri::Manager;

mod browser_view;
mod clipboard_files;
/// 全部 `#[tauri::command]`；业务语义在 `virlen-core`
mod commands;
#[cfg(target_os = "windows")]
mod drag_drop;
mod common_service;
mod deepseek_tokenizer;
/// GUI 宿主实现；`HostEnv` 与 `CliHost` 在 `virlen-core::host`
mod host;
mod load_env;
mod vision_service;
mod speech_service;
mod task_manager;
/// GUI 侧埋点出口；其余在 `virlen-core::telemetry`
mod telemetry;
#[cfg(desktop)]
mod tray;

/// 移到系统回收站
#[tauri::command]
async fn move_to_trash(path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        trash::delete(&path).map_err(|e| format!("移动到回收站失败: {}", e))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// 沙盒诊断：Windows 返回状态目录 / 能力 SID / 环境变量覆盖。
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
// Tauri 命令参数逐个从 JS 传，收结构体会要求前端改调用形状
#[allow(clippy::too_many_arguments)]
async fn search_files_by_name(
    root: String,
    query: String,
    use_regex: bool,
    max_results: usize,
    task_id: String,
    // include_hidden / skip_dir_names 控制遍历范围；keep_dirs 是已展开的忽略目录（例外）
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

/// 停止任务；返回是否找到了该任务
#[tauri::command]
fn stop_task(task_id: String) -> bool {
    task_manager::stop(&task_id)
}

/// 强制杀进程树：Windows 用 Job Object / Toolhelp32，Linux·macOS 递归 ps，均不依赖进程组。
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

/// 探测路径是否存在 / 是文件 / 多大（先探测再读，避免整个读进内存才发现该拒）。
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
            // 不存在是正常结果，不是错误
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

/// 检查是否为有效目录
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
    // 单实例插件必须第一个注册，第二个实例才能在建资源前退出。dev 下不启用（允许并存），
    // 判 dev 用 `tauri::is_dev()`（本包没声明 custom-protocol feature）。
    let mut builder = tauri::Builder::default();
    if !tauri::is_dev() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // 点击通知时系统按 CLSID 拉起新进程，会被本插件拦下；必须接住 `-ToastActivated`，
            // 否则「点通知」退化成「只是聚焦窗口」。
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

    builder = builder.register_asynchronous_uri_scheme_protocol(
        commands::preview::SCHEME,
        commands::preview::handle_uri_request,
    );

    // 图片附件协议：库里存 `attachment://<hash>.<ext>`，`<img>` 靠这个 scheme 取字节
    // （见 `virlen_core::attachment` 与 `commands/attachment.rs`）
    builder = builder.register_asynchronous_uri_scheme_protocol(
        commands::attachment::SCHEME,
        commands::attachment::handle_uri_request,
    );

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

            // 视觉模型按需懒加载，启动期无需初始化

            // 托盘：关闭窗口改为隐藏，托盘菜单提供真正的退出入口
            #[cfg(desktop)]
            {
                app.manage(tray::TrayState::default());
                // Windows：把进程声明成与开始菜单快捷方式相同的 AUMID（通知归属与点击激活）
                tray::notify::init_app_identity(app.handle());
                // 注册 toast 点击的 COM 激活器；放在托盘之前 —— 被通知拉起的进程有超时限制
                tray::toast_activator::init(app.handle());
                if let Err(e) = tray::init(app.handle()) {
                    // 托盘不可用 → decide_close 回退成「关闭即退出」，不会出现隐藏后无托盘的死局
                    eprintln!("[tray] 托盘初始化失败，关闭窗口将直接退出: {}", e);
                }
            }

            // Windows：把拖放换成自定义 OLE 目标（比 wry 多认 VS Code 的拖拽格式）
            #[cfg(target_os = "windows")]
            drag_drop::init(app.handle());

            // 预热 DeepSeek tokenizer（后台线程解析，不阻塞启动；失败静默）
            deepseek_tokenizer::prewarm(app.handle());

            // macOS: visible=false 会阻止 WKWebView 加载 JS，故不做白屏优化
            #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                // 刷新托盘，否则 tooltip 停在「已隐藏到托盘」直到下一次事件
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
        // 系统通知：完成提醒的优先通道
        .plugin(tauri_plugin_notification::init())
        // 「关闭 ≠ 退出」在此收口
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
            // 文档解析（与原生工具 `parse_document` 同一条组装链）
            commands::document::cmd_parse_document,
            // 右侧文件面板的文档预览（Office 六种：xlsx/xls → 网格，docx/doc/pptx/ppt → Markdown）
            commands::document::cmd_preview_document,
            stat_path,
            // HTML 预览的本地资源协议（token 登记 / 撤销）
            commands::preview::preview_allow_root,
            commands::preview::preview_revoke_root,
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
            // 图片预览用：只做 OCR（不做视觉识别），结果按内容指纹缓存
            vision_service::vision_ocr,
            vision_service::vision_ocr_base64,
            // RAG 知识库
            commands::rag::create_knowledge_base,
            commands::rag::list_knowledge_bases,
            commands::rag::update_knowledge_base,
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
            commands::rag::preview_knowledge_base_zip,
            commands::rag::read_knowledge_base_zip_entry,
            commands::rag::scan_import_folder,
            // Agent 引擎（Rust 聊天循环）
            commands::agent::agent_send_message,
            commands::agent::agent_cancel,
            commands::agent::agent_kill_command,
            // PTY 会话交互
            commands::agent::pty_write,
            commands::agent::pty_resize,
            commands::agent::pty_key,
            commands::agent::pty_set_held,
            // TS 引擎路径的原生执行（沙盒 + ConPTY）
            commands::agent::pty_run_command,
            commands::agent::agent_get_run_snapshot,
            commands::agent::agent_clear_run_snapshot,
            commands::agent::agent_dispose,
            // 工具定义 / 提示词 / 供应商目录（前端经此取 core 的唯一真源）
            commands::agent::cmd_list_tool_definitions,
            commands::agent::cmd_agent_prompts,
            commands::agent::cmd_provider_catalog,
            // 上下文压缩 / 标题生成（与 CLI 共用 core）
            commands::agent::cmd_compress_context,
            commands::agent::cmd_generate_title,
            commands::agent::agent_tool_response,
            commands::agent::agent_user_interaction_response,
            commands::agent::agent_round_boundary_response,
            commands::agent::agent_provider_stream_event,
            commands::agent::agent_provider_stream_done,
            // 会话持久化（SQLite 直落）
            commands::session_db::cmd_list_sessions,
            commands::session_db::cmd_get_session,
            commands::session_db::cmd_get_messages,
            commands::session_db::cmd_repair_session_tail,
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
            // 应用设置
            commands::session_db::cmd_settings_get_all,
            commands::session_db::cmd_settings_upsert,
            commands::session_db::cmd_settings_import,
            // MCP（外部工具服务器）：列表 / 增删改 / 启停 / 重连 / 定义 / 状态 / 测试 / 导入
            commands::mcp::cmd_mcp_list,
            commands::mcp::cmd_mcp_upsert,
            commands::mcp::cmd_mcp_remove,
            commands::mcp::cmd_mcp_set_enabled,
            commands::mcp::cmd_mcp_reload,
            commands::mcp::cmd_mcp_tool_definitions,
            commands::mcp::cmd_mcp_status,
            commands::mcp::cmd_mcp_test,
            commands::mcp::cmd_mcp_import,
            commands::mcp::cmd_mcp_instructions,
            // 长期记忆：面板 CRUD + 建会话注入段
            commands::memory::cmd_memory_list,
            commands::memory::cmd_memory_upsert,
            commands::memory::cmd_memory_delete,
            commands::memory::cmd_memory_set_level,
            commands::memory::cmd_memory_set_disabled,
            commands::memory::cmd_memory_prompt_section,
            commands::memory::cmd_memory_touch,
            commands::memory::cmd_memory_limits,
            // 长期记忆：`memory_*` 工具的 GUI 孪生
            commands::memory::cmd_memory_search,
            commands::memory::cmd_memory_recall,
            commands::memory::cmd_memory_write,
            // 长期记忆导出（Rust 只给文本，写文件由前端做）
            commands::memory::cmd_memory_export,
            // 长期记忆再蒸馏
            commands::memory::cmd_memory_redistill,
            commands::memory::cmd_memory_redistill_runs,
            // 后台服务面板
            commands::service::cmd_list_background_services,
            commands::service::cmd_kill_background_service,
            // 全局面板（跨会话）
            commands::service::cmd_list_all_background_services,
            // 后台服务终端
            commands::service::cmd_service_console_read,
            commands::service::cmd_service_console_write,
            commands::service::cmd_service_console_resize,
            // 后台服务结束通知：前端上屏 + 落库后的回执（ack 才出队）
            commands::service::cmd_ack_service_notice,
            // 用户自己的交互终端（右侧面板「新建终端」；**默认脱壳**，只服务界面）
            commands::terminal::cmd_terminal_start,
            // 四种 shell（cmd / powershell / pwsh / git bash）的「装没装」探测
            commands::terminal::cmd_terminal_shells,
            commands::terminal::cmd_terminal_read,
            commands::terminal::cmd_terminal_write,
            commands::terminal::cmd_terminal_resize,
            commands::terminal::cmd_terminal_kill,
            commands::terminal::cmd_terminal_list,
            // 源代码管理（语义在 `virlen-core::git`，全程 git 子进程）
            commands::git::git_repo_info,
            commands::git::git_status,
            commands::git::git_branches,
            commands::git::git_log,
            commands::git::git_diff_sides,
            commands::git::git_commit_detail,
            commands::git::git_commit_file_sides,
            commands::git::git_check_ref_format,
            commands::git::git_merge_state,
            commands::git::git_pick_state,
            commands::git::git_remotes,
            commands::git::git_remote_test,
            commands::git::git_numstat,
            // 写操作（过只读沙盒门禁，fail-closed）
            commands::git::git_stage,
            commands::git::git_unstage,
            commands::git::git_discard,
            commands::git::git_commit,
            commands::git::git_commit_amend,
            commands::git::git_commit_undo_last,
            commands::git::git_branch_switch,
            commands::git::git_branch_delete,
            commands::git::git_branch_rename,
            commands::git::git_merge,
            commands::git::git_merge_abort,
            commands::git::git_commit_reset_soft,
            commands::git::git_reset_preview,
            commands::git::git_pick,
            commands::git::git_pick_abort,
            commands::git::git_pick_resume,
            commands::git::git_init,
            // 远程（凭据走 SSH）
            commands::git::git_fetch,
            commands::git::git_pull,
            commands::git::git_push,
            // 贮藏（stash）
            commands::git::git_stash_list,
            commands::git::git_stash_push,
            commands::git::git_stash_apply,
            commands::git::git_stash_drop,
            commands::git::git_stash_restore,
            // 用量账本（token 统计）
            commands::session_db::cmd_append_usage,
            commands::session_db::cmd_usage_stats,
            commands::session_db::cmd_usage_query,
            commands::session_db::cmd_usage_clear,
            // 库维护（体积快照 / 截断 WAL / 重建）
            commands::session_db::cmd_db_stats,
            commands::session_db::cmd_db_checkpoint,
            commands::session_db::cmd_db_maintain,
            // 无引用的图片附件回收（P0-1 的回收侧）
            commands::session_db::cmd_attachments_gc,
            // DeepSeek tokenizer（token 计数）
            deepseek_tokenizer::cmd_count_tokens,
            // 埋点：前端就绪后拉取落盘的历史 panic
            telemetry::telemetry_drain_panics,
            // 托盘命令（新增命令必须在此注册，否则 invoke 静默 404）
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
            // 手机控制：配对表 / 设备身份持久化
            commands::phone_pairing::cmd_phone_pairing_load,
            commands::phone_pairing::cmd_phone_pairing_save,
            commands::phone_device::cmd_phone_identity_load,
            commands::phone_device::cmd_phone_identity_save,
            // 手机控制：审计落盘（append-only JSONL）
            commands::phone_audit::cmd_phone_audit_append,
            commands::phone_audit::cmd_phone_audit_list,
            commands::phone_audit::cmd_phone_audit_clear,
            // 右侧栏「网页」标签：同一窗口里的原生子 WebView（X-Frame-Options 对 iframe 是硬限制，
            // 对独立浏览上下文不适用 —— 见 `browser_view.rs` 文件头）
            browser_view::browser_view_open,
            browser_view::browser_view_apply,
            browser_view::browser_view_navigate,
            browser_view::browser_view_reload,
            browser_view::browser_view_history,
            browser_view::browser_view_current_url,
            browser_view::browser_view_close,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            tauri::RunEvent::ExitRequested { api, code, .. } => {
                // 只拦「所有窗口已关闭」的默认退出（code = None）；托盘退出 / 关机一律放行
                #[cfg(desktop)]
                {
                    if tray::should_prevent_exit(app, code) {
                        api.prevent_exit();
                    } else {
                        // 退出前销毁托盘图标
                        tray::destroy(app);
                    }
                }
                #[cfg(not(desktop))]
                let _ = (api, code);
            }
            tauri::RunEvent::Exit => {
                // 兜底：任何走到 Exit 的路径都确保托盘已清理（幂等）
                #[cfg(desktop)]
                {
                    tray::destroy(app);
                    // COM 类对象显式撤销，让「注册 / 撤销」对称
                    tray::toast_activator::shutdown();
                }
                // 后台服务不跨应用生命周期存活：不能只靠 Job 的 KILL_ON_JOB_CLOSE（那是崩溃兜底），
                // 正常退出要把进程树收干净，否则它们会带着断掉的管道继续跑。
                let stopped = virlen_core::agent::native_tools::kill_all_services();
                if stopped > 0 {
                    telemetry::track(
                        "tool.service.exit_cleanup",
                        serde_json::json!({ "count": stopped }),
                    );
                }
                // 用户终端同理（与 Job 的 KILL_ON_JOB_CLOSE 双保险：正常退出要把进程树收干净）
                let shells = virlen_core::agent::native_tools::kill_all_shells();
                if shells > 0 {
                    telemetry::track(
                        "terminal.exit_cleanup",
                        serde_json::json!({ "count": shells }),
                    );
                }
                // 再蒸馏任务不能跨进程存活
                virlen_core::agent::memory::redistill::sched::shutdown();
                // MCP：发出关闭指令（stdio 子进程另有 Job 的 KILL_ON_JOB_CLOSE 兜底）
                virlen_core::mcp::host().shutdown_all();
                // 退出前把 WAL 截断回零（幂等；拿不到锁就跳过，绝不拖住退出）
                if let Some(m) = app.try_state::<std::sync::Arc<virlen_core::session_db::DbMaintenance>>() {
                    let _ = m.try_checkpoint_truncate();
                }
                telemetry::on_exit();
            }
            // macOS：点 Dock 图标时把窗口捞回来（关到托盘后窗口是隐藏的）
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => tray::activate_main_window(app, "reopen"),
            _ => {}
        });
}
