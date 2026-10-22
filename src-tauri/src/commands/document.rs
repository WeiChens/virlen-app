//! 文档（`parse_document` 工具 + 右侧面板预览）的命令层：只做参数兜底 + 转交，
//! 解析在 `virlen_core::doc_parse`，版式与失败语义与原生工具同一条组装链（`parse_targets` / `preview`）。
//! ⚠️ 路径安全由**前端**先做（`securityService.resolveSafePath`）；Rust 原生工具路径自己走 `resolve_safe_path`。
//! ⚠️ 新增命令必须登记到 `lib.rs` 的 `generate_handler![...]`，否则 `invoke` 静默 404。

use crate::host::TauriHost;
use tauri::AppHandle;
use virlen_core::agent::native_tools::{
    default_max_chars, ocr_options, parse_targets, ParseTarget,
};
use virlen_core::doc_parse::preview::{self, DocumentPreview, PreviewBody};
use virlen_core::doc_parse::{ParseError, ParseOptions};

/// 解析结果：模型侧英文文本 + 界面结构化数据 + 是否全部失败。
/// `ok == false` 要当**失败**抛出（与原生工具 `NativeToolError` 同语义）。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedDocumentResult {
    pub content: String,
    pub ui_data: serde_json::Value,
    pub ok: bool,
}

/// 解析一份或多份文档（TS 回退路径 / 浏览器 dev；默认引擎走原生工具）。
/// 参数即前端 `invoke` 的载荷字段，合结构体会同时改前端调用形状。
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn cmd_parse_document(
    app: AppHandle,
    path: Option<String>,
    paths: Option<Vec<String>>,
    sheet: Option<String>,
    max_chars: Option<usize>,
    offset: Option<usize>,
    out_txt_file: Option<String>,
    ocr_images: Option<bool>,
) -> Result<ParsedDocumentResult, String> {
    // 与原生工具同口径：`paths` 优先，空串条目丢掉
    let mut inputs: Vec<String> = paths
        .unwrap_or_default()
        .into_iter()
        .filter(|p| !p.trim().is_empty())
        .collect();
    let out_txt_file = out_txt_file.filter(|p| !p.trim().is_empty());
    if inputs.is_empty() {
        if let Some(p) = path.filter(|p| !p.trim().is_empty()) {
            inputs.push(p);
        }
    }
    if inputs.is_empty() {
        return Err("Missing required parameter: \"path\" or \"paths\"".to_string());
    }

    let opts = ParseOptions {
        sheet: sheet.filter(|s| !s.trim().is_empty()),
        // 默认预览长度与原生工具同一份逻辑（传了 `outTxtFile` 时默认只回短预览）
        max_chars: max_chars
            .filter(|n| *n > 0)
            .unwrap_or_else(|| default_max_chars(out_txt_file.as_deref())),
        offset: offset.unwrap_or(0),
        // 全文开关由 `parse_targets` 按 `outTxtFile` 统一推导
        full_text: false,
        // OCR 三态语义与原生工具同一份实现；模型目录走 Tauri 宿主（前端没有「资源目录」这个概念）
        ocr: ocr_options(&TauriHost::new(app), ocr_images, None),
    };

    let targets: Vec<ParseTarget> = inputs.into_iter().map(ParseTarget::Path).collect();
    let agg = parse_targets(&targets, &opts, out_txt_file.as_deref(), None).await;
    Ok(ParsedDocumentResult {
        content: agg.content,
        ui_data: agg.ui_data,
        ok: !agg.failed,
    })
}

// ═══════════════════════════════════════════════════════════════════════════
// 右侧文件面板的预览（`cmd_preview_document`）
// ═══════════════════════════════════════════════════════════════════════════

/// 一片合并区域（0-based 闭区间）—— 界面画成 `colspan` / `rowspan`
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergedBoundsDto {
    pub row_first: u32,
    pub row_last: u32,
    pub col_first: u32,
    pub col_last: u32,
}

/// 一张工作表的网格（`rows` 受 core 的行 / 列上限约束，`rowCount` / `colCount` 是真实总量）
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSheetDto {
    pub name: String,
    pub rows: Vec<Vec<String>>,
    pub row_count: usize,
    pub col_count: usize,
    /// 合并区域（整张表的 0-based 坐标，未按物化上限裁剪）
    pub merges: Vec<MergedBoundsDto>,
}

