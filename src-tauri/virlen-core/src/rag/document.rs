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
/// 不许另写一份 `pdf-extract` 调用）。
fn parse_pdf(file_path: &str) -> Result<(String, Option<u32>), String> {
    let bytes = std::fs::read(file_path).map_err(|e| format!("读取 PDF 失败: {}", e))?;
    let text = crate::doc_parse::pdf::extract_text(&bytes)
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

    let chunks = split_text_slices(text, max_chunk_size, chunk_overlap);

    let doc_name = doc.meta.file_name.clone();

    chunks
        .into_iter()
        .enumerate()
        .map(|(i, (content, overlap_prefix_chars))| DocumentChunk {
            id: format!("{}_{}", doc_id, i),
            document_id: doc_id.to_string(),
            document_name: doc_name.clone(),
            content,
            chunk_index: i,
            metadata: {
                let mut m = std::collections::HashMap::new();
                m.insert("file_type".into(), doc.meta.file_type.clone());
                m.insert("file_size".into(), doc.meta.file_size.to_string());
                m.insert(META_OVERLAP_PREFIX.into(), overlap_prefix_chars.to_string());
                m
            },
        })
        .collect()
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
fn split_text_slices(text: &str, max_chunk_size: usize, overlap: usize) -> Vec<(String, usize)> {
    // 收集所有字符的字节偏移 [byte_start, byte_end, ...]
    let char_boundaries: Vec<(usize, usize)> = text
        .char_indices()
        .map(|(i, c)| (i, i + c.len_utf8()))
        .collect();

    let char_count = char_boundaries.len();

    if char_count <= max_chunk_size {
        return vec![(text.to_string(), 0)];
    }

    let mut chunks: Vec<(String, usize)> = Vec::new();
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
        chunks.push((text[byte_start..byte_end].to_string(), overlap_prefix));
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
}
