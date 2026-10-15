//! `parse_document` 工具（原生）+ **GUI 命令共用的组装链** —— 把二进制文档读成文本
//! （PDF / Office / CSV / 纯文本）。
//!
//! 与 `read_file` 的分工：`read_file` 只读得出「文本文件」，PDF / Office 这类压缩包或 OLE 容器
//! 它一律读不出内容；反过来 `parse_document` 不做行号 / 命中哈希那套编辑语义。
//!
//! 三层分工（改任何一层都别把另外两层的内容搬过来）：
//! 1. **解析**：`crate::doc_parse`（唯一实现，知识库导入 PDF 也走它）；
//! 2. **组装**：[`parse_targets`] —— 模型侧文本 + `uiData`，工具与 Tauri 命令**同一条链**；
//! 3. **安全 + 参数**：工具走 [`resolve_safe_path`]（黑名单 > 白名单 > 工作目录）；
//!    GUI 命令的安全性由前端 `securityService` 先做完（与 `read_file_with_hash` 同一种约定）。
//!
//! ⚠️ 模型侧文案固定英文（D2-A）：`content` / 报错都是英文，界面按 `uiData` 重建。
//!
//! `outTxtFile`（选填）：文档太大时把**全文**落成一份文本文件，本次只回短预览 —— 模型随后用
//! `read_file` / `search_text_in_files` 按需取用。落盘走 `resolve_safe_path(.., "w", ..)`（写模式：
//! 白名单 + 工作目录，黑名单优先）；**被拒就直接失败**，不悄悄降级成「只回正文」。
//!
//! `ocrImages`（选填）：字在图片里的文档（扫描件 PDF、整篇截图、报表里的图）—— 端侧 OCR（quasivision，
//! **图片不出本机**）把图里的字读出来当正文。`pdf` 与 Office 六种都支持，一份文档最多
//! `doc_parse::ocr::MAX_IMAGES` 张（超出的如实报「没读」）；太小 / 太扁的图不读
//! （`ocr::MIN_IMAGE_SIDE` / `ocr::MAX_ASPECT_RATIO`，长边 > 短边 × 3 的横幅、单行截图那类）。
//! 三态语义见 [`ocr_options`]，口径与 GUI 命令共用同一条链。

use crate::agent::cancellation::CancellationToken;
use crate::agent::host::HostEnv;
use crate::agent::native_tools::common::{arg_bool, arg_i64, arg_str, arg_str_array, resolve_safe_path};
use crate::agent::native_tools::heavy;
use crate::agent::native_tools::{NativeToolCtx, NativeToolOutcome};
use crate::doc_parse::{self, DocText, OcrOptions, OcrSummary, ParseError, ParseOptions};
use serde_json::{json, Value};

use super::common::format_size;

/// 一份待解析目标 —— 要么是**已过安全校验**的路径，要么是「已被拒」的记录。
///
/// 拒收也做成合法输入（而不是提前 return）：多文件时前台要按**入参顺序**逐份报结果，
/// 被拒的那份不能悄悄消失，也不能把后面的结果挤位。
pub enum ParseTarget {
    /// 绝对路径（调用方已做过安全校验）
    Path(String),
    /// 被安全闸拒收（`message` = 拒收原因，模型侧英文）
    Rejected { path: String, message: String },
}

/// `outTxtFile` 生效、且模型**没有**显式给 `max_chars` 时的默认预览长度。
///
/// 2000 字 ≈ 中文两千字，够模型判断「这份文档是什么」；细节已经落在文件里，用 `read_file` /
/// `search_text_in_files` 按需取，不必再一次灌满上下文。
pub const OUT_FILE_PREVIEW_CHARS: usize = 2_000;

/// 默认预览长度：要落盘 → [`OUT_FILE_PREVIEW_CHARS`]，否则 → [`doc_parse::DEFAULT_MAX_CHARS`]
///
/// ⚠️ 工具与 GUI 命令都必须用它兜底：两边各写一个默认值 = 同一句调用在引擎路径与回退路径下
/// 返回的长度不同（铁律 1）。
pub fn default_max_chars(out_txt_file: Option<&str>) -> usize {
    if out_txt_file.is_some() {
        OUT_FILE_PREVIEW_CHARS
    } else {
        doc_parse::DEFAULT_MAX_CHARS
    }
}

