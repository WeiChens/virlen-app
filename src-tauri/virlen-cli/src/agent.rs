//! `agent` 子命令 —— 交互式增删改查 Agent 配置（`app_settings.agents`）
//!
//! ```text
//! virlen-cli agent add                交互向导：逐步录入 → 落库
//! virlen-cli agent edit [<id>]        交互向导（现有值作默认）
//! virlen-cli agent rm <id> [--yes]    删除（需确认；默认 Agent 不可删）
//! virlen-cli agent list [--json]      等同 `list-agent`（同一份实现）
//! ```
//!
//! 三个枚举源都来自权威处，不在这里另抄一份：工具名 28 个取自
//! `virlen_core::agent::tool_defs::list_tool_definitions()`（机制 C）、技能名取 `<data_dir>/skills`
//! 的子目录（与 `skillStore` 同一规则）、供应商 + 模型取 `app_settings.providers`（只取 `enabled`）。
//!
//! 校验口径对齐桌面端：`name` / `description` 必填（同 `agent-edit-modal.tsx::validate`）；
//! `projectRulesFile` 为空 = 不注入，非空必须是工作目录内相对路径（与
//! `domain/agent/project-rules.ts::normalizeProjectRulesPath` 同一批规则 —— 规则文件全文会逐字进
//! 系统提示词，所以两边都拦）。
//! ⚠️ 默认 Agent（`__default__`）不可删除：桌面端 `initDefaultAgent` 会把它重新建出来，两侧写入互相
//! 覆盖，所以这里直接拒绝。

use serde_json::{json, Map, Value};
use std::io::{BufRead, IsTerminal, Write};
use std::sync::Arc;

use virlen_core::agent::host::HostEnv;
use virlen_core::agent::tool_defs;
use virlen_core::session_db::{open_session_db, SettingsRepo};

use crate::list::render::brief;
use crate::settings_edit::{
    field_str as get_str, field_strs as get_strs, find_index, read_array, remove_by_id,
    upsert_by_id, write_array,
};
use crate::wizard::Prompter;
use crate::{EXIT_ERROR, EXIT_OK, EXIT_USAGE};

/// `agents` 在 `app_settings` 里的键名（与前端 `SettingsStore` 的 `agents` 键同名）
const KEY: &str = "agents";
/// 数组项的 id 字段
const ID_FIELD: &str = "id";
/// 默认 Agent 的 id（与前端 `DEFAULT_AGENT_ID` 逐字一致）
const DEFAULT_AGENT_ID: &str = "__default__";
/// 默认项目规则文件名（与前端 `DEFAULT_PROJECT_RULES_FILE` 逐字一致）
const DEFAULT_PROJECT_RULES_FILE: &str = "AGENTS.md";

// ==================== 帮助 ====================

pub(crate) const USAGE_AGENT: &str = "\
virlen-cli agent —— 交互式管理 Agent 配置（与桌面端同一份 app_settings.agents）

用法:
  virlen-cli agent add                交互向导：逐步录入姓名 / 描述 / 身份 / 性格 /
                                      工作目录 / 规则文件 / 默认模型 / 工具 / 技能 / 参数
  virlen-cli agent edit [<id>]        交互向导（不给 id 时从列表里选）；现有值作默认
  virlen-cli agent rm <id> [--yes]    删除（需确认；默认 Agent '__default__' 不可删）
  virlen-cli agent list [--json]      列出全部 Agent（同 list-agent）
  virlen-cli agent -h                 显示本帮助

说明:
  · add / edit 是**交互式**命令：stdin 不是终端（管道 / CI）时直接报用法错误，不会挂住。
  · 写入是「按 id 合并单项」：其它 Agent、以及本项里没改到的字段（createdAt /
    桌面端以后新增的字段）都保持原样。
  · ⚠️ 桌面端**正在运行**时，它会在下次改动时用内存副本整组覆盖 agents ——
    改完请重启桌面端（或先退出它再改）。
  · 工具白名单为空 = 不限制（取决于会话侧过滤）；默认 Agent 的定位是「全能助手」。

