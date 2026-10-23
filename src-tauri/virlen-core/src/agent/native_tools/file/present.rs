//! `present` 工具（原生）— 把**已存在的文件**声明为交付物：右侧面板按标签页打开，不复制内容。
//!
//! 四条口径：
//! 1. **只声明、不产出**：路径必须已经存在且是文件。不存在 / 是目录 / 被安全规则挡下的一律记进
//!    `skipped` 并写进 content —— 绝不为它开一个打不开的标签（UI 只打开 `files` 里那些）；
//! 2. **类型必须能在右侧面板预览**（见 `preview_ext.rs`）：不可预览的类型（ODF / 压缩包 /
//!    可执行文件 …）同样只进 `skipped` —— 面板对它只会显示「暂不支持预览 → 在系统程序中打开」，
//!    那不叫「交付物」，所以宁可报错也不开标签；
//! 3. **权限判定与其它文件工具同源**（`resolve_safe_path(.., "r", ..)`）：本工具不写盘，
//!    所以只要读得到就不该拒；唯一副作用在 UI（打开标签），由前端按 `uiData.type = "present"` 触发；
//! 4. **模型侧固定英文 + `uiData` 给 UI**（D2 语义，与其余工具一致）。

use crate::agent::native_tools::common::{arg_str, arg_str_array, resolve_safe_path};
use crate::agent::native_tools::{NativeToolCtx, NativeToolOutcome};
use serde_json::{json, Value};

use super::common::format_size;
use super::preview_ext::is_previewable;

/// 一次最多声明几个文件：右侧面板是标签页，几十个标签既没人看、打开也慢
const MAX_FILES: usize = 10;

/// 路径末段（Windows / POSIX 分隔符都认）
fn file_name_of(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    normalized
        .rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or(normalized.as_str())
        .to_string()
}

/// `path` / `paths` 合成一份请求列表（`path` 在前，与 read_file / parse_document 同口径）
fn requested_paths(args: &Value) -> Vec<String> {
    let mut requested: Vec<String> = arg_str(args, "path").into_iter().collect();
    requested.extend(arg_str_array(args, "paths"));
    requested.retain(|p| !p.trim().is_empty());
    requested
}

/// `skipped` 每条都长这样；拼模型侧正文与 uiData 共用一份口径
fn skip_entry(path: &str, reason: impl Into<String>) -> Value {
    json!({ "path": path, "reason": reason.into() })
}

fn skip_line(entry: &Value) -> String {
    format!(
        "- {} — {}",
        entry.get("path").and_then(|v| v.as_str()).unwrap_or(""),
        entry.get("reason").and_then(|v| v.as_str()).unwrap_or("")
    )
}

