//! `run` 子命令 —— 无界面跑一次 agent（headless 对话）
//!
//! ```text
//! virlen-cli run [选项] <prompt>
//! ```
//!
//! ## 形态与边界
//!
//! - **一次性**：发送一条用户消息，跑完整个 agent 循环（含工具调用）后退出；**没有 REPL**。
//! - **与桌面端同一份数据**：库路径 = `host.data_dir()/virlen.db`（与 `config` 子命令同一条
//!   推导链）。消息由引擎**先落库再 emit**，因此 `--session <id>` 续跑读到的就是桌面端那份历史。
//! - **无 JS**：CLI 里没有前端，于是
//!   - 工具执行不需要桥 —— 28 个工具已全部原生化（`is_native_tool` 是全集）。
//!     ⚠️ 但**必须**下发 `security`（`Some(..)`）：`tool_executor` 用 `security.is_some()`
//!     决定走原生还是走 JS 桥，缺了它 CLI 会去请求一个不存在的 JS 宿主而挂起。
//!   - 未原生化能力（`BridgedProvider`，目前只有 Gemini）在**装配阶段**直接拒绝：
//!     给可读错误，而不是等桥无应答挂住。
//!
//! ## 输出约定（stdout 只放正文，方便管道）
//!
//! - **stdout**：助手正文流式增量；`--json` 时改为「每行一个 `AgentEvent`」的 JSON Lines。
//! - **stderr**：工具进度 / 交互提示 / 错误 / 收尾摘要。
//!
//! ⚠️ 事件文本由 [`render_event`]（纯函数）产出，经**无界通道**交给 `run()` 的 select 循环
//! 写入注入的 `out` / `err`。为什么绕这一圈：`EventSink` 是同步 trait 且要求 `Send + Sync`，
//! 无法借用 `&mut dyn Write`；走通道既满足 trait 约束，又保住了「输出走注入的 Write →
//! 单测能断言」这条既有约定（`config.rs` 同款做法）。
//!
//! ## 交互（用户拍板方案 A）
//!
//! 权限为 `ask` 的命令授权（`confirm_command_native`）与 `user_choice` 都在终端里问：
//! - stdin 是 TTY → 提示后读一行（`y` / `yes` 放行，其余按拒绝）；
//! - stdin **不是** TTY（管道 / CI）→ **一律拒绝**（fail-closed，安全优先）。
//!
//! ⚠️ 卡住的代价：引擎在等交互回执时是 `rx.await`，不回就永远不返回 —— 因此每种交互类型
//! （含未知类型）都必须给出应答。

use virlen_core::agent::bridge::{self, AgentBridgeState};
use virlen_core::agent::engine::AgentEngine;
use virlen_core::agent::event_sink::EventSink;
use virlen_core::agent::host::HostEnv;
use virlen_core::agent::prompts::assemble::{compose_system_prompt, PromptParts};
use virlen_core::agent::provider::DefaultProviderFactory;
use virlen_core::agent::tool_defs;
use virlen_core::agent::types::{
    AgentEvent, Message, NativeToolSecurity, ProviderConnection, SendMessageOptions, Session,
    SessionParams, ToolDefinition,
};
use virlen_core::security::SandboxIgnoreRule;
use virlen_core::session_db::{open_session_db, SessionDb};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::io::{BufRead, IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

use crate::{EXIT_ERROR, EXIT_OK};

/// 项目规则文件（相对工作目录）—— 与 TS `DEFAULT_PROJECT_RULES_FILE` 同名
const PROJECT_RULES_FILE: &str = "AGENTS.md";
/// 项目规则文件大小上限（与 TS `MAX_PROJECT_RULES_BYTES` 一致：超限**不注入**而非截断）
const MAX_PROJECT_RULES_BYTES: u64 = 64 * 1024;
/// 工具结果在 stderr 里的预览长度
const TOOL_PREVIEW_CHARS: usize = 160;

/// `run` 的帮助文本（`run --help` / `run -h`）
pub const USAGE_RUN: &str = "\
virlen-cli run —— 无界面跑一次 agent（与桌面端共用同一份配置与会话库）

用法:
  virlen-cli run [选项] <prompt>

选项:
  --session <id>                 续用已有会话（默认新建；会话必须已存在）
  --provider <id>                指定 Provider 配置 id（默认 app_settings.defaultSelectModel）
  --model <id>                   指定模型 id（默认 app_settings.defaultSelectModel）
  --workspace <path>             工作目录（默认当前目录；相对路径按当前目录解析）
                                 ⚠️ 续用 --session 时以**会话记录**为准：记录非空且与本值
                                 不同会直接报错（会话的工作目录创建后不可变更）；
                                 记录为空时依次回退「设置里的默认工作目录」→ 当前目录，
                                 且**不写回会话**
  --append-system-prompt <text>  在组装好的系统提示词之后追加一段指令
  --max-rounds <n>               最大工具调用轮数（默认取 app_settings.maxToolRounds）
  --no-tools                     不启用工具（纯问答）
  --json                         事件按 JSON Lines 输出到 stdout
  -h, --help                     显示本帮助

输出:
  stdout  助手正文（流式）；--json 时每行一个 AgentEvent
  stderr  工具进度 / 交互提示 / 错误

交互（权限为 ask 时）:
  命令授权与 user_choice 会在终端提示并读 stdin（y/yes = 放行）；
  stdin 不是 TTY（管道 / CI）时一律拒绝；
  ⚠️ 重定向 stdout/stderr 后 stdin 仍是终端 → CLI 会等待输入（看起来像卡住）；
     不需要交互时请同时重定向 stdin（Windows: `< NUL`，POSIX: `< /dev/null`），
     或把对应权限改为 allow / deny（设置 → 安全 → 权限管理）。

⚠️ 已知限制:
  - 白名单 / 黑名单 / 跳过目录存在桌面端 localStorage，CLI 读不到（按空处理）；
    路径安全仍由「工作目录 + 沙盒 + 权限三态」兜底。
  - Gemini 等未原生化的 Provider 需要前端 JS 桥，CLI 不支持（装配阶段报错）。
";

// ==================== 参数解析 ====================

/// `run` 的选项
#[derive(Debug, PartialEq, Eq, Default)]
pub(crate) struct RunOptions {
    /// 用户输入（位置参数以空格连接）
    pub prompt: String,
    pub session_id: Option<String>,
    pub provider_id: Option<String>,
    pub model_id: Option<String>,
    pub workspace: Option<String>,
    pub append_system_prompt: Option<String>,
    pub max_rounds: Option<i64>,
    pub no_tools: bool,
    pub json: bool,
}

/// 解析结果
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum RunCmd {
    Help,
    Run(RunOptions),
}

/// 解析 `run` 之后的参数。纯函数 —— 单测直接断言它。
///
/// 位置参数（不含前导 `-` 的 token）全部拼进 `prompt`：`run 解释 一下 README` 与
/// `run "解释一下 README"` 等价，省掉一层 shell 引号心智负担。
pub(crate) fn parse(args: Vec<&str>) -> Result<RunCmd, String> {
    let mut opts = RunOptions::default();
    let mut words: Vec<String> = Vec::new();
    let mut it = args.into_iter();

    while let Some(arg) = it.next() {
        match arg {
            "-h" | "--help" => return Ok(RunCmd::Help),
            "--no-tools" => opts.no_tools = true,
            "--json" => opts.json = true,
            "--session" | "--provider" | "--model" | "--workspace" | "--append-system-prompt"
            | "--max-rounds" => {
                let value = it
                    .next()
                    .ok_or_else(|| format!("选项 {} 缺少取值", arg))?
                    .to_string();
                if value.is_empty() {
                    return Err(format!("选项 {} 的取值不能为空", arg));
                }
                match arg {
                    "--session" => opts.session_id = Some(value),
                    "--provider" => opts.provider_id = Some(value),
                    "--model" => opts.model_id = Some(value),
                    "--workspace" => opts.workspace = Some(value),
                    "--append-system-prompt" => opts.append_system_prompt = Some(value),
                    "--max-rounds" => {
                        let n: i64 = value
                            .parse()
                            .map_err(|_| format!("--max-rounds 需要整数，收到: {}", value))?;
                        if n < 1 {
                            return Err("--max-rounds 必须 >= 1".to_string());
                        }
                        opts.max_rounds = Some(n);
                    }
                    _ => unreachable!("选项已在 match 中穷举"),
                }
            }
            other if other.starts_with("--") => {
                return Err(format!("未知选项: {}（见 `virlen-cli run --help`）", other));
            }
            word => words.push(word.to_string()),
        }
    }

    if words.is_empty() {
        return Err("缺少 prompt（用法: virlen-cli run [选项] <prompt>）".to_string());
    }
    opts.prompt = words.join(" ");
    Ok(RunCmd::Run(opts))
}

// ==================== 配置解析（装配） ====================

/// `app_settings.providers` 里一个 Provider 配置（只取 CLI 需要的字段）
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderLite {
    id: String,
    /// Provider 协议类型（openai / anthropic / gemini …）
    #[serde(rename = "type")]
    type_: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    api_key: String,
    #[serde(default)]
    base_url: String,
    #[serde(default)]
    models: Vec<String>,
    #[serde(default = "default_enabled")]
    enabled: bool,
}

fn default_enabled() -> bool {
    true
}

/// `app_settings.defaultSelectModel`
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct DefaultModel {
    provider_config_id: String,
    model_id: String,
}

/// 装配结果：引擎需要的一切（除会话本身）
#[derive(Debug)]
struct Resources {
    provider: ProviderConnection,
    /// 实际使用的模型 id（写进 session.model_id）
    model_id: String,
    tool_defs: Vec<ToolDefinition>,
    enable_tools: bool,
    security: NativeToolSecurity,
    system_prompt: String,
    workspace: String,
    max_tool_rounds: i64,
    max_iterations: i64,
    max_tokens: i64,
}

/// 解析本次运行的工作目录 —— **会话记录优先**。
///
/// 为什么不能直接用 cwd：会话的工作目录在**创建时**定下，之后不再变化（与桌面端同语义，
/// 见 `services/rust-engine.ts::resolveSecurityConfig` → `securityService.getWorkspace(session.id)`）。
/// 它同时决定三件关键的事：
/// 1. 工具的 cwd 与沙箱的**可写根**；
/// 2. 系统提示词里的「工作目录」与环境信息；
/// 3. 项目规则文件（`AGENTS.md`）从哪个目录注入。
///
/// 曾经的真实 bug：续跑时这里取了 cwd，于是模型在**另一个项目**里读文件 / 写文件，
/// 而且该值还被写回会话（桌面端看到的工作目录也跟着变）。因此：
/// - 记录非空 → 它是唯一答案；`--workspace` 与之不同则**直接报错**（要换目录请新建会话）；
/// - 记录为空（桌面端建会话时未选目录）→ 按桌面端同一条链回退：
///   `--workspace` → 设置里的 `defaultWorkspace`（`getWorkspace` 的兵底）→ cwd；
///   这种情况**不写回会话**，所以会话记录仍保持「无工作目录」。
fn resolve_workspace(
    cmd: &RunOptions,
    cwd: &Path,
    session_workspace: Option<&str>,
    default_workspace: Option<&str>,
) -> Result<String, String> {
    let recorded = session_workspace
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    // 记录值**原样使用**（不再 canonicalize）：目录后来被删掉也不该拦住续跑
    // （工具会给出可读错误）—— 创建时存进会话的已是 canonical 形式。
    let asked = match cmd
        .workspace
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(raw) => Some(canonicalize_workspace(raw, cwd)?),
        None => None,
    };

    match (recorded, asked) {
        (Some(recorded), None) => Ok(recorded),
        (Some(recorded), Some(asked)) if same_path(&asked, &recorded) => Ok(recorded),
        (Some(recorded), Some(asked)) => Err(format!(
            "会话的工作目录不可变更：该会话创建于「{}」，而 --workspace 指定的是「{}」（会话的工作目录在创建时定下、之后不再改变；要换目录请不带 --session 新建会话）",
            recorded, asked
        )),
        (None, Some(asked)) => Ok(asked),
        // 记录为空：按桌面端 `securityService.getWorkspace()` 同一条链回退
        // （`--workspace` → 设置里的 `defaultWorkspace` → cwd）
        (None, None) => Ok(default_workspace
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| cwd.to_string_lossy().to_string())),
    }
}