退出码:
  0 成功    1 失败 / 用户取消    2 用法错误（含「非终端却在跑交互命令」）
";

// ==================== 参数解析 ====================

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum AgentCmd {
    Help,
    Add,
    Edit { id: Option<String> },
    Rm { id: String, yes: bool },
    List { json: bool },
}

/// 解析 `agent` 之后的参数。纯函数 —— 单测直接断言它。
pub(crate) fn parse(args: Vec<&str>) -> Result<AgentCmd, String> {
    let mut it = args.into_iter();
    let Some(sub) = it.next() else {
        return Err("agent 缺少子命令（可用: add / edit / rm / list）".to_string());
    };
    let rest: Vec<&str> = it.collect();
    match sub {
        "-h" | "--help" | "help" => Ok(AgentCmd::Help),
        "add" => match rest.first() {
            Some(extra) => Err(format!("agent add 不接受参数（多出: {}）", extra)),
            None => Ok(AgentCmd::Add),
        },
        "edit" => match rest.as_slice() {
            [] => Ok(AgentCmd::Edit { id: None }),
            [id] => Ok(AgentCmd::Edit {
                id: Some((*id).to_string()),
            }),
            _ => Err("用法: agent edit [<id>]".to_string()),
        },
        "rm" | "remove" | "delete" => {
            let mut id: Option<String> = None;
            let mut yes = false;
            for a in rest {
                match a {
                    "--yes" | "-y" => yes = true,
                    other if other.starts_with('-') => {
                        return Err(format!("未知选项: {}（见 `virlen-cli agent -h`）", other))
                    }
                    other => {
                        if id.is_some() {
                            return Err("agent rm 只接受一个 <id>".to_string());
                        }
                        id = Some(other.to_string());
                    }
                }
            }
            Ok(AgentCmd::Rm {
                id: id.ok_or_else(|| "用法: agent rm <id> [--yes]".to_string())?,
                yes,
            })
        }
        "list" | "ls" => {
            let mut out_json = false;
            for a in rest {
                match a {
                    "--json" => out_json = true,
                    other => {
                        return Err(format!("未知选项: {}（见 `virlen-cli agent -h`）", other))
                    }
                }
            }
            Ok(AgentCmd::List { json: out_json })
        }
        other => Err(format!(
            "agent 未知子命令: {}（可用: add / edit / rm / list）",
            other
        )),
    }
}

// ==================== 入口 ====================

pub(crate) async fn run(
    host: &Arc<dyn HostEnv>,
    cmd: AgentCmd,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    match cmd {
        AgentCmd::Help => {
            let _ = write!(out, "{}", USAGE_AGENT);
            EXIT_OK
        }
        // `list` 直接复用 `list-agent`（同一份输出格式与统计，不另写一遍）
        AgentCmd::List { json } => {
            crate::list::run_agents(
                host,
                crate::list::AgentsCmd::List(crate::list::ListAgentsOptions { json }),
                out,
                err,
            )
            .await
        }
        other => {
            let db = match open_session_db(host.as_ref(), &|fut| {
                tokio::spawn(fut);
            }) {
                Ok(db) => db,
                Err(e) => {
                    let _ = writeln!(err, "错误: 打开数据库失败: {}", e);
                    return EXIT_ERROR;
                }
            };
            let settings: &dyn SettingsRepo = db.settings.as_ref();
            match other {
                AgentCmd::Add => run_add(host, settings, out, err).await,
                AgentCmd::Edit { id } => run_edit(host, settings, id, out, err).await,
                AgentCmd::Rm { id, yes } => run_rm(&db, &id, yes, out, err).await,
                AgentCmd::Help | AgentCmd::List { .. } => unreachable!("已在上面的分支返回"),
            }
        }
    }
}

