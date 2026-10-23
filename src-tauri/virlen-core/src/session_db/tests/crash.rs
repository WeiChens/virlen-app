//! 崩溃语义（P0-2）：未定稿占位与悬空工具调用的**持久化**修复。
//!
//! 三条不变式：
//! 1. 正常会话修复零写入（`TailRepair::changed() == false`）；
//! 2. 崩溃痕迹一律幂等收口（重复修复不再改动）；
//! 3. 修复后的历史必须满足工具协议（每条 tool 结果都能对应上一条 assistant 的 tool_calls）。

use super::{open_tmp, test_message, test_session};
use crate::agent::message_protocol::INTERRUPTED_TOOL_RESULT;
use crate::agent::types::{Message, ToolUseContent};
use crate::session_db::repo::SessionRepo;
use crate::session_db::sqlite::SqliteSessionRepo;
use serde_json::json;

/// `messages.text_plain`（检索列）的当前值 —— 正文列与检索列的同步是下面几条用例的重点
fn text_plain_of(repo: &SqliteSessionRepo, id: &str) -> String {
    let conn = repo.conn.lock().unwrap();
    conn.query_row(
        "SELECT text_plain FROM messages WHERE id=?1",
        rusqlite::params![id],
        |row| row.get(0),
    )
    .unwrap()
}

async fn search_hits(repo: &dyn SessionRepo, query: &str) -> usize {
    repo.search_messages(query, Some("s1"), None, 10, None)
        .await
        .unwrap()
        .items
        .len()
}

/// 引擎在轮次开始时落下的未定稿占位
fn pending_placeholder(id: &str, content: &str) -> Message {
    let mut message = test_message(id, "assistant");
    message.content = json!(content);
    message.streaming = Some(true);
    message.model = Some("gpt-4o".into());
    message.ui_data = Some(json!({ "pending": true }));
    message
}

fn assistant_with_calls(id: &str, call_ids: &[&str]) -> Message {
    let mut message = test_message(id, "assistant");
    message.content = json!("");
    message.streaming = Some(false);
    message.tool_calls = Some(
        call_ids
            .iter()
            .map(|call_id| ToolUseContent {
                type_: "tool_use".into(),
                id: (*call_id).into(),
                name: "read_file".into(),
                input: json!({ "path": "a.txt" }),
            })
            .collect(),
    );
    message
}

fn tool_result(id: &str, call_id: &str, content: &str) -> Message {
    let mut message = test_message(id, "tool");
    message.content = json!(content);
    message.tool_call_id = Some(call_id.into());
    message
}

async fn seed(repo: &dyn SessionRepo, messages: &[Message]) {
    repo.upsert_session(&test_session("s1", "t", 100))
        .await
        .unwrap();
    repo.append_messages("s1", messages).await.unwrap();
}

#[tokio::test]
async fn healthy_tail_needs_no_repair() {
    let repo = open_tmp();
    seed(
        &repo,
        &[
            test_message("u1", "user"),
            {
                let mut m = test_message("a1", "assistant");
                m.content = json!("正常回答");
                m.streaming = Some(false);
                m
            },
        ],
    )
    .await;

    let report = repo.repair_tail("s1").await.unwrap();
    assert!(!report.changed(), "{report:?}");
}

#[tokio::test]
async fn pending_placeholder_with_text_is_marked_interrupted() {
    let repo = open_tmp();
    seed(&repo, &[pending_placeholder("a1", "说到一半就断了")]).await;

    let report = repo.repair_tail("s1").await.unwrap();
    assert_eq!(report.finalized, 1, "{report:?}");
    assert_eq!(report.dropped, 0);

    let stored = repo.get_messages("s1").await.unwrap();
    assert_eq!(stored.len(), 1);
    // 正文保留（模型能看到“这条回复被截断了”），标记清掉、pending 换成 interrupted
    assert_eq!(stored[0].content, json!("说到一半就断了"));
    assert_eq!(stored[0].streaming, Some(false));
    assert_eq!(stored[0].ui_data, Some(json!({ "interrupted": true })));
}