/// `--workspace` 规范化：相对路径按 `cwd` 解析，并**提前** canonicalize
/// （写错目录时立刻报错，而不是等第一次工具调用才暴露）。
fn canonicalize_workspace(raw: &str, cwd: &Path) -> Result<String, String> {
    let p = PathBuf::from(raw);
    let abs = if p.is_absolute() { p } else { cwd.join(p) };
    let canon =
        dunce::canonicalize(&abs).map_err(|e| format!("工作目录不可用 ({}): {}", abs.display(), e))?;
    Ok(canon.to_string_lossy().to_string())
}

/// 两个路径是否指向同一目录：忽略结尾分隔符，Windows 下大小写不敏感
/// （用户写 `E:\proj\` / `e:/Proj` 不该被判成「改目录」）。
///
/// 只用于「命令行与会话记录是否冲突」的判定 —— 安全校验有自己那套 canonicalize。
fn same_path(a: &str, b: &str) -> bool {
    fn norm(p: &str) -> String {
        let t = p.trim_end_matches(['/', '\\']);
        if cfg!(windows) {
            t.to_lowercase()
        } else {
            t.to_string()
        }
    }
    norm(a) == norm(b)
}

/// 组装引擎入参（纯逻辑 + 读项目规则文件）。
///
/// `cwd` 用于解析相对 `--workspace` 与缺省工作目录（调用方传 `std::env::current_dir()`）；
/// `session_workspace` 是「续用会话时该会话记录的工作目录」——**它优先于 cwd**（见 [`resolve_workspace`]）。
fn build_resources(
    settings: &Map<String, Value>,
    // 「忽略沙盒命令」规则：由调用方经 `security::load_sandbox_ignore_rules` 读好后传入
    // （键名 / 解析 / 失败降级只有那一份实现）
    sandbox_ignore_rules: Vec<SandboxIgnoreRule>,
    cmd: &RunOptions,
    cwd: &Path,
    // 续用会话（`--session`）时该会话记录的**工作目录**；`None` = 新建会话 / 记录为空
    session_workspace: Option<&str>,
) -> Result<Resources, String> {
    let providers: Vec<ProviderLite> = settings
        .get("providers")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();

    let default_model: DefaultModel = settings
        .get("defaultSelectModel")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();

    let fallback = if default_model.provider_config_id.is_empty() || default_model.model_id.is_empty()
    {
        None
    } else {
        Some((
            default_model.provider_config_id.as_str(),
            default_model.model_id.as_str(),
        ))
    };

    let (provider, model_id) = resolve_connection(
        &providers,
        cmd.provider_id.as_deref(),
        cmd.model_id.as_deref(),
        fallback,
    )?;

    // 工作目录：**续用会话时以会话记录为准**，否则 `--workspace` / 默认工作目录 / cwd
    // （见 `resolve_workspace`）
    let workspace = resolve_workspace(
        cmd,
        cwd,
        session_workspace,
        settings.get("defaultWorkspace").and_then(Value::as_str),
    )?;

    let permissions: BTreeMap<String, String> = settings
        .get("permissions")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();

    let security = NativeToolSecurity {
        workspace: workspace.clone(),
        // 旧单一审批模式：CLI 不传（空串 → 走 permissions 表 → 缺失项回退注册表默认值）
        approval_mode: String::new(),
        // ⚠️ skipDirs / blacklist / whitelist 在桌面端存 localStorage，CLI 读不到 → 空。
        // 路径安全仍由「工作目录 + 沙盒 + 权限三态」兜底（见文件头「已知限制」）。
        skip_dirs: Vec::new(),
        blacklist: Vec::new(),
        whitelist: Vec::new(),
        skills_dir: None,
        sandbox_mode: settings
            .get("sandboxMode")
            .and_then(Value::as_str)
            .unwrap_or("on")
            .to_string(),
        permissions,
        // 「忽略沙盒命令」规则：权威源就在 `app_settings`（与桌面端同一份），
        // 判定完全在 Rust 侧（`virlen_core::security`），因此 CLI 天然可用。
        sandbox_ignore_rules,
    };

    let enable_tools = !cmd.no_tools;
    let tool_defs = if enable_tools {
        tool_defs::list_tool_definitions()
    } else {
        Vec::new()
    };

    let allow_env = settings
        .get("allowEnvPrompt")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let system_prompt = build_system_prompt(
        Path::new(&workspace),
        allow_env,
        cmd.append_system_prompt.as_deref(),
    );

    Ok(Resources {
        provider,
        model_id,
        tool_defs,
        enable_tools,
        security,
        system_prompt,
        workspace,
        max_tool_rounds: cmd
            .max_rounds
            .or_else(|| settings.get("maxToolRounds").and_then(Value::as_i64))
            .unwrap_or(30),
        max_iterations: settings
            .get("maxIterations")
            .and_then(Value::as_i64)
            .unwrap_or(5),
        max_tokens: settings
            .get("maxTokens")
            .and_then(Value::as_i64)
            .unwrap_or(32768),
    })
}

