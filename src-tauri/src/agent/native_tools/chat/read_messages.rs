//! `read_messages` 工具（原生）— 按消息 id + 相对窗口读取「已被上下文压缩掉」的历史消息正文
//!
//! 与 `list_messages` 同源（同一 `SessionRepo` 查询），只是定位方式不同：
//! 给定锚点（id 优先，可用 seq）与相对窗口 `[-10,0]` / `[0,10]` / `[-5,5]`，
//! 返回该窗口内各条消息的正文。
//!
//! 约束（需求硬性）：
//!   - 只覆盖「已压缩区间」；触及边界即停止，并提示后续内容已在上下文中；
//!   - 深度思考（reasoning）永不返回；
//!   - 工具调用只给「工具名 + 参数摘要」（≤100 字符，由 `session_db` 侧截断）；
//!   - 单条正文 ≤ 4000 字符、单次窗口 ≤ 21 条、单次输出 ≤ 30000 字符。
//!
//! ⚠️ 与 TS 侧 `src/infrastructure/tools/chat/read-messages.ts` **逐字对齐**（铁律 1）。

use super::common::{
    WINDOW_DEFAULT_SPAN, WINDOW_MAX_BACK, WINDOW_MAX_FWD, cap_output, consume_budget, format_window,
    number_of, to_positive_int, utf16_len,
};
use crate::agent::native_tools::{NativeToolCtx, NativeToolOutcome};
use serde_json::{Value, json};

/// 解析相对窗口 `[start, end]`（要求 `start <= 0 <= end`），并收敛到单侧上限。
/// 非法输入回退到默认 `[-5, 5]`。
fn parse_window(raw: Option<&Value>) -> (usize, usize) {
    if let Some(Value::Array(items)) = raw {
        if items.len() == 2 {
            let start = number_of(items.first());
            let end = number_of(items.get(1));
            if let (Some(s), Some(e)) = (start, end) {
                if s <= 0.0 && e >= 0.0 {
                    let before = ((-s).floor() as i64).min(WINDOW_MAX_BACK).max(0);
                    let after = (e.floor() as i64).min(WINDOW_MAX_FWD).max(0);
                    return (before as usize, after as usize);
                }
            }
        }
    }
    (WINDOW_DEFAULT_SPAN as usize, WINDOW_DEFAULT_SPAN as usize)
}

