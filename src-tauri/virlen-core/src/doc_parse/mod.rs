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
//! | `pdf` | [`pdf`]（`pdf-extract`） | 抽取的纯文本；**扫描版无文字层 → [`ParseError::NoText`]**，不做 OCR |
//! | `docx` `doc` `pptx` `ppt` | [`office`]（`office_oxide`） | Markdown（保留标题 / 列表 / 表格） |
//! | `xlsx` `xls` | [`office`]（`office_oxide`） | 工作表名 + 制表符分隔的行（表格用 Markdown 太费 token） |
//! | `csv` `tsv` | [`delimited`]（`csv`） | 规范化的 CSV（分隔符嗅探 → 统一逗号；解析失败回退原文） |
//! | `txt` `md` `json` … | [`text`] | 解码后的原文（BOM / UTF-16 / GB18030 / BIG5 / Shift_JIS 兜底） |

pub mod delimited;
pub mod office;
pub mod pdf;
pub mod text;

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
    /// 抽不出文本（扫描版 PDF / 纯图文档）—— **不做 OCR**，如实报错而不是回一个空串
    NoText,
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
            Self::NoText => "No text could be extracted from this document (it may be image-only; OCR is not supported)".to_string(),
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
            Self::NoText => "no_text",
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
}

impl Default for ParseOptions {
    fn default() -> Self {
        Self {
            sheet: None,
            max_chars: DEFAULT_MAX_CHARS,
            offset: 0,
            full_text: false,
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
    let raw: String = match ext.as_str() {
        "pdf" => {
            let bytes = read_bytes(file, &ext)?;
            pdf::extract_text(&bytes).map_err(|e| ParseError::Backend {
                format: ext.clone(),
                message: e,
            })?
        }
        "docx" | "doc" | "xlsx" | "xls" | "pptx" | "ppt" => {
            let out = office::extract_text(path, opts.sheet.as_deref(), &ext)?;
            sheets = out.sheets;
            used_sheet = out.sheet;
            if let Some(n) = out.note {
                note = Some(n);
            }
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

    if raw.trim().is_empty() {
        return Err(ParseError::NoText);
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
    })
}

/// 读文件（失败 → `Backend`）
fn read_bytes(file: &Path, ext: &str) -> Result<Vec<u8>, ParseError> {
    std::fs::read(file).map_err(|e| ParseError::Backend {
        format: ext.to_string(),
        message: e.to_string(),
    })
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
}
