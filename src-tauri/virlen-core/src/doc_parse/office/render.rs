//! 渲染 —— 把已解析（且已压平格内换行）的文档变成给模型看的文本 + 一句 `note`。
//!
//! 文本形态按格式分档：**表格**（`xlsx` / `xls`）= 工作表名一行 + 制表符分隔的行（Markdown 表格
//! 列一多就全是 `|`，费 token 且更难读）；**文稿 / 演示** = Markdown（标题、列表、表格都是结构信息）。

use office_oxide::xls::{Sheet, XlsDocument};
use office_oxide::xlsx::XlsxDocument;
use office_oxide::Document;

use super::images::{collect_xls_images, collect_xlsx_images, images_lead};
use super::merge::{collect_xls_merges, collect_xlsx_merges, inject_table_notes, MERGE_LEAD};
use super::notes::{join_notes, Mentions};
use super::OfficeText;
use crate::doc_parse::ParseError;

/// 一份 `.xlsx` 的文本（`sheet` 给定时只取那一张工作表）
pub(super) fn xlsx_text(book: &XlsxDocument, sheet: Option<&str>) -> Result<OfficeText, ParseError> {
    let sheets: Vec<String> = book.worksheets.iter().map(|ws| ws.name.clone()).collect();
    let mut merges = Mentions::default();
    let mut images = Mentions::default();

    match sheet {
        Some(name) => {
            let idx = resolve_sheet(&sheets, name)?;
            let sheet_name = sheets[idx].clone();
            let body = book.sheet_plain_text(idx).unwrap_or_default();
            if let Some(ws) = book.worksheets.get(idx) {
                // 只讲这一张表：表名已在标题行，区域 / 图片都不必再加 `表名!` 前缀
                collect_xlsx_merges(ws, &book.shared_strings, "", &mut merges);
                collect_xlsx_images(ws, "", &mut images);
            }
            let note = join_notes(&[
                merges.note(MERGE_LEAD),
                images.note(&images_lead("this sheet", images.total)),
            ]);
            Ok(OfficeText {
                text: with_sheet_title(&sheet_name, &body),
                sheets,
                sheet: Some(sheet_name),
                note,
            })
        }
        None => {
            for ws in &book.worksheets {
                // 整册：多张表的区域 / 图片混在一句说明里，得能分辨属于哪张表 → Excel 的 `表名!`
                collect_xlsx_merges(ws, &book.shared_strings, &format!("{}!", ws.name), &mut merges);
                // 图片同理：`销售!image 2` 一眼就能看出图挂在哪张表上
                collect_xlsx_images(ws, &format!("{}!", ws.name), &mut images);
            }
            let note = join_notes(&[
                merges.note(MERGE_LEAD),
                images.note(&images_lead("the workbook", images.total)),
            ]);
            Ok(OfficeText {
                text: book.plain_text(),
                sheets,
                sheet: None,
                note,
            })
        }
    }
}

/// 一份 `.xls` 的文本（同 [`xlsx_text`]，只是逐格渲染走库的 `Sheet::display_text`）
pub(super) fn xls_text(book: &XlsDocument, sheet: Option<&str>) -> Result<OfficeText, ParseError> {
    let sheets: Vec<String> = book.sheets.iter().map(|s| s.name.clone()).collect();
    let mut merges = Mentions::default();
    let mut images = Mentions::default();
    // 图片是工作簿级的（`.xls` 把作图记录放在全簿共用的 `MsoDrawingGroup` 里）：
    // 选不选表都要报 —— 但只能说清「这个文件有图」，讲不出在哪张表
    collect_xls_images(book, &mut images);
    let images_note = images.note(&images_lead("the workbook (sheet unknown)", images.total));

    match sheet {
        Some(name) => {
            let idx = resolve_sheet(&sheets, name)?;
            let sheet_name = sheets[idx].clone();
            let body = book.sheets.get(idx).map(render_xls_sheet).unwrap_or_default();
            if let Some(s) = book.sheets.get(idx) {
                collect_xls_merges(s, "", &mut merges);
            }
            let note = join_notes(&[merges.note(MERGE_LEAD), images_note]);
            Ok(OfficeText {
                text: with_sheet_title(&sheet_name, &body),
                sheets,
                sheet: Some(sheet_name),
                note,
            })
        }
        None => {
            for s in &book.sheets {
                collect_xls_merges(s, &format!("{}!", s.name), &mut merges);
            }
            let note = join_notes(&[merges.note(MERGE_LEAD), images_note]);
            Ok(OfficeText {
                text: book.plain_text(),
                sheets,
                sheet: None,
                note,
            })
        }
    }
}

/// 文稿 / 演示（`docx` / `doc` / `pptx` / `ppt`）的文本
pub(super) fn doc_text(doc: &Document, sheet: Option<&str>) -> OfficeText {
    // 文稿 / 演示：Markdown 必须由 **IR** 渲染 —— 库自带的 `to_markdown()` 不看
    // `gridSpan`，行中间的横向合并会让右边的单元格整体左移（见模块头）
    let mut ir = doc.to_ir();
    // 合并说明**就地**插到每张表前面（写进 `note` 的话只能写「table 7 …」，
    // 而正文里没有这个坐标，模型对不上号 —— 见模块头）
    inject_table_notes(&mut ir);
    // Word / PowerPoint 没有「工作表」这个概念 —— 不静默吞掉参数，而是要说明
    let ignored =
        sheet.map(|_| "Parameter \"sheet\" only applies to .xlsx/.xls — ignored".to_string());
    OfficeText {
        text: ir.to_markdown(),
        sheets: Vec::new(),
        note: ignored,
        sheet: None,
    }
}

/// 库的解析错误 → [`ParseError::Backend`]（`ext` 只用于文案）
pub(super) fn backend_error(ext: &str, error: impl std::fmt::Display) -> ParseError {
    ParseError::Backend {
        format: ext.to_string(),
        message: error.to_string(),
    }
}

/// 把 `sheet` 参数解成下标：先精确、再忽略大小写与首尾空白；都不中 → [`ParseError::SheetNotFound`]
pub(super) fn resolve_sheet(sheets: &[String], requested: &str) -> Result<usize, ParseError> {
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
pub(super) fn render_xls_sheet(sheet: &Sheet) -> String {
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