//! Office 文档抽文字（`.docx` / `.doc` / `.xlsx` / `.xls` / `.pptx` / `.ppt`）—— 走 `office_oxide`。
//!
//! ⚠️ **本文件是本仓库唯一引用 `office_oxide` 的地方**：换实现（`calamine` + 自研 docx 解析）
//! 时只需要改这里。用到的接口只有：`Document::open` / `format` / `plain_text` / `to_ir` /
//! `to_markdown`（外加 `as_xlsx` / `as_xls` 拿工作表与**原始合并区域**），以及表格自己那一份
//! 文档对象的 `XlsxDocument::open` / `XlsDocument::open`（见 [`Spreadsheet`]）。
//!
//! 文本形态按格式分档（都是给模型看的，故不做花哨排版）：
//! - **表格**（`xlsx` / `xls`）：工作表名一行 + 制表符分隔的行 —— Markdown 表格列一多就全是 `|`，
//!   费 token 且更难读；`sheet` 参数可只取一张表（`xlsx` 用库的 `sheet_plain_text`，
//!   `xls` 用库的 `Sheet::display_text` 逐格渲染，**不自己解数字格式**）。
//!   ⚠️ 正文仍走库自带的渲染器而**不是** IR：它按**单元格坐标**补 tab，列对齐本来就对，
//!   且 comments / 文本框 / 透视缓存这些旁路内容都在里面；换 IR 要重新验证那些是否仍齐全，
//!   收益为 0。合并与图片信息由 [`Mentions`] 单独补（见下）。
//!   ⚠️ 渲染之前**先把格内换行 / 制表符压成空格**（[`flatten_breaks`]）：值里的换行（Excel 的
//!   Alt+Enter、列太窄时折行后**存进值里**的换行）会被渲染器逐字写出来，把这一行剩下的列全顶到
//!   下一行 —— 「一行 = 一条记录、制表符分列」当场失效（实测：一张 3 列的表头行被拆成 4 行）。
//!   压平是在**值**这一层改，所以要可变所有权：表格由本模块**自己打开并持有**（[`Spreadsheet`]）。
//! - **文稿 / 演示**（`docx` / `doc` / `pptx` / `ppt`）：Markdown —— 标题、列表、表格都是结构信息，
//!   丢了对模型是净损失。
//!   ⚠️ **必须走 IR（`to_ir().to_markdown()`），不能用 `Document::to_markdown()`**：后者是库的
//!   自带渲染器，按 `row.cells` 顺序拼格，完全不看 `gridSpan` / `vMerge` —— 行中间有横向合并时，
//!   它右边的单元格会整体左移（实测：`[合计(跨 2 列), 备注]` 输出成 `| 合计 | 备注 |  |`，
//!   「备注」本该在第 3 列）。IR 路径把 span 摊成网格，锚点落左上角、被覆盖位留空，列对齐才是对的。
//!
//! **合并单元格**（`MERGEDCELLS` / `gridSpan` / `vMerge`）在网格里只体现为「某个位置是空的」，
//! 「合并」与「真空」分不出来，而 GFM 表格也没有 span 语法 —— 所以合并区域总得单独讲一句
//! （[`Mentions`]）。讲在**哪儿**按「模型能不能对上号」分两种：
//! - **表格**（`xlsx` / `xls`）：正文是「表名一行 + 制表符分列的行」，一句总说明里用 Excel 自己的
//!   `表名!A1:D1` 就定位得到（`sheet` 选单张表时连前缀都省），所以照旧放进 `DocText::note`
//!   —— 模型与界面都看得到，且不占正文、不影响分页计数。
//! - **文稿 / 演示**（`docx` / `doc` / `pptx` / `ppt`）：正文里**没有**任何「第 N 张表」的坐标，
//!   而一张报告动辄几十张表带合并（实测那份审核报告 39 张）—— 总说明写成「table 7 r1c1-r1c2 …」
//!   模型根本对不上号。所以改为**就地**在**那张表前面**插一句段落（[`inject_table_notes`]），
//!   由库自己的渲染器排出位置，坐标与正文同源。
//!   ⚠️ 完整解释（括号那句）只在**第一张**带合并的表前讲一次 —— 同一份文件里带合并的表能有
//!   几十张，同一句解释重复几十遍纯是噪音；后面的表只留 `merged cells:` 短开头，条目仍然
//!   各归自己那张表。
//!
//! **图片**是同一类问题里更彻底的一种：渲染器只画文字 —— `xlsx` 的 `<xdr:pic>`（含 Excel 365
//! 「放在单元格里的图片」）与 `.xls` 的 `MsoDrawingGroup` 里的 BLIP **一个字都不会进正文**，
//! 模型看到的就是「这里本来就没东西」；而中文报表里的图片经常盛的正是数据。所以图片也进那句
//! 说明：**只报存在**（哪张表、第几张、格式、显示尺寸、字节数、alt 文本），**不读图的内容**
//! （读图是 PDF 那条路的事，见 `doc_parse::ocr`）。库没有解析出「图片名」（`<xdr:cNvPr>` 的
//! `name` 不在它的模型里）—— 不编这个名字，用「`表名!image 序号` + 格式 + 尺寸 + alt」定位。
//!
//! 未做（如实报错，不猜）：加密（口令保护）文档、扫描件、`.doc` 里的嵌入对象、Word 纵向合并
//! **续格**里的内容（IR 按 Word 的显示语义把它丢掉，要恢复得再走一遍原始 docx 模型，收益极低）。

use std::borrow::Cow;

use office_oxide::ir::{DocumentIR, Element, InlineContent, List, Paragraph, Table, TextSpan};
use office_oxide::xls::{Sheet, XlsDocument, XlsImage};
use office_oxide::xlsx::worksheet::WorksheetPicture;
use office_oxide::xlsx::{Cell, CellRef, CellValue, SharedStringTable, Worksheet, XlsxDocument};
use office_oxide::{Document, DocumentFormat};

