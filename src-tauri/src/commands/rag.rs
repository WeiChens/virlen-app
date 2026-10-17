//! RAG 知识库的 Tauri 命令层（GUI 壳）：实现全在 virlen-core::rag，这里只把宿主数据目录翻译成入参，
//! 并提供「记忆详情正文」护栏（删 / 改前确认它不是某条记忆的正文，需同时知道知识库与记忆两个域）。

use std::collections::HashMap;
use std::path::PathBuf;
use tauri::AppHandle;

use virlen_core::agent::memory::detail_docs_in_kb;
use virlen_core::host::HostEnv;
use virlen_core::rag::import_scan::FolderScan;
use virlen_core::rag::rag_service::RagService;
use virlen_core::rag::vector_store::ZipPreview;
use virlen_core::session_db::MemoryRepo;

/// 宿主数据目录（GUI：Tauri app_data_dir()）
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

// ===== 记忆详情正文的底线保护 =====
// 记忆条目只存摘要 + 一条指向「记忆详情」知识库的 link。库删不掉，但库里的文档原本谁都能删 ——
// 删掉一份详情正文 = 静默丢掉那条记忆的正文。按**引用**判定而不是「builtin 库一律不许删」：
// 默认库也是 builtin，用户自己放的文档当然能删；只有「还被记忆引用着」才算碰不得。

/// 该库里被某条记忆引用着的文档：doc_id → 记忆 id（判定口径在 agent::memory::detail_docs_in_kb）。
async fn memory_linked_docs(
    memory: &std::sync::Arc<dyn MemoryRepo>,
    kb_id: &str,
) -> Result<HashMap<String, String>, String> {
    let records = memory.list(None, true).await?;
    Ok(detail_docs_in_kb(&records, kb_id))
}

