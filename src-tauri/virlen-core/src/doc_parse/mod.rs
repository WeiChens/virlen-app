//! 文档解析 —— 把「读不出文字的二进制文档」变成可读文本的**唯一实现**（零 `tauri::`，GUI 与 CLI 共用）。
//!
//! 谁在用：
//! - `agent::native_tools::file::parse_document`（`parse_document` 工具，Rust 引擎的默认路径）
//! - GUI 命令 `cmd_parse_document`（TS 回退路径的转发目标，与工具同一个 `parse`）
//! - `rag::document`（知识库导入的 PDF 抽文字，走 [`pdf::extract_text`]）
//!
//! 为什么单独一个模块：`read_file` 只能读 UTF-8/GBK 的**文本文件**，PDF / Office / 压缩容器
//! 它一律读不出内容。解析要给人看（界面）也给模型看（工具返回值），两处必须**同一份结果**，
//! 所以格式分派、编码嗅探、大小上限都收敛在这里。
//!
//! ⚠️ **格式适配只在本模块**：`pdf-extract` 调用、编码嗅探、50 MB 上限都各只有一份 ——
//! 工具层与 RAG 层不得另写一份，否则两条路径的结果会静默分叉（`docs/doc-parse-plan.md` §4）。
//!
//! | 扩展名 | 实现 | 文本形态 |
//! |---|---|---|
//! | `pdf` | [`pdf`]（`pdf-extract` + 按版面坐标重排）+ [`ocr`]（内嵌图片） | 文字层（行序按版面重排）；**扫描件没有文字层时走端侧 OCR**（`ParseOptions::ocr`） |
//! | `docx` `doc` `pptx` `ppt` | [`office`]（`office_oxide`） | Markdown（保留标题 / 列表 / 表格）；内嵌图片**就地**标一句 `image N · …`（见 §20） |
//! | `xlsx` `xls` | [`office`]（`office_oxide`） | 工作表名 + 制表符分隔的行（表格用 Markdown 太费 token）；图片进 `note` 的一句说明 |
//! | `csv` `tsv` | [`delimited`]（`csv`） | 规范化的 CSV（分隔符嗅探 → 统一逗号；解析失败回退原文） |
//! | `txt` `md` `json` … | [`text`] | 解码后的原文（BOM / UTF-16 / GB18030 / BIG5 / Shift_JIS 兜底） |
//!
//! **内嵌图片**（`pdf` + Office 六种）默认只**报存在与位置** —— 渲染器一个字都不画，不讲的话
//! 模型只能当那里本来就没东西；[`ParseOptions::ocr`] 有值时按同一套口径把图里的字读出来
//! （太小 / 太扁的图不读：[`ocr::MIN_IMAGE_SIDE`] / [`ocr::MAX_ASPECT_RATIO`]；上限
//! [`ocr::MAX_IMAGES`] 张；**图片不出本机**，两块共用一个 [`ocr`] 模块）。

pub mod delimited;
pub mod ocr;
pub mod office;
pub mod pdf;
pub mod text;

#[cfg(test)]
pub(crate) mod test_pdf;

pub use ocr::{OcrOptions, OcrSection, OcrSummary, TextLayer};

use std::path::Path;

/// 单个文档的大小上限 —— 与知识库导入同一个值（`50 MB`）。
///
/// ⚠️ 复用 `rag_service` 的常量而不是新写一个数字：两边口径必须一致，
/// 否则「知识库能导入、工具却拒绝」这类差异会莫名其妙。
pub const MAX_DOC_BYTES: u64 = crate::rag::rag_service::MAX_DOC_SIZE_BYTES;

/// 返回给模型的最大字符数（默认值）。
///
/// 12000 字符 ≈ 中文 1.2 万字 ≈ 200k 上下文的 6%：一次读完一份常规文档，又不至于把上下文灌满。
pub const DEFAULT_MAX_CHARS: usize = 12_000;

/// `max_chars` 的硬上限 —— 模型自己要求再大也不给（一次调用吃掉整个上下文 = 自伤）。
pub const MAX_MAX_CHARS: usize = 400_000;

