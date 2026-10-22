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
//!   收益为 0。合并与图片信息由 `notes::Mentions` 单独补（见下）。
//!   ⚠️ 渲染之前**先把格内换行 / 制表符压成空格**（`cells::flatten_breaks`）：值里的换行（Excel 的
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
//! （`notes::Mentions`）。讲在**哪儿**按「模型能不能对上号」分两种：
//! - **表格**（`xlsx` / `xls`）：正文是「表名一行 + 制表符分列的行」，一句总说明里用 Excel 自己的
//!   `表名!A1:D1` 就定位得到（`sheet` 选单张表时连前缀都省），所以照旧放进 `DocText::note`
//!   —— 模型与界面都看得到，且不占正文、不影响分页计数。
//! - **文稿 / 演示**（`docx` / `doc` / `pptx` / `ppt`）：正文里**没有**任何「第 N 张表」的坐标，
//!   而一张报告动辄几十张表带合并（实测那份审核报告 39 张）—— 总说明写成「table 7 r1c1-r1c2 …」
//!   模型根本对不上号。所以改为**就地**在**那张表前面**插一句段落（`merge::inject_table_notes`），
//!   由库自己的渲染器排出位置，坐标与正文同源。
//!   ⚠️ 完整解释（括号那句）只在**第一张**带合并的表前讲一次 —— 同一份文件里带合并的表能有
//!   几十张，同一句解释重复几十遍纯是噪音；后面的表只留 `merged cells:` 短开头，条目仍然
//!   各归自己那张表。
//!
//! **图片**是同一类问题里更彻底的一种：渲染器只画文字 —— `docx` / `pptx` 的 `<w:drawing>` /
//! `<p:pic>`、`xlsx` 的 `<xdr:pic>`（含 Excel 365「放在单元格里的图片」）与 `.xls` 的
//! `MsoDrawingGroup` 里的 BLIP **一个字都不会进正文**，模型看到的就是「这里本来就没东西」；
//! 而中文报表 / 截图里的图片经常盛的正是数据。所以图片必须报：
//! - **文稿 / 演示**：图片在正文流里本来就有位置 → **就地**换成一句标记
//!   （`image 3 · png · 640×480 px · 24.6 KB`），位置由库自己的渲染器排、与正文同源；
//! - **表格**：正文是「表名一行 + 制表符分列的行」，插不进「位置」→ 走 `DocText::note` 的一句
//!   说明（`销售!image 2 (png, 1412x844 px, 224.4 KB)`）。
//! - 被要求（`ocrImages: true`，或整份文档除图片外没有文字）时，端侧 OCR 把图里的字读出来：
//!   文稿 / 演示贴在标记后面，表格追加在正文后面（见 `doc_parse::ocr`）。
//!
//! 未做（如实报错，不猜）：加密（口令保护）文档、扫描件、`.doc` 里的嵌入对象、Word 纵向合并
//! **续格**里的内容（IR 按 Word 的显示语义把它丢掉，要恢复得再走一遍原始 docx 模型，收益极低）。
//!
//! **分册**（本文件只留入口与对外名字；`extract_text` / `OfficeText` 的路径一字未变）：
//! - `notes`：说明的公共词汇（`Mentions` / `shrink` / `join_notes`）；
//! - `merge`：合并单元格（`merge::inject_table_notes` 等）；
//! - `images`：文档里的图片（标记 / 说明 + 待读的字节）；
//! - `cells`：格内换行 / 制表符压平（`cells::flatten_breaks`）；
//! - `render`：把文档变成给模型看的文本 + `note`。
//!
//! 代价（§11.18）：跨分册用到的内部项放宽成 `pub(super)` —— 只在本模块内可见，不对外。

use office_oxide::xls::XlsDocument;
use office_oxide::xlsx::XlsxDocument;
use office_oxide::{Document, DocumentFormat};

use super::ocr::{OcrOptions, OcrSummary};
use super::ParseError;
use self::cells::{flatten_xls_breaks, flatten_xlsx_breaks};
use self::merge::{xls_merge_regions, xlsx_merge_regions, MergeRegion};
use self::render::{backend_error, doc_text, render_xls_sheet, xls_text, xlsx_text};

mod cells;
mod images;
mod merge;
mod notes;
mod render;

#[cfg(test)]
mod tests;

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
    /// 端侧 OCR 的摘要（`None` = 这条链接根本没碰 OCR）
    pub ocr: Option<OcrSummary>,
}

