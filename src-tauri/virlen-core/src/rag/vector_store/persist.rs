//! 磁盘读写与路径推导 —— 索引/元数据/文档索引的落盘与回读
//!
//! 为什么单独一层：所有「文件在哪」「怎么原子写」的知识都收在这里，业务层（知识库 / 文档 / 检索）
//! 只调方法、不拼路径。路径穿越过滤（`get_kb_dir`）与「写在 kb 目录内」的校验（`validate_path_within`）
//! 也在这里 —— 安全判定与拼接放在一处才不会被绕过。

use std::collections::HashMap;
use std::path::PathBuf;
use turbovec::IdMapIndex;

use super::*;

impl VectorStoreManager {
    // ===== 索引加载 =====

    /// 加载所有已有知识库的索引到内存
    pub(crate) fn load_all_indices(&mut self) -> Result<(), String> {
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
    pub(crate) fn load_index_from_disk(&self, kb_id: &str) -> Result<IndexState, String> {
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
    ///
    /// ⚠️ 安全校验：确保 `index_path` 和 `chunk_map_path` 均在 `kb_dir` 下，
    /// 防止因调用方传入了意外路径导致数据写到错误位置。
    pub(crate) fn save_index_to_disk(kb_dir: &PathBuf, index_path: &PathBuf, chunk_map_path: &PathBuf, state: &IndexState) -> Result<(), String> {
        // 校验路径合法性 — 防止路径穿越
        Self::validate_path_within(kb_dir, index_path, "索引文件")?;
        Self::validate_path_within(kb_dir, chunk_map_path, "块映射文件")?;

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

    /// 校验 `sub_path` 是否以 `base_dir` 为前缀（防止路径穿越）
    ///
    /// 使用父目录的 canonicalize 做校验，因为 sub_path 本身可能尚不存在（首次写入时）。
    pub(crate) fn validate_path_within(base_dir: &PathBuf, sub_path: &PathBuf, label: &str) -> Result<(), String> {
        let canonical_base = base_dir
            .canonicalize()
            .map_err(|_| format!("{} 路径校验失败: 基础目录不存在 ({})", label, base_dir.display()))?;

        // sub_path 可能尚不存在，取其父目录做 canonicalize 校验
        let sub_parent = sub_path
            .parent()
            .ok_or_else(|| format!("{} 路径校验失败: 无法获取父目录", label))?;

        let canonical_parent = sub_parent
            .canonicalize()
            .map_err(|e| format!("{} 路径校验失败 (父目录): {}", label, e))?;

        if !canonical_parent.starts_with(&canonical_base) {
            return Err(format!(
                "{} 路径安全校验失败: 目标路径不在知识库目录下 ({} not under {})",
                label,
                canonical_parent.display(),
                canonical_base.display()
            ));
        }
        Ok(())
    }

    // ===== 路径辅助 =====

    /// 获取知识库目录路径（自动过滤 `kb_id` 中的危险字符，防止路径穿越）
    pub(crate) fn get_kb_dir(&self, kb_id: &str) -> PathBuf {
        // 只允许字母数字、短横线、下划线，移除所有可能路径穿越的字符（如 ../ 等）
        let safe_id: String = kb_id
            .chars()
            .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_')
            .collect();
        self.data_dir.join(format!("kb_{}", safe_id))
    }

    pub(crate) fn index_path(&self, kb_id: &str) -> PathBuf {
        self.get_kb_dir(kb_id).join("index.tvim")
    }

    pub(crate) fn chunk_map_path(&self, kb_id: &str) -> PathBuf {
        self.get_kb_dir(kb_id).join("chunk_map.json")
    }

    pub(crate) fn kb_meta_path(&self, kb_id: &str) -> PathBuf {
        self.get_kb_dir(kb_id).join("_metadata.json")
    }

    pub(crate) fn kb_docs_path(&self, kb_id: &str) -> PathBuf {
        self.get_kb_dir(kb_id).join("_documents.json")
    }

    // ===== 内部辅助 =====

    pub(crate) fn save_kb_metadata(&self, kb_id: &str, meta: &KnowledgeBaseMeta) -> Result<(), String> {
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

    pub(crate) fn load_kb_metadata(&self, kb_id: &str) -> Result<Option<KnowledgeBaseMeta>, String> {
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

    pub(crate) fn load_docs_index(&self, kb_id: &str) -> Result<Vec<DocumentInfo>, String> {
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

    pub(crate) fn save_docs_index(&self, kb_id: &str, docs: &[DocumentInfo]) -> Result<(), String> {
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
