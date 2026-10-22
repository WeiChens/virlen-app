//! 面板预览 —— 「这份文档长什么样」的结构化出口（GUI 右侧文件面板用；零 `tauri::`）。
//!
//! 与 `parse_document` 的关系：**同一份抽取**（`office` 那套打开 / 压平 / 渲染 + 同一个 [`ParseError`]），
//! 只是形状不同 —— 模型要一段能顺着读的文本（省 token），面板要能画成界面的结构：
//! - 文稿 / 演示（`docx` `doc` `pptx` `ppt`）→ Markdown（标题 / 列表 / 表格都在），前端原样渲染；
//! - 表格（`xlsx` `xls`）→ 每张工作表一份 `行 × 列` 网格 + **合并区域坐标**（前端画成
//!   `colspan` / `rowspan`，而不是一排没字的空占位），前端画表 + 表名切换。
//!
//! 不在这里的两类：
//! - `pdf`：按页**栅格化**要 PDF 渲染器，本项目 Core 只做纯 Rust（见 `doc_parse::pdf` 模块头），
//!   面板因此走前端 pdfjs 视觉渲染，不经过本模块；
//! - `csv` / `tsv`：在面板里是**可编辑文本**，表格预览由草稿渲染时解析（所见即当前所改）。
//!
//! 也**不跑 OCR**：打开文件是「看一眼内容」，把几十秒的端侧视觉塞进这个动作里不合适
//! （要看图里的字走 `parse_document` 的 `ocrImages`）。
//!
//! ⚠️ 上限只影响**物化**的格子 / 字符：真实总量（`row_count` / `col_count` / `char_count`）如实报出，
//! 界面据此说「只显示前 N 行」—— 绝不静默截断后当作完整内容。

use std::path::Path;

use super::office::{self, MergedBounds};
use super::{extension_of, ParseError, MAX_DOC_BYTES};

/// 预览支持的扩展名（面板据此决定要不要走这条命令）
pub const PREVIEW_EXTENSIONS: [&str; 6] = ["docx", "doc", "pptx", "ppt", "xlsx", "xls"];

/// 文稿 / 演示正文的字符上限：面板是「看一眼」，再长 Markdown 渲染会卡
/// （模型侧的长度另由 `ParseOptions::max_chars` 管，两者互不影响）
pub const MAX_PREVIEW_CHARS: usize = 300_000;

/// 单张表物化的行数上限（500 × 40 格 = 2 万格，前端画得动）
pub const MAX_PREVIEW_ROWS: usize = 500;

/// 单张表物化的列数上限
pub const MAX_PREVIEW_COLS: usize = 40;

/// 这个扩展名（不带点，大小写不限）能不能预览
pub fn is_supported(ext: &str) -> bool {
    PREVIEW_EXTENSIONS.contains(&ext.to_lowercase().as_str())
}

/// 预览正文的两种形状
#[derive(Debug, Clone)]
pub enum PreviewBody {
    /// 文稿 / 演示：Markdown
    Text {
        /// 正文（可能已按 `max_chars` 截断）
        text: String,
        /// **全文**字符数（不是 `text` 的长度）
        char_count: usize,
        /// 是否被截断
        truncated: bool,
    },
    /// 表格：每张工作表一份网格（空工作簿会先被拦成 [`ParseError::NoText`]）
    Sheets(Vec<PreviewSheet>),
}

/// 一张工作表的网格
#[derive(Debug, Clone)]
pub struct PreviewSheet {
    /// 工作表名（界面上的切换项）
    pub name: String,
    /// 已物化的行（`rows.len() <= MAX_PREVIEW_ROWS`）
    pub rows: Vec<Vec<String>>,
    /// 这张表的**实际**行数
    pub row_count: usize,
    /// 这张表的**实际**最大列数
    pub col_count: usize,
    /// 合并区域（0-based、整张表的坐标）：界面画成 `colspan` / `rowspan`
    pub merges: Vec<MergedBounds>,
}

/// 一份文档的预览
#[derive(Debug, Clone)]
pub struct DocumentPreview {
    /// 小写扩展名 / 实际格式（`docx` / `pptx` / `xlsx` …）
    pub kind: String,
    /// 正文
    pub body: PreviewBody,
    /// 文件字节数（界面顶部的元信息）
    pub byte_size: u64,
}

/// 预览一个文档（上限取本模块的默认常量）
pub fn preview(path: &str) -> Result<DocumentPreview, ParseError> {
    preview_with_limits(path, MAX_PREVIEW_CHARS, MAX_PREVIEW_ROWS, MAX_PREVIEW_COLS)
}

