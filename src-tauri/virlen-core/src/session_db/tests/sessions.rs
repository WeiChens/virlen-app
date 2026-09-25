//! 会话 / 消息读写、分页与用户消息索引的回归测试

use super::{open_tmp, test_message, test_session};
use crate::agent::types::Message;
use crate::session_db::repo::SessionRepo;
use serde_json::json;

#[tokio::test]
async fn upsert_and_read_roundtrip() {
    let repo = open_tmp();
    let s = test_session("s1", "title", 100);
    repo.upsert_session(&s).await.unwrap();

    let loaded = repo.get_session("s1").await.unwrap().unwrap();
    assert_eq!(loaded.id, "s1");
    assert_eq!(loaded.title, "title");
    assert_eq!(loaded.model_id, "gpt-4o");
    assert_eq!(loaded.tags, vec!["tag1".to_string()]);
    assert_eq!(loaded.allowed_tools, Some(vec!["read_file".to_string()]));
    assert_eq!(loaded.system_prompt_manually_edited, Some(true));
    assert_eq!(loaded.params.max_tokens, 1000);
}

#[tokio::test]
async fn upsert_is_idempotent() {
    let repo = open_tmp();
    repo.upsert_session(&test_session("s1", "v1", 100)).await.unwrap();
    repo.upsert_session(&test_session("s1", "v2", 200)).await.unwrap();
    let loaded = repo.get_session("s1").await.unwrap().unwrap();
    assert_eq!(loaded.title, "v2");
    assert_eq!(loaded.updated_at, 200);
}

#[tokio::test]
async fn append_and_get_messages_ordered() {
    let repo = open_tmp();
    repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
    repo.append_messages(
        "s1",
        &[test_message("m1", "user"), test_message("m2", "assistant")],
    )
    .await
    .unwrap();

    let msgs = repo.get_messages("s1").await.unwrap();
    assert_eq!(msgs.len(), 2);
    assert_eq!(msgs[0].id, "m1");
    assert_eq!(msgs[1].id, "m2");
    // 会话时间不变：落库消息（AI 回复 / 工具结果）不得刷新 updated_at，
    // 它只由前端「用户发送消息」那一次 upsert_session 写入。
    let s = repo.get_session("s1").await.unwrap().unwrap();
    assert_eq!(s.updated_at, 100, "写消息不应刷新会话时间");
}

#[tokio::test]
async fn message_writes_never_refresh_session_time() {
    // 回归（产品语义）：会话时间 = 用户最后一次发言的时间。
    // AI 回复 / 工具结果 / 迭代反馈的落库都不得改写 updated_at，
    // 只有前端「用户发送消息」那一瞬间的 upsert_session 会写它。
    let repo = open_tmp();
    repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
    repo.append_messages(
        "s1",
        &[
            test_message("m1", "user"),
            test_message("m2", "assistant"),
            test_message("m3", "tool"),
        ],
    )
    .await
    .unwrap();
    repo.append_messages("s1", &[test_message("m4", "assistant")])
        .await
        .unwrap();
    let s = repo.get_session("s1").await.unwrap().unwrap();
    assert_eq!(s.updated_at, 100, "写消息不应刷新会话时间");

    // 只有 upsert_session（用户发言时前端调用）才刷新
    repo.upsert_session(&test_session("s1", "t", 500))
        .await
        .unwrap();
    let s2 = repo.get_session("s1").await.unwrap().unwrap();
    assert_eq!(s2.updated_at, 500);
}

#[tokio::test]
async fn append_messages_idempotent() {
    let repo = open_tmp();
    repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
    repo.append_messages("s1", &[test_message("m1", "user")]).await.unwrap();
    repo.append_messages("s1", &[test_message("m1", "user")]).await.unwrap();
    let msgs = repo.get_messages("s1").await.unwrap();
    assert_eq!(msgs.len(), 1, "重复写入同一 id 应幂等");
}

#[tokio::test]
async fn reappend_keeps_message_order() {
    // 回归：重复写入已存在的“中间消息”不得改变读取顺序（保留原 rowid）
    let repo = open_tmp();
    repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
    repo.append_messages("s1", &[test_message("m1", "user")]).await.unwrap();
    repo.append_messages(
        "s1",
        &[test_message("m2", "assistant"), test_message("m3", "tool")],
    )
    .await
    .unwrap();
    repo.append_messages("s1", &[test_message("m1", "user")]).await.unwrap();
    let msgs = repo.get_messages("s1").await.unwrap();
    let ids: Vec<&str> = msgs.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(ids, vec!["m1", "m2", "m3"], "重复写入同 id 不应把消息挪到末尾");
}

