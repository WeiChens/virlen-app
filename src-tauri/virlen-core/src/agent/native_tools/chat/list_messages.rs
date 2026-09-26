//! `list_messages` 工具（原生）— 列出「已被上下文压缩掉」的历史消息时序
//!
//! 只覆盖「已压缩区间」（时序 < 最后一个 summary）：该区间之后的对话已在模型当前上下文中，重复下发只会
//! 浪费 token —— 因此这里不返回当下可见的消息。AI 用它拿到时序 + 消息 id（或按关键词定位），再用
//! `read_messages` 读取正文。
//!
//! ⚠️ 与 TS 侧 `src/infrastructure/tools/chat/list-messages.ts` 逐字对齐（铁律 1）。查询直接走
//! `SessionRepo`（SQLite），无 JS 桥往返；`repo.is_available() == false`（`NoopSessionRepo`，即没有本地
//! 存储）时回与 JS 路径一致的「不可用」文案。

use super::common::{
    LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT, cap_output, consume_budget, format_timeline,
    to_positive_int, utf16_len,
};
use crate::agent::native_tools::{NativeToolCtx, NativeToolOutcome};
use serde_json::{Value, json};

/// `limit` 收敛到 `[1, LIST_MAX_LIMIT]`
fn clamp_limit(raw: Option<&Value>) -> usize {
    match super::common::number_of(raw) {
        Some(n) => (n.floor().max(1.0).min(LIST_MAX_LIMIT as f64)) as usize,
        None => LIST_DEFAULT_LIMIT,
    }
}