/// 同上，上限由调用方给（用例靠它把「截断」压到几行几列）
pub fn preview_with_limits(
    path: &str,
    max_chars: usize,
    max_rows: usize,
    max_cols: usize,
) -> Result<DocumentPreview, ParseError> {
    let file = Path::new(path);
    let ext = extension_of(path);

    if !is_supported(&ext) {
        return Err(ParseError::Unsupported { ext });
    }

    // 存在性 / 是不是目录 / 大小 —— 全在**读文件之前**判（与 `parse` 同口径）
    let meta = std::fs::metadata(file).map_err(|_| ParseError::Backend {
        format: ext.clone(),
        message: "the file does not exist or is not accessible".to_string(),
    })?;
    if meta.is_dir() {
        return Err(ParseError::Backend {
            format: ext.clone(),
            message: "the path is a directory, not a file".to_string(),
        });
    }
    if meta.len() > MAX_DOC_BYTES {
        return Err(ParseError::TooLarge {
            size: meta.len(),
            limit: MAX_DOC_BYTES,
        });
    }

    match ext.as_str() {
        "xlsx" | "xls" => {
            let grids = office::preview_grids(path, &ext, max_rows, max_cols)?;
            let sheets: Vec<PreviewSheet> = grids
                .into_iter()
                .map(|grid| PreviewSheet {
                    name: grid.name,
                    rows: grid.rows,
                    row_count: grid.row_count,
                    col_count: grid.col_count,
                    merges: grid.merges,
                })
                .collect();
            // 一个字都没有的工作簿按「抽不出内容」报，而不是给界面一堆空表
            // （与 `parse` 的 NoText 同一档：这份文件确实没有可看的内容）
            if sheets
                .iter()
                .all(|sheet| sheet.rows.iter().all(|row| row.is_empty()))
            {
                return Err(ParseError::NoText {
                    detail: "the workbook has no cell content".to_string(),
                });
            }
            Ok(DocumentPreview {
                kind: ext,
                body: PreviewBody::Sheets(sheets),
                byte_size: meta.len(),
            })
        }
        _ => {
            // 文稿 / 演示：正文是 Markdown（与 `parse_document` 同一份渲染）
            let out = office::extract_text(path, None, &ext)?;
            let char_count = out.text.chars().count();
            let truncated = char_count > max_chars;
            let text = if truncated {
                out.text.chars().take(max_chars).collect()
            } else {
                out.text
            };
            if text.trim().is_empty() {
                return Err(ParseError::NoText {
                    detail: "the document has no text".to_string(),
                });
            }
            Ok(DocumentPreview {
                kind: ext,
                body: PreviewBody::Text {
                    text,
                    char_count,
                    truncated,
                },
                byte_size: meta.len(),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> String {
        format!("{}/tests/fixtures/office/{name}", env!("CARGO_MANIFEST_DIR"))
    }

    /// 扩展名白名单：只在预览支持的六种里，别的（`pdf` / `csv` / `png`）明确 **不** 在这里
    #[test]
    fn only_office_extensions_are_previewable_here() {
        for ext in ["docx", "doc", "pptx", "ppt", "xlsx", "xls", "XLSX"] {
            assert!(is_supported(ext), "{ext} 应该能预览");
        }
        for ext in ["pdf", "csv", "tsv", "png", "txt", ""] {
            assert!(!is_supported(ext), "{ext} 不该走这条命令");
        }
    }

    /// `.xlsx` 预览：每张表各一份网格，表名与 `parse_document` 拿到的一致
    #[test]
    fn xlsx_preview_returns_one_grid_per_sheet() {        let path = fixture("SampleSS.xlsx");
        let out = preview(&path).unwrap();
        assert_eq!(out.kind, "xlsx");
        assert!(out.byte_size > 0);
        let sheets = match out.body {
            PreviewBody::Sheets(sheets) => sheets,
            _ => panic!("xlsx 应该给网格"),
        };
        assert!(sheets.len() >= 2, "样本是多表工作簿：{:?}", sheets.iter().map(|s| &s.name).collect::<Vec<_>>());

        let text = office::extract_text(&path, None, "xlsx").unwrap();
        assert_eq!(
            sheets.iter().map(|s| s.name.clone()).collect::<Vec<_>>(),
            text.sheets,
            "预览的表名与正文那条路必须同源"
        );

        // 「Test spreadsheet」在样本里是某个单元格的内容，网格里必须找得到
        let has_text = sheets
            .iter()
            .any(|sheet| sheet.rows.iter().flatten().any(|cell| cell.contains("Test spreadsheet")));
        assert!(has_text, "网格里应有样本正文：{:?}", sheets[0].rows);
        assert!(sheets[0].col_count > 0);
    }

    /// `.xls`（旧二进制）也能给网格：与 `.xlsx` 同一条路（压平 → 逐表渲染 → 切格）
    #[test]
    fn xls_preview_returns_a_grid_too() {
        let out = preview(&fixture("Simple.xls")).unwrap();
        assert_eq!(out.kind, "xls");
        match out.body {
            PreviewBody::Sheets(sheets) => {
                assert!(!sheets.is_empty());
                assert!(
                    sheets.iter().any(|s| s.rows.iter().flatten().any(|c| !c.is_empty())),
                    "至少要有非空格"
                );
            }
            _ => panic!("xls 应该给网格"),
        }
    }

    /// 合并区域随网格一起交出：预览要把它们画成 `colspan` / `rowspan`，
    /// 而不是一排没字的空占位（值只在左上角，被覆盖格仍是空串：界面靠 span 填住它们）。
    #[test]
    fn xlsx_preview_exposes_merged_regions() {
        let path = fixture("MergedCells.xlsx");
        let sheets = match preview(&path).unwrap().body {
            PreviewBody::Sheets(sheets) => sheets,
            _ => panic!("xlsx 应该给网格"),
        };

        let report = sheets
            .iter()
            .find(|sheet| sheet.name == "报表")
            .expect("样本有「报表」这张表");
        let mut got: Vec<(u32, u32, u32, u32)> = report
            .merges
            .iter()
            .map(|m| (m.row_first, m.row_last, m.col_first, m.col_last))
            .collect();
        got.sort();
        assert_eq!(
            got,
            vec![(0, 0, 0, 2), (2, 4, 0, 0), (5, 5, 0, 2)],
            "A1:C1 / A3:A5 / A6:C6 三片合并（0-based）"
        );

        // 值只在左上角；被覆盖的位置**不是**靠空字符串占位
        assert_eq!(report.rows[0][0], "销售报表");
        assert_eq!(report.rows[0].get(1).map(String::as_str).unwrap_or(""), "");
        assert_eq!(report.rows[2][0], "华东");
        assert_eq!(report.rows[3].first().map(String::as_str).unwrap_or(""), "");

        // 没有合并的那张表不能蹭到区域
        let detail = sheets
            .iter()
            .find(|sheet| sheet.name == "明细")
            .expect("样本有「明细」这张表");
        assert!(detail.merges.is_empty(), "明细没有合并区域");

        // 与说明同源：`parse_document` 的 note 里点名的区域必须与这里一致
        let text = office::extract_text(&path, None, "xlsx").unwrap();
        let note = text.note.unwrap_or_default();
        assert!(note.contains("A1:C1"), "{note}");
        assert!(note.contains("A3:A5"), "{note}");
    }

    /// 行 / 列上限**只影响物化**：真实总量照旧如实报（界面靠它说「只显示前 N 行」）
    #[test]
    fn grid_limits_only_cap_what_is_materialized() {
        let out = preview_with_limits(&fixture("SampleSS.xlsx"), MAX_PREVIEW_CHARS, 1, 1).unwrap();
        let sheets = match out.body {
            PreviewBody::Sheets(sheets) => sheets,
            _ => panic!("xlsx 应该给网格"),
        };
        let sheet = sheets
            .iter()
            .find(|sheet| sheet.row_count > 1)
            .expect("样本里应有一张多行表");
        assert_eq!(sheet.rows.len(), 1, "物化行数受上限约束");
        assert!(sheet.rows[0].len() <= 1, "物化列数受上限约束");
        assert!(sheet.row_count > 1, "真实行数不受上限影响：{}", sheet.row_count);
    }

    /// `.docx` → Markdown：正文非空、`char_count` 是全文长度、默认不截断
    #[test]
    fn docx_preview_returns_markdown() {
        let out = preview(&fixture("SampleDoc.docx")).unwrap();
        assert_eq!(out.kind, "docx");
        match out.body {
            PreviewBody::Text {
                text,
                char_count,
                truncated,
            } => {
                assert!(!text.trim().is_empty());
                assert_eq!(char_count, text.chars().count());
                assert!(!truncated);
            }
            _ => panic!("docx 应该给正文"),
        }
    }

    /// 字符上限：`truncated` 为真、`char_count` 仍是全文长度（切片不许谎报总量）
    #[test]
    fn text_limit_reports_the_full_length() {
        let full = match preview(&fixture("SampleDoc.docx")).unwrap().body {
            PreviewBody::Text { char_count, .. } => char_count,
            _ => panic!("docx 应该给正文"),
        };
        let out = preview_with_limits(&fixture("SampleDoc.docx"), 5, MAX_PREVIEW_ROWS, MAX_PREVIEW_COLS)
            .unwrap();
        match out.body {
            PreviewBody::Text {
                text,
                char_count,
                truncated,
            } => {
                assert!(truncated);
                assert_eq!(text.chars().count(), 5);
                assert_eq!(char_count, full, "总量必须是全文，不是切片长度");
            }
            _ => panic!("docx 应该给正文"),
        }
    }

    /// 不支持的扩展名 / 不存在的文件：与 `parse` 同一套错误分类
    #[test]
    fn unsupported_and_missing_files_are_reported() {
        let err = preview(&fixture("nope.png")).unwrap_err();
        assert_eq!(err.kind(), "unsupported");

        let err = preview(&fixture("nope.docx")).unwrap_err();
        assert_eq!(err.kind(), "backend");
        assert!(err.message().contains("does not exist"), "{}", err.message());
    }
}