/// 直接按文本读的格式（[`text`] 处理）—— 其余格式见模块头的分派表
pub const TEXT_EXTENSIONS: [&str; 10] = [
    "txt", "md", "markdown", "json", "yaml", "yml", "toml", "ini", "conf", "log",
];

/// Office 二进制 / OOXML（[`office`] 处理）
pub const OFFICE_EXTENSIONS: [&str; 6] = ["docx", "doc", "xlsx", "xls", "pptx", "ppt"];

/// 分隔符文本（[`delimited`] 处理）
pub const DELIMITED_EXTENSIONS: [&str; 2] = ["csv", "tsv"];

/// `ocrImages` 用在**没有内嵌图片的格式**（纯文本 / CSV）上时给模型的一句说明（固定英文）
///
/// ⚠️ 不进 i18n：模型侧文案必须只有一份（铁律 1），界面侧按 `uiData` 重建自己的话。
const OCR_NO_IMAGES_NOTE: &str =
    "Parameter \"ocrImages\" is ignored: this format has no embedded images";

/// 这个格式的内嵌图片能不能读（`ocrImages` 只对有图的格式有意义）
///
/// `pdf` 与 Office 六种都有图（渲染器不画，但图就在包里）；`csv` / 纯文本没有「内嵌图片」这个概念。
pub fn has_embedded_images(ext: &str) -> bool {
    ext == "pdf" || OFFICE_EXTENSIONS.contains(&ext)
}

/// 全部可解析扩展名（错误文案与白名单都取自这里）
pub fn supported_extensions() -> Vec<&'static str> {
    let mut out = vec!["pdf"];
    out.extend(OFFICE_EXTENSIONS);
    out.extend(DELIMITED_EXTENSIONS);
    out.extend(TEXT_EXTENSIONS);
    out
}

/// 这个文件名能不能解析（按扩展名判）
pub fn is_supported(name_or_ext: &str) -> bool {
    is_supported_ext(&extension_of(name_or_ext))
}

/// 这个**扩展名本身**（不带点，大小写不限）能不能解析
///
/// ⚠️ 与 [`is_supported`] 分开是必须的：`parse` 手里已经是扩展名，
/// 再丢给 `is_supported` 会被当成「无扩展名的文件」而全盘拒绝（旧版就踩过这个坑）。
pub fn is_supported_ext(ext: &str) -> bool {
    !ext.is_empty() && supported_extensions().contains(&ext.to_lowercase().as_str())
}

/// 取小写扩展名（不含点）；没有扩展名 → 空串
pub fn extension_of(name: &str) -> String {
    Path::new(name)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

// ==================== 解析失败 ====================

/// 解析失败 —— 每种失败对应一句模型侧固定英文（界面文案由调用方用 `uiData` 重建，见 D2-A）
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParseError {
    /// 扩展名不在支持列表里
    Unsupported { ext: String },
    /// 超过 [`MAX_DOC_BYTES`]
    TooLarge { size: u64, limit: u64 },
    /// 抽不出文本（扫描版 PDF / 纯图文档）—— **不编内容**：为什么没文字如实附在后面
    NoText {
        /// 英文短句（PDF 会说清是「OCR 没认出来」还是「没开 OCR」；界面按 `errorKind` 重建）
        detail: String,
    },
    /// `sheet` 指定的工作表不存在
    SheetNotFound {
        requested: String,
        available: Vec<String>,
    },
    /// 解析库报错（文件损坏 / 加密 / 扩展名与实际格式不符）
    Backend { format: String, message: String },
}

impl ParseError {
    /// 模型侧固定英文（**不进 i18n**，否则 Rust 与 TS 回退路径会产出不同文本，见铁律 1）
    pub fn message(&self) -> String {
        match self {
            Self::Unsupported { ext } => format!("Document parsing is not supported for .{ext}"),
            Self::TooLarge { size, limit } => format!(
                "File is too large to parse ({:.1} MB > {:.0} MB)",
                *size as f64 / (1024.0 * 1024.0),
                *limit as f64 / (1024.0 * 1024.0)
            ),
            Self::NoText { detail } => format!(
                "No text could be extracted from this document (it may be image-only) — {detail}"
            ),
            Self::SheetNotFound {
                requested,
                available,
            } => {
                let list = if available.is_empty() {
                    "(none)".to_string()
                } else {
                    available.join(", ")
                };
                format!("Worksheet \"{requested}\" not found. Available worksheets: {list}")
            }
            Self::Backend { format, message } => {
                format!("Failed to parse {format} document — {message}")
            }
        }
    }

    /// 稳定的失败分类（`uiData` / 埋点用；不进模型文案）
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Unsupported { .. } => "unsupported",
            Self::TooLarge { .. } => "too_large",
            Self::NoText { .. } => "no_text",
            Self::SheetNotFound { .. } => "sheet_not_found",
            Self::Backend { .. } => "backend",
        }
    }
}

