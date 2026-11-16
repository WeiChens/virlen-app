//! 文档解析与分块
//!
//! 支持格式：
//! - PDF（`pdf-extract`；⚠️ 调用点在 `crate::doc_parse::pdf`，与 `parse_document` 工具同一份实现）
//! - Markdown（.md）
//! - 纯文本（.txt）

use std::path::Path;

/// 文档元数据
#[derive(Debug, Clone)]
pub struct DocumentMeta {
    pub id: String,
    pub file_name: String,
    pub file_type: String,
    pub file_size: u64,
    /// PDF 页数（仅 PDF 文件有此字段，当前未在前端展示，保留供后续使用）
    #[allow(dead_code)]
    pub page_count: Option<u32>,
}

/// 文档块 — 知识库的最小检索单元
#[derive(Debug, Clone)]
pub struct DocumentChunk {
    pub id: String,
    pub document_id: String,
    pub document_name: String,
    pub content: String,
    pub chunk_index: usize,
    pub metadata: std::collections::HashMap<String, String>,
}

/// 解析结果
#[derive(Debug)]
pub struct ParsedDocument {
    pub meta: DocumentMeta,
    pub text: String,
}

/// 解析文档文件，提取纯文本
pub fn parse_document(file_path: &str) -> Result<ParsedDocument, String> {
    let path = Path::new(file_path);
    if !path.exists() {
        return Err(format!("文件不存在: {}", file_path));
    }

    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    let file_size = std::fs::metadata(file_path)
        .map(|m| m.len())
        .unwrap_or(0);

    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    let (text, page_count) = match ext.as_str() {
        "pdf" => parse_pdf(file_path)?,
        "md" | "markdown" => (std::fs::read_to_string(file_path).map_err(|e| format!("读取文件失败: {}", e))?, None),
        "txt" => (std::fs::read_to_string(file_path).map_err(|e| format!("读取文件失败: {}", e))?, None),
        _ => return Err(format!("不支持的文件格式: .{}", ext)),
    };

    Ok(ParsedDocument {
        meta: DocumentMeta {
            id: uuid::Uuid::new_v4().to_string(),
            file_name,
            file_type: ext,
            file_size,
            page_count,
        },
        text,
    })
}

/// 从纯文本创建文档（不依赖文件系统）
///
/// 用于 AI 通过 Tool 直接写入知识库的场景。
/// 不需要实际文件存在，直接对文本内容进行分块和嵌入。
pub fn parse_text(text: &str, doc_name: &str) -> ParsedDocument {
    let file_size = text.len() as u64;
    ParsedDocument {
        meta: DocumentMeta {
            id: uuid::Uuid::new_v4().to_string(),
            file_name: doc_name.to_string(),
            file_type: "md".into(),
            file_size,
            page_count: None,
        },
        text: text.to_string(),
    }
}

/// 解析 PDF 文件
///
/// ⚠️ 抽文字的实现在 `crate::doc_parse::pdf`（工具 `parse_document` 与知识库导入共用一份，
/// 不许另写一份 `pdf-extract` 调用）；返回的是**按版面坐标重排**过的文字。
fn parse_pdf(file_path: &str) -> Result<(String, Option<u32>), String> {
    let bytes = std::fs::read(file_path).map_err(|e| format!("读取 PDF 失败: {}", e))?;
    let text = crate::doc_parse::pdf::extract_text(&bytes)
        .map(|out| out.text)
        .map_err(|e| format!("PDF 解析失败: {}", e))?;
    Ok((text, None))
}

/// 默认块大小（**字符**数）—— 知识库所有写入路径都传这一对常量，改就一起改
pub const CHUNK_MAX_CHARS: usize = 512;

/// 相邻块的默认重叠（**字符**数）—— 跨块的问题要能搜到，所以才需要重叠
pub const CHUNK_OVERLAP_CHARS: usize = 48;

/// 块元数据键：本块**开头**有多少字符是上一块结尾的重复（值是可解析为 `usize` 的字符串）
///
/// 为什么必须记下来：重叠是**检索**的需要，但「把整篇读出来」时必须能把它精确裁掉 ——
/// 读全文的三条出口（预览 / 编辑 / 导出）都基于 `get_document_content`。精确重叠长度只在
/// 分块这一刻才自然可得（`next_start = chunk_end - overlap`），事后再拿两块内容去比对前缀
/// 只能靠猜（重复文本上会多裁，正常文本上又可能少裁）。
pub const META_OVERLAP_PREFIX: &str = "overlap_prefix_chars";

/// 块元数据键：本块的**检索语境头**（文档名 + 所属章节 + 前后一句）
///
/// 两个用途，缺一不可：
/// 1. **嵌入口径**（[`embedding_text`]）：把语境与正文一起送进嵌入模型，也就是 Anthropic
///    Contextual Retrieval 的做法 —— 单独一句「每块最多 512 字符」的片段里往往看不出它讲的是
///    哪个文档的哪一节，召回率就是这么丢的；
/// 2. **模型可见口径**（`vector_store::query` 把它放进 `ChunkResult.context_header`，模型侧用
///    [`crate::rag::vector_store::ChunkResult::retrieved_text`] 拼起来看）：检索出来给模型的
///    那段文字与当初被嵌入的那段文字一致，模型不必再从片段内容里猜上下文。
///
/// ⚠️ 它**不进** `content`（块正文与 `ChunkResult.content` 都保持原文）：
/// `get_document_content`（预览 / 编辑 / 导出）靠按块拼接还原全文，正文里混入语境头就会把
/// 「原文」污染成「带标记的加工件」；界面的片段预览要的也是正文，不是语境头。
pub const META_CONTEXT_HEADER: &str = "context_header";