// ==================== 环境（枚举源） ====================

/// 供应商选项（只取启用中的）
struct ProviderOption {
    id: String,
    /// 展示用：`名称 (id)`
    label: String,
    models: Vec<String>,
}

/// 向导要用到的全部「外部事实」——一次性备齐，提问阶段不再读库/读盘
struct AgentEnv {
    /// `(工具名, 描述)` —— 名字与描述都来自 core 的权威定义（机制 C）
    tools: Vec<(String, String)>,
    skills: Vec<String>,
    providers: Vec<ProviderOption>,
    default_workspace: String,
}

impl AgentEnv {
    async fn load(host: &Arc<dyn HostEnv>, settings: &dyn SettingsRepo) -> Result<Self, String> {
        // 工具：权威源在 core（机制 C），平台变体由它自己决定
        let tools: Vec<(String, String)> = tool_defs::list_tool_definitions()
            .into_iter()
            .map(|t| (t.name, t.description))
            .collect();

        let skills = available_skills(host.as_ref());

        let all = settings
            .get_all()
            .await
            .map_err(|e| format!("读取配置失败: {}", e))?;
        let providers: Vec<ProviderOption> = match all.get("providers") {
            Some(Value::Array(items)) => items
                .iter()
                .filter(|v| v.get("enabled").and_then(Value::as_bool).unwrap_or(true))
                .map(|v| {
                    let id = get_str(v, ID_FIELD);
                    let name = get_str(v, "name");
                    ProviderOption {
                        label: if name.is_empty() {
                            id.clone()
                        } else {
                            format!("{}  [{}]", name, id)
                        },
                        models: get_strs(v, "models"),
                        id,
                    }
                })
                .collect(),
            _ => Vec::new(),
        };

        Ok(Self {
            tools,
            skills,
            providers,
            default_workspace: all
                .get("defaultWorkspace")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
        })
    }
}

/// `<data_dir>/skills` 的子目录名（升序）。目录不存在 → 空（与「还没装技能」同义）
fn available_skills(host: &dyn HostEnv) -> Vec<String> {
    let dir = host.data_dir().join("skills");
    let mut names: Vec<String> = match std::fs::read_dir(&dir) {
        Ok(rd) => rd
            .filter_map(|e| e.ok())
            .filter(|e| e.path().is_dir())
            .filter_map(|e| e.file_name().into_string().ok())
            .collect(),
        Err(_) => Vec::new(),
    };
    names.sort();
    names
}

// ==================== add / edit ====================

/// 向导收集到的草稿（字段名与前端 `Agent` 逐字一致）
#[derive(Debug)]
struct AgentDraft {
    id: String,
    name: String,
    description: String,
    identity: String,
    personality: String,
    default_workspace: String,
    project_rules_file: String,
    provider_config_id: String,
    model_id: String,
    allow_tools: Vec<String>,
    skills: Vec<String>,
    temperature: f64,
    top_p: f64,
}

async fn run_add(
    host: &Arc<dyn HostEnv>,
    settings: &dyn SettingsRepo,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    if !std::io::stdin().is_terminal() {
        let _ = writeln!(
            err,
            "错误: `agent add` 是交互式命令（stdin 不是终端）。请在终端里运行。"
        );
        return EXIT_USAGE;
    }
    let env = match AgentEnv::load(host, settings).await {
        Ok(e) => e,
        Err(e) => {
            let _ = writeln!(err, "错误: {}", e);
            return EXIT_ERROR;
        }
    };
    let mut arr = match read_array(settings, KEY).await {
        Ok(a) => a,
        Err(e) => {
            let _ = writeln!(err, "错误: {}", e);
            return EXIT_ERROR;
        }
    };
    let id = uuid::Uuid::new_v4().to_string();

    let mut input = std::io::stdin().lock();
    let tty = std::io::stdin().is_terminal();
    let draft = match collect(&mut input, &mut *out, tty, &env, &id, None).await {
        Ok(d) => d,
        Err(e) => {
            let _ = writeln!(err, "{}", e);
            return EXIT_ERROR;
        }
    };
    finish_write(settings, &mut arr, &draft, true, out, err).await
}

