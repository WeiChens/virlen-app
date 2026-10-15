//! 渲染 —— 把已解析（且已压平格内换行）的文档变成给模型看的文本 + 一句 `note`。
//!
//! 文本形态按格式分档：**表格**（`xlsx` / `xls`）= 工作表名一行 + 制表符分隔的行（Markdown 表格
//! 列一多就全是 `|`，费 token 且更难读）；**文稿 / 演示** = Markdown（标题、列表、表格都是结构信息）。
//!
//! 两条路都要处理**图片**（渲染器一个字都不画）：文稿 / 演示就地贴标记 + 就地贴 OCR 文字，
//! 表格走一句说明 + 正文末的 OCR 块 —— 差别与理由见 `super::images` 的模块头。

use office_oxide::xls::{Sheet, XlsDocument};
use office_oxide::xlsx::XlsxDocument;
use office_oxide::Document;

use crate::doc_parse::ocr::{self, ExtractedImage, OcrOptions, OcrOutcome, OcrSummary, TextLayer};
use crate::doc_parse::ParseError;

use super::images::{collect_xls_pictures, collect_xlsx_pictures, images_lead, mark_ir_images};
use super::merge::{collect_xls_merges, collect_xlsx_merges, inject_table_notes, MERGE_LEAD};
use super::notes::join_notes;
use super::notes::Mentions;
use super::OfficeText;

/// 一份 `.xlsx` 的文本（`sheet` 给定时只取那一张工作表）
pub(super) fn xlsx_text(
    book: &XlsxDocument,
    sheet: Option<&str>,
    ocr: Option<&OcrOptions>,
) -> Result<OfficeText, ParseError> {
    let sheets: Vec<String> = book.worksheets.iter().map(|ws| ws.name.clone()).collect();
    let mut merges = Mentions::default();
    let mut images = Mentions::default();
    let mut pictures: Vec<ExtractedImage> = Vec::new();

    let (text, used_sheet, scope) = match sheet {
        Some(name) => {
            let idx = resolve_sheet(&sheets, name)?;
            let sheet_name = sheets[idx].clone();
            let body = book.sheet_plain_text(idx).unwrap_or_default();
            if let Some(ws) = book.worksheets.get(idx) {
                // 只讲这一张表：表名已在标题行，区域 / 图片都不必再加 `表名!` 前缀
                collect_xlsx_merges(ws, &book.shared_strings, "", &mut merges);
                collect_xlsx_pictures(ws, "", &mut images, &mut pictures);
            }
            (with_sheet_title(&sheet_name, &body), Some(sheet_name), "this sheet")
        }
        None => {
            for ws in &book.worksheets {
                // 整册：多张表的区域 / 图片混在一句说明里，得能分辨属于哪张表 → Excel 的 `表名!`
                collect_xlsx_merges(ws, &book.shared_strings, &format!("{}!", ws.name), &mut merges);
                // 图片同理：`销售!image 2` 一眼就能看出图挂在哪张表上
                collect_xlsx_pictures(ws, &ws.name, &mut images, &mut pictures);
            }
            (book.plain_text(), None, "the workbook")
        }
    };

    let body_has_text = !text.trim().is_empty();
    let outcome = read_pictures(pictures, ocr, body_has_text);
    let note = join_notes(&[
        merges.note(MERGE_LEAD),
        images.note(&images_lead(
            scope,
            images.total,
            read_any(&outcome),
        )),
        ocr_note(&outcome, body_has_text),
    ]);
    Ok(OfficeText {
        text: with_ocr_block(text, &outcome),
        sheets,
        sheet: used_sheet,
        note,
        ocr: outcome.map(|outcome| outcome.summary),
    })
}

/// 一份 `.xls` 的文本（同 [`xlsx_text`]，只是逐格渲染走库的 `Sheet::display_text`）
pub(super) fn xls_text(
    book: &XlsDocument,
    sheet: Option<&str>,
    ocr: Option<&OcrOptions>,
) -> Result<OfficeText, ParseError> {
    let sheets: Vec<String> = book.sheets.iter().map(|s| s.name.clone()).collect();
    let mut merges = Mentions::default();
    let mut images = Mentions::default();
    let mut pictures: Vec<ExtractedImage> = Vec::new();
    // 图片是工作簿级的（`.xls` 把作图记录放在全簿共用的 `MsoDrawingGroup` 里）：
    // 选不选表都要报 —— 但只能说清「这个文件有图」，讲不出在哪张表
    collect_xls_pictures(book, &mut images, &mut pictures);

    let (text, used_sheet) = match sheet {
        Some(name) => {
            let idx = resolve_sheet(&sheets, name)?;
            let sheet_name = sheets[idx].clone();
            let body = book.sheets.get(idx).map(render_xls_sheet).unwrap_or_default();
            if let Some(s) = book.sheets.get(idx) {
                collect_xls_merges(s, "", &mut merges);
            }
            (with_sheet_title(&sheet_name, &body), Some(sheet_name))
        }
        None => {
            for s in &book.sheets {
                collect_xls_merges(s, &format!("{}!", s.name), &mut merges);
            }
            (book.plain_text(), None)
        }
    };

    let body_has_text = !text.trim().is_empty();
    let outcome = read_pictures(pictures, ocr, body_has_text);
    let note = join_notes(&[
        merges.note(MERGE_LEAD),
        images.note(&images_lead(
            "the workbook (sheet unknown)",
            images.total,
            read_any(&outcome),
        )),
        ocr_note(&outcome, body_has_text),
    ]);
    Ok(OfficeText {
        text: with_ocr_block(text, &outcome),
        sheets,
        sheet: used_sheet,
        note,
        ocr: outcome.map(|outcome| outcome.summary),
    })
}