// ==================== 解析入口 ====================

/// 解析参数（工具与命令都从这里下发，不各自散落默认值）
#[derive(Debug, Clone)]
pub struct ParseOptions {
    /// 只看这一张工作表（仅 `xlsx` / `xls`；其它格式会被忽略并在 `note` 里说明）
    pub sheet: Option<String>,
    /// 返回的最大字符数（已钳在 `1..=`[`MAX_MAX_CHARS`]）
    pub max_chars: usize,
    /// 起始字符偏移（续读）
    pub offset: usize,
    /// 顺带把**全文**放进 [`DocText::full_text`]（只有「要落盘成文本文件」的调用方才开）
    ///
    /// 默认 `false`：切片之外的文本当场释放，不在引擎里多留一份大字符串。
    pub full_text: bool,
    /// 端侧 OCR（扫描件 / 图片型 PDF 的文字层取字，以及 PDF 与 Office 的**内嵌图片**取字）；
    /// `None` = 不碰 OCR（含 `ocrImages: false` 的显式关闭）
    pub ocr: Option<OcrOptions>,
}

impl Default for ParseOptions {
    fn default() -> Self {
        Self {
            sheet: None,
            max_chars: DEFAULT_MAX_CHARS,
            offset: 0,
            full_text: false,
            ocr: None,
        }
    }
}

/// 解析结果（`text` 已按 `offset` / `max_chars` 切片）
#[derive(Debug, Clone)]
pub struct DocText {
    /// 小写扩展名 / 实际格式（`pdf` / `docx` / `xlsx` / `csv` …）
    pub kind: String,
    /// 本次返回的文本切片
    pub text: String,
    /// **全文**字符数（不是本次切片的长度 —— 分页提示靠它）
    pub char_count: usize,
    /// 是否被 `max_chars` 截断
    pub truncated: bool,
    /// 续读的起点（未截断时为 `None`）
    pub next_offset: Option<usize>,
    /// 工作簿里全部工作表名（仅 `xlsx` / `xls`）
    pub sheets: Vec<String>,
    /// 实际生效的工作表名（仅 `xlsx` / `xls` 且传了 `sheet`）
    pub sheet: Option<String>,
    /// 需要模型知道的一条说明（英文；例：`sheet` 对 Word 不生效、CSV 解析失败已回退原文）
    pub note: Option<String>,
    /// **全文**（仅 `ParseOptions::full_text` 为 true 时是 `Some`）—— 落盘 / 二次检索用，
    /// **不受 `offset` / `max_chars` 影响**
    pub full_text: Option<String>,
    /// 端侧 OCR 的结果摘要（`None` = 这条解析链没碰 OCR）
    pub ocr: Option<OcrSummary>,
}

