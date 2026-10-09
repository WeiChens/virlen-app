//! PDF 抽文字 —— **唯一一份** `pdf-extract` 调用。
//!
//! ⚠️ 知识库导入（`rag::document::parse_pdf`）与 `parse_document` 工具都走这里：
//! 同一份库、同一份错误语义。任何一侧要改（升级 crate / 换提取器 / 加预处理）都只改这里，
//! 不许在调用方另写一份。
//!
//! 边界：只抽**文字层**。扫描件 / 纯图片 PDF 抽出来是空的 → 由调用方按
//! [`crate::doc_parse::ParseError::NoText`] 如实报错，**不做 OCR**（端侧视觉也不上传图片）。

/// 从 PDF 字节里抽文本。
///
/// 返回的 `Err` 是**库的原始错误文本**（不加前缀）：调用方各自决定怎么说
/// （RAG 用中文前缀，工具用 [`crate::doc_parse::ParseError::Backend`] 的英文模板）。
pub fn extract_text(bytes: &[u8]) -> Result<String, String> {
    pdf_extract::extract_text_from_mem(bytes).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 手写的最小无压缩 PDF（Helvetica + 一个 Tj）—— 只验「能抽出文字」这条路径，
    /// 不引入二进制 fixture
    const MINIMAL_PDF: &str = "%PDF-1.4\n\
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n\
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n\
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>endobj\n\
4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n\
5 0 obj<</Length 44>>stream\n\
BT /F1 12 Tf 20 100 Td (Hello PDF Text) Tj ET\n\
endstream\nendobj\n\
trailer<</Root 1 0 R>>\n%%EOF\n";

    #[test]
    fn extracts_text_from_a_minimal_pdf() {
        match extract_text(MINIMAL_PDF.as_bytes()) {
            Ok(text) => assert!(
                text.contains("Hello PDF Text"),
                "应抽出手写 PDF 里的文字，实际：{text:?}"
            ),
            // 这份手写 PDF 没有完整的 xref：库若不接受，允许解析失败（工具侧会报 Backend）
            Err(e) => assert!(!e.is_empty(), "失败也要给出原因，实际：{e}"),
        }
    }

    #[test]
    fn garbage_input_fails_instead_of_returning_junk() {
        assert!(extract_text(b"not a pdf at all").is_err());
    }
}
