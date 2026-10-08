//! 「可见行计数」与「分页补足」的回归测试（与桌面折叠行模型同口径）。

use super::{open_tmp, test_message, test_session};
use crate::agent::types::{Message, ToolUseContent};
use crate::session_db::repo::SessionRepo;
use crate::session_db::visible::{
    get_message_page_filled, visible_row_count, MESSAGE_FILL_MAX_CHUNKS,
};
use serde_json::json;

/// 普通消息（test_message 默认正文 hello → 有正文，会渲染 1 行）
fn text(id: &str, role: &str) -> Message {
    test_message(id, role)
}

/// 工具宿主 assistant：带 1 个工具调用、无正文、无附件块 → 会被折进工具组
fn host(id: &str) -> Message {
    let mut m = test_message(id, "assistant");
    m.content = json!("");
    m.tool_calls = Some(vec![ToolUseContent {
        type_: "tool_use".into(),
        id: format!("{}-call", id),
        name: "read_file".into(),
        input: json!({}),
    }]);
    m
}

/// 带正文的工具宿主 → 中段遇到它会收口另起一段
fn host_with_body(id: &str) -> Message {
    let mut m = host(id);
    m.content = json!("先看一下");
    m
}

/// 带附件块（图片）的工具宿主 → 不并入折叠组（各占一行）
fn host_with_attachment(id: &str) -> Message {
    let mut m = host(id);
    m.content = json!([
        { "type": "image_url", "image_url": { "url": "data:image/png;base64,AAAA" } }
    ]);
    m
}

/// role='tool' 的结果消息（气泡渲染 null，0 高度）
fn tool(id: &str) -> Message {
    let mut m = test_message(id, "tool");
    m.content = json!("result");
    m.tool_call_id = Some(format!("{}-call", id));
    m
}

fn ids(page: &crate::session_db::types::MessagePage) -> Vec<&str> {
    page.messages.iter().map(|m| m.id.as_str()).collect()
}

async fn seed(repo: &impl SessionRepo, session_id: &str, messages: &[Message]) {
    repo.upsert_session(&test_session(session_id, "t", 100))
        .await
        .unwrap();
    repo.append_messages(session_id, messages).await.unwrap();
}

#[test]
fn visible_rows_fold_merges_consecutive_tool_hosts() {
    let msgs = vec![
        text("u1", "user"),
        host("a1"),
        tool("r1"),
        host("a2"),
        tool("r2"),
        text("a3", "assistant"),
    ];
    // 折叠：user(1) + 一个工具段(1) + assistant(1) = 3
    assert_eq!(visible_row_count(&msgs, true), 3);
    // 不折叠：tool 结果仍不渲染，两个宿主各成卡片 → user + a1 + a2 + a3 = 4
    assert_eq!(visible_row_count(&msgs, false), 4);
}

#[test]
fn visible_rows_split_run_on_body_host() {
    let msgs = vec![
        text("u1", "user"),
        host_with_body("a1"),
        host("a2"),
        tool("r2"),
    ];
    // a1 是段首（正文显示在组头之上，不额外占行），a2 并入同一段 → 整段 1 行
    assert_eq!(visible_row_count(&msgs, true), 2); // user + 工具段
}

#[test]
fn visible_rows_body_host_after_run_starts_new_group() {
    let msgs = vec![
        host("a1"),
        tool("r1"),
        host_with_body("a2"), // 中段带正文 → 收口，a2 另起一段
        tool("r2"),
    ];
    assert_eq!(visible_row_count(&msgs, true), 2); // 两段，各 1 行
}

#[test]
fn visible_rows_attachment_host_not_merged() {
    let msgs = vec![
        text("u1", "user"),
        host_with_attachment("a1"),
        tool("r1"),
    ];
    // 带附件的宿主不进折叠组 → 自己占 1 行；tool 结果不计
    assert_eq!(visible_row_count(&msgs, true), 2);
}

#[test]
fn visible_rows_tool_results_never_counted() {
    let msgs = vec![tool("r1"), tool("r2")];
    assert_eq!(visible_row_count(&msgs, true), 0);
    assert_eq!(visible_row_count(&msgs, false), 0);
}

#[tokio::test]
async fn fill_stops_when_visible_target_met() {
    let repo = open_tmp();
    let msgs: Vec<Message> = (1..=8).map(|i| text(&format!("u{}", i), "user")).collect();
    seed(&repo, "s1", &msgs).await;

    // 每页 2 条，可见行下限 3：尾页 [u7,u8] 只有 2 行 → 再取一页 → [u5..u8] 共 4 行 → 停
    let page = get_message_page_filled(&repo, "s1", 2, None, 3, true)
        .await
        .unwrap();
    assert_eq!(ids(&page), vec!["u5", "u6", "u7", "u8"]);
    assert!(page.has_more);
    assert!(page.oldest_rowid.is_some());
}

#[tokio::test]
async fn fill_stops_at_beginning() {
    let repo = open_tmp();
    seed(
        &repo,
        "s1",
        &[text("u1", "user"), text("u2", "user"), text("u3", "user")],
    )
    .await;

    // 可见行下限 10 永远达不到，但到底即停
    let page = get_message_page_filled(&repo, "s1", 2, None, 10, true)
        .await
        .unwrap();
    assert_eq!(ids(&page), vec!["u1", "u2", "u3"]);
    assert!(!page.has_more);
}

#[tokio::test]
async fn fill_capped_when_visible_never_reaches_target() {
    let repo = open_tmp();
    // 全是工具调用：折叠后可见行恒为 1，靠上限收口
    let mut msgs = Vec::new();
    for i in 1..=6 {
        msgs.push(host(&format!("a{}", i)));
        msgs.push(tool(&format!("r{}", i)));
    }
    seed(&repo, "s1", &msgs).await;

    let page = get_message_page_filled(&repo, "s1", 2, None, 3, true)
        .await
        .unwrap();
    // 最多 MESSAGE_FILL_MAX_CHUNKS 页 × 每页 2 条
    assert_eq!(page.messages.len(), MESSAGE_FILL_MAX_CHUNKS * 2);
    assert!(page.has_more);
    assert_eq!(visible_row_count(&page.messages, true), 1);
}

#[tokio::test]
async fn fill_single_chunk_when_target_already_met() {
    let repo = open_tmp();
    let msgs: Vec<Message> = (1..=8).map(|i| text(&format!("u{}", i), "user")).collect();
    seed(&repo, "s1", &msgs).await;

    // 每页 4 条、下限 2：尾页 [u5..u8] 已是 4 行 → 只取一页
    let page = get_message_page_filled(&repo, "s1", 4, None, 2, true)
        .await
        .unwrap();
    assert_eq!(ids(&page), vec!["u5", "u6", "u7", "u8"]);
}