/// `ocrImages` 的**三态**语义（工具与 GUI 命令共用；两侧各解一次就会分叉）：
///
/// | 入参 | 行为 |
/// |---|---|
/// | 没传 | **自动兜底**：只有「除图片外没有文字」的文档才跑（扫描件 PDF / 整篇截图） |
/// | `true` | 有正文也跑：图片里的字（截图 / 表格图）也读 |
/// | `false` | 完全不跑（显式关掉兜底，纯图文档直接报「没有文字」） |
///
/// 模型目录只在这里解析：只有调用方拿得到宿主（工具 → `ctx.host`，GUI 命令 → `TauriHost`）。
pub fn ocr_options(
    host: &dyn HostEnv,
    requested: Option<bool>,
    cancel: Option<CancellationToken>,
) -> Option<OcrOptions> {
    if requested == Some(false) {
        return None;
    }
    Some(OcrOptions {
        models_dir: crate::vision::models_dir(host),
        always: requested == Some(true),
        cancel,
    })
}

/// `outTxtFile` 的落盘结果 —— 模型侧提示行与 `uiData` 共用同一份事实
enum OutFile {
    /// 已写入（`char_count` 是**全文**字符数，与本次预览长度无关）
    Saved {
        path: String,
        char_count: usize,
        byte_size: usize,
    },
    /// 没写成（解析结果照常给，但必须让模型知道文件没落成）
    Failed { path: String, message: String },
}

impl OutFile {
    /// 模型侧提示行（固定英文）
    fn line(&self) -> String {
        match self {
            Self::Saved {
                path,
                char_count,
                byte_size,
            } => format!(
                "💾 Full text saved to {path} ({char_count} chars · {})",
                format_size(*byte_size)
            ),
            Self::Failed { path, message } => {
                format!("⚠️ Failed to write full text to {path} — {message}")
            }
        }
    }

    /// 界面侧结构化数据（`uiData.outTxtFile`）
    fn ui(&self) -> Value {
        match self {
            Self::Saved {
                path,
                char_count,
                byte_size,
            } => json!({
                "path": path,
                "ok": true,
                "charCount": char_count,
                "byteSize": byte_size,
            }),
            Self::Failed { path, message } => json!({
                "path": path,
                "ok": false,
                "error": message,
            }),
        }
    }
}

/// 一次调用的整体结果（模型侧文本 + 界面侧结构化数据）
pub struct ParseAggregate {
    /// 模型侧文本（固定英文）
    pub content: String,
    /// 界面侧结构化数据：单份 = 该份对象；多份 = `{ files: [...] }`
    pub ui_data: Value,
    /// 是否全部失败（调用方据此决定是「成功」还是「失败」）
    pub failed: bool,
}

/// **组装入口**：解析若干目标并按统一版式输出（工具与 GUI 命令都调它）
///
/// `out_txt_file`（已过安全校验的绝对路径）：把**每份成功解析文档的全文**写进这一个文件
/// （多份按入参顺序、`---` 分隔；一个都没成功时一个字节也不写，免得留下空文件）。
pub async fn parse_targets(
    targets: &[ParseTarget],
    opts: &ParseOptions,
    out_txt_file: Option<&str>,
    cancel: Option<&CancellationToken>,
) -> ParseAggregate {
    let single = targets.len() == 1;
    // 没有取消诉求的调用方（GUI 命令）用「永不取消」的令牌，避免下面到处 `Option` 分支
    let no_cancel: CancellationToken = (*heavy::NEVER_CANCELLED).clone();
    let cancel = cancel.unwrap_or(&no_cancel);
    // 要落盘才把全文带回来 —— 全文开关只在这里推导（调用方不要自己设 `full_text`）
    let parse_opts = ParseOptions {
        full_text: out_txt_file.is_some(),
        ..opts.clone()
    };
    let mut blocks: Vec<String> = Vec::new();
    let mut uis: Vec<Value> = Vec::new();
    let mut errors: Vec<String> = Vec::new();
    let mut fulls: Vec<String> = Vec::new();

    for target in targets {
        match target {
            ParseTarget::Rejected { path, message } => {
                errors.push(format!("{path} — {message}"));
                uis.push(json!({
                    "file": path,
                    "ok": false,
                    "errorKind": "denied",
                    "error": message,
                }));
            }
            ParseTarget::Path(full_path) => {
                // 多份文档之间也要能取消：外层 select 已能立刻返回，这里避免再白启动后续解析
                if cancel.is_cancelled() {
                    break;
                }
                match parse_one(full_path, &parse_opts, cancel).await {
                    Ok(parsed) => {
                        if let Some(full) = parsed.full_text {
                            fulls.push(full);
                        }
                        blocks.push(parsed.content);
                        uis.push(parsed.ui);
                    }
                    Err((message, ui)) => {
                        errors.push(message);
                        uis.push(ui);
                    }
                }
            }
        }
    }

    let out_file = match out_txt_file {
        Some(path) if !fulls.is_empty() => Some(write_full_text(path, fulls).await),
        _ => None,
    };

    let mut ui_data = if single {
        uis.into_iter().next().unwrap_or_else(|| json!({}))
    } else {
        json!({ "files": uis })
    };
    // 落盘信息与文档对象同层：单文件时挂在那个对象上，多文件时与 `files` 并列
    if let (Some(out), Some(obj)) = (&out_file, ui_data.as_object_mut()) {
        obj.insert("outTxtFile".into(), out.ui());
    }

    if blocks.is_empty() {
        return ParseAggregate {
            content: errors.join("\n"),
            ui_data,
            failed: true,
        };
    }

    let mut parts: Vec<String> = blocks
        .iter()
        .enumerate()
        .map(|(i, c)| if i == 0 { c.clone() } else { format!("\n---\n{c}") })
        .collect();
    // 落盘提示放**最前**：正文很长时放在尾部模型容易略过
    if let Some(out) = &out_file {
        parts.insert(0, out.line());
    }
    if !errors.is_empty() {
        parts.push(format!(
            "\n\n⚠️ Failed to parse {} file(s):\n{}",
            errors.len(),
            errors
                .iter()
                .map(|e| format!("  - {e}"))
                .collect::<Vec<_>>()
                .join("\n")
        ));
    }

    ParseAggregate {
        content: parts.join("\n"),
        ui_data,
        failed: false,
    }
}