async fn run_edit(
    host: &Arc<dyn HostEnv>,
    settings: &dyn SettingsRepo,
    id: Option<String>,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    let mut arr = match read_array(settings, KEY).await {
        Ok(a) => a,
        Err(e) => {
            let _ = writeln!(err, "错误: {}", e);
            return EXIT_ERROR;
        }
    };
    if arr.is_empty() {
        let _ = writeln!(
            err,
            "错误: 没有可编辑的 Agent（app_settings.agents 为空）；先用 `virlen-cli agent add` 创建"
        );
        return EXIT_ERROR;
    }
    let id = match id {
        Some(x) => x,
        None => match pick_agent_id(&arr, out) {
            Ok(x) => x,
            Err(code) => return code,
        },
    };
    let Some(idx) = find_index(&arr, ID_FIELD, &id) else {
        let _ = writeln!(err, "错误: Agent 不存在: {}", id);
        return EXIT_ERROR;
    };
    let existing = arr[idx].clone();

    if !std::io::stdin().is_terminal() {
        let _ = writeln!(
            err,
            "错误: `agent edit` 是交互式命令（stdin 不是终端）。请在终端里运行。"
        );
        return EXIT_USAGE;
    }
    let env = match AgentEnv::load(host, settings).await {
        Ok(e) => e,
        Err(e) => {
            let _ = writeln!(err, "错误: {}", e);
            return EXIT_ERROR;
        }
    };

    let mut input = std::io::stdin().lock();
    let tty = std::io::stdin().is_terminal();
    let draft = match collect(&mut input, &mut *out, tty, &env, &id, Some(&existing)).await {
        Ok(d) => d,
        Err(e) => {
            let _ = writeln!(err, "{}", e);
            return EXIT_ERROR;
        }
    };
    finish_write(settings, &mut arr, &draft, false, out, err).await
}

/// 不给 id 时从列表里挑一个（要求真终端）
fn pick_agent_id(arr: &[Value], out: &mut dyn Write) -> Result<String, i32> {
    if !std::io::stdin().is_terminal() {
        let _ = writeln!(
            out,
            "错误: `agent edit` 不给 id 时需要真终端（stdin 不是终端）"
        );
        return Err(EXIT_USAGE);
    }
    let labels: Vec<String> = arr
        .iter()
        .map(|v| {
            let name = get_str(v, "name");
            let name = if name.is_empty() {
                get_str(v, ID_FIELD)
            } else {
                name
            };
            format!("{}  [{}]", name, get_str(v, ID_FIELD))
        })
        .collect();
    let mut input = std::io::stdin().lock();
    let tty = std::io::stdin().is_terminal();
    let mut p = Prompter::new(&mut input, out, tty);
    match p.choose("请选择要编辑的 Agent：", &labels, 0) {
        Ok(i) => Ok(get_str(&arr[i], ID_FIELD)),
        Err(e) => {
            p.say(&e);
            Err(EXIT_ERROR)
        }
    }
}

