//! `list-session` / `list-agent` 子命令 —— 无界面查看会话与 Agent
//!
//! ```text
//! virlen-cli list-session [-g agent|workdir] [--limit N] [--json]
//! virlen-cli list-agent   [--json]
//! ```
//!
//! ## 数据来源（都是与桌面端**同一份** `virlen.db`）
//!
//! - **会话**：`sessions` 表（`SessionRepo::list_sessions`，按 `updated_at` 降序）。
//!   `-g` 分组用的 `agent_id` / `workspace` 就是表里的列，与桌面端侧边栏分组同源。
//! - **Agent**：`app_settings` 的 `agents` 键 —— 与 GUI 共用同一份（配置下沉 D3 的延伸，
//!   见 `src/infrastructure/agentRepo`）。⚠️ 在 agents 下沉之前，这份数据只存在于
//!   桌面端 localStorage，CLI 根本读不到；下沉后两侧才真正一致。
//!
//! ## 与 GUI 的文案 / 语义对齐
//!
//! - 未分组 key 用 `__ungrouped__`、组名「未分组 / 未知代理」——与
//!   `ui/pages/chat/components/sidebar/index.tsx` 的 `UNGROUPED_KEY` 及分组函数一致；
//! - 会话顺序 = 表顺序（`updated_at` 降序），不在这里重排；
//! - 输出文案用**中文**（与 crate 内其它用户可见消息一致），`--json` 面向脚本。

use virlen_core::agent::host::HostEnv;
use virlen_core::agent::types::Session;
use virlen_core::session_db::{open_session_db, SessionDb, SettingsRepo};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::io::Write;
use std::sync::Arc;

use crate::{EXIT_ERROR, EXIT_OK};

/// 未分组会话的虚拟 key（与前端 `UNGROUPED_KEY` 逐字一致）
const UNGROUPED_KEY: &str = "__ungrouped__";
/// 默认显示条数（会话可能上千，默认不刷屏）
const DEFAULT_LIMIT: usize = 50;
/// `--limit` 上限（0 = 全部，仍受此上限约束）
const MAX_LIMIT: usize = 1000;

// ==================== 参数解析 ====================

/// 分组维度
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum GroupBy {
    /// 按 Agent（`sessions.agent_id`）
    Agent,
    /// 按工作目录（`sessions.workspace`）
    Workspace,
}

impl GroupBy {
    /// 词表：`agent` / `workdir`（`workspace` 为别名，与 GUI 字段名一致）
    fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "agent" | "agents" => Some(Self::Agent),
            "workdir" | "workspace" | "dir" => Some(Self::Workspace),
            _ => None,
        }
    }

    fn as_str(&self) -> &'static str {
        match self {
            Self::Agent => "agent",
            Self::Workspace => "workdir",
        }
    }
}

/// `list-session` 的选项
#[derive(Debug, PartialEq, Eq, Default)]
pub(crate) struct ListSessionsOptions {
    pub group: Option<GroupBy>,
    /// `None` = 默认；`Some(0)` = 全部
    pub limit: Option<usize>,
    pub json: bool,
}

/// `list-agent` 的选项
#[derive(Debug, PartialEq, Eq, Default)]
pub(crate) struct ListAgentsOptions {
    pub json: bool,
}