/// 解析一个文档文件。
///
/// 只读、不联网、不写临时文件（`outTxtFile` 的落盘在工具层，本函数只把全文本事交出去）；
/// 调用方负责**先做路径安全校验**（黑名单 > 白名单 > 工作目录），本函数只认已经校验过的路径。
pub fn parse(path: &str, opts: &ParseOptions) -> Result<DocText, ParseError> {
    let file = Path::new(path);
    let ext = extension_of(path);

    if !is_supported_ext(&ext) {
        return Err(ParseError::Unsupported { ext });
    }

    // 存在性 / 是不是目录 / 大小 —— 全在**读文件之前**判：宁可在这里拒绝，
    // 也不要为一个 500 MB 的文件（或一个目录）分配内存
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

    let mut note: Option<String> = None;
    let mut sheets: Vec<String> = Vec::new();
    let mut used_sheet: Option<String> = None;
    let mut ocr_summary: Option<OcrSummary> = None;
    let raw: String = match ext.as_str() {
        "pdf" => {
            let bytes = read_bytes(file, &ext)?;
            // 文字层抽失败不算致命：扫描件本来就抽不出文字（图片里オ是正文），OCR 可能就是唯一取字路径
            let layer = pdf::extract_text(&bytes);
            let mut text = layer
                .as_ref()
                .map(|out| out.text.clone())
                .unwrap_or_default();
            let has_layer = !text.trim().is_empty();
            // 行序退回原样（上游库在某个字体上 panic、或重排一个字都没拿到）：如实说一句，
            // 否则模型会把「行」当成版面上的行去理解（看 `docs/doc-parse-plan.md` §19）
            if has_layer && !layer.as_ref().is_ok_and(|out| out.laid_out) {
                note = Some(pdf::RAW_ORDER_NOTE.to_string());
            }
            // 要不要 OCR：模型显式要（`ocrImages`）或**抽不到文字层**（扫描件兜底）
            if opts.ocr.as_ref().is_some_and(|o| o.always || !has_layer) {
                let ocr_opts = opts.ocr.as_ref().expect("上面的判断保证是 Some");
                let outcome = ocr::run_pdf_ocr(&bytes, ocr_opts);
                if !outcome.text.is_empty() {
                    if has_layer {
                        // 有文字层：OCR 作为**追加块**（模型能分清哪段字来自图）
                        text.push_str(&format!("\n\n{}\n\n", ocr::BLOCK_LEAD));
                    }
                    text.push_str(&outcome.text);
                }
                let layer_state = match &layer {
                    _ if has_layer => TextLayer::Present,
                    Err(e) => TextLayer::Failed(e.clone()),
                    Ok(_) => TextLayer::Empty,
                };
                note = join_notes([
                    note.take(),
                    ocr::summary_note(&outcome.summary, layer_state),
                ]);
                ocr_summary = Some(outcome.summary);
            }
            // 文字层与 OCR 都没给出东西：库报的错比「没文字」更能解释为什么
            if text.trim().is_empty() {
                if let Err(e) = layer {
                    return Err(ParseError::Backend {
                        format: ext.clone(),
                        message: e,
                    });
                }
            }
            text
        }
        "docx" | "doc" | "xlsx" | "xls" | "pptx" | "ppt" => {
            // 图片：Markdown / 表格渲染器都不画它 —— 就地标一句（文稿）或进 `note`（表格）；
            // `ocrImages` 有值时顺带把图里的字读出来（要不要跑由 `office::render` 按同一套口径决定）
            let out = office::extract_text_with_ocr(
                path,
                opts.sheet.as_deref(),
                &ext,
                opts.ocr.as_ref(),
            )?;
            sheets = out.sheets;
            used_sheet = out.sheet;
            if let Some(n) = out.note {
                note = Some(n);
            }
            ocr_summary = out.ocr;
            out.text
        }
        "csv" | "tsv" => {
            let bytes = read_bytes(file, &ext)?;
            let out = delimited::extract_text(&bytes, &ext).map_err(|e| ParseError::Backend {
                format: ext.clone(),
                message: e,
            })?;
            if let Some(n) = out.note {
                note = Some(n);
            }
            out.text
        }
        _ => {
            let bytes = read_bytes(file, &ext)?;
            text::decode_text(&bytes).ok_or_else(|| ParseError::Backend {
                format: ext.clone(),
                message: "the file is not decodable text (UTF-8 / GB18030 / BIG5 / Shift_JIS all failed)"
                    .to_string(),
            })?
        }
    };

    // OCR 只对**有内嵌图片的格式**有意义：纯文本 / CSV 收到了要**如实说一句**（与 `sheet` 在 Word 上
    // 被忽略同口径）—— 静默忽略会让模型以为「我明明让它读了图里的字」。
    // `None` = 调用方显式关掉了 OCR（`ocrImages: false`），那本来就没期待，不必啰嗦。
    if !has_embedded_images(&ext) && opts.ocr.is_some() {
        note = join_notes([note.take(), Some(OCR_NO_IMAGES_NOTE.to_string())]);
    }

    if raw.trim().is_empty() {
        // 为什么没文字：跑过 OCR 的说 OCR 的结论；有图但没跑的提醒开关（否则模型会以为这格式读不了）
        let subject = if ext == "pdf" { "the PDF" } else { "the document" };
        let detail = match &ocr_summary {
            Some(summary) => ocr::no_text_detail(summary, subject),
            None if has_embedded_images(&ext) => {
                "pass ocrImages: true to read the text inside its embedded images with on-device OCR"
                    .to_string()
            }
            None => "OCR is not supported for this format".to_string(),
        };
        return Err(ParseError::NoText { detail });
    }

    // 按**字符**分页（不是字节：中文一个字 3 字节，按字节切会把字切碎）
    let total = raw.chars().count();
    let max_chars = opts.max_chars.clamp(1, MAX_MAX_CHARS);
    let start = opts.offset.min(total);
    let end = start.saturating_add(max_chars).min(total);
    let slice = slice_chars(&raw, start, end);
    let truncated = end < total;
    // 全文只在被要求时留下（此时 `raw` 是最后一次使用，直接移进来，不复制）
    let full_text = if opts.full_text { Some(raw) } else { None };

    Ok(DocText {
        kind: ext,
        text: slice,
        char_count: total,
        truncated,
        next_offset: truncated.then_some(end),
        sheets,
        sheet: used_sheet,
        note,
        full_text,
        ocr: ocr_summary,
    })
}

