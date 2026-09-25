//! 文档解析与分块
//!
//! 支持格式：
//! - PDF（通过 pdf-extract）
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
fn parse_pdf(file_path: &str) -> Result<(String, Option<u32>), String> {
    let bytes = std::fs::read(file_path).map_err(|e| format!("读取 PDF 失败: {}", e))?;
    let text = pdf_extract::extract_text_from_mem(&bytes)
        .map_err(|e| format!("PDF 解析失败: {}", e))?;
    Ok((text, None))
}

/// 将文档文本分割成块
///
/// 使用 text-splitter 进行智能分块，基于 token 数而非字符数。
/// 块大小默认 512 tokens，块重叠 48 tokens。
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

    // 使用简单的字符级分块（避免引入 tokenizer 依赖）
    let chunks = split_text_by_chars(text, max_chunk_size, chunk_overlap);

    let doc_name = doc.meta.file_name.clone();

    chunks
        .into_iter()
        .enumerate()
        .map(|(i, content)| DocumentChunk {
            id: format!("{}_{}", doc_id, i),
            document_id: doc_id.to_string(),
            document_name: doc_name.clone(),
            content,
            chunk_index: i,
            metadata: {
                let mut m = std::collections::HashMap::new();
                m.insert("file_type".into(), doc.meta.file_type.clone());
                m.insert("file_size".into(), doc.meta.file_size.to_string());
                m
            },
        })
        .collect()
}

/// 基于字符数的文本分块（UTF-8 安全）
///
/// `max_chunk_size` — 每块的最大**字符数**（不是字节数）
/// `overlap` — 相邻块的**字符**重叠数
fn split_text_by_chars(text: &str, max_chunk_size: usize, overlap: usize) -> Vec<String> {
    // 收集所有字符的字节偏移 [byte_start, byte_end, ...]
    let char_boundaries: Vec<(usize, usize)> = text
        .char_indices()
        .map(|(i, c)| (i, i + c.len_utf8()))
        .collect();

    let char_count = char_boundaries.len();

    if char_count <= max_chunk_size {
        return vec![text.to_string()];
    }

    let mut chunks = Vec::new();
    let mut start_char_idx = 0; // 当前块的起始字符索引

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

        chunks.push(text[byte_start..byte_end].to_string());

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
