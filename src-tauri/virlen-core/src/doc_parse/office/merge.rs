//! 合并单元格（`MERGEDCELLS` / `gridSpan` / `vMerge`）—— **解释一句「为什么那些位置是空的」**。
//!
//! 合并区域在网格里只体现为「某个位置是空的」，「合并」与「真空」分不出来，而 GFM 表格也没有
//! span 语法，所以总得单独讲一句。讲在**哪儿**按「模型能不能对上号」分两种：
//! - 表格（`xlsx` / `xls`）：正文是「表名一行 + 制表符分列的行」，用 Excel 的 `表名!A1:D1` 就定位得到，
//!   所以走 `DocText::note`（在 `render` 里拼）；
//! - 文稿 / 演示（`docx` / `doc` / `pptx` / `ppt`）：正文里没有「第 N 张表」这个坐标，所以
//!   **就地**插一句段落（`inject_table_notes`），位置由库自己的渲染器排，与正文同源。

use office_oxide::ir::{DocumentIR, Element, InlineContent, List, Paragraph, Table, TextSpan};
use office_oxide::xls::Sheet;
use office_oxide::xlsx::{Cell, CellRef, CellValue, SharedStringTable, Worksheet};

use super::notes::{shrink, Mentions};

/// 合并说明的开头 —— 先讲清「为什么被覆盖的位置是空的」，后面接区域清单
pub(super) const MERGE_LEAD: &str =
    "merged cells show a value only in the region's top-left cell, the rest of its grid positions are empty";

/// 文稿 / 演示的合并说明开头 —— 贴在**同一份文件里第一张**带合并的表前，把「为什么被覆盖的
/// 位置是空的」这一层一次讲清（此后各表只留 [`TABLE_MERGE_LEAD_SHORT`]）。
pub(super) const TABLE_MERGE_LEAD: &str =
    "merged cells (only the region's top-left cell shows its value, the rest is empty)";

/// 后面各张表的合并说明开头 —— 解释**只讲一次**：同一份文件里带合并的表能有几十张
/// （实测那份审核报告 39 张），同一句解释重复几十遍纯是噪音；但「这些一个字都没有的空位是合并
/// 留下的」这层意思每张表都得留一句，否则紧接着的表格还是会被读成「本来就是空的」。
pub(super) const TABLE_MERGE_LEAD_SHORT: &str = "merged cells";

/// 合并区域摊成网格时的位置上限（每个单元格最多铺几个位置）
///
/// ⚠️ 与库的 `ir_render::table_grid` 同口径：span 是不可信输入，`行 x 宽` 得先算出来再拒绝，
/// 否则一个被裁剪过的 IR 就能让这里分配一块巨大的网格。
const MAX_GRID_POSITIONS_PER_CELL: usize = 64;

/// 见 [`MAX_GRID_POSITIONS_PER_CELL`]：小表里合法的大合并区始终保留坐标
const MIN_GRID_POSITIONS: usize = 1 << 20;

/// 一片合并区域（0-based 闭区间）
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct MergeRegion {
    row_first: u32,
    row_last: u32,
    col_first: u32,
    col_last: u32,
}

impl MergeRegion {
pub(super) fn new(row_first: u32, row_last: u32, col_first: u32, col_last: u32) -> Self {
        Self {
            row_first,
            row_last,
            col_first,
            col_last,
        }
    }

    fn rows(&self) -> u32 {
        self.row_last - self.row_first + 1
    }

    fn cols(&self) -> u32 {
        self.col_last - self.col_first + 1
    }

    /// 真跨了格子才算合并（`A1:A1` 这种退化区域不算）
pub(super) fn is_merge(&self) -> bool {
        self.rows() > 1 || self.cols() > 1
    }

    /// `A1:D1` —— 电子表格用（Excel 自己的记法，用户和模型都熟）
pub(super) fn a1(&self) -> String {
        format!(
            "{}{}:{}{}",
            CellRef::col_name(self.col_first),
            self.row_first + 1,
            CellRef::col_name(self.col_last),
            self.row_last + 1
        )
    }

    /// `r1c1-r1c3` —— 文稿表格用（Word 的表没有列标）：1-based、表内计数
pub(super) fn rc(&self) -> String {
        format!(
            "r{}c{}-r{}c{}",
            self.row_first + 1,
            self.col_first + 1,
            self.row_last + 1,
            self.col_last + 1
        )
    }