pub(crate) async fn read_messages_tool(
    ctx: &NativeToolCtx<'_>,
    args: &Value,
) -> Result<NativeToolOutcome, String> {
    let session_id = ctx.session_id;
    if session_id.is_empty() {
        return Ok(NativeToolOutcome::Value {
            content: "No active conversation is available.".to_string(),
            ui_data: None,
        });
    }

    let anchor_id = args
        .get("message_id")
        .and_then(Value::as_str)
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let anchor_seq = to_positive_int(args.get("seq"));
    let (before, after) = parse_window(args.get("window"));

    let started = crate::telemetry::now_ms();
    // 与 TS `try { sessionRepo.getMessageWindow(...) } catch { null }` 等价
    let window = if ctx.repo.is_available() {
        ctx.repo
            .get_message_window(session_id, anchor_id.as_deref(), anchor_seq, before, after)
            .await
            .ok()
    } else {
        None
    };

    let Some(win) = window else {
        crate::telemetry::track(
            "chat.messages.query",
            json!({
                "mode": "window",
                "status": "unavailable",
                "duration_ms": crate::telemetry::now_ms() - started,
            }),
        );
        return Ok(NativeToolOutcome::Value {
            content:
                "Message history is unavailable in this environment (local storage not accessible)."
                    .to_string(),
            ui_data: None,
        });
    };

    if win.total == 0 {
        return Ok(NativeToolOutcome::Value {
            content: "This conversation has no messages yet.".to_string(),
            ui_data: None,
        });
    }

    if win.boundary_seq.is_none() {
        crate::telemetry::track(
            "chat.messages.query",
            json!({
                "mode": "window",
                "status": "not_compressed",
                "duration_ms": crate::telemetry::now_ms() - started,
            }),
        );
        return Ok(NativeToolOutcome::Value {
            content: "This conversation has not been compressed yet, so the full history is already in your current context. There is nothing to read here.".to_string(),
            ui_data: Some(json!({
                "mode": "window",
                "status": "not_compressed",
                "total": win.total,
            })),
        });
    }

    if !win.anchor_found {
        // `anchorId ?? anchorSeq`（两者都没有时 JS 模板会打印 "undefined"）
        let shown = anchor_id
            .clone()
            .or_else(|| anchor_seq.map(|s| s.to_string()))
            .unwrap_or_else(|| "undefined".to_string());
        return Ok(NativeToolOutcome::Value {
            content: format!(
                "Message \"{}\" was not found in this conversation. It may have been deleted. Use list_messages to get valid message IDs.",
                shown
            ),
            ui_data: Some(json!({
                "mode": "window",
                "status": "not_found",
                "total": win.total,
            })),
        });
    }

    if win.messages.is_empty() {
        // 锚点落在「已在上下文」的区间（压缩摘要及其之后）
        let boundary = win.boundary_seq.unwrap_or(0);
        return Ok(NativeToolOutcome::Value {
            content: format!(
                "#{} and everything after it are already in your current context — no need to read them. The readable (compressed) range is #1..#{}.",
                win.anchor_seq,
                boundary - 1
            ),
            ui_data: Some(json!({
                "mode": "window",
                "status": "in_context",
                "anchorSeq": win.anchor_seq,
                "boundarySeq": win.boundary_seq,
                "total": win.total,
            })),
        });
    }

    let (text, truncated) = cap_output(format_window(&win));
    if !consume_budget(session_id, utf16_len(&text)) {
        crate::telemetry::track(
            "chat.messages.query",
            json!({
                "mode": "window",
                "status": "budget_exceeded",
                "msg_count": win.messages.len(),
                "duration_ms": crate::telemetry::now_ms() - started,
            }),
        );
        return Ok(NativeToolOutcome::Value {
            content: "[Message-query budget exceeded. Stop querying history and answer with the information you already have.]".to_string(),
            ui_data: None,
        });
    }

    crate::telemetry::track(
        "chat.messages.query",
        json!({
            "mode": "window",
            "status": "success",
            "msg_count": win.messages.len(),
            "chars": utf16_len(&text),
            "truncated": truncated,
            "clamped_by_boundary": win.clamped_by_boundary,
            "duration_ms": crate::telemetry::now_ms() - started,
            "session_id": crate::telemetry::hash_id(session_id),
        }),
    );

    let messages = serde_json::to_value(&win.messages).unwrap_or_else(|_| Value::Array(Vec::new()));
    Ok(NativeToolOutcome::Value {
        content: text,
        ui_data: Some(json!({
            "mode": "window",
            "status": "success",
            "total": win.total,
            "anchorSeq": win.anchor_seq,
            "startSeq": win.start_seq,
            "endSeq": win.end_seq,
            "boundarySeq": win.boundary_seq,
            "clampedByBoundary": win.clamped_by_boundary,
            "messages": messages,
        })),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::bridge::AgentBridgeState;
    use crate::agent::cancellation::CancellationToken;
    use crate::agent::event_sink::TestEventSink;
    use crate::agent::native_tools::execute_native_tool;
    use crate::agent::native_tools::test_util::test_security_bare;
    use crate::agent::types::Message;
    use crate::session_db::SessionRepo;
    use crate::session_db::tests::{open_tmp, test_message, test_session};

    const SESSION: &str = "s1";

    async fn run(repo: &dyn SessionRepo, args: Value) -> NativeToolOutcome {
        let sec = test_security_bare("/tmp/virlen_ws");
        let sink = TestEventSink::new();
        let bridge = AgentBridgeState::default();
        let cancel = CancellationToken::new();
        let ctx = NativeToolCtx {
            session_id: SESSION,
            tool_call_id: "tc_read",
            cancel: &cancel,
            sink: &sink,
            bridge: &bridge,
            security: &sec,
            repo,
            skills: None,
            host: crate::host::default_host().as_ref(),
            settings: crate::agent::native_tools::noop_settings(),
        };
        execute_native_tool(&ctx, "read_messages", &args)
            .await
            .expect("read_messages 不应返回 Err")
    }

    fn content_of(outcome: &NativeToolOutcome) -> String {
        match outcome {
            NativeToolOutcome::Value { content, .. } => content.clone(),
            other => panic!("unexpected outcome: {other:?}"),
        }
    }

    fn ui_of(outcome: &NativeToolOutcome) -> Value {
        match outcome {
            NativeToolOutcome::Value { ui_data, .. } => ui_data.clone().unwrap_or(Value::Null),
            other => panic!("unexpected outcome: {other:?}"),
        }
    }

    /// 5 条用户消息 + summary（时序 6）→ 可查询区间 #1..#5
    async fn seed(repo: &dyn SessionRepo) {
        repo.upsert_session(&test_session(SESSION, "t", 100))
            .await
            .unwrap();
        let msgs: Vec<Message> = (1..=5)
            .map(|i| {
                let mut m = test_message(&format!("m{}", i), "user");
                m.content = json!(format!("消息 {}", i));
                m
            })
            .collect();
        repo.append_messages(SESSION, &msgs).await.unwrap();
        let mut s = test_message("sum", "summary");
        s.content = json!("[summary]");
        repo.append_messages(SESSION, &[s]).await.unwrap();
    }

    #[tokio::test]
    async fn unavailable_without_local_storage() {
        let outcome = run(crate::agent::native_tools::noop_repo(), json!({})).await;
        assert_eq!(
            content_of(&outcome),
            "Message history is unavailable in this environment (local storage not accessible)."
        );
    }

    #[tokio::test]
    async fn reads_window_around_anchor() {
        let repo = open_tmp();
        seed(&repo).await;
        let outcome = run(&repo, json!({ "message_id": "m3", "window": [-1, 1] })).await;

        let text = content_of(&outcome);
        assert!(text.starts_with("Window #2..#4 around anchor #3 (conversation total: 6)."));
        assert!(text.contains("消息 2") && text.contains("消息 4"));
        assert!(!text.contains("消息 5"), "窗口外的消息不得返回");

        let ui = ui_of(&outcome);
        assert_eq!(ui["mode"], "window");
        assert_eq!(ui["status"], "success");
        assert_eq!(ui["anchorSeq"], 3);
        assert_eq!(ui["boundarySeq"], 6);
        assert_eq!(ui["clampedByBoundary"], false);
        assert_eq!(ui["messages"].as_array().unwrap().len(), 3);
    }

    /// 锚点落在「已在上下文」区间（summary 自身）→ 不返回任何正文，提示可读区间
    #[tokio::test]
    async fn anchor_in_context_region() {
        let repo = open_tmp();
        seed(&repo).await;
        let outcome = run(&repo, json!({ "message_id": "sum" })).await;

        assert_eq!(
            content_of(&outcome),
            "#6 and everything after it are already in your current context — no need to read them. The readable (compressed) range is #1..#5."
        );
        assert_eq!(ui_of(&outcome)["status"], "in_context");
        assert_eq!(ui_of(&outcome)["anchorSeq"], 6);
    }

    #[tokio::test]
    async fn anchor_not_found() {
        let repo = open_tmp();
        seed(&repo).await;
        let outcome = run(&repo, json!({ "message_id": "nope" })).await;
        assert_eq!(
            content_of(&outcome),
            "Message \"nope\" was not found in this conversation. It may have been deleted. Use list_messages to get valid message IDs."
        );
        assert_eq!(ui_of(&outcome)["status"], "not_found");
    }

    #[tokio::test]
    async fn not_compressed_and_empty_guards() {
        let repo = open_tmp();
        repo.upsert_session(&test_session(SESSION, "t", 100))
            .await
            .unwrap();
        let outcome = run(&repo, json!({ "message_id": "m1" })).await;
        assert_eq!(content_of(&outcome), "This conversation has no messages yet.");

        let mut m = test_message("m1", "user");
        m.content = json!("你好");
        repo.append_messages(SESSION, &[m]).await.unwrap();
        let outcome = run(&repo, json!({ "seq": 1 })).await;
        assert!(content_of(&outcome).starts_with("This conversation has not been compressed yet"));
        assert_eq!(ui_of(&outcome)["status"], "not_compressed");
    }

    /// 窗口解析：非法 / 缺省 → 默认 `[-5,5]`；单侧超限 → 收敛到 20
    #[test]
    fn window_parsing() {
        assert_eq!(parse_window(None), (5, 5));
        assert_eq!(parse_window(Some(&json!([0, 10]))), (0, 10));
        assert_eq!(parse_window(Some(&json!([-100, 100]))), (20, 20));
        // 非法（start > 0 / 长度不对 / 非数字）→ 默认
        assert_eq!(parse_window(Some(&json!([1, 5]))), (5, 5));
        assert_eq!(parse_window(Some(&json!([0]))), (5, 5));
        assert_eq!(parse_window(Some(&json!(["a", "b"]))), (5, 5));
    }
}
