//! 文档里的图片 —— **就地**报出「这里有一张图」（文稿 / 演示）或一句说明（表格），
//! 并在被要求时把图里的字读出来（读图走 `crate::doc_parse::ocr`，本模块只管「图在哪、是什么」）。
//!
//! 为什么必须报：渲染器只画文字 —— `docx` / `pptx` 的 `<w:drawing>` / `<p:pic>`、`xlsx` 的
//! `<xdr:pic>`（含 Excel 365「放在单元格里的图片」）、`.xls` 的 `MsoDrawingGroup` 里的 BLIP
//! **一个字都不会进正文**，模型看到的就是「这里本来就没东西」，而中文报表 / 截图里的图片
//! 经常盛的正是数据。讲在**哪儿**按格式分两种（与合并单元格同一套判断）：
//! - **文稿 / 演示**（`docx` / `doc` / `pptx` / `ppt`）：图片本来就在正文流里有个位置，而正文里
//!   没有「第 N 张图」这种坐标，所以**就地**把它换成一句标记段落（`image 3 · png · 640×480 px ·
//!   24.6 KB`），位置由库自己的渲染器排、与正文同源；被要求读图时，标记后面紧跟
//!   `OCR text of image 3:` + 识别出的字（同一张图，位置一眼对得上）。
//! - **表格**（`xlsx` / `xls`）：正文是「表名一行 + 制表符分列的行」，插不进「位置」，所以照旧走
//!   `DocText::note` 的一句说明（Excel 自己的 `销售!image 2` 定位得到），读出来的字追加在正文
//!   后面（`[OCR] Image 2 · 销售 · 1412×844`）。
//!
//! 说明里的事实都是库真给了的：格式 / 显示尺寸 / 字节数 / alt 文本。**图片名不编** ——
//! `<xdr:cNvPr>` 的 `name` 不在库的模型里；`.xls` 更连「图挂在哪张表」都读不出来。

use office_oxide::ir::{DocumentIR, Element, Image as IrImage, List};
use office_oxide::xls::{XlsDocument, XlsImage};
use office_oxide::xlsx::worksheet::WorksheetPicture;
use office_oxide::xlsx::Worksheet;

use crate::doc_parse::ocr::{ExtractedImage, Reading};

use super::notes::{fact_paragraph, shrink, Mentions};

/// 图片说明的开头（数量写在句子里：`1 image` / `3 images`）
///
/// `scope` 说清「图是哪来的」：整册 = `the workbook`，选单表 = `this sheet`，
/// `.xls`（图片是全簿共用的，归属哪张表读不出来）= `the workbook (sheet unknown)`。
/// `extracted` = 这次真把图里的字读出来了 —— 读了就不能再说「不读内容」（那句是**没读**时的交代）。
pub(super) fn images_lead(scope: &str, total: usize, extracted: bool) -> String {
    let noun = if total == 1 { "image" } else { "images" };
    if extracted {
        format!("{scope} holds {total} {noun}; the text inside them follows")
    } else {
        format!("image contents are not extracted; {scope} holds {total} {noun}")
    }
}

/// 一条图片说明：`<前缀>image <序号> (<事实…>)`
pub(super) fn image_text(prefix: &str, number: usize, facts: &[String]) -> String {
    format!("{prefix}image {number} ({})", facts.join(", "))
}

// ═══════════════════════════════════════════════════════════════════════════
// 文稿 / 演示：就地贴标记（`docx` / `doc` / `pptx` / `ppt`）
// ═══════════════════════════════════════════════════════════════════════════