use super::ParseError;

// ═══════════════════════════════════════════════════════════════════════════
// 合并单元格
// ═══════════════════════════════════════════════════════════════════════════

/// 一句说明里最多列几条（合并区域 / 图片各自计数）—— 一张满是合并或满是图的表
/// 不该把说明写成一篇长文
const MAX_MENTIONS: usize = 8;

/// 合并说明的开头 —— 先讲清「为什么被覆盖的位置是空的」，后面接区域清单
const MERGE_LEAD: &str =
    "merged cells show a value only in the region's top-left cell, the rest of its grid positions are empty";

/// 文稿 / 演示的合并说明开头 —— 贴在**同一份文件里第一张**带合并的表前，把「为什么被覆盖的
/// 位置是空的」这一层一次讲清（此后各表只留 [`TABLE_MERGE_LEAD_SHORT`]）。
const TABLE_MERGE_LEAD: &str =
    "merged cells (only the region's top-left cell shows its value, the rest is empty)";

/// 后面各张表的合并说明开头 —— 解释**只讲一次**：同一份文件里带合并的表能有几十张
/// （实测那份审核报告 39 张），同一句解释重复几十遍纯是噪音；但「这些一个字都没有的空位是合并
/// 留下的」这层意思每张表都得留一句，否则紧接着的表格还是会被读成「本来就是空的」。
const TABLE_MERGE_LEAD_SHORT: &str = "merged cells";

/// 说明里引用「被覆盖格里另存的值」时最多显示多少字符
const MAX_HIDDEN_VALUE_CHARS: usize = 40;

/// 合并区域摊成网格时的位置上限（每个单元格最多铺几个位置）
///
/// ⚠️ 与库的 `ir_render::table_grid` 同口径：span 是不可信输入，`行 x 宽` 得先算出来再拒绝，
/// 否则一个被裁剪过的 IR 就能让这里分配一块巨大的网格。
const MAX_GRID_POSITIONS_PER_CELL: usize = 64;

/// 见 [`MAX_GRID_POSITIONS_PER_CELL`]：小表里合法的大合并区始终保留坐标
const MIN_GRID_POSITIONS: usize = 1 << 20;

/// 一片合并区域（0-based 闭区间）
#[derive(Debug, Clone, PartialEq, Eq)]
struct MergeRegion {
    row_first: u32,
    row_last: u32,
    col_first: u32,
    col_last: u32,
}

