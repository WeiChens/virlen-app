//! MCP 服务器配置 —— 唯一持久化结构（`app_settings.mcpServers`），GUI 与 CLI 读同一份。
//!
//! 形状与 TS `src/domain/mcp/types.ts` 一一对应（serde camelCase）：配置**扁平**存传输字段
//! （`transport` 只做判别标签），这样设置页的编辑状态与落库 JSON 同形，不需要来回映射。
//!
//! ⚠️ 校验规则（`validate`）在两侧各有一份实现（前端 `domain/mcp/config.ts`），语义由
//! `tests/` 的同一批用例固定：服务器名 `^[A-Za-z0-9_-]{1,32}$` **且不含 `__`**（旧版公开名的
//! 分隔符，旧数据反解靠它）。

use std::collections::BTreeMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// 服务器名长度上限（只影响展示与审批档查找；工具公开名里已不含它）
pub const MAX_SERVER_NAME_LEN: usize = 32;

/// 单次 `tools/call` 默认超时
pub const DEFAULT_TOOL_CALL_TIMEOUT_MS: u64 = 60_000;
/// 建连 + 首次 `tools/list` 默认超时（`npx` 冷启动经常 > 10s）
pub const DEFAULT_STARTUP_TIMEOUT_MS: u64 = 30_000;

// ==================== 配置结构 ====================

/// 一个 MCP 服务器。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    /// 稳定 id（uuid）：只用于 UI key 与重命名；公开工具名**不用**它
    pub id: String,
    /// 命名空间（公开名里的 `<serverName>`）
    pub name: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// 传输方式（标签 + 该传输自己的字段）
    #[serde(flatten)]
    pub transport: McpTransport,
    #[serde(default)]
    pub approval: McpApproval,
    #[serde(default = "default_tool_call_timeout_ms")]
    pub tool_call_timeout_ms: u64,
    #[serde(default = "default_startup_timeout_ms")]
    pub startup_timeout_ms: u64,
    #[serde(default)]
    pub reconnect: McpReconnectConfig,
    /// 只暴露这些工具（`rawName` 白名单）；`None` = 全部
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled_tools: Option<Vec<String>>,
    /// 把服务器 `instructions` 注入系统提示词（实际上在 `publish` 判定）
    #[serde(default = "default_true")]
    pub inject_instructions: bool,
    /// 工具公开名的自定义覆盖：`服务器原始工具名 → 模型可见名`（无条目 = 与服务一致）。
    ///
    /// 只影响「模型看到的名字」（下发、卡片、白名单），`tools/call` 永远发服务器原始名。
    /// 用户改名的动机通常是让模型更认得出用途（`look` → `blender_look`）或自己解同名冲突。
    /// ⚠️ 名字是模型唯一的身份凭据：给一个工具改名 = 旧名在白名单 / 会话历史里失效（白名单
    /// 由保存时的迁移顺手挽救，历史消息不能了）。
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub tool_aliases: BTreeMap<String, String>,
}

/// 审批三态 —— 与内置权限同一套词表（`allow` / `ask` / `deny`）。
///
/// - `allow`（默认）：直接执行；
/// - `ask`：每次调用经 `confirm_mcp_call` 交互确认；
/// - `deny`：**不建立连接**、工具不下发（比「连上但不许调」更可预测）。
///
/// 缺省值 = `allow`：新建服务器不弹审批打扰（用户自己填的命令，与内置工具默认放行同口径）。
/// ⚠️ `import` 是例外：粘贴进来的第三方配置**显式写 `ask`**（不是「用户自己写的」）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum McpApproval {
    #[default]
    Allow,
    Ask,
    Deny,
}

/// 传输方式（内部标签 `transport`，字段扁平 —— 与 TS 侧同形）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "transport", rename_all = "lowercase")]
pub enum McpTransport {
    /// 本地子进程（stdio + 行分隔 JSON-RPC）
    Stdio {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
        /// 叠加在「清洗后的父环境」之上（显式覆盖永远优先）
        #[serde(default)]
        env: BTreeMap<String, String>,
    },
    /// Streamable HTTP（POST + 可选 SSE）
    Http {
        url: String,
        #[serde(default)]
        headers: BTreeMap<String, String>,
    },
}

impl McpTransport {
    pub fn kind(&self) -> &'static str {
        match self {
            McpTransport::Stdio { .. } => "stdio",
            McpTransport::Http { .. } => "http",
        }
    }
}

