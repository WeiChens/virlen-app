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

use crate::rag::document::DocumentChunk;
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
struct IndexState {
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

    // ===== 索引加载 =====

    /// 加载所有已有知识库的索引到内存
    fn load_all_indices(&mut self) -> Result<(), String> {
        if !self.data_dir.exists() {
            return Ok(());
        }

        for entry in std::fs::read_dir(&self.data_dir).map_err(|e| format!("读取目录失败: {}", e))? {
            let entry = entry.map_err(|e| format!("读取目录项失败: {}", e))?;
            let dir_name = entry.file_name().to_string_lossy().to_string();

            if dir_name.starts_with("kb_") && entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                let kb_id = dir_name.strip_prefix("kb_").unwrap_or(&dir_name).to_string();
                if let Ok(state) = self.load_index_from_disk(&kb_id) {
                    self.indices.insert(kb_id, state);
                }
            }
        }
        Ok(())
    }

    /// 从磁盘加载单个知识库的索引
    fn load_index_from_disk(&self, kb_id: &str) -> Result<IndexState, String> {
        let index_path = self.index_path(kb_id);
        let chunk_map_path = self.chunk_map_path(kb_id);

        // 如果文件不存在，返回空索引
        if !index_path.exists() || !chunk_map_path.exists() {
            let dim = self.embedding_provider.dimensions();
            let index = IdMapIndex::new(dim, DEFAULT_BIT_WIDTH)
                .map_err(|e| format!("创建 turbovec 索引失败: {:?}", e))?;
            return Ok(IndexState {
                index,
                chunks: HashMap::new(),
                next_id: 0,
            });
        }

        // 加载 turbovec 索引
        let index = IdMapIndex::load(&index_path)
            .map_err(|e| format!("加载 turbovec 索引失败: {}", e))?;

        // 加载块映射
        let json = std::fs::read_to_string(&chunk_map_path)
            .map_err(|e| format!("读取块映射失败: {}", e))?;
        let file: ChunkMapFile = serde_json::from_str(&json)
            .map_err(|e| format!("解析块映射失败: {}", e))?;

        Ok(IndexState {
            index,
            chunks: file.chunks,
            next_id: file.next_id,
        })
    }

    /// 保存索引到磁盘（turbovec 二进制 + chunk_map JSON）
    fn save_index_to_disk(kb_dir: &PathBuf, index_path: &PathBuf, chunk_map_path: &PathBuf, state: &IndexState) -> Result<(), String> {
        std::fs::create_dir_all(kb_dir)
            .map_err(|e| format!("创建知识库目录失败: {}", e))?;

        // 保存 turbovec IdMapIndex
        state
            .index
            .write(index_path)
            .map_err(|e| format!("保存 turbovec 索引失败: {}", e))?;

        // 保存 chunk_map
        let file = ChunkMapFile {
            chunks: state.chunks.clone(),
            next_id: state.next_id,
        };
        let json = serde_json::to_string_pretty(&file)
            .map_err(|e| format!("序列化块映射失败: {}", e))?;
        std::fs::write(chunk_map_path, &json)
            .map_err(|e| format!("写入块映射失败: {}", e))?;

        Ok(())
    }

    // ===== 路径辅助 =====

    fn get_kb_dir(&self, kb_id: &str) -> PathBuf {
        self.data_dir.join(format!("kb_{}", kb_id))
    }

    fn index_path(&self, kb_id: &str) -> PathBuf {
        self.get_kb_dir(kb_id).join("index.tvim")
    }

    fn chunk_map_path(&self, kb_id: &str) -> PathBuf {
        self.get_kb_dir(kb_id).join("chunk_map.json")
    }

    fn kb_meta_path(&self, kb_id: &str) -> PathBuf {
        self.get_kb_dir(kb_id).join("_metadata.json")
    }

    fn kb_docs_path(&self, kb_id: &str) -> PathBuf {
        self.get_kb_dir(kb_id).join("_documents.json")
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

    pub fn get_knowledge_base(&self, kb_id: &str) -> Result<KnowledgeBaseMeta, String> {
        self.load_kb_metadata(kb_id)?
            .ok_or_else(|| format!("知识库不存在: {}", kb_id))
    }

    pub fn delete_knowledge_base(&mut self, kb_id: &str) -> Result<(), String> {
        let kb_dir = self.get_kb_dir(kb_id);
        if kb_dir.exists() {
            std::fs::remove_dir_all(&kb_dir)
                .map_err(|e| format!("删除知识库目录失败: {}", e))?;
        }
        self.indices.remove(kb_id);
        Ok(())
    }

    // ===== 文档管理 =====

    pub fn add_document(
        &mut self,
        kb_id: &str,
        chunks: Vec<DocumentChunk>,
    ) -> Result<DocumentInfo, String> {
        if chunks.is_empty() {
            return Err("文档内容为空".to_string());
        }

        let doc_id = chunks[0].document_id.clone();
        let doc_name = chunks[0].document_name.clone();
        let file_type = chunks[0]
            .metadata
            .get("file_type")
            .cloned()
            .unwrap_or_default();
        let file_size = chunks[0]
            .metadata
            .get("file_size")
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        let now = chrono::Utc::now().to_rfc3339();
        let chunk_count = chunks.len();

        // 1. 生成嵌入向量（先获得，释放 self 的不可变借用）
        let texts: Vec<&str> = chunks.iter().map(|c| c.content.as_str()).collect();
        let embeddings = self.embedding_provider.embed_batch(&texts)?;
        let dim = self.embedding_provider.dimensions();
        let n = embeddings.len();

        // 2. 预计算路径（在获取可变借用前）
        let kb_dir = self.get_kb_dir(kb_id);
        let index_path = self.index_path(kb_id);
        let chunk_map_path = self.chunk_map_path(kb_id);

        // 3. 确保该知识库的索引已加载（可变借用）
        let state = if !self.indices.contains_key(kb_id) {
            let index = IdMapIndex::new(dim, DEFAULT_BIT_WIDTH)
                .map_err(|e| format!("创建 turbovec 索引失败: {:?}", e))?;
            self.indices.insert(
                kb_id.to_string(),
                IndexState {
                    index,
                    chunks: HashMap::new(),
                    next_id: 0,
                },
            );
            self.indices.get_mut(kb_id).unwrap()
        } else {
            self.indices.get_mut(kb_id).unwrap()
        };

        // 4. 分配 u64 ID 并构建 chunk_info
        let ids: Vec<u64> = (state.next_id..state.next_id + n as u64).collect();
        state.next_id += n as u64;

        // 扁平化向量：Vec<Vec<f32>> → Vec<f32>
        let mut flat_vectors = Vec::with_capacity(n * dim);
        for emb in &embeddings {
            flat_vectors.extend_from_slice(emb);
        }

        // 5. 添加到 turbovec 索引
        state
            .index
            .add_with_ids(&flat_vectors, &ids)
            .map_err(|e| format!("添加向量到 turbovec 索引失败: {:?}", e))?;

        // 6. 构建 chunk 映射
        for (i, chunk) in chunks.iter().enumerate() {
            let tid = ids[i];
            state.chunks.insert(
                tid,
                ChunkInfo {
                    chunk_id: chunk.id.clone(),
                    document_id: chunk.document_id.clone(),
                    document_name: chunk.document_name.clone(),
                    content: chunk.content.clone(),
                    chunk_index: chunk.chunk_index,
                    file_type: file_type.clone(),
                },
            );
        }

        // 7. 持久化到磁盘（使用预计算路径，无需借用 self）
        Self::save_index_to_disk(&kb_dir, &index_path, &chunk_map_path, state)?;

        // 8. 更新文档索引（self 的可变借用已释放）
        let mut docs = self.load_docs_index(kb_id)?;
        docs.push(DocumentInfo {
            id: doc_id.clone(),
            file_name: doc_name.clone(),
            file_type: file_type.clone(),
            file_size,
            chunk_count,
            status: "ready".into(),
            error: None,
            created_at: now.clone(),
        });
        self.save_docs_index(kb_id, &docs)?;

        // 9. 更新知识库元数据
        let (docs_count, total_chunks) = {
            let state = self.indices.get(kb_id).unwrap();
            let mut doc_ids = std::collections::HashSet::new();
            for info in state.chunks.values() {
                doc_ids.insert(info.document_id.clone());
            }
            (doc_ids.len(), state.chunks.len())
        };

        if let Some(mut meta) = self.load_kb_metadata(kb_id)? {
            meta.document_count = docs_count;
            meta.chunk_count = total_chunks;
            meta.updated_at = now.clone();
            self.save_kb_metadata(kb_id, &meta)?;
        }

        Ok(DocumentInfo {
            id: doc_id,
            file_name: doc_name,
            file_type,
            file_size,
            chunk_count,
            status: "ready".into(),
            error: None,
            created_at: now,
        })
    }

    pub fn remove_document(&mut self, kb_id: &str, doc_id: &str) -> Result<(), String> {
        // 1. 预计算路径（在获取可变借用前）
        let kb_dir = self.get_kb_dir(kb_id);
        let index_path = self.index_path(kb_id);
        let chunk_map_path = self.chunk_map_path(kb_id);

        // 2. 获取可变引用操作索引，记录 chunk_count 后释放借用
        let (_ids_removed, remaining_chunk_count) = {
            let state = self
                .indices
                .get_mut(kb_id)
                .ok_or_else(|| format!("知识库不存在: {}", kb_id))?;

            // 找出该文档的所有 u64 ID
            let ids: Vec<u64> = state
                .chunks
                .iter()
                .filter(|(_, info)| info.document_id == doc_id)
                .map(|(&id, _)| id)
                .collect();

            if ids.is_empty() {
                return Err(format!("文档不存在: {}", doc_id));
            }

            // 从 turbovec 索引中删除（O(1) swap_remove）
            for &id in &ids {
                state.index.remove(id);
            }

            // 从 chunk 映射中删除
            for &id in &ids {
                state.chunks.remove(&id);
            }

            // 记录剩余 chunk 数（在 state 释放前捕获）
            let remaining = state.chunks.len();

            // 3. 持久化
            Self::save_index_to_disk(&kb_dir, &index_path, &chunk_map_path, state)?;

            (ids, remaining)
        }; // state 借用在此释放

        // 4. 更新文档索引（state 已释放，可以借用 self）
        let docs = self.load_docs_index(kb_id)?;
        let docs: Vec<DocumentInfo> = docs.into_iter().filter(|d| d.id != doc_id).collect();
        let remaining_doc_count = docs.len();
        self.save_docs_index(kb_id, &docs)?;

        // 5. 更新知识库元数据（修复 Bug：删除文档后 document_count/chunk_count 未更新）
        let now = chrono::Utc::now().to_rfc3339();

        if let Some(mut meta) = self.load_kb_metadata(kb_id)? {
            meta.document_count = remaining_doc_count;
            meta.chunk_count = remaining_chunk_count;
            meta.updated_at = now;
            self.save_kb_metadata(kb_id, &meta)?;
        }

        Ok(())
    }

    /// 编辑文档 — 删除旧内容并重新添加新内容
    ///
    /// 流程：
    /// 1. 删除文档原有的所有 chunk（同 remove_document）
    /// 2. 用新的 chunks 重新添加（同 add_document 的 chunk 部分）
    pub fn edit_document(
        &mut self,
        kb_id: &str,
        old_doc_id: &str,
        new_chunks: Vec<DocumentChunk>,
    ) -> Result<DocumentInfo, String> {
        // 0. 预计算路径（在获取可变借用前）
        let kb_dir = self.get_kb_dir(kb_id);
        let index_path = self.index_path(kb_id);
        let chunk_map_path = self.chunk_map_path(kb_id);

        // 1. 删除旧文档的 chunks + 添加新 chunks（在同一个 state 借用中完成）
        let doc_info = {
            let state = self
                .indices
                .get_mut(kb_id)
                .ok_or_else(|| format!("知识库不存在: {}", kb_id))?;

            // 1a. 删除旧 chunks
            let ids_to_remove: Vec<u64> = state
                .chunks
                .iter()
                .filter(|(_, info)| info.document_id == old_doc_id)
                .map(|(&id, _)| id)
                .collect();

            if !ids_to_remove.is_empty() {
                for &id in &ids_to_remove {
                    state.index.remove(id);
                }
                for &id in &ids_to_remove {
                    state.chunks.remove(&id);
                }
            }

            // 1b. 生成新嵌入向量
            let texts: Vec<&str> = new_chunks.iter().map(|c| c.content.as_str()).collect();
            let embeddings = self.embedding_provider.embed_batch(&texts)?;
            let dim = self.embedding_provider.dimensions();
            let n = embeddings.len();

            let doc_id = new_chunks[0].document_id.clone();
            let doc_name = new_chunks[0].document_name.clone();
            let file_type = new_chunks[0]
                .metadata
                .get("file_type")
                .cloned()
                .unwrap_or_default();
            let file_size = new_chunks[0]
                .metadata
                .get("file_size")
                .and_then(|s| s.parse().ok())
                .unwrap_or(0);

            // 1c. 分配 u64 ID
            let ids: Vec<u64> = (state.next_id..state.next_id + n as u64).collect();
            state.next_id += n as u64;

            // 1d. 扁平化向量并添加到索引
            let mut flat_vectors = Vec::with_capacity(n * dim);
            for emb in &embeddings {
                flat_vectors.extend_from_slice(emb);
            }
            state
                .index
                .add_with_ids(&flat_vectors, &ids)
                .map_err(|e| format!("添加向量到 turbovec 索引失败: {:?}", e))?;

            // 1e. 构建 chunk 映射
            for (i, chunk) in new_chunks.iter().enumerate() {
                let tid = ids[i];
                state.chunks.insert(
                    tid,
                    ChunkInfo {
                        chunk_id: chunk.id.clone(),
                        document_id: chunk.document_id.clone(),
                        document_name: chunk.document_name.clone(),
                        content: chunk.content.clone(),
                        chunk_index: chunk.chunk_index,
                        file_type: file_type.clone(),
                    },
                );
            }

            // 1f. 持久化
            Self::save_index_to_disk(&kb_dir, &index_path, &chunk_map_path, state)?;

            // 1g. 构建返回的 DocumentInfo（在 state 释放前捕获所需数据）
            let total_chunks = state.chunks.len();
            let now = chrono::Utc::now().to_rfc3339();

            (doc_id, doc_name, file_type, file_size, n, total_chunks, now)
        }; // state 借用在此释放

        let (doc_id, doc_name, file_type, file_size, chunk_count, total_chunks, now) = doc_info;

        // 2. 更新文档索引（state 已释放）
        let mut docs = self.load_docs_index(kb_id)?;
        docs.retain(|d| d.id != old_doc_id);
        docs.push(DocumentInfo {
            id: doc_id.clone(),
            file_name: doc_name.clone(),
            file_type: file_type.clone(),
            file_size,
            chunk_count,
            status: "ready".into(),
            error: None,
            created_at: now.clone(),
        });
        let doc_count = docs.len();
        self.save_docs_index(kb_id, &docs)?;

        // 3. 更新元数据
        if let Some(mut meta) = self.load_kb_metadata(kb_id)? {
            meta.document_count = doc_count;
            meta.chunk_count = total_chunks;
            meta.updated_at = now.clone();
            self.save_kb_metadata(kb_id, &meta)?;
        }

        Ok(DocumentInfo {
            id: doc_id,
            file_name: doc_name,
            file_type,
            file_size,
            chunk_count,
            status: "ready".into(),
            error: None,
            created_at: now,
        })
    }

    pub fn list_documents(&self, kb_id: &str) -> Result<Vec<DocumentInfo>, String> {
        let docs = self.load_docs_index(kb_id)?;
        Ok(docs)
    }

    /// 获取文档的完整内容（所有 chunk 按顺序拼接）
    ///
    /// 通过 document_id 查找所有属于该文档的 chunk，按 chunk_index 排序后拼接。
    pub fn get_document_content(&self, kb_id: &str, doc_id: &str) -> Result<String, String> {
        let state = self
            .indices
            .get(kb_id)
            .ok_or_else(|| format!("知识库不存在: {}", kb_id))?;

        // 找出该文档的所有 chunk，按 chunk_index 排序
        let mut chunks: Vec<&ChunkInfo> = state
            .chunks
            .values()
            .filter(|info| info.document_id == doc_id)
            .collect();

        if chunks.is_empty() {
            return Err(format!("文档不存在: {}", doc_id));
        }

        chunks.sort_by_key(|c| c.chunk_index);

        // 按顺序拼接
        let content: String = chunks.iter().map(|c| c.content.as_str()).collect::<Vec<_>>().join("\n\n");
        Ok(content)
    }

    // ===== 检索 =====

    pub fn query(&self, kb_id: &str, query_text: &str, top_k: usize) -> Result<Vec<ChunkResult>, String> {
        let state = self
            .indices
            .get(kb_id)
            .ok_or_else(|| format!("知识库不存在: {}", kb_id))?;

        if state.chunks.is_empty() {
            return Ok(Vec::new());
        }

        // 1. 生成查询向量
        let query_vec = self.embedding_provider.embed(query_text)?;

        // 2. 用 turbovec 搜索（查询向量也是扁平的 &[f32]）
        let effective_k = top_k.min(state.chunks.len());
        let (scores, ids) = state.index.search(&query_vec, effective_k);
        // 对于单查询：scores 有 effective_k 个元素，ids 有 effective_k 个元素

        // 3. 通过 u64 ID 反向查找 chunk 内容
        let results: Vec<ChunkResult> = ids
            .iter()
            .enumerate()
            .filter_map(|(i, &id)| {
                let info = state.chunks.get(&id)?;
                Some(ChunkResult {
                    id: info.chunk_id.clone(),
                    content: info.content.clone(),
                    document_id: info.document_id.clone(),
                    document_name: info.document_name.clone(),
                    chunk_index: info.chunk_index,
                    score: scores[i],
                })
            })
            .collect();

        Ok(results)
    }

    // ===== 内部辅助 =====

    fn save_kb_metadata(&self, kb_id: &str, meta: &KnowledgeBaseMeta) -> Result<(), String> {
        let path = self.kb_meta_path(kb_id);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("创建目录失败: {}", e))?;
        }
        let json = serde_json::to_string_pretty(meta)
            .map_err(|e| format!("序列化元数据失败: {}", e))?;
        std::fs::write(&path, &json).map_err(|e| format!("写入元数据失败: {}", e))?;
        Ok(())
    }

    fn load_kb_metadata(&self, kb_id: &str) -> Result<Option<KnowledgeBaseMeta>, String> {
        let path = self.kb_meta_path(kb_id);
        if !path.exists() {
            return Ok(None);
        }
        let json = std::fs::read_to_string(&path)
            .map_err(|e| format!("读取元数据失败: {}", e))?;
        let meta: KnowledgeBaseMeta = serde_json::from_str(&json)
            .map_err(|e| format!("解析元数据失败: {}", e))?;
        Ok(Some(meta))
    }

    fn load_docs_index(&self, kb_id: &str) -> Result<Vec<DocumentInfo>, String> {
        let path = self.kb_docs_path(kb_id);
        if !path.exists() {
            return Ok(Vec::new());
        }
        let json = std::fs::read_to_string(&path)
            .map_err(|e| format!("读取文档索引失败: {}", e))?;
        let docs: Vec<DocumentInfo> = serde_json::from_str(&json)
            .map_err(|e| format!("解析文档索引失败: {}", e))?;
        Ok(docs)
    }

    fn save_docs_index(&self, kb_id: &str, docs: &[DocumentInfo]) -> Result<(), String> {
        let path = self.kb_docs_path(kb_id);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("创建目录失败: {}", e))?;
        }
        let json = serde_json::to_string_pretty(docs)
            .map_err(|e| format!("序列化文档索引失败: {}", e))?;
        std::fs::write(&path, &json).map_err(|e| format!("写入文档索引失败: {}", e))?;
        Ok(())
    }
}