/// 语境头里「文档名」的最大字符数（文件名可能很长；同名片段跨库时靠它认来源）
const CONTEXT_DOC_NAME_MAX_CHARS: usize = 48;
/// 语境头里「章节」的最大字符数
const CONTEXT_SECTION_MAX_CHARS: usize = 28;
/// 语境头里「上一句 / 下一句」各自的最大字符数
const CONTEXT_SENTENCE_MAX_CHARS: usize = 36;
/// 语境头的总字符上限
///
/// ⚠️ 它会被**嵌进每一块**（默认块长 [`CHUNK_MAX_CHARS`] = 512）：200 字符相当于给正文加
/// 40% 的固定开销 —— 嵌入按 token 计费，检索回填也占模型上下文，每块都要付。
/// 160 配上上面的三段上限，正常情况下四段都放得下（不会总把「下文」砍掉）：
/// `〔语境〕(4) + 文档《…》(4+48) + ｜章节「…」(5+28) + ｜上文「…」(6+36) + ｜下文「…」(6+36)`。
const CONTEXT_HEADER_MAX_CHARS: usize = 160;
/// 往回找章节标题时最多看多少行（大文档里不必回溯到全文开头）
const CONTEXT_SECTION_SCAN_LINES: usize = 400;
/// 看「块自身是否以标题开头」时最多跳过开头多少行空白
const CONTEXT_SECTION_START_SCAN_LINES: usize = 3;
/// 找前后一句时取的最大窗口（字符）；整篇塞进 `Vec<char>` 在大文档上不划算
const CONTEXT_SENTENCE_WINDOW_CHARS: usize = 240;

/// 将文档文本分割成块
///
/// ⚠️ 是**字符**级分块，不是 token 级：每块最多 `max_chunk_size` 个字符，相邻块重叠
/// `chunk_overlap` 个字符（实现见 `split_text_slices`）。默认值见 [`CHUNK_MAX_CHARS`] /
/// [`CHUNK_OVERLAP_CHARS`]。
///
/// 每块都会在 `metadata` 里记下 [`META_OVERLAP_PREFIX`]（开头重复了多少字符），
/// `get_document_content` 据此把全文拼回来。
pub fn chunk_document(
    doc: &ParsedDocument,
    doc_id: &str,
    max_chunk_size: usize,
    chunk_overlap: usize,
) -> Vec<DocumentChunk> {
    let text = &doc.text;
    if text.trim().is_empty() {
        return Vec::new();
    }

    let chunks = split_text_spans(text, max_chunk_size, chunk_overlap);

    let doc_name = doc.meta.file_name.clone();

    chunks
        .into_iter()
        .enumerate()
        .map(|(i, span)| {
            let header = context_header(&doc_name, text, span.start_byte, span.end_byte);
            DocumentChunk {
                id: format!("{}_{}", doc_id, i),
                document_id: doc_id.to_string(),
                document_name: doc_name.clone(),
                content: span.content,
                chunk_index: i,
                metadata: {
                    let mut m = std::collections::HashMap::new();
                    m.insert("file_type".into(), doc.meta.file_type.clone());
                    m.insert("file_size".into(), doc.meta.file_size.to_string());
                    m.insert(
                        META_OVERLAP_PREFIX.into(),
                        span.overlap_prefix_chars.to_string(),
                    );
                    m.insert(META_CONTEXT_HEADER.into(), header);
                    m
                },
            }
        })
        .collect()
}

/// 送进嵌入模型的文本 = 语境头 + 空行 + 原文
///
/// 为什么嵌入与展示分成两份而不是把语境头直接写进 `content`：
/// - `content` 是**原文**，读全文（预览 / 编辑 / 导出）靠按块拼接还原，混入标记就还原不回去；
/// - 语境头是**检索用的加工件**，只要「被嵌入的文本」与「检索结果给模型看的文本」一致即可
///   （两处都走 [`context_header`] 的同一份产物），不必污染正文。
///
/// 老数据（没有 [`META_CONTEXT_HEADER`] 的块）原样返回 —— 行为与升级前一致。
pub fn embedding_text(chunk: &DocumentChunk) -> String {
    match chunk.metadata.get(META_CONTEXT_HEADER).map(|s| s.trim()) {
        Some(header) if !header.is_empty() => format!("{}\n\n{}", header, chunk.content),
        _ => chunk.content.clone(),
    }
}

/// 一块在原文里的位置（**字节**偏移，切片时不经过 `Vec<char>`）
struct ChunkSpan {
    content: String,
    overlap_prefix_chars: usize,
    start_byte: usize,
    end_byte: usize,
}

/// 生成一块的检索语境头：`〔语境〕文档《…》｜章节「…」｜上文「…」｜下文「…」`
///
/// 缺什么就省什么（PDF / 纯文本常常没有章节标题，那时只剩文档名与前后的句子）。
/// 长度上限见 [`CONTEXT_HEADER_MAX_CHARS`]：它是**每块**都要付的固定开销。
fn context_header(doc_name: &str, text: &str, start_byte: usize, end_byte: usize) -> String {
    let before = &text[..start_byte];
    let after = &text[end_byte..];

    let mut parts: Vec<String> = vec![format!(
        "文档《{}》",
        one_line(doc_name, CONTEXT_DOC_NAME_MAX_CHARS)
    )];
    // 先看块**自身**是不是以标题开头（首块之前没有文本，往回找永远是 None；
    // 而刚好切在标题处的块，这一行的标题对它而言比上文那节更准）
    let section =
        section_title_at_start(&text[start_byte..end_byte]).or_else(|| section_title(before));
    if let Some(section) = section {
        parts.push(format!("章节「{}」", section));
    }
    if let Some(prev) = last_sentence(tail_chars(before, CONTEXT_SENTENCE_WINDOW_CHARS)) {
        parts.push(format!(
            "上文「…{}」",
            one_line(prev, CONTEXT_SENTENCE_MAX_CHARS)
        ));
    }
    if let Some(next) = first_sentence(take_chars(after, CONTEXT_SENTENCE_WINDOW_CHARS)) {
        parts.push(format!(
            "下文「{}…」",
            one_line(next, CONTEXT_SENTENCE_MAX_CHARS)
        ));
    }

    clamp_chars(
        &format!("〔语境〕{}", parts.join("｜")),
        CONTEXT_HEADER_MAX_CHARS,
    )
}

