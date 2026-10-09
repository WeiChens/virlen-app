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

use crate::agent::native_tools::common::{arg_i64, arg_str, arg_str_array, resolve_safe_path};
use crate::agent::native_tools::{NativeToolCtx, NativeToolOutcome};
use crate::doc_parse::{self, DocText, ParseError, ParseOptions};
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
) -> ParseAggregate {
    let single = targets.len() == 1;
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
            ParseTarget::Path(full_path) => match parse_one(full_path, &parse_opts).await {
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
            },
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

/// 解析一份：读元信息 → `spawn_blocking` 跑解析（同步 CPU 活，别占住异步运行时）→ 组装
async fn parse_one(full_path: &str, opts: &ParseOptions) -> Result<ParsedOne, (String, Value)> {
    let byte_size = std::fs::metadata(full_path).map(|m| m.len()).unwrap_or(0);
    let target = full_path.to_string();
    let opts_owned = opts.clone();
    let parsed = tokio::task::spawn_blocking(move || doc_parse::parse(&target, &opts_owned)).await;

    match parsed {
        Ok(Ok(doc)) => {
            let content = render_block(full_path, byte_size, opts, &doc);
            let ui = ui_data(full_path, byte_size, opts, &doc);
            Ok(ParsedOne {
                content,
                ui,
                full_text: doc.full_text,
            })
        }
        Ok(Err(err)) => {
            let message = err.message();
            Err((
                format!("{full_path} — {message}"),
                error_ui_data(full_path, byte_size, &err),
            ))
        }
        Err(join_err) => {
            let message = format!("internal error: {join_err}");
            Err((
                format!("{full_path} — {message}"),
                json!({ "file": full_path, "ok": false, "errorKind": "internal", "error": message }),
            ))
        }
    }
}

/// 工具入口：安全校验（黑名单 > 白名单 > 工作目录）→ 组装
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

    let agg = parse_targets(&targets, &opts, out_txt_file.as_deref()).await;
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
    let mut header = vec![
        format!("📄 {full_path}"),
        format!(
            "🔢 {} · {} · {} chars{}",
            doc.kind,
            format_size(byte_size as usize),
            doc.char_count,
            sheet_part
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
    json!({
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
            ParseError::NoText => {
                obj.insert("fileType".into(), json!(doc_parse::extension_of(full_path)));
                obj.insert("charCount".into(), json!(0));
            }
        }
    }
    ui
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::bridge::AgentBridgeState;
    use crate::agent::cancellation::CancellationToken;
    use crate::agent::event_sink::TestEventSink;
    use crate::agent::native_tools::noop_repo;
    use crate::agent::native_tools::test_util::test_security;
    use crate::agent::types::NativeToolSecurity;

    fn fixture(name: &str) -> String {
        format!("{}/tests/fixtures/office/{name}", env!("CARGO_MANIFEST_DIR"))
    }

    fn tmp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "virlen_parse_tool_{tag}_{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 真正跑一次工具（唯一的上下文组装点）
    async fn call(sec: NativeToolSecurity, args: Value) -> Result<NativeToolOutcome, String> {
        let sink = TestEventSink::new();
        let cancel = CancellationToken::new();
        let bridge = AgentBridgeState::default();
        let ctx = NativeToolCtx {
            session_id: "s_parse",
            tool_call_id: "tc_parse",
            cancel: &cancel,
            sink: &sink,
            bridge: &bridge,
            security: &sec,
            repo: noop_repo(),
            skills: None,
            host: crate::host::default_host().as_ref(),
            settings: crate::agent::native_tools::noop_settings(),
            memory: crate::agent::native_tools::noop_memory(),
        };
        parse_document_tool(&ctx, &args).await
    }

    async fn run(workspace: &str, args: Value) -> NativeToolOutcome {
        call(test_security(workspace), args)
            .await
            .expect("工具不应返回协议级错误")
    }

    fn content_of(outcome: &NativeToolOutcome) -> String {
        match outcome {
            NativeToolOutcome::Value { content, .. } | NativeToolOutcome::Error { content, .. } => {
                content.clone()
            }
            other => panic!("非预期结果：{other:?}"),
        }
    }

    fn ui_of(outcome: &NativeToolOutcome) -> Value {
        match outcome {
            NativeToolOutcome::Value { ui_data, .. } | NativeToolOutcome::Error { ui_data, .. } => {
                ui_data.clone().expect("应下发 uiData")
            }
            other => panic!("非预期结果：{other:?}"),
        }
    }

    #[tokio::test]
    async fn parses_a_csv_with_header_and_ui_data() {
        let dir = tmp_dir("csv");
        std::fs::write(dir.join("数据.csv"), "姓名,年龄\n张三,30\n").unwrap();

        let outcome = run(dir.to_str().unwrap(), json!({ "path": "数据.csv" })).await;
        let content = content_of(&outcome);
        assert!(content.contains("📄"), "头部要有路径：{content}");
        assert!(content.contains("🔢 csv"), "头部要标格式：{content}");
        assert!(content.contains("姓名,年龄"), "正文要在：{content}");
        assert!(matches!(outcome, NativeToolOutcome::Value { .. }));

        let ui = ui_of(&outcome);
        assert_eq!(ui.get("ok").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(ui.get("fileType").and_then(|v| v.as_str()), Some("csv"));
        assert_eq!(ui.get("charCount").and_then(|v| v.as_u64()), Some(12));
        assert_eq!(ui.get("truncated").and_then(|v| v.as_bool()), Some(false));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn truncation_points_at_the_next_offset() {
        let dir = tmp_dir("paging");
        std::fs::write(dir.join("long.txt"), "abcdefghij".repeat(10)).unwrap();

        let outcome = run(
            dir.to_str().unwrap(),
            json!({ "path": "long.txt", "max_chars": 25 }),
        )
        .await;
        let content = content_of(&outcome);
        assert!(content.contains("Use offset=25 to read more"), "{content}");
        let ui = ui_of(&outcome);
        assert_eq!(ui.get("truncated").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(ui.get("nextOffset").and_then(|v| v.as_u64()), Some(25));

        std::fs::remove_dir_all(&dir).ok();
    }

    /// 真实 `.doc`（OLE 容器）—— 正是 `read_file` 读不出来的场景
    #[tokio::test]
    async fn parses_a_legacy_doc_file() {
        let dir = tmp_dir("doc");
        let outcome = run(&dir.to_string_lossy(), json!({ "path": fixture("simple.doc") })).await;
        let content = content_of(&outcome);
        assert!(
            content.contains("This is a simple file created with Word 97"),
            "{content}"
        );
        assert!(content.contains("🔢 doc"), "头部要标格式：{content}");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// `.xlsx` 选表失败：失败要带上可用表名（模型据此改参数）
    #[tokio::test]
    async fn unknown_sheet_is_an_error_with_the_available_names() {
        let dir = tmp_dir("sheet");
        let outcome = run(
            &dir.to_string_lossy(),
            json!({ "path": fixture("SampleSS.xlsx"), "sheet": "Nope" }),
        )
        .await;
        assert!(matches!(outcome, NativeToolOutcome::Error { .. }));
        let content = content_of(&outcome);
        assert!(content.contains("not found"), "{content}");
        let ui = ui_of(&outcome);
        assert_eq!(
            ui.get("errorKind").and_then(|v| v.as_str()),
            Some("sheet_not_found")
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 多文件：逐份给结果，且单份失败不牵连另一份
    #[tokio::test]
    async fn batch_reports_every_file() {
        let dir = tmp_dir("batch");
        std::fs::write(dir.join("ok.csv"), "a,b\n").unwrap();

        let outcome = run(
            dir.to_str().unwrap(),
            json!({ "paths": ["ok.csv", fixture("simple.doc")] }),
        )
        .await;
        assert!(matches!(outcome, NativeToolOutcome::Value { .. }));
        let content = content_of(&outcome);
        assert!(content.contains("a,b"), "{content}");
        assert!(content.contains("Word 97"), "{content}");
        let ui = ui_of(&outcome);
        assert_eq!(
            ui.get("files").and_then(|v| v.as_array()).map(|a| a.len()),
            Some(2)
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 黑名单里的路径必须被拒（只读工具也不例外）—— 安全闸不给解析开后门
    #[tokio::test]
    async fn blacklisted_path_is_denied() {
        let dir = tmp_dir("denied");
        let secret = dir.join("secret.txt");
        std::fs::write(&secret, "top secret").unwrap();

        let mut sec = test_security(dir.to_str().unwrap());
        sec.blacklist = vec![secret.to_string_lossy().replace('\\', "/")];

        let outcome = call(sec, json!({ "path": secret.to_string_lossy() }))
            .await
            .unwrap();
        assert!(matches!(outcome, NativeToolOutcome::Error { .. }));
        assert!(
            !content_of(&outcome).contains("top secret"),
            "被拒的路径不能把内容带出来"
        );
        let ui = ui_of(&outcome);
        assert_eq!(ui.get("errorKind").and_then(|v| v.as_str()), Some("denied"));

        std::fs::remove_dir_all(&dir).ok();
    }

    /// 多文件里夹一份被拒的：顺序不丢、其余照常出结果
    #[tokio::test]
    async fn batch_keeps_denied_entries_in_place() {
        let dir = tmp_dir("denied_batch");
        std::fs::write(dir.join("ok.csv"), "a,b\n").unwrap();
        let secret = dir.join("secret.txt");
        std::fs::write(&secret, "top secret").unwrap();

        let mut sec = test_security(dir.to_str().unwrap());
        sec.blacklist = vec![secret.to_string_lossy().replace('\\', "/")];

        let outcome = call(
            sec,
            json!({ "paths": ["ok.csv", secret.to_string_lossy()] }),
        )
        .await
        .unwrap();
        assert!(matches!(outcome, NativeToolOutcome::Value { .. }));
        let content = content_of(&outcome);
        assert!(content.contains("a,b"), "{content}");
        assert!(content.contains("Failed to parse 1 file(s)"), "{content}");
        assert!(!content.contains("top secret"), "被拒的那份不能带出内容");

        let ui = ui_of(&outcome);
        let files = ui.get("files").and_then(|v| v.as_array()).unwrap();
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].get("ok").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(
            files[1].get("errorKind").and_then(|v| v.as_str()),
            Some("denied")
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn missing_parameters_are_protocol_errors() {
        let dir = tmp_dir("missing");
        let err = call(test_security(dir.to_str().unwrap()), json!({}))
            .await
            .unwrap_err();
        assert!(err.contains("Missing required parameter"), "{err}");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// GUI 命令走的入口（`ParseTarget::Path`，前端已做完安全校验）：单份时 `uiData` 是对象不是数组
    #[tokio::test]
    async fn parse_targets_returns_a_single_object_for_one_target() {
        let dir = tmp_dir("targets");
        let file = dir.join("a.csv");
        std::fs::write(&file, "x,y\n").unwrap();

        let targets = vec![ParseTarget::Path(file.to_string_lossy().replace('\\', "/"))];
        let agg = parse_targets(&targets, &ParseOptions::default(), None).await;
        assert!(!agg.failed);
        assert!(agg.content.contains("x,y"), "{}", agg.content);
        assert_eq!(agg.ui_data.get("ok").and_then(|v| v.as_bool()), Some(true));
        assert!(agg.ui_data.get("files").is_none());

        std::fs::remove_dir_all(&dir).ok();
    }

    /// `outTxtFile`：**全文**落盘（不受 `max_chars` / `offset` 影响），本次只回预览 + 头部提示行
    #[tokio::test]
    async fn out_txt_file_saves_the_full_text_and_only_previews() {
        let dir = tmp_dir("out");
        let full: String = (0..800).map(|i| format!("第{i}行\n")).collect();
        std::fs::write(dir.join("long.txt"), &full).unwrap();

        // 1) 没给 max_chars → 默认短预览（2000），不是常规的 12000
        let outcome = run(
            dir.to_str().unwrap(),
            json!({ "path": "long.txt", "outTxtFile": "dump/全文.txt" }),
        )
        .await;
        let content = content_of(&outcome);
        assert!(content.contains("💾 Full text saved to"), "{content}");
        assert!(
            content.contains("Use offset=2000 to read more"),
            "默认预览应为 2000 字：{content}"
        );

        let written = dir.join("dump").join("全文.txt");
        assert_eq!(
            std::fs::read_to_string(&written).unwrap(),
            full,
            "落盘必须是全文（父目录自动建）"
        );

        let ui = ui_of(&outcome);
        assert_eq!(ui.get("truncated").and_then(|v| v.as_bool()), Some(true));
        let out = ui.get("outTxtFile").expect("uiData 应带 outTxtFile");
        assert_eq!(out.get("ok").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(
            out.get("charCount").and_then(|v| v.as_u64()),
            Some(full.chars().count() as u64)
        );

        // 2) 显式 max_chars 以它为准
        let outcome = run(
            dir.to_str().unwrap(),
            json!({ "path": "long.txt", "outTxtFile": "dump/全文.txt", "max_chars": 50 }),
        )
        .await;
        assert!(
            content_of(&outcome).contains("Use offset=50 to read more"),
            "显式 max_chars 应压过默认预览"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// 工作目录外的 `outTxtFile` 必须被拒（写模式：白名单 + 工作目录），且失败要发生在解析之前
    #[tokio::test]
    async fn out_txt_file_outside_the_workspace_is_refused() {
        let dir = tmp_dir("out_denied");
        std::fs::write(dir.join("a.csv"), "a,b\n").unwrap();
        let outside = std::env::temp_dir().join(format!("virlen_out_{}.txt", uuid::Uuid::new_v4()));
        let outside_str = outside.to_string_lossy().replace('\\', "/");

        let err = call(
            test_security(dir.to_str().unwrap()),
            json!({ "path": "a.csv", "outTxtFile": outside_str }),
        )
        .await
        .unwrap_err();
        assert!(err.contains("outTxtFile"), "报错要点名参数：{err}");
        assert!(!outside.exists(), "被拒时不该写出文件");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// 多文件落盘：一个文件装下全部全文（入参顺序、`---` 分隔），解析结果照常逐份返回
    #[tokio::test]
    async fn batch_out_txt_file_joins_every_document() {
        let dir = tmp_dir("out_batch");
        std::fs::write(dir.join("a.txt"), "AAA\n").unwrap();
        std::fs::write(dir.join("b.txt"), "BBB\n").unwrap();

        let outcome = run(
            dir.to_str().unwrap(),
            json!({ "paths": ["a.txt", "b.txt"], "outTxtFile": "dump.txt" }),
        )
        .await;
        assert_eq!(
            std::fs::read_to_string(dir.join("dump.txt")).unwrap(),
            "AAA\n\n---\nBBB\n"
        );

        let ui = ui_of(&outcome);
        assert_eq!(
            ui.get("files").and_then(|v| v.as_array()).map(|a| a.len()),
            Some(2)
        );
        assert_eq!(
            ui.get("outTxtFile")
                .and_then(|v| v.get("ok"))
                .and_then(|v| v.as_bool()),
            Some(true)
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// 全部失败 → 一个字节也不落盘（不留空文件骗后来的自己），`uiData` 也不带 `outTxtFile`
    #[tokio::test]
    async fn out_txt_file_is_not_written_when_nothing_parsed() {
        let dir = tmp_dir("out_empty");
        std::fs::write(dir.join("a.png"), "not a document").unwrap();

        let outcome = run(
            dir.to_str().unwrap(),
            json!({ "path": "a.png", "outTxtFile": "dump.txt" }),
        )
        .await;
        assert!(matches!(outcome, NativeToolOutcome::Error { .. }));
        assert!(!dir.join("dump.txt").exists(), "全失败不该写出文件");
        assert!(ui_of(&outcome).get("outTxtFile").is_none());

        std::fs::remove_dir_all(&dir).ok();
    }
}