impl MergeRegion {
    fn new(row_first: u32, row_last: u32, col_first: u32, col_last: u32) -> Self {
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
    fn is_merge(&self) -> bool {
        self.rows() > 1 || self.cols() > 1
    }

    /// `A1:D1` —— 电子表格用（Excel 自己的记法，用户和模型都熟）
    fn a1(&self) -> String {
        format!(
            "{}{}:{}{}",
            CellRef::col_name(self.col_first),
            self.row_first + 1,
            CellRef::col_name(self.col_last),
            self.row_last + 1
        )
    }

    /// `r1c1-r1c3` —— 文稿表格用（Word 的表没有列标）：1-based、表内计数
    fn rc(&self) -> String {
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

/// 一句说明的收集器（合并区域 / 图片共用）：只留前 [`MAX_MENTIONS`] 条的文本，但要数得清总数
///
/// 为什么不是「直接拼一句 String」：整册工作簿的说明要把多张表的区域混在一句里，得能分辨区域
/// 属于哪张表（用 Excel 自己的 `表名!A1` 记法），所以每个来源各自渲染好一句话再交进来。
#[derive(Default)]
struct Mentions {
    /// 前几条的说明（多出来的只计数）
    texts: Vec<String>,
    /// 真实总数（说明里那句「and N more」靠它）
    total: usize,
}

impl Mentions {
    /// 已经列满了 —— 后面的区域不必再为「被覆盖格里的值」去扫单元格
    fn full(&self) -> bool {
        self.texts.len() >= MAX_MENTIONS
    }

    fn add(&mut self, text: String) {
        self.total += 1;
        if !self.full() {
            self.texts.push(text);
        }
    }

    /// `DocText::note` 的那句话（没有条目 → `None`）：`<开头>: <条目…>[; and N more]`
    fn note(&self, lead: &str) -> Option<String> {
        if self.total == 0 {
            return None;
        }
        let mut parts = self.texts.clone();
        if self.total > self.texts.len() {
            parts.push(format!("and {} more", self.total - self.texts.len()));
        }
        Some(format!("{lead}: {}", parts.join("; ")))
    }
}

/// 一条区域的说明：`<前缀><位置> <跨几行几列>[ (被覆盖格里另存的值)]`
fn region_text(prefix: &str, place: &str, spans: String, hidden: Option<&str>) -> String {
    match hidden {
        Some(value) => format!("{prefix}{place} {spans} (a covered cell also holds {value:?})"),
        None => format!("{prefix}{place} {spans}"),
    }
}

/// 说明里引用一个值：空白 → `None`；过长 → 截断（只要够模型看出「这里还有别的数据」）
fn shrink(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.chars().count() <= MAX_HIDDEN_VALUE_CHARS {
        return Some(trimmed.to_string());
    }
    let head: String = trimmed.chars().take(MAX_HIDDEN_VALUE_CHARS).collect();
    Some(format!("{head}…"))
}

/// 一张 `.xlsx` 工作表的合并区域 —— 直接读工作表自己的 `merged_cells`（`"A1:C1"`，就是 Excel 存的那份）
fn collect_xlsx_merges(
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
fn parse_a1_range(range: &str) -> Option<MergeRegion> {
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
fn collect_xls_merges(sheet: &Sheet, prefix: &str, out: &mut Mentions) {
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
fn inject_table_notes(ir: &mut DocumentIR) {
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
fn table_merge_note(table: &Table, explained: bool) -> Option<String> {
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

// ══════════════════════════════════════════════════════════════════════════
// 图片：只报存在，不读内容
// ══════════════════════════════════════════════════════════════════════════

/// 图片说明的开头（数量写在句子里：`1 image` / `3 images`）
///
/// `scope` 说清「图是哪来的」：整册 = `the workbook`，选单表 = `this sheet`，
/// `.xls`（图片是全簿共用的，归属哪张表读不出来）= `the workbook (sheet unknown)`。
fn images_lead(scope: &str, total: usize) -> String {
    let noun = if total == 1 { "image" } else { "images" };
    format!("image contents are not extracted; {scope} holds {total} {noun}")
}

/// 一条图片说明：`<前缀>image <序号> (<事实…>)`
fn image_text(prefix: &str, number: usize, facts: &[String]) -> String {
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
fn collect_xlsx_images(ws: &Worksheet, prefix: &str, out: &mut Mentions) {
    for (index, pic) in ws.images.iter().enumerate() {
        out.add(image_text(prefix, index + 1, &xlsx_image_facts(pic)));
    }
}

/// `.xls` 图片能报的事实：格式 / 字节数（旧二进制格式里没有显示尺寸，也没有 alt 文本）
fn xls_image_facts(pic: &XlsImage) -> Vec<String> {
    vec![
        pic.format.extension().to_string(),
        human_bytes(pic.data.len()),
    ]
}

/// 一份 `.xls` 的图片 —— 库里只有**工作簿级**的一份（`MsoDrawingGroup` 是所有表共用的，
/// BLIP 与具体工作表之间的链接库没建立），所以只能讲「这个文件有图」，讲不出在哪张表
fn collect_xls_images(book: &XlsDocument, out: &mut Mentions) {
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

/// 多句说明 → `DocText::note`（都没话 → `None`；句子之间用 ` · `，
/// 与「sheet 参数在 Word 上被忽略」那句同一口径）
fn join_notes(notes: &[Option<String>]) -> Option<String> {
    let mut out = String::new();
    for note in notes.iter().flatten() {
        if !out.is_empty() {
            out.push_str(" · ");
        }
        out.push_str(note);
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

// ══════════════════════════════════════════════════════════════════════════
// 格内换行 / 制表符
// ══════════════════════════════════════════════════════════════════════════

/// 格内换行 / 制表符 → 空格。
///
/// 为什么必须压平：工作表的正文版式是「一行 = 一条记录、制表符分列」，而渲染器把格内文本**逐字**
/// 写出来 —— 值里的一个换行（Excel 的 Alt+Enter、或列太窄时折行后跟着值一起存下来的换行）就把
/// 这一行剩下的列全顶到下一行，列与列的对应全断（实测：一张 3 列的表头行被拆成 4 行）；格内制表符
/// 更会凭空多出一列。压成空格后词间距仍在、一行一条记录的版式也保住了。
///
/// 分段两侧的空白顺手 trim（折行留下的缩进 / 尾随空格都不是内容），连续空行合成一个空格；
/// 没有可压平的东西就原样借用，不分配。
fn flatten_breaks(text: &str) -> Cow<'_, str> {
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
fn flatten_shared_strings(table: &mut SharedStringTable) {
    for entry in &mut table.strings {
        flatten_in_place(&mut entry.text);
    }
}

/// 整册 `.xlsx`：共享字符串表 + 单元格里的内联字符串
fn flatten_xlsx_breaks(book: &mut XlsxDocument) {
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
fn flatten_xls_breaks(book: &mut XlsDocument) {
    for sheet in &mut book.sheets {
        flatten_sheet_breaks(sheet);
    }
}

/// 一张 `.xls` 工作表（单独一个函数：旧二进制格式没法在测试里造，只能手工拼 [`Sheet`] 来验）
fn flatten_sheet_breaks(sheet: &mut Sheet) {
    for row in &mut sheet.rows {
        for cell in row {
            if let office_oxide::xls::CellValue::String(text) = cell {
                flatten_in_place(text);
            }
        }
    }
}

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

/// 抽一个 Office 文档的文本。
///
/// `ext` 既用于错误文案，也用于**先按哪种类型打开**：表格（`xlsx` / `xls`）要压平格内换行
/// （[`flatten_breaks`]），那是在**值**这一层改、需要可变所有权 —— 所以表格自己开、自己持有
/// （[`Spreadsheet`]）；开不出来才落到 `Document::open` 那条路（扩展名骗人 / 加密包 / 损坏），
/// 容器嗅探与错误文案都归库。
pub fn extract_text(path: &str, sheet: Option<&str>, ext: &str) -> Result<OfficeText, ParseError> {
    if let Some(book) = Spreadsheet::open(path, ext) {
        return book.flattened_text(sheet);
    }

    // 文稿 / 演示，或**按扩展名开不出来的表格**
    let doc = Document::open(path).map_err(|e| backend_error(ext, e))?;
    match doc.format() {
        // 扩展名与容器不符的表格（比如 `.xls` 里装的其实是 `.xlsx`）：库刚确认了真格式，
        // 按真格式开一份可变的再净化 —— 同一份文件刚解析成功过，这次必开得出来
        DocumentFormat::Xlsx | DocumentFormat::Xls => {
            Spreadsheet::open_as(path, doc.format(), ext)?.flattened_text(sheet)
        }
        _ => Ok(doc_text(&doc, sheet)),
    }
}

/// 一份**自己打开的**表格文档（`xlsx` / `xls`）。
///
/// 为什么要自己持有：格内换行 / 制表符要先压成空格（见 [`flatten_breaks`]）—— 那是在值这一层
/// 改，而 `Document` 只给只读引用。
///
/// 两个变体都装箱：文档对象本身是千字节级的（`clippy::large_enum_variant`），枚举本体只该是两个指针。
enum Spreadsheet {
    Xlsx(Box<XlsxDocument>),
    Xls(Box<XlsDocument>),
}

impl Spreadsheet {
    /// 按扩展名开（不是表格、或打不开 → `None`）
    fn open(path: &str, ext: &str) -> Option<Self> {
        match ext {
            "xlsx" => XlsxDocument::open(path).map(Box::new).ok().map(Self::Xlsx),
            "xls" => XlsDocument::open(path).map(Box::new).ok().map(Self::Xls),
            _ => None,
        }
    }

    /// 按**库判定的**真格式开：扩展名与容器不符时走这条
    fn open_as(path: &str, kind: DocumentFormat, ext: &str) -> Result<Self, ParseError> {
        match kind {
            DocumentFormat::Xlsx => XlsxDocument::open(path)
                .map(Box::new)
                .map(Self::Xlsx)
                .map_err(|e| backend_error(ext, e)),
            _ => XlsDocument::open(path)
                .map(Box::new)
                .map(Self::Xls)
                .map_err(|e| backend_error(ext, e)),
        }
    }

    /// 压平格内换行 / 制表符，再渲染
    fn flattened_text(self, sheet: Option<&str>) -> Result<OfficeText, ParseError> {
        match self {
            Self::Xlsx(mut book) => {
                flatten_xlsx_breaks(&mut book);
                xlsx_text(&book, sheet)
            }
            Self::Xls(mut book) => {
                flatten_xls_breaks(&mut book);
                xls_text(&book, sheet)
            }
        }
    }
}

/// 一份 `.xlsx` 的文本（`sheet` 给定时只取那一张工作表）
fn xlsx_text(book: &XlsxDocument, sheet: Option<&str>) -> Result<OfficeText, ParseError> {
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
fn xls_text(book: &XlsDocument, sheet: Option<&str>) -> Result<OfficeText, ParseError> {
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
fn doc_text(doc: &Document, sheet: Option<&str>) -> OfficeText {
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
fn backend_error(ext: &str, error: impl std::fmt::Display) -> ParseError {
    ParseError::Backend {
        format: ext.to_string(),
        message: error.to_string(),
    }
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
fn render_xls_sheet(sheet: &Sheet) -> String {
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

    // ══════════════════════ 合并单元格 ══════════════════════

    fn tmp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("virlen_office_{tag}_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 造一份最小 docx（`word/document.xml` 的正文由调用方给）——
    /// 表格里的 `gridSpan` / `vMerge` 没法用库的写入 API 造，只能直接拼 OOXML
    fn write_docx(dir: &std::path::Path, document_xml: &str) -> String {
        use std::io::Write;
        const CONTENT_TYPES: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>"#;
        const ROOT_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"#;

        let path = dir.join("t.docx");
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
        let options: zip::write::FileOptions<'_, ()> = zip::write::FileOptions::default();
        for (name, body) in [
            ("[Content_Types].xml", CONTENT_TYPES),
            ("_rels/.rels", ROOT_RELS),
            ("word/document.xml", document_xml),
        ] {
            zip.start_file(name, options).unwrap();
            zip.write_all(body.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
        path.to_str().unwrap().to_string()
    }

    /// 3 列表，首行的「合计」横跨 2 列
    const DOCX_MIDDLE_MERGE: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:tbl>
      <w:tblGrid>
        <w:gridCol w:w="2000"/><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/>
      </w:tblGrid>
      <w:tr>
        <w:tc>
          <w:tcPr><w:gridSpan w:val="2"/></w:tcPr>
          <w:p><w:r><w:t>合计</w:t></w:r></w:p>
        </w:tc>
        <w:tc><w:p><w:r><w:t>备注</w:t></w:r></w:p></w:tc>
      </w:tr>
      <w:tr>
        <w:tc><w:p><w:r><w:t>销量</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>金额</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>含税</w:t></w:r></w:p></w:tc>
      </w:tr>
    </w:tbl>
  </w:body>
</w:document>"#;

    /// 2 列表，首列的「华东」纵跨第 2~3 行
    const DOCX_VERTICAL_MERGE: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:tbl>
      <w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>
      <w:tr>
        <w:tc><w:p><w:r><w:t>地区</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>销量</w:t></w:r></w:p></w:tc>
      </w:tr>
      <w:tr>
        <w:tc>
          <w:tcPr><w:vMerge w:val="restart"/></w:tcPr>
          <w:p><w:r><w:t>华东</w:t></w:r></w:p>
        </w:tc>
        <w:tc><w:p><w:r><w:t>120</w:t></w:r></w:p></w:tc>
      </w:tr>
      <w:tr>
        <w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc>
        <w:tc><w:p><w:r><w:t>80</w:t></w:r></w:p></w:tc>
      </w:tr>
    </w:tbl>
  </w:body>
</w:document>"#;

    /// 表格的**行中间**有横向合并时，右边的单元格不能左移
    /// （库自带的 `to_markdown()` 会输出 `| 合计 | 备注 |  |`，「备注」本该在第 3 列）
    #[test]
    fn rows_with_a_middle_merge_keep_their_columns() {
        let dir = tmp_dir("merge_mid");
        let path = write_docx(&dir, DOCX_MIDDLE_MERGE);
        let out = extract_text(&path, None, "docx").unwrap();

        assert!(
            out.text.contains("| 合计 |  | 备注 |"),
            "「备注」必须留在第 3 列：{}",
            out.text
        );
        // 说明**就地**落在这张表前面（不再堆到文件最前面 —— 模型看不到「table 1」这种坐标）
        assert_eq!(out.note, None, "文稿的合并说明不再进 note：{:?}", out.note);
        let lines: Vec<&str> = out.text.lines().collect();
        let marker = merge_marker(&lines);
        assert_eq!(
            lines[marker],
            "merged cells (only the region's top-left cell shows its value, the rest is empty): \
             r1c1-r1c2 spans 2 columns"
        );
        assert_eq!(lines[marker + 1], "", "说明与表格之间隔一个空行");
        assert_eq!(lines[marker + 2], "| 合计 |  | 备注 |", "说明要贴着它那张表");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 纵向合并（`vMerge`）：说明里要点出跨了几行，且被覆盖位不能把后面的列挤走
    #[test]
    fn vertical_merges_are_reported() {
        let dir = tmp_dir("merge_vertical");
        let path = write_docx(&dir, DOCX_VERTICAL_MERGE);
        let out = extract_text(&path, None, "docx").unwrap();

        assert!(
            out.text.contains("|  | 80 |"),
            "纵向合并的续格位置要留空：{}",
            out.text
        );
        let lines: Vec<&str> = out.text.lines().collect();
        let marker = merge_marker(&lines);
        assert!(
            lines[marker].ends_with(": r2c1-r3c1 spans 2 rows"),
            "{}",
            lines[marker]
        );
        assert_eq!(lines[marker + 2], "| 地区 | 销量 |", "说明要贴着它那张表");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 三张表，只有**中间**那张带横向合并：说明必须出现在那张表前面，
    /// 而不是像以前那样全部堆到文件最前面（总说明只能写「table 2 r1c1-r1c2」，
    /// 而正文里没有这个坐标，模型对不上号）
    const DOCX_THREE_TABLES_ONE_MERGED: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>第一张表</w:t></w:r></w:p>
    <w:tbl>
      <w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>
      <w:tr>
        <w:tc><w:p><w:r><w:t>甲</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>乙</w:t></w:r></w:p></w:tc>
      </w:tr>
    </w:tbl>
    <w:p><w:r><w:t>第二张表</w:t></w:r></w:p>
    <w:tbl>
      <w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>
      <w:tr>
        <w:tc>
          <w:tcPr><w:gridSpan w:val="2"/></w:tcPr>
          <w:p><w:r><w:t>合并表头</w:t></w:r></w:p>
        </w:tc>
      </w:tr>
      <w:tr>
        <w:tc><w:p><w:r><w:t>丙</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>丁</w:t></w:r></w:p></w:tc>
      </w:tr>
    </w:tbl>
    <w:p><w:r><w:t>第三张表</w:t></w:r></w:p>
    <w:tbl>
      <w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>
      <w:tr>
        <w:tc><w:p><w:r><w:t>戊</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>己</w:t></w:r></w:p></w:tc>
      </w:tr>
    </w:tbl>
  </w:body>
</w:document>"#;

    /// 找一个行号：说明应该是正文里**独占一行**的一句
    fn merge_marker(lines: &[&str]) -> usize {
        lines
            .iter()
            .position(|line| line.starts_with("merged cells"))
            .expect("应该有一句合并说明")
    }

    #[test]
    fn each_table_carries_its_own_merge_note() {
        let dir = tmp_dir("merge_per_table");
        let path = write_docx(&dir, DOCX_THREE_TABLES_ONE_MERGED);
        let out = extract_text(&path, None, "docx").unwrap();

        assert_eq!(out.note, None, "文稿的合并说明不再进 note：{:?}", out.note);
        let lines: Vec<&str> = out.text.lines().collect();
        assert_eq!(
            lines.iter().filter(|l| l.starts_with("merged cells")).count(),
            1,
            "只有中间那张表带合并：{:#?}",
            out.text
        );
        let marker = merge_marker(&lines);
        assert_eq!(lines[marker + 1], "", "说明与表之间隔一个空行");
        assert_eq!(
            lines[marker + 2],
            "| 合并表头 |  |",
            "说明要贴着它那张表：{}",
            out.text
        );
        // 前面那张表（以及后面的段落）都不该被这句说明带上
        let before = lines[..marker].join("\n");
        assert!(before.contains("| 甲 | 乙 |"), "{before}");
        assert!(!before.contains("merged cells"), "{before}");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 完整解释**只讲一次**：第一张带合并的表拿到括号那句，后面的表只留 `merged cells:`；
    /// 没合并的表一张说明都不给（说明仍然各自贴在自己那张表前）
    #[test]
    fn the_explanation_is_given_only_once() {
        use office_oxide::ir::{Section, TableCell, TableRow};

        let table = |merged: bool| {
            let cells = if merged {
                vec![TableCell {
                    col_span: 2,
                    ..Default::default()
                }]
            } else {
                vec![TableCell::default()]
            };
            Table {
                rows: vec![TableRow {
                    cells,
                    ..Default::default()
                }],
                ..Default::default()
            }
        };
        let mut ir = DocumentIR {
            sections: vec![Section {
                elements: vec![
                    Element::Table(table(true)),
                    Element::Table(table(false)),
                    Element::Table(table(true)),
                ],
                ..Default::default()
            }],
            ..Default::default()
        };
        inject_table_notes(&mut ir);

        let elements = &ir.sections[0].elements;
        let shape: Vec<&str> = elements
            .iter()
            .map(|element| match element {
                Element::Paragraph(_) => "note",
                Element::Table(_) => "table",
                _ => "other",
            })
            .collect();
        assert_eq!(
            shape,
            vec!["note", "table", "table", "note", "table"],
            "说明各自贴在自己那张表前，没合并的表不给说明"
        );

        let notes: Vec<String> = elements
            .iter()
            .filter_map(|element| match element {
                Element::Paragraph(paragraph) => {
                    paragraph.content.iter().find_map(|inline| match inline {
                        InlineContent::Text(span) => Some(span.text.clone()),
                        _ => None,
                    })
                }
                _ => None,
            })
            .collect();
        assert_eq!(
            notes,
            vec![
                format!("{TABLE_MERGE_LEAD}: r1c1-r1c2 spans 2 columns"),
                format!("{TABLE_MERGE_LEAD_SHORT}: r1c1-r1c2 spans 2 columns"),
            ],
            "解释只在第一句里，第二句只留短开头且条目一字不少：{notes:?}"
        );
        assert_eq!(
            notes
                .iter()
                .filter(|note| note.starts_with(TABLE_MERGE_LEAD))
                .count(),
            1,
            "同一句解释不能讲两遍：{notes:?}"
        );
    }

    /// 上限是**每张表**各 [`MAX_MENTIONS`] 条（不再是全文件共 8 条）：
    /// 说明贴在表上，就只讲这张表的事
    #[test]
    fn every_table_has_its_own_mention_cap() {
        use office_oxide::ir::{TableCell, TableRow};

        let spanned = |rows: usize| Table {
            rows: (0..rows)
                .map(|_| TableRow {
                    cells: vec![TableCell {
                        col_span: 2,
                        ..Default::default()
                    }],
                    ..Default::default()
                })
                .collect(),
            ..Default::default()
        };

        let note = table_merge_note(&spanned(MAX_MENTIONS + 4), false).unwrap();
        assert!(note.starts_with(TABLE_MERGE_LEAD), "{note}");
        assert!(
            note.contains(&format!("r{MAX_MENTIONS}c1-r{MAX_MENTIONS}c2 spans 2 columns")),
            "{note}"
        );
        assert!(
            !note.contains(&format!("r{}c1", MAX_MENTIONS + 1)),
            "第 9 条只计数、不展开：{note}"
        );
        assert!(note.contains("and 4 more"), "{note}");

        // 另一张表各算各的：两张表合起来也不串
        let other = table_merge_note(&spanned(2), false).unwrap();
        assert!(other.contains("r1c1-r1c2") && other.contains("r2c1-r2c2"), "{other}");
        assert!(!other.contains("more"), "{other}");
        assert!(table_merge_note(&spanned(0), false).is_none(), "没有行就没有说明");

        // 完整解释已经在这个文件里讲过了 → 只留短开头
        assert_eq!(
            table_merge_note(&spanned(2), true).unwrap(),
            format!("{TABLE_MERGE_LEAD_SHORT}: r1c1-r1c2 spans 2 columns; r2c1-r2c2 spans 2 columns")
        );
    }

    /// 没有合并 → 一个字的说明都不加（这句话只该在真有时出现）
    #[test]
    fn documents_without_merges_carry_no_note() {
        let out = extract_text(&fixture("SampleDoc.docx"), None, "docx").unwrap();
        assert_eq!(out.note, None, "实际：{:?}", out.note);
        assert!(
            !out.text.contains("merged cells"),
            "没有合并就不该有说明：{}",
            out.text
        );
    }

    /// `.xlsx`：区域直接来自 `MERGEDCELLS`（A1 记法），被覆盖格里另存的值得说明
    #[test]
    fn xlsx_merges_use_a1_notation_and_report_covered_values() {
        let dir = tmp_dir("merge_xlsx");
        let path = dir.join("merged.xlsx");
        {
            let mut writer = office_oxide::xlsx::write::XlsxWriter::new();
            {
                let mut sheet = writer.add_sheet("销售");
                let grid = [
                    ["季度合计", "", "", ""],
                    ["地区", "销量", "金额", "备注"],
                    ["华东", "120", "3400", "含税"],
                    ["华南", "80", "2100", ""],
                ];
                for (row, cells) in grid.iter().enumerate() {
                    for (col, value) in cells.iter().enumerate() {
                        if !value.is_empty() {
                            sheet.set_cell(
                                row,
                                col,
                                office_oxide::xlsx::write::CellData::String(value.to_string()),
                            );
                        }
                    }
                }
                // 表头横跨 4 列；A3:A4 纵向合并（左上角是「华东」，被覆盖的 A4 里还留着「华南」）
                sheet.merge_cells(0, 0, 1, 4);
                sheet.merge_cells(2, 0, 2, 1);
            }
            writer.save(&path).unwrap();
        }

        let out = extract_text(path.to_str().unwrap(), None, "xlsx").unwrap();
        let note = out.note.expect("xlsx 的合并必须给出一句说明");
        assert!(note.contains("销售!A1:D1 spans 4 columns"), "{note}");
        assert!(note.contains("销售!A3:A4 spans 2 rows"), "{note}");
        assert!(
            note.contains("a covered cell also holds \"华南\""),
            "被覆盖的值不能静默丢掉：{note}"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// `.xls`：`MERGEDCELLS` 的四元组 → 区域，被覆盖格里的值同样要说明
    /// （旧二进制格式没法在测试里造，所以手工拼一张 `Sheet`：字段全是公开的）
    #[test]
    fn xls_merges_and_covered_values_are_reported() {
        use office_oxide::xls::CellValue as XlsValue;

        let sheet = Sheet {
            rows: vec![
                vec![XlsValue::String("季度合计".into())],
                vec![XlsValue::String("地区".into()), XlsValue::String("销量".into())],
                vec![XlsValue::String("华东".into()), XlsValue::Number(120.0)],
                vec![XlsValue::String("华南".into()), XlsValue::Number(80.0)],
            ],
            merged_cells: vec![(0, 0, 0, 1), (2, 3, 0, 0)],
            ..Default::default()
        };

        let mut merges = Mentions::default();
        collect_xls_merges(&sheet, "", &mut merges);
        let note = merges.note(MERGE_LEAD).expect("合并必须给出一句说明");
        assert!(note.contains("A1:B1 spans 2 columns"), "{note}");
        assert!(note.contains("A3:A4 spans 2 rows"), "{note}");
        assert!(note.contains("also holds \"华南\""), "{note}");
        assert_eq!(merges.total, 2);
    }

    /// 说明里最多列 [`MAX_MENTIONS`] 条，剩下的只计数
    #[test]
    fn mentions_are_capped_but_still_counted() {
        let mut merges = Mentions::default();
        for index in 0..(MAX_MENTIONS + 4) {
            merges.add(format!("region {index}"));
        }
        let note = merges.note(MERGE_LEAD).unwrap();
        assert!(note.contains(&format!("region {}", MAX_MENTIONS - 1)), "{note}");
        assert!(!note.contains(&format!("region {MAX_MENTIONS}")), "{note}");
        assert!(note.contains("and 4 more"), "{note}");
        assert_eq!(merges.total, MAX_MENTIONS + 4);
    }

    /// A1 记法的区域：没有冒号不是合并、首尾反着写要归一、越界引用挡掉
    #[test]
    fn a1_ranges_are_parsed_and_normalized() {
        assert!(parse_a1_range("A1").is_none(), "单格不是合并区");
        assert_eq!(parse_a1_range("A1:C1"), Some(MergeRegion::new(0, 0, 0, 2)));
        assert_eq!(parse_a1_range("C1:A1"), Some(MergeRegion::new(0, 0, 0, 2)), "反着写也要归一");
        assert!(parse_a1_range("A1:ZZZZZZ1").is_none(), "越界引用挡掉");
        assert!(!MergeRegion::new(2, 2, 5, 5).is_merge(), "单格不算合并");
        assert_eq!(MergeRegion::new(0, 1, 0, 3).a1(), "A1:D2");
        assert_eq!(MergeRegion::new(2, 3, 0, 0).rc(), "r3c1-r4c1");
    }

    // ══════════════════════ 格内换行 / 制表符 ══════════════════════

    /// 造一份含格内换行 / 制表符的 `.xlsx`（写完就关：读者只认文件）
    fn write_xlsx_with_breaks(path: &std::path::Path) {
        let mut writer = office_oxide::xlsx::write::XlsxWriter::new();
        {
            let mut sheet = writer.add_sheet("到资晾晒单");
            let grid = [
                ["指标", "2026年新签约\n项目投资到位率（%）", "动工项目\n数量\n（个）"],
                ["高新区", "64.7%", "22"],
                ["英德市", "甲\t乙", "27.1%"],
            ];
            for (row, cells) in grid.iter().enumerate() {
                for (col, value) in cells.iter().enumerate() {
                    sheet.set_cell(
                        row,
                        col,
                        office_oxide::xlsx::write::CellData::String(value.to_string()),
                    );
                }
            }
        }
        writer.save(path).unwrap();
    }

    /// 格内的换行（Excel 的 Alt+Enter、列窄时折行后**存进值里**的换行）不能把一行拆成多行：
    /// 工作表的正文版式是「一行 = 一条记录、制表符分列」，一个换行就把这一行剩下的列全顶下去
    #[test]
    fn xlsx_cells_with_line_breaks_stay_on_their_row() {
        let dir = tmp_dir("xlsx_breaks");
        let path = dir.join("breaks.xlsx");
        write_xlsx_with_breaks(&path);

        let out = extract_text(path.to_str().unwrap(), None, "xlsx").unwrap();
        let lines: Vec<&str> = out.text.lines().collect();
        assert_eq!(lines.len(), 4, "表名 + 3 行数据，一行都不该多：{lines:#?}");
        assert_eq!(lines[0], "到资晾晒单");
        assert_eq!(
            lines[1],
            "指标\t2026年新签约 项目投资到位率（%）\t动工项目 数量 （个）"
        );
        assert_eq!(lines[1].matches('\t').count(), 2, "3 列就是 2 个制表符");
        assert_eq!(lines[2], "高新区\t64.7%\t22");
        assert_eq!(lines[3], "英德市\t甲 乙\t27.1%", "格内制表符会凭空多出一列");

        // 选单表那条路（`sheet_plain_text`）同样不能拆行
        let one = extract_text(path.to_str().unwrap(), Some("到资晾晒单"), "xlsx").unwrap();
        assert_eq!(one.sheet.as_deref(), Some("到资晾晒单"));
        assert!(one.text.contains("动工项目 数量 （个）"), "实际：{}", one.text);
        assert_eq!(one.text.lines().count(), 4, "实际：{}", one.text);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 扩展名与容器不符的表格（`.xls` 里装的其实是 `.xlsx`）走的是「库判真格式 + 再开一份」
    /// 那条兜底路 —— 也得压平
    #[test]
    fn mislabeled_spreadsheet_is_still_flattened() {
        let dir = tmp_dir("xlsx_mislabeled");
        let path = dir.join("报表.xls");
        write_xlsx_with_breaks(&path);

        let out = extract_text(path.to_str().unwrap(), None, "xls").unwrap();
        assert_eq!(out.text.lines().count(), 4, "实际：{}", out.text);
        assert!(out.text.contains("动工项目 数量 （个）"), "实际：{}", out.text);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 压平规则：换行 / 回车 / 制表符 → 一个空格；连续空行合成一个；折行留下的缩进不算内容
    #[test]
    fn in_cell_breaks_flatten_to_spaces() {
        assert!(matches!(flatten_breaks("动工项目"), Cow::Borrowed(_)), "没得改就别分配");
        assert_eq!(flatten_breaks("动工项目\n数量\n（个）"), "动工项目 数量 （个）");
        assert_eq!(flatten_breaks("Total\r\nRevenue"), "Total Revenue");
        assert_eq!(flatten_breaks("Total\rRevenue"), "Total Revenue");
        assert_eq!(flatten_breaks("甲\n\n乙"), "甲 乙");
        assert_eq!(flatten_breaks("  甲 \n 乙  "), "甲 乙");
        assert_eq!(flatten_breaks("甲\t乙"), "甲 乙");
        assert_eq!(flatten_breaks("\n \n"), "");
    }

    /// Excel 自己写的字符串都在共享字符串表里（单元格只存索引）—— 那张表也要压平
    #[test]
    fn shared_strings_are_flattened_too() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2" uniqueCount="2">
  <si><t xml:space="preserve">动工项目
数量</t></si>
  <si><t>没有换行</t></si>
</sst>"#;
        let mut table = SharedStringTable::parse(xml.as_bytes()).unwrap();
        flatten_shared_strings(&mut table);
        assert_eq!(table.get(0), Some("动工项目 数量"));
        assert_eq!(table.get(1), Some("没有换行"));
    }

    /// `.xls`：字符串直接存在单元格里（数字格式那些不可能带换行）—— 同一套压平
    /// （旧二进制格式没法在测试里造，只能手工拼一张 [`Sheet`]）
    #[test]
    fn xls_cells_with_line_breaks_are_flattened() {
        use office_oxide::xls::CellValue as XlsValue;

        let mut sheet = Sheet {
            rows: vec![
                vec![
                    XlsValue::String("动工项目\n数量（个）".into()),
                    XlsValue::Number(22.0),
                ],
                vec![XlsValue::String("甲\t乙".into()), XlsValue::Empty],
            ],
            ..Default::default()
        };
        flatten_sheet_breaks(&mut sheet);

        assert_eq!(sheet.rows[0][0], XlsValue::String("动工项目 数量（个）".into()));
        assert_eq!(sheet.rows[0][1], XlsValue::Number(22.0), "数字不动");
        assert_eq!(sheet.rows[1][0], XlsValue::String("甲 乙".into()));
        // 渲染出来仍是一行一条记录（`.xls` 选单表那条路走的就是这个渲染器）
        assert_eq!(
            render_xls_sheet(&sheet).lines().collect::<Vec<_>>(),
            vec!["动工项目 数量（个）\t22", "甲 乙"]
        );
    }

    // ══════════════════════ 图片 ══════════════════════

    /// 造一份含图片的 `.xlsx`：一张表两张图（一张带 alt、一张不带），另一张表无图
    fn write_xlsx_with_images(path: &std::path::Path) {
        use office_oxide::xlsx::write::{CellData, XlsxWriter};

        // 图的内容无所谓（读者只把包的字节搬出来）—— 但字节数会进说明，给个可断言的长度
        let mut logo = vec![0x89, b'P', b'N', b'G', 13, 10, 26, 10];
        logo.resize(2048, 0);

        let mut writer = XlsxWriter::new();
        {
            let mut sheet = writer.add_sheet("销售");
            sheet.set_cell(0, 0, CellData::String("2026 到资晾晒单".to_string()));
            // 顺手放一个合并：图片说明与合并说明要能同在一句里
            sheet.merge_cells(0, 0, 1, 2);
            sheet.add_image_with_alt(
                logo,
                "png",
                0,
                0,
                480 * 9525,
                320 * 9525,
                Some("公司 logo".to_string()),
            );
            sheet.add_image(vec![0xFF, 0xD8, 0xFF, 0xE0], "jpeg", 0, 457_200, 96 * 9525, 96 * 9525);
        }
        {
            let mut sheet = writer.add_sheet("数据");
            sheet.set_cell(0, 0, CellData::String("无图".to_string()));
        }
        writer.save(path).unwrap();
    }

    /// 图片：只报「这里有图」—— 哪张表、第几张、格式、显示尺寸、字节数、alt 文本；
    /// 图的内容一个字都不进正文（更不能让模型以为「这里本来就没东西」）
    #[test]
    fn xlsx_images_are_reported_without_reading_them() {
        let dir = tmp_dir("xlsx_images");
        let path = dir.join("images.xlsx");
        write_xlsx_with_images(&path);

        let out = extract_text(path.to_str().unwrap(), None, "xlsx").unwrap();
        let note = out.note.expect("有图片就必须给出一句说明");
        assert!(note.contains("the workbook holds 2 images"), "{note}");
        assert!(
            note.contains("销售!image 1 (png, 480x320 px, 2.0 KB, alt \"公司 logo\")"),
            "{note}"
        );
        assert!(note.contains("销售!image 2 (jpeg, 96x96 px, 4 B)"), "{note}");
        assert!(!note.contains("数据!image"), "没有图的表不该被点名：{note}");
        // 与合并说明同在一句里（` · ` 相连）
        assert!(note.contains("merged cells show"), "{note}");
        assert!(note.contains("销售!A1:B1 spans 2 columns"), "{note}");
        assert!(note.contains(" · "), "两句说明用 ` · ` 相连：{note}");
        // 正文照旧，图片的字节不进去
        assert!(out.text.contains("2026 到资晾晒单"), "实际：{}", out.text);
        assert!(!out.text.contains("PNG"), "图片的内容不解析：{}", out.text);

        // 选单表：正文标题已给表名，图片不必再冠 `表名!`；开头句换成 this sheet
        let one = extract_text(path.to_str().unwrap(), Some("销售"), "xlsx").unwrap();
        let note = one.note.expect("选单表也要报图片");
        assert!(note.contains("this sheet holds 2 images"), "{note}");
        assert!(
            note.contains("image 1 (png, 480x320 px, 2.0 KB, alt \"公司 logo\")"),
            "{note}"
        );
        assert!(!note.contains("销售!image"), "单表模式不必冠表名：{note}");

        // 选中的表没有图 → 一句说明都不加
        let none = extract_text(path.to_str().unwrap(), Some("数据"), "xlsx").unwrap();
        assert_eq!(none.note, None, "实际：{:?}", none.note);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// `.xls` 的图片是**工作簿级**的（`MsoDrawingGroup` 全簿共用，归属哪张表读不出来）——
    /// 说明里如实写 sheet unknown（旧二进制格式没法在测试里造，只能手工拼一条 [`XlsImage`]）
    #[test]
    fn xls_images_are_reported_without_sheet_attribution() {
        use office_oxide::xls::ImageFormat;

        let pic = XlsImage {
            format: ImageFormat::Png,
            data: vec![0; 2048],
            index: 0,
        };
        let mut images = Mentions::default();
        images.add(image_text("", 1, &xls_image_facts(&pic)));
        let note = images
            .note(&images_lead("the workbook (sheet unknown)", images.total))
            .unwrap();

        assert!(note.contains("image contents are not extracted"), "{note}");
        assert!(note.contains("sheet unknown"), "{note}");
        assert!(note.contains("image 1 (png, 2.0 KB)"), "{note}");
        assert!(images_lead("the workbook", 1).contains("holds 1 image"));
        assert!(images_lead("the workbook", 2).contains("holds 2 images"));
    }
}