/// 传输无关的 stdio 启动参数（运输层只要这一份，不依赖整个配置）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StdioSpec {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub env: BTreeMap<String, String>,
}

/// 传输无关的 HTTP 连接参数
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpSpec {
    pub url: String,
    pub headers: BTreeMap<String, String>,
}

/// 重连退避 —— 与 dsh 同参：500ms 起、逐次翻倍、上限 30s、连续 10 次放弃。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct McpReconnectConfig {
    pub enabled: bool,
    pub initial_delay_ms: u64,
    pub max_delay_ms: u64,
    pub max_attempts: u32,
}

impl Default for McpReconnectConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            initial_delay_ms: 500,
            max_delay_ms: 30_000,
            max_attempts: 10,
        }
    }
}

impl McpReconnectConfig {
    /// 第 `attempt`（从 1 起）次重连前要等多久；超出上限时取上限。
    pub fn delay_for_attempt(&self, attempt: u32) -> Duration {
        let exp = attempt.saturating_sub(1).min(31);
        let delay = self
            .initial_delay_ms
            .saturating_mul(1u64.checked_shl(exp).unwrap_or(u64::MAX));
        Duration::from_millis(delay.min(self.max_delay_ms.max(1)))
    }
}

fn default_true() -> bool {
    true
}

fn default_tool_call_timeout_ms() -> u64 {
    DEFAULT_TOOL_CALL_TIMEOUT_MS
}

fn default_startup_timeout_ms() -> u64 {
    DEFAULT_STARTUP_TIMEOUT_MS
}

// ==================== 校验 ====================

impl McpServerConfig {
    pub fn transport_spec_stdio(&self) -> Option<StdioSpec> {
        match &self.transport {
            McpTransport::Stdio {
                command,
                args,
                cwd,
                env,
            } => Some(StdioSpec {
                command: command.clone(),
                args: args.clone(),
                cwd: cwd.clone(),
                env: env.clone(),
            }),
            McpTransport::Http { .. } => None,
        }
    }

    pub fn transport_spec_http(&self) -> Option<HttpSpec> {
        match &self.transport {
            McpTransport::Http { url, headers } => Some(HttpSpec {
                url: url.clone(),
                headers: headers.clone(),
            }),
            McpTransport::Stdio { .. } => None,
        }
    }

    /// 这个 raw 工具是否允许暴露（`enabled_tools` 为空 = 全部）
    pub fn allows_tool(&self, raw_name: &str) -> bool {
        match &self.enabled_tools {
            None => true,
            Some(list) => list.iter().any(|n| n == raw_name),
        }
    }

    /// 一个服务器原始工具名**对模型可见的名字**：有别名用别名，否则走默认算法
    ///（[`super::naming::public_tool_name`] —— 与服务一致，必要时加哈希后缀）。
    pub fn public_name_for(&self, raw_name: &str) -> String {
        match self.tool_aliases.get(raw_name) {
            Some(alias) => alias.clone(),
            None => super::naming::public_tool_name(raw_name),
        }
    }

    pub fn tool_call_timeout(&self) -> Duration {
        Duration::from_millis(self.tool_call_timeout_ms.max(1))
    }

    pub fn startup_timeout(&self) -> Duration {
        Duration::from_millis(self.startup_timeout_ms.max(1))
    }

    /// 单条配置自检。错误文案给用户看（设置页直接显示），故写清楚「哪一项不对」。
    pub fn validate(&self) -> Result<(), String> {
        if self.id.trim().is_empty() {
            return Err("服务器缺少 id".to_string());
        }
        validate_server_name(&self.name)?;
        if self.tool_call_timeout_ms == 0 {
            return Err(format!("{}：单次调用超时必须大于 0", self.name));
        }
        if self.startup_timeout_ms == 0 {
            return Err(format!("{}：启动超时必须大于 0", self.name));
        }
        if let Some(list) = &self.enabled_tools {
            if list.iter().any(|n| n.trim().is_empty()) {
                return Err(format!("{}：工具白名单里有空名字", self.name));
            }
        }
        validate_tool_aliases(&self.name, &self.tool_aliases)?;
        match &self.transport {
            McpTransport::Stdio { command, .. } => {
                if command.trim().is_empty() {
                    return Err(format!("{}：命令不能为空", self.name));
                }
            }
            McpTransport::Http { url, .. } => {
                if !(url.starts_with("http://") || url.starts_with("https://")) {
                    return Err(format!("{}：URL 必须以 http:// 或 https:// 开头", self.name));
                }
            }
        }
        Ok(())
    }
}