#[tokio::test]
async fn pending_placeholder_without_content_is_dropped() {
    let repo = open_tmp();
    seed(&repo, &[pending_placeholder("a1", "")]).await;

    let report = repo.repair_tail("s1").await.unwrap();
    assert_eq!(report.dropped, 1, "{report:?}");

    // 空 assistant 消息会让上游 400，必须整行删掉
    assert!(repo.get_messages("s1").await.unwrap().is_empty());
}

#[tokio::test]
async fn legacy_streaming_row_only_loses_its_flag() {
    let repo = open_tmp();
    // 旧版本定稿漏清 streaming（没有 pending 标记）：内容其实是完整的
    let mut message = test_message("a1", "assistant");
    message.content = json!("完整回答");
    message.streaming = Some(true);
    seed(&repo, &[message]).await;

    let report = repo.repair_tail("s1").await.unwrap();
    assert_eq!(report.finalized, 1, "{report:?}");

    let stored = repo.get_messages("s1").await.unwrap();
    assert_eq!(stored[0].streaming, Some(false));
    // 绝不把旧账标成“中断”（那会让用户以为回复被截断）
    assert_eq!(stored[0].ui_data, None);
    assert_eq!(stored[0].content, json!("完整回答"));
}

#[tokio::test]
async fn dangling_tool_calls_get_an_interrupted_result() {
    let repo = open_tmp();
    seed(
        &repo,
        &[
            test_message("u1", "user"),
            assistant_with_calls("a1", &["call_1", "call_2"]),
            tool_result("t1", "call_1", "第一个工具的结果"),
        ],
    )
    .await;

    let report = repo.repair_tail("s1").await.unwrap();
    assert_eq!(report.tool_results, 1, "{report:?}");

    let stored = repo.get_messages("s1").await.unwrap();
    assert_eq!(stored.len(), 4);
    let added = &stored[3];
    assert_eq!(added.role, "tool");
    assert_eq!(added.tool_call_id.as_deref(), Some("call_2"));
    assert_eq!(added.content, json!(INTERRUPTED_TOOL_RESULT));
    assert_eq!(added.is_error, Some(true));
    assert_eq!(added.ui_data, Some(json!({ "interrupted": true })));

    // 幂等：再修一次什么都不用做
    let again = repo.repair_tail("s1").await.unwrap();
    assert!(!again.changed(), "{again:?}");
    assert_eq!(repo.get_messages("s1").await.unwrap().len(), 4);
}

#[tokio::test]
async fn dangling_call_followed_by_user_message_is_left_to_request_repair() {
    let repo = open_tmp();
    // 悬空 assistant 之后已经排了用户消息：这里补会把结果排到用户消息后面，
    // 交给请求层 `repair_tool_protocol` 归位（它会把占位插到 assistant 之后）。
    seed(
        &repo,
        &[
            assistant_with_calls("a1", &["call_1"]),
            test_message("u2", "user"),
        ],
    )
    .await;

    let report = repo.repair_tail("s1").await.unwrap();
    assert_eq!(report.tool_results, 0, "{report:?}");
    assert!(!report.changed());
}

#[tokio::test]
async fn crash_mid_tool_round_repairs_both_symptoms() {
    let repo = open_tmp();
    // 一轮里崩在「已产出 tool_calls、工具还没跑完」：占位未定稿 + 一个结果缺失
    let mut pending = assistant_with_calls("a1", &["call_1"]);
    pending.streaming = Some(true);
    pending.ui_data = Some(json!({ "pending": true }));
    seed(&repo, &[test_message("u1", "user"), pending, tool_result("t1", "call_1", "ok")]).await;

    let report = repo.repair_tail("s1").await.unwrap();
    assert_eq!(report.finalized, 1, "{report:?}");
    assert_eq!(repo.get_messages("s1").await.unwrap()[1].streaming, Some(false));
}

