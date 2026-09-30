//! `session` 子命令的测试
//!
//! 两条硬约束（与 crate 既有约定一致）：
//! 1. **绝不读真实 stdin** —— `rm` / `purge` 的确认路径要么走 `--yes`（不读），要么在
//!    「会话不存在」时就已返回；需要读 stdin 的分支只由 [`needs_yes_gate`] 这类纯函数覆盖
//!    （真终端里跑测试会挂住，同 `provider/tests.rs` 只测解析的前例）。
//! 2. 端到端用例都打在**临时数据目录**上（真 SQLite，不触网）。

use serde_json::json;
use std::path::PathBuf;
use std::sync::Arc;
use virlen_core::agent::host::HostEnv;
use virlen_core::agent::types::{Message, Session, SessionParams};
use virlen_core::host::CliHost;
use virlen_core::session_db::{UsageEntry, UsageQuery};

use crate::{EXIT_ERROR, EXIT_OK, EXIT_USAGE};

use super::*;

fn args(v: &[&'static str]) -> Vec<&'static str> {
    v.to_vec()
}

/// 每个用例独占一个临时数据目录 —— 它就是「与桌面端同一个目录」的替身
fn temp_host() -> (Arc<dyn HostEnv>, PathBuf) {
    let dir = std::env::temp_dir().join(format!("virlen_cli_session_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    (Arc::new(CliHost::new(vec![], dir.clone())), dir)
}

fn session(id: &str, title: &str, updated: i64) -> Session {
    Session {
        id: id.to_string(),
        title: title.to_string(),
        messages: Vec::new(),
        provider_config_id: "p1".to_string(),
        model_id: "m1".to_string(),
        system_prompt: String::new(),
        params: SessionParams {
            temperature: 0.7,
            top_p: 1.0,
            max_tokens: 100,
            stream: true,
            reasoning_effort: None,
        },
        created_at: updated - 10,
        updated_at: updated,
        pinned: false,
        tags: Vec::new(),
        workspace: Some("E:/proj".to_string()),
        agent_id: None,
        allowed_tools: None,
        skills: None,
        system_prompt_manually_edited: None,
    }
}

fn msg(id: &str, role: &str, text: &str, ts: i64) -> Message {
    Message {
        id: id.to_string(),
        role: role.to_string(),
        content: json!(text),
        timestamp: ts,
        ..Default::default()
    }
}

async fn seed_session(host: &Arc<dyn HostEnv>, s: &Session, messages: &[Message]) {
    let db = open_db(host).unwrap();
    db.repo.upsert_session(s).await.unwrap();
    if !messages.is_empty() {
        db.repo.append_messages(&s.id, messages).await.unwrap();
    }
}

// ==================== 参数解析 ====================

#[test]
fn parse_requires_a_subcommand_and_accepts_help() {
    assert!(parse(args(&[])).is_err(), "缺子命令");
    assert_eq!(parse(args(&["-h"])), Ok(SessionCmd::Help));
    assert_eq!(parse(args(&["--help"])), Ok(SessionCmd::Help));
    assert!(parse(args(&["nope"])).is_err(), "未知子命令");
}

#[test]
fn parse_show_flags_and_errors() {
    assert_eq!(
        parse(args(&["show", "s1"])),
        Ok(SessionCmd::Show {
            id: "s1".into(),
            messages: 0,
            json: false
        })
    );
    assert_eq!(
        parse(args(&["show", "s1", "--messages", "5", "--json"])),
        Ok(SessionCmd::Show {
            id: "s1".into(),
            messages: 5,
            json: true
        })
    );
    assert!(parse(args(&["show"])).is_err(), "缺 id");
    assert!(parse(args(&["show", "s1", "s2"])).is_err(), "多给了 id");
    assert!(parse(args(&["show", "s1", "--messages"])).is_err(), "缺取值");
    assert!(parse(args(&["show", "s1", "--messages", "abc"])).is_err());
    assert!(parse(args(&["show", "s1", "--messages", "51"])).is_err(), "超上限");
    assert!(parse(args(&["show", "s1", "--nope"])).is_err(), "未知选项");
}

#[test]
fn parse_search_joins_words_and_validates() {
    // 关键词含空格：位置参数拼起来（与 `run` 的 prompt 同口径）
    assert_eq!(
        parse(args(&["search", "票据", "作废"])),
        Ok(SessionCmd::Search {
            keyword: "票据 作废".into(),
            session: None,
            limit: DEFAULT_SEARCH_LIMIT,
            json: false
        })
    );
    assert_eq!(
        parse(args(&["search", "kw", "--session", "s1", "--limit", "5", "--json"])),
        Ok(SessionCmd::Search {
            keyword: "kw".into(),
            session: Some("s1".into()),
            limit: 5,
            json: true
        })
    );
    assert!(parse(args(&["search"])).is_err(), "缺关键词");
    assert!(parse(args(&["search", "   "])).is_err(), "空白关键词");
    assert!(parse(args(&["search", "kw", "--limit", "0"])).is_err(), "0 不在 1..=100");
    assert!(parse(args(&["search", "kw", "--limit", "101"])).is_err(), "超上限");
    assert!(parse(args(&["search", "kw", "--session", ""])).is_err());
    assert!(parse(args(&["search", "kw", "--nope"])).is_err());
}

#[test]
fn parse_rm_and_purge() {
    assert_eq!(
        parse(args(&["rm", "s1"])),
        Ok(SessionCmd::Rm {
            id: "s1".into(),
            yes: false
        })
    );
    for flag in ["--yes", "-y"] {
        assert_eq!(
            parse(args(&["rm", "s1", flag])),
            Ok(SessionCmd::Rm {
                id: "s1".into(),
                yes: true
            })
        );
    }
    assert_eq!(
        parse(args(&["purge", "--yes"])),
        Ok(SessionCmd::Purge { yes: true })
    );
    assert_eq!(parse(args(&["purge"])), Ok(SessionCmd::Purge { yes: false }));
    assert!(parse(args(&["rm"])).is_err(), "缺 id");
    assert!(parse(args(&["rm", "a", "b"])).is_err(), "多给了 id");
    assert!(parse(args(&["rm", "s1", "--nope"])).is_err());
    assert!(parse(args(&["purge", "now"])).is_err(), "purge 不收位置参数");
}

/// fail-closed 红线：非终端 + 未给 `--yes` = 用法错误（两种放行组合各测一遍）
#[test]
fn needs_yes_gate_is_fail_closed() {
    assert_eq!(needs_yes_gate(true, false), Ok(()), "--yes 无需终端");
    assert_eq!(needs_yes_gate(true, true), Ok(()));
    assert_eq!(needs_yes_gate(false, true), Ok(()), "真终端可以问");
    assert_eq!(
        needs_yes_gate(false, false),
        Err(EXIT_USAGE),
        "管道里必须拒绝，不能默认放行"
    );
}

// ==================== 端到端（真 SQLite） ====================

#[tokio::test]
async fn show_reports_missing_session() {
    let (host, dir) = temp_host();
    let mut out: Vec<u8> = Vec::new();
    let mut err: Vec<u8> = Vec::new();
    let code = run(
        &host,
        SessionCmd::Show {
            id: "ghost".into(),
            messages: 0,
            json: false,
        },
        &mut out,
        &mut err,
    )
    .await;
    assert_eq!(code, EXIT_ERROR);
    assert!(out.is_empty(), "失败不该有 stdout 输出");
    assert!(String::from_utf8_lossy(&err).contains("会话不存在"));
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn show_prints_metadata_and_recent_messages() {
    let (host, dir) = temp_host();
    seed_session(
        &host,
        &session("s1", "票据问题", 300),
        &[
            msg("m1", "user", "第一条", 100),
            msg("m2", "assistant", "第二条", 200),
            msg("m3", "user", "第三条", 300),
        ],
    )
    .await;

    // 默认：只看元信息（不带消息预览）
    let mut out: Vec<u8> = Vec::new();
    let mut err: Vec<u8> = Vec::new();
    let code = run(
        &host,
        SessionCmd::Show {
            id: "s1".into(),
            messages: 0,
            json: false,
        },
        &mut out,
        &mut err,
    )
    .await;
    assert_eq!(code, EXIT_OK, "stderr={}", String::from_utf8_lossy(&err));
    let text = String::from_utf8_lossy(&out).to_string();
    assert!(text.contains("标题    : 票据问题"), "{text}");
    assert!(text.contains("模型    : m1"), "{text}");
    assert!(text.contains("工作目录: E:/proj"), "{text}");
    assert!(text.contains("消息数  : 3"), "{text}");
    assert!(!text.contains("第一条"), "默认不打印消息正文: {text}");

    // --messages 2：只看尾部两条（第三条 + 第二条）
    let mut out: Vec<u8> = Vec::new();
    let code = run(
        &host,
        SessionCmd::Show {
            id: "s1".into(),
            messages: 2,
            json: false,
        },
        &mut out,
        &mut err,
    )
    .await;
    assert_eq!(code, EXIT_OK);
    let text = String::from_utf8_lossy(&out).to_string();
    assert!(text.contains("最近 2 条消息"), "{text}");
    assert!(text.contains("第三条") && text.contains("第二条"), "{text}");
    assert!(!text.contains("第一条"), "只取尾部窗口: {text}");

    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn show_json_carries_session_and_messages() {
    let (host, dir) = temp_host();
    seed_session(
        &host,
        &session("s1", "标题", 300),
        &[msg("m1", "user", "你好", 100)],
    )
    .await;

    let mut out: Vec<u8> = Vec::new();
    let mut err: Vec<u8> = Vec::new();
    assert_eq!(
        run(
            &host,
            SessionCmd::Show {
                id: "s1".into(),
                messages: 1,
                json: true
            },
            &mut out,
            &mut err
        )
        .await,
        EXIT_OK
    );
    let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(v["session"]["id"], "s1");
    assert_eq!(v["session"]["messageCount"], 1);
    assert_eq!(v["session"]["contextWindowTokens"], 200_000);
    assert!(v["session"]["contextTokens"].is_null(), "无用量 → null，不是 0");
    assert_eq!(v["messagesRequested"], 1, "要能区分「没要预览」与「真没消息」");
    assert_eq!(v["messages"][0]["role"], "user");
    assert_eq!(v["messages"][0]["preview"], "你好");

    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn search_finds_across_sessions_and_respects_limit() {
    let (host, dir) = temp_host();
    seed_session(
        &host,
        &session("s1", "票据问题", 300),
        &[msg("m1", "user", "二维码被扫走了", 100)],
    )
    .await;
    seed_session(
        &host,
        &session("s2", "别的会话", 200),
        &[msg("m2", "assistant", "二维码已经过期", 150)],
    )
    .await;

    // 跨会话：两条命中
    let mut out: Vec<u8> = Vec::new();
    let mut err: Vec<u8> = Vec::new();
    assert_eq!(
        run(
            &host,
            SessionCmd::Search {
                keyword: "二维码".into(),
                session: None,
                limit: 20,
                json: false
            },
            &mut out,
            &mut err
        )
        .await,
        EXIT_OK,
        "stderr={}",
        String::from_utf8_lossy(&err)
    );
    let text = String::from_utf8_lossy(&out).to_string();
    assert!(text.contains("命中 2 条"), "{text}");
    assert!(text.contains("[票据问题]") && text.contains("[别的会话]"), "跨会话要带标题: {text}");

    // --limit 1：只剩最新那条（按时间倒序）
    let mut out: Vec<u8> = Vec::new();
    assert_eq!(
        run(
            &host,
            SessionCmd::Search {
                keyword: "二维码".into(),
                session: None,
                limit: 1,
                json: false
            },
            &mut out,
            &mut err
        )
        .await,
        EXIT_OK
    );
    let text = String::from_utf8_lossy(&out).to_string();
    assert!(text.contains("命中 1 条"), "{text}");
    assert!(text.contains("二维码已经过期"), "最新的那条: {text}");

    // --session 限定：只剩 s1 那条，且不再重复打印会话标题
    let mut out: Vec<u8> = Vec::new();
    assert_eq!(
        run(
            &host,
            SessionCmd::Search {
                keyword: "二维码".into(),
                session: Some("s1".into()),
                limit: 20,
                json: false
            },
            &mut out,
            &mut err
        )
        .await,
        EXIT_OK
    );
    let text = String::from_utf8_lossy(&out).to_string();
    assert!(text.contains("命中 1 条"), "{text}");
    assert!(!text.contains("["), "单会话检索不打印标题列: {text}");

    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn search_no_hit_and_json_shape() {
    let (host, dir) = temp_host();
    seed_session(
        &host,
        &session("s1", "标题", 300),
        &[msg("m1", "user", "普通内容", 100)],
    )
    .await;

    let mut out: Vec<u8> = Vec::new();
    let mut err: Vec<u8> = Vec::new();
    assert_eq!(
        run(
            &host,
            SessionCmd::Search {
                keyword: "绝不出现".into(),
                session: None,
                limit: 20,
                json: false
            },
            &mut out,
            &mut err
        )
        .await,
        EXIT_OK
    );
    assert!(String::from_utf8_lossy(&out).contains("没有命中"));

    let mut out: Vec<u8> = Vec::new();
    assert_eq!(
        run(
            &host,
            SessionCmd::Search {
                keyword: "普通".into(),
                session: None,
                limit: 20,
                json: true
            },
            &mut out,
            &mut err
        )
        .await,
        EXIT_OK
    );
    let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(v["query"], "普通");
    assert_eq!(v["count"], 1);
    assert_eq!(v["hasMore"], false);
    assert_eq!(v["items"][0]["sessionId"], "s1");
    assert_eq!(v["items"][0]["sessionTitle"], "标题");

    std::fs::remove_dir_all(&dir).ok();
}

/// 会话不存在时**先**失败，绝不进入确认流程（这条也保证本用例不碰 stdin）
#[tokio::test]
async fn rm_missing_session_fails_before_confirm() {
    let (host, dir) = temp_host();
    let mut out: Vec<u8> = Vec::new();
    let mut err: Vec<u8> = Vec::new();
    let code = run(
        &host,
        SessionCmd::Rm {
            id: "ghost".into(),
            yes: false,
        },
        &mut out,
        &mut err,
    )
    .await;
    assert_eq!(code, EXIT_ERROR);
    assert!(String::from_utf8_lossy(&err).contains("会话不存在"));
    std::fs::remove_dir_all(&dir).ok();
}

/// `--yes` 路径：删会话 + 它的消息，但**不动**用量账本（与 `provider rm` 同一条确认口径）
#[tokio::test]
async fn rm_yes_deletes_session_but_keeps_usage_ledger() {
    let (host, dir) = temp_host();
    seed_session(
        &host,
        &session("s1", "要删的", 300),
        &[msg("m1", "user", "你好", 100)],
    )
    .await;
    {
        let db = open_db(&host).unwrap();
        db.repo
            .append_usage(&[UsageEntry {
                session_id: Some("s1".into()),
                message_id: Some("m1".into()),
                model: "m1".into(),
                kind: "chat_round".into(),
                prompt_tokens: 10,
                completion_tokens: 5,
                total_tokens: 15,
                ..Default::default()
            }])
            .await
            .unwrap();
    }

    let mut out: Vec<u8> = Vec::new();
    let mut err: Vec<u8> = Vec::new();
    let code = run(
        &host,
        SessionCmd::Rm {
            id: "s1".into(),
            yes: true,
        },
        &mut out,
        &mut err,
    )
    .await;
    assert_eq!(code, EXIT_OK, "stderr={}", String::from_utf8_lossy(&err));
    let text = String::from_utf8_lossy(&out).to_string();
    assert!(text.contains("已删除会话 s1"), "{text}");
    assert!(text.contains("1 条消息"), "应报出连带删除的条数: {text}");
    assert!(
        String::from_utf8_lossy(&err).contains("用量账本不受影响"),
        "必须说明账本不清"
    );

    let db = open_db(&host).unwrap();
    assert!(db.repo.get_session("s1").await.unwrap().is_none());
    assert!(db.repo.get_messages("s1").await.unwrap().is_empty());
    let stats = db.repo.usage_stats(&UsageQuery::default()).await.unwrap();
    assert_eq!(stats.totals.calls, 1, "用量流水不能被连带删除");
    assert_eq!(stats.totals.total_tokens, 15);

    std::fs::remove_dir_all(&dir).ok();
}

/// 孤儿消息 = `session_id` 指向不存在会话的行（早期版本删会话时还有 run 在跑会留下）
///
/// ⚠️ 这里只能验「0 条」那条路：`open_session_db` 会 spawn 一次后台回收，与本命令的前台回收
/// 谁先跑完不确定（造「有孤儿」会 flaky）。非 0 分支由 [`purge_line`] 的纯函数用例覆盖。
#[tokio::test]
async fn purge_on_normal_database_reports_zero() {
    let (host, dir) = temp_host();
    seed_session(
        &host,
        &session("s1", "正常会话", 300),
        &[msg("m1", "user", "在", 100)],
    )
    .await;

    let mut out: Vec<u8> = Vec::new();
    let mut err: Vec<u8> = Vec::new();
    assert_eq!(
        run(&host, SessionCmd::Purge { yes: true }, &mut out, &mut err).await,
        EXIT_OK,
        "stderr={}",
        String::from_utf8_lossy(&err)
    );
    assert!(String::from_utf8_lossy(&out).contains("0 条"));

    // 正常会话的消息没被误删
    let db = open_db(&host).unwrap();
    assert_eq!(db.repo.get_messages("s1").await.unwrap().len(), 1);

    std::fs::remove_dir_all(&dir).ok();
}

/// 非 0 分支的渲染（真端到端造不出来，见上一个用例的注释）
#[test]
fn purge_line_covers_both_branches() {
    assert!(purge_line(0).contains("0 条"));
    assert_eq!(purge_line(1), "已回收 1 条孤儿消息");
    assert_eq!(purge_line(37), "已回收 37 条孤儿消息");
}

/// `--help` 不碰数据库
#[tokio::test]
async fn help_does_not_touch_database() {
    let (host, dir) = temp_host();
    let mut out: Vec<u8> = Vec::new();
    let mut err: Vec<u8> = Vec::new();
    assert_eq!(
        run(&host, SessionCmd::Help, &mut out, &mut err).await,
        EXIT_OK
    );
    assert!(String::from_utf8_lossy(&out).contains("用法:"));
    assert!(!dir.join("virlen.db").exists(), "help 不得建库");
    std::fs::remove_dir_all(&dir).ok();
}