/// 别名表自检：每个别名自己合法 + 同一台服务器内不得重名。
///
/// 同名会让其中一项**静默不发布**（`build_tools` 只留第一个）—— 那是「工具莫名少了一个」
/// 这类最难查的现象，所以在这里当场驳。与内置 / 另一台服务器重名不在这里拦：那是发布期的
/// 判定（`registry::classify`：内置优先、跨服务器都不发，并在界面横幅上报出），
/// 而且堵在这里会让「以后新增一个同名内置工具」把整份配置卡成存不进去。
fn validate_tool_aliases(server: &str, aliases: &BTreeMap<String, String>) -> Result<(), String> {
    let mut seen: Vec<&str> = Vec::with_capacity(aliases.len());
    for (raw, alias) in aliases {
        if raw.trim().is_empty() {
            return Err(format!("{server}：工具别名缺少原始工具名"));
        }
        if let Err(error) = super::naming::validate_tool_alias(alias) {
            return Err(format!("{server}（{raw}）：{error}"));
        }
        if seen.contains(&alias.as_str()) {
            return Err(format!("{server}：工具名重复：{alias}"));
        }
        seen.push(alias);
    }
    Ok(())
}

/// 服务器名校验（公开名前缀的命名空间）。
pub fn validate_server_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("服务器名不能为空".to_string());
    }
    if name.len() > MAX_SERVER_NAME_LEN {
        return Err(format!("服务器名不能超过 {MAX_SERVER_NAME_LEN} 个字符"));
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err("服务器名只能包含字母、数字、下划线和连字符".to_string());
    }
    if name.contains("__") {
        // `__` 是**旧版**公开名 `mcp__<server>__<raw>` 的分隔符：混进服务器名会让旧数据反解错
        return Err("服务器名不能包含连续下划线（__ 是工具名分隔符）".to_string());
    }
    Ok(())
}

/// 一批配置的整体校验：逐条自检 + 名字不得重复。
pub fn validate_all(configs: &[McpServerConfig]) -> Result<(), String> {
    let mut seen: Vec<&str> = Vec::with_capacity(configs.len());
    for cfg in configs {
        cfg.validate()?;
        if seen.contains(&cfg.name.as_str()) {
            return Err(format!("服务器名重复：{}", cfg.name));
        }
        seen.push(&cfg.name);
    }
    Ok(())
}

// ==================== 子进程环境清洗 ====================

/// 环境变量名是否「像密钥」——命中即从子进程环境里删除。
///
/// 与 dsh `scrubbedParentEnv()` 同一份正则（`/KEY|PASSWORD|SECRET|TOKEN/i`），外加
/// `VIRLEN_*`（本应用自己的内部变量不该外泄）。
pub fn is_sensitive_env_key(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    upper.starts_with("VIRLEN_")
        || upper.contains("KEY")
        || upper.contains("PASSWORD")
        || upper.contains("SECRET")
        || upper.contains("TOKEN")
}

/// 按规则过一遍任意环境变量集合（抽出来是为了能单测，不必污染进程环境）。
pub fn scrub_env<I, K, V>(vars: I) -> BTreeMap<String, String>
where
    I: IntoIterator<Item = (K, V)>,
    K: AsRef<str>,
    V: AsRef<str>,
{
    let mut out = BTreeMap::new();
    for (key, value) in vars {
        let key = key.as_ref();
        if is_sensitive_env_key(key) {
            continue;
        }
        out.insert(key.to_string(), value.as_ref().to_string());
    }
    out
}

/// 当前进程环境的清洗版本（stdio 子进程的基座）。
///
/// 非 UTF-8 的键直接跳过、值用有损转换：MCP 子进程拿不到「看不懂的字节」比拿到乱码安全。
pub fn scrubbed_parent_env() -> BTreeMap<String, String> {
    let vars: Vec<(String, String)> = std::env::vars_os()
        .filter_map(|(k, v)| Some((k.into_string().ok()?, v.to_string_lossy().into_owned())))
        .collect();
    scrub_env(vars)
}

