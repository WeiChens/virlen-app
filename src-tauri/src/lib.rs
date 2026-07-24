use std::fs;
#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
use tauri::Manager;

mod common_service;
mod file_ops;
mod load_env;
mod rag;
mod vision_service;
mod search;
mod task_manager;

/// 将文件或目录移动到系统回收站（跨平台）
#[tauri::command]
async fn move_to_trash(path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        trash::delete(&path).map_err(|e| format!("移动到回收站失败: {}", e))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
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
) -> Result<Vec<search::FileSearchResult>, String> {
    let cancel_flag = task_manager::register(&task_id);
    let root_c = root.clone();
    let query_c = query.clone();

    let task = tokio::task::spawn_blocking(move || {
        search::search_files_by_name(&root_c, &query_c, use_regex, max_results, &cancel_flag)
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
/// - Windows: taskkill /F /T (带 CREATE_NO_WINDOW，防止弹黑窗口)
/// - Linux/macOS: kill 负 PGID
#[tauri::command]
async fn kill_process_tree(pid: u32) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        #[cfg(target_os = "windows")]
        {
            // 引入 CommandExt 以使用 creation_flags 隐藏控制台窗口
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;

            let _ = std::process::Command::new("taskkill")
                .args(["/F", "/T", "/PID", &pid.to_string()])
                .creation_flags(CREATE_NO_WINDOW)
                .status();
        }

        #[cfg(not(target_os = "windows"))]
        {
            // 负 PID = 发送信号到整个进程组
            let _ = std::process::Command::new("kill")
                .args(["--", &format!("-{}", pid)])
                .status();
            // 也补一个 pkill 杀子进程（某些 shell 可能不在同一进程组）
            let _ = std::process::Command::new("pkill")
                .args(["-P", &pid.to_string()])
                .status();
        }
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?;

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
        let expanded = if path.starts_with('~') {
            let home = std::env::var("HOME")
                .or_else(|_| std::env::var("USERPROFILE"))
                .unwrap_or_default()
                .replace('\\', "/");
            path.replacen('~', &home, 1)
        } else if path.contains("%USERPROFILE%") {
            let home = std::env::var("USERPROFILE")
                .unwrap_or_default()
                .replace('\\', "/");
            path.replace("%USERPROFILE%", &home)
        } else {
            path.clone()
        };
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
async fn edit_file_in_place(
    path: String,
    old_string: String,
    new_string: String,
    expected_hash: String,
    replace_count: usize,
) -> Result<file_ops::FileEditResult, String> {
    tokio::task::spawn_blocking(move || {
        file_ops::edit_file(
            &path,
            &old_string,
            &new_string,
            &expected_hash,
            replace_count,
        )
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // 初始化 RAG 知识库服务
            if let Err(e) = rag::init_rag_service(app.handle()) {
                eprintln!("[RAG] 初始化失败: {}", e);
            } 
            // else {
            //     println!("[RAG] 知识库服务初始化成功");
            // }

            vision_service::setup_vision(app)?;

            // macOS: visible=false 会阻止 WKWebView 加载 JS，导致窗口永远无法通过 JS show()
            // 因此 macOS 上不做白屏优化，直接显示窗口
            #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
            }
            Ok(())
        })
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            os_platform,
            save_file_to_path,
            search_files_by_name,
            search_text_in_files,
            list_directory,
            stop_task,
            read_file_with_hash,
            edit_file_in_place,
            kill_process_tree,
            canonicalize_path,
            check_is_directory,
            move_to_trash,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
