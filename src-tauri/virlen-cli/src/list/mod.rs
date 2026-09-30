//! `list-session` / `list-agent` 子命令 —— 无界面查看会话与 Agent
//!
//! ```text
//! virlen-cli list-session [-g agent|workdir] [--limit N] [--json]
//! virlen-cli list-agent   [--json]
//! ```
//!
//! ## 数据来源（都是与桌面端同一份 `virlen.db`）
//!
//! - 会话：`sessions` 表（`SessionRepo::list_sessions`，按 `updated_at` 降序）。`-g` 分组用的
//!   `agent_id` / `workspace` 就是表里的列，与桌面端侧边栏分组同源。
//! - Agent：`app_settings` 的 `agents` 键 —— 与 GUI 共用同一份（配置下沉 D3 的延伸，见
//!   `src/infrastructure/agentRepo`）。在 agents 下沉之前，这份数据只存在于桌面端 localStorage，
//!   CLI 根本读不到；下沉后两侧才真正一致。
//!
//! ## 与 GUI 的文案 / 语义对齐
//!
//! - 未分组 key 用 `__ungrouped__`、组名「未分组 / 未知代理」—— 与
//!   `ui/pages/chat/components/sidebar/index.tsx` 的 `UNGROUPED_KEY` 及分组函数一致；
//! - 会话顺序 = 表顺序（`updated_at` 降序），不在这里重排；
//! - 输出文案用中文（与 crate 内其它用户可见消息一致），`--json` 面向脚本。

pub(crate) mod agents;
pub(crate) mod group;
pub(crate) mod render;
pub(crate) mod sessions;

// 再导出：`lib.rs` 只认 `list::{parse_sessions, parse_agents, run_sessions, run_agents}`。
// 只再导出 `agents` / `sessions`：`group` 与 `render` 是**实现细节**，谁用谁显式
// `use super::group::…` / `use super::render::…`（无脑 glob 会带来「lib 目标下没人用」的警告）。
pub(crate) use self::agents::*;
pub(crate) use self::sessions::*;

use virlen_core::agent::host::HostEnv;
use virlen_core::agent::types::Session;
use virlen_core::session_db::{open_session_db, SessionDb};
use std::sync::Arc;

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
    /// 关键词筛选（**只看会话元数据**，不碰消息正文 —— 正文检索是 `session search`）
    pub search: Option<String>,
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
  -s, --search <关键词>         按会话元数据筛选（标题 / 工作目录 / 模型 / Agent 名，
                                大小写不敏感，子串匹配）
      --json                    输出 JSON（便于脚本）
  -h, --help                    显示本帮助

说明:
  会话按最近更新倒序（与桌面端列表一致）；分组时组内同样保持该顺序。
  未关联 Agent / 无工作目录的会话归入「未分组」。
  -s/--search 只筛**会话元数据**（标题 / 工作目录 / 模型 / Agent id 与名称），不检索消息正文 ——
  要在历史正文里找东西请用 `virlen-cli session search <关键词>`（两者不可互相替代）。
  「上下文/<窗口>」列 = 当前上下文占用（百分比 + 绝对 token，与桌面端 token 环同口径）；
  窗口大小（100% 对应多少）取自 app_settings.contextWindowTokens，可在桌面端设置里修改；
  「条数」列 = 会话内消息条数。两者无数据时显示 `-` / `0`（而不是 0%）。
  ⚠️ 表格约 139 列宽（终端较窄时会折行）——需要机器可读请用 `--json`。
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
            "-s" | "--search" => {
                let raw = it.next().ok_or_else(|| "选项 -s/--search 缺少取值".to_string())?;
                if raw.trim().is_empty() {
                    return Err("选项 -s/--search 的取值不能为空（不想筛就别传）".to_string());
                }
                opts.search = Some(raw.trim().to_string());
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

// ==================== 关键词筛选 ====================

/// 按关键词筛会话 —— **只看会话元数据**（标题 / 模型 / 工作目录 / Agent id 与名称），
/// 不碰消息正文。
///
/// 为什么不做正文检索：那是 `session search` 的活（走 `SessionRepo::search_messages`）。
/// 两者不能互相替代：列表筛选要在 `--limit` **之前**完成（否则匹配项会被限量截掉），
/// 而全文检索的代价是逐条读正文 —— 放在「列表」里就成了不可控开销。
///
/// 大小写不敏感、子串匹配；关键词为空白时原样返回（当作没筛）。
pub(crate) fn filter_sessions(
    sessions: Vec<Session>,
    keyword: &str,
    agents: &[AgentLite],
) -> Vec<Session> {
    let kw = keyword.trim().to_lowercase();
    if kw.is_empty() {
        return sessions;
    }
    sessions
        .into_iter()
        .filter(|s| session_matches(s, &kw, agents))
        .collect()
}

/// 单个会话是否命中关键词（`kw` 必须是已小写的非空串）
fn session_matches(s: &Session, kw: &str, agents: &[AgentLite]) -> bool {
    let hit = |v: &str| v.to_lowercase().contains(kw);
    if hit(&s.title) || hit(&s.model_id) {
        return true;
    }
    if s.workspace.as_deref().map(hit).unwrap_or(false) {
        return true;
    }
    if let Some(aid) = s.agent_id.as_deref() {
        if hit(aid) {
            return true;
        }
        // Agent 名也参与匹配：用户记得的往往是「Virlen」而不是它的 uuid
        if let Some(a) = agents.iter().find(|a| a.id == aid) {
            return hit(&a.name);
        }
    }
    false
}

// ==================== 执行 ====================

/// 打开库（与 `config` / `run` 同一条推导链：`host.data_dir()/virlen.db`）
fn open_db(host: &Arc<dyn HostEnv>) -> Result<SessionDb, String> {
    open_session_db(host.as_ref(), &|fut| {
        tokio::spawn(fut);
    })
}

#[cfg(test)]
mod tests;