#[tokio::test]
async fn replace_messages_swaps_all() {
    let repo = open_tmp();
    repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
    repo.append_messages(
        "s1",
        &[test_message("m1", "user"), test_message("m2", "assistant")],
    )
    .await
    .unwrap();
    // 压缩后整体替换为新的消息列表
    repo.replace_messages(
        "s1",
        &[test_message("m9", "user"), test_message("m10", "assistant")],
    )
    .await
    .unwrap();
    let msgs = repo.get_messages("s1").await.unwrap();
    assert_eq!(msgs.len(), 2, "替换后不应残留旧消息");
    assert_eq!(msgs[0].id, "m9");
    assert_eq!(msgs[1].id, "m10");
    // 压缩（整批替换）也不是用户发言 → 会话时间保持原值
    let s = repo.get_session("s1").await.unwrap().unwrap();
    assert_eq!(s.updated_at, 100, "整批替换消息不应刷新会话时间");
}

#[tokio::test]
async fn delete_removes_session_and_messages() {
    let repo = open_tmp();
    repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
    repo.append_messages("s1", &[test_message("m1", "user")]).await.unwrap();
    repo.delete_session("s1").await.unwrap();
    assert!(repo.get_session("s1").await.unwrap().is_none());
    assert!(repo.get_messages("s1").await.unwrap().is_empty());
}

#[tokio::test]
async fn append_after_delete_is_skipped_and_purge_reclaims_orphans() {
    // 回归：删除会话与进行中的 run 是天然竞态 —— 会话行（连同消息）已删、引擎仍在落库，
    // 不拦就会写入 session_id 指向不存在会话的孤儿消息：查询查不到（检索是 JOIN sessions）、
    // 清理逻辑也不碰，只会让数据库文件只增不减。
    let repo = open_tmp();
    repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();

    // 会话存活 → 引擎落库照常写入
    assert!(repo
        .append_messages_if_alive("s1", &[test_message("m1", "user")])
        .await
        .unwrap());

    // 用户删除会话 → 后续引擎落库必须整体跳过（不写任何行）
    repo.delete_session("s1").await.unwrap();
    assert!(!repo
        .append_messages_if_alive("s1", &[test_message("m2", "assistant")])
        .await
        .unwrap());
    assert!(repo.get_messages("s1").await.unwrap().is_empty());

    // 历史遗留的孤儿行（旧版本：删会话时引擎还在跑）由启动兜底清理回收。
    // 直接用不校验存活的 append_messages 造出孤儿，模拟旧数据。
    repo.append_messages("ghost", &[test_message("m3", "assistant")])
        .await
        .unwrap();
    assert_eq!(repo.purge_orphan_messages().await.unwrap(), 1);
    assert!(repo.get_messages("ghost").await.unwrap().is_empty());
    // 幂等：再跑一次无行可删
    assert_eq!(repo.purge_orphan_messages().await.unwrap(), 0);
}

#[tokio::test]
async fn truncate_removes_target_and_after() {
    // 回归：前端删除用户消息时，DB 必须同步删除该消息及其之后的全部消息，
    // 否则重启后已删除消息会从 SQLite「复活」。
    let repo = open_tmp();
    repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
    let msgs: Vec<Message> = (1..=5)
        .map(|i| test_message(&format!("m{}", i), "user"))
        .collect();
    repo.append_messages("s1", &msgs).await.unwrap();

    repo.truncate_messages_from("s1", "m3").await.unwrap();

    let ids: Vec<String> = repo
        .get_messages("s1")
        .await
        .unwrap()
        .into_iter()
        .map(|m| m.id)
        .collect();
    assert_eq!(ids, vec!["m1", "m2"], "应删除目标及其之后的消息");
    // 删除消息不是用户发言 → 会话时间不变
    assert_eq!(
        repo.get_session("s1").await.unwrap().unwrap().updated_at,
        100,
        "删除消息不应刷新会话时间"
    );
}

#[tokio::test]
async fn truncate_missing_message_is_noop() {
    let repo = open_tmp();
    repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
    repo.append_messages(
        "s1",
        &[test_message("m1", "user"), test_message("m2", "assistant")],
    )
    .await
    .unwrap();

    // 目标不存在：子查询为 NULL → 不应误删任何行
    repo.truncate_messages_from("s1", "nope").await.unwrap();

    assert_eq!(repo.get_messages("s1").await.unwrap().len(), 2);
}