    fn spans(&self) -> String {
        match (self.rows(), self.cols()) {
            (1, cols) => format!("spans {cols} columns"),
            (rows, 1) => format!("spans {rows} rows"),
            (rows, cols) => format!("spans {rows} rows x {cols} columns"),
        }
    }
}

/// 一条区域的说明：`<前缀><位置> <跨几行几列>[ (被覆盖格里另存的值)]`
fn region_text(prefix: &str, place: &str, spans: String, hidden: Option<&str>) -> String {
    match hidden {
        Some(value) => format!("{prefix}{place} {spans} (a covered cell also holds {value:?})"),
        None => format!("{prefix}{place} {spans}"),
    }
}

/// 一张 `.xlsx` 工作表的合并区域 —— 直接读工作表自己的 `merged_cells`（`"A1:C1"`，就是 Excel 存的那份）
pub(super) fn collect_xlsx_merges(
    ws: &Worksheet,
    strings: &SharedStringTable,
    prefix: &str,
    out: &mut Mentions,
) {
    for raw in &ws.merged_cells {
        let Some(region) = parse_a1_range(raw) else {
            continue;
        };
        if !region.is_merge() {
            continue;
        }
        // 扫单元格不便宜：列满上限之后就不再为「被覆盖值」扫了（只计数）
        let hidden = if out.full() {
            None
        } else {
            xlsx_hidden_value(ws, strings, &region)
        };
        out.add(region_text(
            prefix,
            &region.a1(),
            region.spans(),
            hidden.as_deref(),
        ));
    }
}

/// `"A1:C1"` → 区域；`"A1"` 这种单格（没有冒号）不是合并 → `None`；越界引用也 `None`（`CellRef::parse` 挡掉）
pub(super) fn parse_a1_range(range: &str) -> Option<MergeRegion> {
    let (from, to) = range.split_once(':')?;
    let a = CellRef::parse(from.trim())?;
    let b = CellRef::parse(to.trim())?;
    Some(MergeRegion::new(
        a.row.min(b.row),
        a.row.max(b.row),
        a.col.min(b.col),
        a.col.max(b.col),
    ))
}

/// 合并区域里**不显示**的那些格子里存了什么。
///
/// 为什么不省掉：`a.xlsx` 把左上角以外的地方也写过东西是真实存在的（先填数再合并），
/// 而 IR 路径会把被覆盖的格子整个丢掉 —— 那份数据不能连一句提示都没有就消失。
fn xlsx_hidden_value(
    ws: &Worksheet,
    strings: &SharedStringTable,
    region: &MergeRegion,
) -> Option<String> {
    for row in &ws.rows {
        // `Row::index` 是 1-based（`<row r="3">`），区域坐标是 0-based
        let row_idx = row.index.saturating_sub(1);
        if row_idx < region.row_first || row_idx > region.row_last {
            continue;
        }
        for cell in &row.cells {
            let (r, c) = (cell.reference.row, cell.reference.col);
            if r < region.row_first
                || r > region.row_last
                || c < region.col_first
                || c > region.col_last
            {
                continue;
            }
            // 左上角那格是**显示出来**的值，不算被覆盖
            if (r, c) == (region.row_first, region.col_first) {
                continue;
            }
            if let Some(text) = xlsx_cell_text(cell, strings) {
                return Some(text);
            }
        }
    }
    None
}

/// 格子里存的值（只用于「被覆盖格里还有内容」这一句 —— 不复原数字格式，那不是这里的事）
fn xlsx_cell_text(cell: &Cell, strings: &SharedStringTable) -> Option<String> {
    let raw = match &cell.value {
        CellValue::Empty => return None,
        CellValue::String(text) => text.clone(),
        CellValue::SharedString(index) => strings.get(*index)?.to_string(),
        CellValue::Number(number) => number.to_string(),
        CellValue::Boolean(flag) => if *flag { "TRUE" } else { "FALSE" }.to_string(),
        CellValue::Error(error) => error.clone(),
        CellValue::Date(date) => date.to_string(),
    };
    shrink(&raw)
}