#[tokio::test]
async fn empty_pending_placeholder_is_hidden_from_pages() {
    let repo = open_tmp();
    seed(
        &repo,
        &[test_message("u1", "user"), pending_placeholder("a1", "")],
    )
    .await;

    // 空壳不展示（否则重启后界面上是一个空气泡）
    let page = repo.get_message_page("s1", 10, None).await.unwrap();
    let ids: Vec<&str> = page.messages.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(ids, vec!["u1"]);

    // 但**数据仍在**：下一次发送时 repair_tail 会把它删掉（展示过滤不碰库）
    assert_eq!(repo.get_messages("s1").await.unwrap().len(), 2);

    // 有正文的未定稿回复必须展示（用户要看已经产出的部分）
    let repo2 = open_tmp();
    seed(
        &repo2,
        &[test_message("u1", "user"), pending_placeholder("a1", "半截")],
    )
    .await;
    let page = repo2.get_message_page("s1", 10, None).await.unwrap();
    assert_eq!(page.messages.len(), 2);
}

#[tokio::test]
async fn other_sessions_are_untouched() {
    let repo = open_tmp();
    seed(&repo, &[pending_placeholder("a1", "半截")]).await;
    repo.upsert_session(&test_session("s2", "t2", 100))
        .await
        .unwrap();
    let mut other = pending_placeholder("b1", "别的会话");
    other.streaming = Some(true);
    repo.append_messages("s2", &[other]).await.unwrap();

    repo.repair_tail("s1").await.unwrap();

    let s2 = repo.get_messages("s2").await.unwrap();
    assert_eq!(s2[0].streaming, Some(true), "修复必须限定在目标会话内");
}

/// 启动兜底：把最近活跃会话里的崩溃残留收口，健康会话零改动，且幂等。
#[tokio::test]
async fn startup_repair_sweeps_recent_sessions() {
    let repo = open_tmp();
    repo.upsert_session(&test_session("s1", "old", 100))
        .await
        .unwrap();
    repo.upsert_session(&test_session("s2", "new", 200))
        .await
        .unwrap();
    seed(&repo, &[pending_placeholder("a1", "半截")]).await;
    let mut healthy = test_message("a2", "assistant");
    healthy.content = json!("完整回答");
    healthy.streaming = Some(false);
    repo.append_messages("s2", &[healthy]).await.unwrap();

    assert_eq!(repo.repair_recent_tails().await.unwrap(), 1);

    let s1 = repo.get_messages("s1").await.unwrap();
    assert_eq!(s1[0].ui_data, Some(json!({ "interrupted": true })));
    assert_eq!(s1[0].streaming, Some(false));
    let s2 = repo.get_messages("s2").await.unwrap();
    assert_eq!(s2[0].ui_data, None, "健康会话不能被标成中断");

    // 幂等：再扫一次零改动
    assert_eq!(repo.repair_recent_tails().await.unwrap(), 0);
}

/// 流式途中被杀：定期落库的正文必须还在，并被标成「已中断」。
///
/// 这是崩溃验证的真实路径（用户实测：重开后连半截回复都看不到）—— 引擎过去只在结算时
/// 落 assistant 消息，流式途中的正文只存在内存里，进程一死就彻底消失。
#[tokio::test]
async fn streaming_partial_text_survives_kill() {
    let repo = open_tmp();
    // 轮次开始：引擎落下的空占位
    seed(&repo, &[pending_placeholder("a1", "")]).await;

    // 流式途中两个落库节流点（模拟 `STREAM_PERSIST_MS`）
    let mut snapshot = pending_placeholder("a1", "第一段");
    repo.persist_streaming_text("s1", &snapshot);
    snapshot.content = json!("第一段，第二段");
    repo.persist_streaming_text("s1", &snapshot);

    // 进程在此被杀 → 重开时读消息前先修复
    let report = repo.repair_tail("s1").await.unwrap();
    assert_eq!(report.dropped, 0, "有正文就不能当空壳丢掉: {report:?}");
    assert_eq!(report.finalized, 1);

    let stored = repo.get_messages("s1").await.unwrap();
    assert_eq!(stored.len(), 1);
    assert_eq!(stored[0].content, json!("第一段，第二段"));
    assert_eq!(stored[0].streaming, Some(false));
    assert_eq!(stored[0].ui_data, Some(json!({ "interrupted": true })));
}