/// 格式化知识库数据目录大小
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
mod tests {
    use super::*;
    use crate::rag::embedding::NgramEmbeddingProvider;
    use crate::rag::document::DocumentChunk;

    fn create_test_manager() -> VectorStoreManager {
        let test_id = uuid::Uuid::new_v4();
        let dir = std::env::temp_dir().join(format!("virlen_rag_test_turbovec_{}", test_id));
        let provider = Arc::new(NgramEmbeddingProvider::new(512));
        let mut manager = VectorStoreManager::new(dir, provider);
        manager.init().unwrap();
        manager
    }

    fn make_test_chunks(doc_id: &str, doc_name: &str, texts: &[&str]) -> Vec<DocumentChunk> {
        texts.iter().enumerate().map(|(i, text)| {
            let mut metadata = std::collections::HashMap::new();
            metadata.insert("file_type".into(), "md".into());
            metadata.insert("file_size".into(), "100".into());
            DocumentChunk {
                id: format!("{}_{}", doc_id, i),
                document_id: doc_id.to_string(),
                document_name: doc_name.to_string(),
                content: text.to_string(),
                chunk_index: i,
                metadata,
            }
        }).collect()
    }

    #[test]
    fn test_kb_crud() {
        let mut mgr = create_test_manager();

        // 创建
        let kb = mgr.create_knowledge_base("测试知识库", "测试用").unwrap();
        assert_eq!(kb.name, "测试知识库");

        // 列出
        let list = mgr.list_knowledge_bases().unwrap();
        assert!(!list.is_empty());

        // 获取
        let fetched = mgr.get_knowledge_base(&kb.id).unwrap();
        assert_eq!(fetched.id, kb.id);

        // 删除
        mgr.delete_knowledge_base(&kb.id).unwrap();
        let list = mgr.list_knowledge_bases().unwrap();
        assert!(list.is_empty());
    }

