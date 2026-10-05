//! 记忆蒸馏素材（P2）：`day_materials` / `earliest_message_ts` / `usage_model_counts`
//!
//! 素材是**跨会话蒸馏**的输入，出错的代价很隐蔽（模型拿到错的素材 → 写出错的长期记忆）。
//! 因此这里逐条钉住：日界、摘要优先、降级链、排序与上限。

use super::{open_tmp, test_message, test_session};
use crate::agent::memory::consolidate::day_bounds_ms;
use crate::agent::types::Message;
use crate::session_db::repo::SessionRepo;
use crate::session_db::types::{
    MATERIAL_SUMMARY_MAX_CHARS, MATERIAL_TRANSCRIPT_CHARS_PER_SESSION,
    MATERIAL_TRANSCRIPT_MESSAGES_PER_SESSION,
};
use crate::session_db::UsageEntry;
use serde_json::json;

/// 造一条指定时间与角色的消息
fn msg_at(id: &str, role: &str, text: &str, ts: i64) -> Message {
    let mut m = test_message(id, role);
    m.content = json!(text);
    m.timestamp = ts;
    m
}

fn day_start(day: &str) -> i64 {
    day_bounds_ms(day).unwrap().0
}

async fn materials_for(repo: &dyn SessionRepo, day: &str) -> Vec<crate::session_db::SessionMaterial> {
    let (start, end) = day_bounds_ms(day).unwrap();
    repo.day_materials(start, end).await.unwrap()
}

#[tokio::test]
async fn summary_of_the_day_wins_over_dialogue() {
    let repo = open_tmp();
    repo.upsert_session(&test_session("s1", "记忆功能", 100)).await.unwrap();
    let base = day_start("2026-10-05");
    repo.append_messages(
        "s1",
        &[
            msg_at("u1", "user", "帮我实现记忆功能", base + 1_000),
            msg_at("a1", "assistant", "好的，先看结构", base + 2_000),
            msg_at("sum1", "summary", "已实现记忆注入链", base + 3_000),
        ],
    )
    .await
    .unwrap();

    let materials = materials_for(&repo, "2026-10-05").await;
    assert_eq!(materials.len(), 1);
    let m = &materials[0];
    assert_eq!(m.session_id, "s1");
    assert_eq!(m.title, "记忆功能");
    assert_eq!(m.workspace.as_deref(), Some("/ws"));
    assert_eq!(m.summary.as_deref(), Some("已实现记忆注入链"));
    assert!(m.transcript.is_empty(), "有摘要时不再抓正文（重复且更费 token）");
    assert!(!m.is_fallback());
    assert_eq!(m.text(), "已实现记忆注入链");
    assert_eq!(m.updated_at, base + 3_000);
}

#[tokio::test]
async fn last_summary_of_the_day_is_used() {
    let repo = open_tmp();
    repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
    let base = day_start("2026-10-05");
    repo.append_messages(
        "s1",
        &[
            msg_at("sum1", "summary", "上午的摘要", base + 1_000),
            msg_at("u1", "user", "继续", base + 2_000),
            msg_at("sum2", "summary", "下午的摘要（自包含）", base + 3_000),
        ],
    )
    .await
    .unwrap();

    let materials = materials_for(&repo, "2026-10-05").await;
    assert_eq!(
        materials[0].summary.as_deref(),
        Some("下午的摘要（自包含）"),
        "压缩摘要自包含 → 只留最后一条，否则同一段历史会被蒸馏多次"
    );
}

#[tokio::test]
async fn dialogue_excerpt_is_the_fallback_when_no_summary_exists() {
    let repo = open_tmp();
    repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
    let base = day_start("2026-10-05");
    repo.append_messages(
        "s1",
        &[
            msg_at("u1", "user", "第一个问题", base + 1_000),
            msg_at("a1", "assistant", "第一个回答", base + 2_000),
            // 工具结果不该进素材（是过程，不是结论）
            msg_at("t1", "tool", "工具结果一大堆", base + 3_000),
        ],
    )
    .await
    .unwrap();

    let materials = materials_for(&repo, "2026-10-05").await;
    assert_eq!(materials.len(), 1);
    let m = &materials[0];
    assert!(m.summary.is_none());
    assert!(m.is_fallback(), "无摘要 → 用正文摘录");
    assert!(m.transcript.contains("user: 第一个问题"));
    assert!(m.transcript.contains("assistant: 第一个回答"));
    assert!(!m.transcript.contains("工具结果"), "tool 消息不进素材");
}

#[tokio::test]
async fn day_boundary_excludes_neighbouring_days() {
    let repo = open_tmp();
    repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
    let today = day_start("2026-10-05");
    let yesterday_end = today - 1;
    let tomorrow = day_bounds_ms("2026-10-06").unwrap().0;
    repo.append_messages(
        "s1",
        &[
            msg_at("old", "summary", "前一天的", yesterday_end),
            msg_at("now", "summary", "当天的", today),
            msg_at("future", "summary", "第二天的", tomorrow),
        ],
    )
    .await
    .unwrap();

    let materials = materials_for(&repo, "2026-10-05").await;
    assert_eq!(materials.len(), 1);
    assert_eq!(
        materials[0].summary.as_deref(),
        Some("当天的"),
        "边界必须严格是 [当天 00:00, 次日 00:00)"
    );
}