/// 一片合并区域（0-based 闭区间）—— 界面把它画成 `colspan` / `rowspan`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MergedBounds {
    pub row_first: u32,
    pub row_last: u32,
    pub col_first: u32,
    pub col_last: u32,
}

/// 预览用的表格网格（每张工作表一份行×列）。
///
/// 与 [`OfficeText`] 的区别只有一条：**保留单元格的结构**（哪一格属于哪一列、哪些位置是一片合并），
/// 界面才能画成表格；正文仍然由同一个逐表渲染器产出，不另写一份取值逻辑。
#[derive(Debug, Clone)]
pub struct SheetGrid {
    /// 工作表名
    pub name: String,
    /// 已物化的行（行数 / 列数受调用方上限约束）
    pub rows: Vec<Vec<String>>,
    /// 这张表的**实际**行数（不受上限影响）
    pub row_count: usize,
    /// 这张表的**实际**最大列数（不受上限影响）
    pub col_count: usize,
    /// 合并区域（坐标是**整张表**的 0-based 行列，**未**按物化上限裁剪：
    /// 裁到可见窗口是渲染层的事，底层只交事实）
    pub merges: Vec<MergedBounds>,
}

/// 逐表取出「行 × 列」网格 —— 面板预览专用（**只是同一套渲染结果的另一种形状**）。
///
/// 与 [`extract_text`] 共用 `Spreadsheet` 的打开 / 压平（格内换行）逻辑，区别只在于：
/// 它把每张表**单独**渲染再按 `行 → 列` 切开，而正文那条路是把整册拼成一段文本。
/// `max_rows` / `max_cols` 只限制物化的格子数（见 [`SheetGrid`]）。
pub fn preview_grids(
    path: &str,
    ext: &str,
    max_rows: usize,
    max_cols: usize,
) -> Result<Vec<SheetGrid>, ParseError> {
    let book = match Spreadsheet::open(path, ext) {
        Some(book) => book,
        // 扩展名与容器不符 / 打不开：让库自己嗅容器（错误文案归它）
        None => {
            let doc = Document::open(path).map_err(|e| backend_error(ext, e))?;
            match doc.format() {
                DocumentFormat::Xlsx | DocumentFormat::Xls => {
                    Spreadsheet::open_as(path, doc.format(), ext)?
                }
                _ => {
                    return Err(ParseError::Backend {
                        format: ext.to_string(),
                        message: "the file is not a spreadsheet".to_string(),
                    })
                }
            }
        }
    };
    Ok(book.grids(max_rows, max_cols))
}

/// 一张表的制表符正文 → 网格。
///
/// 被截掉的部分**不静默丢**：`row_count` / `col_count` 记真实总量，界面据此提示「只看前 N 行」。
/// 行内**末尾**的空格不算列（渲染器本来也只补到最后一个有内容的格），
/// 但中间的空格要留着 —— 那是合并单元格摊平后的占位，丢了列会整体左移。
fn grid_from_tsv(
    name: &str,
    body: &str,
    max_rows: usize,
    max_cols: usize,
    regions: &[MergeRegion],
) -> SheetGrid {
    // 渲染器每行一个 `\n`：末尾那一个换行不算一行（否则每张表都多出一行空白）
    let body = body.strip_suffix('\n').unwrap_or(body);
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut row_count = 0usize;
    let mut col_count = 0usize;
    if body.is_empty() {
        return SheetGrid {
            name: name.to_string(),
            rows,
            row_count,
            col_count,
            merges: merged_bounds(regions),
        };
    }
    for line in body.split('\n') {
        row_count += 1;
        let cells: Vec<&str> = line.split('\t').collect();
        let last = cells
            .iter()
            .rposition(|cell| !cell.trim().is_empty())
            .map(|idx| idx + 1)
            .unwrap_or(0);
        col_count = col_count.max(last);
        if rows.len() < max_rows {
            rows.push(
                cells[..last.min(max_cols)]
                    .iter()
                    .map(|cell| cell.trim().to_string())
                    .collect(),
            );
        }
    }
    SheetGrid {
        name: name.to_string(),
        rows,
        row_count,
        col_count,
        merges: merged_bounds(regions),
    }
}

/// 内部区域 → 对外的四元组（`MergeRegion` 的几个字段是模块内的，不对外）
fn merged_bounds(regions: &[MergeRegion]) -> Vec<MergedBounds> {
    regions
        .iter()
        .map(|region| {
            let (row_first, row_last, col_first, col_last) = region.bounds();
            MergedBounds {
                row_first,
                row_last,
                col_first,
                col_last,
            }
        })
        .collect()
}