/// 文稿 / 演示的图片标记：`image 3 · png · 640×480 px · 24.6 KB[ · alt "…"]`
///
/// ⚠️ 不用方括号（`[image 3]`）：这句要进库的 Markdown 渲染器，而它把 `[` 转义成 `\[`
/// （实测 `[OCR] Image 3` 渲染出来是 `\[OCR\] Image 3`）—— 标记本身就够醒目，不给正文添反斜杠。
pub(super) fn ir_image_text(number: usize, image: &IrImage) -> String {
    let mut facts: Vec<String> = Vec::new();
    match image.data.as_ref() {
        Some(data) => {
            facts.push(match image.format.as_ref() {
                Some(format) => format.extension().to_string(),
                None => "unknown format".to_string(),
            });
            if let Some(size) = rendered_px(
                image.display_width_emu.unwrap_or(0) as i64,
                image.display_height_emu.unwrap_or(0) as i64,
            ) {
                facts.push(size);
            }
            facts.push(human_bytes(data.len()));
        }
        // 没有字节：外链图（`r:link`）/ 嵌入对象（OLE）/ pptx 的形状占位 —— 如实说「没有字节」，
        // 不编「图里有什么」，也不说「图不存在」（它在版面上确实占着一个位置）
        None => facts.push(match image.source_url.as_deref().and_then(shrink) {
            Some(url) => format!("linked image, not embedded: {url}"),
            None => "no embedded image data (linked image or embedded object)".to_string(),
        }),
    }
    if let Some(alt) = image.alt_text.as_deref().and_then(shrink) {
        facts.push(format!("alt {alt:?}"));
    }
    format!("image {number} · {}", facts.join(" · "))
}

/// 文稿 / 演示：把每张图**就地**换成一句标记；`reading` 有值时顺带把图里的字读出来贴在标记后面。
///
/// 走法即库的渲染顺序（正文 → 单元格 / 文本框 → 脚注尾注 → 列表 → 页眉页脚 → 演讲备注），
/// 所以标记里的序号就是模型读到的第几张图 —— 与 `uiData.ocr.sections[].index` 同一份编号。
pub(super) fn mark_ir_images(ir: &mut DocumentIR, reading: &mut Option<Reading<'_>>) {
    let mut number = 0usize;
    for section in &mut ir.sections {
        mark_in_blocks(&mut section.elements, "body", &mut number, reading);
        if let Some(notes) = &mut section.speaker_notes {
            mark_in_blocks(notes, "speaker notes", &mut number, reading);
        }
        // 页眉页脚不在 `elements` 里，但渲染时同样在正文中
        for (place, header) in [
            ("first page header", section.first_page_header.as_mut()),
            ("header", section.header.as_mut()),
            ("even page header", section.even_page_header.as_mut()),
            ("first page footer", section.first_page_footer.as_mut()),
            ("footer", section.footer.as_mut()),
            ("even page footer", section.even_page_footer.as_mut()),
        ] {
            if let Some(header) = header {
                mark_in_blocks(&mut header.content, place, &mut number, reading);
            }
        }
    }
}

/// 一批块元素（[`mark_ir_images`] 的递归主体）：遇到图就换成标记段落，别的容器往下走
///
/// 字节用 `Option::take` 直接**搬走**（不复制 —— 图马上就不在 IR 里了），元素本身换成标记段落。
/// `Element` 实现了 `Drop`，所以不能按值解构它（`E0509`）—— 分开做：先只读地把标记算出来，
/// 再取字节，最后整体替换。
fn mark_in_blocks(
    elements: &mut Vec<Element>,
    place: &str,
    number: &mut usize,
    reading: &mut Option<Reading<'_>>,
) {
    let mut index = 0;
    while index < elements.len() {
        // 1. 先只读地算标记（下面才动字节）
        let marker = match &elements[index] {
            Element::Image(image) => {
                *number += 1;
                Some(ir_image_text(*number, image))
            }
            _ => None,
        };

        let Some(marker) = marker else {
            mark_in_container(&mut elements[index], place, number, reading);
            index += 1;
            continue;
        };

        // 2. 字节搬出来，位置换成标记段落
        let current = *number;
        let bytes = match &mut elements[index] {
            Element::Image(image) => image.data.take(),
            _ => None,
        };
        elements[index] = fact_paragraph(marker);

        // 3. 有字节才谈得上「读图里的字」（外链图 / 嵌入对象不在本机，读不了）；
        //    读出来了就紧跟在标记后面贴一段
        if let Some(bytes) = bytes {
            let section = reading.as_mut().and_then(|reader| {
                reader.read(ExtractedImage {
                    number: current,
                    place: place.to_string(),
                    bytes,
                })
            });
            if let Some(section) = section {
                elements.insert(index + 1, ocr_paragraph(current, &section.text));
                index += 1; // 插进去的那段也在游标前面
            }
        }
        index += 1;
    }
}

