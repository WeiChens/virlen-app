//! 格内换行 / 制表符 → 空格（电子表格正文版式的前提）。
//!
//! 工作表的正文是「一行 = 一条记录、制表符分列」，而渲染器把格内文本**逐字**写出来：
//! 值里的一个换行（Excel 的 Alt+Enter、列太窄时折行后跟着值存下来的换行）就把这一行剩下的列
//! 全顶到下一行，列与列的对应全断；格内制表符更会凭空多出一列。
//!
//! 压平是在**值**这一层改 —— 所以要可变所有权，表格由 `super` 自己打开并持有（`Spreadsheet`）。

use std::borrow::Cow;

use office_oxide::xls::{Sheet, XlsDocument};
use office_oxide::xlsx::{CellValue, SharedStringTable, XlsxDocument};

/// 格内换行 / 制表符 → 空格。
///
/// 为什么必须压平：工作表的正文版式是「一行 = 一条记录、制表符分列」，而渲染器把格内文本**逐字**
/// 写出来 —— 值里的一个换行（Excel 的 Alt+Enter、或列太窄时折行后跟着值一起存下来的换行）就把
/// 这一行剩下的列全顶到下一行，列与列的对应全断（实测：一张 3 列的表头行被拆成 4 行）；格内制表符
/// 更会凭空多出一列。压成空格后词间距仍在、一行一条记录的版式也保住了。
///
/// 分段两侧的空白顺手 trim（折行留下的缩进 / 尾随空格都不是内容），连续空行合成一个空格；
/// 没有可压平的东西就原样借用，不分配。
pub(super) fn flatten_breaks(text: &str) -> Cow<'_, str> {
    if !text.contains(['\r', '\n', '\t']) {
        return Cow::Borrowed(text);
    }
    let mut out = String::with_capacity(text.len());
    for part in text.split(['\r', '\n', '\t']) {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(part);
    }
    Cow::Owned(out)
}

/// [`flatten_breaks`] 的就地版：真要改才分配
fn flatten_in_place(text: &mut String) {
    if let Cow::Owned(clean) = flatten_breaks(text) {
        *text = clean;
    }
}

/// `.xlsx` 的共享字符串表 —— Excel 自己写的字符串都在这儿
/// （渲染只用 `text`；rich_text 那一份是给 IR / HTML 用的，这条路上没人读）
pub(super) fn flatten_shared_strings(table: &mut SharedStringTable) {
    for entry in &mut table.strings {
        flatten_in_place(&mut entry.text);
    }
}

/// 整册 `.xlsx`：共享字符串表 + 单元格里的内联字符串
pub(super) fn flatten_xlsx_breaks(book: &mut XlsxDocument) {
    flatten_shared_strings(&mut book.shared_strings);
    for ws in &mut book.worksheets {
        for row in &mut ws.rows {
            for cell in &mut row.cells {
                if let CellValue::String(text) = &mut cell.value {
                    flatten_in_place(text);
                }
            }
        }
    }
}

/// 整册 `.xls`：字符串就在单元格里（数字 / 布尔 / 错误码不可能带换行）
pub(super) fn flatten_xls_breaks(book: &mut XlsDocument) {
    for sheet in &mut book.sheets {
        flatten_sheet_breaks(sheet);
    }
}

/// 一张 `.xls` 工作表（单独一个函数：旧二进制格式没法在测试里造，只能手工拼 [`Sheet`] 来验）
pub(super) fn flatten_sheet_breaks(sheet: &mut Sheet) {
    for row in &mut sheet.rows {
        for cell in row {
            if let office_oxide::xls::CellValue::String(text) = cell {
                flatten_in_place(text);
            }
        }
    }
}