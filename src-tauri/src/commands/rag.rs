//! RAG 知识库的 **Tauri 命令层**（GUI 壳）
//!
//! 知识库实现（向量索引 / 分块 / 检索）全在 `virlen-core::rag`（零 `tauri::`）。
//! 本文件只把「宿主数据目录」翻译成 core 的入参：
//!
//! ```text
//! GUI：TauriHost::data_dir() ─┐
//! CLI：CliHost::data_dir()    ├─→ virlen_core::rag::init_service(app_data_dir)
//! ```
//!
//! 与重构前的唯一行为差异：数据目录取自 `HostEnv`（而非 `app.path().app_data_dir()`），
//! 取不到时的回退同样是 `.`（见 `TauriHost::data_dir`）。

use std::path::PathBuf;
use tauri::AppHandle;

use virlen_core::host::HostEnv;
use virlen_core::rag::rag_service::RagService;

/// 宿主数据目录（GUI：Tauri `app_data_dir()`）
fn data_dir(app: &AppHandle) -> PathBuf {
    crate::host::TauriHost::new(app.clone()).data_dir()
}

/// 初始化 RAG 服务（应用启动时调用）
pub fn init_rag_service(app: &AppHandle) -> Result<(), String> {
    virlen_core::rag::init_service(data_dir(app))
}

/// 取服务；未初始化则先用当前宿主目录初始化（懒惰初始化，幂等）
fn service_for(app: &AppHandle) -> Result<&'static RagService, String> {
    virlen_core::rag::ensure_service(data_dir(app))
}

// ===== Tauri 命令 =====

/// 创建知识库
#[tauri::command]
pub async fn create_knowledge_base(
    app: AppHandle,
    name: String,
    description: Option<String>,
) -> Result<serde_json::Value, String> {
    let service = service_for(&app)?;
    let name = name.clone();
    let desc = description.clone().unwrap_or_default();

    let kb = tokio::task::spawn_blocking(move || {
        service.create_knowledge_base(&name, &desc)
    })
    .await
    .map_err(|e| format!("任务执行失败: {}", e))??;

    serde_json::to_value(kb).map_err(|e| format!("序列化失败: {}", e))
}

/// 列出所有知识库
#[tauri::command]
pub async fn list_knowledge_bases(
    app: AppHandle,
) -> Result<Vec<serde_json::Value>, String> {
    let service = service_for(&app)?;

    let kbs = tokio::task::spawn_blocking(move || {
        service.list_knowledge_bases()
    })
    .await
    .map_err(|e| format!("任务执行失败: {}", e))??;

    let result: Vec<serde_json::Value> = kbs
        .into_iter()
        .map(|kb| serde_json::to_value(kb).unwrap_or_default())
        .collect();
    Ok(result)
}

/// 删除知识库
#[tauri::command]
pub async fn delete_knowledge_base(
    app: AppHandle,
    kb_id: String,
) -> Result<(), String> {
    let service = service_for(&app)?;
    let kb_id = kb_id.clone();

    tokio::task::spawn_blocking(move || {
        service.delete_knowledge_base(&kb_id)
    })
    .await
    .map_err(|e| format!("任务执行失败: {}", e))?
}

/// 添加文档到知识库
#[tauri::command]
pub async fn add_document_to_knowledge_base(
    app: AppHandle,
    kb_id: String,
    file_path: String,
) -> Result<serde_json::Value, String> {
    let service = service_for(&app)?;
    let kb_id = kb_id.clone();
    let file_path = file_path.clone();

    let doc_info = tokio::task::spawn_blocking(move || {
        service.add_document(&kb_id, &file_path)
    })
    .await
    .map_err(|e| format!("任务执行失败: {}", e))??;

    serde_json::to_value(doc_info).map_err(|e| format!("序列化失败: {}", e))
}

/// 初始化知识库 — 如果没有任何知识库，自动创建一个默认知识库
///
/// 前端在应用启动时调用，确保至少有一个知识库可用。
/// 返回默认知识库的 ID。
#[tauri::command]
pub async fn init_knowledge_bases(
    app: AppHandle,
) -> Result<String, String> {
    let service = service_for(&app)?;

    tokio::task::spawn_blocking(move || {
        service.init_default_knowledge_base()
    })
    .await
    .map_err(|e| format!("任务执行失败: {}", e))?
}

/// 获取知识库中某个文档的完整内容
///
/// 返回文档所有 chunk 按顺序拼接的完整文本。
#[tauri::command]
pub async fn get_knowledge_base_document(
    app: AppHandle,
    kb_id: String,
    doc_id: String,
) -> Result<String, String> {
    let service = service_for(&app)?;
    let kb_id = kb_id.clone();
    let doc_id = doc_id.clone();

    tokio::task::spawn_blocking(move || {
        service.get_document_content(&kb_id, &doc_id)
    })
    .await
    .map_err(|e| format!("任务执行失败: {}", e))?
}

/// 从知识库删除文档
#[tauri::command]
pub async fn remove_document_from_knowledge_base(
    app: AppHandle,
    kb_id: String,
    doc_id: String,
) -> Result<(), String> {
    let service = service_for(&app)?;
    let kb_id = kb_id.clone();
    let doc_id = doc_id.clone();

    tokio::task::spawn_blocking(move || {
        service.remove_document(&kb_id, &doc_id)
    })
    .await
    .map_err(|e| format!("任务执行失败: {}", e))?
}