/// 块**自身**是否以标题开头（首块 / 刚好切在标题处的块用）
///
/// 只看开头第一个**非空**行：是标题 / 章节标记就返回它，不是就直接 `None`（不继续往下找 ——
/// 「正文第 3 行出现了个标题」只说明这一块**跨越**了两个章节，拿它当整块的章节是误导）。
fn section_title_at_start(chunk_text: &str) -> Option<String> {
    for line in chunk_text.lines().take(CONTEXT_SECTION_START_SCAN_LINES) {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        return heading_text(t);
    }
    None
}

/// 向上文找**所属章节**：Markdown ATX 标题（`## 安装`）优先，其次中文 / 数字章节标记
///
/// 只认两种**无歧义**的结构标记，不去猜「短行可能是标题」——乱猜会把「运行 npm install」
/// 这种正文行当章节名，而语境头会跟着每一块进入嵌入，噪声代价是永久的。
/// 找不到就返回 `None`（PDF / 纯文本常见），此时语境头只剩文档名与前后句。
///
/// ⚠️ 只从块起点**往回**倒序看 [`CONTEXT_SECTION_SCAN_LINES`] 行 —— 不要 `collect()` 整段
/// 上文：那是每块一次的全量扫描，总代价 O(n²)（实测 3 MB 文档从 22 ms 变成 1.3 s，
/// 50 MB 的 PDF 会到分钟级）。`Lines` 是 `DoubleEndedIterator`，倒着取前 N 行是 O(N)。
fn section_title(before: &str) -> Option<String> {
    for line in before.lines().rev().take(CONTEXT_SECTION_SCAN_LINES) {
        if let Some(title) = heading_text(line) {
            return Some(title);
        }
    }
    None
}

/// 单行是否像「章节标题」：是则返回归一化后的标题
fn heading_text(line: &str) -> Option<String> {
    let t = line.trim();
    if t.is_empty() || t.chars().count() > 60 {
        return None;
    }

    // ① Markdown ATX 标题：1~6 个 `#` + **至少一个空白**。
    //    「#」后没空白的不算 —— 否则 `#!/bin/bash`、`#hashtag` 都会被当标题。
    if let Some(rest) = t.strip_prefix('#') {
        let hashes = 1 + rest.chars().take_while(|c| *c == '#').count();
        if hashes <= 6 {
            let after = &t[hashes..];
            if after.starts_with(char::is_whitespace) {
                let title = after.trim();
                if !title.is_empty() {
                    return Some(clamp_chars(title, CONTEXT_SECTION_MAX_CHARS));
                }
            }
        }
        return None;
    }

    // ② 中文 / 数字章节标记：「第三章 …」「1.2 配置」「一、概述」
    numbered_section(t)
}

/// 「第三章 / 第 3 节 …」「1.2 配置」「一、概述」这类结构标记
fn numbered_section(t: &str) -> Option<String> {
    let first = t.chars().next()?;

    // 中文序号开头：第 X 章 / 节 / 部分 / 篇 / 讲 / 课（允许「第 2 节」这种带空格的写法）
    if first == '第' {
        let rest = t['第'.len_utf8()..].trim_start();
        let mut digits = 0usize;
        let mut after_digits = 0usize;
        for (i, c) in rest.char_indices() {
            if c.is_ascii_digit() || "一二三四五六七八九十百千零〇两".contains(c) {
                digits += 1;
                if digits > 4 {
                    return None;
                }
                after_digits = i + c.len_utf8();
                continue;
            }
            break;
        }
        if digits == 0 {
            return None;
        }
        let tail = rest[after_digits..].trim_start();
        let mut chars = tail.chars();
        let marker = chars.next()?;
        if !"章节部分篇讲课".contains(marker) {
            return None;
        }
        let title = chars.as_str().trim();
        return (!title.is_empty()).then(|| clamp_chars(t, CONTEXT_SECTION_MAX_CHARS));
    }

    // 「一、概述」：单个中文数字 + 顿号 / 点
    if "一二三四五六七八九十".contains(first) {
        let rest = &t[first.len_utf8()..];
        if rest.starts_with('、') || rest.starts_with('．') || rest.starts_with('：') {
            let title = rest[rest.chars().next()?.len_utf8()..].trim();
            return (!title.is_empty()).then(|| clamp_chars(t, CONTEXT_SECTION_MAX_CHARS));
        }
        return None;
    }

    // 「1.2 配置」/「1 安装」：最多两段数字 + 空白（或顿号），且必须还有标题正文。
    //    三段以上（`1.0.3 修复`）当版本号，不当章节 —— 版本号不是章节，混进语境头只会误导检索。
    if first.is_ascii_digit() {
        let (head, tail) = match t.find(|c: char| c.is_whitespace() || c == '、') {
            Some(idx) => (
                &t[..idx],
                t[idx..].trim_start_matches(|c: char| c.is_whitespace() || c == '、'),
            ),
            None => return None,
        };
        let parts: Vec<&str> = head.split('.').collect();
        if parts.len() > 2
            || parts
                .iter()
                .any(|p| p.is_empty() || !p.chars().all(|c| c.is_ascii_digit()))
        {
            return None;
        }
        return (!tail.is_empty()).then(|| clamp_chars(t, CONTEXT_SECTION_MAX_CHARS));
    }

    None
}

