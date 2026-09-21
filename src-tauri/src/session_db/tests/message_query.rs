//! 「消息查询」工具（窗口 / 时序）的回归测试 —— 只允许查询「已压缩区间」

use super::{open_tmp, test_message, test_session};
use crate::agent::types::Message;
use crate::session_db::repo::SessionRepo;
use crate::session_db::types::{MSG_QUERY_MAX_SPAN, MSG_QUERY_TOOL_DETAIL_MAX_CHARS};
use serde_json::json;

// ==================== 消息查询（query messages）====================

/// 造一条带 tool_calls + 深度思考的 assistant 消息
fn assistant_with_tool(id: &str, text: &str, tool: &str, args: serde_json::Value) -> Message {
    let mut m = test_message(id, "assistant");
    m.content = json!(text);
    m.reasoning_content = Some("SECRET_REASONING_绝不外泄".into());
    m.tool_calls = Some(vec![crate::agent::types::ToolUseContent {
        type_: "function".into(),
        id: format!("tc_{}", id),
        name: tool.into(),
        input: args,
    }]);
    m
}

/// 追加一条 summary，作为「压缩边界」
fn summary_message(id: &str) -> Message {
    let mut m = test_message(id, "summary");
    m.content = json!("[summary] 之前的对话已压缩");
    m
}

fn user_msg(id: &str, text: &str) -> Message {
    let mut m = test_message(id, "user");
    m.content = json!(text);
    m
}

#[tokio::test]
async fn message_window_returns_before_and_after_ascending() {
    let repo = open_tmp();
    repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
    let msgs: Vec<Message> = (1..=10)
        .map(|i| user_msg(&format!("m{}", i), &format!("消息 {}", i)))
        .collect();
    repo.append_messages("s1", &msgs).await.unwrap();
    repo.append_messages("s1", &[summary_message("s")]).await.unwrap();

    let w = repo
        .get_message_window("s1", Some("m5"), None, 2, 2)
        .await
        .unwrap();
    assert!(w.anchor_found);
    assert_eq!(w.anchor_seq, 5);
    assert_eq!(w.boundary_seq, Some(11));
    assert_eq!(w.total, 11);
    let ids: Vec<&str> = w.messages.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(ids, vec!["m3", "m4", "m5", "m6", "m7"]);
    assert_eq!(w.messages[0].seq, 3);
    assert!(!w.clamped_by_boundary);
}

#[tokio::test]
async fn message_window_clamps_at_boundary_and_never_returns_known_tail() {
    let repo = open_tmp();
    repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
    let msgs: Vec<Message> = (1..=10)
        .map(|i| user_msg(&format!("m{}", i), &format!("消息 {}", i)))
        .collect();
    repo.append_messages("s1", &msgs).await.unwrap();
    repo.append_messages("s1", &[summary_message("s")]).await.unwrap();
    // 边界之后还有「已知」消息：绝不能被查询返回
    let mut known = test_message("m11", "assistant");
    known.content = json!("已知回复");
    repo.append_messages("s1", &[known]).await.unwrap();

    let w = repo
        .get_message_window("s1", Some("m9"), None, 0, 10)
        .await
        .unwrap();
    let ids: Vec<&str> = w.messages.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(ids, vec!["m9", "m10"], "只返回压缩区间内的消息");
    assert!(w.clamped_by_boundary);
    assert!(!ids.contains(&"m11"));
    assert!(!ids.contains(&"s"));
}

#[tokio::test]
async fn message_window_anchor_in_visible_region_returns_empty() {
    let repo = open_tmp();
    repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
    let msgs: Vec<Message> = (1..=5)
        .map(|i| test_message(&format!("m{}", i), "user"))
        .collect();
    repo.append_messages("s1", &msgs).await.unwrap();
    repo.append_messages("s1", &[summary_message("s")]).await.unwrap();

    // 锚点 = summary（在「已知区间」）→ 空窗口
    let w = repo
        .get_message_window("s1", Some("s"), None, 5, 5)
        .await
        .unwrap();
    assert!(w.anchor_found);
    assert!(w.messages.is_empty());
}

#[tokio::test]
async fn message_window_without_summary_has_nothing_queryable() {
    let repo = open_tmp();
    repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
    let msgs: Vec<Message> = (1..=5)
        .map(|i| test_message(&format!("m{}", i), "user"))
        .collect();
    repo.append_messages("s1", &msgs).await.unwrap();

    let w = repo
        .get_message_window("s1", Some("m3"), None, 5, 5)
        .await
        .unwrap();
    assert_eq!(w.boundary_seq, None);
    assert!(w.messages.is_empty(), "未压缩 → 无可查询历史");
}

#[tokio::test]
async fn message_window_anchor_not_found() {
    let repo = open_tmp();
    repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
    repo.append_messages("s1", &[test_message("m1", "user"), summary_message("s")])
        .await
        .unwrap();
    let w = repo
        .get_message_window("s1", Some("nope"), None, 5, 5)
        .await
        .unwrap();
    assert!(!w.anchor_found);
    assert!(w.messages.is_empty());
}

