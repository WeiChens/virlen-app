//! `parse_document` 的用例：真实文档（`.doc` / `.xlsx` / `.csv`）、分页、批量、黑名单拒收、
//! `outTxtFile` 落盘、OCR 三态与取消。
//!
//! 这里只放「不需要真模型」的分支；真跑推理的用例在 `doc_parse::ocr` 的 `#[ignore]` 里。

use super::*;
use crate::agent::bridge::AgentBridgeState;
use crate::agent::cancellation::CancellationToken;
use crate::agent::event_sink::TestEventSink;
use crate::agent::native_tools::noop_repo;
use crate::agent::native_tools::test_util::test_security;
use crate::agent::types::NativeToolSecurity;
use crate::doc_parse::OcrSection;

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
    call_with_cancel(sec, args, &CancellationToken::new()).await
}

/// 同上，但用调用方给的令牌（取消行为要被测到）
async fn call_with_cancel(
    sec: NativeToolSecurity,
    args: Value,
    cancel: &CancellationToken,
) -> Result<NativeToolOutcome, String> {
    let sink = TestEventSink::new();
    let bridge = AgentBridgeState::default();
    let ctx = NativeToolCtx {
        session_id: "s_parse",
        tool_call_id: "tc_parse",
        cancel,
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
    let agg = parse_targets(&targets, &ParseOptions::default(), None, None).await;
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

// ═════════════════════════════════════════════════════════════════════════
// OCR（扫描件）：不需要真模型的那些分支（真跑推理的用例见 ocr.rs 的 `#[ignore]` 用例）
// ═════════════════════════════════════════════════════════════════════════

/// 一个「没有资源目录」的宿主：模型必然找不到 → OCR 分支可确定地测（不依赖开发机上的模型）
struct EmptyHost {
    dir: std::path::PathBuf,
}
impl crate::agent::host::HostEnv for EmptyHost {
    fn resource_candidates(&self) -> Vec<std::path::PathBuf> {
        vec![self.dir.join("no-such-resources")]
    }
    fn data_dir(&self) -> std::path::PathBuf {
        self.dir.clone()
    }
}

/// 与 [`call`] 相同，但用指定宿主（OCR 的模型定位走宿主，见 [`ocr_options`]）
async fn call_with_host(
    host: &dyn crate::agent::host::HostEnv,
    sec: NativeToolSecurity,
    args: Value,
) -> Result<NativeToolOutcome, String> {
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
        host,
        settings: crate::agent::native_tools::noop_settings(),
        memory: crate::agent::native_tools::noop_memory(),
    };
    parse_document_tool(&ctx, &args).await
}

/// 一份没有文字层的「扫描件」PDF（图是纯灰块，真 OCR 也读不出字）
fn scanned_pdf_file(dir: &std::path::Path) -> String {
    let bytes = crate::doc_parse::test_pdf::scanned_pdf(1, 200);
    let file = dir.join("scan.pdf");
    std::fs::write(&file, bytes).unwrap();
    "scan.pdf".to_string()
}

/// 没传 `ocrImages` = **自动兜底**：扫描件会去跑 OCR；这里宿主没有模型目录，故如实报「不可用」
#[tokio::test]
async fn a_scanned_pdf_triggers_the_oc_fallback_and_reports_missing_models() {
    let dir = tmp_dir("ocr_auto");
    let path = scanned_pdf_file(&dir);
    let host = EmptyHost { dir: dir.clone() };

    let outcome = call_with_host(
        &host,
        test_security(dir.to_str().unwrap()),
        json!({ "path": path }),
    )
    .await
    .expect("工具不应返回协议级错误");
    assert!(matches!(outcome, NativeToolOutcome::Error { .. }));
    let content = content_of(&outcome);
    assert!(
        content.contains("on-device OCR is unavailable: quasivision models directory not found"),
        "{content}"
    );

    std::fs::remove_dir_all(&dir).ok();
}

/// `ocrImages: false` = 显式关掉兜底：OCR 一步也不跑，直接报「没有文字」并指出开关在哪
#[tokio::test]
async fn ocr_images_false_turns_the_fallback_off() {
    let dir = tmp_dir("ocr_false");
    let path = scanned_pdf_file(&dir);
    let host = EmptyHost { dir: dir.clone() };

    let outcome = call_with_host(
        &host,
        test_security(dir.to_str().unwrap()),
        json!({ "path": path, "ocrImages": false }),
    )
    .await
    .expect("工具不应返回协议级错误");
    assert!(matches!(outcome, NativeToolOutcome::Error { .. }));
    let content = content_of(&outcome);
    assert!(content.contains("No text could be extracted"), "{content}");
    assert!(content.contains("pass ocrImages: true"), "要给出下一步动作：{content}");
    assert_eq!(
        ui_of(&outcome).get("errorKind").and_then(|v| v.as_str()),
        Some("no_text")
    );

    std::fs::remove_dir_all(&dir).ok();
}

/// 模型不在（这里直接把原因喂给解析链）：报「OCR 不可用 + 原因」，不冒充「图里没字」
#[tokio::test]
async fn unavailable_ocr_is_reported_with_its_reason() {
    let dir = tmp_dir("ocr_nomodels");
    let file = dir.join("scan.pdf");
    std::fs::write(&file, crate::doc_parse::test_pdf::scanned_pdf(1, 200)).unwrap();

    let opts = ParseOptions {
        ocr: Some(OcrOptions {
            models_dir: Err("quasivision models directory not found".to_string()),
            always: true,
            cancel: None,
        }),
        ..Default::default()
    };
    let targets = vec![ParseTarget::Path(file.to_string_lossy().replace('\\', "/"))];
    let agg = parse_targets(&targets, &opts, None, None).await;

    assert!(agg.failed);
    assert!(
        agg.content.contains("on-device OCR is unavailable: quasivision models directory not found"),
        "{}",
        agg.content
    );
    assert_eq!(
        agg.ui_data.get("errorKind").and_then(|v| v.as_str()),
        Some("no_text")
    );

    std::fs::remove_dir_all(&dir).ok();
}

/// OCR 走通时两侧的呈现：模型侧头部加 `ocr: N image(s)`，界面侧 `uiData.ocr` 结构化
#[test]
fn ocr_facts_reach_both_the_model_text_and_the_ui_data() {
    let summary = OcrSummary {
        available: true,
        images: 2,
        chars: 42,
        skipped: 1,
        total: 3,
        sections: vec![OcrSection {
            index: 1,
            place: "pages 3, 4".to_string(),
            width: 1240,
            height: 1754,
            object_id: Some(27),
            chars: 40,
            text: "…".to_string(),
        }],
        ..Default::default()
    };
    let doc = DocText {
        kind: "pdf".to_string(),
        text: "[OCR] Image 1 · pages 3, 4 · 1240×1754".to_string(),
        char_count: 40,
        truncated: false,
        next_offset: None,
        sheets: Vec::new(),
        sheet: None,
        note: Some("no text layer — …".to_string()),
        full_text: None,
        ocr: Some(summary),
    };
    let opts = ParseOptions::default();

    let rendered = render_block("C:/ws/scan.pdf", 1024, &opts, &doc);
    assert!(rendered.contains("🔢 pdf · 1.0 KB · 40 chars · ocr: 2 image(s)"), "{rendered}");
    assert!(rendered.contains("💡 no text layer"), "{rendered}");

    let ui = ui_data("C:/ws/scan.pdf", 1024, &opts, &doc);
    assert_eq!(ui.pointer("/ocr/images"), Some(&json!(2)));
    assert_eq!(ui.pointer("/ocr/available"), Some(&json!(true)));
    assert_eq!(ui.pointer("/ocr/sections/0/index"), Some(&json!(1)));
    assert_eq!(ui.pointer("/ocr/sections/0/objectId"), Some(&json!(27)));
    assert_eq!(
        ui.pointer("/ocr/sections/0/place"),
        Some(&json!("pages 3, 4"))
    );
    assert_eq!(ui.pointer("/ocr/skipped"), Some(&json!(1)));
}

/// 取消预检：已取消时不解析，直接回取消口径（与 `web_fetch` / `vision_analyze` 同形）
#[tokio::test]
async fn cancelled_before_start_returns_cancel_text() {
    let dir = tmp_dir("cancelled");
    std::fs::write(dir.join("数据.csv"), "姓名,年龄\n张三,30\n").unwrap();
    let sec = test_security(dir.to_str().unwrap());
    let cancel = CancellationToken::new();
    cancel.cancel();

    let outcome = call_with_cancel(sec, json!({ "path": "数据.csv" }), &cancel)
        .await
        .expect("取消不是协议级错误");
    match outcome {
        NativeToolOutcome::Error { content, .. } => {
            assert!(
                content.starts_with("parse_document was cancelled:"),
                "content: {content}"
            );
            assert!(!content.contains("姓名"), "取消时不该带回正文：{content}");
        }
        other => panic!("expected Error, got {other:?}"),
    }
    std::fs::remove_dir_all(&dir).ok();
}