/// `text` 里**最后一句**（不含句末标点；为空白时往前退一句）
fn last_sentence(text: &str) -> Option<&str> {
    let mut start = 0usize;
    let mut segments: Vec<&str> = Vec::new();
    let mut iter = text.char_indices().peekable();
    while let Some((i, ch)) = iter.next() {
        if is_sentence_end(ch, text, i) {
            segments.push(&text[start..i]);
            start = i + ch.len_utf8();
        }
    }
    segments.push(&text[start..]);
    segments
        .iter()
        .rev()
        .map(|s| s.trim())
        .find(|s| !s.is_empty())
}

/// `text` 里**第一句**（不含句末标点）
fn first_sentence(text: &str) -> Option<&str> {
    let mut start = 0usize;
    let mut segments: Vec<&str> = Vec::new();
    for (i, ch) in text.char_indices() {
        if is_sentence_end(ch, text, i) {
            segments.push(&text[start..i]);
            start = i + ch.len_utf8();
            if segments.len() >= 3 {
                // 已经够挑了：早停，别为了「第一句」扫完整个窗口
                break;
            }
        }
    }
    segments.push(&text[start..]);
    segments.iter().map(|s| s.trim()).find(|s| !s.is_empty())
}

/// 句末标点。`.` 只在后面是空白 / 结尾时算（避免 `v1.2`、`a.b` 被切开）
fn is_sentence_end(ch: char, text: &str, byte_idx: usize) -> bool {
    match ch {
        '。' | '！' | '？' | '!' | '?' | '；' | ';' | '\n' | '\r' => true,
        '.' => {
            let next = text[byte_idx + 1..].chars().next();
            next.map(|c| c.is_whitespace()).unwrap_or(true)
        }
        _ => false,
    }
}

/// 压成一行（换行 / 制表 / 连续空白 → 单个空格），并截到 `max` 字符
///
/// 语境头必须是**一行**：它是嵌入输入的一部分，也是检索结果里那行前置说明，
/// 带换行会把 `[片段 N] 来自：…` 的排版打散。
fn one_line(raw: &str, max: usize) -> String {
    let mut out = String::with_capacity(raw.len().min(max * 4));
    let mut prev_space = false;
    for c in raw.chars() {
        if c.is_whitespace() {
            if !prev_space && !out.is_empty() {
                out.push(' ');
            }
            prev_space = true;
        } else {
            if out.chars().count() >= max {
                break;
            }
            out.push(c);
            prev_space = false;
        }
    }
    out.trim().to_string()
}

/// 截到 `max` 字符（超出才截，末尾补省略号）
fn clamp_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// 取 `s` 开头 `n` 个字符（UTF-8 安全；不够长就整串）
fn take_chars(s: &str, n: usize) -> &str {
    match s.char_indices().nth(n) {
        Some((byte_idx, _)) => &s[..byte_idx],
        None => s,
    }
}

/// 取 `s` 末尾 `n` 个字符（UTF-8 安全；不够长就整串）
fn tail_chars(s: &str, n: usize) -> &str {
    let total = s.chars().count();
    if total <= n {
        return s;
    }
    match s.char_indices().nth(total - n) {
        Some((byte_idx, _)) => &s[byte_idx..],
        None => s,
    }
}

/// 基于字符数的文本分块（UTF-8 安全）—— 只要文本，重叠信息丢弃
///
/// ⚠️ 只给测试用：生产路径（`chunk_document`）要的是带重叠标记的块，走 `split_text_slices`。
///
/// `max_chunk_size` — 每块的最大**字符数**（不是字节数）
/// `overlap` — 相邻块的**字符**重叠数
#[cfg(test)]
fn split_text_by_chars(text: &str, max_chunk_size: usize, overlap: usize) -> Vec<String> {
    split_text_slices(text, max_chunk_size, overlap)
        .into_iter()
        .map(|(content, _)| content)
        .collect()
}

/// 基于字符数的文本分块，**并带出「本块开头与上一块重复了多少字符」**（UTF-8 安全）
///
/// `max_chunk_size` — 每块的最大**字符数**（不是字节数）
/// `overlap` — 相邻块的**字符**重叠数
///
/// 返回值第二项：本块开头与**上一块结尾**重复的字符数；首块恒为 0（没有上一块）。
/// 注意它与传入的 `overlap` 可能不同：分割点会向前贴到换行/句末，而「至少前进 1 个字符」
/// 的兜底也会把它压小 —— 所以调用方要的是这个**实际值**，不是参数值。
/// 同 [`split_text_spans`]，只保留 `(块内容, 重叠字符数)` —— **只给测试用**
///
/// 生产路径（`chunk_document`）走 `split_text_spans`：它还要每块在原文里的字节位置
/// 来生成语境头（见 [`META_CONTEXT_HEADER`]）。
#[cfg(test)]
fn split_text_slices(text: &str, max_chunk_size: usize, overlap: usize) -> Vec<(String, usize)> {
    split_text_spans(text, max_chunk_size, overlap)
        .into_iter()
        .map(|span| (span.content, span.overlap_prefix_chars))
        .collect()
}