/// 读文件（失败 → `Backend`）
fn read_bytes(file: &Path, ext: &str) -> Result<Vec<u8>, ParseError> {
    std::fs::read(file).map_err(|e| ParseError::Backend {
        format: ext.to_string(),
        message: e.to_string(),
    })
}

/// 两句说明拼成一句（` · ` 相连，与 `office` 同口径）；只有一句就原样返回，都没话 → `None`
///
/// ⚠️ 为什么是「拼」而不是「赋值」：`note` 承载的是**各自独立的事实**（行序退回原样 / OCR 摘要 /
/// 非 PDF 的 `ocrImages` 被忽略），后写的把先写的覆盖掉 = 静默丢一句。
fn join_notes(parts: [Option<String>; 2]) -> Option<String> {
    let mut out = String::new();
    for part in parts.into_iter().flatten() {
        if !out.is_empty() {
            out.push_str(" · ");
        }
        out.push_str(&part);
    }
    (!out.is_empty()).then_some(out)
}

/// 取 `[start, end)` 这段**字符**（字节索引经 UTF-8 边界换算，绝不切碎多字节字符）
fn slice_chars(s: &str, start: usize, end: usize) -> String {
    if start >= end {
        return String::new();
    }
    let from = byte_index_of_char(s, start);
    let to = byte_index_of_char(s, end);
    s[from..to].to_string()
}