/// 交互收集（**唯一**的提问处）。`existing` 为 `None` = 新增。
async fn collect(
    input: &mut dyn BufRead,
    out: &mut dyn Write,
    tty: bool,
    env: &AgentEnv,
    id: &str,
    existing: Option<&Value>,
) -> Result<AgentDraft, String> {
    let mut p = Prompter::new(input, out, tty);
    let mut n = 0usize;
    macro_rules! step {
        ($title:expr) => {{
            n += 1;
            p.step(n, $title);
        }};
    }

    // ── 1. 名称 ──
    step!("名称");
    let name = p.text(
        "名称",
        existing.map(|e| get_str(e, "name")).as_deref().filter(|s| !s.is_empty()),
    )?;

    // ── 2. 描述（桌面端同样强制非空） ──
    step!("描述");
    let description = p.text(
        "描述（一句话说明这个 Agent 干什么）",
        existing
            .map(|e| get_str(e, "description"))
            .as_deref()
            .filter(|s| !s.is_empty()),
    )?;

    // ── 3. 身份与性格（都要，可空） ──
    step!("身份与性格");
    p.say("  这两段会注入系统提示词的角色身份 / 性格部分；不需要就留空。");
    let identity = p.text_opt(
        "身份",
        existing.map(|e| get_str(e, "identity")).as_deref(),
    )?;
    let personality = p.text_opt(
        "性格",
        existing.map(|e| get_str(e, "personality")).as_deref(),
    )?;

    // ── 4. 默认工作目录 ──
    step!("默认工作目录");
    let ws_default = existing
        .map(|e| get_str(e, "defaultWorkspace"))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| env.default_workspace.clone());
    let default_workspace = p.text_opt("默认工作目录", Some(&ws_default))?;

    // ── 5. 项目规则文件 ──
    step!("项目规则文件");
    p.say("  相对工作目录的路径；文件存在时其内容会被注入系统提示词。留空 = 不注入。");
    let rules_default = existing
        .map(|e| get_str(e, "projectRulesFile"))
        .unwrap_or_else(|| DEFAULT_PROJECT_RULES_FILE.to_string());
    let project_rules_file = p.text_with(
        "项目规则文件",
        Some(&rules_default),
        validate_project_rules_path,
    )?;

    // ── 6. 默认模型 ──
    step!("默认模型");
    let existing_model = existing
        .and_then(|e| e.get("defaultModel"))
        .cloned()
        .unwrap_or(Value::Null);
    let existing_pid = get_str(&existing_model, "providerConfigId");
    let existing_mid = get_str(&existing_model, "modelId");
    let (provider_config_id, model_id) = if env.providers.is_empty() {
        p.say("  ⚠ 没有启用中的供应商（providers 里 enabled=true 的项为空）。");
        p.say("    先 `virlen-cli provider add` 配一个；本项保持原值。");
        (existing_pid, existing_mid)
    } else {
        let labels: Vec<String> = env.providers.iter().map(|o| o.label.clone()).collect();
        let d = env
            .providers
            .iter()
            .position(|o| o.id == existing_pid)
            .unwrap_or(0);
        let i = p.choose("默认使用哪个供应商？", &labels, d)?;
        let prov = &env.providers[i];
        if prov.models.is_empty() {
            let model = p.text_opt(
                "模型 id（该供应商还没登记模型，可留空稍后再配）",
                Some(existing_mid.as_str()).filter(|s| !s.is_empty()),
            )?;
            (prov.id.clone(), model)
        } else {
            let dm = prov
                .models
                .iter()
                .position(|m| *m == existing_mid)
                .unwrap_or(0);
            let mi = p.choose("默认使用哪个模型？", &prov.models, dm)?;
            (prov.id.clone(), prov.models[mi].clone())
        }
    };

    // ── 7. 工具白名单 ──
    step!("工具白名单");
    p.say("  勾选这个 Agent 能用哪些工具；留空 = 不限制。");
    let tool_labels: Vec<String> = env
        .tools
        .iter()
        .map(|(name, desc)| format!("{}  {}", name, brief(desc, 64)))
        .collect();
    let existing_tools = existing.map(|e| get_strs(e, "allowTools")).unwrap_or_default();
    let tool_default: Vec<usize> = if existing_tools.is_empty() {
        // 新增 / 原本就没白名单 → 默认全选（与桌面端「新建 Agent 默认全选所有工具」一致）
        (0..env.tools.len()).collect()
    } else {
        env.tools
            .iter()
            .enumerate()
            .filter(|(_, (nm, _))| existing_tools.contains(nm))
            .map(|(i, _)| i)
            .collect()
    };
    let picked = p.multi("勾选工具：", &tool_labels, &tool_default)?;
    let allow_tools: Vec<String> = picked.iter().map(|i| env.tools[*i].0.clone()).collect();

    // ── 8. 技能（没有技能目录就跳过，不占一个空步） ──
    let mut skills: Vec<String> = existing.map(|e| get_strs(e, "skills")).unwrap_or_default();
    if env.skills.is_empty() {
        p.say("  （没发现技能：技能目录 <data_dir>/skills 为空或不存在，跳过）");
    } else {
        step!("技能");
        let skill_default: Vec<usize> = env
            .skills
            .iter()
            .enumerate()
            .filter(|(_, s)| skills.contains(s))
            .map(|(i, _)| i)
            .collect();
        let picked = p.multi(
            "勾选这个 Agent 默认启用的技能（留空 = 不启用）：",
            &env.skills,
            &skill_default,
        )?;
        skills = picked.iter().map(|i| env.skills[*i].clone()).collect();
    }

    // ── 9. 默认参数 ──
    step!("默认参数");
    let temp_default = existing
        .and_then(|e| e.get("defaultParams"))
        .and_then(|p| p.get("temperature"))
        .and_then(Value::as_f64)
        .unwrap_or(0.7);
    let top_p_default = existing
        .and_then(|e| e.get("defaultParams"))
        .and_then(|p| p.get("topP"))
        .and_then(Value::as_f64)
        .unwrap_or(1.0);
    let temperature = parse_f64(&p.text_with(
        "温度（0 ~ 2，越大越随机）",
        Some(&format!("{}", temp_default)),
        validate_temperature,
    )?)?;
    let top_p = parse_f64(&p.text_with(
        "topP（0 ~ 1）",
        Some(&format!("{}", top_p_default)),
        validate_top_p,
    )?)?;

    // ── 10. 回显 + 确认 ──
    step!("确认写入");
    p.say(&format!("  id          : {}", id));
    p.say(&format!("  名称        : {}", name));
    p.say(&format!("  描述        : {}", description));
    p.say(&format!(
        "  身份 / 性格 : {} / {}",
        if identity.is_empty() { "（空）" } else { &identity },
        if personality.is_empty() { "（空）" } else { &personality }
    ));
    p.say(&format!(
        "  工作目录    : {}",
        if default_workspace.is_empty() {
            "（未设置）".to_string()
        } else {
            default_workspace.clone()
        }
    ));
    p.say(&format!(
        "  规则文件    : {}",
        if project_rules_file.is_empty() {
            "（不注入）".to_string()
        } else {
            project_rules_file.clone()
        }
    ));
    p.say(&format!(
        "  默认模型    : {} / {}",
        if provider_config_id.is_empty() {
            "（未选）"
        } else {
            &provider_config_id
        },
        if model_id.is_empty() { "（未选）" } else { &model_id }
    ));
    p.say(&format!(
        "  工具        : {}",
        if allow_tools.is_empty() {
            "（不限制）".to_string()
        } else {
            format!("{} 个：{}", allow_tools.len(), allow_tools.join(", "))
        }
    ));
    p.say(&format!(
        "  技能        : {}",
        if skills.is_empty() {
            "（无）".to_string()
        } else {
            skills.join(", ")
        }
    ));
    p.say(&format!("  温度 / topP : {} / {}", temperature, top_p));
    if !p.confirm("写入配置？", true)? {
        return Err("已取消，未写入任何内容".to_string());
    }

    Ok(AgentDraft {
        id: id.to_string(),
        name,
        description,
        identity,
        personality,
        default_workspace,
        project_rules_file,
        provider_config_id,
        model_id,
        allow_tools,
        skills,
        temperature,
        top_p,
    })
}