/// 一张图读出来的字 —— 紧跟在标记后面：`OCR text of image 3:` 加原样的识别结果
/// （换行照留着：一段里的换行会被渲染成同一块的软换行，读起来仍是一行一行）
fn ocr_paragraph(number: usize, text: &str) -> Element {
    fact_paragraph(format!("OCR text of image {number}:\n{text}"))
}

/// 容器里的图（表格单元格 / 文本框 / 脚注尾注 / 列表项）—— 与 [`mark_in_blocks`] 同一套走法
fn mark_in_container(
    element: &mut Element,
    place: &str,
    number: &mut usize,
    reading: &mut Option<Reading<'_>>,
) {
    match element {
        Element::Table(table) => {
            for row in &mut table.rows {
                for cell in &mut row.cells {
                    mark_in_blocks(&mut cell.content, "table", number, reading);
                }
            }
        }
        Element::TextBox(text_box) => {
            mark_in_blocks(&mut text_box.content, "text box", number, reading)
        }
        Element::Footnote(note) => mark_in_blocks(&mut note.content, "footnote", number, reading),
        Element::Endnote(note) => mark_in_blocks(&mut note.content, "endnote", number, reading),
        Element::List(list) => mark_in_list(list, place, number, reading),
        _ => {}
    }
}

/// 列表项里的图（含嵌套列表）—— 位置沿用外层的说法（列表项自己不算一个「部位」）
fn mark_in_list(
    list: &mut List,
    place: &str,
    number: &mut usize,
    reading: &mut Option<Reading<'_>>,
) {
    for item in &mut list.items {
        mark_in_blocks(&mut item.content, place, number, reading);
        if let Some(nested) = &mut item.nested {
            mark_in_list(nested, place, number, reading);
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// 表格：一句说明 + 待读的字节（`xlsx` / `xls`）
// ═══════════════════════════════════════════════════════════════════════════

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

/// 一张 `.xlsx` 工作表的图片 —— 说明里那句 + 待读的字节。
///
/// `place` = 表名（整册；说明里写成 Excel 的 `表名!image 2`）或空串（选单张表：表名已在正文
/// 标题行，说明与 OCR 标记里都不再挂前缀）。
pub(super) fn collect_xlsx_pictures(
    ws: &Worksheet,
    place: &str,
    out: &mut Mentions,
    pictures: &mut Vec<ExtractedImage>,
) {
    let prefix = if place.is_empty() {
        String::new()
    } else {
        format!("{place}!")
    };
    for (index, pic) in ws.images.iter().enumerate() {
        let number = index + 1;
        out.add(image_text(&prefix, number, &xlsx_image_facts(pic)));
        pictures.push(ExtractedImage {
            number,
            place: place.to_string(),
            bytes: pic.data.clone(),
        });
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
/// （`place` 因此写成 `sheet unknown`）。
pub(super) fn collect_xls_pictures(
    book: &XlsDocument,
    out: &mut Mentions,
    pictures: &mut Vec<ExtractedImage>,
) {
    for (index, pic) in book.images().iter().enumerate() {
        let number = index + 1;
        out.add(image_text("", number, &xls_image_facts(pic)));
        pictures.push(ExtractedImage {
            number,
            place: "sheet unknown".to_string(),
            bytes: pic.data.clone(),
        });
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
