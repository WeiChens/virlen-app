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
    /// 系统自建（由功能自己创建与维护：默认知识库 / 记忆详情）—— **用户不能删除**。
    ///
    /// 为什么落进元数据而不是「按名字判断」：名字是给用户看的文本，改文案不该顺带改变
    /// 「能不能删」；而删掉这两个库会让对应功能静默失效（记忆条目指向的详情库就没了）。
    ///
    /// `#[serde(default)]`：升级前的 `_metadata.json` 里没有这个字段 —— 读出来是 `false`，
    /// 不能因为新增字段就让老库解析失败（补标记见 `init_default_knowledge_base` / `memory::kb`）。
    #[serde(default)]
    pub builtin: bool,
}

/// 压缩包预览（给界面两步走：先把「会进来什么 / 有多少被排除」说清，再逐条导入）
///
/// 逐条导入由命令层驱动（每读一条报一次进度，用户可随时取消），所以这里不再是「导入结果」，
/// 而是导入前的**名单**。
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct ZipPreview {
    /// 会入库的条目名（已按包内 .gitignore 过滤、已排除超过 2 MB 的条目）
    pub names: Vec<String>,
    /// 被 .gitignore 排除的条目数（含被排除目录里的条目 —— 条目是一张名单，不涉及「进不进得去」）
    pub ignored: usize,
    /// 超过 [`crate::rag::import_scan::MAX_TEXT_FILE_BYTES`]（2 MB）而没收的条目数
    pub too_large: usize,
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
    /// 本块开头有多少**字符**是上一块结尾的重复（分块时记下，见
    /// [`crate::rag::document::META_OVERLAP_PREFIX`]）。
    ///
    /// 读全文时按它裁掉重叠，否则预览 / 编辑 / 导出会看到重复内容。
    /// `None` = 升级前写的块（那时没这个字段）—— 此时由
    /// [`VectorStoreManager::legacy_overlap_prefix`] 按默认重叠量回推。
    #[serde(default)]
    overlap_prefix_chars: Option<usize>,
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

    /// 创建知识库（用户在界面上新建的：可以删除）
    pub fn create_knowledge_base(&self, name: &str, description: &str) -> Result<KnowledgeBaseMeta, String> {
        self.create_knowledge_base_with(name, description, false)
    }

    /// 创建**系统自建**知识库（默认知识库 / 记忆详情）：带 `builtin` 标记，用户删不掉
    pub fn create_builtin_knowledge_base(&self, name: &str, description: &str) -> Result<KnowledgeBaseMeta, String> {
        self.create_knowledge_base_with(name, description, true)
    }

    fn create_knowledge_base_with(&self, name: &str, description: &str, builtin: bool) -> Result<KnowledgeBaseMeta, String> {
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
            builtin,
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

    /// 把已有知识库补记为「系统自建」
    ///
    /// 升级前的数据没有 `builtin` 字段（那时默认知识库 / 记忆详情还能被删掉），由各自的
    /// 归属模块按名字认领后调用这里补标记。已经标记过 = 空操作。
    ///
    /// 返回「这次是否真的改了」，便于调用方只记一次日志。
    pub fn mark_knowledge_base_builtin(&self, kb_id: &str) -> Result<bool, String> {
        let mut meta = match self.load_kb_metadata(kb_id)? {
            Some(m) => m,
            None => return Ok(false),
        };
        if meta.builtin {
            return Ok(false);
        }
        meta.builtin = true;
        meta.updated_at = chrono::Utc::now().to_rfc3339();
        self.save_kb_metadata(kb_id, &meta)?;
        Ok(true)
    }

    /// 删除知识库（写操作）
    /// 改知识库的名称 / 说明（`None` = 不动这一项）
    ///
    /// 为什么要它：卡片上原本只有「进」与「删」—— 名字写错只能删了重建（里面的文档一起没）。
    ///
    /// 两个约束：
    /// - 名称不能改成空白：列表、搜索、导入时的认领都拿它当标识；
    /// - **系统自建库不给改名**：默认知识库与记忆详情都以**名字**当「缓存失效后认领」的锚
    ///   （`init_default_knowledge_base` / `memory::kb::ensure_memory_kb`），改名会让锚点失效、
    ///   旧的详情文档变孤儿。与「不能删除」同源。
    pub fn update_knowledge_base(
        &self,
        kb_id: &str,
        name: Option<&str>,
        description: Option<&str>,
    ) -> Result<KnowledgeBaseMeta, String> {
        let mut meta = self
            .load_kb_metadata(kb_id)?
            .ok_or_else(|| format!("知识库不存在: {}", kb_id))?;

        if meta.builtin && name.is_some() {
            return Err(format!("「{}」是 Virlen 自动创建的知识库，不能改名。", meta.name));
        }

        if let Some(raw) = name {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return Err("知识库名称不能为空".to_string());
            }
            meta.name = trimmed.to_string();
        }
        if let Some(raw) = description {
            meta.description = raw.trim().to_string();
        }

        meta.updated_at = chrono::Utc::now().to_rfc3339();
        self.save_kb_metadata(kb_id, &meta)?;
        Ok(meta)
    }

    pub fn delete_knowledge_base(&mut self, kb_id: &str) -> Result<(), String> {
        // 检查知识库（内存索引 或 磁盘目录）是否存在
        let exists_in_memory = self.indices.contains_key(kb_id);
        let kb_dir = self.get_kb_dir(kb_id);
        let exists_on_disk = kb_dir.exists();

        if !exists_in_memory && !exists_on_disk {
            return Err(format!("知识库不存在: {}", kb_id));
        }

        // 系统自建库（默认知识库 / 记忆详情）不给删：删掉之后对应功能只会静默失效
        //（记忆条目会指向一个不存在的库）。界面上已经不显示删除入口，这一道是**兜底** ——
        // 删除只有这一个出口，AI 工具 / 命令行走同一个入口也绕不过去。
        if let Some(meta) = self.load_kb_metadata(kb_id)? {
            if meta.builtin {
                return Err(format!(
                    "「{}」是 Virlen 自动创建的知识库，不能删除。",
                    meta.name
                ));
            }
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

/// 从块元数据取「开头重复了多少字符」（缺字段 / 解析不了 → `None` = 老数据）
fn overlap_prefix_of(chunk: &crate::rag::document::DocumentChunk) -> Option<usize> {
    chunk
        .metadata
        .get(crate::rag::document::META_OVERLAP_PREFIX)
        .and_then(|s| s.parse().ok())
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