/// 落库（add 与 edit 共用）
async fn finish_write(
    settings: &dyn SettingsRepo,
    arr: &mut Vec<Value>,
    draft: &AgentDraft,
    is_new: bool,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    let now = virlen_core::telemetry::now_ms();
    let mut patch = Map::new();
    patch.insert("name".into(), json!(draft.name));
    patch.insert("description".into(), json!(draft.description));
    patch.insert("identity".into(), json!(draft.identity));
    patch.insert("personality".into(), json!(draft.personality));
    patch.insert("defaultWorkspace".into(), json!(draft.default_workspace));
    patch.insert("projectRulesFile".into(), json!(draft.project_rules_file));
    patch.insert(
        "defaultModel".into(),
        json!({
            "providerConfigId": draft.provider_config_id,
            "modelId": draft.model_id,
        }),
    );
    patch.insert("allowTools".into(), json!(draft.allow_tools));
    patch.insert("skills".into(), json!(draft.skills));
    patch.insert(
        "defaultParams".into(),
        json!({ "temperature": draft.temperature, "topP": draft.top_p }),
    );
    patch.insert("updatedAt".into(), json!(now));
    if is_new {
        patch.insert("createdAt".into(), json!(now));
    }

    if let Err(e) = upsert_by_id(arr, ID_FIELD, &draft.id, &patch) {
        let _ = writeln!(err, "错误: {}", e);
        return EXIT_ERROR;
    }
    match write_array(settings, KEY, arr).await {
        Ok(()) => {
            let _ = writeln!(
                out,
                "{}Agent `{}`（{}）",
                if is_new { "已新增 " } else { "已更新 " },
                draft.id,
                draft.name
            );
            let _ = writeln!(
                out,
                "  工具 {} 个  技能 {} 个  模型 {}/{}",
                draft.allow_tools.len(),
                draft.skills.len(),
                draft.provider_config_id,
                draft.model_id
            );
            let _ = writeln!(
                err,
                "提示: 桌面端正在运行时，它下次改动会用内存副本整组覆盖 agents —— 请重启桌面端（或先退出它再改）。"
            );
            EXIT_OK
        }
        Err(e) => {
            let _ = writeln!(err, "错误: {}", e);
            EXIT_ERROR
        }
    }
}