/// 一份文档的解析结果（`full_text` 只在调用方要落盘时才是 `Some`）
struct ParsedOne {
    content: String,
    ui: Value,
    full_text: Option<String>,
}

/// 把全文写进 `out` —— 走 `file_ops::write_file`（写文件的唯一实现：建父目录 + 失败原因口径一致）
async fn write_full_text(out: &str, fulls: Vec<String>) -> OutFile {
    let path = out.to_string();
    let content = fulls.join("\n---\n");
    let char_count = content.chars().count();
    let target = path.clone();
    let written =
        tokio::task::spawn_blocking(move || crate::file_ops::write_file(&target, &content)).await;
    match written {
        Ok(Ok(result)) => OutFile::Saved {
            path,
            char_count,
            byte_size: result.byte_size,
        },
        Ok(Err(e)) => OutFile::Failed { path, message: e },
        Err(join_err) => OutFile::Failed {
            path,
            message: format!("internal error: {join_err}"),
        },
    }
}

/// 取消时的统一结果（文案与 `web_fetch` / `vision_analyze` 同口径）。
///
/// ⚠️ 取消为什么只能在**工具层**兜：解析走第三方同步库（`pdf-extract` / `office_oxide`），内部没有
/// 检查点，`spawn_blocking` 的 JoinHandle 丢掉也不会停掉已开跑的任务。这里 select 的价值是
/// **让工具立刻返回、引擎立刻收敛**（用户点「停止」立即有反应），而不是省 CPU；能协作退出的
/// 内层只有 OCR 的逐图循环（见 `ocr_options` 收到的 `ctx.cancel`）。
fn cancelled(targets: &[ParseTarget]) -> Result<NativeToolOutcome, String> {
    let what = match targets {
        [ParseTarget::Path(p)] => p.clone(),
        other => format!("{} file(s)", other.len()),
    };
    Ok(NativeToolOutcome::error(format!(
        "parse_document was cancelled: {}",
        what
    )))
}

