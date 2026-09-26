//! `list-session` 的执行入口（`pub(super) async fn run_sessions` 的落点）

use virlen_core::agent::host::HostEnv;
use virlen_core::agent::types::Session;
use serde_json::{json, Map, Value};
use std::io::Write;
use std::sync::Arc;

use crate::{EXIT_ERROR, EXIT_OK};

// 同层：`list` 的公共词汇与数据装载走 `super::*`；分组与渲染是**实现细节**，显式点名。
use super::group::group_sessions;
use super::render::{effective_limit, pad, session_json, session_line, COL_ID, COL_MODEL, COL_TIME};
use super::*;

/// `list-session` 入口。返回进程退出码。
pub(crate) async fn run_sessions(
    host: &Arc<dyn HostEnv>,
    cmd: SessionsCmd,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    let opts = match cmd {
        SessionsCmd::Help => {
            let _ = write!(out, "{}", USAGE_LIST_SESSION);
            return EXIT_OK;
        }
        SessionsCmd::List(opts) => opts,
    };

    let db = match open_db(host) {
        Ok(db) => db,
        Err(e) => {
            let _ = writeln!(err, "错误: 打开数据库失败: {}", e);
            return EXIT_ERROR;
        }
    };
    let all = match db.repo.list_sessions().await {
        Ok(list) => list,
        Err(e) => {
            let _ = writeln!(err, "错误: 读取会话失败: {}", e);
            return EXIT_ERROR;
        }
    };

    let total = all.len();
    let limit = effective_limit(opts.limit);
    // 先截断再分组：分组模式下每组拿到的都是「最近的那批」，与「最近 50 条」的直觉一致
    let shown_sessions: Vec<Session> = all.into_iter().take(limit).collect();
    let shown = shown_sessions.len();

    if opts.json {
        let agents = load_agents(db.settings.as_ref()).await;
        let mut payload = Map::new();
        payload.insert("total".into(), json!(total));
        payload.insert("shown".into(), json!(shown));
        payload.insert(
            "groupBy".into(),
            opts.group.map(|g| json!(g.as_str())).unwrap_or(Value::Null),
        );
        match opts.group {
            Some(by) => {
                let groups: Vec<Value> = group_sessions(shown_sessions, by, &agents)
                    .iter()
                    .map(|g| {
                        json!({
                            "key": g.key,
                            "name": g.name,
                            "count": g.sessions.len(),
                            "sessions": g.sessions.iter().map(session_json).collect::<Vec<_>>(),
                        })
                    })
                    .collect();
                payload.insert("groups".into(), Value::Array(groups));
            }
            None => {
                payload.insert(
                    "sessions".into(),
                    Value::Array(shown_sessions.iter().map(session_json).collect()),
                );
            }
        }
        let _ = writeln!(
            out,
            "{}",
            serde_json::to_string_pretty(&Value::Object(payload)).unwrap_or_default()
        );
        return EXIT_OK;
    }

    // 人类可读：头部统计 + 行（ID 固定 36 字符宽，导出可复制给 `run --session`）
    if total == 0 {
        let _ = writeln!(out, "没有会话。");
        return EXIT_OK;
    }
    let _ = writeln!(
        out,
        "共 {} 个会话，显示 {}{}",
        total,
        shown,
        if shown < total {
            format!("（--limit {} 调整，0 = 全部）", limit)
        } else {
            String::new()
        }
    );

    match opts.group {
        None => {
            let _ = writeln!(out);
            let _ = writeln!(
                out,
                "{}  {}  {}  标题",
                pad("ID", COL_ID),
                pad("更新于", COL_TIME),
                pad("模型", COL_MODEL),
            );
            for s in &shown_sessions {
                let _ = writeln!(out, "{}", session_line(s, ""));
            }
        }
        Some(by) => {
            let agents = load_agents(db.settings.as_ref()).await;
            for group in group_sessions(shown_sessions, by, &agents) {
                let _ = writeln!(out, "\n▌ {}（{}）", group.name, group.sessions.len());
                for s in &group.sessions {
                    let _ = writeln!(out, "{}", session_line(s, "  "));
                }
            }
        }
    }
    EXIT_OK
}