// ==================== rm ====================

async fn run_rm(
    db: &virlen_core::session_db::SessionDb,
    id: &str,
    yes: bool,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    if id == DEFAULT_AGENT_ID {
        let _ = writeln!(
            err,
            "错误: 默认 Agent（{}）不可删除 —— 桌面端靠它兜底，删了也会被重建出来",
            DEFAULT_AGENT_ID
        );
        return EXIT_ERROR;
    }
    let settings: &dyn SettingsRepo = db.settings.as_ref();
    let mut arr = match read_array(settings, KEY).await {
        Ok(a) => a,
        Err(e) => {
            let _ = writeln!(err, "错误: {}", e);
            return EXIT_ERROR;
        }
    };
    let Some(idx) = find_index(&arr, ID_FIELD, id) else {
        let _ = writeln!(err, "错误: Agent 不存在: {}", id);
        return EXIT_ERROR;
    };
    let name = get_str(&arr[idx], "name");

    // 引用检查：删掉被会话引用的 Agent，那些会话会退回默认行为——先让用户知道
    let used = match db.repo.list_sessions().await {
        Ok(list) => list
            .iter()
            .filter(|s| s.agent_id.as_deref() == Some(id))
            .count(),
        Err(e) => {
            let _ = writeln!(err, "警告: 统计会话数失败（按 0 处理）: {}", e);
            0
        }
    };

    if !yes {
        if !std::io::stdin().is_terminal() {
            let _ = writeln!(
                err,
                "错误: 删除需要确认，但 stdin 不是终端。确认要删就加 `--yes`"
            );
            return EXIT_USAGE;
        }
        let mut input = std::io::stdin().lock();
        let tty = std::io::stdin().is_terminal();
        let mut p = Prompter::new(&mut input, &mut *out, tty);
        if used > 0 {
            p.say(&format!("⚠ 有 {} 条会话正使用这个 Agent。", used));
        }
        match p.confirm(&format!("确定删除 `{}`（{}）？", id, name), false) {
            Ok(true) => {}
            Ok(false) => {
                let _ = writeln!(err, "已取消，未删除任何内容");
                return EXIT_ERROR;
            }
            Err(e) => {
                let _ = writeln!(err, "{}", e);
                return EXIT_ERROR;
            }
        }
    }

    remove_by_id(&mut arr, ID_FIELD, id);
    match write_array(settings, KEY, &arr).await {
        Ok(()) => {
            let _ = writeln!(out, "已删除 Agent `{}`（{}）", id, name);
            if used > 0 {
                let _ = writeln!(
                    err,
                    "⚠ 有 {} 条会话仍记录着这个 agentId；它们会退回默认 Agent 的行为。",
                    used
                );
            }
            EXIT_OK
        }
        Err(e) => {
            let _ = writeln!(err, "错误: {}", e);
            EXIT_ERROR
        }
    }
}