/// 文稿 / 演示（`docx` / `doc` / `pptx` / `ppt`）的文本
pub(super) fn doc_text(doc: &Document, sheet: Option<&str>, ocr: Option<&OcrOptions>) -> OfficeText {
    // 文稿 / 演示：Markdown 必须由 **IR** 渲染 —— 库自带的 `to_markdown()` 不看
    // `gridSpan`，行中间的横向合并会让右边的单元格整体左移（见模块头）
    let mut ir = doc.to_ir();
    // 合并说明**就地**插到每张表前面（写进 `note` 的话只能写「table 7 …」，
    // 而正文里没有这个坐标，模型对不上号 —— 见模块头）
    inject_table_notes(&mut ir);
    // 「这份文档除了图片之外有没有文字」要在贴图片标记**之前**问库 —— `plain_text` 不带图片
    // （渲染器对图片输出空串），所以它就是「除图片外的文字」
    let body_has_text = !doc.plain_text().trim().is_empty();
    // 读图：模型显式要（`ocrImages: true`），或整份文档除图片外一个字都没有（整篇截图那种）
    let mut reading = match ocr {
        Some(opts) if should_read_images(Some(opts), body_has_text) => {
            Some(ocr::Reading::new(opts))
        }
        _ => None,
    };
    // 图片就地换标记（读出来的字紧跟其后）—— OCR 必须在走 IR 的这一刻做，否则回头定位不着
    mark_ir_images(&mut ir, &mut reading);
    let summary = reading.map(ocr::Reading::finish);
    // Word / PowerPoint 没有「工作表」这个概念 —— 不静默吞掉参数，而是要说明
    let ignored =
        sheet.map(|_| "Parameter \"sheet\" only applies to .xlsx/.xls — ignored".to_string());
    OfficeText {
        text: ir.to_markdown(),
        sheets: Vec::new(),
        note: join_notes(&[ignored, ocr_note_summary(summary.as_ref(), body_has_text)]),
        sheet: None,
        ocr: summary,
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

// ═══════════════════════════════════════════════════════════════════════════
// 读图（两条路共用同一套「什么时候读、读完怎么讲」）
// ═══════════════════════════════════════════════════════════════════════════

/// 要不要读图：模型显式要（`ocrImages: true`，`opts.always`），或整份文档除图片外一个字都没有
/// （整篇截图那种，OCR 就是唯一取字路径）。
///
/// 与 PDF 的**三态语义**同口径（见 `parse_document::ocr_options`）：没传 `ocrImages` = 只在
/// 「除图片外没有文字」时兜底；`false` = 调用方根本没给 `OcrOptions`，碰都不碰。
pub(super) fn should_read_images(ocr: Option<&OcrOptions>, has_text: bool) -> bool {
    ocr.is_some_and(|opts| opts.always || !has_text)
}

/// 表格一侧：读一批已抽出来的图（不该读 → `None`，连模型目录都不碰）
fn read_pictures(
    pictures: Vec<ExtractedImage>,
    ocr: Option<&OcrOptions>,
    has_text: bool,
) -> Option<OcrOutcome> {
    if !should_read_images(ocr, has_text) {
        return None;
    }
    let opts = ocr?;
    Some(ocr::run_images_ocr(pictures, opts))
}

/// 这次真读出字的图数 —— 决定说明里那句是「不读内容」还是「读出来的字在下面」
fn read_any(outcome: &Option<OcrOutcome>) -> bool {
    outcome
        .as_ref()
        .is_some_and(|outcome| outcome.summary.images > 0)
}

/// OCR 提示行（`DocText::note` 里的一句）：与 PDF 同一套措辞（`ocr::summary_note`）
fn ocr_note(outcome: &Option<OcrOutcome>, has_text: bool) -> Option<String> {
    ocr_note_summary(outcome.as_ref().map(|outcome| &outcome.summary), has_text)
}

/// 同上，但摘要已经在手（文稿 / 演示那条路是逐个 [`ocr::Reading::read`]，没有 `OcrOutcome`）
fn ocr_note_summary(summary: Option<&OcrSummary>, has_text: bool) -> Option<String> {
    // 有正文 = 「补充」；整份文档只有图 = OCR 就是正文（措辞与扫描件 PDF 一样）
    let layer = if has_text {
        TextLayer::Present
    } else {
        TextLayer::Empty
    };
    ocr::summary_note(summary?, layer)
}

/// 把 OCR 正文块接到正文后面（一个字都没读出来 → 原样返回）
///
/// 表格的正文是库渲染的制表符行，插不进「位置」—— OCR 文字只能带着一句
/// `[OCR] Image N · 表名` 追加在后面，与说明里那句 `销售!image 2` 靠序号 + 表名对上号。
fn with_ocr_block(text: String, outcome: &Option<OcrOutcome>) -> String {
    match outcome {
        Some(outcome) if !outcome.text.is_empty() => {
            format!("{text}\n\n{}\n\n{}", ocr::BLOCK_LEAD, outcome.text)
        }
        _ => text,
    }
}
