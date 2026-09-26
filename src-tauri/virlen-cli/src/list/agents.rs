//! Agent 视图 —— `app_settings.agents` 的模型、解析、装载与输出
//!
//! 数据来源是**下沉到 SQLite 的那份**（与桌面端同一份）：`agents` 键不存在 → 空列表；
//! 单项坏数据 → 跳过该项（不让一条脏配置把整张表打不出来）。

use virlen_core::agent::host::HostEnv;
use virlen_core::session_db::SettingsRepo;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Write;
use std::sync::Arc;

use crate::{EXIT_ERROR, EXIT_OK};

use super::render::{brief, pad, pad_left, COL_COUNT, COL_DIR, COL_ID, COL_MODEL};
use super::*;

// ==================== Agent 视图 ====================

/// `app_settings.agents` 里一个 Agent（只取列出所需字段；字段名与前端 `Agent` 同名）
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
/// 字段为 `pub(crate)`：分组（`group.rs`）要读 `id` / `name`，单测要直接造数据。
/// 这是「纯搬运」的代价 —— 原来它们在同一个文件里，私有字段天然可见。
pub(crate) struct AgentLite {
    pub(crate) id: String,
    #[serde(default)]
    pub(crate) name: String,
    #[serde(default)]
    pub(crate) description: String,
    /// 默认工作目录（未配置时为空串）
    #[serde(default)]
    pub(crate) default_workspace: String,
    #[serde(default)]
    pub(crate) default_model: AgentDefaultModel,
    /// 启用的技能名
    #[serde(default)]
    pub(crate) skills: Vec<String>,
    /// 工具白名单（空 = 全部可用，取决于会话侧过滤）
    #[serde(default)]
    pub(crate) allow_tools: Vec<String>,
    #[serde(default)]
    pub(crate) created_at: i64,
    #[serde(default)]
    pub(crate) updated_at: i64,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentDefaultModel {
    #[serde(default)]
    pub(crate) provider_config_id: String,
    #[serde(default)]
    pub(crate) model_id: String,
}

/// 从 `app_settings` 读 Agent 列表（键不存在 / 单项坏数据 → 跳过，不让整表失败）
pub(crate) fn parse_agents_value(value: Option<&Value>) -> Vec<AgentLite> {
    match value.and_then(Value::as_array) {
        Some(arr) => arr
            .iter()
            .filter_map(|v| serde_json::from_value::<AgentLite>(v.clone()).ok())
            .collect(),
        None => Vec::new(),
    }
}

/// 读 Agent 列表（键不存在 → 空；单项坏数据 → 跳过该项）
pub(crate) async fn load_agents(settings: &dyn SettingsRepo) -> Vec<AgentLite> {
    match settings.get_all().await {
        Ok(all) => parse_agents_value(all.get("agents")),
        Err(e) => {
            eprintln!("[list] 读取 agents 失败（按空处理）: {}", e);
            Vec::new()
        }
    }
}

/// `list-agent` 入口。返回进程退出码。
pub(crate) async fn run_agents(
    host: &Arc<dyn HostEnv>,
    cmd: AgentsCmd,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    let opts = match cmd {
        AgentsCmd::Help => {
            let _ = write!(out, "{}", USAGE_LIST_AGENT);
            return EXIT_OK;
        }
        AgentsCmd::List(opts) => opts,
    };

    let db = match open_db(host) {
        Ok(db) => db,
        Err(e) => {
            let _ = writeln!(err, "错误: 打开数据库失败: {}", e);
            return EXIT_ERROR;
        }
    };
    let agents = load_agents(db.settings.as_ref()).await;

    // 会话数：按 agent_id 聚合（让「哪些 Agent 真在用」一眼可见）
    let counts: HashMap<String, usize> = match db.repo.list_sessions().await {
        Ok(list) => {
            let mut m: HashMap<String, usize> = HashMap::new();
            for s in list {
                if let Some(id) = s.agent_id.filter(|i| !i.trim().is_empty()) {
                    *m.entry(id).or_insert(0) += 1;
                }
            }
            m
        }
        Err(e) => {
            let _ = writeln!(err, "警告: 统计会话数失败: {}", e);
            HashMap::new()
        }
    };

    if opts.json {
        let items: Vec<Value> = agents
            .iter()
            .map(|a| {
                let mut v = serde_json::to_value(a).unwrap_or(Value::Null);
                if let Some(obj) = v.as_object_mut() {
                    obj.insert(
                        "sessionCount".into(),
                        json!(counts.get(&a.id).copied().unwrap_or(0)),
                    );
                }
                v
            })
            .collect();
        let _ = writeln!(
            out,
            "{}",
            serde_json::to_string_pretty(&json!({
                "total": agents.len(),
                "agents": items,
            }))
            .unwrap_or_default()
        );
        return EXIT_OK;
    }

    if agents.is_empty() {
        let _ = writeln!(
            out,
            "没有 Agent（app_settings.agents 为空）：请先在桌面端创建，或确认桌面端已升级到 agents 下沉版本。"
        );
        return EXIT_OK;
    }

    let _ = writeln!(out, "共 {} 个 Agent\n", agents.len());
    let _ = writeln!(
        out,
        "{}  {}  {}  {}  名称",
        pad("ID", COL_ID),
        pad_left("会话数", COL_COUNT),
        pad("默认模型", COL_MODEL),
        pad("默认工作目录", COL_DIR),
    );
    for a in &agents {
        let model = if a.default_model.model_id.trim().is_empty() {
            "-".to_string()
        } else {
            brief(&a.default_model.model_id, COL_MODEL)
        };
        let ws = if a.default_workspace.trim().is_empty() {
            "-".to_string()
        } else {
            brief(&a.default_workspace, COL_DIR)
        };
        let name = if a.name.trim().is_empty() {
            a.id.clone()
        } else {
            a.name.clone()
        };
        let _ = writeln!(
            out,
            "{}  {}  {}  {}  {}",
            pad(&a.id, COL_ID),
            pad_left(&counts.get(&a.id).copied().unwrap_or(0).to_string(), COL_COUNT),
            pad(&model, COL_MODEL),
            pad(&ws, COL_DIR),
            brief(&name, 30)
        );
    }
    EXIT_OK
}