/// 同 [`split_text_slices`]，但**带出每块在原文里的字节位置**（生成语境头要用它看前后文）
///
/// 位置信息只在切分的那一刻天然可得：事后再去 `text.find(chunk)` 找位置，重复文本上必然找错。
fn split_text_spans(text: &str, max_chunk_size: usize, overlap: usize) -> Vec<ChunkSpan> {
    // 收集所有字符的字节偏移 [byte_start, byte_end, ...]
    let char_boundaries: Vec<(usize, usize)> = text
        .char_indices()
        .map(|(i, c)| (i, i + c.len_utf8()))
        .collect();

    let char_count = char_boundaries.len();

    if char_count <= max_chunk_size {
        return vec![ChunkSpan {
            content: text.to_string(),
            overlap_prefix_chars: 0,
            start_byte: 0,
            end_byte: text.len(),
        }];
    }

    let mut chunks: Vec<ChunkSpan> = Vec::new();
    let mut start_char_idx = 0; // 当前块的起始字符索引
    let mut prev_end_char_idx: usize = 0; // 上一块的结束字符索引（= 本块起点的「无缝位置」）

    while start_char_idx < char_count {
        let end_char_idx = (start_char_idx + max_chunk_size).min(char_count);

        // 如果不是最后一块，尝试在最近的换行符或句末标点处断开
        let chunk_end_char_idx = if end_char_idx < char_count {
            // 在 [start_char_idx..end_char_idx] 范围内从后往前找分割点
            let mut split_at = end_char_idx;
            for i in (start_char_idx..end_char_idx).rev() {
                let (byte_start, byte_end) = char_boundaries[i];
                let ch = &text[byte_start..byte_end];
                if ch == "\n" || ch == "\r" {
                    split_at = i + 1; // 包含换行符
                    break;
                }
                if ch == "。" || ch == "." || ch == "！" || ch == "？" || ch == "!" || ch == "?" {
                    split_at = i + 1;
                    break;
                }
            }
            split_at
        } else {
            end_char_idx
        };

        // 确保有进展：如果分割点等于或小于起点，强制前进
        let chunk_end = if chunk_end_char_idx <= start_char_idx {
            // 强制至少前进一个字符（或到末尾）
            let next = (start_char_idx + 1).min(char_count);
            // 如果强制前进后已经到了末尾，直接取到末尾
            if next >= char_count {
                char_count
            } else {
                next
            }
        } else {
            chunk_end_char_idx
        };

        // 使用安全的字节索引获取切片
        let byte_start = char_boundaries[start_char_idx].0;
        let byte_end = if chunk_end < char_count {
            char_boundaries[chunk_end].0
        } else {
            text.len()
        };

        // 本块开头有多少字符是上一块结尾的重复：上一块的终点 - 本块起点（首块为 0）
        let overlap_prefix = prev_end_char_idx.saturating_sub(start_char_idx);
        chunks.push(ChunkSpan {
            content: text[byte_start..byte_end].to_string(),
            overlap_prefix_chars: overlap_prefix,
            start_byte: byte_start,
            end_byte: byte_end,
        });
        prev_end_char_idx = chunk_end;

        // 下一块起点
        if chunk_end >= char_count {
            break;
        }

        // 计算下一块起点，但确保至少前进 1 个字符
        let next_start = if chunk_end > overlap {
            chunk_end.saturating_sub(overlap)
        } else {
            chunk_end
        };

        start_char_idx = next_start.max(start_char_idx + 1);
    }

    chunks
}

#[cfg(test)]
mod tests {
    use super::*;

    // ============ 分块重叠标记（读全文时据此裁掉重复） ============

    /// 完整还原的证明：按每块报出的重叠长度裁掉开头，拼回去必须**逐字**等于原文
    ///
    /// ⚠️ 这就昰「分块重叠被当成正文读出来」那个 bug 的回归锁 —— 当初
    /// `get_document_content` 只是把块 `join` 起来，文本里会多出每处交界的 48 字符重复。
    #[test]
    fn test_overlap_prefix_allows_exact_reconstruction() {
        let text: String = (0..80)
            .map(|i| format!("第{}句：这是一段用于验证还原的文本。\n", i))
            .collect();
        let chunks = split_text_slices(&text, 50, 10);
        assert!(chunks.len() > 2, "样本要能切出多块，实际 {}", chunks.len());
        assert_eq!(chunks[0].1, 0, "首块没有上一块，重叠必须是 0");

        let mut rebuilt = String::new();
        for (i, (content, overlap)) in chunks.iter().enumerate() {
            if i == 0 {
                rebuilt.push_str(content);
                continue;
            }
            assert!(*overlap > 0, "第 {} 块应该有重叠", i);
            let rest: String = content.chars().skip(*overlap).collect();
            rebuilt.push_str(&rest);
        }
        assert_eq!(rebuilt, text, "裁掉重叠后必须还原原文");
    }

    /// 报出的重叠不能超过请求值（它只可能更小：分割点贴到换行/句末）
    #[test]
    fn test_overlap_prefix_never_exceeds_requested() {
        let text = "abcdefghij".repeat(40); // 高度重复的文本
        let chunks = split_text_slices(&text, 30, 5);
        assert!(chunks.len() > 2);
        for (content, overlap) in &chunks {
            assert!(*overlap <= 5, "实际 {}（块长 {}）", overlap, content.chars().count());
        }
    }

