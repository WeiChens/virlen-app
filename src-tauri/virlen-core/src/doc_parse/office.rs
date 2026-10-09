//! Office 文档抽文字（`.docx` / `.doc` / `.xlsx` / `.xls` / `.pptx` / `.ppt`）—— 走 `office_oxide`。
//!
//! ⚠️ **本文件是本仓库唯一引用 `office_oxide` 的地方**：换实现（`calamine` + 自研 docx 解析）
//! 时只需要改这里。用到的接口只有四个：`Document::open` / `format` / `plain_text` / `to_markdown`
//! （外加 `as_xlsx` / `as_xls` 拿工作表）。
//!
//! 文本形态按格式分档（都是给模型看的，故不做花哨排版）：
//! - **表格**（`xlsx` / `xls`）：工作表名一行 + 制表符分隔的行 —— Markdown 表格列一多就全是 `|`，
//!   费 token 且更难读；`sheet` 参数可只取一张表（`xlsx` 用库的 `sheet_plain_text`，
//!   `xls` 用库的 `Sheet::display_text` 逐格渲染，**不自己解数字格式**）。
//! - **文稿 / 演示**（`docx` / `doc` / `pptx` / `ppt`）：Markdown —— 标题、列表、表格都是结构信息，
//!   丢了对模型是净损失。
//!
//! 未做（如实报错，不猜）：加密（口令保护）文档、扫描件、`.doc` 里的嵌入对象。

use office_oxide::{Document, DocumentFormat};

use super::ParseError;

/// 抽取结果
#[derive(Debug, Clone)]
pub struct OfficeText {
    /// 抽出的文本
    pub text: String,
    /// 工作簿里的全部工作表名（非表格 → 空）
    pub sheets: Vec<String>,
    /// 实际取用的工作表名（传了 `sheet` 且生效时）
    pub sheet: Option<String>,
    /// 需要让模型知道的说明（英文）
    pub note: Option<String>,
}

/// 抽一个 Office 文档的文本（`ext` 只用于错误文案，格式由库自己嗅探）
pub fn extract_text(path: &str, sheet: Option<&str>, ext: &str) -> Result<OfficeText, ParseError> {
    let doc = Document::open(path).map_err(|e| ParseError::Backend {
        format: ext.to_string(),
        message: e.to_string(),
    })?;
    let sheets = sheet_names(&doc);

    match doc.format() {
        DocumentFormat::Xlsx => match sheet {
            Some(name) => {
                let idx = resolve_sheet(&sheets, name)?;
                let sheet_name = sheets[idx].clone();
                let body = doc
                    .as_xlsx()
                    .and_then(|x| x.sheet_plain_text(idx))
                    .unwrap_or_default();
                Ok(OfficeText {
                    text: with_sheet_title(&sheet_name, &body),
                    sheets,
                    sheet: Some(sheet_name),
                    note: None,
                })
            }
            None => Ok(OfficeText {
                text: doc.plain_text(),
                sheets,
                sheet: None,
                note: None,
            }),
        },
        DocumentFormat::Xls => match sheet {
            Some(name) => {
                let idx = resolve_sheet(&sheets, name)?;
                let sheet_name = sheets[idx].clone();
                let body = doc
                    .as_xls()
                    .and_then(|x| x.sheets.get(idx).map(render_xls_sheet))
                    .unwrap_or_default();
                Ok(OfficeText {
                    text: with_sheet_title(&sheet_name, &body),
                    sheets,
                    sheet: Some(sheet_name),
                    note: None,
                })
            }
            None => Ok(OfficeText {
                text: doc.plain_text(),
                sheets,
                sheet: None,
                note: None,
            }),
        },
        _ => Ok(OfficeText {
            text: doc.to_markdown(),
            sheets,
            // Word / PowerPoint 没有「工作表」这个概念 —— 不静默吞掉参数，而是要说明
            note: sheet.map(|_| {
                "Parameter \"sheet\" only applies to .xlsx/.xls — ignored".to_string()
            }),
            sheet: None,
        }),
    }
}

/// 全部工作表名（按工作簿顺序）
fn sheet_names(doc: &Document) -> Vec<String> {
    if let Some(x) = doc.as_xlsx() {
        return x.worksheets.iter().map(|w| w.name.clone()).collect();
    }
    if let Some(x) = doc.as_xls() {
        return x.sheets.iter().map(|s| s.name.clone()).collect();
    }
    Vec::new()
}

/// 把 `sheet` 参数解成下标：先精确、再忽略大小写与首尾空白；都不中 → [`ParseError::SheetNotFound`]
fn resolve_sheet(sheets: &[String], requested: &str) -> Result<usize, ParseError> {
    let want = requested.trim();
    let found = sheets
        .iter()
        .position(|s| s == want)
        .or_else(|| sheets.iter().position(|s| s.eq_ignore_ascii_case(want)));
    found.ok_or_else(|| ParseError::SheetNotFound {
        requested: requested.to_string(),
        available: sheets.to_vec(),
    })
}

/// 单张工作表的正文前面补上表名（与整册 `plain_text` 的版式一致：表名独占一行）
fn with_sheet_title(name: &str, body: &str) -> String {
    if body.is_empty() {
        name.to_string()
    } else {
        format!("{name}\n{body}")
    }
}

