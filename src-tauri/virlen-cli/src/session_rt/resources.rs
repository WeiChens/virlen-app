//! 装配链 —— 读配置 → 定工作目录 → 组装安全策略与系统提示词
//!
//! 这一段的**顺序即契约**（`resolve_workspace` 的注释里写明了为什么）：
//! 「先读会话记录的工作目录（它是权威），再装配资源」——反过来的话 cwd 会顶掉会话记录，
//! 于是模型在另一个项目里读写文件（真实踩过的 bug）。

use serde::Deserialize;
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use virlen_core::agent::host::HostEnv;
use virlen_core::agent::prompts::assemble::{compose_system_prompt, PromptParts};
use virlen_core::agent::tool_defs;
use virlen_core::security::SandboxIgnoreRule;
use virlen_core::agent::types::{
    NativeToolSecurity, ProviderConnection, ToolDefinition,
};

use super::*;

/// 项目规则文件（相对工作目录）—— 与 TS `DEFAULT_PROJECT_RULES_FILE` 同名
const PROJECT_RULES_FILE: &str = "AGENTS.md";
/// 项目规则文件大小上限（与 TS `MAX_PROJECT_RULES_BYTES` 一致：超限**不注入**而非截断）
const MAX_PROJECT_RULES_BYTES: u64 = 64 * 1024;

// ==================== 配置解析（装配） ====================

/// `app_settings.providers` 里一个 Provider 配置（只取 CLI 需要的字段）
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderLite {
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

pub(crate) fn default_enabled() -> bool {
    true
}

/// `app_settings.defaultSelectModel`
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct DefaultModel {
    provider_config_id: String,
    model_id: String,
}

/// 装配结果：引擎需要的一切（除会话本身）
#[derive(Debug)]
pub(crate) struct Resources {
    pub(crate) provider: ProviderConnection,
    /// 实际使用的模型 id（写进 session.model_id）
    pub(crate) model_id: String,
    pub(crate) tool_defs: Vec<ToolDefinition>,
    pub(crate) enable_tools: bool,
    pub(crate) security: NativeToolSecurity,
    pub(crate) system_prompt: String,
    pub(crate) workspace: String,
    pub(crate) max_tool_rounds: i64,
    pub(crate) max_iterations: i64,
    pub(crate) max_tokens: i64,
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
pub(crate) fn resolve_workspace(
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
pub(crate) fn canonicalize_workspace(raw: &str, cwd: &Path) -> Result<String, String> {
    let p = PathBuf::from(raw);
    let abs = if p.is_absolute() { p } else { cwd.join(p) };
    let canon =
        dunce::canonicalize(&abs).map_err(|e| format!("工作目录不可用 ({}): {}", abs.display(), e))?;
    Ok(canon.to_string_lossy().to_string())
}

/// 两个路径是否指向同一目录：先按**文件系统真身**比较（`canonicalize`），
/// 失败（目录已不存在等）再退回字符串比较——忽略结尾分隔符，Windows 下大小写不敏感
/// （用户写 `E:\proj\` / `e:/Proj` 不该被判成「改目录」）。
///
/// ⚠️ 为何必须 canonicalize：本函数两侧的来源**不同**——
/// `asked` 来自命令行（已 canonicalize），`recorded` 来自会话记录（按约定原样使用）。
/// 同一个目录常有两种写法，且**都不是用户写错**：
///   - macOS：`/var/...` vs `/private/var/...`（`/var` 是指向 `/private/var` 的符号链接，
///     `std::env::temp_dir()` 给的是前者，`canonicalize` 得到后者）；
///   - Windows：8.3 短名 vs 长名（`C:\Users\RUNNER~1\...` vs
///     `C:\Users\runneradmin\...`，GitHub Actions 的 `TEMP` 就是短名形式）。
///
/// 只比字符串会把这些判成「换目录」→ 续跑被**无辜拦下**（ci.yml 的 macos/windows 用例真踩到）。
///
/// 只用 canonicalize 做**相等判定**；返回值仍用记录原样（见 [`resolve_workspace`]）。
pub(crate) fn same_path(a: &str, b: &str) -> bool {
    /// canonicalize 成功则用真身，失败（如目录已被删除）则退回原字符串
    fn canon_or_self(p: &str) -> String {
        dunce::canonicalize(p)
            .map(|c| c.to_string_lossy().to_string())
            .unwrap_or_else(|_| p.to_string())
    }
    fn norm(p: &str) -> String {
        let t = p.trim_end_matches(['/', '\\']);
        if cfg!(windows) {
            t.to_lowercase()
        } else {
            t.to_string()
        }
    }
    norm(&canon_or_self(a)) == norm(&canon_or_self(b))
}

/// 组装引擎入参（纯逻辑 + 读项目规则文件）。
///
/// `cwd` 用于解析相对 `--workspace` 与缺省工作目录（调用方传 `std::env::current_dir()`）；
/// `session_workspace` 是「续用会话时该会话记录的工作目录」——**它优先于 cwd**（见 [`resolve_workspace`]）。
pub(crate) fn build_resources(
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
pub(crate) fn resolve_connection(
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

pub(crate) fn provider_id_list(providers: &[ProviderLite]) -> String {
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
pub(crate) fn build_system_prompt(workspace: &Path, allow_env: bool, extra: Option<&str>) -> String {
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
pub(crate) fn read_project_rules(workspace: &Path) -> Option<String> {
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
pub(crate) fn existing_skills_dir(host: &Arc<dyn HostEnv>) -> Option<String> {
    let dir = host.data_dir().join("skills");
    dir.is_dir().then(|| dir.to_string_lossy().to_string())
}