    /// 不分块的小文档：整体一块，重叠 0（不能因为加了标记就多出个空块）
    #[test]
    fn test_short_text_single_chunk_has_no_overlap() {
        let chunks = split_text_slices("短文本", 100, 10);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].0, "短文本");
        assert_eq!(chunks[0].1, 0);
    }

    // ==================== split_text_by_chars ====================

    #[test]
    fn test_split_text_by_chars() {
        let text = "这是第一段内容。\n这是第二段内容。\n这是第三段内容。";
        let chunks = split_text_by_chars(text, 10, 3);
        assert!(!chunks.is_empty());
        assert!(chunks.len() >= 2);
        // 验证所有块都是有效的 UTF-8
        for chunk in &chunks {
            assert!(std::str::from_utf8(chunk.as_bytes()).is_ok());
        }
    }

    #[test]
    fn test_split_text_by_chars_ascii() {
        let text = "Hello World!\n\nThis is a test document.\n\nWith multiple paragraphs.";
        let chunks = split_text_by_chars(text, 20, 5);
        assert!(!chunks.is_empty());
        assert!(chunks.len() >= 2);
    }

    #[test]
    fn test_split_text_by_chars_mixed() {
        let text = "Hello 你好 World 世界\nFoo Bar 中文测试";
        let chunks = split_text_by_chars(text, 10, 3);
        assert!(!chunks.is_empty());
        for chunk in &chunks {
            assert!(std::str::from_utf8(chunk.as_bytes()).is_ok());
        }
    }

    #[test]
    fn test_split_text_empty() {
        let chunks = split_text_by_chars("", 100, 10);
        assert_eq!(chunks, vec![""]);
    }

    #[test]
    fn test_split_text_shorter_than_chunk_size() {
        let text = "Short text";
        let chunks = split_text_by_chars(text, 100, 10);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0], "Short text");
    }

    #[test]
    fn test_split_text_exact_chunk_size() {
        let text = "1234567890"; // 10 chars
        let chunks = split_text_by_chars(text, 10, 2);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0], "1234567890");
    }

    #[test]
    fn test_split_text_many_small_chunks() {
        // 每个块5个字符，重叠2个，应产生多个块
        let text = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
        let chunks = split_text_by_chars(text, 5, 2);
        assert!(chunks.len() >= 5, "expected >=5 chunks, got {}", chunks.len());

        // 验证没有丢失或重复内容
        let mut combined = String::new();
        for chunk in &chunks {
            combined.push_str(chunk);
        }
        // 由于重叠，combined 会比原文本长，但应包含所有字符
        for c in text.chars() {
            assert!(combined.contains(c), "missing char {}", c);
        }
    }

    #[test]
    fn test_split_text_unicode_boundary_safety() {
        // 包含表情符号（4字节UTF-8）和中文（3字节）
        let text = "Hello 🌍 世界 🔥 Rust 语言 🚀 编程";
        let chunks = split_text_by_chars(text, 8, 2);
        assert!(!chunks.is_empty());
        for chunk in &chunks {
            // 验证每个块都是有效的 UTF-8
            assert!(std::str::from_utf8(chunk.as_bytes()).is_ok());
        }
        // 验证所有原始字符都在 chunks 中
        let combined: String = chunks.concat();
        for c in text.chars() {
            assert!(combined.contains(c), "char '{}' missing after split", c);
        }
    }

    #[test]
    fn test_split_text_only_newlines() {
        let text = "\n\n\n\n\n";
        let chunks = split_text_by_chars(text, 3, 1);
        assert!(!chunks.is_empty());
        // 所有块都应该是有效的
        for chunk in &chunks {
            assert!(std::str::from_utf8(chunk.as_bytes()).is_ok());
        }
    }

    #[test]
    fn test_split_text_chinese_punctuation() {
        // 应优先在中文标点处分割
        let text = "第一段内容。第二段内容！第三段内容？第四段内容";
        let chunks = split_text_by_chars(text, 10, 3);
        assert!(chunks.len() >= 3, "expected >=3 chunks, got {}", chunks.len());
        // 第一块应在标点处结束
        assert!(
            chunks[0].ends_with("。") || chunks[0].ends_with("！") || chunks[0].ends_with("？") || chunks[0].len() >= 10,
            "first chunk should end at punctuation or be full size"
        );
    }

    // ==================== chunk_document ====================

    #[test]
    fn test_chunk_document() {
        let doc = ParsedDocument {
            meta: DocumentMeta {
                id: "test-id".into(),
                file_name: "test.md".into(),
                file_type: "md".into(),
                file_size: 100,
                page_count: None,
            },
            text: "Hello World!\n\nThis is a test document.\n\nWith multiple paragraphs.".into(),
        };
        let chunks = chunk_document(&doc, "doc-1", 50, 10);
        assert!(!chunks.is_empty());
        assert_eq!(chunks[0].document_id, "doc-1");
        assert_eq!(chunks[0].chunk_index, 0);
    }

    #[test]
    fn test_chunk_document_empty_text() {
        let doc = ParsedDocument {
            meta: DocumentMeta {
                id: "empty-id".into(),
                file_name: "empty.md".into(),
                file_type: "md".into(),
                file_size: 0,
                page_count: None,
            },
            text: "".into(),
        };
        let chunks = chunk_document(&doc, "doc-empty", 100, 10);
        assert!(chunks.is_empty());
    }

    #[test]
    fn test_chunk_document_whitespace_only() {
        let doc = ParsedDocument {
            meta: DocumentMeta {
                id: "ws-id".into(),
                file_name: "whitespace.md".into(),
                file_type: "md".into(),
                file_size: 10,
                page_count: None,
            },
            text: "   \n\n  \t  ".into(),
        };
        let chunks = chunk_document(&doc, "doc-ws", 100, 10);
        assert!(chunks.is_empty());
    }

    #[test]
    fn test_chunk_document_chunk_ids_sequential() {
        let text = "A".repeat(1000); // 超长文本
        let doc = ParsedDocument {
            meta: DocumentMeta {
                id: "seq-id".into(),
                file_name: "long.txt".into(),
                file_type: "txt".into(),
                file_size: 1000,
                page_count: None,
            },
            text,
        };
        let chunks = chunk_document(&doc, "doc-seq", 100, 20);
        assert!(chunks.len() >= 8, "expected >=8 chunks for 1000 chars, got {}", chunks.len());
        for (i, chunk) in chunks.iter().enumerate() {
            assert_eq!(chunk.chunk_index, i);
            assert_eq!(chunk.document_id, "doc-seq");
            assert!(!chunk.content.is_empty());
        }
    }

    #[test]
    fn test_chunk_document_metadata_preserved() {
        let doc = ParsedDocument {
            meta: DocumentMeta {
                id: "meta-id".into(),
                file_name: "test.pdf".into(),
                file_type: "pdf".into(),
                file_size: 5000,
                page_count: Some(10),
            },
            text: "PDF content here. With multiple sentences across the document.".into(),
        };
        let chunks = chunk_document(&doc, "doc-meta", 100, 10);
        assert!(!chunks.is_empty());
        for chunk in &chunks {
            assert_eq!(chunk.metadata.get("file_type").unwrap(), "pdf");
            assert_eq!(chunk.metadata.get("file_size").unwrap(), "5000");
            assert_eq!(chunk.document_name, "test.pdf");
        }
    }

    // ==================== parse_text ====================

    #[test]
    fn test_parse_text_basic() {
        let parsed = parse_text("Hello World!", "my-doc.md");
        assert_eq!(parsed.meta.file_name, "my-doc.md");
        assert_eq!(parsed.meta.file_type, "md");
        assert_eq!(parsed.text, "Hello World!");
        assert!(parsed.meta.file_size > 0);
    }

    #[test]
    fn test_parse_text_large_content() {
        let content = "Content line\n".repeat(100);
        let parsed = parse_text(&content, "large-doc.txt");
        assert_eq!(parsed.text.len(), content.len());
        assert_eq!(parsed.meta.file_size as usize, content.len());
        assert_eq!(parsed.meta.file_name, "large-doc.txt");
    }

    #[test]
    fn test_parse_text_empty() {
        let parsed = parse_text("", "empty.md");
        assert_eq!(parsed.text, "");
        assert_eq!(parsed.meta.file_size, 0);
    }

    // ==================== 语境头（Contextual Retrieval） ====================

    fn doc_with(text: &str, name: &str) -> ParsedDocument {
        ParsedDocument {
            meta: DocumentMeta {
                id: "d".into(),
                file_name: name.into(),
                file_type: "md".into(),
                file_size: text.len() as u64,
                page_count: None,
            },
            text: text.to_string(),
        }
    }

    /// 章节识别：只认 Markdown ATX 标题与无歧义的章节标记
    #[test]
    fn heading_detection_only_takes_unambiguous_markers() {
        // Markdown 标题：抽出来的是**标题正文**（`##` 与空白不进语境头）
        assert_eq!(heading_text("## 安装").as_deref(), Some("安装"));
        assert_eq!(heading_text("#  快速开始  ").as_deref(), Some("快速开始"));
        // `#` 后没空白：shebang 与话题标签不是标题
        assert_eq!(heading_text("#!/bin/bash"), None);
        assert_eq!(heading_text("#hashtag"), None);
        // 正文不会被误当标题
        assert_eq!(heading_text("运行 npm install 即可"), None);
        assert_eq!(heading_text("这是一句普通的说明。"), None);

        // 中文 / 数字章节标记
        assert_eq!(heading_text("第三章 配置").as_deref(), Some("第三章 配置"));
        assert_eq!(heading_text("第 2 节 部署").as_deref(), Some("第 2 节 部署"));
        assert_eq!(heading_text("1.2 配置文件").as_deref(), Some("1.2 配置文件"));
        assert_eq!(heading_text("一、概述").as_deref(), Some("一、概述"));
        // 版本号 / 三级编号不是章节
        assert_eq!(heading_text("1.0.3 修复了一个 bug"), None);
        assert_eq!(heading_text("第一章"), None, "只有章号没有标题，不算");
    }

    /// 多块文档：每块都带文档名 + 所属章节 + 上文（多块时首块之后就有前文）
    #[test]
    fn chunks_carry_document_section_and_neighbour_sentences() {
        let text = "## 安装\n\n第一步是下载安装包。第二步是解压到指定目录。第三步是运行安装脚本。\n\n".repeat(12);
        let parsed = doc_with(&text, "手册.md");
        let chunks = chunk_document(&parsed, "doc-1", 120, 20);
        assert!(chunks.len() >= 2, "样本要能切出多块，实际 {}", chunks.len());

        let header = chunks[1]
            .metadata
            .get(META_CONTEXT_HEADER)
            .expect("每块都要有语境头");
        assert!(header.contains("文档《手册.md》"), "{header}");
        assert!(header.contains("章节「"), "{header}");
        assert!(header.contains("上文「"), "非首块应当有上文，{header}");
        // 头部必须是一行：带换行会把检索结果的排版打散
        assert!(!header.contains('\n'), "{header}");
        assert!(
            header.chars().count() <= CONTEXT_HEADER_MAX_CHARS,
            "语境头有总长上限，实际 {}",
            header.chars().count()
        );

        // 首块：没有上文（它在文首）
        let first = chunks[0].metadata.get(META_CONTEXT_HEADER).unwrap();
        assert!(first.contains("文档《手册.md》"), "{first}");
        assert!(!first.contains("上文「"), "{first}");

        // 正文本身不得被污染（读全文靠按块拼回原文）
        assert!(!chunks[1].content.contains("〔语境〕"));
    }

    /// 没有任何章节标记的纯文本：只剩文档名 + 前后句，不编造章节
    #[test]
    fn plain_text_without_markers_has_no_section() {
        let text = "这是一段很长的说明文字，没有任何标题。".repeat(20);
        let parsed = doc_with(&text, "notes.txt");
        let chunks = chunk_document(&parsed, "doc-2", 80, 10);
        let header = chunks[1].metadata.get(META_CONTEXT_HEADER).unwrap();
        assert!(header.contains("文档《notes.txt》"), "{header}");
        assert!(!header.contains("章节「"), "没有标题就不该编一个：{header}");
    }

    /// 嵌入口径 = 语境头 + 原文；`content` 保持原文（逐字），供还原全文
    #[test]
    fn embedding_text_prefixes_the_header_without_touching_the_content() {
        let text = "## 部署\n\n先把服务停掉，再替换二进制。".repeat(8);
        let parsed = doc_with(&text, "ops.md");
        let chunks = chunk_document(&parsed, "doc-3", 100, 20);
        let chunk = &chunks[0];

        let embedded = embedding_text(chunk);
        assert!(embedded.starts_with("〔语境〕"), "{embedded}");
        assert!(embedded.ends_with(&chunk.content));
        // content 本身不带语境头（否则 get_document_content 会把标记当成正文读出来）
        assert!(!chunk.content.contains("〔语境〕"));

        // 老数据（没有这个元数据键）原样返回
        let legacy = DocumentChunk {
            metadata: std::collections::HashMap::new(),
            ..chunk.clone()
        };
        assert_eq!(embedding_text(&legacy), legacy.content);
    }

    /// 首块以标题开头 → 那一行就是它的章节（往回找是找不到的：之前没有文本）
    #[test]
    fn first_chunk_takes_the_heading_it_starts_with() {
        let parsed = doc_with("# 安装\n\n先把包下下来，再解压到目录里。\n", "guide.md");
        let chunks = chunk_document(&parsed, "doc-6", 200, 20);
        let header = chunks[0].metadata.get(META_CONTEXT_HEADER).unwrap();
        assert!(header.contains("章节「安装」"), "{header}");

        // 块自带的标题**优先于**「上文那一节的标题」：它比上文那节更贴这一块。
        // （这里直接锁判定函数：切点是否刚好落在标题处取决于块长与标点，
        //   用整篇文档去碰那个切点只会得到一条脆弱用例）
        assert_eq!(
            section_title_at_start("## 第二节\n\n后续内容。").as_deref(),
            Some("第二节")
        );
        // 开头是空行也算「以标题开头」；但正文行开头不是
        assert_eq!(section_title_at_start("\n\n3 部署\n步骤").as_deref(), Some("3 部署"));
        assert_eq!(section_title_at_start("正文\n\n## 后面的标题"), None);
    }

    /// 不看「块中间出现的标题」：那一块跨越了两个章节，拿后者当整块的章节是误导
    #[test]
    fn a_heading_in_the_middle_of_a_chunk_is_not_the_section() {
        let parsed = doc_with("正文第一行。\n\n## 后面的标题\n\n更多正文。", "mixed.md");
        let chunks = chunk_document(&parsed, "doc-8", 400, 20);
        assert_eq!(chunks.len(), 1);
        let header = chunks[0].metadata.get(META_CONTEXT_HEADER).unwrap();
        assert!(!header.contains("章节「"), "块不是以标题开头的：{header}");
    }

    /// 语境头的固定开销有上限：文档名很长时也不会把正文的比重挤没（≤ CONTEXT_HEADER_MAX_CHARS）
    #[test]
    fn long_document_name_is_clamped_in_the_header() {
        let name = format!("{}.md", "very-long-file-name-".repeat(10));
        let text = format!("## 章\n\n{}", "这是一段用于验证上限的正文。".repeat(40));
        let parsed = doc_with(&text, &name);
        let chunks = chunk_document(&parsed, "doc-9", 100, 10);
        for chunk in &chunks {
            let header = chunk.metadata.get(META_CONTEXT_HEADER).unwrap();
            assert!(
                header.chars().count() <= CONTEXT_HEADER_MAX_CHARS,
                "语境头必须受总长上限管着，实际 {}：{header}",
                header.chars().count()
            );
            assert!(
                !header.contains(&name),
                "超长文档名要被截短，不能整串进头里"
            );
        }
    }

    /// 单块短文也有语境头（至少带文档名：同名片段跨库时不至于认不出来源）
    #[test]
    fn single_chunk_document_still_has_the_document_name() {
        let parsed = doc_with("短短一句话。", "tiny.md");
        let chunks = chunk_document(&parsed, "doc-4", 100, 10);
        assert_eq!(chunks.len(), 1);
        let header = chunks[0].metadata.get(META_CONTEXT_HEADER).unwrap();
        assert_eq!(header, "〔语境〕文档《tiny.md》");
    }

    /// 语境头不得把重叠标记挤掉（两个元数据各自独立，读全文仍逐字还原）
    #[test]
    fn context_header_does_not_break_exact_reconstruction() {
        let text: String = (0..60).map(|i| format!("第{}句：用于验证还原。\n", i)).collect();
        let parsed = doc_with(&text, "recon.md");
        let chunks = chunk_document(&parsed, "doc-5", 50, 10);

        let mut rebuilt = String::new();
        for (i, chunk) in chunks.iter().enumerate() {
            let overlap: usize = chunk
                .metadata
                .get(META_OVERLAP_PREFIX)
                .unwrap()
                .parse()
                .unwrap();
            if i == 0 {
                rebuilt.push_str(&chunk.content);
            } else {
                rebuilt.extend(chunk.content.chars().skip(overlap));
            }
        }
        assert_eq!(rebuilt, text, "语境头不得混进块正文，否则读全文会多出标记");
    }
}