/// 预览结果：文稿 / 演示给 `text`（Markdown），表格给 `sheets`。
///
/// 两种形状**同时在结构里**（另一个是空值），因为界面只关心「拿到的这是什么」——
/// 分成两个命令会让前端多一个分支，而它们本来就是同一个文件的两种形态。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentPreviewDto {
    /// 小写扩展名（`docx` / `pptx` / `xlsx` …）
    pub kind: String,
    /// 文稿 / 演示的 Markdown 正文（表格类为空串）
    pub text: String,
    /// 正文的**全文**字符数（不是 `text` 的长度）
    pub char_count: usize,
    /// 正文是否被长度上限截断
    pub truncated: bool,
    /// 表格类：每张工作表一份网格（文稿 / 演示为空数组）
    pub sheets: Vec<PreviewSheetDto>,
    pub byte_size: u64,
}

/// 预览失败的结构化原因（界面按 `kind` 重建文案，不解析英文正文 —— 与 `parse_document` 的 D2-A 同口径）
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewErrorDto {
    /// `unsupported` / `too_large` / `no_text` / `backend` / `internal`
    pub kind: String,
    /// 小写扩展名（错误文案里的格式名）
    pub ext: String,
    /// `too_large` 时的上限（字节）
    pub limit: Option<u64>,
}

fn preview_error(err: ParseError) -> PreviewErrorDto {
    PreviewErrorDto {
        kind: err.kind().to_string(),
        ext: match &err {
            ParseError::Unsupported { ext } => ext.clone(),
            ParseError::TooLarge { .. } => String::new(),
            ParseError::NoText { .. } => String::new(),
            ParseError::SheetNotFound { .. } => String::new(),
            ParseError::Backend { format, .. } => format.clone(),
        },
        limit: match &err {
            ParseError::TooLarge { limit, .. } => Some(*limit),
            _ => None,
        },
    }
}

/// 右侧面板的文档预览（Office 六种：`docx`/`doc`/`pptx`/`ppt`/`xlsx`/`xls`）。
///
/// `pdf` 与 `csv` **不走这里**：前者由前端 pdfjs 按页栅格化，后者在面板里是可编辑文本、
/// 表格预览由草稿现场解析（见 `workspace-file` 的文件头）。
///
/// ⚠️ 路径安全由**前端**先做（`securityService.resolveSafePath`），与 `cmd_parse_document` 同一约定。
/// ⚠️ 解析是同步的第三方库（`office_oxide`），必须扔到阻塞线程池，否则会卡住 async 运行时。
#[tauri::command]
pub async fn cmd_preview_document(path: String) -> Result<DocumentPreviewDto, PreviewErrorDto> {
    let parsed = tauri::async_runtime::spawn_blocking(move || preview::preview(&path))
        .await
        .map_err(|_| PreviewErrorDto {
            kind: "internal".to_string(),
            ext: String::new(),
            limit: None,
        })?;
    let preview: DocumentPreview = parsed.map_err(preview_error)?;

    let (text, char_count, truncated, sheets) = match preview.body {
        PreviewBody::Text {
            text,
            char_count,
            truncated,
        } => (text, char_count, truncated, Vec::new()),
        PreviewBody::Sheets(sheets) => (
            String::new(),
            0,
            false,
            sheets
                .into_iter()
                .map(|sheet| PreviewSheetDto {
                    name: sheet.name,
                    rows: sheet.rows,
                    row_count: sheet.row_count,
                    col_count: sheet.col_count,
                    merges: sheet
                        .merges
                        .into_iter()
                        .map(|region| MergedBoundsDto {
                            row_first: region.row_first,
                            row_last: region.row_last,
                            col_first: region.col_first,
                            col_last: region.col_last,
                        })
                        .collect(),
                })
                .collect(),
        ),
    };

    Ok(DocumentPreviewDto {
        kind: preview.kind,
        text,
        char_count,
        truncated,
        sheets,
        byte_size: preview.byte_size,
    })
}
