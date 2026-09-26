//! `session_rt` 的集成测试 —— **真实 SQLite + 真实装配链**
//!
//! 只测「胶水」：装配 → 压缩执行链（闸门 / 落库 / 快照 / 报告 / 失败原子性）。
//! 压缩本身的语义（两种模式、口径、渲染、记账口径）在 `virlen_core::agent::compress` 里单测 ——
//! 两边不重复断言同一件事。
//!
//! `ai` 模式的**网络调用**不在这里测（需要一个真 Provider）：它的请求形状与非流式边界
//! 由 core 的 mock provider 单测覆盖。

use super::*;
use serde_json::{json, Map, Value};
use std::path::PathBuf;
use std::sync::Arc;
use virlen_core::agent::compress::CompressMode;
use virlen_core::agent::host::HostEnv;
use virlen_core::agent::types::{Message, TokenUsage};
use virlen_core::host::CliHost;
use virlen_core::session_db::open_session_db;

/// 造一个「配置够用」的临时运行时：一个启用的 openai 兼容 Provider + 默认模型，
/// 然后走**生产那条**装配链（`bootstrap_chat`）。
async fn runtime() -> (SessionRuntime, PathBuf) {
    let dir = std::env::temp_dir().join(format!("virlen_cli_srt_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let host: Arc<dyn HostEnv> = Arc::new(CliHost::new(vec![], dir.clone()));
    {
        let db = open_session_db(host.as_ref(), &|fut| {
            tokio::spawn(fut);
        })
        .unwrap();
        let mut entries = Map::new();
        entries.insert(
            "providers".into(),
            json!([{
                "id": "p1",
                "type": "openai",
                "name": "本地",
                "apiKey": "k",
                "baseUrl": "http://127.0.0.1:1",
                "models": ["m1"],
                "enabled": true
            }]),
        );
        entries.insert(
            "defaultSelectModel".into(),
            json!({ "providerConfigId": "p1", "modelId": "m1" }),
        );
        db.settings.upsert(entries).await.unwrap();
    }
    let rt = SessionRuntime::bootstrap_chat(&host, RunOptions::default())
        .await
        .expect("装配应成功（配置齐全）");
    (rt, dir)
}

fn msg(id: &str, role: &str, text: &str) -> Message {
    Message {
        id: id.into(),
        role: role.into(),
        content: Value::String(text.into()),
        timestamp: 10,
        ..Default::default()
    }
}

fn with_usage(mut m: Message, total: i64) -> Message {
    m.usage = Some(TokenUsage {
        prompt_tokens: total - 10,
        completion_tokens: 10,
        total_tokens: total,
        cached_tokens: None,
    });
    m
}

/// 正文压缩：闸门 → 压缩 → **落库** → 快照/占用刷新 → 再压被闸门拦下
#[tokio::test]
async fn raw_compress_appends_summary_and_refreshes_snapshot() {
    let (mut rt, dir) = runtime().await;
    let sid = rt.session.id.clone();
    rt.db
        .repo
        .append_messages(
            &sid,
            &[
                msg("u1", "user", "第一个问题"),
                msg("a1", "assistant", "第一个回答"),
                // 90k / 200k = 45% → 过 40% 闸门
                with_usage(msg("a2", "assistant", "第二个回答"), 90_000),
            ],
        )
        .await
        .unwrap();

    let report = compress_session(&mut rt, CompressMode::Raw)
        .await
        .expect("有历史且占用够高 → 应压缩成功");
    assert_eq!(report.mode, CompressMode::Raw);
    assert_eq!(report.before, Some(90_000));
    assert!(report.after < 90_000, "压缩后占用必须变小");
    assert_eq!(report.message_count, 4, "原 3 条 + 1 条 summary");
    assert!(report.llm.is_none(), "正文压缩没有模型调用（不记账）");
    assert!(
        report_line(&report).contains("正文压缩"),
        "结果行要写明方式"
    );

    // 落库：只**追加**一条 summary（旧消息留在库里，供模型侧查询工具检索「已压缩区间」）
    let stored = rt.db.repo.get_messages(&sid).await.unwrap();
    assert_eq!(stored.len(), 4);
    let last = stored.last().unwrap();
    assert_eq!(last.role, "summary");
    assert_eq!(last.ui_data.as_ref().unwrap()["compressMode"], json!("raw"));
    assert_eq!(
        last.ui_data.as_ref().unwrap()["contextTokens"],
        json!(report.after)
    );
    assert!(
        last.content.as_str().unwrap().contains("第一个问题"),
        "正文压缩的产物必须自包含（模型只看到 summary）"
    );

    // 快照 + 占用口径：summary 的 contextTokens **优先于**它自己那条的 usage
    assert_eq!(rt.messages.len(), 4);
    assert!(rt.messages.last().unwrap().role == "summary");
    assert_eq!(current_context_tokens(&rt).await, Some(report.after));

    // 再压一次：此时占用已很低 → 被 40% 闸门拦下（是 Skipped，不是 Failed）
    match compress_session(&mut rt, CompressMode::Raw).await {
        Err(CompressError::Skipped(m)) => assert!(m.contains("很充裕"), "实际: {m}"),
        other => panic!("应被闸门拦下，实际: {other:?}"),
    }

    std::fs::remove_dir_all(&dir).ok();
}

/// 只有 1 条消息：过了闸门但压缩本身无事可做 → 真失败，且**不得留下任何 summary**
/// （要么压了、要么没压；半成品落库会让下一轮请求看到一条空摘要）
#[tokio::test]
async fn compress_failure_leaves_no_partial_summary() {
    let (mut rt, dir) = runtime().await;
    let sid = rt.session.id.clone();
    rt.db
        .repo
        .append_messages(&sid, &[with_usage(msg("a1", "assistant", "唯一一条"), 90_000)])
        .await
        .unwrap();

    match compress_session(&mut rt, CompressMode::Raw).await {
        Err(CompressError::Failed(m)) => assert!(m.contains("至少需要 2 条"), "实际: {m}"),
        other => panic!("应为 Failed，实际: {other:?}"),
    }
    assert_eq!(
        rt.db.repo.get_messages(&sid).await.unwrap().len(),
        1,
        "失败不得写入半成品"
    );
    assert_eq!(rt.messages.len(), 0, "快照也不该被改动");

    std::fs::remove_dir_all(&dir).ok();
}

/// 闸门对「没有用量数据」的会话同样生效，并且**说清原因**（不是一句「压缩失败」）
#[tokio::test]
async fn compress_without_usage_data_is_skipped_with_a_reason() {
    let (mut rt, dir) = runtime().await;
    let sid = rt.session.id.clone();
    rt.db
        .repo
        .append_messages(&sid, &[msg("u1", "user", "还没有回答"), msg("u2", "user", "新的提问")])
        .await
        .unwrap();

    match compress_session(&mut rt, CompressMode::Raw).await {
        Err(CompressError::Skipped(m)) => {
            assert!(m.contains("用量数据"), "要指明「为什么不能判断」: {m}")
        }
        other => panic!("应为 Skipped，实际: {other:?}"),
    }

    std::fs::remove_dir_all(&dir).ok();
}

/// `ai` 模式的最小可达失败：协议不支持（桥接类 Provider）必须在**装配期**报错，
/// 而不是发出去挂死（headless 没有 JS 宿主）
#[tokio::test]
async fn ai_mode_rejects_bridged_provider_before_calling() {
    let (mut rt, dir) = runtime().await;
    let sid = rt.session.id.clone();
    rt.db
        .repo
        .append_messages(
            &sid,
            &[
                with_usage(msg("u1", "user", "一"), 90_000),
                msg("u2", "user", "二"),
            ],
        )
        .await
        .unwrap();
    // 把会话的 Provider 换成 gemini（桥接协议）
    rt.resources.provider.provider_type = "gemini".to_string();

    match compress_session(&mut rt, CompressMode::Ai).await {
        Err(CompressError::Failed(m)) => {
            assert!(m.contains("headless") || m.contains("JS 桥"), "实际: {m}")
        }
        other => panic!("应为 Failed（装配期拒绝），实际: {other:?}"),
    }
    assert_eq!(rt.db.repo.get_messages(&sid).await.unwrap().len(), 2);

    std::fs::remove_dir_all(&dir).ok();
}
