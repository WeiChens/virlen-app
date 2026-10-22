//! 压缩遮罩记录（P0-3）：`compactions` 表的写入 / 读取，以及「已压缩区间」与
//! 「模型上下文起点」两个口径是否真的跟着记录走（而不是跟着 summary 的位置走）。

use super::{open_tmp, test_message, test_session};
use crate::agent::types::Message;
use crate::session_db::repo::SessionRepo;
use serde_json::json;

fn user_msg(id: &str, text: &str) -> Message {
    let mut m = test_message(id, "user");
    m.content = json!(text);
    m
}

fn summary_message(id: &str) -> Message {
    let mut m = test_message(id, "summary");
    m.content = json!("[summary] 之前的对话已压缩");
    m
}

async fn seed(repo: &dyn SessionRepo, messages: &[Message]) {
    repo.upsert_session(&test_session("s1", "t", 100))
        .await
        .unwrap();
    repo.append_messages("s1", messages).await.unwrap();
}

#[tokio::test]
async fn record_and_list_roundtrip_is_idempotent() {
    let repo = open_tmp();
    repo.record_compaction("s1", "m1", "m2", "sum1")
        .await
        .unwrap();
    // 同一个 summary 重复记 → 不产生第二条
    repo.record_compaction("s1", "m1", "m2", "sum1")
        .await
        .unwrap();
    repo.record_compaction("s1", "m3", "m4", "sum2")
        .await
        .unwrap();

    let masks = repo.list_compactions("s1").await.unwrap();
    assert_eq!(masks.len(), 2);
    assert_eq!(masks[0].start_message_id, "m1");
    assert_eq!(masks[0].end_message_id, "m2");
    assert_eq!(masks[0].summary_message_id, "sum1");
    assert_eq!(masks[1].summary_message_id, "sum2");

    // 别的会话读不到
    assert!(repo.list_compactions("s2").await.unwrap().is_empty());
}

#[tokio::test]
async fn context_load_starts_after_the_masked_range() {
    let repo = open_tmp();
    seed(
        &repo,
        &[
            user_msg("m1", "第一轮"),
            user_msg("m2", "第二轮"),
            user_msg("m3", "第三轮"),
            summary_message("sum1"),
            user_msg("m4", "压缩之后"),
        ],
    )
    .await;
    // 遮罩 m1..m2（summary 是 sum1）
    repo.record_compaction("s1", "m1", "m2", "sum1")
        .await
        .unwrap();

    let context = repo.get_context_messages("s1").await.unwrap();
    let ids: Vec<&str> = context.iter().map(|m| m.id.as_str()).collect();
    // 起点 = 被遮罩区间的末条（含）→ m2 之后的内容原样带出（m2 自身会被遮罩掉）
    assert_eq!(ids, vec!["m2", "m3", "sum1", "m4"]);
}

#[tokio::test]
async fn boundary_follows_the_masked_range_not_the_summary_position() {
    let repo = open_tmp();
    seed(
        &repo,
        &[
            user_msg("m1", "一"),
            user_msg("m2", "二"),
            user_msg("m3", "三"),
            summary_message("sum1"),
            user_msg("m4", "四"),
        ],
    )
    .await;
    repo.record_compaction("s1", "m1", "m3", "sum1")
        .await
        .unwrap();

    let page = repo
        .get_message_timeline("s1", None, None, 50)
        .await
        .unwrap();
    // 边界 = 最后一条被遮罩消息的下一条时序（m3 是第 3 条 → 边界 4）
    assert_eq!(page.boundary_seq, Some(4));
    // 可查询的只有「已压缩区间」内（1..=3）
    let seqs: Vec<i64> = page.items.iter().map(|i| i.seq).collect();
    assert_eq!(seqs, vec![1, 2, 3]);
}

#[tokio::test]
async fn legacy_sessions_without_records_keep_the_summary_boundary() {
    let repo = open_tmp();
    seed(
        &repo,
        &[
            user_msg("m1", "一"),
            user_msg("m2", "二"),
            summary_message("sum1"),
            user_msg("m3", "三"),
        ],
    )
    .await;

    let page = repo
        .get_message_timeline("s1", None, None, 50)
        .await
        .unwrap();
    // 没有记录 → 回退到「最后一条 summary 的位置」（第 3 条）
    assert_eq!(page.boundary_seq, Some(3));
    let seqs: Vec<i64> = page.items.iter().map(|i| i.seq).collect();
    assert_eq!(seqs, vec![1, 2]);
}