/// 子进程最终环境 = 清洗后的父环境 + 配置里的显式覆盖。
pub fn merge_child_env(extra: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    let mut env = scrubbed_parent_env();
    for (k, v) in extra {
        env.insert(k.clone(), v.clone());
    }
    env
}

// ==================== Windows 启动解析 ====================

/// 把配置里的命令解析成「实际可执行程序 + 参数」。
///
/// ⚠️ Windows 上 `npx` / `pnpm` / `uvx` 是 `.cmd` / `.bat` 垫片，`CreateProcess` **不能**直接
/// 执行批处理（`Command::new("npx")` 报 NotFound）。故：带脚本扩展名、或不带扩展名也不带路径
/// 分隔符时，包一层 `cmd /C`。
///
/// 已知限制：参数里含 `&` `|` `^` `%` 时会被 cmd 二次解释 —— 这类命令请直接填 `.exe` 绝对路径
/// （设置页的错误提示里也写了这条）。
pub fn resolve_launch(command: &str, args: &[String]) -> (String, Vec<String>) {
    #[cfg(target_os = "windows")]
    {
        let lower = command.to_ascii_lowercase();
        let script_ext = lower.ends_with(".cmd") || lower.ends_with(".bat") || lower.ends_with(".com");
        // 只看文件名部分判断「有没有扩展名」（`C:\a.b\node` 里的点是目录名，不算）
        let file_name = command.rsplit(['\\', '/']).next().unwrap_or(command);
        let has_dot = file_name.contains('.');
        let bare = !command.contains('\\') && !command.contains('/');
        let needs_shell = script_ext || (bare && !has_dot);
        if needs_shell {
            let mut shell_args = Vec::with_capacity(args.len() + 2);
            shell_args.push("/C".to_string());
            shell_args.push(command.to_string());
            shell_args.extend(args.iter().cloned());
            return ("cmd".to_string(), shell_args);
        }
        (command.to_string(), args.to_vec())
    }
    #[cfg(not(target_os = "windows"))]
    {
        (command.to_string(), args.to_vec())
    }
}