pub(crate) async fn present_tool(
    ctx: &NativeToolCtx<'_>,
    args: &Value,
) -> Result<NativeToolOutcome, String> {
    let requested = requested_paths(args);
    if requested.is_empty() {
        return Ok(NativeToolOutcome::error(
            "Error: \"path\" or \"paths\" is required — pass the file(s) to present.",
        ));
    }

    let mut files: Vec<Value> = Vec::new();
    let mut skipped: Vec<Value> = Vec::new();
    // 已经收下的绝对路径：同一个文件只开一个标签（标签 id 就是路径），重复声明是模型的小失误
    let mut accepted: Vec<String> = Vec::new();

    for input in requested {
        if files.len() >= MAX_FILES {
            skipped.push(skip_entry(
                &input,
                format!("at most {} files per call", MAX_FILES),
            ));
            continue;
        }

        let full_path = match resolve_safe_path(&input, "r", ctx.security) {
            Ok(p) => p,
            Err(reason) => {
                skipped.push(skip_entry(&input, reason));
                continue;
            }
        };
        if accepted.contains(&full_path) {
            continue;
        }

        let metadata = match std::fs::metadata(&full_path) {
            Ok(m) => m,
            Err(_) => {
                skipped.push(skip_entry(&full_path, "file does not exist"));
                continue;
            }
        };
        if metadata.is_dir() {
            skipped.push(skip_entry(
                &full_path,
                "is a directory; present a file instead",
            ));
            continue;
        }
        // 面板预览不了的类型：开标签只会让用户看到「暂不支持预览 / 在系统程序中打开」，
        // 那不是交付物 —— 如实报错，让模型换成受支持的格式再交
        if !is_previewable(&full_path) {
            let ext = crate::doc_parse::extension_of(&full_path);
            skipped.push(skip_entry(
                &full_path,
                format!(
                    "file type .{ext} cannot be previewed in the side panel; export it to a supported format first"
                ),
            ));
            continue;
        }

        accepted.push(full_path.clone());
        files.push(json!({
            "path": full_path,
            "name": file_name_of(&full_path),
            "sizeBytes": metadata.len(),
        }));
    }

    // 全被跳过 → 当成失败（is_error）：否则模型会以为「已经给用户了」，用户那边什么都没开
    if files.is_empty() {
        let detail = skipped.iter().map(skip_line).collect::<Vec<_>>().join("\n");
        return Ok(NativeToolOutcome::error(format!(
            "Error: no file was presented; nothing was opened in the side panel.\n{}",
            detail
        )));
    }

    let mut lines = vec![format!(
        "Presented {} file(s) to the user as deliverables (opened in the side panel on desktop; contents are not copied):",
        files.len()
    )];
    for file in &files {
        let path = file.get("path").and_then(|v| v.as_str()).unwrap_or("");
        let size = file.get("sizeBytes").and_then(|v| v.as_u64()).unwrap_or(0);
        lines.push(format!("- {} ({})", path, format_size(size as usize)));
    }
    if !skipped.is_empty() {
        lines.push(String::new());
        lines.push(format!("Skipped {} path(s):", skipped.len()));
        lines.extend(skipped.iter().map(skip_line));
    }

    Ok(NativeToolOutcome::Value {
        content: lines.join("\n"),
        // `type = "present"`：前端（事件处理器 / 工具卡片）据此认出「这些文件要上右侧面板」，
        // 与 `todo` 的 uiData.type 同一套约定
        ui_data: Some(json!({
            "type": "present",
            "files": files,
            "skipped": skipped,
        })),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::bridge::AgentBridgeState;
    use crate::agent::cancellation::CancellationToken;
    use crate::agent::event_sink::TestEventSink;
    use crate::agent::native_tools::test_util::test_security;
    use crate::agent::native_tools::{noop_memory, noop_repo, noop_settings};

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "virlen_present_{}_{}",
            tag,
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    async fn run(dir: &std::path::Path, args: Value) -> NativeToolOutcome {
        let sec = test_security(&dir.to_string_lossy());
        let sink = TestEventSink::new();
        let bridge = AgentBridgeState::default();
        let cancel = CancellationToken::new();
        let ctx = NativeToolCtx {
            session_id: "s_present",
            tool_call_id: "tc_present",
            cancel: &cancel,
            sink: &sink,
            bridge: &bridge,
            security: &sec,
            repo: noop_repo(),
            memory: noop_memory(),
            skills: None,
            host: crate::host::default_host().as_ref(),
            settings: noop_settings(),
        };
        present_tool(&ctx, &args).await.unwrap()
    }

    #[tokio::test]
    async fn presents_existing_files_and_skips_the_rest() {
        let dir = temp_dir("ok");
        std::fs::write(dir.join("报表.xlsx"), "x").unwrap();

        // 相对路径按工作目录展开；不存在的 / 目录 / 同一个文件重复声明
        let outcome = run(
            &dir,
            json!({ "paths": ["报表.xlsx", "missing.pdf", ".", "报表.xlsx"] }),
        )
        .await;

        match outcome {
            NativeToolOutcome::Value { content, ui_data } => {
                assert!(content.contains("Presented 1 file(s)"), "content: {content}");
                assert!(content.contains("Skipped 2 path(s)"), "content: {content}");
                let ui = ui_data.expect("应下发 uiData");
                assert_eq!(ui.get("type").and_then(|v| v.as_str()), Some("present"));
                let files = ui.get("files").and_then(|v| v.as_array()).unwrap();
                assert_eq!(files.len(), 1, "同一个文件只开一个标签: {ui}");
                assert_eq!(
                    files[0].get("name").and_then(|v| v.as_str()),
                    Some("报表.xlsx")
                );
                assert_eq!(files[0].get("sizeBytes").and_then(|v| v.as_u64()), Some(1));
                assert_eq!(
                    ui.get("skipped").and_then(|v| v.as_array()).map(|a| a.len()),
                    Some(2)
                );
            }
            other => panic!("expected Value, got {other:?}"),
        }

        std::fs::remove_dir_all(&dir).ok();
    }

    /// 一个都不成立 → 失败（`is_error`），否则模型会以为已经交给用户了
    #[tokio::test]
    async fn nothing_presentable_is_an_error() {
        let dir = temp_dir("empty");
        let outcome = run(&dir, json!({ "path": "missing.docx" })).await;
        match outcome {
            NativeToolOutcome::Error { content, ui_data } => {
                assert!(
                    content.contains("no file was presented"),
                    "content: {content}"
                );
                assert!(content.contains("file does not exist"), "content: {content}");
                assert!(ui_data.is_none());
            }
            other => panic!("expected Error, got {other:?}"),
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 面板预览不了的类型：只进 skipped（带明确原因），绝不打开一个「暂不支持预览」的标签
    #[tokio::test]
    async fn unsupported_type_is_skipped() {
        let dir = temp_dir("type");
        std::fs::write(dir.join("表.ods"), "x").unwrap();
        std::fs::write(dir.join("报表.xlsx"), "x").unwrap();

        let outcome = run(&dir, json!({ "paths": ["表.ods", "报表.xlsx"] })).await;
        match outcome {
            NativeToolOutcome::Value { content, ui_data } => {
                let ui = ui_data.expect("应下发 uiData");
                let files = ui.get("files").and_then(|v| v.as_array()).unwrap();
                assert_eq!(files.len(), 1, "只应打开 xlsx: {ui}");
                assert_eq!(
                    files[0].get("name").and_then(|v| v.as_str()),
                    Some("报表.xlsx")
                );
                let skipped = ui.get("skipped").and_then(|v| v.as_array()).unwrap();
                assert_eq!(skipped.len(), 1, "ods 应被跳过: {ui}");
                let reason = skipped[0]
                    .get("reason")
                    .and_then(|v| v.as_str())
                    .unwrap();
                assert!(
                    reason.contains("file type .ods cannot be previewed in the side panel"),
                    "reason: {reason}"
                );
                assert!(content.contains("Skipped 1 path(s)"), "content: {content}");
                assert!(content.contains("cannot be previewed"), "content: {content}");
            }
            other => panic!("expected Value, got {other:?}"),
        }

        std::fs::remove_dir_all(&dir).ok();
    }

    /// 全部都是不可预览的类型 → 失败（与「一个都不成立」同一口径）
    #[tokio::test]
    async fn only_unsupported_types_is_an_error() {
        let dir = temp_dir("type_only");
        std::fs::write(dir.join("表.ods"), "x").unwrap();

        let outcome = run(&dir, json!({ "path": "表.ods" })).await;
        match outcome {
            NativeToolOutcome::Error { content, .. } => {
                assert!(content.contains("no file was presented"), "content: {content}");
                assert!(content.contains("cannot be previewed"), "content: {content}");
            }
            other => panic!("expected Error, got {other:?}"),
        }

        std::fs::remove_dir_all(&dir).ok();
    }

    /// 缺参：给模型一句能照着改的英文，不要静默成功
    #[tokio::test]
    async fn missing_parameters_is_an_error() {
        let dir = temp_dir("noparam");
        let outcome = run(&dir, json!({})).await;
        assert!(matches!(outcome, NativeToolOutcome::Error { .. }));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 分发也要通：契约里有定义、`is_native_tool` 有名字，但 `execute_native_tool` 漏了分支时，
    /// 模型能看见却调不动（运行期才报 not implemented）—— 这里把它提前到单测。
    #[tokio::test]
    async fn dispatcher_routes_present() {
        let dir = temp_dir("dispatch");
        std::fs::write(dir.join("out.txt"), "x").unwrap();

        let sec = test_security(&dir.to_string_lossy());
        let sink = TestEventSink::new();
        let bridge = AgentBridgeState::default();
        let cancel = CancellationToken::new();
        let ctx = NativeToolCtx {
            session_id: "s_present",
            tool_call_id: "tc_present",
            cancel: &cancel,
            sink: &sink,
            bridge: &bridge,
            security: &sec,
            repo: noop_repo(),
            memory: noop_memory(),
            skills: None,
            host: crate::host::default_host().as_ref(),
            settings: noop_settings(),
        };

        let outcome = crate::agent::native_tools::execute_native_tool(
            &ctx,
            "present",
            &json!({ "path": "out.txt" }),
        )
        .await
        .expect("原生分发不应报错");
        match outcome {
            NativeToolOutcome::Value { ui_data, .. } => {
                let ui = ui_data.expect("应下发 uiData");
                assert_eq!(ui.get("type").and_then(|v| v.as_str()), Some("present"));
            }
            other => panic!("expected Value, got {other:?}"),
        }

        std::fs::remove_dir_all(&dir).ok();
    }

    /// 黑名单命中的路径不能开标签（安全红线：读都读不到的文件不该被「声明为交付物」）
    #[tokio::test]
    async fn blocked_path_is_skipped() {
        let dir = temp_dir("blocked");
        let secret = dir.join("secret.txt");
        std::fs::write(&secret, "x").unwrap();

        let mut sec = test_security(&dir.to_string_lossy());
        sec.blacklist = vec![secret.to_string_lossy().replace('\\', "/")];
        let sink = TestEventSink::new();
        let bridge = AgentBridgeState::default();
        let cancel = CancellationToken::new();
        let ctx = NativeToolCtx {
            session_id: "s_present",
            tool_call_id: "tc_present",
            cancel: &cancel,
            sink: &sink,
            bridge: &bridge,
            security: &sec,
            repo: noop_repo(),
            memory: noop_memory(),
            skills: None,
            host: crate::host::default_host().as_ref(),
            settings: noop_settings(),
        };

        let outcome = present_tool(&ctx, &json!({ "path": "secret.txt" }))
            .await
            .unwrap();
        match outcome {
            NativeToolOutcome::Error { content, .. } => {
                assert!(content.contains("blacklist"), "content: {content}");
            }
            other => panic!("expected Error, got {other:?}"),
        }

        std::fs::remove_dir_all(&dir).ok();
    }
}
