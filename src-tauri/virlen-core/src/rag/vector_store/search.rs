//! 检索与导出 —— 向量检索（`query`）、内容匹配（`search_documents_content`）与 zip 导出

use std::collections::HashMap;

use std::io::Write;

use super::*;

impl VectorStoreManager {
    // ===== 检索 =====

    /// 模糊搜索文档内容 — 在知识库所有 chunk 中匹配关键词，返回匹配的文档 ID 列表（去重）
    ///
    /// 用于前端"搜索内容"功能，不依赖向量嵌入，直接做文本包含匹配。
    pub fn search_documents_content(
        &self,
        kb_id: &str,
        keyword: &str,
    ) -> Result<Vec<String>, String> {
        let state = self
            .indices
            .get(kb_id)
            .ok_or_else(|| format!("知识库不存在: {}", kb_id))?;

        if state.chunks.is_empty() {
            return Ok(Vec::new());
        }

        let lower_keyword = keyword.to_lowercase();
        let mut matched_doc_ids: Vec<String> = state
            .chunks
            .values()
            .filter(|info| info.content.to_lowercase().contains(&lower_keyword))
            .map(|info| info.document_id.clone())
            .collect();

        // 去重并保持顺序
        matched_doc_ids.sort();
        matched_doc_ids.dedup();

        Ok(matched_doc_ids)
    }

    /// 将知识库中的所有文档导出为 ZIP 文件
    ///
    /// - 文档名中的 `/` 会转换为嵌套文件夹
    /// - 特殊字符（非字母数字、非中文、非 `.` `-` `_` `空格`）被移除
    /// - 同名文件自动重命名为 `name(n).ext`
    pub fn export_to_zip(&self, kb_id: &str, output_path: &str) -> Result<(), String> {
        let docs = self.list_documents(kb_id)?;
        if docs.is_empty() {
            return Err("知识库中没有文档".to_string());
        }

        let file = std::fs::File::create(output_path)
            .map_err(|e| format!("创建 ZIP 文件失败: {}", e))?;
        let mut zip_writer = zip::ZipWriter::new(file);

        let mut used_names: HashMap<String, usize> = HashMap::new();

        for doc in &docs {
            let content = self.get_document_content(kb_id, &doc.id)?;

            // 1. 清理文件名中的特殊字符
            let raw_name = doc.file_name.replace('\\', "/");
            let cleaned = Self::sanitize_zip_path(&raw_name);

            if cleaned.is_empty() {
                continue;
            }

            // 2. 处理重名
            let final_name = Self::dedup_name(&cleaned, &mut used_names);

            // 3. 写入 ZIP
            let options: zip::write::FileOptions<'_, ()> = zip::write::FileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            zip_writer
                .start_file(&final_name, options)
                .map_err(|e| format!("添加 ZIP 条目失败: {}", e))?;
            zip_writer
                .write_all(content.as_bytes())
                .map_err(|e| format!("写入 ZIP 条目失败: {}", e))?;
        }

        zip_writer
            .finish()
            .map_err(|e| format!("ZIP 写入完成失败: {}", e))?;

        Ok(())
    }

    /// 清理路径中的特殊字符，保留字母数字中文 `.` `-` `_` `/` 和空格
    pub(crate) fn sanitize_zip_path(path: &str) -> String {
        let result: String = path
            .chars()
            .map(|c| {
                if c.is_alphanumeric()
                    || c == '/'
                    || c == '.'
                    || c == '-'
                    || c == '_'
                    || c == ' '
                    || c > '\u{00FF}'
                {
                    c
                } else {
                    ' ' // 占位，后续压缩
                }
            })
            .collect::<String>();

        // 压缩连续空格、移除首尾空格
        let mut cleaned = String::with_capacity(result.len());
        let mut prev_space = false;
        for c in result.chars() {
            if c == ' ' {
                if !prev_space {
                    cleaned.push(c);
                }
                prev_space = true;
            } else {
                cleaned.push(c);
                prev_space = false;
            }
        }

        cleaned.trim().to_string()
    }

    /// 处理重名：如果 name 已存在，追加 `(n)` 后缀
    pub(crate) fn dedup_name(
        name: &str,
        used: &mut HashMap<String, usize>,
    ) -> String {
        // 如果名称中有路径分隔符，只对文件名部分去重
        if let Some((dir, file)) = name.rsplit_once('/') {
            let deduped_file = Self::dedup_filename(file, used);
            return format!("{}/{}", dir, deduped_file);
        }

        Self::dedup_filename(name, used)
    }

    /// 对单个文件名去重
    pub(crate) fn dedup_filename(
        name: &str,
        used: &mut HashMap<String, usize>,
    ) -> String {
        if !used.contains_key(name) {
            used.insert(name.to_string(), 0);
            return name.to_string();
        }

        let count = used.get(name).unwrap() + 1;
        used.insert(name.to_string(), count);

        // 在扩展名前插入 `(n)`
        if let Some(dot_pos) = name.rfind('.') {
            let base = &name[..dot_pos];
            let ext = &name[dot_pos..];
            format!("{}({}){}", base, count, ext)
        } else {
            format!("{}({})", name, count)
        }
    }

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
}