/// 列出知识库中的文档
#[tauri::command]
pub async fn list_knowledge_base_documents(
    app: AppHandle,
    kb_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    let service = service_for(&app)?;
    let kb_id = kb_id.clone();

    let docs = tokio::task::spawn_blocking(move || {
        service.list_documents(&kb_id)
    })
    .await
    .map_err(|e| format!("任务执行失败: {}", e))??;

    let result: Vec<serde_json::Value> = docs
        .into_iter()
        .map(|d| serde_json::to_value(d).unwrap_or_default())
        .collect();
    Ok(result)
}

/// 检索知识库
#[tauri::command]
pub async fn query_knowledge_base(
    app: AppHandle,
    kb_id: String,
    query: String,
    top_k: Option<usize>,
) -> Result<serde_json::Value, String> {
    let service = service_for(&app)?;
    let kb_id = kb_id.clone();
    let query = query.clone();
    let top_k = top_k.unwrap_or(5);

    let results = tokio::task::spawn_blocking(move || {
        service.query(&kb_id, &query, top_k)
    })
    .await
    .map_err(|e| format!("任务执行失败: {}", e))??;

    // 同时返回格式化上下文
    let context = RagService::format_context(&results, 8000);

    let response = serde_json::json!({
        "results": results,
        "context": context,
    });

    Ok(response)
}

/// 模糊搜索文档内容 — 在知识库所有 chunk 中匹配关键词，返回匹配的文档 ID 列表
#[tauri::command]
pub async fn search_documents_content(
    app: AppHandle,
    kb_id: String,
    keyword: String,
) -> Result<Vec<String>, String> {
    let service = service_for(&app)?;
    let kb_id = kb_id.clone();
    let keyword = keyword.clone();

    tokio::task::spawn_blocking(move || {
        service.search_documents_content(&kb_id, &keyword)
    })
    .await
    .map_err(|e| format!("任务执行失败: {}", e))?
}

/// 导出知识库为 ZIP 文件
#[tauri::command]
pub async fn export_knowledge_base(
    app: AppHandle,
    kb_id: String,
    output_path: String,
) -> Result<(), String> {
    let service = service_for(&app)?;
    let kb_id = kb_id.clone();
    let output_path = output_path.clone();

    tokio::task::spawn_blocking(move || {
        service.export_to_zip(&kb_id, &output_path)
    })
    .await
    .map_err(|e| format!("任务执行失败: {}", e))?
}

/// 将文本内容写入知识库（AI Tool 直接调用）
///
/// 不需要文件路径，AI 可以直接将生成的文本内容保存到知识库。
#[tauri::command]
pub async fn write_text_to_knowledge_base(
    app: AppHandle,
    kb_id: String,
    doc_name: String,
    content: String,
) -> Result<serde_json::Value, String> {
    let service = service_for(&app)?;
    let kb_id = kb_id.clone();
    let doc_name = doc_name.clone();
    let content = content.clone();

    let doc_info = tokio::task::spawn_blocking(move || {
        service.add_text_document(&kb_id, &doc_name, &content)
    })
    .await
    .map_err(|e| format!("任务执行失败: {}", e))??;

    serde_json::to_value(doc_info).map_err(|e| format!("序列化失败: {}", e))
}

/// 编辑知识库中的文档 — 用新文件替换
///
/// 用户上传新文件替换已有文档，自动重新分块和嵌入。
#[tauri::command]
pub async fn edit_document_in_knowledge_base(
    app: AppHandle,
    kb_id: String,
    doc_id: String,
    file_path: String,
) -> Result<serde_json::Value, String> {
    let service = service_for(&app)?;
    let kb_id = kb_id.clone();
    let doc_id = doc_id.clone();
    let file_path = file_path.clone();

    let doc_info = tokio::task::spawn_blocking(move || {
        service.edit_document(&kb_id, &doc_id, &file_path)
    })
    .await
    .map_err(|e| format!("任务执行失败: {}", e))??;

    serde_json::to_value(doc_info).map_err(|e| format!("序列化失败: {}", e))
}

/// 编辑知识库中的文本文档 — 用新内容替换（AI Tool 直接调用）
///
/// AI 可以直接用新文本内容替换已有文档，自动重新分块和嵌入。
#[tauri::command]
pub async fn edit_text_in_knowledge_base(
    app: AppHandle,
    kb_id: String,
    doc_id: String,
    doc_name: String,
    content: String,
) -> Result<serde_json::Value, String> {
    let service = service_for(&app)?;
    let kb_id = kb_id.clone();
    let doc_id = doc_id.clone();
    let doc_name = doc_name.clone();
    let content = content.clone();

    let doc_info = tokio::task::spawn_blocking(move || {
        service.edit_text_document(&kb_id, &doc_id, &doc_name, &content)
    })
    .await
    .map_err(|e| format!("任务执行失败: {}", e))??;

    serde_json::to_value(doc_info).map_err(|e| format!("序列化失败: {}", e))
}
