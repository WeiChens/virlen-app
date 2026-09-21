//! 用量账本（token 统计）的回归测试

use super::{open_tmp, test_message, test_session};
use crate::session_db::repo::SessionRepo;
use crate::session_db::usage::{
    backfill_usage_ledger, repair_usage_ledger_model, UsageEntry, UsageQuery,
};
use serde_json::json;

// ===== 用量账本（token 统计） =====

fn usage_entry(id: Option<&str>, ts: i64, kind: &str, total: i64) -> UsageEntry {
    UsageEntry {
        ts: Some(ts),
        session_id: Some("s1".into()),
        message_id: id.map(String::from),
        model: "gpt-4o".into(),
        provider_type: Some("openai".into()),
        provider_config_id: Some("p1".into()),
        kind: kind.into(),
        round: Some(1),
        prompt_tokens: total - 20,
        completion_tokens: 20,
        cached_tokens: 0,
        total_tokens: total,
        estimated: false,
        trace_id: None,
    }
}

#[tokio::test]
async fn usage_append_is_idempotent_by_message_id() {
    let repo = open_tmp();
    repo.append_usage(&[usage_entry(Some("m1"), 1000, "chat_round", 100)])
        .await
        .unwrap();
    // 同一 message_id 重复写入（流式重试 / 重放）→ 不产生新流水
    repo.append_usage(&[usage_entry(Some("m1"), 1000, "chat_round", 100)])
        .await
        .unwrap();
    // 无 message_id 的调用（title / verify）每次都单独记账
    repo.append_usage(&[
        usage_entry(None, 1000, "title", 10),
        usage_entry(None, 1000, "title", 10),
    ])
    .await
    .unwrap();

    let stats = repo.usage_stats(&UsageQuery::default()).await.unwrap();
    assert_eq!(stats.totals.calls, 3);
    assert_eq!(stats.totals.total_tokens, 120);
    assert_eq!(stats.totals.estimated_calls, 0);
}