/// 一张 `.xls` 工作表的合并区域（`MERGEDCELLS`，0-based 四元组）
pub(super) fn collect_xls_merges(sheet: &Sheet, prefix: &str, out: &mut Mentions) {
    for &(row_a, row_b, col_a, col_b) in &sheet.merged_cells {
        // 记录里的首尾不保证有序（也不保证不是同一个格子），统一归一
        let region = MergeRegion::new(
            u32::from(row_a.min(row_b)),
            u32::from(row_a.max(row_b)),
            u32::from(col_a.min(col_b)),
            u32::from(col_a.max(col_b)),
        );
        if !region.is_merge() {
            continue;
        }
        let hidden = if out.full() {
            None
        } else {
            xls_hidden_value(sheet, &region)
        };
        out.add(region_text(
            prefix,
            &region.a1(),
            region.spans(),
            hidden.as_deref(),
        ));
    }
}

/// 同 [`xlsx_hidden_value`]：只走**存在**的行列（`rows` 是锯齿状的）—— 一个铺满整张网格的合并
/// 区域（`(0, 0xFFFF, 0, 0xFFFF)` 这种是合法记录）也不会把这里变成 40 亿次循环
fn xls_hidden_value(sheet: &Sheet, region: &MergeRegion) -> Option<String> {
    for (row_idx, row) in sheet.rows.iter().enumerate() {
        let r = row_idx as u32;
        if r < region.row_first || r > region.row_last {
            continue;
        }
        for col_idx in 0..row.len() {
            let c = col_idx as u32;
            if c < region.col_first || c > region.col_last {
                continue;
            }
            if (r, c) == (region.row_first, region.col_first) {
                continue;
            }
            if let Some(text) = sheet.display_text(row_idx, col_idx) {
                if let Some(text) = shrink(&text) {
                    return Some(text);
                }
            }
        }
    }
    None
}

/// 文稿 / 演示的合并说明：**就地**插到每张表前面 —— 正文、单元格里的嵌套表、文本框、脚注 /
/// 尾注、列表项、页眉页脚、演讲备注，表能藏的地方都走到。
///
/// 为什么不是一句总说明：总说明只能用 `table N` 指认表，而正文里**没有**「第 N 张表」这个坐标
/// （实测那份审核报告 39 张表都带合并，一句「table 1 …; and 31 more」全堆在文件最前面，模型对不上号）。
/// 就地插一句段落则天然贴着那张表，位置由库自己的渲染器排 —— 与正文同源，不会错位。
///
/// `explained` 由本函数持有、跨节带着走：**完整解释只讲一次**（第一张带合并的表），
/// 之后的表一律只留 [`TABLE_MERGE_LEAD_SHORT`]。
pub(super) fn inject_table_notes(ir: &mut DocumentIR) {
    let mut explained = false;
    for section in &mut ir.sections {
        inject_notes_in_blocks(&mut section.elements, &mut explained);
        // 演讲备注（PPTX 讲稿）也是会渲染进正文的块序列
        if let Some(notes) = &mut section.speaker_notes {
            inject_notes_in_blocks(notes, &mut explained);
        }
        // 页眉页脚要单独走：它们不在 `elements` 里，但渲染时同样在正文中
        for header in [
            section.first_page_header.as_mut(),
            section.header.as_mut(),
            section.even_page_header.as_mut(),
            section.first_page_footer.as_mut(),
            section.footer.as_mut(),
            section.even_page_footer.as_mut(),
        ]
        .into_iter()
        .flatten()
        {
            inject_notes_in_blocks(&mut header.content, &mut explained);
        }
    }
}

/// 一批块元素：[`inject_table_notes`] 的递归主体
///
/// 顺序：**先算这张表自己那句**再往里走 —— 说明在渲染时排在这张表前面，先算它，
/// [`TABLE_MERGE_LEAD`] 才会落在渲染顺序上的第一张表（嵌套表在渲染时排在它外层表之后）。
fn inject_notes_in_blocks(elements: &mut Vec<Element>, explained: &mut bool) {
    let mut index = 0;
    while index < elements.len() {
        // 先只读地把句子算出来，算完才动 `elements`
        let note = match &elements[index] {
            Element::Table(table) => table_merge_note(table, *explained),
            _ => None,
        };
        if let Some(text) = note {
            elements.insert(index, note_paragraph(text));
            *explained = true;
            // 说明插在这张表前，表本身挪到了下一个位置
            index += 1;
        }
        // 再处理容器里层的表（嵌套表各自在自己那张表前面补说明）
        match &mut elements[index] {
            Element::Table(table) => {
                for row in &mut table.rows {
                    for cell in &mut row.cells {
                        inject_notes_in_blocks(&mut cell.content, explained);
                    }
                }
            }
            Element::TextBox(text_box) => inject_notes_in_blocks(&mut text_box.content, explained),
            Element::Footnote(footnote) | Element::Endnote(footnote) => {
                inject_notes_in_blocks(&mut footnote.content, explained)
            }
            Element::List(list) => inject_notes_in_list(list, explained),
            _ => {}
        }
        index += 1;
    }
}