#[tokio::test]
async fn sessions_without_usable_text_are_not_material() {
    let repo = open_tmp();
    repo.upsert_session(&test_session("s1", "只有工具消息", 100)).await.unwrap();
    repo.upsert_session(&test_session("s2", "只有空摘要", 100)).await.unwrap();
    let base = day_start("2026-10-05");
    repo.append_messages("s1", &[msg_at("t1", "tool", "结果", base + 1_000)])
        .await
        .unwrap();
    let mut empty_summary = msg_at("sum", "summary", "", base + 1_000);
    empty_summary.content = json!("");
    repo.append_messages("s2", &[empty_summary]).await.unwrap();

    assert!(
        materials_for(&repo, "2026-10-05").await.is_empty(),
        "没有可用素材 → 调用方据此记 skipped（不调模型、不花钱）"
    );
}

#[tokio::test]
async fn materials_are_ordered_old_to_new_and_capped() {
    let repo = open_tmp();
    repo.upsert_session(&test_session("s_late", "晚会话", 100)).await.unwrap();
    repo.upsert_session(&test_session("s_early", "早会话", 100)).await.unwrap();
    let base = day_start("2026-10-05");
    repo.append_messages("s_late", &[msg_at("l1", "summary", "晚", base + 9_000)])
        .await
        .unwrap();
    repo.append_messages("s_early", &[msg_at("e1", "summary", "早", base + 1_000)])
        .await
        .unwrap();

    let materials = materials_for(&repo, "2026-10-05").await;
    assert_eq!(
        materials.iter().map(|m| m.session_id.as_str()).collect::<Vec<_>>(),
        vec!["s_early", "s_late"],
        "旧 → 新：调用方按这个顺序裁预算（新内容最值钱）"
    );
}

#[tokio::test]
async fn long_summary_is_truncated_and_long_transcript_keeps_the_tail() {
    let repo = open_tmp();
    repo.upsert_session(&test_session("s1", "长摘要", 100)).await.unwrap();
    repo.upsert_session(&test_session("s2", "长对话", 100)).await.unwrap();
    let base = day_start("2026-10-05");
    repo.append_messages(
        "s1",
        &[msg_at("sum", "summary", &"摘".repeat(MATERIAL_SUMMARY_MAX_CHARS + 500), base + 1_000)],
    )
    .await
    .unwrap();
    // 30 轮对话：只留最后 N 条，且总长受字符上限约束
    let msgs: Vec<Message> = (0..30)
        .map(|i| msg_at(&format!("u{}", i), "user", &format!("第{}轮 {}", i, "字".repeat(300)), base + 2_000 + i))
        .collect();
    repo.append_messages("s2", &msgs).await.unwrap();

    let materials = materials_for(&repo, "2026-10-05").await;
    assert_eq!(materials.len(), 2);
    let long_summary = &materials[0];
    assert_eq!(
        long_summary.summary.as_ref().unwrap().chars().count(),
        MATERIAL_SUMMARY_MAX_CHARS
    );
    let long_dialog = &materials[1];
    assert!(long_dialog.transcript.chars().count() <= MATERIAL_TRANSCRIPT_CHARS_PER_SESSION);
    assert!(
        long_dialog.transcript.contains("第29轮"),
        "保留的是**最后**几轮（结论在后面）"
    );
    let kept_lines = long_dialog.transcript.lines().count();
    assert!(kept_lines <= MATERIAL_TRANSCRIPT_MESSAGES_PER_SESSION);
    assert!(!long_dialog.transcript.contains("第0轮"));
}

#[tokio::test]
async fn materials_stay_empty_outside_the_range_and_in_empty_db() {
    let repo = open_tmp();
    assert!(repo.earliest_message_ts().await.unwrap().is_none());
    repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
    let base = day_start("2026-10-05");
    repo.append_messages("s1", &[msg_at("u1", "user", "内容", base + 1_000)])
        .await
        .unwrap();

    assert_eq!(repo.earliest_message_ts().await.unwrap(), Some(base + 1_000));
    assert!(materials_for(&repo, "2026-10-04").await.is_empty(), "空区间");
    assert!(materials_for(&repo, "2026-10-06").await.is_empty());
    assert_eq!(materials_for(&repo, "2026-10-05").await.len(), 1);
}

#[tokio::test]
async fn usage_model_counts_orders_by_calls_and_filters_kind() {
    let repo = open_tmp();
    let entry = |kind: &str, pid: &str, model: &str| UsageEntry {
        session_id: Some("s1".into()),
        model: model.into(),
        provider_config_id: Some(pid.into()),
        kind: kind.into(),
        total_tokens: 1,
        ..Default::default()
    };
    repo.append_usage(&[
        entry("compress", "p1", "m-a"),
        entry("compress", "p1", "m-a"),
        entry("compress", "p1", "m-a"),
        entry("compress", "p2", "m-b"),
        entry("compress", "p2", "m-b"),
        // 别的类型不参与（蒸馏按「压缩用得最多」排序）
        entry("chat_round", "p3", "m-c"),
        entry("chat_round", "p3", "m-c"),
        entry("chat_round", "p3", "m-c"),
        entry("chat_round", "p3", "m-c"),
        // 无模型的流水不参与（历史数据补不回来）
        entry("compress", "p4", ""),
    ])
    .await
    .unwrap();

    let counts = repo.usage_model_counts("compress", 10).await.unwrap();
    assert_eq!(counts.len(), 2);
    assert_eq!(counts[0].model, "m-a");
    assert_eq!(counts[0].calls, 3);
    assert_eq!(counts[1].model, "m-b");
    assert_eq!(counts[1].provider_config_id, "p2");

    assert!(repo
        .usage_model_counts("memory", 10)
        .await
        .unwrap()
        .is_empty());
}