/// 解析 Provider 连接与模型。
///
/// - `want_id` / `want_model`：命令行**显式**指定 —— 找不到就报错（绝不静默换一个：
///   用户以为在用 A 模型、实际跑 B 模型，是最难排查的一类问题）。
/// - `fallback`：`app_settings.defaultSelectModel`（缺省来源）。
fn resolve_connection(
    providers: &[ProviderLite],
    want_id: Option<&str>,
    want_model: Option<&str>,
    fallback: Option<(&str, &str)>,
) -> Result<(ProviderConnection, String), String> {
    if providers.is_empty() {
        return Err(
            "未配置任何 Provider（app_settings.providers 为空）：请先在桌面端配置，或使用 `virlen-cli config set providers [...]`"
                .to_string(),
        );
    }

    let pick = |id: &str| providers.iter().find(|p| p.id == id);
    let provider: &ProviderLite = match want_id {
        Some(id) => pick(id).ok_or_else(|| {
            format!(
                "指定的 Provider 不存在: {}（可用: {}）",
                id,
                provider_id_list(providers)
            )
        })?,
        None => {
            let from_default = fallback.and_then(|(pid, _)| pick(pid)).filter(|p| p.enabled);
            from_default
                .or_else(|| providers.iter().find(|p| p.enabled))
                .ok_or_else(|| "没有启用的 Provider（app_settings.providers 全部 enabled=false）".to_string())?
        }
    };

    // 未原生化的协议（Gemini 等）走 `BridgedProvider` —— 需要前端 JS 宿主，CLI 没有。
    // 提前失败，避免运行期卡在桥等待。
    if !matches!(provider.type_.as_str(), "openai" | "anthropic") {
        return Err(format!(
            "CLI 暂不支持 Provider 类型 `{}`（{}）：该协议需要前端 JS 桥（BridgedProvider），请改用 openai 兼容或 anthropic",
            provider.type_,
            if provider.name.is_empty() { provider.id.as_str() } else { provider.name.as_str() }
        ));
    }
    if provider.api_key.trim().is_empty() {
        return Err(format!("Provider `{}` 缺少 apiKey", provider.id));
    }
    if provider.base_url.trim().is_empty() {
        return Err(format!("Provider `{}` 缺少 baseUrl", provider.id));
    }

    let model = match want_model {
        Some(m) => {
            if !provider.models.iter().any(|x| x == m) {
                return Err(format!(
                    "Provider `{}` 未配置模型 `{}`（可用: {}）",
                    provider.id,
                    m,
                    if provider.models.is_empty() {
                        "无".to_string()
                    } else {
                        provider.models.join(", ")
                    }
                ));
            }
            m.to_string()
        }
        None => {
            let from_default = fallback
                .map(|(_, mid)| mid)
                .filter(|mid| provider.models.iter().any(|x| x == mid));
            from_default
                .map(String::from)
                .or_else(|| provider.models.first().cloned())
                .ok_or_else(|| {
                    format!("Provider `{}` 没有可用模型（models 为空）", provider.id)
                })?
        }
    };

    Ok((
        ProviderConnection {
            provider_type: provider.type_.clone(),
            provider_id: provider.id.clone(),
            api_key: provider.api_key.clone(),
            base_url: provider.base_url.clone(),
        },
        model,
    ))
}

fn provider_id_list(providers: &[ProviderLite]) -> String {
    providers
        .iter()
        .map(|p| p.id.clone())
        .collect::<Vec<_>>()
        .join(", ")
}

/// 组装系统提示词。
///
/// 按 TS `services/agent-service.ts` 的同一顺序拼（`prompts/assemble.rs` 已与 TS
/// `compose-prompt.ts` 逐字节对齐，有 golden 测试守）：
/// **基础规范 → 环境 → 项目规则 → 追加指令**。
///
/// CLI 不注入角色 / 身份 / 性格 / 技能 —— 那些来自桌面端的 Agent 配置与技能注册表，
/// headless 下不可得（不是「另一份实现」，而是「没有输入」）。
fn build_system_prompt(workspace: &Path, allow_env: bool, extra: Option<&str>) -> String {
    let env_prompt = if allow_env {
        Some(format!(
            "# Current Environment\n- OS: {} ({})\n- Current working directory: {}",
            std::env::consts::OS,
            std::env::consts::ARCH,
            workspace.display()
        ))
    } else {
        None
    };

    let project_rules = read_project_rules(workspace);
    let mut prompt = compose_system_prompt(&PromptParts {
        env_prompt: env_prompt.as_deref(),
        project_rules: project_rules.as_deref(),
        ..Default::default()
    });

    if let Some(extra) = extra {
        if !extra.trim().is_empty() {
            prompt.push_str("\n\n");
            prompt.push_str(extra.trim());
        }
    }
    prompt
}

/// 读取工作目录下的项目规则文件（读不到 / 超限 / 非文件 → 不注入）
fn read_project_rules(workspace: &Path) -> Option<String> {
    let path = workspace.join(PROJECT_RULES_FILE);
    let meta = std::fs::metadata(&path).ok()?;
    if !meta.is_file() || meta.len() > MAX_PROJECT_RULES_BYTES {
        return None;
    }
    std::fs::read_to_string(&path).ok()
}

/// 技能目录：`<data_dir>/skills`（存在才返回）。
///
/// 前端 `skillStore` 的规则是「技能目录**固定**为 Tauri `appDataDir/skills`」
/// （见其文件头），而 CLI 的 `HostEnv::data_dir()` 与 Tauri `appDataDir()` 指向
/// **同一目录**（`host/cli_host.rs` 的既有保证）—— 因此 CLI 可以自行推导，
/// 不需要前端下发 `NativeToolSecurity.skills_dir`。
///
/// ⚠️ 不推导的后果是**静默**的：`list_skills` / `read_skill_source` 会按
/// 「无技能」返回（见 `native_tools/skill/list_skills.rs`），模型会以为这个环境没有技能。
/// 目录不存在时保持 `None`（与桌面端首次启动、尚无技能时的行为一致）。
fn existing_skills_dir(host: &Arc<dyn HostEnv>) -> Option<String> {
    let dir = host.data_dir().join("skills");
    dir.is_dir().then(|| dir.to_string_lossy().to_string())
}

// ==================== 事件渲染（纯函数） ====================

/// 渲染状态（跳事件累积的少量信息：是否需要补换行、工具行是否已打过）
#[derive(Default, Debug)]
pub(crate) struct RenderState {
    /// 本轮是否已经输出过正文
    printed_text: bool,
    /// 输出是否停在行首（决定结束帧要不要补换行）
    at_line_start: bool,
    /// 已经打过「工具开始行」的 tool_call id。
    ///
    /// 为什么需要：同一次工具调用会被发两帧 `tool_call`（模型宣布调用 / 执行器开始执行），
    /// GUI 靠 id 去重；无界面输出否则会重复一行。
    started_tools: std::collections::HashSet<String>,
}

/// 一个事件渲染出来的文本（两条流分开，便于分别写 stdout / stderr）
#[derive(Default, Debug, PartialEq, Eq)]
pub(crate) struct Rendered {
    pub stdout: String,
    pub stderr: String,
}

impl Rendered {
    fn is_empty(&self) -> bool {
        self.stdout.is_empty() && self.stderr.is_empty()
    }
}