#[tokio::test]
async fn message_window_never_exposes_reasoning() {
    let repo = open_tmp();
    repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
    repo.append_messages(
        "s1",
        &[
            assistant_with_tool("m1", "正文", "read_file", json!({ "path": "a.txt" })),
            summary_message("s"),
        ],
    )
    .await
    .unwrap();

    let w = repo
        .get_message_window("s1", Some("m1"), None, 0, 0)
        .await
        .unwrap();
    assert_eq!(w.messages.len(), 1);
    assert!(w.messages[0].has_reasoning, "应标记「含思考」");
    let serialized = serde_json::to_string(&w).unwrap();
    assert!(
        !serialized.contains("SECRET_REASONING"),
        "深度思考内容绝不能出现在返回里"
    );
    assert!(!serialized.contains("reasoning_content"));
}

#[tokio::test]
async fn message_window_truncates_tool_details_and_tool_result() {
    let repo = open_tmp();
    repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
    let long_arg = "x".repeat(500);
    let mut tool_result = test_message("m2", "tool");
    tool_result.content = json!("y".repeat(500));
    tool_result.tool_call_id = Some("tc_m1".into());
    repo.append_messages(
        "s1",
        &[
            assistant_with_tool("m1", "正文", "read_file", json!({ "path": long_arg })),
            tool_result,
            summary_message("s"),
        ],
    )
    .await
    .unwrap();

    let w = repo
        .get_message_window("s1", Some("m1"), None, 5, 5)
        .await
        .unwrap();
    let a = &w.messages[0];
    assert_eq!(a.tool_calls.len(), 1);
    assert_eq!(a.tool_calls[0].name, "read_file");
    assert!(a.tool_calls[0].input_truncated);
    assert!(
        a.tool_calls[0].input_brief.chars().count()
            <= MSG_QUERY_TOOL_DETAIL_MAX_CHARS + 1
    );
    let tr = &w.messages[1];
    assert_eq!(tr.role, "tool");
    assert!(tr.text_truncated);
    assert!(tr.text.chars().count() <= MSG_QUERY_TOOL_DETAIL_MAX_CHARS + 1);
}

#[tokio::test]
async fn message_window_clamps_span() {
    let repo = open_tmp();
    repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
    let msgs: Vec<Message> = (1..=100)
        .map(|i| test_message(&format!("m{}", i), "user"))
        .collect();
    repo.append_messages("s1", &msgs).await.unwrap();
    repo.append_messages("s1", &[summary_message("s")]).await.unwrap();

    let w = repo
        .get_message_window("s1", Some("m50"), None, 999, 999)
        .await
        .unwrap();
    assert!(w.messages.len() <= MSG_QUERY_MAX_SPAN + 1);
    assert!(w.messages.len() > 1, "应按比例保留锚点前后");
}

#[tokio::test]
async fn message_timeline_lists_queryable_only_and_pages_backwards() {
    let repo = open_tmp();
    repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
    let msgs: Vec<Message> = (1..=10)
        .map(|i| user_msg(&format!("m{}", i), &format!("消息 {}", i)))
        .collect();
    repo.append_messages("s1", &msgs).await.unwrap();
    repo.append_messages("s1", &[summary_message("s")]).await.unwrap();
    let mut known = test_message("m11", "assistant");
    known.content = json!("已知回复");
    repo.append_messages("s1", &[known]).await.unwrap();

    // 首页：可查询区间最新 4 条（#7..#10），不含 summary / m11
    let p1 = repo.get_message_timeline("s1", None, None, 4).await.unwrap();
    let ids: Vec<&str> = p1.items.iter().map(|i| i.id.as_str()).collect();
    assert_eq!(ids, vec!["m7", "m8", "m9", "m10"]);
    assert_eq!(p1.boundary_seq, Some(11));
    assert!(p1.has_more);

    // 翻更早
    let p2 = repo
        .get_message_timeline("s1", None, p1.next_cursor, 4)
        .await
        .unwrap();
    let ids2: Vec<&str> = p2.items.iter().map(|i| i.id.as_str()).collect();
    assert_eq!(ids2, vec!["m3", "m4", "m5", "m6"]);
}

#[tokio::test]
async fn message_timeline_keyword_filter_and_empty_when_uncompressed() {
    let repo = open_tmp();
    repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
    repo.append_messages("s1", &[user_msg("m1", "关于沙盒的讨论"), user_msg("m2", "关于网络的讨论")])
        .await
        .unwrap();

    // 未压缩 → 无可查询
    let p = repo.get_message_timeline("s1", None, None, 10).await.unwrap();
    assert!(p.items.is_empty());
    assert_eq!(p.boundary_seq, None);

    repo.append_messages("s1", &[summary_message("s")]).await.unwrap();
    let p = repo
        .get_message_timeline("s1", Some("沙盒"), None, 10)
        .await
        .unwrap();
    let ids: Vec<&str> = p.items.iter().map(|i| i.id.as_str()).collect();
    assert_eq!(ids, vec!["m1"]);
    assert!(p.items[0].preview.contains("沙盒"));
}