#[tokio::test]
async fn truncate_does_not_touch_other_sessions() {
    let repo = open_tmp();
    repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
    repo.upsert_session(&test_session("s2", "t", 100)).await.unwrap();
    repo.append_messages(
        "s1",
        &[test_message("a1", "user"), test_message("a2", "assistant")],
    )
    .await
    .unwrap();
    repo.append_messages(
        "s2",
        &[test_message("b1", "user"), test_message("b2", "assistant")],
    )
    .await
    .unwrap();

    repo.truncate_messages_from("s1", "a1").await.unwrap();

    assert!(repo.get_messages("s1").await.unwrap().is_empty());
    let other: Vec<String> = repo
        .get_messages("s2")
        .await
        .unwrap()
        .into_iter()
        .map(|m| m.id)
        .collect();
    assert_eq!(other, vec!["b1", "b2"], "不应影响其它会话");
}

#[tokio::test]
async fn list_sessions_sorted_desc() {
    let repo = open_tmp();
    repo.upsert_session(&test_session("a", "A", 100)).await.unwrap();
    repo.upsert_session(&test_session("b", "B", 300)).await.unwrap();
    repo.upsert_session(&test_session("c", "C", 200)).await.unwrap();
    let list = repo.list_sessions().await.unwrap();
    let ids: Vec<&str> = list.iter().map(|s| s.id.as_str()).collect();
    assert_eq!(ids, vec!["b", "c", "a"]);
}

#[tokio::test]
async fn page_returns_tail_window_in_order() {
    let repo = open_tmp();
    repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
    let msgs: Vec<Message> = (1..=10)
        .map(|i| test_message(&format!("m{}", i), "user"))
        .collect();
    repo.append_messages("s1", &msgs).await.unwrap();

    // 尾部窗口：最后 4 条（且为升序）
    let p1 = repo.get_message_page("s1", 4, None).await.unwrap();
    let ids1: Vec<&str> = p1.messages.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(ids1, vec!["m7", "m8", "m9", "m10"]);
    assert!(p1.has_more);
    let cursor1 = p1.oldest_rowid.expect("尾部页应有 oldest_rowid");

    // 向上回补：再取 4 条
    let p2 = repo.get_message_page("s1", 4, Some(cursor1)).await.unwrap();
    let ids2: Vec<&str> = p2.messages.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(ids2, vec!["m3", "m4", "m5", "m6"]);
    assert!(p2.has_more);
    let cursor2 = p2.oldest_rowid.unwrap();

    // 最后一页：只剩 2 条，无更多
    let p3 = repo.get_message_page("s1", 4, Some(cursor2)).await.unwrap();
    let ids3: Vec<&str> = p3.messages.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(ids3, vec!["m1", "m2"]);
    assert!(!p3.has_more);
}

#[tokio::test]
async fn page_marks_no_more_when_session_smaller_than_limit() {
    let repo = open_tmp();
    repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
    repo.append_messages(
        "s1",
        &[test_message("m1", "user"), test_message("m2", "assistant")],
    )
    .await
    .unwrap();
    let p = repo.get_message_page("s1", 60, None).await.unwrap();
    assert_eq!(p.messages.len(), 2);
    assert!(!p.has_more, "消息数少于 limit 时不应标记 has_more");
}

#[tokio::test]
async fn page_is_empty_for_missing_session() {
    let repo = open_tmp();
    let p = repo.get_message_page("nope", 60, None).await.unwrap();
    assert!(p.messages.is_empty());
    assert!(!p.has_more);
    assert!(p.oldest_rowid.is_none());
}

#[tokio::test]
async fn user_message_refs_only_returns_user_messages_in_order() {
    let repo = open_tmp();
    repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
    let mut assistant = test_message("m2", "assistant");
    assistant.content = json!("assistant reply");
    // 带图片块 + 文本块的 user 消息：摘要应只取 text 块
    let mut with_image = test_message("m3", "user");
    with_image.content = json!([
        { "type": "image_url", "image_url": { "url": "data:image/png;base64,AAAA" } },
        { "type": "text", "text": "看看这张图" }
    ]);
    repo.append_messages(
        "s1",
        &[
            test_message("m1", "user"),
            assistant,
            with_image,
            test_message("m4", "tool"),
        ],
    )
    .await
    .unwrap();

    let refs = repo.get_user_message_refs("s1").await.unwrap();
    let ids: Vec<&str> = refs.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(ids, vec!["m1", "m3"], "只返回 user 消息且保持插入顺序");
    assert_eq!(refs[0].preview, "hello");
    assert_eq!(refs[1].preview, "看看这张图");
}

#[tokio::test]
async fn user_message_refs_truncates_preview_to_420_chars() {
    let repo = open_tmp();
    repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
    let mut long = test_message("m1", "user");
    long.content = json!("字".repeat(600));
    repo.append_messages("s1", &[long]).await.unwrap();

    let refs = repo.get_user_message_refs("s1").await.unwrap();
    assert_eq!(refs.len(), 1);
    assert_eq!(refs[0].preview.chars().count(), 420);
}