/// 抽一个 Office 文档的文本（**不碰 OCR**）—— 等价于 [`extract_text_with_ocr`] 传 `None`。
///
/// 实测：19 处用例只关心正文，不必每处多写一个 `None`；实现只有一份（下面那个）。
pub fn extract_text(path: &str, sheet: Option<&str>, ext: &str) -> Result<OfficeText, ParseError> {
    extract_text_with_ocr(path, sheet, ext, None)
}

/// 抽一个 Office 文档的文本，并可选地把内嵌图片里的字读出来（`ocr`）。
///
/// `ext` 既用于错误文案，也用于**先按哪种类型打开**：表格（`xlsx` / `xls`）要压平格内换行
/// （`cells::flatten_breaks`），那是在**值**这一层改、需要可变所有权 —— 所以表格自己开、自己持有
/// （[`Spreadsheet`]）；开不出来才落到 `Document::open` 那条路（扩展名骗人 / 加密包 / 损坏），
/// 容器嗅探与错误文案都归库。
pub fn extract_text_with_ocr(
    path: &str,
    sheet: Option<&str>,
    ext: &str,
    ocr: Option<&OcrOptions>,
) -> Result<OfficeText, ParseError> {
    if let Some(book) = Spreadsheet::open(path, ext) {
        return book.flattened_text(sheet, ocr);
    }

    // 文稿 / 演示，或**按扩展名开不出来的表格**
    let doc = Document::open(path).map_err(|e| backend_error(ext, e))?;
    match doc.format() {
        // 扩展名与容器不符的表格（比如 `.xls` 里装的其实是 `.xlsx`）：库刚确认了真格式，
        // 按真格式开一份可变的再净化 —— 同一份文件刚解析成功过，这次必开得出来
        DocumentFormat::Xlsx | DocumentFormat::Xls => {
            Spreadsheet::open_as(path, doc.format(), ext)?.flattened_text(sheet, ocr)
        }
        _ => Ok(doc_text(&doc, sheet, ocr)),
    }
}

/// 一份**自己打开的**表格文档（`xlsx` / `xls`）。
///
/// 为什么要自己持有：格内换行 / 制表符要先压成空格（见 `cells::flatten_breaks`）—— 那是在值这一层
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

    /// 逐表取出「行 × 列」网格（**不碰 OCR**：预览是看内容，不是补文字）
    ///
    /// `max_rows` / `max_cols` 只限制**物化**的格子：超出部分不分配内存，
    /// 真实总量由 [`SheetGrid::row_count`] / [`SheetGrid::col_count`] 如实报出。
    fn grids(self, max_rows: usize, max_cols: usize) -> Vec<SheetGrid> {
        match self {
            Self::Xlsx(mut book) => {
                flatten_xlsx_breaks(&mut book);
                (0..book.worksheets.len())
                    .map(|idx| {
                        let name = book.worksheets[idx].name.clone();
                        let body = book.sheet_plain_text(idx).unwrap_or_default();
                        // 合并区域与正文那条路同源（`parse_a1_range`）：说明里算合并，这里就算
                        let regions = xlsx_merge_regions(&book.worksheets[idx]);
                        grid_from_tsv(&name, &body, max_rows, max_cols, &regions)
                    })
                    .collect()
            }
            Self::Xls(mut book) => {
                flatten_xls_breaks(&mut book);
                book.sheets
                    .iter()
                    .map(|sheet| {
                        let body = render_xls_sheet(sheet);
                        let regions = xls_merge_regions(sheet);
                        grid_from_tsv(&sheet.name, &body, max_rows, max_cols, &regions)
                    })
                    .collect()
            }
        }
    }

    /// 压平格内换行 / 制表符，再渲染（`ocr` = 要不要顺带把图里的字读出来）
    fn flattened_text(
        self,
        sheet: Option<&str>,
        ocr: Option<&OcrOptions>,
    ) -> Result<OfficeText, ParseError> {
        match self {
            Self::Xlsx(mut book) => {
                flatten_xlsx_breaks(&mut book);
                xlsx_text(&book, sheet, ocr)
            }
            Self::Xls(mut book) => {
                flatten_xls_breaks(&mut book);
                xls_text(&book, sheet, ocr)
            }
        }
    }
}