// ==================== 校验 ====================

/// 项目规则文件路径：必须是**工作目录内的相对路径**（允许 `AGENTS.md` / `.cursor/rules.md` /
/// `.\docs\MEMORY.md`，拒绝绝对路径 / 盘符 / `~` / 任意 `..` 段 / 空字节 / 超 200 字符）。
///
/// ⚠️ 与 `project-rules.ts::normalizeProjectRulesPath` 是两份实现（可能漂移，改规则时两处一起改）：
/// 真正的准入闸仍在 TS 读路径上（CLI 不读规则文件），这里只防「脏值进配置」—— 差异的后果是多一次
/// 驳回，不是安全漏洞。
fn validate_project_rules_path(input: &str) -> Result<(), String> {
    let raw = input.trim().replace('\\', "/");
    if raw.is_empty() {
        return Ok(()); // 空 = 不注入（合法）
    }
    if raw.chars().count() > 200 {
        return Err("路径过长（上限 200 字符）".to_string());
    }
    if raw.contains('\0') {
        return Err("包含非法字符".to_string());
    }
    if raw.starts_with('/') || raw.starts_with('~') {
        return Err("必须是工作目录内的相对路径（不能是绝对路径 / 家目录）".to_string());
    }
    let b = raw.as_bytes();
    if b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
        return Err("必须是工作目录内的相对路径（不能是盘符路径）".to_string());
    }
    if raw.split('/').any(|seg| seg == "..") {
        return Err("不允许 `..`（会越出工作目录）".to_string());
    }
    if raw.split('/').all(|seg| seg.is_empty() || seg == ".") {
        return Err("路径无效".to_string());
    }
    Ok(())
}

fn validate_temperature(v: &str) -> Result<(), String> {
    match v.trim().parse::<f64>() {
        Ok(x) if (0.0..=2.0).contains(&x) => Ok(()),
        Ok(_) => Err("温度需在 0 ~ 2 之间".to_string()),
        Err(_) => Err("请输入数字".to_string()),
    }
}

fn validate_top_p(v: &str) -> Result<(), String> {
    match v.trim().parse::<f64>() {
        Ok(x) if (0.0..=1.0).contains(&x) => Ok(()),
        Ok(_) => Err("topP 需在 0 ~ 1 之间".to_string()),
        Err(_) => Err("请输入数字".to_string()),
    }
}

fn parse_f64(v: &str) -> Result<f64, String> {
    v.trim()
        .parse::<f64>()
        .map_err(|_| format!("不是合法数字: {}", v))
}

#[cfg(test)]
mod tests;
