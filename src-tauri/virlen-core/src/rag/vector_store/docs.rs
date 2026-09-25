//! 文档管理 —— 增 / 删 / 改 / 列 / 取正文（向量索引与文档索引的同步也在这里）

use crate::rag::document::DocumentChunk;
use std::collections::HashMap;
use turbovec::IdMapIndex;

use super::*;

impl VectorStoreManager {
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
}