/// 列表项里的表（Word 允许列表项里嵌表）—— 与 [`inject_notes_in_blocks`] 同一套走法
fn inject_notes_in_list(list: &mut List, explained: &mut bool) {
    for item in &mut list.items {
        inject_notes_in_blocks(&mut item.content, explained);
        if let Some(nested) = &mut item.nested {
            inject_notes_in_list(nested, explained);
        }
    }
}

/// 一张表的合并说明（没有合并 → `None`）：`merged cells (…): r1c1-r2c1 spans 2 rows; and 3 more`
///
/// 上限是**每张表**各 [`MAX_MENTIONS`] 条（不再是全文件共 8 条）—— 说明贴在表上，就只讲这张表的事。
/// `explained` = 这份文件里完整解释已经讲过了 → 只留 [`TABLE_MERGE_LEAD_SHORT`]。
pub(super) fn table_merge_note(table: &Table, explained: bool) -> Option<String> {
    let mut mentions = Mentions::default();
    for region in table_regions(table) {
        mentions.add(region_text("", &region.rc(), region.spans(), None));
    }
    let lead = if explained {
        TABLE_MERGE_LEAD_SHORT
    } else {
        TABLE_MERGE_LEAD
    };
    mentions.note(lead)
}

/// 一句事实 → IR 里的一个普通段落（库自己的渲染器会把它排在表前、独占一行）
fn note_paragraph(text: String) -> Element {
    Element::Paragraph(Paragraph {
        content: vec![InlineContent::Text(TextSpan::plain(text))],
        ..Default::default()
    })
}

/// 一张表的合并区域（`table_regions` 的坐标是**表内** 0-based）。
///
/// 一旦 span 与网格对不上（只有被裁剪过的 IR 才会这样），就**整张表放弃** —— 坐标宁可没有，
/// 也不能给错的。
fn table_regions(table: &Table) -> Vec<MergeRegion> {
    let rows = table.rows.len();
    if rows == 0 {
        return Vec::new();
    }
    let cell_total: usize = table.rows.iter().map(|row| row.cells.len()).sum();
    // 宽度按**网格列**算，不是按单元格个数
    let width = table
        .rows
        .iter()
        .map(|row| {
            row.cells
                .iter()
                .fold(0usize, |w, c| w.saturating_add(c.col_span.max(1) as usize))
        })
        .max()
        .unwrap_or(0);
    if width == 0 {
        return Vec::new();
    }
    let max_positions = cell_total
        .saturating_mul(MAX_GRID_POSITIONS_PER_CELL)
        .max(MIN_GRID_POSITIONS);
    if rows.saturating_mul(width) > max_positions {
        return Vec::new();
    }

    let mut covered = vec![vec![false; width]; rows];
    let mut regions = Vec::new();
    for (r, row) in table.rows.iter().enumerate() {
        let mut col = 0usize;
        for cell in &row.cells {
            while col < width && covered[r][col] {
                col += 1;
            }
            if col >= width {
                // span 抢的位置比网格还多 —— 与库渲染器的「放弃摊平」同一个分支
                return Vec::new();
            }
            let col_span = (cell.col_span.max(1) as usize).min(width - col);
            let row_span = (cell.row_span.max(1) as usize).min(rows - r);
            if col_span > 1 || row_span > 1 {
                regions.push(MergeRegion::new(
                    r as u32,
                    (r + row_span - 1) as u32,
                    col as u32,
                    (col + col_span - 1) as u32,
                ));
            }
            for covered_row in &mut covered[r..r + row_span] {
                covered_row[col..col + col_span].fill(true);
            }
            col += col_span;
        }
    }
    regions
}