    #[test]
    fn test_add_and_query_document() {
        let mut mgr = create_test_manager();
        let kb = mgr.create_knowledge_base("测试", "").unwrap();

        let chunks = make_test_chunks("doc1", "test.md", &[
            "Rust 是一种系统编程语言，注重安全和性能。",
            "Python 是一种解释型高级编程语言。",
            "机器学习是人工智能的一个重要分支。",
        ]);

        let doc_info = mgr.add_document(&kb.id, chunks).unwrap();
        assert_eq!(doc_info.file_name, "test.md");
        assert_eq!(doc_info.chunk_count, 3);

        // 查询
        let results = mgr.query(&kb.id, "编程语言", 2).unwrap();
        assert!(!results.is_empty());
        assert!(results.len() <= 2);
        // 结果应该包含 Rust 或 Python
        let all_content: String = results.iter().map(|r| r.content.clone()).collect();
        assert!(all_content.contains("Rust") || all_content.contains("Python"));
    }

    #[test]
    fn test_remove_document() {
        let mut mgr = create_test_manager();
        let kb = mgr.create_knowledge_base("测试", "").unwrap();

        let chunks = make_test_chunks("doc1", "doc1.md", &["内容 A", "内容 B"]);
        let doc_info = mgr.add_document(&kb.id, chunks).unwrap();

        // 删除
        mgr.remove_document(&kb.id, &doc_info.id).unwrap();

        // 验证文档列表为空
        let docs = mgr.list_documents(&kb.id).unwrap();
        assert!(docs.is_empty());

        // 验证查询为空
        let results = mgr.query(&kb.id, "内容", 5).unwrap();
        assert!(results.is_empty());
    }

