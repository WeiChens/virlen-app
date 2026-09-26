//! `session_stats` —— `list-session` 的「上下文大小 / 对话条数」两列的数据源
//!
//! 两件事必须锁住：① 条数是**全量**计数（不是分页窗口）；② 占用口径与
//! `agent::compress::context_tokens` 完全一致（压缩产物优先于它自己的 usage）。

use super::{open_tmp, test_message, test_session};
use crate::agent::types::TokenUsage;
use crate::session_db::repo::SessionRepo;
use serde_json::json;

fn usage(total: i64) -> TokenUsage {
    TokenUsage {
        prompt_tokens: total - 10,
        completion_tokens: 10,
        total_tokens: total,
        cached_tokens: None,
    }
}

#[tokio::test]
async fn counts_all_messages_and_reads_tokens_from_newest_usage() {
    let repo = open_tmp();
    repo.upsert_session(&test_session("s1", "会话1", 100))
        .await
        .unwrap();
    repo.upsert_session(&test_session("s2", "会话2", 200))
        .await
        .unwrap();

    // s1：三条消息，最后一条带 usage → 占用 = 它的 totalTokens
    repo.append_messages(
        "s1",
        &[test_message("m1", "user"), test_message("m2", "assistant")],
    )
    .await
    .unwrap();
    let mut m3 = test_message("m3", "assistant");
    m3.usage = Some(usage(1230));
    repo.append_messages("s1", &[m3]).await.unwrap();

    // s2：两条消息，没有任何用量 → 占用为 None（界面上显示 '-'，而不是 0%）
    repo.append_messages(
        "s2",
        &[test_message("u1", "user"), test_message("a1", "assistant")],
    )
    .await
    .unwrap();

    let stats = repo.session_stats().await.unwrap();
    let find = |id: &str| {
        stats
            .iter()
            .find(|s| s.session_id == id)
            .unwrap_or_else(|| panic!("缺少会话 {id} 的统计"))
    };
    assert_eq!(find("s1").messages, 3, "条数必须是全量计数");
    assert_eq!(find("s1").context_tokens, Some(1230));
    assert_eq!(find("s2").messages, 2);
    assert_eq!(find("s2").context_tokens, None);
}

/// 压缩产物（summary）带 `uiData.contextTokens` → 必须**优先于它自己那条的 usage**
/// （否则会显示成「压缩后反而更大」，这正是 compress 口径存在的原因）
#[tokio::test]
async fn compression_product_wins_over_its_own_usage() {
    let repo = open_tmp();
    repo.upsert_session(&test_session("s1", "t", 1)).await.unwrap();

    let mut summary = test_message("sum", "summary");
    summary.usage = Some(usage(90_100));
    summary.ui_data = Some(json!({ "compressMode": "ai", "contextTokens": 8_000 }));
    repo.append_messages("s1", &[test_message("m1", "user"), summary])
        .await
        .unwrap();

    let stats = repo.session_stats().await.unwrap();
    assert_eq!(stats.len(), 1);
    assert_eq!(stats[0].context_tokens, Some(8_000));
}

/// `uiData` 里**没有** contextTokens（其它用途的 ui_data）时不该当作用量，
/// 继续往前找真正带用量的消息
#[tokio::test]
async fn ui_data_without_context_tokens_falls_back_to_usage() {
    let repo = open_tmp();
    repo.upsert_session(&test_session("s1", "t", 1)).await.unwrap();

    let mut a = test_message("a1", "assistant");
    a.usage = Some(usage(5_000));
    let mut later = test_message("a2", "assistant");
    later.ui_data = Some(json!({ "someOtherField": true }));
    repo.append_messages("s1", &[a, later]).await.unwrap();

    let stats = repo.session_stats().await.unwrap();
    assert_eq!(stats[0].context_tokens, Some(5_000));
}

/// 空库 / 无消息的会话不产生统计行（调用方按「0 条 / 无占用」展示）
#[tokio::test]
async fn empty_repo_and_message_less_session_yield_nothing() {
    let repo = open_tmp();
    assert!(repo.session_stats().await.unwrap().is_empty());

    repo.upsert_session(&test_session("s9", "空会话", 1))
        .await
        .unwrap();
    assert!(
        repo.session_stats().await.unwrap().is_empty(),
        "只有消息的会话才该出现在统计里"
    );
}