/// 渲染 `.xls` 的一张工作表 —— 逐格走库里公开的 `Sheet::display_text`
/// （数字格式 / 日期 / 百分比都按 Excel 的显示结果给），避免自己解格式造成两份口径。
fn render_xls_sheet(sheet: &office_oxide::xls::Sheet) -> String {
    let mut out = String::with_capacity(sheet.rows.len() * 48);
    for (row_idx, row) in sheet.rows.iter().enumerate() {
        let line_start = out.len();
        for col in 0..row.len() {
            if col > 0 {
                out.push('\t');
            }
            if let Some(text) = sheet.display_text(row_idx, col) {
                out.push_str(&text);
            }
        }
        // 行尾的空单元格不留空白（与库的 `plain_text` 一致）
        let trimmed = out[line_start..].trim_end().len();
        out.truncate(line_start + trimmed);
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> String {
        format!("{}/tests/fixtures/office/{name}", env!("CARGO_MANIFEST_DIR"))
    }

    /// `.doc`（Word 97 旧二进制，OLE/CFB 容器）—— `read_file` 读不出来的那一类
    #[test]
    fn legacy_doc_is_extracted() {
        let out = extract_text(&fixture("simple.doc"), None, "doc").unwrap();
        assert!(
            out.text.contains("This is a simple file created with Word 97"),
            "实际：{:?}",
            out.text.chars().take(120).collect::<String>()
        );
        assert!(out.sheets.is_empty(), "Word 文档没有工作表");
    }

    /// `.docx` → Markdown（结构信息保留）；`sheet` 参数在 Word 上要**说明**被忽略，而不是静默
    #[test]
    fn docx_becomes_markdown_and_reports_the_ignored_sheet_param() {
        let out = extract_text(&fixture("SampleDoc.docx"), Some("Sheet1"), "docx").unwrap();
        assert!(!out.text.trim().is_empty(), "docx 应有文本");
        assert!(out.sheet.is_none());
        let note = out.note.expect("Word 文档上 sheet 参数必须给出说明");
        assert!(note.contains("only applies to .xlsx/.xls"), "{note}");
    }

    /// `.xlsx` 整册：每张表的名字都要出现（模型要能自己选表）
    #[test]
    fn xlsx_lists_every_sheet_and_extracts_all_by_default() {
        let out = extract_text(&fixture("SampleSS.xlsx"), None, "xlsx").unwrap();
        assert!(out.sheets.len() >= 2, "样本是多表工作簿：{:?}", out.sheets);
        for name in &out.sheets {
            assert!(out.text.contains(name), "整册文本里应含表名 {name}");
        }
        assert!(out.text.contains("Test spreadsheet"), "实际：{}", out.text);
    }

    /// `.xlsx` 选表：只回那一张表的内容，且**不报错**
    #[test]
    fn xlsx_single_sheet_is_selected_by_name() {
        let out = extract_text(&fixture("SampleSS.xlsx"), Some("Sheet Number 2"), "xlsx").unwrap();
        assert_eq!(out.sheet.as_deref(), Some("Sheet Number 2"));
        assert!(out.text.starts_with("Sheet Number 2"), "实际：{}", out.text);
        assert!(
            !out.text.contains("Test spreadsheet"),
            "选了第二张表就不该带第一张表的内容：{}",
            out.text
        );
    }

    /// 表名不存在 → 报错里带全部可用表名（模型据此改参数重试）
    #[test]
    fn unknown_sheet_reports_the_available_ones() {
        let err = extract_text(&fixture("SampleSS.xlsx"), Some("Nope"), "xlsx").unwrap_err();
        assert_eq!(err.kind(), "sheet_not_found");
        let msg = err.message();
        assert!(msg.contains("Worksheet \"Nope\" not found"), "{msg}");
        assert!(msg.contains("First Sheet"), "应列出可用表名：{msg}");
    }

    /// `.xls`（旧二进制表格）整册与选表两条路
    #[test]
    fn legacy_xls_supports_whole_workbook_and_single_sheet() {
        let all = extract_text(&fixture("Simple.xls"), None, "xls").unwrap();
        assert_eq!(all.sheets, vec!["Sheet1", "Sheet2", "Sheet3"]);
        assert!(all.text.contains("replaceMe"), "实际：{}", all.text);

        let one = extract_text(&fixture("Simple.xls"), Some("sheet2"), "xls").unwrap();
        assert_eq!(one.sheet.as_deref(), Some("Sheet2"), "表名匹配忽略大小写");
        assert!(one.text.starts_with("Sheet2"), "实际：{}", one.text);
        assert!(!one.text.contains("replaceMe"), "选表后不该带别表内容");
    }

    /// 加密 / 损坏文件：报错，不返回半截内容
    #[test]
    fn corrupt_file_fails_with_a_backend_error() {
        let dir = std::env::temp_dir().join(format!("virlen_office_bad_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("broken.docx");
        std::fs::write(&file, b"definitely not a zip package").unwrap();
        let err = extract_text(file.to_str().unwrap(), None, "docx").unwrap_err();
        assert_eq!(err.kind(), "backend");
        assert!(
            err.message().starts_with("Failed to parse docx document"),
            "{}",
            err.message()
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn sheet_resolution_prefers_exact_match() {
        let sheets = vec!["Data".to_string(), "data".to_string()];
        assert_eq!(resolve_sheet(&sheets, "data").unwrap(), 1);
        assert_eq!(resolve_sheet(&sheets, " Data ").unwrap(), 0, "首尾空白要忽略");
        assert!(resolve_sheet(&sheets, "nope").is_err());
    }
}