/// 解析结果
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum SessionsCmd {
    Help,
    List(ListSessionsOptions),
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum AgentsCmd {
    Help,
    List(ListAgentsOptions),
}

/// `list-session` 的帮助文本
pub const USAGE_LIST_SESSION: &str = "\
virlen-cli list-session —— 列出会话（与桌面端同一份 virlen.db）

用法:
  virlen-cli list-session [-g agent|workdir] [--limit N] [--json]

选项:
  -g, --group <agent|workdir>   分组显示：按 Agent / 按工作目录
                                （`workspace` 是 `workdir` 的别名；不传则不分组）
      --limit <N>               最多显示 N 条（默认 50；0 = 全部，上限 1000）
      --json                    输出 JSON（便于脚本）
  -h, --help                    显示本帮助

说明:
  会话按最近更新倒序（与桌面端列表一致）；分组时组内同样保持该顺序。
  未关联 Agent / 无工作目录的会话归入「未分组」。
";

/// `list-agent` 的帮助文本
pub const USAGE_LIST_AGENT: &str = "\
virlen-cli list-agent —— 列出 Agent（与桌面端同一份 app_settings.agents）

用法:
  virlen-cli list-agent [--json]

选项:
      --json    输出 JSON（便于脚本）
  -h, --help    显示本帮助

说明:
  Agent 配置（名称 / 描述 / 默认工作目录 / 默认模型 / 技能 / 工具白名单）
  自配置下沉后以数据库里的 `agents` 键为唯一源，桌面端与 CLI 读写同一份。
";

/// 解析 `list-session` 之后的参数。纯函数 —— 单测直接断言它。
pub(crate) fn parse_sessions(args: Vec<&str>) -> Result<SessionsCmd, String> {
    let mut opts = ListSessionsOptions::default();
    let mut it = args.into_iter();
    while let Some(arg) = it.next() {
        match arg {
            "-h" | "--help" => return Ok(SessionsCmd::Help),
            "--json" => opts.json = true,
            "-g" | "--group" | "--group-by" => {
                let raw = it
                    .next()
                    .ok_or_else(|| "选项 -g/--group 缺少取值（agent | workdir）".to_string())?;
                opts.group = Some(GroupBy::parse(raw).ok_or_else(|| {
                    format!("-g 取值无效: {}（可选: agent | workdir）", raw)
                })?);
            }
            "--limit" => {
                let raw = it.next().ok_or_else(|| "选项 --limit 缺少取值".to_string())?;
                let n: usize = raw
                    .parse()
                    .map_err(|_| format!("--limit 需要非负整数，收到: {}", raw))?;
                if n > MAX_LIMIT {
                    return Err(format!("--limit 上限为 {}（0 = 全部）", MAX_LIMIT));
                }
                opts.limit = Some(n);
            }
            other => {
                return Err(format!(
                    "未知选项: {}（见 `virlen-cli list-session --help`）",
                    other
                ))
            }
        }
    }
    Ok(SessionsCmd::List(opts))
}

/// 解析 `list-agent` 之后的参数
pub(crate) fn parse_agents(args: Vec<&str>) -> Result<AgentsCmd, String> {
    let mut opts = ListAgentsOptions::default();
    for arg in args {
        match arg {
            "-h" | "--help" => return Ok(AgentsCmd::Help),
            "--json" => opts.json = true,
            other => {
                return Err(format!(
                    "未知选项: {}（见 `virlen-cli list-agent --help`）",
                    other
                ))
            }
        }
    }
    Ok(AgentsCmd::List(opts))
}

// ==================== Agent 视图 ====================

/// `app_settings.agents` 里一个 Agent（只取列出所需字段；字段名与前端 `Agent` 同名）
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentLite {
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    description: String,
    /// 默认工作目录（未配置时为空串）
    #[serde(default)]
    default_workspace: String,
    #[serde(default)]
    default_model: AgentDefaultModel,
    /// 启用的技能名
    #[serde(default)]
    skills: Vec<String>,
    /// 工具白名单（空 = 全部可用，取决于会话侧过滤）
    #[serde(default)]
    allow_tools: Vec<String>,
    #[serde(default)]
    created_at: i64,
    #[serde(default)]
    updated_at: i64,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentDefaultModel {
    #[serde(default)]
    provider_config_id: String,
    #[serde(default)]
    model_id: String,
}

/// 从 `app_settings` 读 Agent 列表（键不存在 / 单项坏数据 → 跳过，不让整表失败）
fn parse_agents_value(value: Option<&Value>) -> Vec<AgentLite> {
    match value.and_then(Value::as_array) {
        Some(arr) => arr
            .iter()
            .filter_map(|v| serde_json::from_value::<AgentLite>(v.clone()).ok())
            .collect(),
        None => Vec::new(),
    }
}

// ==================== 分组（纯函数） ====================

/// 一个分组视图
#[derive(Debug)]
pub(crate) struct GroupView {
    pub key: String,
    pub name: String,
    pub sessions: Vec<Session>,
}

/// 按维度分组（**保持输入顺序**；输入应为 `updated_at` 降序）。
///
/// 与前端 `groupSessionsByAgent` / `groupSessionsByWorkspace` 同语义：
/// 组间排序 = 已知组按名称升序 → 未知组 → 「未分组」垫底。
pub(crate) fn group_sessions(
    sessions: Vec<Session>,
    by: GroupBy,
    agents: &[AgentLite],
) -> Vec<GroupView> {
    let mut groups: Vec<GroupView> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();

    for session in sessions {
        let key = match by {
            GroupBy::Agent => session.agent_id.clone(),
            GroupBy::Workspace => session.workspace.clone(),
        }
        .filter(|k| !k.trim().is_empty())
        .unwrap_or_else(|| UNGROUPED_KEY.to_string());

        let idx = match index.get(&key) {
            Some(i) => *i,
            None => {
                let name = group_name(by, &key, agents);
                groups.push(GroupView {
                    key: key.clone(),
                    name,
                    sessions: Vec::new(),
                });
                let i = groups.len() - 1;
                index.insert(key, i);
                i
            }
        };
        groups[idx].sessions.push(session);
    }

    groups.sort_by(|a, b| {
        let a_un = a.key == UNGROUPED_KEY;
        let b_un = b.key == UNGROUPED_KEY;
        if a_un != b_un {
            return if a_un { std::cmp::Ordering::Greater } else { std::cmp::Ordering::Less };
        }
        // 已知 Agent（表里能找到）优先于未知 id —— 与 GUI 的排序规则一致
        if by == GroupBy::Agent {
            let a_known = agents.iter().any(|g| g.id == a.key);
            let b_known = agents.iter().any(|g| g.id == b.key);
            if a_known != b_known {
                return if a_known { std::cmp::Ordering::Less } else { std::cmp::Ordering::Greater };
            }
        }
        a.name.cmp(&b.name)
    });
    groups
}

/// 组显示名：Agent → 表中名称（找不到写「未知代理」）；工作目录 → 原路径
fn group_name(by: GroupBy, key: &str, agents: &[AgentLite]) -> String {
    if key == UNGROUPED_KEY {
        return "未分组".to_string();
    }
    match by {
        GroupBy::Workspace => key.to_string(),
        GroupBy::Agent => agents
            .iter()
            .find(|a| a.id == key)
            .map(|a| {
                if a.name.trim().is_empty() {
                    a.id.clone()
                } else {
                    a.name.clone()
                }
            })
            .unwrap_or_else(|| "未知代理".to_string()),
    }
}

// ==================== 渲染 ====================

// 列宽（显示列数；改这里即改表格形状）
const COL_ID: usize = 36;
const COL_TIME: usize = 16;
const COL_MODEL: usize = 20;
const COL_TITLE: usize = 40;
const COL_COUNT: usize = 6;
const COL_DIR: usize = 28;

/// 字符是否占两个终端列（CJK / 全角）
fn is_wide(c: char) -> bool {
    matches!(
        c as u32,
        0x1100..=0x115F
            | 0x2E80..=0x303E
            | 0x3041..=0x33FF
            | 0x3400..=0x4DBF
            | 0x4E00..=0x9FFF
            | 0xA000..=0xA4CF
            | 0xAC00..=0xD7A3
            | 0xF900..=0xFAFF
            | 0xFE30..=0xFE6F
            | 0xFF00..=0xFF60
            | 0xFFE0..=0xFFE6
    )
}

/// 终端显示宽度（中文按 2 列）
///
/// ⚠️ Rust 的 `{:<n}` 按**字符数**补齐，中文列（如「会话数」= 6 列 / 3 字符）会错位，
/// 所以表格一律走本文件的 `pad` / `pad_left`。
fn display_width(s: &str) -> usize {
    s.chars().map(|c| if is_wide(c) { 2 } else { 1 }).sum()
}

/// 左对齐补齐到 `width` 显示列
fn pad(s: &str, width: usize) -> String {
    let w = display_width(s);
    if w >= width {
        s.to_string()
    } else {
        format!("{}{}", s, " ".repeat(width - w))
    }
}

/// 右对齐补齐到 `width` 显示列
fn pad_left(s: &str, width: usize) -> String {
    let w = display_width(s);
    if w >= width {
        s.to_string()
    } else {
        format!("{}{}", " ".repeat(width - w), s)
    }
}

/// 毫秒时间戳 → 本地时间 `YYYY-MM-DD HH:MM`
fn fmt_time(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|dt| {
            dt.with_timezone(&chrono::Local)
                .format("%Y-%m-%d %H:%M")
                .to_string()
        })
        .unwrap_or_else(|| "-".to_string())
}

/// 压平换行 + 按**显示列**截断（超过 `max_cols` 加省略号）
fn brief(s: &str, max_cols: usize) -> String {
    let flat = s.replace(['\r', '\n'], " ");
    if display_width(&flat) <= max_cols {
        return flat;
    }
    let mut out = String::new();
    let mut w = 0usize;
    for c in flat.chars() {
        let cw = if is_wide(c) { 2 } else { 1 };
        if w + cw > max_cols.saturating_sub(1) {
            break;
        }
        out.push(c);
        w += cw;
    }
    out.push('…');
    out
}

/// 生效条数：`None` → 默认；`Some(0)` → 全部（仍受 `MAX_LIMIT` 限制）
fn effective_limit(limit: Option<usize>) -> usize {
    match limit {
        None => DEFAULT_LIMIT,
        Some(0) => MAX_LIMIT,
        Some(n) => n.min(MAX_LIMIT),
    }
}

/// 一个会话 → JSON（字段与前端 `Session` 同名；不含 messages）
fn session_json(s: &Session) -> Value {
    json!({
        "id": s.id,
        "title": s.title,
        "agentId": s.agent_id,
        "workspace": s.workspace,
        "providerConfigId": s.provider_config_id,
        "modelId": s.model_id,
        "pinned": s.pinned,
        "tags": s.tags,
        "createdAt": s.created_at,
        "updatedAt": s.updated_at,
    })
}

// ==================== 执行 ====================

/// 打开库（与 `config` / `run` 同一条推导链：`host.data_dir()/virlen.db`）
fn open_db(host: &Arc<dyn HostEnv>) -> Result<SessionDb, String> {
    open_session_db(host.as_ref(), &|fut| {
        tokio::spawn(fut);
    })
}

/// 读 Agent 列表（键不存在 → 空；单项坏数据 → 跳过该项）
async fn load_agents(settings: &dyn SettingsRepo) -> Vec<AgentLite> {
    match settings.get_all().await {
        Ok(all) => parse_agents_value(all.get("agents")),
        Err(e) => {
            eprintln!("[list] 读取 agents 失败（按空处理）: {}", e);
            Vec::new()
        }
    }
}

/// `list-session` 入口。返回进程退出码。
pub(super) async fn run_sessions(
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
                "{}  {}  {}  {}",
                pad("ID", COL_ID),
                pad("更新于", COL_TIME),
                pad("模型", COL_MODEL),
                "标题"
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

/// 会话行：`ID  更新于  模型  标题`（`indent` 供分组模式缩进）
fn session_line(s: &Session, indent: &str) -> String {
    format!(
        "{}{}  {}  {}  {}",
        indent,
        pad(&s.id, COL_ID),
        pad(&fmt_time(s.updated_at), COL_TIME),
        pad(&brief(&s.model_id, COL_MODEL), COL_MODEL),
        brief(&s.title, COL_TITLE)
    )
}

/// `list-agent` 入口。返回进程退出码。
pub(super) async fn run_agents(
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
        "{}  {}  {}  {}  {}",
        pad("ID", COL_ID),
        pad_left("会话数", COL_COUNT),
        pad("默认模型", COL_MODEL),
        pad("默认工作目录", COL_DIR),
        "名称"
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

#[cfg(test)]
mod tests {
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
}