pub(crate) async fn list_messages_tool(
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

    let keyword = args
        .get("keyword")
        .and_then(Value::as_str)
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let cursor = to_positive_int(args.get("cursor"));
    let limit = clamp_limit(args.get("limit"));

    let started = crate::telemetry::now_ms();
    // 与 TS `try { sessionRepo.getMessageTimeline(...) } catch { null }` 等价：
    // 无本地存储（Noop）或查询报错 → 一律按「不可用」处理
    let page = if ctx.repo.is_available() {
        ctx.repo
            .get_message_timeline(session_id, keyword.as_deref(), cursor, limit)
            .await
            .ok()
    } else {
        None
    };

    let Some(page) = page else {
        crate::telemetry::track(
            "chat.messages.query",
            json!({
                "mode": "list",
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

    if page.total == 0 {
        return Ok(NativeToolOutcome::Value {
            content: "This conversation has no messages yet.".to_string(),
            ui_data: None,
        });
    }

    if page.boundary_seq.is_none() {
        // 会话从未压缩 → 全部对话都在模型上下文里，没有「被压缩掉」的历史
        crate::telemetry::track(
            "chat.messages.query",
            json!({
                "mode": "list",
                "status": "not_compressed",
                "duration_ms": crate::telemetry::now_ms() - started,
            }),
        );
        return Ok(NativeToolOutcome::Value {
            content: "This conversation has not been compressed yet, so the full history is already in your current context. There is nothing to look up here.".to_string(),
            ui_data: Some(json!({
                "mode": "list",
                "status": "not_compressed",
                "total": page.total,
            })),
        });
    }

    if page.items.is_empty() {
        let queryable = page.boundary_seq.unwrap_or(0) - 1;
        let content = match &keyword {
            Some(kw) => format!(
                "No queryable message matches \"{}\". Queryable range: #1..#{}.",
                kw, queryable
            ),
            None => "No more older messages in the queryable range.".to_string(),
        };
        return Ok(NativeToolOutcome::Value {
            content,
            ui_data: Some(json!({
                "mode": "list",
                "status": "empty",
                "total": page.total,
            })),
        });
    }

    let (text, truncated) = cap_output(format_timeline(&page));
    if !consume_budget(session_id, utf16_len(&text)) {
        crate::telemetry::track(
            "chat.messages.query",
            json!({
                "mode": "list",
                "status": "budget_exceeded",
                "msg_count": page.items.len(),
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
            "mode": "list",
            "status": "success",
            "msg_count": page.items.len(),
            "chars": utf16_len(&text),
            "truncated": truncated,
            "has_keyword": keyword.is_some(),
            "duration_ms": crate::telemetry::now_ms() - started,
            "session_id": crate::telemetry::hash_id(session_id),
        }),
    );

    let items = serde_json::to_value(&page.items).unwrap_or_else(|_| Value::Array(Vec::new()));
    Ok(NativeToolOutcome::Value {
        content: text,
        ui_data: Some(json!({
            "mode": "list",
            "status": "success",
            "total": page.total,
            "boundarySeq": page.boundary_seq,
            "hasMore": page.has_more,
            "nextCursor": page.next_cursor,
            "keyword": keyword,
            "items": items,
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
            tool_call_id: "tc_list",
            cancel: &cancel,
            sink: &sink,
            bridge: &bridge,
            security: &sec,
            repo,
            skills: None,
            host: crate::host::default_host().as_ref(),
            settings: crate::agent::native_tools::noop_settings(),
        };
        execute_native_tool(&ctx, "list_messages", &args)
            .await
            .expect("list_messages 不应返回 Err")
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

    /// 存入 n 条用户消息 + 一条 summary（summary 之后的时序即「已在上下文」）
    async fn seed(repo: &dyn SessionRepo, n: usize, with_summary: bool) {
        repo.upsert_session(&test_session(SESSION, "t", 100))
            .await
            .unwrap();
        let msgs: Vec<Message> = (1..=n)
            .map(|i| {
                let mut m = test_message(&format!("m{}", i), "user");
                m.content = json!(format!("消息 {}", i));
                m
            })
            .collect();
        repo.append_messages(SESSION, &msgs).await.unwrap();
        if with_summary {
            let mut s = test_message("sum", "summary");
            s.content = json!("[summary]");
            repo.append_messages(SESSION, &[s]).await.unwrap();
        }
    }

    /// 无本地存储（Noop）→ 与 JS 路径一致的「不可用」文案
    #[tokio::test]
    async fn unavailable_without_local_storage() {
        let outcome = run(crate::agent::native_tools::noop_repo(), json!({})).await;
        assert_eq!(
            content_of(&outcome),
            "Message history is unavailable in this environment (local storage not accessible)."
        );
    }

    #[tokio::test]
    async fn empty_conversation() {
        let repo = open_tmp();
        repo.upsert_session(&test_session(SESSION, "t", 100))
            .await
            .unwrap();
        let outcome = run(&repo, json!({})).await;
        assert_eq!(content_of(&outcome), "This conversation has no messages yet.");
    }

    #[tokio::test]
    async fn not_compressed_yet() {
        let repo = open_tmp();
        seed(&repo, 3, false).await;
        let outcome = run(&repo, json!({})).await;
        assert!(content_of(&outcome).starts_with("This conversation has not been compressed yet"));
        assert_eq!(ui_of(&outcome)["status"], "not_compressed");
        assert_eq!(ui_of(&outcome)["total"], 3);
    }

    #[tokio::test]
    async fn lists_queryable_range_only() {
        let repo = open_tmp();
        // 5 条消息 + summary（时序 6）→ 可查询区间 #1..#5
        seed(&repo, 5, true).await;
        let outcome = run(&repo, json!({ "limit": 10 })).await;

        let text = content_of(&outcome);
        assert!(text.starts_with("Queryable history: #1..#5 (5 messages); conversation total: 6."));
        assert!(text.contains("#1 [user] "));
        assert!(text.contains("    id: m1"));
        assert!(text.ends_with("This is the oldest page of the queryable history."));

        let ui = ui_of(&outcome);
        assert_eq!(ui["mode"], "list");
        assert_eq!(ui["status"], "success");
        assert_eq!(ui["boundarySeq"], 6);
        assert_eq!(ui["hasMore"], false);
        assert!(ui["keyword"].is_null());
        assert_eq!(ui["items"].as_array().unwrap().len(), 5);
    }

    /// 关键词无命中 → 提示可查询区间（uiData.status = empty）
    #[tokio::test]
    async fn keyword_without_match() {
        let repo = open_tmp();
        seed(&repo, 4, true).await;
        let outcome = run(&repo, json!({ "keyword": "不存在的词" })).await;
        assert_eq!(
            content_of(&outcome),
            "No queryable message matches \"不存在的词\". Queryable range: #1..#4."
        );
        assert_eq!(ui_of(&outcome)["status"], "empty");
    }
}
