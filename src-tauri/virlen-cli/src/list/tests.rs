use virlen_core::agent::host::HostEnv;
use virlen_core::agent::types::Session;
use serde_json::{json, Map, Value};
use std::sync::Arc;

use crate::EXIT_OK;

use super::group::group_sessions;
use super::render::{brief, display_width, effective_limit, fmt_time, pad, pad_left};
use super::*;
use virlen_core::agent::types::SessionParams;
use virlen_core::host::CliHost;
use std::path::PathBuf;

fn args(v: &[&'static str]) -> Vec<&'static str> {
    v.to_vec()
}

/// 造一个会话（只关心列表用得到的字段）
fn session(id: &str, title: &str, agent: Option<&str>, ws: Option<&str>, updated: i64) -> Session {
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
        created_at: updated,
        updated_at: updated,
        pinned: false,
        tags: Vec::new(),
        workspace: ws.map(String::from),
        agent_id: agent.map(String::from),
        allowed_tools: None,
        skills: None,
        system_prompt_manually_edited: None,
    }
}

fn agent(id: &str, name: &str) -> AgentLite {
    AgentLite {
        id: id.to_string(),
        name: name.to_string(),
        description: String::new(),
        default_workspace: String::new(),
        default_model: AgentDefaultModel::default(),
        skills: Vec::new(),
        allow_tools: Vec::new(),
        created_at: 0,
        updated_at: 0,
    }
}

// ==================== 参数解析 ====================

#[test]
fn parse_sessions_defaults_and_flags() {
    assert_eq!(
        parse_sessions(args(&[])),
        Ok(SessionsCmd::List(ListSessionsOptions::default()))
    );
    assert_eq!(
        parse_sessions(args(&["-g", "agent"])),
        Ok(SessionsCmd::List(ListSessionsOptions {
            group: Some(GroupBy::Agent),
            ..Default::default()
        }))
    );
    // workdir / workspace 都认
    for raw in ["workdir", "workspace", "DIR"] {
        assert_eq!(
            parse_sessions(args(&["-g", raw])),
            Ok(SessionsCmd::List(ListSessionsOptions {
                group: Some(GroupBy::Workspace),
                ..Default::default()
            })),
            "取值 {raw}"
        );
    }
    assert_eq!(
        parse_sessions(args(&["--group", "agent", "--limit", "10", "--json"])),
        Ok(SessionsCmd::List(ListSessionsOptions {
            group: Some(GroupBy::Agent),
            limit: Some(10),
            json: true,
        }))
    );
    // 0 = 全部
    assert_eq!(
        parse_sessions(args(&["--limit", "0"])),
        Ok(SessionsCmd::List(ListSessionsOptions {
            limit: Some(0),
            ..Default::default()
        }))
    );
}

#[test]
fn parse_sessions_help_and_errors() {
    for flag in ["-h", "--help"] {
        assert_eq!(parse_sessions(args(&[flag])), Ok(SessionsCmd::Help));
    }
    assert!(parse_sessions(args(&["-g"])).is_err(), "缺取值");
    assert!(parse_sessions(args(&["-g", "nope"])).is_err(), "非法分组维度");
    assert!(parse_sessions(args(&["--limit", "-1"])).is_err(), "负数");
    assert!(parse_sessions(args(&["--limit", "abc"])).is_err(), "非数字");
    assert!(parse_sessions(args(&["--limit", "1001"])).is_err(), "超上限");
    assert!(parse_sessions(args(&["--nope"])).is_err(), "未知选项");
}

#[test]
fn parse_agents_flags_and_errors() {
    assert_eq!(
        parse_agents(args(&[])),
        Ok(AgentsCmd::List(ListAgentsOptions::default()))
    );
    assert_eq!(
        parse_agents(args(&["--json"])),
        Ok(AgentsCmd::List(ListAgentsOptions { json: true }))
    );
    assert_eq!(parse_agents(args(&["--help"])), Ok(AgentsCmd::Help));
    assert!(parse_agents(args(&["nope"])).is_err());
}

// ==================== 分组 ====================

#[test]
fn group_by_agent_orders_known_then_unknown_then_ungrouped() {
    let agents = vec![agent("a1", "Virlen"), agent("a2", "Reviewer")];
    let sessions = vec![
        session("s1", "未分组会话", None, Some("E:/p"), 300),
        session("s2", "a1 会话", Some("a1"), Some("E:/p"), 200),
        session("s3", "未知 agent 会话", Some("ghost"), Some("E:/q"), 100),
        session("s4", "a2 会话", Some("a2"), Some("E:/q"), 50),
    ];
    let groups = group_sessions(sessions, GroupBy::Agent, &agents);
    let names: Vec<&str> = groups.iter().map(|g| g.name.as_str()).collect();
    // 已知（按名称升序）→ 未知 → 未分组垫底
    assert_eq!(names, vec!["Reviewer", "Virlen", "未知代理", "未分组"]);
    assert_eq!(groups[0].sessions[0].id, "s4", "组内保持输入顺序");
    assert_eq!(groups[3].sessions[0].id, "s1");
}

#[test]
fn group_by_workspace_uses_path_and_ungrouped_for_empty() {
    let sessions = vec![
        session("s1", "空目录", Some("a1"), Some("   "), 300),
        session("s2", "在 E:/p", Some("a1"), Some("E:/p"), 200),
        session("s3", "在 E:/q", Some("a1"), Some("E:/q"), 100),
    ];
    let groups = group_sessions(sessions, GroupBy::Workspace, &[]);
    let names: Vec<&str> = groups.iter().map(|g| g.name.as_str()).collect();
    assert_eq!(names, vec!["E:/p", "E:/q", "未分组"]);
    assert_eq!(groups[2].sessions[0].id, "s1", "空白工作目录 = 未分组");
}

// ==================== 渲染小工具 ====================

#[test]
fn brief_flattens_and_truncates_by_display_width() {
    assert_eq!(brief("a\nb", 10), "a b");
    // ASCII：不超过 max_cols 列
    assert_eq!(brief("abcdef", 3), "ab…");
    // 中文按 2 列：6 列 ≈ 2 个汉字 + 省略号
    assert_eq!(brief("中文标题", 6), "中文…");
    assert_eq!(display_width("中文"), 4);
}

#[test]
fn pad_aligns_cjk_by_display_width() {
    // 「会话数」= 6 列，补齐到 8 列应再补 2 个空格
    assert_eq!(pad_left("会话数", 8), "  会话数");
    assert_eq!(pad_left("1", 4), "   1");
    assert_eq!(pad("模型", 8), "模型    ");
}

#[test]
fn effective_limit_defaults_and_all() {
    assert_eq!(effective_limit(None), DEFAULT_LIMIT);
    assert_eq!(effective_limit(Some(0)), MAX_LIMIT);
    assert_eq!(effective_limit(Some(7)), 7);
}

#[test]
fn fmt_time_handles_out_of_range() {
    assert_eq!(fmt_time(i64::MAX), "-");
    assert!(fmt_time(0).starts_with("19"), "1970 年（本地时区）: {}", fmt_time(0));
}

#[test]
fn parse_agents_value_skips_bad_items() {
    let raw = json!([
        { "id": "a1", "name": "Virlen", "defaultModel": { "modelId": "m1" } },
        { "bogus": true },
        "not-an-object"
    ]);
    let list = parse_agents_value(Some(&raw));
    assert_eq!(list.len(), 1, "坏项被跳过");
    assert_eq!(list[0].id, "a1");
    assert_eq!(list[0].default_model.model_id, "m1");
    assert!(parse_agents_value(None).is_empty());
}

// ==================== 端到端（真 SQLite，不触网） ====================

fn temp_host() -> (Arc<dyn HostEnv>, PathBuf) {
    let dir = std::env::temp_dir().join(format!("virlen_cli_list_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    (Arc::new(CliHost::new(vec![], dir.clone())), dir)
}

async fn seed(
    host: &Arc<dyn HostEnv>,
    sessions: Vec<Session>,
    agents: Option<Value>,
) {
    let db = open_db(host).unwrap();
    for s in sessions {
        db.repo.upsert_session(&s).await.unwrap();
    }
    if let Some(a) = agents {
        let mut entries = Map::new();
        entries.insert("agents".to_string(), a);
        db.settings.upsert(entries).await.unwrap();
    }
}

#[tokio::test]
async fn list_sessions_end_to_end_flat_and_grouped() {
    let (host, dir) = temp_host();
    seed(
        &host,
        vec![
            session("s1", "标题一", Some("a1"), Some("E:/p"), 300),
            session("s2", "标题二", Some("a1"), Some("E:/q"), 200),
            session("s3", "标题三", None, None, 100),
        ],
        Some(json!([{ "id": "a1", "name": "Virlen" }])),
    )
    .await;

    // 平坦
    let mut out: Vec<u8> = Vec::new();
    let mut err: Vec<u8> = Vec::new();
    let code = run_sessions(
        &host,
        SessionsCmd::List(ListSessionsOptions::default()),
        &mut out,
        &mut err,
    )
    .await;
    assert_eq!(code, EXIT_OK, "stderr={}", String::from_utf8_lossy(&err));
    let text = String::from_utf8_lossy(&out).to_string();
    assert!(text.contains("共 3 个会话"), "text={text}");
    assert!(text.contains("标题一") && text.contains("s1"));
    assert!(text.contains("m1"), "含模型列");

    // 按 agent 分组 → 用表里的 Agent 名，未分组垫底
    let mut out: Vec<u8> = Vec::new();
    let code = run_sessions(
        &host,
        SessionsCmd::List(ListSessionsOptions {
            group: Some(GroupBy::Agent),
            ..Default::default()
        }),
        &mut out,
        &mut err,
    )
    .await;
    assert_eq!(code, EXIT_OK);
    let text = String::from_utf8_lossy(&out).to_string();
    let virlen_at = text.find("Virlen").expect("应有 Virlen 组");
    let ungrouped_at = text.find("未分组").expect("应有未分组组");
    assert!(virlen_at < ungrouped_at, "未分组应垫底: {text}");

    // JSON 模式：结构可解析
    let mut out: Vec<u8> = Vec::new();
    let code = run_sessions(
        &host,
        SessionsCmd::List(ListSessionsOptions {
            group: Some(GroupBy::Workspace),
            json: true,
            ..Default::default()
        }),
        &mut out,
        &mut err,
    )
    .await;
    assert_eq!(code, EXIT_OK);
    let v: Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(v["total"], 3);
    assert_eq!(v["groupBy"], "workdir");
    assert_eq!(v["groups"].as_array().unwrap().len(), 3);

    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn list_sessions_limit_and_empty_db() {
    let (host, dir) = temp_host();

    // 空库：明确的一行，而不是空输出
    let mut out: Vec<u8> = Vec::new();
    let mut err: Vec<u8> = Vec::new();
    assert_eq!(
        run_sessions(
            &host,
            SessionsCmd::List(ListSessionsOptions::default()),
            &mut out,
            &mut err
        )
        .await,
        EXIT_OK
    );
    assert!(String::from_utf8_lossy(&out).contains("没有会话"));

    seed(
        &host,
        vec![
            session("s1", "一", None, None, 300),
            session("s2", "二", None, None, 200),
            session("s3", "三", None, None, 100),
        ],
        None,
    )
    .await;

    let mut out: Vec<u8> = Vec::new();
    run_sessions(
        &host,
        SessionsCmd::List(ListSessionsOptions {
            limit: Some(2),
            ..Default::default()
        }),
        &mut out,
        &mut err,
    )
    .await;
    let text = String::from_utf8_lossy(&out).to_string();
    assert!(text.contains("共 3 个会话，显示 2"), "text={text}");
    assert!(!text.contains("三"), "超出 limit 的不显示");

    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn list_agents_end_to_end_with_session_counts() {
    let (host, dir) = temp_host();
    seed(
        &host,
        vec![
            session("s1", "一", Some("a1"), None, 300),
            session("s2", "二", Some("a1"), None, 200),
            session("s3", "三", Some("a2"), None, 100),
            session("s4", "四", None, None, 50),
        ],
        Some(json!([
            {
                "id": "a1",
                "name": "Virlen",
                "description": "全能助手",
                "defaultWorkspace": "E:/proj",
                "defaultModel": { "providerConfigId": "p1", "modelId": "m1" }
            },
            { "id": "a2", "name": "Reviewer" }
        ])),
    )
    .await;

    let mut out: Vec<u8> = Vec::new();
    let mut err: Vec<u8> = Vec::new();
    assert_eq!(
        run_agents(
            &host,
            AgentsCmd::List(ListAgentsOptions::default()),
            &mut out,
            &mut err
        )
        .await,
        EXIT_OK,
        "stderr={}",
        String::from_utf8_lossy(&err)
    );
    let text = String::from_utf8_lossy(&out).to_string();
    assert!(text.contains("共 2 个 Agent"), "text={text}");
    assert!(text.contains("Virlen") && text.contains("Reviewer"));
    assert!(text.contains("E:/proj"), "含默认工作目录");

    // JSON：会话数按 agent_id 聚合
    let mut out: Vec<u8> = Vec::new();
    assert_eq!(
        run_agents(
            &host,
            AgentsCmd::List(ListAgentsOptions { json: true }),
            &mut out,
            &mut err
        )
        .await,
        EXIT_OK
    );
    let v: Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(v["total"], 2);
    assert_eq!(v["agents"][0]["sessionCount"], 2);
    assert_eq!(v["agents"][0]["defaultModel"]["modelId"], "m1");
    assert_eq!(v["agents"][1]["sessionCount"], 1);

    std::fs::remove_dir_all(&dir).ok();
}

/// `--help` 不碰数据库
#[tokio::test]
async fn help_does_not_touch_database() {
    let (host, dir) = temp_host();
    let mut out: Vec<u8> = Vec::new();
    let mut err: Vec<u8> = Vec::new();
    assert_eq!(run_sessions(&host, SessionsCmd::Help, &mut out, &mut err).await, EXIT_OK);
    assert!(String::from_utf8_lossy(&out).contains("用法:"));
    assert_eq!(run_agents(&host, AgentsCmd::Help, &mut out, &mut err).await, EXIT_OK);
    assert!(!dir.join("virlen.db").exists(), "help 不得建库");
    std::fs::remove_dir_all(&dir).ok();
}