/// 解析一份：读元信息 → 重活入口跑解析（同步 CPU 活，别占住异步运行时）→ 组装
async fn parse_one(
    full_path: &str,
    opts: &ParseOptions,
    cancel: &CancellationToken,
) -> Result<ParsedOne, (String, Value)> {
    let byte_size = std::fs::metadata(full_path).map(|m| m.len()).unwrap_or(0);
    let target = full_path.to_string();
    let opts_owned = opts.clone();
    // ⚠️ 解析走第三方同步库（`pdf-extract` / `office_oxide` 内部没有检查点），所以取消靠两层：
    // ① `run_heavy` 立刻返回、丢弃结果（引擎马上收敛）；② OCR 逐图循环里的取消标志
    //    （`ocr_options` 已把 `ctx.cancel` 传进 `doc_parse`，这是唯一能协作退出的内层）。
    let heavy_outcome =
        heavy::run_heavy(cancel, move |_flag| doc_parse::parse(&target, &opts_owned)).await;
    let parsed = match heavy_outcome {
        // 被取消：不算解析失败，但要让调用链知道这一份没结果
        heavy::Heavy::Cancelled => {
            return Err((
                format!("{full_path} — cancelled by the user"),
                json!({
                    "file": full_path,
                    "ok": false,
                    "errorKind": "cancelled",
                    "error": "cancelled by the user",
                }),
            ))
        }
        heavy::Heavy::Panicked(e) => {
            return Err((
                format!("{full_path} — internal error: {e}"),
                json!({ "file": full_path, "ok": false, "errorKind": "internal", "error": e }),
            ))
        }
        heavy::Heavy::Done(v) => v,
    };

    match parsed {
        Ok(doc) => {
            let content = render_block(full_path, byte_size, opts, &doc);
            let ui = ui_data(full_path, byte_size, opts, &doc);
            Ok(ParsedOne {
                content,
                ui,
                full_text: doc.full_text,
            })
        }
        Err(err) => {
            let message = err.message();
            Err((
                format!("{full_path} — {message}"),
                error_ui_data(full_path, byte_size, &err),
            ))
        }
    }
}

/// 工具入口：安全校验（黑名单 > 白名单 > 工作目录）→ 组装
///
/// 可取消：预检在最前（已点停止就不再启动解析），解析过程整体包在 `tokio::select!` 里
/// （取消时立刻返回，见 [`cancelled`] 的说明）。
pub(crate) async fn parse_document_tool(
    ctx: &NativeToolCtx<'_>,
    args: &Value,
) -> Result<NativeToolOutcome, String> {
    // 输出文件（选填）：**写模式**校验（白名单 + 工作目录，黑名单优先）。被拒 = 直接失败
    // —— 模型要的是落盘，行为被悄悄换成「只回正文」它得知道
    let out_txt_file = match arg_str(args, "outTxtFile").filter(|s| !s.trim().is_empty()) {
        Some(out) => Some(
            resolve_safe_path(&out, "w", ctx.security)
                .map_err(|e| format!("Cannot write \"outTxtFile\" — {e}"))?,
        ),
        None => None,
    };

    // 与 read_file 同口径：缺失 / <=0 时取默认值；要落盘时默认只回短预览（省上下文）
    let max_chars = match arg_i64(args, "max_chars") {
        Some(n) if n > 0 => n as usize,
        _ => default_max_chars(out_txt_file.as_deref()),
    };
    let opts = ParseOptions {
        sheet: arg_str(args, "sheet").filter(|s| !s.trim().is_empty()),
        max_chars,
        offset: arg_i64(args, "offset").unwrap_or(0).max(0) as usize,
        // 全文开关由 `parse_targets` 按 `outTxtFile` 统一推导（这里不设，避免两份真相）
        full_text: false,
        // OCR 开关：没传 = 扫描件兜底；`true` = 图片里的字也读；`false` = 关闭
        ocr: ocr_options(ctx.host, arg_bool(args, "ocrImages"), Some(ctx.cancel.clone())),
    };

    // 支持 paths 数组（一次解析多份）
    let paths = arg_str_array(args, "paths");
    let targets: Vec<ParseTarget> = if paths.is_empty() {
        let path = arg_str(args, "path").unwrap_or_default();
        if path.is_empty() {
            return Err("Missing required parameter: \"path\" or \"paths\"".to_string());
        }
        vec![resolve_target(ctx, &path)]
    } else {
        paths.iter().map(|p| resolve_target(ctx, p)).collect()
    };

    // 取消预检：已经点了停止就不该再启动一次（可能几十秒的）文档解析
    if ctx.cancel.is_cancelled() {
        return cancelled(&targets);
    }

    let agg = tokio::select! {
        _ = ctx.cancel.cancelled() => return cancelled(&targets),
        agg = parse_targets(&targets, &opts, out_txt_file.as_deref(), Some(ctx.cancel)) => agg,
    };
    if agg.failed {
        return Ok(NativeToolOutcome::error_with_ui(agg.content, agg.ui_data));
    }
    Ok(NativeToolOutcome::Value {
        content: agg.content,
        ui_data: Some(agg.ui_data),
    })
}

/// 单个路径的安全校验（相对路径按工作目录展开）
fn resolve_target(ctx: &NativeToolCtx<'_>, path: &str) -> ParseTarget {
    match resolve_safe_path(path, "r", ctx.security) {
        Ok(full) => ParseTarget::Path(full),
        Err(e) => ParseTarget::Rejected {
            path: path.to_string(),
            message: e,
        },
    }
}