/// 拦下「动到记忆详情正文」的写操作（删 / 改）。不是详情 → Ok(())。
async fn ensure_not_memory_detail(
    memory: &std::sync::Arc<dyn MemoryRepo>,
    kb_id: &str,
    doc_id: &str,
) -> Result<(), String> {
    let linked = memory_linked_docs(memory, kb_id).await?;
    match linked.get(doc_id) {
        None => Ok(()),
        Some(memory_id) => Err(format!(
            "这份文档是记忆「{}」的详情正文，不能单独删改（否则那条记忆只剩摘要）。\n先删掉那条记忆，正文会一起清掉。",
            memory_id
        )),
    }
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
///
/// doc_name 可选：文件夹导入时传相对路径，避免同名文件撞车；不传则用基础名。
#[tauri::command]
pub async fn add_document_to_knowledge_base(
    app: AppHandle,
    kb_id: String,
    file_path: String,
    doc_name: Option<String>,
) -> Result<serde_json::Value, String> {
    let service = service_for(&app)?;
    let kb_id = kb_id.clone();
    let file_path = file_path.clone();

    let doc_info = tokio::task::spawn_blocking(move || {
        service.add_document_named(&kb_id, &file_path, doc_name.as_deref())
    })
    .await
    .map_err(|e| format!("任务执行失败: {}", e))??;

    serde_json::to_value(doc_info).map_err(|e| format!("序列化失败: {}", e))
}

/// 没有任何知识库时自动建一个默认库；返回其 ID。
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

/// 取文档完整内容（所有 chunk 按序拼接）。
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
///
/// ⚠️ 记忆详情正文不给删；AI 工具 delete_knowledge_base_document 也走这里。
#[tauri::command]
pub async fn remove_document_from_knowledge_base(
    app: AppHandle,
    memory: tauri::State<'_, std::sync::Arc<dyn MemoryRepo>>,
    kb_id: String,
    doc_id: String,
) -> Result<(), String> {
    let service = service_for(&app)?;
    ensure_not_memory_detail(memory.inner(), &kb_id, &doc_id).await?;
    let kb_id = kb_id.clone();
    let doc_id = doc_id.clone();

    tokio::task::spawn_blocking(move || {
        service.remove_document(&kb_id, &doc_id)
    })
    .await
    .map_err(|e| format!("任务执行失败: {}", e))?
}

/// 列出文档，并给每份带上 `memory_detail_of`（引用它的记忆 id）—— 让界面能提前把「删除」换成说明。
#[tauri::command]
pub async fn list_knowledge_base_documents(
    app: AppHandle,
    memory: tauri::State<'_, std::sync::Arc<dyn MemoryRepo>>,
    kb_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    let service = service_for(&app)?;
    let kb_id = kb_id.clone();

    let linked = memory_linked_docs(memory.inner(), &kb_id).await?;
    let docs = tokio::task::spawn_blocking(move || {
        service.list_documents(&kb_id)
    })
    .await
    .map_err(|e| format!("任务执行失败: {}", e))??;

    let result: Vec<serde_json::Value> = docs
        .into_iter()
        .map(|d| {
            let mut value = serde_json::to_value(&d).unwrap_or_default();
            if let Some(obj) = value.as_object_mut() {
                obj.insert(
                    "memory_detail_of".to_string(),
                    match linked.get(&d.id) {
                        Some(memory_id) => serde_json::Value::String(memory_id.clone()),
                        None => serde_json::Value::Null,
                    },
                );
            }
            value
        })
        .collect();
    Ok(result)
}

/// 检索知识库（同时返回格式化上下文）
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

/// 模糊搜索文档内容（在全部 chunk 里匹配关键词，返回文档 ID 列表）
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

/// 将文本内容写入知识库（AI 可直接调用，无需文件路径）
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

/// 用新文件替换已有文档（自动重新分块与嵌入）。
/// doc_name 可选：文件夹导入覆盖同名 PDF 时传相对路径。⚠️ 记忆详情正文不给改。
#[tauri::command]
pub async fn edit_document_in_knowledge_base(
    app: AppHandle,
    memory: tauri::State<'_, std::sync::Arc<dyn MemoryRepo>>,
    kb_id: String,
    doc_id: String,
    file_path: String,
    doc_name: Option<String>,
) -> Result<serde_json::Value, String> {
    let service = service_for(&app)?;
    ensure_not_memory_detail(memory.inner(), &kb_id, &doc_id).await?;
    let kb_id = kb_id.clone();
    let doc_id = doc_id.clone();
    let file_path = file_path.clone();

    let doc_info = tokio::task::spawn_blocking(move || {
        service.edit_document_named(&kb_id, &doc_id, &file_path, doc_name.as_deref())
    })
    .await
    .map_err(|e| format!("任务执行失败: {}", e))??;

    serde_json::to_value(doc_info).map_err(|e| format!("序列化失败: {}", e))
}

/// 用新内容替换文本文档（「编辑文档」与导入同名覆盖都走这里；替换是中途失败不丢原内容）。
/// ⚠️ 记忆详情正文不给改。
#[tauri::command]
pub async fn edit_text_in_knowledge_base(
    app: AppHandle,
    memory: tauri::State<'_, std::sync::Arc<dyn MemoryRepo>>,
    kb_id: String,
    doc_id: String,
    doc_name: String,
    content: String,
) -> Result<serde_json::Value, String> {
    let service = service_for(&app)?;
    ensure_not_memory_detail(memory.inner(), &kb_id, &doc_id).await?;
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

/// 改知识库名称 / 说明（参数为 None 则不动该项）
#[tauri::command]
pub async fn update_knowledge_base(
    app: AppHandle,
    kb_id: String,
    name: Option<String>,
    description: Option<String>,
) -> Result<serde_json::Value, String> {
    let service = service_for(&app)?;
    let kb_id = kb_id.clone();

    let kb = tokio::task::spawn_blocking(move || {
        service.update_knowledge_base(&kb_id, name.as_deref(), description.as_deref())
    })
    .await
    .map_err(|e| format!("任务执行失败: {}", e))??;

    serde_json::to_value(kb).map_err(|e| format!("序列化失败: {}", e))
}

/// 列出压缩包里的文档名（不解压），导入前告诉用户会进来什么。包内 .gitignore 也生效。
#[tauri::command]
pub async fn preview_knowledge_base_zip(zip_path: String) -> Result<ZipPreview, String> {
    tokio::task::spawn_blocking(move || RagService::zip_entry_names(&zip_path))
        .await
        .map_err(|e| format!("任务执行失败: {}", e))?
}

/// 读压缩包里一个条目的正文（逐条导入 = 一次调用）。
/// 不整包一次导入：逐条才能有进度与取消，且顺带继承写库命令上的记忆详情护栏。
#[tauri::command]
pub async fn read_knowledge_base_zip_entry(
    zip_path: String,
    entry_name: String,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || RagService::read_zip_entry(&zip_path, &entry_name))
        .await
        .map_err(|e| format!("任务执行失败: {}", e))?
}

/// 按 .gitignore 过滤后列出可导入的文档（纯函数，不与任何库关联）
#[tauri::command]
pub async fn scan_import_folder(dir_path: String) -> Result<FolderScan, String> {
    tokio::task::spawn_blocking(move || RagService::scan_import_folder(&dir_path))
        .await
        .map_err(|e| format!("任务执行失败: {}", e))?
}