/// Windows：在 `PATH` + `PATHEXT` 里找可执行文件。
///
/// 为什么要自己找：裸命令会被包成 `cmd /C`，而 `cmd` **总是启动成功**（找不到命令是 cmd 自己
/// 的运行时错误）—— 于是「命令写错」在调用方看来变成「连上了又立刻断开」，用户完全不知道
/// 自己拼错了。这里先找一轮，找不到就直接给一条能看懂的错误。
#[cfg(target_os = "windows")]
pub fn find_in_path(command: &str) -> Option<std::path::PathBuf> {
    let path = std::env::var_os("PATH")?;
    let extensions =
        std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
    for directory in std::env::split_paths(&path) {
        let direct = directory.join(command);
        if direct.is_file() {
            return Some(direct);
        }
        for extension in extensions.split(';').filter(|ext| !ext.is_empty()) {
            let candidate = directory.join(format!("{command}{extension}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stdio_config() -> McpServerConfig {
        serde_json::from_value(serde_json::json!({
            "id": "01J8Z0M4",
            "name": "fs",
            "transport": "stdio",
            "command": "npx",
            "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
            "env": { "FOO": "bar" }
        }))
        .expect("最小 stdio 配置应能反序列化")
    }

    #[test]
    fn ts_shaped_json_round_trips() {
        let cfg = stdio_config();
        assert_eq!(cfg.name, "fs");
        assert!(cfg.enabled, "enabled 默认 true");
        assert_eq!(cfg.approval, McpApproval::Allow, "审批默认直接执行");
        assert_eq!(cfg.tool_call_timeout_ms, DEFAULT_TOOL_CALL_TIMEOUT_MS);
        assert_eq!(cfg.startup_timeout_ms, DEFAULT_STARTUP_TIMEOUT_MS);
        assert_eq!(cfg.reconnect, McpReconnectConfig::default());
        assert!(cfg.inject_instructions);

        let spec = cfg.transport_spec_stdio().expect("应是 stdio");
        assert_eq!(spec.command, "npx");
        assert_eq!(spec.args.len(), 3);
        assert_eq!(spec.env.get("FOO").map(String::as_str), Some("bar"));

        // 序列化回去仍是扁平形状（设置页与落库同形）
        let value = serde_json::to_value(&cfg).unwrap();
        assert_eq!(value["transport"], "stdio");
        assert_eq!(value["command"], "npx");
        assert_eq!(value["toolCallTimeoutMs"], DEFAULT_TOOL_CALL_TIMEOUT_MS);
        assert!(value.get("url").is_none());
    }

    #[test]
    fn http_config_round_trips() {
        let cfg: McpServerConfig = serde_json::from_value(serde_json::json!({
            "id": "h1",
            "name": "remote",
            "transport": "http",
            "url": "https://mcp.example.com/mcp",
            "headers": { "Authorization": "Bearer x" },
            "approval": "deny"
        }))
        .unwrap();
        assert_eq!(cfg.approval, McpApproval::Deny);
        let spec = cfg.transport_spec_http().unwrap();
        assert_eq!(spec.url, "https://mcp.example.com/mcp");
        assert_eq!(
            spec.headers.get("Authorization").map(String::as_str),
            Some("Bearer x")
        );
        assert!(cfg.transport_spec_stdio().is_none());
    }

    #[test]
    fn validate_rejects_bad_names() {
        let mut cfg = stdio_config();
        for bad in ["", "has space", "工具", "a__b", &"x".repeat(33)] {
            cfg.name = bad.to_string();
            assert!(cfg.validate().is_err(), "{bad:?} 应被拒绝");
        }
        for good in ["fs", "my-server", "my_server_2", "A1"] {
            cfg.name = good.to_string();
            assert!(cfg.validate().is_ok(), "{good:?} 应通过：{:?}", cfg.validate());
        }
    }

    #[test]
    fn validate_requires_transport_fields() {
        let mut cfg = stdio_config();
        if let McpTransport::Stdio { command, .. } = &mut cfg.transport {
            command.clear();
        }
        assert!(cfg.validate().is_err());

        let mut http: McpServerConfig = serde_json::from_value(serde_json::json!({
            "id": "h", "name": "r", "transport": "http", "url": "ftp://x"
        }))
        .unwrap();
        assert!(http.validate().is_err());
        if let McpTransport::Http { url, .. } = &mut http.transport {
            *url = "https://x/mcp".into();
        }
        assert!(http.validate().is_ok());
    }

    #[test]
    fn validate_all_rejects_duplicate_names() {
        let a = stdio_config();
        let mut b = stdio_config();
        b.id = "other".into();
        assert!(validate_all(&[a.clone(), b.clone()]).is_err());
        b.name = "fs2".into();
        assert!(validate_all(&[a, b]).is_ok());
    }

    #[test]
    fn env_scrub_drops_credential_shaped_names() {
        let env = scrub_env([
            ("PATH", "/usr/bin"),
            ("HOME", "/home/me"),
            ("OPENAI_API_KEY", "sk-1"),
            ("GITHUB_TOKEN", "ghp"),
            ("DB_PASSWORD", "p"),
            ("CLIENT_SECRET", "s"),
            ("VIRLEN_DB", "/tmp/x"),
            ("MONOREPO", "keep-me"), // 含 "NO" 不含敏感词 → 保留
        ]);
        assert_eq!(env.get("PATH").map(String::as_str), Some("/usr/bin"));
        assert_eq!(env.get("HOME").map(String::as_str), Some("/home/me"));
        assert_eq!(env.get("MONOREPO").map(String::as_str), Some("keep-me"));
        for key in [
            "OPENAI_API_KEY",
            "GITHUB_TOKEN",
            "DB_PASSWORD",
            "CLIENT_SECRET",
            "VIRLEN_DB",
        ] {
            assert!(!env.contains_key(key), "{key} 应被清洗");
        }
    }

    #[test]
    fn explicit_env_overrides_survive() {
        let mut extra = BTreeMap::new();
        extra.insert("OPENAI_API_KEY".to_string(), "explicit".to_string());
        // 父环境里若真有这个键也会被清洗，但显式覆盖要保留（用户明确要给它）
        let env = scrub_env([("OPENAI_API_KEY", "from-parent")]);
        assert!(!env.contains_key("OPENAI_API_KEY"));
        let merged = merge_child_env(&extra);
        assert_eq!(
            merged.get("OPENAI_API_KEY").map(String::as_str),
            Some("explicit")
        );
    }

    #[test]
    fn reconnect_delay_doubles_and_caps() {
        let policy = McpReconnectConfig::default();
        assert_eq!(policy.delay_for_attempt(1).as_millis(), 500);
        assert_eq!(policy.delay_for_attempt(2).as_millis(), 1_000);
        assert_eq!(policy.delay_for_attempt(3).as_millis(), 2_000);
        // 上限 30s，且不因 u64 溢出 panic
        assert_eq!(policy.delay_for_attempt(30).as_millis(), 30_000);
        assert_eq!(policy.delay_for_attempt(999).as_millis(), 30_000);
    }

    #[test]
    fn enabled_tools_whitelist() {
        let mut cfg = stdio_config();
        assert!(cfg.allows_tool("anything"));
        cfg.enabled_tools = Some(vec!["echo".into()]);
        assert!(cfg.allows_tool("echo"));
        assert!(!cfg.allows_tool("other"));
    }

    /// 别名优先，默认回落到与服务一致的名字（同一份定义只能有一个对外名字）
    #[test]
    fn aliases_override_public_names() {
        let mut cfg = stdio_config();
        assert_eq!(cfg.public_name_for("look"), "look");
        cfg.tool_aliases
            .insert("look".into(), "blender_look".into());
        assert_eq!(cfg.public_name_for("look"), "blender_look");
        // 没改名的工具不受影响
        assert_eq!(cfg.public_name_for("get_scene_info"), "get_scene_info");

        // 落库形状：`toolAliases` 是 camelCase 对象，空时整个键不出现（不吃存储）
        let value = serde_json::to_value(&cfg).unwrap();
        assert_eq!(value["toolAliases"]["look"], "blender_look");
        let empty = serde_json::to_value(stdio_config()).unwrap();
        assert!(empty.get("toolAliases").is_none(), "空别名表不应落库");

        // 回遢：与 TS 侧同形
        let back: McpServerConfig = serde_json::from_value(value).unwrap();
        assert_eq!(back, cfg);
    }

    /// 别名不自洽（非法字符 / 空 / 同服务器重名）在落库前就驳；与内置重名交由发布期报给界面
    #[test]
    fn validate_rejects_broken_aliases() {
        let mut cfg = stdio_config();
        cfg.tool_aliases.insert("look".into(), "has space".into());
        assert!(cfg.validate().is_err());

        cfg.tool_aliases.insert("look".into(), "".into());
        assert!(cfg.validate().is_err());

        cfg.tool_aliases.clear();
        cfg.tool_aliases.insert("a".into(), "same".into());
        cfg.tool_aliases.insert("b".into(), "same".into());
        let error = cfg.validate().expect_err("同一台服务器内重名应被拒");
        assert!(error.contains("重复"), "{error}");

        // 合法：名字合法就通过（即使它恰好占用了内置工具名 —— 那由发布期扣下 + 界面报）
        cfg.tool_aliases.clear();
        cfg.tool_aliases.insert("a".into(), "read_file".into());
        assert_eq!(cfg.validate(), Ok(()));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_finds_known_binaries_on_path() {
        // `cmd` 是系统自带、且在 PATH 里的（CI 环境也成立）
        assert!(find_in_path("cmd").is_some());
        assert!(find_in_path("virlen-definitely-not-a-real-command-xyz").is_none());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_batch_shims_go_through_cmd() {
        let args = vec!["-y".to_string(), "pkg".to_string()];
        for shim in ["npx", "npx.cmd", "pnpm", "uvx.bat"] {
            let (program, expanded) = resolve_launch(shim, &args);
            assert_eq!(program, "cmd", "{shim} 应走 cmd /C");
            assert_eq!(expanded[0], "/C");
            assert_eq!(expanded[1], shim);
            assert_eq!(&expanded[2..], &args[..]);
        }
        // 已经是 exe → 原样；`.cmd` 即使带绝对路径也要走 cmd /C（CreateProcess 跑不了批处理）
        for direct in ["node.exe", "C:\\Program Files\\nodejs\\node.exe"] {
            let (program, expanded) = resolve_launch(direct, &args);
            assert_eq!(program, direct, "{direct} 不应包 shell");
            assert_eq!(expanded, args);
        }
        let (program, expanded) = resolve_launch("C:\\tools\\run.cmd", &args);
        assert_eq!(program, "cmd", "绝对路径的 .cmd 仍需 cmd /C");
        assert_eq!(expanded[1], "C:\\tools\\run.cmd");
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn posix_commands_pass_through() {
        let args = vec!["-y".to_string()];
        assert_eq!(
            resolve_launch("npx", &args),
            ("npx".to_string(), args.clone())
        );
    }
}