    #[test]
    fn test_multiple_documents() {
        let mut mgr = create_test_manager();
        let kb = mgr.create_knowledge_base("测试", "").unwrap();

        // 添加第一个文档
        let chunks1 = make_test_chunks("doc1", "rust.md", &["Rust 编程语言", "Rust 的所有权系统"]);
        mgr.add_document(&kb.id, chunks1).unwrap();

        // 添加第二个文档
        let chunks2 = make_test_chunks("doc2", "python.md", &["Python 编程", "Python 的列表推导"]);
        mgr.add_document(&kb.id, chunks2).unwrap();

        // 列出文档
        let docs = mgr.list_documents(&kb.id).unwrap();
        assert_eq!(docs.len(), 2);

        // 跨文档搜索（两个文档都包含"编程"，但 n-gram 可能最多返回所有 4 个块）
        let results = mgr.query(&kb.id, "编程", 10).unwrap();
        assert!(results.len() >= 2, "搜索应该返回至少2个结果，实际返回 {}", results.len());
    }

    #[test]
    fn test_persistence() {
        let test_id = uuid::Uuid::new_v4();
        let dir = std::env::temp_dir().join(format!("virlen_rag_test_persist_{}", test_id));

        let provider = Arc::new(NgramEmbeddingProvider::new(512));
        let kb_id;

        // 第一阶段：创建知识库并添加文档
        {
            let mut mgr = VectorStoreManager::new(dir.clone(), provider.clone());
            mgr.init().unwrap();
            let kb = mgr.create_knowledge_base("持久化测试", "").unwrap();
            kb_id = kb.id.clone();

            let chunks = make_test_chunks("doc1", "test.md", &["Hello World", "Rust is great"]);
            mgr.add_document(&kb_id, chunks).unwrap();
        } // mgr 析构，数据落盘

        // 第二阶段：重新加载并验证
        {
            let mut mgr = VectorStoreManager::new(dir.clone(), provider);
            mgr.init().unwrap();

            let kbs = mgr.list_knowledge_bases().unwrap();
            assert!(!kbs.is_empty());

            let results = mgr.query(&kb_id, "Hello", 5).unwrap();
            assert!(!results.is_empty());
            assert!(results[0].content.contains("Hello"));
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_edit_document() {
        let mut mgr = create_test_manager();
        let kb = mgr.create_knowledge_base("编辑测试", "").unwrap();

        // 添加初始文档
        let chunks1 = make_test_chunks("doc1", "original.md", &["原始内容第一块", "原始内容第二块"]);
        let doc1 = mgr.add_document(&kb.id, chunks1).unwrap();
        assert_eq!(doc1.file_name, "original.md");
        assert_eq!(doc1.chunk_count, 2);

        // 验证元数据
        let meta = mgr.get_knowledge_base(&kb.id).unwrap();
        assert_eq!(meta.document_count, 1);
        assert_eq!(meta.chunk_count, 2);

        // 编辑文档 — 用不同 chunk 数量替换
        let chunks_new = make_test_chunks("doc1_new", "updated.md", &[
            "更新后的内容第一块",
            "更新后的内容第二块",
            "新增的第三块内容",
        ]);
        let doc2 = mgr.edit_document(&kb.id, "doc1", chunks_new).unwrap();
        assert_eq!(doc2.file_name, "updated.md");
        assert_eq!(doc2.chunk_count, 3);

        // 验证文档索引已更新（旧文档被替换）
        let docs = mgr.list_documents(&kb.id).unwrap();
        assert_eq!(docs.len(), 1);
        assert_eq!(docs[0].file_name, "updated.md");

        // 验证元数据已更新（chunk_count 从 2 变为 3）
        let meta = mgr.get_knowledge_base(&kb.id).unwrap();
        assert_eq!(meta.document_count, 1, "document_count should still be 1");
        assert_eq!(meta.chunk_count, 3, "chunk_count should be 3 (replaced 2 with 3)");

        // 验证搜索新内容能找到
        let results = mgr.query(&kb.id, "更新后的内容", 5).unwrap();
        assert!(!results.is_empty(), "should find updated content");

        // 验证旧文档 doc_id 的 chunk 已被删除（文档列表只剩新文档）
        assert!(!docs.iter().any(|d| d.id == "doc1"), "old doc should be gone from index");
    }

    #[test]
    fn test_remove_document_updates_metadata() {
        let mut mgr = create_test_manager();
        let kb = mgr.create_knowledge_base("元数据测试", "").unwrap();

        // 添加两个文档
        let docs1 = make_test_chunks("d1", "doc1.md", &["第一个文档的内容"]);
        let docs2 = make_test_chunks("d2", "doc2.md", &["第二个文档的内容", "第二文档的第二段"]);
        mgr.add_document(&kb.id, docs1).unwrap();
        mgr.add_document(&kb.id, docs2).unwrap();

        // 验证元数据
        let meta = mgr.get_knowledge_base(&kb.id).unwrap();
        assert_eq!(meta.document_count, 2);
        assert_eq!(meta.chunk_count, 3);

        // 删除一个文档后验证元数据更新
        mgr.remove_document(&kb.id, "d1").unwrap();
        let meta = mgr.get_knowledge_base(&kb.id).unwrap();
        assert_eq!(meta.document_count, 1, "after removing 1 doc, count should be 1");
        assert_eq!(meta.chunk_count, 2, "after removing 1 chunk, count should be 2");

        // 再删除最后一个文档
        mgr.remove_document(&kb.id, "d2").unwrap();
        let meta = mgr.get_knowledge_base(&kb.id).unwrap();
        assert_eq!(meta.document_count, 0, "after removing all docs, count should be 0");
        assert_eq!(meta.chunk_count, 0, "after removing all chunks, count should be 0");
    }
}
