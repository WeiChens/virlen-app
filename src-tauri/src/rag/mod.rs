//! RAG 知识库模块
//!
//! 提供基于本地文件存储的 RAG 知识库功能：
//! - 知识库的创建、删除、列表
//! - 文档的添加、删除、列表
//! - 语义检索（向量相似度搜索）

pub mod document;
pub mod embedding;
pub mod rag_service;
pub mod vector_store;

use crate::rag::embedding::{EmbeddingProvider, NgramEmbeddingProvider, OpenAIEmbeddingProvider};
use crate::rag::rag_service::RagService;
use once_cell::sync::OnceCell;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::AppHandle;
use tauri::Manager;

/// 全局 RAG 服务实例
static RAG_SERVICE: OnceCell<RagService> = OnceCell::new();

/// 获取应用数据目录
fn get_app_data_dir(app: &AppHandle) -> PathBuf {
    let path = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    path.join("knowledge_base")
}

/// 初始化 RAG 服务（在应用启动时调用）
pub fn init_rag_service(app: &AppHandle) -> Result<(), String> {
    let data_dir = get_app_data_dir(app);

    // 优先使用用户配置的嵌入 API，否则使用本地 n-gram 嵌入
    let embedding_provider: Arc<dyn EmbeddingProvider> =
        if let Some(provider) = OpenAIEmbeddingProvider::from_env() {
            Arc::new(provider)
        } else {
            // 使用基于 n-gram 特征的本地嵌入
            // 无需任何外部依赖，对中英文都有较好的效果
            Arc::new(NgramEmbeddingProvider::new(512))
        };

    let service = RagService::new(data_dir, embedding_provider)?;

    RAG_SERVICE
        .set(service)
        .map_err(|_| "RAG 服务已经被初始化".to_string())
}

/// 获取 RAG 服务引用
fn get_service() -> Result<&'static RagService, String> {
    RAG_SERVICE
        .get()
        .ok_or_else(|| "RAG 服务未初始化，请重启应用".to_string())
}

// ===== Tauri 命令 =====

/// 创建知识库
#[tauri::command]
pub async fn create_knowledge_base(
    app: AppHandle,
    name: String,
    description: Option<String>,
) -> Result<serde_json::Value, String> {
    // 确保已初始化
    if RAG_SERVICE.get().is_none() {
        init_rag_service(&app)?;
    }

    let service = get_service()?;
    let name = name.clone();
    let desc = description.clone().unwrap_or_default();

    let kb = tokio::task::spawn_blocking(move || {
        service.create_knowledge_base(&name, &desc)
    })
    .await
    .map_err(|e| format!("任务执行失败: {}", e))??;

    Ok(serde_json::to_value(kb).map_err(|e| format!("序列化失败: {}", e))?)
}

/// 列出所有知识库
#[tauri::command]
pub async fn list_knowledge_bases(
    app: AppHandle,
) -> Result<Vec<serde_json::Value>, String> {
    if RAG_SERVICE.get().is_none() {
        init_rag_service(&app)?;
    }

    let service = get_service()?;

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
    if RAG_SERVICE.get().is_none() {
        init_rag_service(&app)?;
    }

    let service = get_service()?;
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
    if RAG_SERVICE.get().is_none() {
        init_rag_service(&app)?;
    }

    let service = get_service()?;
    let kb_id = kb_id.clone();
    let file_path = file_path.clone();

    let doc_info = tokio::task::spawn_blocking(move || {
        service.add_document(&kb_id, &file_path)
    })
    .await
    .map_err(|e| format!("任务执行失败: {}", e))??;

    Ok(serde_json::to_value(doc_info).map_err(|e| format!("序列化失败: {}", e))?)
}

/// 初始化知识库 — 如果没有任何知识库，自动创建一个默认知识库
///
/// 前端在应用启动时调用，确保至少有一个知识库可用。
/// 返回默认知识库的 ID。
#[tauri::command]
pub async fn init_knowledge_bases(
    app: AppHandle,
) -> Result<String, String> {
    if RAG_SERVICE.get().is_none() {
        init_rag_service(&app)?;
    }

    let service = get_service()?;

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
    if RAG_SERVICE.get().is_none() {
        init_rag_service(&app)?;
    }

    let service = get_service()?;
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
    if RAG_SERVICE.get().is_none() {
        init_rag_service(&app)?;
    }

    let service = get_service()?;
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
    if RAG_SERVICE.get().is_none() {
        init_rag_service(&app)?;
    }

    let service = get_service()?;
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
    if RAG_SERVICE.get().is_none() {
        init_rag_service(&app)?;
    }

    let service = get_service()?;
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
    if RAG_SERVICE.get().is_none() {
        init_rag_service(&app)?;
    }

    let service = get_service()?;
    let kb_id = kb_id.clone();
    let keyword = keyword.clone();

    tokio::task::spawn_blocking(move || {
        service.search_documents_content(&kb_id, &keyword)
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
    if RAG_SERVICE.get().is_none() {
        init_rag_service(&app)?;
    }

    let service = get_service()?;
    let kb_id = kb_id.clone();
    let doc_name = doc_name.clone();
    let content = content.clone();

    let doc_info = tokio::task::spawn_blocking(move || {
        service.add_text_document(&kb_id, &doc_name, &content)
    })
    .await
    .map_err(|e| format!("任务执行失败: {}", e))??;

    Ok(serde_json::to_value(doc_info).map_err(|e| format!("序列化失败: {}", e))?)
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
    if RAG_SERVICE.get().is_none() {
        init_rag_service(&app)?;
    }

    let service = get_service()?;
    let kb_id = kb_id.clone();
    let doc_id = doc_id.clone();
    let file_path = file_path.clone();

    let doc_info = tokio::task::spawn_blocking(move || {
        service.edit_document(&kb_id, &doc_id, &file_path)
    })
    .await
    .map_err(|e| format!("任务执行失败: {}", e))??;

    Ok(serde_json::to_value(doc_info).map_err(|e| format!("序列化失败: {}", e))?)
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
    if RAG_SERVICE.get().is_none() {
        init_rag_service(&app)?;
    }

    let service = get_service()?;
    let kb_id = kb_id.clone();
    let doc_id = doc_id.clone();
    let doc_name = doc_name.clone();
    let content = content.clone();

    let doc_info = tokio::task::spawn_blocking(move || {
        service.edit_text_document(&kb_id, &doc_id, &doc_name, &content)
    })
    .await
    .map_err(|e| format!("任务执行失败: {}", e))??;

    Ok(serde_json::to_value(doc_info).map_err(|e| format!("序列化失败: {}", e))?)
}