/// 事件 → 文本。纯函数（除 `state` 累积），单测直接断言。
///
/// `--json` 模式：整条事件序列化成一行 JSON 写 stdout（人类文本一律不产出）。
pub(crate) fn render_event(event: &AgentEvent, json: bool, state: &mut RenderState) -> Rendered {
    if json {
        return Rendered {
            stdout: format!(
                "{}\n",
                serde_json::to_string(event).unwrap_or_else(|_| "{}".to_string())
            ),
            stderr: String::new(),
        };
    }

    let data = event.data.as_ref();
    match event.type_.as_str() {
        // 正文增量：唯一被打印的正文来源
        //（`assistant_message_updated` 带同一份 contentDelta，重复打印会出现双份正文）
        "stream_event" => {
            let delta = data
                .and_then(|d| d.get("delta"))
                .and_then(Value::as_str)
                .unwrap_or("");
            if delta.is_empty() {
                return Rendered::default();
            }
            state.printed_text = true;
            state.at_line_start = delta.ends_with('\n');
            Rendered {
                stdout: delta.to_string(),
                stderr: String::new(),
            }
        }
        "stream_end" => {
            let paused = data
                .and_then(|d| d.get("paused"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let mut out = Rendered::default();
            if state.printed_text && !state.at_line_start {
                out.stdout.push('\n');
                state.at_line_start = true;
            }
            if paused {
                out.stderr
                    .push_str("[paused] 运行已暂停（快照保留在内存中，刷新 / 退出即失效）\n");
            }
            state.printed_text = false;
            out
        }
        // 工具开始帧（结束帧带 result，结果统一由 tool_result_created 呈现，避免重复）
        "tool_call" => {
            let Some(d) = data else {
                return Rendered::default();
            };
            if d.get("result").is_some() {
                return Rendered::default();
            }
            let name = d.get("name").and_then(Value::as_str).unwrap_or("tool");
            let id = d.get("id").and_then(Value::as_str).unwrap_or("");
            if !id.is_empty() && !state.started_tools.insert(id.to_string()) {
                // 同一次调用的第二帧（开始执行）—— 前面已经打过行了
                return Rendered::default();
            }
            Rendered {
                stdout: String::new(),
                stderr: format!("\n[tool] {}\n", name),
            }
        }
        "tool_result_created" => {
            let msg = data.and_then(|d| d.get("message"));
            let content = msg
                .and_then(|m| m.get("content"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let failed = msg
                .and_then(|m| m.get("isError"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            Rendered {
                stdout: String::new(),
                stderr: format!(
                    "[tool]   → {} ({} 字符): {}\n",
                    if failed { "failed" } else { "ok" },
                    content.chars().count(),
                    one_line_preview(content, TOOL_PREVIEW_CHARS)
                ),
            }
        }
        "error" => Rendered {
            stdout: String::new(),
            stderr: format!(
                "\n[error] {}\n",
                event.error.as_deref().unwrap_or("unknown error")
            ),
        },
        // 迭代验证（默认不启用，只有传 iterationGoal 时才有）
        "iteration_start" => Rendered {
            stdout: String::new(),
            stderr: format!(
                "\n[iteration] 第 {} 轮\n",
                data.and_then(|d| d.get("iteration"))
                    .and_then(Value::as_i64)
                    .unwrap_or(1)
            ),
        },
        "iteration_verify_start" => Rendered {
            stdout: String::new(),
            stderr: "[iteration] 验证中…\n".to_string(),
        },
        "iteration_verify_pass" => Rendered {
            stdout: String::new(),
            stderr: "[iteration] 验证通过\n".to_string(),
        },
        "iteration_verify_fail" => Rendered {
            stdout: String::new(),
            stderr: "[iteration] 验证未通过，继续修复\n".to_string(),
        },
        "iteration_max_exceeded" => Rendered {
            stdout: String::new(),
            stderr: "[iteration] 已达最大迭代次数\n".to_string(),
        },
        // 其余（assistant_message_created/updated、update_message_id、user_interaction…）
        // 对无界面输出无意义
        _ => Rendered::default(),
    }
}

/// 单行预览：换行压成空格，超长截断
fn one_line_preview(s: &str, max_chars: usize) -> String {
    let flat = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max_chars {
        return flat;
    }
    let mut out: String = flat.chars().take(max_chars).collect();
    out.push('…');
    out
}

// ==================== 交互应答（方案 A） ====================

/// 由终端输入解析 `user_choice` 的回答；`None` = 取消。
///
/// 与桌面端 `tool-ui.tsx::handleChoiceConfirm` 同口径：多个选中项用 `, ` 连接；
/// 非选项的自由文本按「自定义回复」原样带上（对应 GUI 的 customReply）。
pub(crate) fn resolve_choice(input: &str, options: &[String], multi: bool) -> Option<String> {
    let raw = input.trim();
    if raw.is_empty() {
        return None;
    }

    let pick_one = |token: &str| -> Option<String> {
        let t = token.trim();
        if t.is_empty() {
            return None;
        }
        if let Ok(n) = t.parse::<usize>() {
            if n >= 1 && n <= options.len() {
                return Some(options[n - 1].clone());
            }
        }
        if let Some(hit) = options.iter().find(|o| o.as_str() == t) {
            return Some(hit.clone());
        }
        options
            .iter()
            .find(|o| o.eq_ignore_ascii_case(t))
            .cloned()
    };

    if !multi {
        return Some(pick_one(raw).unwrap_or_else(|| raw.to_string()));
    }

    let mut picked: Vec<String> = Vec::new();
    let mut custom: Vec<String> = Vec::new();
    for token in raw.split([',', '，', '、', ';', '；']) {
        let t = token.trim();
        if t.is_empty() {
            continue;
        }
        match pick_one(t) {
            Some(o) => picked.push(o),
            None => custom.push(t.to_string()),
        }
    }
    picked.extend(custom);
    if picked.is_empty() {
        None
    } else {
        Some(picked.join(", "))
    }
}

/// 读一行 stdin（去掉行尾换行）；读不到（EOF / 出错）返回空串
fn read_stdin_line(input: &mut impl BufRead) -> String {
    let mut line = String::new();
    match input.read_line(&mut line) {
        Ok(_) => line.trim_end_matches(['\r', '\n']).to_string(),
        Err(_) => String::new(),
    }
}

/// 应答一次用户交互（**同步、可能阻塞** —— 由调用方放进 `spawn_blocking`）
///
/// 返回桥协议载荷：`{__kind:"value", value}` 表示正常回答，`{__kind:"cancelled"}` 表示拒绝。
fn ask_user(kind: &str, data: &Value, interactive: bool, stdin: &mut impl BufRead) -> Value {
    let denied = || json!({ "__kind": "cancelled" });

    match kind {
        "confirm_command_native" => {
            let title = data.get("title").and_then(Value::as_str).unwrap_or("");
            let desc = data.get("desc").and_then(Value::as_str).unwrap_or("");
            let hint = data.get("hint").and_then(Value::as_str).unwrap_or("");
            let risk = data.get("risk").and_then(Value::as_str).unwrap_or("");

            eprintln!("\n[confirm] {}（权限: {}）", title, risk);
            if !desc.is_empty() {
                eprintln!("  内容: {}", desc);
            }
            if !hint.is_empty() {
                eprintln!("  {}", hint);
            }
            if !interactive {
                eprintln!("  → 非交互终端，已拒绝（fail-closed）");
                return denied();
            }
            eprint!("  允许执行？[y/N] ");
            let _ = std::io::stderr().flush();
            let answer = read_stdin_line(stdin);
            if matches!(answer.trim().to_ascii_lowercase().as_str(), "y" | "yes") {
                // Rust 侧 `parse_approval` 认 `approved` 文本（与桌面端弹窗同一条路径）
                json!({ "__kind": "value", "value": "approved" })
            } else {
                eprintln!("  → 已拒绝");
                denied()
            }
        }
        "user_choice" => {
            let question = data.get("question").and_then(Value::as_str).unwrap_or("");
            let multi = data.get("multi").and_then(Value::as_bool).unwrap_or(false);
            let options: Vec<String> = data
                .get("options")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .map(|v| match v {
                            Value::String(s) => s.clone(),
                            other => other.to_string(),
                        })
                        .collect()
                })
                .unwrap_or_default();

            eprintln!("\n[question] {}", question);
            for (i, o) in options.iter().enumerate() {
                eprintln!("  {}. {}", i + 1, o);
            }
            if !interactive {
                eprintln!("  → 非交互终端，无选择（按取消处理）");
                return denied();
            }
            eprint!(
                "  请输入{}（直接回车 = 取消）: ",
                if multi {
                    "序号或文本，逗号分隔可多选"
                } else {
                    "序号或文本"
                }
            );
            let _ = std::io::stderr().flush();
            let answer = read_stdin_line(stdin);
            match resolve_choice(&answer, &options, multi) {
                Some(content) => json!({ "__kind": "value", "value": content }),
                None => denied(),
            }
        }
        other => {
            // 未知类型也必须应答 —— 否则引擎会一直等回执（见文件头）
            eprintln!("\n[interaction] 未支持的交互类型 `{}`，已拒绝", other);
            denied()
        }
    }
}

// ==================== 事件出口 ====================

/// CLI 事件出口：渲染成文本后经无界通道交给 `run()` 的 select 循环写流；
/// 桥请求（交互 / 轮次边界 / 未原生化的工具与 Provider）在这里就地应答。
struct CliEventSink {
    bridge: Arc<AgentBridgeState>,
    tx: mpsc::UnboundedSender<Rendered>,
    json: bool,
    interactive: bool,
    state: Mutex<RenderState>,
}

impl CliEventSink {
    fn new(
        bridge: Arc<AgentBridgeState>,
        tx: mpsc::UnboundedSender<Rendered>,
        json: bool,
        interactive: bool,
    ) -> Self {
        Self {
            bridge,
            tx,
            json,
            interactive,
            state: Mutex::new(RenderState::default()),
        }
    }

    /// 在 runtime 里异步执行一个桥回执（emit 是同步函数，不能 await）
    fn spawn_reply<F>(&self, future: F)
    where
        F: std::future::Future<Output = ()> + Send + 'static,
    {
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(future);
        }
    }
}

impl EventSink for CliEventSink {
    fn emit_agent_event(&self, _session_id: &str, event: &AgentEvent) {
        let rendered = {
            let mut state = self.state.lock().unwrap();
            render_event(event, self.json, &mut state)
        };
        if !rendered.is_empty() {
            let _ = self.tx.send(rendered);
        }
    }

    fn emit_raw(&self, event_name: &str, payload: serde_json::Value) {
        let Some(request_id) = payload
            .get("requestId")
            .and_then(Value::as_str)
            .map(String::from)
        else {
            return;
        };

        match event_name {
            // 真的在问用户（命令授权 / 选择）：提示 + 读 stdin（阻塞放 blocking 池）
            "agent:user-interaction-request" => {
                let kind = payload
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let data = payload.get("data").cloned().unwrap_or(Value::Null);
                let bridge = self.bridge.clone();
                let interactive = self.interactive;
                self.spawn_reply(async move {
                    let answer = tokio::task::spawn_blocking(move || {
                        let stdin = std::io::stdin();
                        let mut lock = stdin.lock();
                        ask_user(&kind, &data, interactive, &mut lock)
                    })
                    .await
                    .unwrap_or_else(|_| json!({ "__kind": "cancelled" }));
                    bridge::handle_user_interaction_response(&bridge, &request_id, answer).await;
                });
            }
            // 轮次边界注入：CLI 没有「回复期间用户改清单」这种来源 → 空注入。
            // 必须回，否则引擎要等 5s 超时（`ROUND_BOUNDARY_TIMEOUT`）。
            "agent:round-boundary" => {
                let bridge = self.bridge.clone();
                self.spawn_reply(async move {
                    bridge::handle_round_boundary_response(
                        &bridge,
                        &request_id,
                        json!({ "messages": [] }),
                    )
                    .await;
                });
            }
            // 以下两类在 CLI 里都不该发生（工具全原生化；BridgedProvider 已在装配期拒绝）。
            // 仍然应答：宁可给出可读失败，也不要挂起。
            "agent:tool-request" => {
                let tool_name = payload
                    .get("toolName")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_string();
                eprintln!(
                    "[bridge] 工具 `{}` 未原生化，CLI 无 JS 执行环境 → 失败",
                    tool_name
                );
                let bridge = self.bridge.clone();
                self.spawn_reply(async move {
                    bridge::handle_tool_response(
                        &bridge,
                        &request_id,
                        json!({
                            "__kind": "error",
                            "message": format!(
                                "CLI has no JS runtime: tool `{}` is not natively implemented",
                                tool_name
                            ),
                        }),
                    )
                    .await;
                });
            }
            "agent:provider-request" => {
                eprintln!("[bridge] 该 Provider 需要前端 JS 桥，CLI 不支持 → 失败");
                let bridge = self.bridge.clone();
                self.spawn_reply(async move {
                    bridge::handle_provider_stream_done(
                        &bridge,
                        &request_id,
                        None,
                        Some("CLI has no JS runtime: provider requires the JS bridge".to_string()),
                    )
                    .await;
                });
            }
            // `agent:tool-output`（PTY 实时输出）：CLI 不逐块打印，只在工具结束时给摘要，
            // 避免与正文交错成噪音。需要实时进度时看桌面端。
            _ => {}
        }
    }
}

// ==================== 驱动 ====================

/// `run` 子命令入口。返回进程退出码。
pub(super) async fn run(
    host: &Arc<dyn HostEnv>,
    cmd: RunCmd,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    let opts = match cmd {
        RunCmd::Help => {
            let _ = write!(out, "{}", USAGE_RUN);
            return EXIT_OK;
        }
        RunCmd::Run(opts) => opts,
    };

    let cwd = match std::env::current_dir() {
        Ok(p) => p,
        Err(e) => {
            let _ = writeln!(err, "错误: 无法获取当前目录: {}", e);
            return EXIT_ERROR;
        }
    };

    // 与 `config` 子命令**同一条**库路径推导链
    let db_path = host.data_dir().join("virlen.db");
    let db = match open_session_db(host.as_ref(), &|fut| {
        tokio::spawn(fut);
    }) {
        Ok(db) => db,
        Err(e) => {
            let _ = writeln!(err, "错误: 打开数据库失败 ({}): {}", db_path.display(), e);
            return EXIT_ERROR;
        }
    };

    let settings = match db.settings.get_all().await {
        Ok(m) => m,
        Err(e) => {
            let _ = writeln!(err, "错误: 读取配置失败: {}", e);
            return EXIT_ERROR;
        }
    };

    // ⚠️ 续用会话时必须**先**读会话记录里的工作目录（它是权威），再装配资源 ——
    //    顺序反过来 cwd 就会顶掉会话的工作目录（曾经的真实 bug，见 `resolve_workspace`）。
    let session_workspace: Option<String> = match opts.session_id.as_deref() {
        Some(id) => match db.repo.get_session(id).await {
            Ok(Some(s)) => s.workspace,
            Ok(None) => {
                let _ = writeln!(
                    err,
                    "错误: 会话不存在: {}（用 `virlen-cli run` 不带 --session 新建一条）",
                    id
                );
                return EXIT_ERROR;
            }
            Err(e) => {
                let _ = writeln!(err, "错误: 读取会话失败: {}", e);
                return EXIT_ERROR;
            }
        },
        None => None,
    };

    // 「忽略沙盒命令」规则经 `security` 的统一入口读取（键名 / 解析 / 降级只有一份）
    let sandbox_ignore_rules =
        virlen_core::security::load_sandbox_ignore_rules(db.settings.as_ref()).await;
    let resources = match build_resources(
        &settings,
        sandbox_ignore_rules,
        &opts,
        &cwd,
        session_workspace.as_deref(),
    ) {
        Ok(r) => r,
        Err(e) => {
            let _ = writeln!(err, "错误: {}", e);
            return EXIT_ERROR;
        }
    };
    // 会话记录里没有工作目录（桌面端建会话时未选）→ 本次用推出的值，但**不写回会话**，
    // 好让「创建时没有」这件事保持原样（否则桌面端会措手不及）
    if opts.session_id.is_some()
        && session_workspace
            .as_deref()
            .map(str::trim)
            .unwrap_or("")
            .is_empty()
    {
        let _ = writeln!(
            err,
            "[run] 该会话没有记录工作目录 → 本次使用 {}（不写回会话）",
            resources.workspace
        );
    }
    // 技能目录（推导规则与前端 `skillStore` 一致）—— 不补会让技能相关工具**静默**失效
    let mut resources = resources;
    resources.security.skills_dir = existing_skills_dir(host);

    let (session, messages) = match load_or_create_session(&db, &resources, &opts).await {
        Ok(v) => v,
        Err(e) => {
            let _ = writeln!(err, "错误: {}", e);
            return EXIT_ERROR;
        }
    };

    let _ = writeln!(
        err,
        "[run] session={} model={} tools={} workspace={}",
        session.id,
        resources.model_id,
        if resources.enable_tools {
            resources.tool_defs.len().to_string()
        } else {
            "off".to_string()
        },
        resources.workspace
    );

    let interactive = std::io::stdin().is_terminal();
    let (tx, mut rx) = mpsc::unbounded_channel::<Rendered>();
    let bridge = Arc::new(AgentBridgeState::default());
    let sink: Arc<dyn EventSink> = Arc::new(CliEventSink::new(
        bridge.clone(),
        tx,
        opts.json,
        interactive,
    ));

    let engine = AgentEngine::with_deps(
        bridge.clone(),
        sink.clone(),
        db.repo.clone(),
        Arc::new(DefaultProviderFactory {
            bridge: bridge.clone(),
            sink: sink.clone(),
        }),
        host.clone(),
        db.settings.clone(),
    );

    // `session_id` 与 `session.id` 必须一致（桌面端 `rust-engine.ts` 也是这么传的）：
    // 引擎用 `session_id` 发事件 / 落库，用 `session.id` 取会话元数据。
    let session_id = session.id.clone();
    let options = SendMessageOptions {
        session,
        messages,
        provider: Some(resources.provider),
        tool_defs: resources.tool_defs,
        enable_tools: resources.enable_tools,
        max_tokens: Some(resources.max_tokens),
        resume_from_snapshot: None,
        reasoning_effort: None,
        max_tool_rounds: resources.max_tool_rounds,
        iteration_goal: None,
        max_iterations: resources.max_iterations,
        session_id,
        security: Some(resources.security),
        trace_id: None,
    };

    let started = virlen_core::telemetry::now_ms();
    let mut fut = Box::pin(engine.send_message(options));
    let result = loop {
        tokio::select! {
            res = &mut fut => break res,
            maybe = rx.recv() => {
                match maybe {
                    Some(r) => flush_rendered(&mut *out, &mut *err, r),
                    // 发送端未 drop（`sink` 由本函数持有）→ 实际不可达；留着只为穷举
                    None => break Ok(()),
                }
                // 一次唤醒把积压全部写出去，避免高频率增量下打印滞后
                while let Ok(r) = rx.try_recv() {
                    flush_rendered(&mut *out, &mut *err, r);
                }
            }
        }
    };
    // 收尾：drain 残余事件（sender 由 engine/sink 持有，可能还有几条）
    drop(sink);
    while let Ok(r) = rx.try_recv() {
        flush_rendered(&mut *out, &mut *err, r);
    }
    let _ = out.flush();
    let _ = err.flush();

    let elapsed_ms = virlen_core::telemetry::now_ms() - started;
    match result {
        Ok(()) => {
            let _ = writeln!(err, "[done] 用时 {} ms", elapsed_ms);
            EXIT_OK
        }
        Err(e) => {
            let _ = writeln!(err, "\n[error] {}", e);
            let _ = writeln!(err, "[failed] 用时 {} ms", elapsed_ms);
            EXIT_ERROR
        }
    }
}

/// 把渲染结果写进两条流（stdout 放正文，stderr 放进度/错误）
fn flush_rendered(out: &mut dyn Write, err: &mut dyn Write, r: Rendered) {
    if !r.stdout.is_empty() {
        let _ = out.write_all(r.stdout.as_bytes());
        let _ = out.flush();
    }
    if !r.stderr.is_empty() {
        let _ = err.write_all(r.stderr.as_bytes());
        let _ = err.flush();
    }
}

/// 取会话：`--session` 则续用（读历史消息），否则新建一条。
///
/// 续用时 Provider / 模型的选择顺序：**命令行 > 会话自身 > app_settings 默认**
/// （命令行给了却找不到会报错，见 [`resolve_connection`]）。
async fn load_or_create_session(
    db: &SessionDb,
    resources: &Resources,
    opts: &RunOptions,
) -> Result<(Session, Vec<Message>), String> {
    let now = virlen_core::telemetry::now_ms();
    let user_message = Message {
        id: uuid::Uuid::new_v4().to_string(),
        role: "user".to_string(),
        content: Value::String(opts.prompt.clone()),
        timestamp: now,
        ..Default::default()
    };

    let Some(session_id) = opts.session_id.as_ref() else {
        // 新会话：标题取 prompt 首行（与桌面端的「截取首条用户消息」同口径）
        let session = Session {
            id: uuid::Uuid::new_v4().to_string(),
            title: title_from_prompt(&opts.prompt),
            messages: Vec::new(),
            provider_config_id: resources.provider.provider_id.clone(),
            model_id: resources.model_id.clone(),
            system_prompt: resources.system_prompt.clone(),
            params: SessionParams {
                temperature: 0.7,
                top_p: 1.0,
                max_tokens: resources.max_tokens,
                stream: true,
                reasoning_effort: None,
            },
            created_at: now,
            updated_at: now,
            pinned: false,
            tags: Vec::new(),
            workspace: Some(resources.workspace.clone()),
            agent_id: None,
            allowed_tools: None,
            skills: None,
            system_prompt_manually_edited: None,
        };
        return Ok((session, vec![user_message]));
    };

    let Some(mut session) = db
        .repo
        .get_session(session_id)
        .await
        .map_err(|e| format!("读取会话失败: {}", e))?
    else {
        return Err(format!(
            "会话不存在: {}（用 `virlen-cli run` 不带 --session 新建一条）",
            session_id
        ));
    };

    // 命令行显式指定 → 覆盖；否则沿用会话自身的 Provider / 模型
    if let Some(pid) = opts.provider_id.as_ref() {
        session.provider_config_id = pid.clone();
    }
    if let Some(mid) = opts.model_id.as_ref() {
        session.model_id = mid.clone();
    }
    // ⚠️ 会话的工作目录**创建时定下、之后不可变**（与桌面端 `getWorkspace(session.id)` 同语义）：
    // 续用路径**一律不写回** —— 曾经的 bug 就是这里无条件覆盖，换个目录续跑就把会话的
    // 工作目录改掉（桌面端看到的工作目录也跟着变）。
    if opts.append_system_prompt.is_some() {
        // 追加指令来自本次命令行 → 只影响本次调用（不写回会话的系统提示词）
        session.system_prompt = resources.system_prompt.clone();
    }
    session.params.stream = true;
    session.updated_at = now;

    let history = db
        .repo
        .get_messages(session_id)
        .await
        .map_err(|e| format!("读取会话消息失败: {}", e))?;

    let mut messages = history;
    messages.push(user_message);
    Ok((session, messages))
}

/// 会话标题：prompt 首行，最多 60 字符
fn title_from_prompt(prompt: &str) -> String {
    let first = prompt.lines().next().unwrap_or("").trim();
    if first.chars().count() <= 60 {
        return first.to_string();
    }
    first.chars().take(60).collect::<String>() + "…"
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn args(v: &[&'static str]) -> Vec<&'static str> {
        v.to_vec()
    }

    /// 测试用装配入口：不注入「忽略沙盒命令」规则（规则本身有专门用例）
    fn build(settings: &Map<String, Value>, cmd: &RunOptions) -> Result<Resources, String> {
        build_resources(settings, Vec::new(), cmd, Path::new("."), None)
    }

    /// 桌面端典型配置：一个启用的 OpenAI 兼容 Provider + 两个模型
    fn settings_with(extra: Value) -> Map<String, Value> {
        let providers = json!([{
            "id": "p1",
            "name": "OpenAI",
            "type": "openai",
            "apiKey": "sk-test",
            "baseUrl": "https://api.openai.com/v1",
            "models": ["gpt-4o", "gpt-4o-mini"],
            "enabled": true
        }]);
        let mut map = json!({ "providers": providers });
        if let (Some(base), Some(extra_map)) = (map.as_object_mut(), extra.as_object()) {
            for (k, v) in extra_map {
                base.insert(k.clone(), v.clone());
            }
        }
        serde_json::from_value(map).unwrap()
    }

    // ==================== 参数解析 ====================

    #[test]
    fn parse_help_variants() {
        for flag in ["-h", "--help"] {
            assert_eq!(parse(args(&[flag])), Ok(RunCmd::Help));
        }
    }

    #[test]
    fn parse_requires_prompt() {
        assert!(parse(args(&[])).is_err());
        // 只有选项、没有位置参数 → 同样是用法错误
        assert!(parse(args(&["--json"])).is_err());
        assert!(parse(args(&["--session", "s1"])).is_err());
    }

    /// 位置参数以空格连接：不必为整个 prompt 加引号
    #[test]
    fn parse_joins_positional_words() {
        assert_eq!(
            parse(args(&["解释", "一下", "README"])),
            Ok(RunCmd::Run(RunOptions {
                prompt: "解释 一下 README".to_string(),
                ..Default::default()
            }))
        );
        // 选项可以出现在 prompt 之前 / 之后
        assert_eq!(
            parse(args(&["--json", "hi"])),
            Ok(RunCmd::Run(RunOptions {
                prompt: "hi".to_string(),
                json: true,
                ..Default::default()
            }))
        );
    }

    #[test]
    fn parse_all_options() {
        let parsed = parse(args(&[
            "--session",
            "s1",
            "--provider",
            "p1",
            "--model",
            "gpt-4o",
            "--workspace",
            "E:/tmp",
            "--append-system-prompt",
            "用中文回答",
            "--max-rounds",
            "5",
            "--no-tools",
            "--json",
            "你好",
        ]))
        .unwrap();
        assert_eq!(
            parsed,
            RunCmd::Run(RunOptions {
                prompt: "你好".to_string(),
                session_id: Some("s1".into()),
                provider_id: Some("p1".into()),
                model_id: Some("gpt-4o".into()),
                workspace: Some("E:/tmp".into()),
                append_system_prompt: Some("用中文回答".into()),
                max_rounds: Some(5),
                no_tools: true,
                json: true,
            })
        );
    }

    #[test]
    fn parse_rejects_bad_usage() {
        assert!(parse(args(&["--nope", "hi"])).is_err(), "未知选项");
        assert!(parse(args(&["--session"])).is_err(), "缺取值");
        assert!(parse(args(&["--session", ""])).is_err(), "空取值");
        assert!(parse(args(&["--max-rounds", "abc", "hi"])).is_err());
        assert!(parse(args(&["--max-rounds", "0", "hi"])).is_err());
    }

    // ==================== 配置装配 ====================

    #[test]
    fn build_resources_uses_default_model_and_limits() {
        let settings = settings_with(json!({
            "defaultSelectModel": { "providerConfigId": "p1", "modelId": "gpt-4o-mini" },
            "maxTokens": 1234,
            "maxToolRounds": 7,
            "maxIterations": 2,
            "sandboxMode": "off",
            "permissions": { "terminal.normal.execute": "ask" }
        }));
        let res = build(
            &settings,
            &RunOptions {
                prompt: "hi".into(),
                ..Default::default()
            },
        )
        .unwrap();

        assert_eq!(res.provider.provider_type, "openai");
        assert_eq!(res.provider.provider_id, "p1");
        assert_eq!(res.provider.api_key, "sk-test");
        assert_eq!(res.model_id, "gpt-4o-mini", "取 defaultSelectModel");
        assert_eq!(res.max_tokens, 1234);
        assert_eq!(res.max_tool_rounds, 7);
        assert_eq!(res.max_iterations, 2);
        assert_eq!(res.enable_tools, true);
        assert_eq!(res.tool_defs.len(), 28, "启用工具时必须下发全量定义");
        assert_eq!(res.security.sandbox_mode, "off");
        assert_eq!(
            res.security.permissions.get("terminal.normal.execute"),
            Some(&"ask".to_string())
        );
        assert!(res.system_prompt.contains("# Current Environment"));
        assert!(
            res.system_prompt.starts_with("# Tool Call Specification"),
            "基础规范必须打头（与 TS compose-prompt 同序）"
        );
    }

    /// 命令行显式给的 provider / model / 轮数优先级最高
    #[test]
    fn build_resources_command_line_overrides_defaults() {
        let settings = settings_with(json!({
            "defaultSelectModel": { "providerConfigId": "p1", "modelId": "gpt-4o-mini" },
            "maxToolRounds": 7
        }));
        let res = build(
            &settings,
            &RunOptions {
                prompt: "hi".into(),
                model_id: Some("gpt-4o".into()),
                max_rounds: Some(3),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(res.model_id, "gpt-4o");
        assert_eq!(res.max_tool_rounds, 3);
    }

    #[test]
    fn build_resources_no_tools_disables_defs() {
        let settings = settings_with(json!({}));
        let res = build(
            &settings,
            &RunOptions {
                prompt: "hi".into(),
                no_tools: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(!res.enable_tools);
        assert!(res.tool_defs.is_empty());
    }

    /// 「忽略沙盒命令」规则由调用方经 `security` 读好后注入（与 CLI 运行路径同一份解析）
    #[test]
    fn build_resources_carries_permissions_and_sandbox_rules() {
        let settings = settings_with(json!({
            "permissions": { "terminal.dangerous.execute": "deny" }
        }));
        let rules = virlen_core::security::parse_rules(&json!([
            { "id": "r1", "name": "npm", "enabled": true, "kind": "text", "textMode": "prefix", "pattern": "npm" },
            { "id": "r2", "name": "disabled", "enabled": false, "kind": "text", "pattern": "rm" }
        ]));
        let res = build_resources(
            &settings,
            rules,
            &RunOptions {
                prompt: "hi".into(),
                ..Default::default()
            },
            Path::new("."),
            None,
        )
        .unwrap();
        assert_eq!(
            res.security.permissions.get("terminal.dangerous.execute"),
            Some(&"deny".to_string())
        );
        assert_eq!(res.security.sandbox_ignore_rules.len(), 2);
        assert_eq!(res.security.sandbox_ignore_rules[0].name, "npm");
        assert!(!res.security.sandbox_ignore_rules[1].enabled);
    }

    #[test]
    fn build_resources_without_providers_fails_with_readable_error() {
        let settings: Map<String, Value> = serde_json::from_value(json!({})).unwrap();
        let err = build(
            &settings,
            &RunOptions {
                prompt: "hi".into(),
                ..Default::default()
            },
        )
        .unwrap_err();
        assert!(err.contains("Provider"), "err: {err}");
    }

    /// 未原生化的协议（Gemini 需 JS 桥）必须在装配期就报错，而不是运行期挂住
    #[test]
    fn build_resources_rejects_bridged_provider_type() {
        let settings: Map<String, Value> = serde_json::from_value(json!({
            "providers": [{
                "id": "g1", "name": "Gemini", "type": "gemini",
                "apiKey": "k", "baseUrl": "https://x", "models": ["gemini-2.0"], "enabled": true
            }],
            "defaultSelectModel": { "providerConfigId": "g1", "modelId": "gemini-2.0" }
        }))
        .unwrap();
        let err = build(
            &settings,
            &RunOptions {
                prompt: "hi".into(),
                ..Default::default()
            },
        )
        .unwrap_err();
        assert!(err.contains("gemini"), "err: {err}");
        assert!(err.contains("JS"), "err: {err}");
    }

    /// 命令行给了不存在的 provider / model → 报错并列出可用值（绝不静默换一个）
    #[test]
    fn build_resources_reports_unknown_ids_with_choices() {
        let settings = settings_with(json!({}));
        let err = build(
            &settings,
            &RunOptions {
                prompt: "hi".into(),
                provider_id: Some("nope".into()),
                ..Default::default()
            },
        )
        .unwrap_err();
        assert!(err.contains("nope") && err.contains("p1"), "err: {err}");

        let err = build(
            &settings,
            &RunOptions {
                prompt: "hi".into(),
                model_id: Some("gpt-9".into()),
                ..Default::default()
            },
        )
        .unwrap_err();
        assert!(err.contains("gpt-9") && err.contains("gpt-4o"), "err: {err}");
    }

    #[test]
    fn build_resources_missing_api_key_is_rejected() {
        let settings: Map<String, Value> = serde_json::from_value(json!({
            "providers": [{
                "id": "p1", "type": "openai", "apiKey": "",
                "baseUrl": "https://x", "models": ["m"], "enabled": true
            }],
            "defaultSelectModel": { "providerConfigId": "p1", "modelId": "m" }
        }))
        .unwrap();
        let err = build(
            &settings,
            &RunOptions {
                prompt: "hi".into(),
                ..Default::default()
            },
        )
        .unwrap_err();
        assert!(err.contains("apiKey"), "err: {err}");
    }

    #[test]
    fn build_resources_appends_extra_system_prompt() {
        let settings = settings_with(json!({ "allowEnvPrompt": false }));
        let res = build(
            &settings,
            &RunOptions {
                prompt: "hi".into(),
                append_system_prompt: Some("只回答一个字".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(!res.system_prompt.contains("# Current Environment"));
        assert!(res.system_prompt.ends_with("只回答一个字"));
    }

    /// 技能目录：存在才注入（目录规则 = `<data_dir>/skills`，与前端 `skillStore` 一致）
    #[test]
    fn skills_dir_is_derived_from_data_dir_when_present() {
        let dir = std::env::temp_dir().join(format!("virlen_cli_skills_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("skills").join("demo")).unwrap();
        let host: Arc<dyn HostEnv> = Arc::new(virlen_core::host::CliHost::new(vec![], dir.clone()));

        let got = existing_skills_dir(&host).expect("目录存在时应注入路径");
        assert!(got.ends_with("skills"), "got={got}");

        // 目录不在 → 不注入（工具按「无技能」处理，与桌面端首次启动一致）
        std::fs::remove_dir_all(dir.join("skills")).ok();
        assert!(existing_skills_dir(&host).is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn build_resources_rejects_missing_workspace() {
        let settings = settings_with(json!({}));
        let err = build(
            &settings,
            &RunOptions {
                prompt: "hi".into(),
                workspace: Some("E:/definitely/missing/dir".into()),
                ..Default::default()
            },
        )
        .unwrap_err();
        assert!(err.contains("工作目录"), "err: {err}");
    }

    // ==================== 工作目录：会话记录是权威（曾经的真实 bug） ====================

    /// 续用会话时工作目录取**会话记录**，cwd 不参与
    #[test]
    fn resolve_workspace_prefers_session_record_over_cwd() {
        let cmd = RunOptions {
            prompt: "hi".into(),
            session_id: Some("s1".into()),
            ..Default::default()
        };
        assert_eq!(
            resolve_workspace(&cmd, Path::new("E:/cwd"), Some("C:/Users/wei/Desktop/test"), None).unwrap(),
            "C:/Users/wei/Desktop/test"
        );
    }

    /// 会话没记录工作目录（桌面端建会话时未选）→ 才回退到 cwd
    #[test]
    fn resolve_workspace_falls_back_when_record_is_missing_or_blank() {
        let cmd = RunOptions {
            prompt: "hi".into(),
            session_id: Some("s1".into()),
            ..Default::default()
        };
        assert_eq!(
            resolve_workspace(&cmd, Path::new("E:/cwd"), None, None).unwrap(),
            "E:/cwd"
        );
        assert_eq!(
            resolve_workspace(&cmd, Path::new("E:/cwd"), Some("   "), None).unwrap(),
            "E:/cwd"
        );
    }

    /// `--workspace` 与会话记录指向同一目录（大小写 / 结尾分隔符不同）→ 放行，且返回记录值
    #[test]
    fn resolve_workspace_accepts_same_path_written_differently() {
        let dir = std::env::temp_dir().join(format!("virlen_cli_ws_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let recorded = dir.to_string_lossy().to_string();
        let spelling = if cfg!(windows) {
            format!("{}\\", recorded.to_uppercase())
        } else {
            format!("{}/", recorded)
        };
        let cmd = RunOptions {
            prompt: "hi".into(),
            session_id: Some("s1".into()),
            workspace: Some(spelling),
            ..Default::default()
        };
        assert_eq!(
            resolve_workspace(&cmd, Path::new("."), Some(&recorded), None).unwrap(),
            recorded
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 续用时 `--workspace` 与会话记录冲突 → 明确报错（会话的工作目录不可变更）
    #[test]
    fn resolve_workspace_rejects_conflicting_workspace_on_resume() {
        let a = std::env::temp_dir().join(format!("virlen_cli_ws_a_{}", uuid::Uuid::new_v4()));
        let b = std::env::temp_dir().join(format!("virlen_cli_ws_b_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();

        let cmd = RunOptions {
            prompt: "hi".into(),
            session_id: Some("s1".into()),
            workspace: Some(b.to_string_lossy().to_string()),
            ..Default::default()
        };
        let err = resolve_workspace(&cmd, Path::new("."), Some(&a.to_string_lossy()), None).unwrap_err();
        assert!(err.contains("不可变更"), "err: {err}");

        std::fs::remove_dir_all(&a).ok();
        std::fs::remove_dir_all(&b).ok();
    }

    /// 新建会话（无 --session）→ `--workspace` 生效（不受任何会话记录影响）
    #[test]
    fn resolve_workspace_uses_flag_for_new_sessions() {
        let dir = std::env::temp_dir().join(format!("virlen_cli_ws_n_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let cmd = RunOptions {
            prompt: "hi".into(),
            workspace: Some(dir.to_string_lossy().to_string()),
            ..Default::default()
        };
        assert_eq!(
            resolve_workspace(&cmd, Path::new("E:/cwd"), None, None).unwrap(),
            dunce::canonicalize(&dir).unwrap().to_string_lossy().to_string()
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 记录为空时的回退链：`--workspace` → 设置里的 defaultWorkspace → cwd
    #[test]
    fn resolve_workspace_falls_back_to_default_workspace_then_cwd() {
        let base = RunOptions {
            prompt: "hi".into(),
            session_id: Some("s1".into()),
            ..Default::default()
        };
        // 有默认工作目录 → 用它（与桌面端 `getWorkspace` 同一条兵底链）
        assert_eq!(
            resolve_workspace(&base, Path::new("E:/cwd"), None, Some("D:/default")).unwrap(),
            "D:/default"
        );
        assert_eq!(
            resolve_workspace(&base, Path::new("E:/cwd"), Some("  "), Some("D:/default")).unwrap(),
            "D:/default"
        );
        // 显式 --workspace 优先于默认工作目录
        let dir = std::env::temp_dir().join(format!("virlen_cli_ws_p_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let with_flag = RunOptions {
            workspace: Some(dir.to_string_lossy().to_string()),
            ..base
        };
        assert_eq!(
            resolve_workspace(&with_flag, Path::new("E:/cwd"), None, Some("D:/default")).unwrap(),
            dunce::canonicalize(&dir).unwrap().to_string_lossy().to_string()
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    // ==================== 事件渲染 ====================

    #[test]
    fn render_streams_text_then_newline_at_end() {
        let mut state = RenderState::default();
        let ev = AgentEvent::new("stream_event", json!({ "delta": "你好" }));
        assert_eq!(render_event(&ev, false, &mut state).stdout, "你好");

        let ev = AgentEvent::new("stream_event", json!({ "delta": "世界" }));
        assert_eq!(render_event(&ev, false, &mut state).stdout, "世界");

        // 结束帧补换行（正文没以换行结尾时）
        let end = AgentEvent::new("stream_end", json!({}));
        assert_eq!(render_event(&end, false, &mut state).stdout, "\n");
        // 已经换过行则不再重复补
        assert_eq!(render_event(&end, false, &mut state).stdout, "");
    }

    #[test]
    fn render_ignores_assistant_message_updated() {
        // contentDelta 与 stream_event 是同一份正文 —— 重复打印会出现双份
        let mut state = RenderState::default();
        let ev = AgentEvent::new(
            "assistant_message_updated",
            json!({ "messageId": "m1", "patch": { "contentDelta": "x" } }),
        );
        let out = render_event(&ev, false, &mut state);
        assert!(out.is_empty());
    }

    #[test]
    fn render_tool_lines_go_to_stderr() {
        let mut state = RenderState::default();
        let start = AgentEvent::new(
            "tool_call",
            json!({ "type": "tool_use", "id": "tc1", "name": "read_file", "input": {} }),
        );
        let out = render_event(&start, false, &mut state);
        assert!(out.stdout.is_empty(), "工具进度不进 stdout");
        assert!(out.stderr.contains("read_file"));

        let result = AgentEvent::new(
            "tool_result_created",
            json!({ "message": {
                "id": "m1", "role": "tool",
                "content": "line1\nline2", "isError": false
            } }),
        );
        let out = render_event(&result, false, &mut state);
        assert!(out.stderr.contains("ok"));
        assert!(out.stderr.contains("line1 line2"), "预览压成单行: {}", out.stderr);
    }

    /// 同一次工具调用的两帧「开始」事件只打一行（GUI 靠 id 去重，CLI 也要）
    #[test]
    fn render_dedupes_repeated_tool_call_starts() {
        let mut state = RenderState::default();
        let ev = AgentEvent::new(
            "tool_call",
            json!({ "type": "tool_use", "id": "tc1", "name": "read_file", "input": {} }),
        );
        assert!(!render_event(&ev, false, &mut state).stderr.is_empty());
        assert!(
            render_event(&ev, false, &mut state).is_empty(),
            "同一 id 的后续开始帧必须被去重"
        );
        // 新 id 仍然要打
        let other = AgentEvent::new(
            "tool_call",
            json!({ "type": "tool_use", "id": "tc2", "name": "write_file", "input": {} }),
        );
        assert!(render_event(&other, false, &mut state)
            .stderr
            .contains("write_file"));
    }

    /// 结束帧（带 result）不重复报名字
    #[test]
    fn render_tool_call_end_frame_is_ignored() {
        let mut state = RenderState::default();
        let ev = AgentEvent::new(
            "tool_call",
            json!({ "type": "tool_use", "id": "tc1", "name": "read_file", "result": "ok" }),
        );
        assert!(render_event(&ev, false, &mut state).is_empty());
    }

    #[test]
    fn render_error_and_json_mode() {
        let mut state = RenderState::default();
        let out = render_event(&AgentEvent::error("boom"), false, &mut state);
        assert!(out.stderr.contains("boom"));

        let ev = AgentEvent::new("stream_event", json!({ "delta": "x" }));
        let out = render_event(&ev, true, &mut state);
        assert!(out.stderr.is_empty());
        let parsed: Value = serde_json::from_str(out.stdout.trim()).unwrap();
        assert_eq!(parsed["type"], "stream_event");
        assert_eq!(parsed["data"]["delta"], "x");
    }

    // ==================== 交互 ====================

    #[test]
    fn resolve_choice_by_index_text_and_custom() {
        let options = vec!["A".to_string(), "B".to_string()];
        assert_eq!(resolve_choice("2", &options, false), Some("B".into()));
        assert_eq!(resolve_choice("A", &options, false), Some("A".into()));
        assert_eq!(resolve_choice("a", &options, false), Some("A".into()));
        // 非选项文本 = 自定义回复（对应 GUI 的 customReply）
        assert_eq!(resolve_choice("都不要", &options, false), Some("都不要".into()));
        // 空输入 = 取消
        assert_eq!(resolve_choice("   ", &options, false), None);
        // 越界序号不能命中选项 → 按自定义文本处理
        assert_eq!(resolve_choice("9", &options, false), Some("9".into()));
    }

    #[test]
    fn resolve_choice_multi_joins_by_comma() {
        let options = vec!["A".to_string(), "B".to_string(), "C".to_string()];
        assert_eq!(resolve_choice("1,3", &options, true), Some("A, C".into()));
        assert_eq!(resolve_choice("A、B", &options, true), Some("A, B".into()));
        // 选项 + 自定义混合：都能带上
        assert_eq!(resolve_choice("1,自定义", &options, true), Some("A, 自定义".into()));
        assert_eq!(resolve_choice(" , ", &options, true), None);
    }

    /// 非 TTY 一律拒绝（方案 A 的安全底线）
    #[test]
    fn ask_user_is_fail_closed_without_tty() {
        let mut input = std::io::Cursor::new(b"y\n".to_vec());
        let answer = ask_user(
            "confirm_command_native",
            &json!({ "title": "危险命令", "desc": "rm -rf /", "risk": "dangerous" }),
            false,
            &mut input,
        );
        assert_eq!(answer["__kind"], "cancelled");

        let answer = ask_user(
            "user_choice",
            &json!({ "question": "选哪个？", "options": ["A", "B"] }),
            false,
            &mut input,
        );
        assert_eq!(answer["__kind"], "cancelled");
    }

    /// 交互式（TTY）下 `y` 放行、其余拒绝；`user_choice` 回选项文本
    #[test]
    fn ask_user_reads_stdin_when_interactive() {
        let mut input = std::io::Cursor::new(b"y\n".to_vec());
        let answer = ask_user("confirm_command_native", &json!({}), true, &mut input);
        assert_eq!(answer["__kind"], "value");
        assert_eq!(answer["value"], "approved");

        let mut input = std::io::Cursor::new(b"n\n".to_vec());
        let answer = ask_user("confirm_command_native", &json!({}), true, &mut input);
        assert_eq!(answer["__kind"], "cancelled");

        let mut input = std::io::Cursor::new(b"2\n".to_vec());
        let answer = ask_user(
            "user_choice",
            &json!({ "question": "q", "options": ["A", "B"], "multi": false }),
            true,
            &mut input,
        );
        assert_eq!(answer["value"], "B");
    }

    /// 未知交互类型也必须应答（否则引擎会一直等回执）
    #[test]
    fn ask_user_answers_unknown_interaction_types() {
        let mut input = std::io::Cursor::new(Vec::new());
        let answer = ask_user("something_new", &json!({}), true, &mut input);
        assert_eq!(answer["__kind"], "cancelled");
    }

    // ==================== 端到端（不触碰网络） ====================

    /// 空库 + 无 Provider → 可读错误 + 退出码 1（不 panic、不挂起）
    #[tokio::test]
    async fn run_without_providers_fails_cleanly() {
        let dir = std::env::temp_dir().join(format!("virlen_cli_run_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let host: Arc<dyn HostEnv> = Arc::new(virlen_core::host::CliHost::new(vec![], dir.clone()));

        let mut out: Vec<u8> = Vec::new();
        let mut err: Vec<u8> = Vec::new();
        let code = run(
            &host,
            RunCmd::Run(RunOptions {
                prompt: "你好".into(),
                ..Default::default()
            }),
            &mut out,
            &mut err,
        )
        .await;

        assert_eq!(code, EXIT_ERROR);
        assert!(out.is_empty(), "出错时 stdout 不应有正文: {}", String::from_utf8_lossy(&out));
        assert!(
            String::from_utf8_lossy(&err).contains("Provider"),
            "err: {}",
            String::from_utf8_lossy(&err)
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// `run --help` 只打印帮助、不碰数据库
    #[tokio::test]
    async fn run_help_does_not_touch_database() {
        let dir = std::env::temp_dir().join(format!("virlen_cli_help_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let host: Arc<dyn HostEnv> = Arc::new(virlen_core::host::CliHost::new(vec![], dir.clone()));

        let mut out: Vec<u8> = Vec::new();
        let mut err: Vec<u8> = Vec::new();
        assert_eq!(run(&host, RunCmd::Help, &mut out, &mut err).await, EXIT_OK);
        assert!(String::from_utf8_lossy(&out).contains("用法:"));
        assert!(!dir.join("virlen.db").exists(), "help 不得建库");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn title_from_prompt_takes_first_line_and_clamps() {
        assert_eq!(title_from_prompt("第一行\n第二行"), "第一行");
        assert_eq!(title_from_prompt("  短标题  "), "短标题");
        let long = "啊".repeat(80);
        let title = title_from_prompt(&long);
        assert_eq!(title.chars().count(), 61, "60 字符 + 省略号");
        assert!(title.ends_with('…'));
    }

    #[test]
    fn one_line_preview_flattens_and_truncates() {
        assert_eq!(one_line_preview("a\n\nb   c", 100), "a b c");
        assert_eq!(one_line_preview("abcdef", 3), "abc…");
    }
}
