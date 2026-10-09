//! RAG 知识库的 **Tauri 命令层**（GUI 壳）
//!
//! 知识库实现（向量索引 / 分块 / 检索 / 归档）全在 `virlen-core::rag`（零 `tauri::`）。
//! 本文件把「宿主数据目录」翻译成 core 的入参：
//!
//! ```text
//! GUI：TauriHost::data_dir() ─┐
//! CLI：CliHost::data_dir()    ├─→ virlen_core::rag::init_service(app_data_dir)
//! ```
//!
//! 与重构前的唯一行为差异：数据目录取自 `HostEnv`（而非 `app.path().app_data_dir()`），
//! 取不到时的回退同样是 `.`（见 `TauriHost::data_dir`）。
//!
//! 另一件事，也在这里：**记忆详情正文的护栏**（删 / 改之前先看它是不是某条记忆的正文）。
//! 它要同时知道「知识库」与「记忆」两个域，而只有壳层同时持有两边的仓储 —— 见
//! `memory_linked_docs` / `ensure_not_memory_detail`。

use std::collections::HashMap;
use std::path::PathBuf;
use tauri::AppHandle;

use virlen_core::agent::memory::detail_docs_in_kb;
use virlen_core::host::HostEnv;
use virlen_core::rag::import_scan::FolderScan;
use virlen_core::rag::rag_service::RagService;
use virlen_core::rag::vector_store::ZipPreview;
use virlen_core::session_db::MemoryRepo;

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

// ===== 记忆详情正文的底线保护 =====
//
// 记忆条目只存摘要 + 一条指向「记忆详情」知识库的 link（`detail_kb_id` + `detail_doc_id`）。
// 库本身删不掉（`vector_store::delete_knowledge_base` 拦），但**库里的文档**原本谁都能删 ——
// 在知识库页删掉一份详情正文 = 静默丢掉那条记忆的正文（只剩摘要），而且删完看不出异常。
//
// 为什么放在命令层：这条规则要同时知道「知识库」和「记忆」两个域，只有壳层同时持有两边。
// 为什么按**引用**（而不是「builtin 库一律不许删文档」）：
// - 默认知识库也是 builtin，用户自己往里放的文档当然该能删；
// - `cmd_memory_delete` 把详情正文一起清掉，失败时留下的**孤儿**正文还得能让用户手动清理
//   （见那里的注释）—— 只有「还被回忆引用着」才算碰不得。

/// 该库里「被某条记忆引用着」的文档：`doc_id` → 记忆 id
///
/// 判定口径（哪两半算有效链接）住在记忆域（`agent::memory::detail_docs_in_kb`）——
/// 这里只负责把仓储里的记录取出来。
async fn memory_linked_docs(
    memory: &std::sync::Arc<dyn MemoryRepo>,
    kb_id: &str,
) -> Result<HashMap<String, String>, String> {
    let records = memory.list(None, true).await?;
    Ok(detail_docs_in_kb(&records, kb_id))
}

/// 拦下「动到记忆详情正文」的写操作（删 / 改）。不是详情 → `Ok(())`。
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
/// `doc_name` 可选：从文件夹导入时前端会传**相对路径**（`子目录/手册.pdf`），
/// 这样同一棵目录树里的同名文件不会撞在一起；不传就是文件的基础名（单个文件导入）。
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
///
/// ⚠️ 记忆详情正文不给删（见 [`ensure_not_memory_detail`]）。AI 工具
/// `delete_knowledge_base_document` 也走这个命令，所以这一道同时也是给 AI 的约束。
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

/// 列出知识库中的文档
///
/// 除核心的文档信息外，额外给每份文档带上 `memory_detail_of`（引用它的记忆 id，没有则 null）——
/// 让界面能把「删除」换成一句说明，而不是等用户点了才报错（后端那道栏是兜底，见
/// [`ensure_not_memory_detail`]）。
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
/// `doc_name` 可选：文件夹导入覆盖同名 PDF 时，前端把相对路径传进来，免得覆盖一次就丢了目录信息。
/// ⚠️ 记忆详情正文不给改（改了那条记忆的正文就换了人）—— 同 `remove_document_from_knowledge_base`。
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

/// 编辑知识库中的文本文档 — 用新内容替换
///
/// 界面上的「编辑文档」、文件/文件夹导入的同名覆盖都走这里（替换是「先删旧块再写新块」，
/// 中途失败不会把原来那份弄丢）。
/// ⚠️ 记忆详情正文不给改（见 [`ensure_not_memory_detail`]）。
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

/// 改知识库的名称 / 说明（两个参数都可缺省：`None` = 不动这一项）
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

/// 列出压缩包里的文档名（不解压）—— 导入前告诉用户「会进来什么 / 会被 .gitignore 排除多少」
///
/// 包内自带的 .gitignore 也在这里生效（用户拿自己打的项目包来导入时用得上），与文件夹扫描同一套规则。
#[tauri::command]
pub async fn preview_knowledge_base_zip(zip_path: String) -> Result<ZipPreview, String> {
    tokio::task::spawn_blocking(move || RagService::zip_entry_names(&zip_path))
        .await
        .map_err(|e| format!("任务执行失败: {}", e))?
}

/// 读压缩包里一个条目的正文（逐条导入的一条 = 一次这个调用）
///
/// 为什么拆成一条一条：整包一次性导入时，界面既看不到进度也没法取消；逐条读 + 逐条写库
///（用现成的 `write_text_in_knowledge_base` / `edit_text_in_knowledge_base`）就两件都有了，
/// 而且顺带继承了那两条命令上的**记忆详情正文护栏**（比从前「整批拒绍」更细：只挡住那一条）。
#[tauri::command]
pub async fn read_knowledge_base_zip_entry(
    zip_path: String,
    entry_name: String,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || RagService::read_zip_entry(&zip_path, &entry_name))
        .await
        .map_err(|e| format!("任务执行失败: {}", e))?
}

/// 扫描文件夹：按 `.gitignore` 过滤后列出可导入的文档（纯函数，不与任何库关联）
#[tauri::command]
pub async fn scan_import_folder(dir_path: String) -> Result<FolderScan, String> {
    tokio::task::spawn_blocking(move || RagService::scan_import_folder(&dir_path))
        .await
        .map_err(|e| format!("任务执行失败: {}", e))?
}
