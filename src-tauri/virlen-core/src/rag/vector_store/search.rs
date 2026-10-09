//! 检索与归档 —— 向量检索（`query`）、内容匹配（`search_documents_content`）与 zip 导出 / 读取
//!
//! 压缩包的**导入**由命令层逐条驱动（`commands/rag.rs` 的 `read_knowledge_base_zip_entry`）：
//! 一条一条读、一条一条入库，界面才能显示进度、随时取消。这里只负责「看」与「读」——
//! [`VectorStoreManager::zip_entry_names`] 列出会导入的条目名，
//! [`VectorStoreManager::read_zip_entry`] 读其中一条的正文。
//!
//! 与「选文件夹」那条导入路径的差别（见 `rag::import_scan`）：包里的条目**一律当纯文本**入库
//!（导出写的就是解析后的文本，`manual.pdf` 这样的名字只是个名字），所以这里不嗅探内容，
//! 只有 `.gitignore` + 2 MB 大小上限两条规则。

use std::collections::HashMap;

use std::io::{Read, Write};

use crate::rag::import_scan::{IgnoreLayers, MAX_TEXT_FILE_BYTES};

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

    /// 列出压缩包里会导入的条目名（只读中央目录，不解压内容）
    ///
    /// 给「导入前先说清会覆盖哪几份」用，也是逐条导入时前端循环的名单 —— 所以这里的过滤规则
    /// 必须与 [`Self::read_zip_entry`] 一致（同一套 [`Self::normalize_zip_entry_name`]）。
    ///
    /// 两条过滤规则：
    /// - 包内若带 `.gitignore`（用户把自己打的包拿来导入），按其规则排除条目 —— 与文件夹导入同一套口径
    ///   （见 `rag::import_scan`），`ignored` 就是被它排掉的那几条；
    /// - 条目超过 [`MAX_TEXT_FILE_BYTES`]（2 MB）不收（中央目录里就有大小，不用解压就知道）——
    ///   与文件夹导入的文本上限同一个值。
    pub fn zip_entry_names(zip_path: &str) -> Result<ZipPreview, String> {
        let mut archive = Self::open_zip(zip_path)?;

        let mut candidates: Vec<(String, u64)> = Vec::new();
        let mut sources: Vec<(String, String)> = Vec::new();
        for i in 0..archive.len() {
            let mut entry = archive
                .by_index(i)
                .map_err(|e| format!("读取压缩包条目失败: {}", e))?;
            if entry.is_dir() {
                continue;
            }
            let raw = entry.name().replace('\\', "/");
            // .gitignore 是规则来源，不入库（[`Self::normalize_zip_entry_name`] 也会把点文件挡掉）
            if raw.rsplit('/').next() == Some(".gitignore") {
                let dir = raw.strip_suffix(".gitignore").unwrap_or("");
                let dir = dir.trim_end_matches('/').trim_start_matches('/').to_string();
                // 读不出来（非 UTF-8 / 太大）就当这份规则不存在，不打断整次导入
                if let Ok(content) = read_entry_text(&mut entry, ".gitignore") {
                    sources.push((dir, content));
                }
                continue;
            }
            // 大小从中央目录就能拿到，不必读条目内容
            let size = entry.size();
            if let Some(name) = Self::normalize_zip_entry_name(&raw) {
                candidates.push((name, size));
            }
        }

        let layers = IgnoreLayers::from_sources(sources);
        let mut preview = ZipPreview::default();
        for (name, size) in candidates {
            // 先听 .gitignore 的（用户明确说过不要的东西，不该被别的理由改写），再看大小
            if layers.is_ignored(&name, false) {
                preview.ignored += 1;
            } else if size > MAX_TEXT_FILE_BYTES {
                preview.too_large += 1;
            } else {
                preview.names.push(name);
            }
        }
        Ok(preview)
    }

    /// 读压缩包里的一个条目（条目名按 [`Self::normalize_zip_entry_name`] 归一后比对）
    ///
    /// `Err` 的三种情形（非 UTF-8 / 太大 / 找不到）都带中文原因，调用方直接显示给用户 ——
    /// 逐条导入时这就是那一条「为什么没进来」。
    pub fn read_zip_entry(zip_path: &str, entry_name: &str) -> Result<String, String> {
        let mut archive = Self::open_zip(zip_path)?;
        for i in 0..archive.len() {
            let mut entry = archive
                .by_index(i)
                .map_err(|e| format!("读取压缩包条目失败: {}", e))?;
            if entry.is_dir() {
                continue;
            }
            if Self::normalize_zip_entry_name(entry.name()).as_deref() == Some(entry_name) {
                return read_entry_text(&mut entry, entry_name);
            }
        }
        Err(format!("压缩包里找不到「{}」", entry_name))
    }

    /// 打开压缩包（三处入口共用，错误文案一致）
    fn open_zip(zip_path: &str) -> Result<zip::ZipArchive<std::fs::File>, String> {
        let file = std::fs::File::open(zip_path).map_err(|e| format!("打开压缩包失败: {}", e))?;
        zip::ZipArchive::new(file).map_err(|e| format!("读取压缩包失败: {}", e))
    }

    /// 压缩包条目名 → 文档名（`None` = 这个条目不该入库）
    ///
    /// 过滤：目录、空名、隐藏文件 / 系统垃圾（`.DS_Store`、`__MACOSX/…`、`Thumbs.db`），
    /// 并把 Windows 风格的 `\` 归一成 `/`（跨平台压缩包常见）。
    pub(crate) fn normalize_zip_entry_name(raw: &str) -> Option<String> {
        let name = raw.replace('\\', "/");
        let name = name.trim().trim_start_matches('/');
        if name.is_empty() {
            return None;
        }
        let leaf = name.rsplit('/').next().unwrap_or(name);
        if leaf.starts_with('.') || leaf.eq_ignore_ascii_case("Thumbs.db") {
            return None;
        }
        if name.starts_with("__MACOSX/") {
            return None;
        }
        Some(name.to_string())
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

/// 读一个 zip 条目为文本（`.gitignore` 与文档条目共用）
///
/// 三道护栏：
/// - `take(文本上限 + 1)`：条目头写的尺寸可能是假的（zip bomb 的常见手法），实际读多少算多少；
///   上限就是 [`MAX_TEXT_FILE_BYTES`]（2 MB）—— 与预览名单同一把尺，预览没列进来的条目，
///   就算有人直接调命令也读不出东西；
/// - 只收 UTF-8：非 UTF-8 = 原始文件被整包塞进来了（比如用户自己把 PDF 打包进去），
///   这类要报错让用户看见，而不是当文本硬解成乱码。
fn read_entry_text<R: Read>(reader: &mut R, label: &str) -> Result<String, String> {
    let mut bytes = Vec::new();
    reader
        .take(MAX_TEXT_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("读「{}」时出错：{}", label, e))?;
    if bytes.len() as u64 > MAX_TEXT_FILE_BYTES {
        return Err(format!("「{}」太大了，没有读进来", label));
    }
    String::from_utf8(bytes)
        .map_err(|_| format!("「{}」不是文本（可能是二进制文件），没有读进来", label))
}