/// 模型侧文本（固定英文，头部风格对齐 `read_file`）
fn render_block(full_path: &str, byte_size: u64, opts: &ParseOptions, doc: &DocText) -> String {
    let sheet_part = match (&doc.sheet, doc.sheets.is_empty()) {
        (Some(sheet), _) => format!(" · sheet: \"{sheet}\""),
        (None, false) => format!(" · sheets: {}", doc.sheets.join(", ")),
        (None, true) => String::new(),
    };
    let ocr_part = match &doc.ocr {
        Some(ocr) if ocr.images > 0 => format!(" · ocr: {} image(s)", ocr.images),
        _ => String::new(),
    };
    let mut header = vec![
        format!("📄 {full_path}"),
        format!(
            "🔢 {} · {} · {} chars{sheet_part}{ocr_part}",
            doc.kind,
            format_size(byte_size as usize),
            doc.char_count,
        ),
    ];
    if let Some(note) = &doc.note {
        header.push(format!("💡 {note}"));
    }
    if doc.truncated {
        let shown_end = opts.offset + doc.text.chars().count();
        let remaining = doc.char_count.saturating_sub(shown_end);
        header.push(format!(
            "💡 Tip: content truncated, {remaining} chars remaining. Use offset={} to read more",
            doc.next_offset.unwrap_or(shown_end)
        ));
    }
    format!("{}\n\n{}", header.join("\n"), doc.text)
}

/// 界面侧结构化数据（D2-A：界面按 `uiData` 重建文案，不解析模型侧英文）
fn ui_data(full_path: &str, byte_size: u64, opts: &ParseOptions, doc: &DocText) -> Value {
    let mut ui = json!({
        "file": full_path,
        "ok": true,
        "fileType": doc.kind,
        "byteSize": byte_size,
        "charCount": doc.char_count,
        "truncated": doc.truncated,
        "offset": opts.offset,
        "nextOffset": doc.next_offset,
        "sheets": doc.sheets,
        "sheet": doc.sheet,
        "note": doc.note,
        "text": doc.text,
    });
    // OCR 事实（没跑 OCR 时不出现 —— 界面据此决定要不要出它那块）
    if let (Some(summary), Some(obj)) = (&doc.ocr, ui.as_object_mut()) {
        obj.insert("ocr".into(), ocr_ui(summary));
    }
    ui
}

/// OCR 摘要 → 界面侧结构化数据（逐图事实；**不带正文** —— 正文已在 `text` / 正文块里）
fn ocr_ui(summary: &OcrSummary) -> Value {
    json!({
        "available": summary.available,
        "unavailableKind": summary.unavailable.map(|kind| kind.kind()),
        "unavailableReason": summary.unavailable_reason,
        "images": summary.images,
        "chars": summary.chars,
        "skipped": summary.skipped,
        "empty": summary.empty,
        "errors": summary.errors,
        "total": summary.total,
        "truncated": summary.truncated,
        "sections": summary
            .sections
            .iter()
            .map(|s| json!({
                "index": s.index,
                "place": s.place,
                "width": s.width,
                "height": s.height,
                "objectId": s.object_id,
                "chars": s.chars,
            }))
            .collect::<Vec<_>>(),
    })
}

/// 失败时的结构化信息（界面按语言重建原因：分类 / 文件类型 / 大小 / 上限）
fn error_ui_data(full_path: &str, byte_size: u64, err: &ParseError) -> Value {
    let mut ui = json!({
        "file": full_path,
        "ok": false,
        "errorKind": err.kind(),
        "error": err.message(),
        "byteSize": byte_size,
    });
    if let Some(obj) = ui.as_object_mut() {
        match err {
            ParseError::Unsupported { ext } => {
                obj.insert("fileType".into(), json!(ext));
            }
            ParseError::TooLarge { limit, .. } => {
                obj.insert("limit".into(), json!(limit));
                obj.insert("fileType".into(), json!(doc_parse::extension_of(full_path)));
            }
            ParseError::SheetNotFound {
                requested,
                available,
            } => {
                obj.insert("requestedSheet".into(), json!(requested));
                obj.insert("sheets".into(), json!(available));
            }
            ParseError::Backend { format, .. } => {
                obj.insert("fileType".into(), json!(format));
            }
            ParseError::NoText { .. } => {
                obj.insert("fileType".into(), json!(doc_parse::extension_of(full_path)));
                obj.insert("charCount".into(), json!(0));
            }
        }
    }
    ui
}

#[cfg(test)]
mod tests;
