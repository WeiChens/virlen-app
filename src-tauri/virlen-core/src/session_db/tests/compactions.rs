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

async fn seed_in(repo: &dyn SessionRepo, session_id: &str, messages: &[Message]) {
    repo.upsert_session(&test_session(session_id, "t", 100))
        .await
        .unwrap();
    repo.append_messages(session_id, messages).await.unwrap();
}

async fn seed(repo: &dyn SessionRepo, messages: &[Message]) {
    seed_in(repo, "s1", messages).await;
}

/// 五条目标会话：m1 m2 m3 sum1 m4（会话内时序 1..=5）
fn five_messages() -> Vec<Message> {
    vec![
        user_msg("m1", "一"),
        user_msg("m2", "二"),
        user_msg("m3", "三"),
        summary_message("sum1"),
        user_msg("m4", "四"),
    ]
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

/// `get_context_messages` 的起点是**最早那条 summary**（而不是被遮罩区间的末条）：
/// summary 之前的区间已由它代表，从 summary 起读既不丢内容也不把压缩掉的历史再读进内存。
#[tokio::test]
async fn context_load_starts_at_the_masking_summary() {
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
    assert_eq!(
        ids,
        vec!["sum1", "m4"],
        "起点 = summary 本身（m3 在 summary 之前，同样已被它代表）"
    );
}

/**
 * 回归：`get_context_messages` 曾经用 `MIN(end_message_id)`（被遮罩区间**末条**）当窗口起点。
 *
 * 末条落在区间内部，于是「区间起点」永远在窗口外 → `apply_compaction_masks` 把这条记录整条丢掉。
 * 只压过一次时靠 provider 的「最后一条 summary」切片侥幸兑对了；压过两次以后，后一条 mask 生效、
 * 上下文里再无 `summary` 角色，窗口首条（无前置 user 的 assistant）就会原样发给模型
 * —— Anthropic 报 `first message must use the user role`。
 */
#[tokio::test]
async fn chained_compactions_do_not_leak_the_previous_span() {
    let repo = open_tmp();
    let mut a1 = test_message("a1", "assistant");
    a1.content = json!("答一");
    let mut a2 = test_message("a2", "assistant");
    a2.content = json!("答二");
    let mut a3 = test_message("a3", "assistant");
    a3.content = json!("答三");
    seed(
        &repo,
        &[
            user_msg("u1", "问一"),
            a1,
            user_msg("u2", "问二"),
            a2,
            summary_message("s1"),
            user_msg("u3", "问三"),
            a3,
            summary_message("s2"),
        ],
    )
    .await;
    // 第一次压缩：u1..a2 → s1；第二次压缩：s1..a3 → s2
    repo.record_compaction("s1", "u1", "a2", "s1")
        .await
        .unwrap();
    repo.record_compaction("s1", "s1", "a3", "s2")
        .await
        .unwrap();

    let context = repo.get_context_messages("s1").await.unwrap();
    let ids: Vec<&str> = context.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(
        ids,
        vec!["s1", "u3", "a3", "s2"],
        "窗口必须从最早的 summary 开始，不能把被遮罩区间的末条带出来"
    );

    // 逐条 mask 重建后只应剩下最后一代 summary（而且降级为 user，provider 不再按位置切片）
    let masks = repo.list_compactions("s1").await.unwrap();
    let built = crate::agent::context::apply_compaction_masks(&context, &masks);
    let built_ids: Vec<&str> = built.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(built_ids, vec!["s2"]);
    assert_eq!(built[0].role, "user");
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

/**
 * 回归（P0-3）：`boundary_seq` 的遮罩分支曾经返回**全局 rowid**，而不是会话内 1 基时序。
 *
 * `rowid` 跨会话全局单调：只要库里还有别的会话，`rowid` 就比「会话内时序」大出「其它会话的
 * 消息数」那么多 → 消费方的 `last_queryable = boundary - 1` 被同步放大 → 边界钳制失效，
 * `query_messages` 会把**已经在模型上下文里**的 summary 及其后消息再吐一遍。
 *
 * 为什么原来的测试抓不到：临时库只有 `s1` 一个会话，`rowid` 恰好等于会话内时序（1..=5），
 * `rowid + 1` 与正确值撞了个正着。本用例先灌 20 条噪音把 rowid 顶开。
 */
#[tokio::test]
async fn masked_boundary_is_session_seq_even_with_other_sessions() {
    let repo = open_tmp();
    // ① 另一个会话先占掉 rowid 1..=20：s1 的消息因此落在 rowid 21..=25
    let noise: Vec<Message> = (0..20)
        .map(|i| user_msg(&format!("n{i}"), "噪音"))
        .collect();
    seed_in(&repo, "s0", &noise).await;
    // ② 目标会话 + 遮罩 m1..m3
    seed(&repo, &five_messages()).await;
    repo.record_compaction("s1", "m1", "m3", "sum1")
        .await
        .unwrap();

    let page = repo
        .get_message_timeline("s1", None, None, 50)
        .await
        .unwrap();
    assert_eq!(
        page.boundary_seq,
        Some(4),
        "边界必须是会话内时序（m3 是第 3 条 → 4），不是全局 rowid（那会算出 24）"
    );
    let seqs: Vec<i64> = page.items.iter().map(|i| i.seq).collect();
    assert_eq!(
        seqs,
        vec![1, 2, 3],
        "可查询的只有已压缩区间；summary 及其后（已在上下文）不能返回"
    );
}

/**
 * 同一个单位错误在 `get_message_window` 一侧的表现：锚点落在「已在模型上下文」的区间时
 * 必须返回空窗口（由调用方转成提示），而不是把上下文里的消息再给模型一遍。
 */
#[tokio::test]
async fn masked_window_clamps_with_other_sessions_present() {
    let repo = open_tmp();
    let noise: Vec<Message> = (0..20)
        .map(|i| user_msg(&format!("n{i}"), "噪音"))
        .collect();
    seed_in(&repo, "s0", &noise).await;
    seed(&repo, &five_messages()).await;
    repo.record_compaction("s1", "m1", "m3", "sum1")
        .await
        .unwrap();

    // ① 锚点是 summary 之后的消息（m4 是第 5 条 > 边界 4）→ 空窗口
    let w = repo
        .get_message_window("s1", Some("m4"), None, 2, 2)
        .await
        .unwrap();
    assert!(
        w.messages.is_empty(),
        "m4 已在模型上下文里，不该再返回: {:?}",
        w.messages.iter().map(|m| &m.id).collect::<Vec<_>>()
    );
    assert!(w.clamped_by_boundary);

    // ② 锚点在压缩区间内 → 尾部收敛到边界（end ≤ 3）
    let w2 = repo
        .get_message_window("s1", Some("m1"), None, 0, 5)
        .await
        .unwrap();
    assert_eq!((w2.start_seq, w2.end_seq), (1, 3));
    assert!(w2.clamped_by_boundary);
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
