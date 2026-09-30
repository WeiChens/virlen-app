//! `usage` 子命令的测试
//!
//! 端到端用例都打在**临时数据目录**的真 SQLite 上，并用 `append_usage` 预置流水 ——
//! 不去碰网络、也不依赖桌面端。时间桶的断言按**本机时区**算（core 的 SQL 用 `'localtime'`，
//! 测试里同样用 `chrono::Local`，两边同口径）。

use std::path::PathBuf;
use std::sync::Arc;
use virlen_core::agent::host::HostEnv;
use virlen_core::agent::types::{Session, SessionParams};
use virlen_core::host::CliHost;
use virlen_core::session_db::UsageEntry;

use crate::{EXIT_ERROR, EXIT_OK};

use super::*;

fn args(v: &[&'static str]) -> Vec<&'static str> {
    v.to_vec()
}

fn temp_host() -> (Arc<dyn HostEnv>, PathBuf) {
    let dir = std::env::temp_dir().join(format!("virlen_cli_usage_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    (Arc::new(CliHost::new(vec![], dir.clone())), dir)
}

/// 本地时间 → 毫秒（与 core 的 `'localtime'` 分桶同口径）
fn local_ms(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> i64 {
    let naive = chrono::NaiveDate::from_ymd_opt(y, mo, d)
        .unwrap()
        .and_hms_opt(h, mi, 0)
        .unwrap();
    chrono::TimeZone::from_local_datetime(&chrono::Local, &naive)
        .earliest()
        .unwrap()
        .timestamp_millis()
}

/// 一条流水（只写测试关心的字段）
fn entry(ts: i64, session: Option<&str>, model: &str, kind: &str, total: i64) -> UsageEntry {
    UsageEntry {
        ts: Some(ts),
        session_id: session.map(String::from),
        model: model.to_string(),
        kind: kind.to_string(),
        prompt_tokens: total - 100,
        completion_tokens: 100,
        total_tokens: total,
        ..Default::default()
    }
}

async fn seed_usage(host: &Arc<dyn HostEnv>, entries: Vec<UsageEntry>) {
    let db = open_db(host).unwrap();
    db.repo.append_usage(&entries).await.unwrap();
}

async fn seed_session(host: &Arc<dyn HostEnv>, id: &str, title: &str) {
    let db = open_db(host).unwrap();
    let now = virlen_core::telemetry::now_ms();
    db.repo
        .upsert_session(&Session {
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
            created_at: now,
            updated_at: now,
            pinned: false,
            tags: Vec::new(),
            workspace: None,
            agent_id: None,
            allowed_tools: None,
            skills: None,
            system_prompt_manually_edited: None,
        })
        .await
        .unwrap();
}

// ==================== 参数解析 ====================

#[test]
fn parse_defaults_and_flags() {
    assert_eq!(
        parse(args(&[])),
        Ok(UsageCmd::Report(UsageOptions::default()))
    );
    assert_eq!(
        parse(args(&[
            "--session", "s1", "--model", "m1", "--kind", "compress", "--group-by", "model",
            "--records", "--limit", "5", "--json"
        ])),
        Ok(UsageCmd::Report(UsageOptions {
            session: Some("s1".into()),
            model: Some("m1".into()),
            kind: Some("compress".into()),
            from: None,
            to: None,
            group_by: "model".into(),
            records: true,
            limit: 5,
            json: true,
        }))
    );
    // 维度大小写不敏感（用户敲 `--group-by Model` 也该认）
    assert_eq!(
        parse(args(&["--group-by", "Model"])),
        Ok(UsageCmd::Report(UsageOptions {
            group_by: "model".into(),
            ..Default::default()
        }))
    );
}

#[test]
fn parse_rejects_bad_values() {
    assert!(parse(args(&["--group-by", "minute"])).is_err(), "core 会静默退回 day，必须挡住");
    assert!(parse(args(&["--kind", "chat"])).is_err(), "类型的白名单");
    assert!(parse(args(&["--limit", "0"])).is_err());
    assert!(parse(args(&["--limit", "201"])).is_err());
    assert!(parse(args(&["--limit", "abc"])).is_err());
    assert!(parse(args(&["--session"])).is_err(), "缺取值");
    assert!(parse(args(&["--session", "  "])).is_err(), "空白取值");
    // chrono 的 `%m/%d` 宽容：`2026-9-1` 也认（不强迫补零）—— 但真错的格式必须报错
    assert!(parse_ts("2026-9-1", false).is_ok());
    assert!(parse(args(&["--since", "2026/09/01"])).is_err(), "拼写不支持");
    assert!(parse(args(&["--since", "2026-09-29", "--until", "2026-09-01"])).is_err(), "区间反了");
    assert!(parse(args(&["--nope"])).is_err(), "未知选项");
}

#[test]
fn parse_ts_dates_and_epoch() {
    // 日期：`--since` 当日 00:00；`--until` 当日 23:59:59.999（含当天）
    assert_eq!(parse_ts("2026-09-28", false).unwrap(), local_ms(2026, 9, 28, 0, 0));
    assert_eq!(
        parse_ts("2026-09-28", true).unwrap(),
        local_ms(2026, 9, 28, 23, 59) + 59_000 + 999
    );
    // 纯数字 = 毫秒时间戳
    assert_eq!(parse_ts("1759000000000", false).unwrap(), 1_759_000_000_000);
    assert!(parse_ts("昨天", false).is_err());
}

/// 空桶名的占位文案（`group_by=session/provider` 时都会遇到空 key）
#[test]
fn bucket_label_covers_empty_and_unknown_keys() {
    let mut titles = HashMap::new();
    titles.insert("s1".to_string(), "票据问题".to_string());

    assert_eq!(bucket_label("session", "s1", &titles), "票据问题");
    assert_eq!(bucket_label("session", "", &titles), "（无会话）");
    assert_eq!(bucket_label("session", "ghost", &titles), "ghost", "查不到标题就退回 id");
    assert_eq!(bucket_label("provider", "", &titles), "（未记录）");
    assert_eq!(bucket_label("model", "m1", &titles), "m1", "其它维度原样展示");
}

#[test]
fn help_variants() {
    for flag in ["-h", "--help"] {
        assert_eq!(parse(args(&[flag])), Ok(UsageCmd::Help));
    }
}

// ==================== 端到端（真 SQLite） ====================

#[tokio::test]
async fn empty_ledger_says_so_instead_of_printing_zeroes() {
    let (host, dir) = temp_host();
    let mut out: Vec<u8> = Vec::new();
    let mut err: Vec<u8> = Vec::new();
    let code = run(
        &host,
        UsageCmd::Report(UsageOptions::default()),
        &mut out,
        &mut err,
    )
    .await;
    assert_eq!(code, EXIT_OK, "stderr={}", String::from_utf8_lossy(&err));
    let text = String::from_utf8_lossy(&out).to_string();
    assert!(text.contains("没有匹配的流水"), "{text}");
    assert!(!text.contains("合计"), "空账本不该打印合计行: {text}");
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn report_groups_by_day_and_totals() {
    let (host, dir) = temp_host();
    seed_usage(
        &host,
        vec![
            entry(local_ms(2026, 9, 28, 10, 0), None, "m1", "chat_round", 1_000),
            entry(local_ms(2026, 9, 28, 11, 0), None, "m1", "chat_round", 2_000),
            entry(local_ms(2026, 9, 29, 9, 0), None, "m1", "chat_round", 4_000),
        ],
    )
    .await;

    let mut out: Vec<u8> = Vec::new();
    let mut err: Vec<u8> = Vec::new();
    assert_eq!(
        run(
            &host,
            UsageCmd::Report(UsageOptions::default()),
            &mut out,
            &mut err
        )
        .await,
        EXIT_OK
    );
    let text = String::from_utf8_lossy(&out).to_string();
    assert!(text.contains("按日分桶"), "{text}");
    assert!(text.contains("2026-09-28") && text.contains("2026-09-29"), "{text}");
    assert!(text.contains("数据范围:"), "要标出账本覆盖范围: {text}");
    assert!(text.contains("合计 3 次调用 · 7000 token"), "合计与精确 token 数: {text}");
    // 费用说明走 stderr（stdout 留给数据）
    assert!(
        String::from_utf8_lossy(&err).contains("只统计 token"),
        "stderr 要说明不含费用"
    );

    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn report_filters_and_session_titles() {
    let (host, dir) = temp_host();
    seed_session(&host, "s1", "票据问题").await;
    seed_usage(
        &host,
        vec![
            entry(local_ms(2026, 9, 28, 10, 0), Some("s1"), "m1", "chat_round", 1_000),
            entry(local_ms(2026, 9, 28, 11, 0), None, "m2", "compress", 500),
        ],
    )
    .await;

    // `--group-by session`：桶名换成标题（uuid 读不懂）
    let mut out: Vec<u8> = Vec::new();
    let mut err: Vec<u8> = Vec::new();
    assert_eq!(
        run(
            &host,
            UsageCmd::Report(UsageOptions {
                group_by: "session".into(),
                ..Default::default()
            }),
            &mut out,
            &mut err
        )
        .await,
        EXIT_OK
    );
    let text = String::from_utf8_lossy(&out).to_string();
    assert!(text.contains("按会话分桶"), "{text}");
    assert!(text.contains("票据问题"), "桶名应是会话标题: {text}");
    // 没有 session_id 的流水桶 key 是空串 —— 必须给人看得懂的占位，不能是空单元格
    assert!(text.contains("（无会话）"), "空 key 要有占位文案: {text}");

    // `--kind compress`：只算那一条
    let mut out: Vec<u8> = Vec::new();
    let code = run(
        &host,
        UsageCmd::Report(UsageOptions {
            kind: Some("compress".into()),
            json: true,
            ..Default::default()
        }),
        &mut out,
        &mut err,
    )
    .await;
    assert_eq!(code, EXIT_OK);
    let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(v["stats"]["totals"]["calls"], 1);
    assert_eq!(v["stats"]["totals"]["totalTokens"], 500);
    assert_eq!(v["query"]["kind"], "compress");
    assert_eq!(v["costIncluded"], false, "必须显式标注不含费用");
    assert!(v["records"].is_null(), "没给 --records 就没有明细");

    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn report_with_records_lists_recent_calls() {
    let (host, dir) = temp_host();
    seed_session(&host, "s1", "会话甲").await;
    seed_usage(
        &host,
        vec![
            entry(local_ms(2026, 9, 28, 10, 0), Some("s1"), "m1", "chat_round", 1_000),
            entry(local_ms(2026, 9, 29, 10, 0), Some("s1"), "m1", "title", 200),
        ],
    )
    .await;

    let mut out: Vec<u8> = Vec::new();
    let mut err: Vec<u8> = Vec::new();
    assert_eq!(
        run(
            &host,
            UsageCmd::Report(UsageOptions {
                records: true,
                limit: 5,
                json: true,
                ..Default::default()
            }),
            &mut out,
            &mut err
        )
        .await,
        EXIT_OK
    );
    let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
    let records = v["records"]["records"].as_array().unwrap();
    assert_eq!(records.len(), 2);
    assert_eq!(v["records"]["total"], 2);
    // 时间倒序：title 那条更新
    assert_eq!(records[0]["kind"], "title");
    assert_eq!(records[0]["sessionTitle"], "会话甲");
    // 未测量的耗时按 0 落库（UI 显示 `-`，JSON 里是 0）
    assert_eq!(records[0]["durationMs"], 0);

    // 人类可读路径：明细表带表头与总条数
    let mut out: Vec<u8> = Vec::new();
    assert_eq!(
        run(
            &host,
            UsageCmd::Report(UsageOptions {
                records: true,
                ..Default::default()
            }),
            &mut out,
            &mut err
        )
        .await,
        EXIT_OK
    );
    let text = String::from_utf8_lossy(&out).to_string();
    assert!(text.contains("最近 2 条明细（共 2 条）"), "{text}");

    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn help_does_not_touch_database() {
    let (host, dir) = temp_host();
    let mut out: Vec<u8> = Vec::new();
    let mut err: Vec<u8> = Vec::new();
    assert_eq!(run(&host, UsageCmd::Help, &mut out, &mut err).await, EXIT_OK);
    assert!(String::from_utf8_lossy(&out).contains("用法:"));
    assert!(!dir.join("virlen.db").exists(), "help 不得建库");
    std::fs::remove_dir_all(&dir).ok();
}

/// 账本打不开/建不了时是 `EXIT_ERROR` 而不是 panic（用「数据目录被占成文件」造失败）
#[tokio::test]
async fn open_failure_is_reported_as_error() {
    let dir = std::env::temp_dir().join(format!("virlen_cli_usage_bad_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    // 让 `virlen.db` 变成一个目录 → 打不开
    std::fs::create_dir_all(dir.join("virlen.db")).unwrap();
    let host: Arc<dyn HostEnv> = Arc::new(CliHost::new(vec![], dir.clone()));

    let mut out: Vec<u8> = Vec::new();
    let mut err: Vec<u8> = Vec::new();
    let code = run(
        &host,
        UsageCmd::Report(UsageOptions::default()),
        &mut out,
        &mut err,
    )
    .await;
    assert_eq!(code, EXIT_ERROR);
    assert!(String::from_utf8_lossy(&err).contains("打开数据库失败"));
    std::fs::remove_dir_all(&dir).ok();
}
