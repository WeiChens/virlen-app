//! RAG 知识库模块（零 `tauri::` 依赖）
//!
//! 提供基于本地文件存储的 RAG 知识库功能：知识库的创建、删除、列表；文档的添加、删除、列表；
//! 语义检索（向量相似度搜索）。
//!
//! ⚠️ 数据目录由宿主注入（`HostEnv::data_dir()`）而不是从 `tauri::AppHandle` 取 —— 这样 CLI 与
//! GUI 落在同一目录、读写同一份知识库。Tauri 命令（`#[tauri::command]`）在 `virlen-app` 的
//! `src/commands/rag.rs`。

pub mod document;
pub mod embedding;
pub mod rag_service;
pub mod vector_store;

use crate::rag::embedding::{EmbeddingProvider, NgramEmbeddingProvider, OpenAIEmbeddingProvider};
use crate::rag::rag_service::RagService;
use once_cell::sync::OnceCell;
use std::path::PathBuf;
use std::sync::Arc;

/// 全局 RAG 服务实例
static RAG_SERVICE: OnceCell<RagService> = OnceCell::new();

/// 知识库目录名（相对宿主的数据目录）
pub const KNOWLEDGE_BASE_DIR: &str = "knowledge_base";

/// 初始化 RAG 服务（**无 Tauri**）。
///
/// `app_data_dir` 由宿主提供：GUI 传 `TauriHost::data_dir()`，CLI 传 `CliHost::data_dir()`；
/// 知识库落在 `<app_data_dir>/knowledge_base`。
pub fn init_service(app_data_dir: PathBuf) -> Result<(), String> {
    let data_dir = app_data_dir.join(KNOWLEDGE_BASE_DIR);

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

/// 是否已初始化
pub fn is_initialized() -> bool {
    RAG_SERVICE.get().is_some()
}

/// 获取 RAG 服务引用
pub fn get_service() -> Result<&'static RagService, String> {
    RAG_SERVICE
        .get()
        .ok_or_else(|| "RAG 服务未初始化，请重启应用".to_string())
}

/// 取服务；未初始化则**先用给定数据目录初始化**（幂等）。
///
/// 供「懒初始化」路径使用：GUI 命令 / 原生知识库工具在首次调用时补齐初始化，
/// 与重构前 `if RAG_SERVICE.get().is_none() { init_rag_service(&app)?; }` 语义一致。
pub fn ensure_service(app_data_dir: PathBuf) -> Result<&'static RagService, String> {
    if !is_initialized() {
        init_service(app_data_dir)?;
    }
    get_service()
}