#[tokio::test]
async fn usage_stats_groups_and_filters() {
    let repo = open_tmp();
    repo.upsert_session(&test_session("s1", "会话一", 100)).await.unwrap();
    repo.append_usage(&[
        usage_entry(Some("m1"), 1_700_000_000_000, "chat_round", 100),
        usage_entry(Some("m2"), 1_700_000_000_000, "chat_round", 200),
        usage_entry(None, 1_700_100_000_000, "verify", 50),
    ])
    .await
    .unwrap();

    // 按类型分桶
    let by_kind = repo
        .usage_stats(&UsageQuery {
            group_by: Some("kind".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(by_kind.buckets.len(), 2);
    assert_eq!(by_kind.totals.total_tokens, 350);
    assert_eq!(by_kind.first_ts, Some(1_700_000_000_000));

    // 按时间过滤 + 按会话分桶（只命中前两条）
    let by_session = repo
        .usage_stats(&UsageQuery {
            to_ts: Some(1_700_000_000_001),
            group_by: Some("session".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(by_session.totals.total_tokens, 300);
    assert_eq!(by_session.buckets.len(), 1);
    assert_eq!(by_session.buckets[0].key, "s1");
    assert_eq!(by_session.buckets[0].calls, 2);

    // 按天分桶（tz-dependent：只断言桶数与合计，不写死日期）
    let by_day = repo
        .usage_stats(&UsageQuery {
            group_by: Some("day".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert!(!by_day.buckets.is_empty());
    assert_eq!(by_day.buckets.iter().map(|b| b.calls).sum::<i64>(), 3);

    // 按小时分桶（同样 tz-dependent：只断言合计）
    let by_hour = repo
        .usage_stats(&UsageQuery {
            group_by: Some("hour".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(by_hour.buckets.iter().map(|b| b.calls).sum::<i64>(), 3);
}

#[tokio::test]
async fn usage_records_join_session_title_and_survive_session_delete() {
    let repo = open_tmp();
    repo.upsert_session(&test_session("s1", "会话一", 100)).await.unwrap();
    repo.append_usage(&[usage_entry(Some("m1"), 2000, "chat_round", 100)])
        .await
        .unwrap();

    let page = repo.usage_records(&UsageQuery::default()).await.unwrap();
    assert_eq!(page.total, 1);
    assert_eq!(page.records[0].session_title.as_deref(), Some("会话一"));

    // 删会话只删对话内容，用量流水保留（口径见 docs/token-usage-stats.md）
    repo.delete_session("s1").await.unwrap();
    let page = repo.usage_records(&UsageQuery::default()).await.unwrap();
    assert_eq!(page.total, 1, "删会话后用量记录仍保留");
    assert_eq!(page.records[0].session_title, None);
}

/// 回归：带过滤条件时，COUNT 与明细查询必须用**同一张表别名**。
///
/// 曾经 COUNT 写成 `FROM usage_ledger`（无别名）却复用了 `u.ts >= ?` 的 WHERE，
/// SQLite 直接报 `no such column: u.ts` → 明细/导出在有时间过滤时全空。
#[tokio::test]
async fn usage_records_with_filters_matches_count() {
    let repo = open_tmp();
    repo.upsert_session(&test_session("s1", "会话一", 100)).await.unwrap();
    repo.append_usage(&[
        usage_entry(Some("m1"), 1_000, "chat_round", 100),
        usage_entry(Some("m2"), 5_000, "chat_round", 200),
    ])
    .await
    .unwrap();

    // 时间下界过滤
    let page = repo
        .usage_records(&UsageQuery {
            from_ts: Some(2_000),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(page.total, 1);
    assert_eq!(page.records.len(), 1);
    assert_eq!(page.records[0].total_tokens, 200);

    // 会话过滤（同样走 WHERE，同样会踩到别名问题）
    let page = repo
        .usage_records(&UsageQuery {
            session_id: Some("s1".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(page.total, 2);
    assert_eq!(page.records.len(), 2);

    // 分页参数编号必须在过滤参数之后（否则 LIMIT 会吃掉过滤值）
    let page = repo
        .usage_records(&UsageQuery {
            from_ts: Some(0),
            limit: Some(1),
            offset: Some(1),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(page.total, 2);
    assert_eq!(page.records.len(), 1);
    assert_eq!(page.records[0].total_tokens, 100, "按 ts DESC 取第二页 = 更早的一条");
}

#[tokio::test]
async fn usage_estimated_flag_and_clear() {
    let repo = open_tmp();
    let mut entry = usage_entry(Some("m1"), 3000, "compress", 80);
    entry.estimated = true;
    repo.append_usage(&[entry]).await.unwrap();

    let stats = repo.usage_stats(&UsageQuery::default()).await.unwrap();
    assert_eq!(stats.totals.estimated_calls, 1);

    let n = repo.clear_usage().await.unwrap();
    assert_eq!(n, 1);
    let stats = repo.usage_stats(&UsageQuery::default()).await.unwrap();
    assert_eq!(stats.totals.calls, 0);
    assert_eq!(stats.first_ts, None);
}

#[tokio::test]
async fn usage_backfill_from_messages_is_idempotent() {
    let repo = open_tmp();
    repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
    let mut with_usage = test_message("m1", "assistant");
    with_usage.usage = Some(serde_json::from_value(json!({
        "promptTokens": 10,
        "completionTokens": 5,
        "totalTokens": 15
    }))
    .unwrap());
    repo.append_messages("s1", &[with_usage]).await.unwrap();

    // 模拟升级迁移：从 messages.usage 回填（幂等，跑两次不翻倍）
    backfill_usage_ledger(&repo.conn).unwrap();
    backfill_usage_ledger(&repo.conn).unwrap();

    let stats = repo.usage_stats(&UsageQuery::default()).await.unwrap();
    assert_eq!(stats.totals.calls, 1);
    assert_eq!(stats.totals.total_tokens, 15);
    let page = repo.usage_records(&UsageQuery::default()).await.unwrap();
    assert_eq!(page.records[0].kind, "legacy");
    // 消息本身没存过 model（生产环境同此）→ 回退到会话的 model_id，
    // 否则历史流水取不到单价、费用恒为 0
    assert_eq!(page.records[0].model, "gpt-4o");
}

/// v2 → v3 修补：早于本修补的用户，历史流水的 model 是空串 → 费用恒为 0。
#[tokio::test]
async fn repair_usage_ledger_model_fills_from_session() {
    let repo = open_tmp();
    repo.upsert_session(&test_session("s1", "会话一", 100)).await.unwrap();

    let mut legacy = usage_entry(Some("m1"), 1_000, "legacy", 100);
    legacy.model = String::new(); // 模拟 v2 回填出来的空模型
    let mut orphan = usage_entry(Some("m2"), 2_000, "legacy", 100);
    orphan.model = String::new();
    orphan.session_id = Some("gone".into()); // 会话已删 → 无法补齐
    repo.append_usage(&[legacy, orphan]).await.unwrap();

    // 跑两次（迁移可重入）：结果必须一致，不得把已补好的值写坏
    repair_usage_ledger_model(&repo.conn).unwrap();
    repair_usage_ledger_model(&repo.conn).unwrap();

    let page = repo.usage_records(&UsageQuery::default()).await.unwrap();
    let by_id: std::collections::HashMap<String, String> = page
        .records
        .iter()
        .map(|r| (r.message_id.clone().unwrap_or_default(), r.model.clone()))
        .collect();
    assert_eq!(by_id["m1"], "gpt-4o");
    assert_eq!(by_id["m2"], "", "会话已删的流水补不上，保持空串");
}
