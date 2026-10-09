//! CSV / TSV —— 用 `csv` 解析后**规范化重写**，让模型看到一份稳定的逗号分隔文本。
//!
//! 为什么不是「原样返回解码后的文本」：
//! - 分隔符不统一（`;` / `\t` / `|` 都有人用），模型要自己猜；
//! - 带引号的多行字段会把「一行 = 一条记录」这个直觉打破。
//!
//! 规范化只做两件事：**嗅探分隔符 → 统一按 CSV 重写**（引号风格由 `csv` 自己决定，
//! 字段内真含逗号 / 换行时它仍会加引号）。`csv` 对畸形输入很宽容（未闭合引号当一条记录收下，
//! 正文不丢）；真遇到它拒收的输入时**不报错**，回退成解码后的原文并在 `note` 里说明 ——
//! 坏文件照样有可读内容，报错反而丢掉它。

use super::text::decode_text;

/// 规范化后的文本 + 一条需要让模型知道的说明
#[derive(Debug, Clone)]
pub struct DelimitedText {
    pub text: String,
    pub note: Option<String>,
}

/// 解析 CSV / TSV（`ext` 只用来定默认分隔符：`tsv` 用制表符）
pub fn extract_text(bytes: &[u8], ext: &str) -> Result<DelimitedText, String> {
    let raw = decode_text(bytes).ok_or_else(|| {
        "the file is not decodable text (UTF-8 / GB18030 / BIG5 / Shift_JIS all failed)".to_string()
    })?;

    let delimiter = if ext.eq_ignore_ascii_case("tsv") {
        b'\t'
    } else {
        sniff_delimiter(&raw)
    };

    match normalize(&raw, delimiter) {
        Ok(text) => Ok(DelimitedText { text, note: None }),
        Err(e) => Ok(DelimitedText {
            text: raw,
            note: Some(format!(
                "the file could not be parsed as CSV ({e}); returning the raw text instead"
            )),
        }),
    }
}

/// 嗅探分隔符：取第一条非空行里出现次数最多的那个（都很少 → 逗号）
fn sniff_delimiter(text: &str) -> u8 {
    let first_line = text.lines().find(|l| !l.trim().is_empty()).unwrap_or("");
    let line: String = first_line.chars().take(4096).collect();
    let count = |c: char| line.matches(c).count();
    let candidates = [(b',', count(',')), (b';', count(';')), (b'\t', count('\t')), (b'|', count('|'))];
    let mut best = (b',', 0usize);
    for (d, n) in candidates {
        if n > best.1 {
            best = (d, n);
        }
    }
    best.0
}

/// 按嗅探到的分隔符解析，再统一写成 CSV
fn normalize(raw: &str, delimiter: u8) -> Result<String, String> {
    let mut reader = csv::ReaderBuilder::new()
        .delimiter(delimiter)
        .has_headers(false)
        .flexible(true) // 每行列数不齐是常态（表格数据常有空尾列），不当错误
        .from_reader(raw.as_bytes());

    let mut writer = csv::WriterBuilder::new()
        .quote_style(csv::QuoteStyle::Necessary)
        .from_writer(Vec::new());

    for record in reader.records() {
        let record = record.map_err(|e| e.to_string())?;
        writer
            .write_record(record.iter())
            .map_err(|e| e.to_string())?;
    }

    let bytes = writer.into_inner().map_err(|e| e.to_string())?;
    String::from_utf8(bytes).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn comma_csv_keeps_rows_and_quotes_fields_with_commas() {
        let out = extract_text(b"a,b\n\"x,y\",2\n", "csv").unwrap();
        assert!(out.note.is_none());
        let lines: Vec<&str> = out.text.trim_end().lines().collect();
        assert_eq!(lines, vec!["a,b", "\"x,y\",2"]);
    }

    #[test]
    fn semicolon_csv_is_normalized_to_commas() {
        let out = extract_text("姓名;年龄\n张三;30\n".as_bytes(), "csv").unwrap();
        assert_eq!(
            out.text.trim_end().lines().collect::<Vec<_>>(),
            vec!["姓名,年龄", "张三,30"]
        );
    }

    #[test]
    fn tsv_is_parsed_with_tabs_regardless_of_content() {
        let out = extract_text(b"a\tb\n1\t2\n", "tsv").unwrap();
        assert_eq!(out.text, "a,b\n1,2\n");
    }

    /// 引号里的换行属于同一条记录：规范化后必须仍是**一条**
    #[test]
    fn quoted_newlines_stay_in_one_record() {
        let out = extract_text(b"a,\"line1\nline2\"\n", "csv").unwrap();
        assert_eq!(out.text, "a,\"line1\nline2\"\n");
        assert_eq!(out.text.matches("line1").count(), 1);
    }

    #[test]
    fn gbk_csv_is_decoded_before_parsing() {
        // “中文,一\n” 的 GBK 编码
        let bytes = [0xd6, 0xd0, 0xce, 0xc4, b',', 0xd2, 0xbb, b'\n'];
        let out = extract_text(&bytes, "csv").unwrap();
        assert_eq!(out.text, "中文,一\n");
    }

    /// 未闭合引号 / 少列这类「坏文件」：`csv` 本身很宽容（当一条记录解析，正文一字不丢），
    /// 所以这里验的是「内容不丢」，而不是「一定走回退」—— 回退分支是为库将来变严格留的安全网。
    #[test]
    fn broken_quoting_never_loses_content() {
        let out = extract_text(b"a,\"unterminated\n", "csv").unwrap();
        assert!(out.text.starts_with("a,"), "实际：{:?}", out.text);
        assert!(out.text.contains("unterminated"), "实际：{:?}", out.text);
    }

    #[test]
    fn binary_input_is_refused() {
        let err = extract_text(&[0x89, 0x50, 0x4e, 0x47, 0x00, 0xff], "csv").unwrap_err();
        assert!(err.contains("not decodable text"), "{err}");
    }

    #[test]
    fn empty_file_yields_empty_text() {
        let out = extract_text(b"", "csv").unwrap();
        assert!(out.text.is_empty());
    }
}
