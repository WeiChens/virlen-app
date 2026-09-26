//! `list-session` 的执行入口（`pub(super) async fn run_sessions` 的落点）

use virlen_core::agent::host::HostEnv;
use virlen_core::agent::types::Session;
use virlen_core::session_db::SessionStat;
use serde_json::{json, Map, Value};
use std::io::Write;
use std::sync::Arc;

use crate::{EXIT_ERROR, EXIT_OK};

// 同层：`list` 的公共词汇与数据装载走 `super::*`；分组与渲染是**实现细节**，显式点名。
use super::group::group_sessions;
use super::render::{
    effective_limit, pad, pad_left, session_json, session_line, COL_CTX, COL_ID, COL_MODEL, COL_MSG,
    COL_TIME,
};
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

    // 每个会话的统计（消息条数 + 上下文占用）——**两条聚合查询**搞定，
    // 不逐个会话拉全部历史（大库上那会很慢，见 `SessionRepo::session_stats`）。
    // ⚠️ 统计失败**不中断列表**：这两列是附加信息，展示主体（会话本身）不应因此消失；
    //    但必须显式告警，不能静默 —— 统计恒为 0 / `-` 会被当成「真的没数据」。
    let stats: std::collections::HashMap<String, SessionStat> = match db.repo.session_stats().await {
        Ok(list) => list.into_iter().map(|s| (s.session_id.clone(), s)).collect(),
        Err(e) => {
            let _ = writeln!(
                err,
                "[warn] 读取会话统计失败（上下文/条数两列按无数据展示）: {}",
                e
            );
            std::collections::HashMap::new()
        }
    };
    let stat_of = |id: &str| stats.get(id);

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
                            "sessions": g
                                .sessions
                                .iter()
                                .map(|s| session_json(s, stat_of(&s.id)))
                                .collect::<Vec<_>>(),
                        })
                    })
                    .collect();
                payload.insert("groups".into(), Value::Array(groups));
            }
            None => {
                payload.insert(
                    "sessions".into(),
                    Value::Array(
                        shown_sessions
                            .iter()
                            .map(|s| session_json(s, stat_of(&s.id)))
                            .collect(),
                    ),
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
                "{}  {}  {}  {}  {}  标题",
                pad("ID", COL_ID),
                pad("更新于", COL_TIME),
                pad("模型", COL_MODEL),
                pad_left("上下文/200k", COL_CTX),
                pad_left("条数", COL_MSG),
            );
            for s in &shown_sessions {
                let _ = writeln!(out, "{}", session_line(s, "", stat_of(&s.id)));
            }
        }
        Some(by) => {
            let agents = load_agents(db.settings.as_ref()).await;
            for group in group_sessions(shown_sessions, by, &agents) {
                let _ = writeln!(out, "\n▌ {}（{}）", group.name, group.sessions.len());
                for s in &group.sessions {
                    let _ = writeln!(out, "{}", session_line(s, "  ", stat_of(&s.id)));
                }
            }
        }
    }
    EXIT_OK
}
