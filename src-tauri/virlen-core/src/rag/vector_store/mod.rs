//! 向量存储 — 基于 turbovec (TurboQuant) 的高压缩向量索引
//!
//! 使用 Google TurboQuant 算法的 Rust 实现做向量量化索引。
//! 每个知识库对应一个目录，包含：
//! - `_metadata.json` — 知识库元数据
//! - `_documents.json` — 文档索引
//! - `index.tvim` — turbovec IdMapIndex 二进制文件（量化向量 + 外部 ID）
//! - `chunk_map.json` — u64 ID → 块内容/元数据的映射
//!
//! 相比旧版（vectors.bin + 暴力余弦）：
//! - 8x 压缩（4-bit 量化，1536维: 6KB → 768B）
//! - SIMD 加速搜索（手写 NEON/AVX-512/AVX2 内核）
//! - 搜索精度与 FAISS 持平或更优


pub(crate) mod docs;
pub(crate) mod persist;
pub(crate) mod search;

// 无需再导出：三个子模块里**只有 `impl` 块**（跨文件 impl 与文件位置无关），
// 公开名字（`VectorStoreManager` / `format_data_size` / 各数据结构）都定义在本文件，
// 因此 `crate::rag::vector_store::…` 这些路径**一行都没变**。

use crate::rag::embedding::EmbeddingProvider;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use turbovec::IdMapIndex;

/// 默认 TurboQuant 量化位宽（4-bit 推荐，8x 压缩 + 高召回）
const DEFAULT_BIT_WIDTH: usize = 4;

/// 知识库元数据
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct KnowledgeBaseMeta {
    pub id: String,
    pub name: String,
    pub description: String,
    pub created_at: String,
    pub updated_at: String,
    pub document_count: usize,
    pub chunk_count: usize,
}

/// 文档信息
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DocumentInfo {
    pub id: String,
    pub file_name: String,
    pub file_type: String,
    pub file_size: u64,
    pub chunk_count: usize,
    pub status: String,
    pub error: Option<String>,
    pub created_at: String,
}

/// 检索结果块
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ChunkResult {
    pub id: String,
    pub content: String,
    pub document_id: String,
    pub document_name: String,
    pub chunk_index: usize,
    pub score: f32,
}

/// 块信息 — 用于 turbovec u64 ID → 块内容的反向查找
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct ChunkInfo {
    chunk_id: String,
    document_id: String,
    document_name: String,
    content: String,
    chunk_index: usize,
    file_type: String,
}

/// 单个知识库的索引状态
pub(crate) struct IndexState {
    /// turbovec IdMapIndex（量化向量 + u64 外部 ID）
    index: IdMapIndex,
    /// u64 ID → 块内容的映射
    chunks: HashMap<u64, ChunkInfo>,
    /// 下一个可用的 u64 ID（自增）
    next_id: u64,
}

/// 序列化格式：chunk_map.json
#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct ChunkMapFile {
    chunks: HashMap<u64, ChunkInfo>,
    next_id: u64,
}

/// 向量存储管理器
pub struct VectorStoreManager {
    pub(crate) data_dir: PathBuf,
    embedding_provider: Arc<dyn EmbeddingProvider>,
    /// 内存索引 {kb_id -> IndexState}
    indices: HashMap<String, IndexState>,
}

impl VectorStoreManager {
    pub fn new(data_dir: PathBuf, embedding_provider: Arc<dyn EmbeddingProvider>) -> Self {
        Self {
            data_dir,
            embedding_provider,
            indices: HashMap::new(),
        }
    }

    /// 初始化
    pub fn init(&mut self) -> Result<(), String> {
        std::fs::create_dir_all(&self.data_dir)
            .map_err(|e| format!("创建数据目录失败: {}", e))?;
        self.load_all_indices()?;
        Ok(())
    }

    // ===== 知识库管理 =====

    pub fn create_knowledge_base(&self, name: &str, description: &str) -> Result<KnowledgeBaseMeta, String> {
        let id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now().to_rfc3339();

        let meta = KnowledgeBaseMeta {
            id: id.clone(),
            name: name.to_string(),
            description: description.to_string(),
            created_at: now.clone(),
            updated_at: now,
            document_count: 0,
            chunk_count: 0,
        };

        // 创建目录和元数据文件
        let kb_dir = self.get_kb_dir(&id);
        std::fs::create_dir_all(&kb_dir)
            .map_err(|e| format!("创建知识库目录失败: {}", e))?;

        self.save_kb_metadata(&id, &meta)?;

        Ok(meta)
    }

    pub fn list_knowledge_bases(&self) -> Result<Vec<KnowledgeBaseMeta>, String> {
        let mut result = Vec::new();
        if !self.data_dir.exists() {
            return Ok(result);
        }

        for entry in std::fs::read_dir(&self.data_dir).map_err(|e| format!("读取目录失败: {}", e))? {
            let entry = entry.map_err(|e| format!("读取目录项失败: {}", e))?;
            let dir_name = entry.file_name().to_string_lossy().to_string();
            if dir_name.starts_with("kb_") {
                let kb_id = dir_name.strip_prefix("kb_").unwrap_or(&dir_name);
                if let Some(meta) = self.load_kb_metadata(kb_id)? {
                    result.push(meta);
                }
            }
        }
        Ok(result)
    }

    /// 获取单个知识库元数据
    /// 当前未被前端直接调用，保留供后续功能扩展使用
    #[allow(dead_code)]
    pub fn get_knowledge_base(&self, kb_id: &str) -> Result<KnowledgeBaseMeta, String> {
        self.load_kb_metadata(kb_id)?
            .ok_or_else(|| format!("知识库不存在: {}", kb_id))
    }

    pub fn delete_knowledge_base(&mut self, kb_id: &str) -> Result<(), String> {
        // 检查知识库（内存索引 或 磁盘目录）是否存在
        let exists_in_memory = self.indices.contains_key(kb_id);
        let kb_dir = self.get_kb_dir(kb_id);
        let exists_on_disk = kb_dir.exists();

        if !exists_in_memory && !exists_on_disk {
            return Err(format!("知识库不存在: {}", kb_id));
        }

        if exists_on_disk {
            std::fs::remove_dir_all(&kb_dir)
                .map_err(|e| format!("删除知识库目录失败: {}", e))?;
        }
        if exists_in_memory {
            self.indices.remove(kb_id);
        }
        Ok(())
    }
}

/// 格式化知识库数据目录大小（当前未被使用，保留供后续 UI 展示用）
#[allow(dead_code)]
pub fn format_data_size(size: u64) -> String {
    const KB: u64 = 1024;
    const MB: u64 = KB * 1024;
    const GB: u64 = MB * 1024;

    if size >= GB {
        format!("{:.2} GB", size as f64 / GB as f64)
    } else if size >= MB {
        format!("{:.2} MB", size as f64 / MB as f64)
    } else if size >= KB {
        format!("{:.2} KB", size as f64 / KB as f64)
    } else {
        format!("{} B", size)
    }
}

#[cfg(test)]
mod tests;