/// 流式正文落库不得动 `ui_data` / `streaming`：那条行还在跑，只改正文列。
#[tokio::test]
async fn streaming_persist_only_touches_content() {
    let repo = open_tmp();
    seed(&repo, &[pending_placeholder("a1", "")]).await;

    let mut snapshot = pending_placeholder("a1", "进行中");
    snapshot.reasoning_content = Some("想一想".into());
    repo.persist_streaming_text("s1", &snapshot);

    let stored = repo.get_messages("s1").await.unwrap();
    assert_eq!(stored[0].content, json!("进行中"));
    assert_eq!(stored[0].reasoning_content.as_deref(), Some("想一想"));
    // pending / streaming 原样保留：此刻这一轮还活着，不能提前定稿
    assert_eq!(stored[0].streaming, Some(true));
    assert_eq!(stored[0].ui_data, Some(json!({ "pending": true })));
    // ⚠️ `text_plain` 刻意不跟：它一改就会触发 `messages_fts_au` 重建整段 trigram，
    // 而节流落库是 700ms 一次 × 当前全量正文 = 近似平方级。半截正文的检索由结算点补。
    assert_eq!(text_plain_of(&repo, "a1"), "");
}

/// 崩在流式中途：修复（定稿 + 标「已中断」）时必须把检索列补上 ——
/// 流式落库刻意不写它，否则这半截正文永远搜不到。
#[tokio::test]
async fn repair_tail_backfills_text_plain_for_partial_reply() {
    let repo = open_tmp();
    seed(&repo, &[pending_placeholder("a1", "")]).await;
    let snapshot = pending_placeholder("a1", "半截回复正文");
    repo.persist_streaming_text("s1", &snapshot);
    assert_eq!(text_plain_of(&repo, "a1"), "");

    let report = repo.repair_tail("s1").await.unwrap();
    assert_eq!(report.finalized, 1);
    assert_eq!(text_plain_of(&repo, "a1"), "半截回复正文");
    // 补了检索列 → 现在能搜到（索引只重建了这一次）
    assert_eq!(search_hits(&repo, "半截回复").await, 1);
}

/// `messages_fts_au` 必须带 `WHEN`：否则**任何** UPDATE（含每 700ms 一次的流式落库）
/// 都会把整段 `text_plain` 的 trigram 删掉重建。老库由 `ensure_fts_update_trigger` 补装。
#[tokio::test]
async fn fts_update_trigger_only_rebuilds_when_text_plain_changes() {
    let repo = open_tmp();
    // ① 触发器定义
    let trigger_sql: String = {
        let conn = repo.conn.lock().unwrap();
        conn.query_row(
            "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='messages_fts_au'",
            [],
            |row| row.get(0),
        )
        .unwrap()
    };
    assert!(
        trigger_sql.to_ascii_uppercase().contains("WHEN"),
        "messages_fts_au 缺 WHEN：每次流式落库都会重建整段 trigram: {trigger_sql}"
    );

    // ② 行为：只改非检索列 → 索引条目仍在
    let mut message = test_message("m1", "assistant");
    message.content = json!("苹果香蕉橘子");
    seed(&repo, &[message]).await;
    {
        let conn = repo.conn.lock().unwrap();
        conn.execute("UPDATE messages SET elapsed_ms=42 WHERE id='m1'", [])
            .unwrap();
    }
    assert_eq!(search_hits(&repo, "香蕉橘子").await, 1);

    // ③ 改 `text_plain` → 索引跟着换（外部内容表的正文取自这一列）
    {
        let conn = repo.conn.lock().unwrap();
        conn.execute("UPDATE messages SET text_plain='葡萄西瓜' WHERE id='m1'", [])
            .unwrap();
    }
    assert_eq!(search_hits(&repo, "香蕉橘子").await, 0);
    assert_eq!(search_hits(&repo, "葡萄西瓜").await, 1);
}
