//! 表格里的图片 —— **只报存在，不读内容**（读图是 PDF 那条路的事，见 `crate::doc_parse::ocr`）。
//!
//! 渲染器只画文字：`xlsx` 的 `<xdr:pic>`（含 Excel 365「放在单元格里的图片」）与 `.xls` 的
//! `MsoDrawingGroup` 里的 BLIP 一个字都不会进正文，模型看到的就是「这里本来就没东西」，
//! 而中文报表里的图片经常盛的正是数据 —— 所以至少要告诉它「这里有图、几张、多大」。

use office_oxide::xls::{XlsDocument, XlsImage};
use office_oxide::xlsx::worksheet::WorksheetPicture;
use office_oxide::xlsx::Worksheet;

use super::notes::{shrink, Mentions};

/// 图片说明的开头（数量写在句子里：`1 image` / `3 images`）
///
/// `scope` 说清「图是哪来的」：整册 = `the workbook`，选单表 = `this sheet`，
/// `.xls`（图片是全簿共用的，归属哪张表读不出来）= `the workbook (sheet unknown)`。
pub(super) fn images_lead(scope: &str, total: usize) -> String {
    let noun = if total == 1 { "image" } else { "images" };
    format!("image contents are not extracted; {scope} holds {total} {noun}")
}

/// 一条图片说明：`<前缀>image <序号> (<事实…>)`
pub(super) fn image_text(prefix: &str, number: usize, facts: &[String]) -> String {
    format!("{prefix}image {number} ({})", facts.join(", "))
}

/// `.xlsx` 图片能报的事实：格式 / 显示尺寸 / 字节数 / alt 文本
///
/// 为什么没有「名字」：库只解析出这些（`<xdr:cNvPr>` 的 `name` 没进它的模型），不编。
fn xlsx_image_facts(pic: &WorksheetPicture) -> Vec<String> {
    let mut facts = vec![if pic.format.is_empty() {
        "unknown format".to_string()
    } else {
        pic.format.clone()
    }];
    facts.extend(rendered_px(pic.cx_emu, pic.cy_emu));
    facts.push(human_bytes(pic.data.len()));
    if let Some(alt) = pic.alt_text.as_deref().and_then(shrink) {
        // 与「被覆盖格里另存的值」同一个口径：截断 + 引号里转义（alt 里可能有换行）
        facts.push(format!("alt {alt:?}"));
    }
    facts
}

/// 显示尺寸：EMU → 96 dpi 下的像素（`914400 EMU = 1 inch`，Excel 就是按这个摆图的）。
/// 两侧都得有值才报 —— 0 是「位置未知」的哨兵（库处理「放在单元格里的图片」时会用它）
fn rendered_px(cx_emu: i64, cy_emu: i64) -> Option<String> {
    if cx_emu <= 0 || cy_emu <= 0 {
        return None;
    }
    let px = |emu: i64| ((emu as f64 / 9525.0).round() as i64).max(1);
    Some(format!("{}x{} px", px(cx_emu), px(cy_emu)))
}

/// 一张 `.xlsx` 工作表的图片 —— `ws.images` 里既有 `<xdr:pic>`，也有 Excel 365
/// 「放在单元格里的图片」（`=IMAGE()` / Place in Cell，库把两者都收进来了）
pub(super) fn collect_xlsx_images(ws: &Worksheet, prefix: &str, out: &mut Mentions) {
    for (index, pic) in ws.images.iter().enumerate() {
        out.add(image_text(prefix, index + 1, &xlsx_image_facts(pic)));
    }
}

/// `.xls` 图片能报的事实：格式 / 字节数（旧二进制格式里没有显示尺寸，也没有 alt 文本）
pub(super) fn xls_image_facts(pic: &XlsImage) -> Vec<String> {
    vec![
        pic.format.extension().to_string(),
        human_bytes(pic.data.len()),
    ]
}

/// 一份 `.xls` 的图片 —— 库里只有**工作簿级**的一份（`MsoDrawingGroup` 是所有表共用的，
/// BLIP 与具体工作表之间的链接库没建立），所以只能讲「这个文件有图」，讲不出在哪张表
pub(super) fn collect_xls_images(book: &XlsDocument, out: &mut Mentions) {
    for (index, pic) in book.images().iter().enumerate() {
        out.add(image_text("", index + 1, &xls_image_facts(pic)));
    }
}

/// 字节数 → `24.6 KB`（说明里给人看的，粗算即可；界面侧另有 `formatSize`）
fn human_bytes(bytes: usize) -> String {
    const KB: f64 = 1024.0;
    let size = bytes as f64;
    if size < KB {
        format!("{bytes} B")
    } else if size < KB * KB {
        format!("{:.1} KB", size / KB)
    } else {
        format!("{:.1} MB", size / (KB * KB))
    }
}