/// 第 `char_idx` 个字符的字节偏移（超出长度 → 串尾）
fn byte_index_of_char(s: &str, char_idx: usize) -> usize {
    if char_idx == 0 {
        return 0;
    }
    match s.char_indices().nth(char_idx) {
        Some((b, _)) => b,
        None => s.len(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("virlen_doc_parse_{}_{}", tag, uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn extension_dispatch_covers_the_whitelist() {
        assert!(is_supported("a.pdf"));
        assert!(is_supported("A.XLSX"), "扩展名判定大小写不敏感");
        assert!(is_supported("notes.md"));
        assert!(!is_supported("a.png"));
        assert!(!is_supported("noext"));
        assert!(!is_supported(".gitignore"), "只有点没有主名的不算");
        assert!(is_supported_ext("txt"), "裸扩展名也要认");
        assert!(is_supported_ext("PDF"), "大小写不限");
        assert!(!is_supported_ext(""));
        assert_eq!(extension_of("C:/ws/报表.XLSX"), "xlsx");
        assert_eq!(extension_of("noext"), "");
    }

    #[test]
    fn unsupported_extension_reports_the_extension() {
        let err = parse("C:/ws/a.png", &ParseOptions::default()).unwrap_err();
        assert_eq!(err.kind(), "unsupported");
        assert_eq!(
            err.message(),
            "Document parsing is not supported for .png"
        );
    }

    #[test]
    fn char_paging_slices_by_characters_not_bytes() {
        // 12 个字：0中 1文 2a 3b 4c 5中 6文 7a 8b 9c 10中 11文
        let text = "中文abc中文abc中文";
        assert_eq!(slice_chars(text, 0, 4), "中文ab");
        assert_eq!(slice_chars(text, 2, 5), "abc");
        assert_eq!(slice_chars(text, 5, 100), "中文abc中文");
        assert_eq!(slice_chars(text, 100, 200), "", "越界起点 → 空串");
        assert_eq!(byte_index_of_char(text, 0), 0);
        assert_eq!(byte_index_of_char(text, 100), text.len());
    }

    #[test]
    fn text_file_pages_with_offset_and_reports_the_rest() {
        let dir = tmp_dir("page");
        let file = dir.join("a.txt");
        let full: String = (0..100).map(|i| format!("第{i}行\n")).collect();
        std::fs::write(&file, &full).unwrap();

        let opts = ParseOptions {
            sheet: None,
            max_chars: 20,
            offset: 0,
            full_text: false,
            ocr: None,
        };
        let first = parse(file.to_str().unwrap(), &opts).unwrap();
        assert_eq!(first.kind, "txt");
        assert_eq!(first.char_count, full.chars().count());
        assert!(first.truncated);
        assert_eq!(first.next_offset, Some(20));

        // 续读：两段拼起来必须是原文的前 40 个字符（分页不丢字）
        let second = parse(
            file.to_str().unwrap(),
            &ParseOptions {
                offset: 20,
                ..opts
            },
        )
        .unwrap();
        let joined: String = format!("{}{}", first.text, second.text);
        assert_eq!(joined, slice_chars(&full, 0, 40));

        std::fs::remove_dir_all(&dir).ok();
    }

    /// 全文只在被要求时带回：默认 `None`（不留大字符串），开了之后**不受 `max_chars` 影响**
    #[test]
    fn full_text_is_returned_only_when_requested() {
        let dir = tmp_dir("full");
        let file = dir.join("a.txt");
        let full: String = (0..50).map(|i| format!("第{i}行\n")).collect();
        std::fs::write(&file, &full).unwrap();

        let paged = parse(
            file.to_str().unwrap(),
            &ParseOptions {
                max_chars: 10,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(paged.full_text.is_none(), "默认不该持有全文");
        assert_eq!(paged.text.chars().count(), 10);

        let whole = parse(
            file.to_str().unwrap(),
            &ParseOptions {
                max_chars: 10,
                full_text: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(whole.full_text.as_deref(), Some(full.as_str()));
        assert_eq!(whole.text.chars().count(), 10, "切片照旧受 max_chars 限制");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn oversized_file_is_refused_before_reading() {
        let dir = tmp_dir("big");
        let file = dir.join("big.txt");
        // 稀疏文件：不真写 50 MB
        std::fs::File::create(&file)
            .unwrap()
            .set_len(MAX_DOC_BYTES + 1)
            .unwrap();
        let err = parse(file.to_str().unwrap(), &ParseOptions::default()).unwrap_err();
        assert_eq!(err.kind(), "too_large");
        assert!(err.message().starts_with("File is too large to parse"), "{}", err.message());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn empty_document_is_reported_as_no_text() {
        let dir = tmp_dir("empty");
        let file = dir.join("empty.txt");
        std::fs::write(&file, "   \n\t\n").unwrap();
        let err = parse(file.to_str().unwrap(), &ParseOptions::default()).unwrap_err();
        assert_eq!(err.kind(), "no_text");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 不存在的文件 / 目录：给出可读的英文原因，而不是让底层 IO 错误直接漏出去
    #[test]
    fn missing_file_and_directory_get_clear_errors() {
        let dir = tmp_dir("missing");
        let mut opts = ParseOptions::default();

        let missing = dir.join("nope.txt");
        opts.max_chars = DEFAULT_MAX_CHARS;
        let err = parse(missing.to_str().unwrap(), &opts).unwrap_err();
        assert_eq!(err.kind(), "backend");
        assert!(
            err.message().contains("does not exist or is not accessible"),
            "{}",
            err.message()
        );

        // 目录（扩展名只是为了让白名单先放行）→ 明确说「这是目录」
        let as_dir = dir.join("folder.txt");
        std::fs::create_dir_all(&as_dir).unwrap();
        let err = parse(as_dir.to_str().unwrap(), &opts).unwrap_err();
        assert!(
            err.message().contains("is a directory, not a file"),
            "{}",
            err.message()
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// 两句说明**都要留住**：`layout_text` 失败退回原样 + `ocrImages: true` 会同时命中，
    /// 早先这里是「赋值」，OCR 摘要把「行序可能不是版面顺序」那句整句顶掉了。
    #[test]
    fn layout_caveat_and_ocr_note_are_both_kept() {
        let merged = join_notes([
            Some(pdf::RAW_ORDER_NOTE.to_string()),
            Some("2 embedded image(s) were additionally read with on-device OCR".to_string()),
        ])
        .unwrap();
        assert!(merged.contains("the layout pass could not be used"), "{merged}");
        assert!(merged.contains("2 embedded image(s)"), "{merged}");
        assert_eq!(merged.matches(" · ").count(), 1, "两句只拼一次：{merged}");

        assert_eq!(
            join_notes([Some("only one".to_string()), None]).as_deref(),
            Some("only one")
        );
        assert_eq!(join_notes([None, None]), None);
    }

    /// 没有内嵌图片的格式（纯文本 / CSV）收到 `ocrImages` 要如实说一句 ——
    /// 静默忽略等于骗模型「图里的字读过了」（Office 六种是**有**图的格式，不再进这一档）
    #[test]
    fn ocr_images_on_a_format_without_images_is_reported_as_ignored() {
        let dir = tmp_dir("ocr_nonpdf");
        let file = dir.join("notes.txt");
        std::fs::write(&file, "hello\n").unwrap();

        let requested = ParseOptions {
            ocr: Some(OcrOptions {
                models_dir: Err("not needed".to_string()),
                always: true,
                cancel: None,
            }),
            ..Default::default()
        };
        let out = parse(file.to_str().unwrap(), &requested).unwrap();
        let note = out
            .note
            .expect("没图的格式收到 ocrImages 必须给一句说明");
        assert!(note.contains("this format has no embedded images"), "{note}");
        assert!(out.ocr.is_none(), "没图的格式根本不碰 OCR");

        // 显式 `false`（`ocr` 为 `None`）= 调用方本来就期待不跑，不必再解释一遍
        let off = ParseOptions {
            ocr: None,
            ..Default::default()
        };
        assert_eq!(parse(file.to_str().unwrap(), &off).unwrap().note, None);

        std::fs::remove_dir_all(&dir).ok();
    }

    /// `ocrImages` 只对有内嵌图片的格式有意义：`pdf` 与 Office 六种都算，其余不算
    #[test]
    fn embedded_image_capable_formats_are_the_pdf_and_office_ones() {
        for ext in ["pdf", "docx", "doc", "xlsx", "xls", "pptx", "ppt"] {
            assert!(has_embedded_images(ext), "{ext} 应该有图");
        }
        for ext in ["txt", "md", "json", "csv", "tsv"] {
            assert!(!has_embedded_images(ext), "{ext} 没有「内嵌图片」这个概念");
        }
    }
}
