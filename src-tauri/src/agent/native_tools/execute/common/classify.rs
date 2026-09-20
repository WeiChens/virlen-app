//! 命令解析与风险分类（safe | install | dangerous）+ 风险/审批文案。
//!
//! - 命令名提取、shell 包装剥离、引号感知的分段（`extract_*` / `split_*`）。
//! - 风险分类 `classify_command`，文案 `risk_info`，权限三态决策 `command_decision` / `resolve_decision`。
//! - 绕过沙盒的警告文案 `SANDBOX_BYPASS_HINT` / `with_bypass_hint`。

/// 引号感知：取命令段第一个 token。
/// 单引号/双引号内的空白和分隔符不参与切分（如 "C:\Program Files\app.exe" 视为一个整体）。
fn extract_first_token(raw: &str) -> String {
    let mut token = String::new();
    let mut quote: Option<char> = None;
    let chars: Vec<char> = raw.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        if let Some(q) = quote {
            token.push(ch);
            // 双引号内支持 \" 转义（单引号内无反斜杠转义）
            if q == '"' && ch == '\\' && i + 1 < chars.len() {
                token.push(chars[i + 1]);
                i += 2;
                continue;
            }
            if ch == q {
                quote = None;
            }
            i += 1;
            continue;
        }
        if ch == '"' || ch == '\'' {
            quote = Some(ch);
            token.push(ch);
            i += 1;
            continue;
        }
        if ch.is_whitespace() || matches!(ch, '|' | '&' | ';' | '<' | '>' | '(' | ')') {
            break;
        }
        token.push(ch);
        i += 1;
    }
    token
}

/// 提取命令名（第一个 token，去路径/扩展名/引号）
fn extract_command_name(raw: &str) -> String {
    let trimmed = raw.trim_start();
    // 同时剥掉首尾引号（JS 只剥开头，这里补上结尾，`'npm'` → `npm` 更准确）
    let mut t = extract_first_token(trimmed)
        .trim_start_matches(['"', '\''])
        .trim_end_matches(['"', '\''])
        .to_string();
    if let Some(stripped) = t.strip_prefix("./") {
        t = stripped.to_string();
    }
    if let Some(idx) = t.rfind(['/', '\\']) {
        t = t[idx + 1..].to_string();
    }
    t = t.to_lowercase();
    let ext_re = regex::Regex::new(r"\.(exe|bat|cmd|ps1|sh)$").unwrap();
    ext_re.replace(&t, "").to_string()
}

/// 剥掉外层 shell 包装（cmd /c、powershell -Command、sh -c），递归最大 5 层
fn unwrap_shell_wrapper(cmd_str: &str, depth: i32) -> String {
    if depth <= 0 {
        return cmd_str.to_string();
    }
    let re1 = regex::Regex::new(r#"(?i)^(?:cmd\.exe|cmd)\s+/c\s+"?([^"]+)"?$"#).unwrap();
    if let Some(caps) = re1.captures(cmd_str) {
        return unwrap_shell_wrapper(&caps[1], depth - 1);
    }
    let re2 = regex::Regex::new(r#"(?i)^(?:powershell|pwsh)(?:\.exe)?\s+-Command\s+"?([^"]+)"?$"#)
        .unwrap();
    if let Some(caps) = re2.captures(cmd_str) {
        return unwrap_shell_wrapper(&caps[1], depth - 1);
    }
    let re3 = regex::Regex::new(r#"(?i)^(?:sh|bash|zsh|dash)\s+-c\s+"?([^"]+)"?$"#).unwrap();
    if let Some(caps) = re3.captures(cmd_str) {
        return unwrap_shell_wrapper(&caps[1], depth - 1);
    }
    cmd_str.to_string()
}

/// 引号感知：按分隔符切分 shell 命令段，引号内的分隔符不生效。
/// 例如 `echo "a;b"` 不会被 `;` 切开，`echo 'a&&b'` 不会被 `&&` 切开。
fn split_command_respecting_quotes(raw: &str, separators: &[&str]) -> Vec<String> {
    let mut parts: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let chars: Vec<char> = raw.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        if let Some(q) = quote {
            current.push(ch);
            // 双引号内支持 \" 转义（单引号内无反斜杠转义）
            if q == '"' && ch == '\\' && i + 1 < chars.len() {
                current.push(chars[i + 1]);
                i += 2;
                continue;
            }
            if ch == q {
                quote = None;
            }
            i += 1;
            continue;
        }
        if ch == '"' || ch == '\'' {
            quote = Some(ch);
            current.push(ch);
            i += 1;
            continue;
        }
        let mut matched = false;
        for sep in separators {
            let sep_chars: Vec<char> = sep.chars().collect();
            if chars[i..].starts_with(&sep_chars[..]) {
                parts.push(std::mem::take(&mut current));
                i += sep_chars.len();
                matched = true;
                break;
            }
        }
        if matched {
            continue;
        }
        current.push(ch);
        i += 1;
    }
    parts.push(current);
    parts
}

/// 提取命令中所有被 &&、||、; 分隔的命令名（去重）
/// ⚠️ 引号内的分隔符不切分（如 `echo "a;b"` 不会把 `b` 当命令名）
fn extract_all_command_names(raw: &str) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    let segments = split_command_respecting_quotes(raw, &["&&", "||", ";"]);
    for seg in &segments {
        let name = extract_command_name(seg);
        if !name.is_empty() && !names.contains(&name) {
            names.push(name);
        }
    }
    names
}

const DANGEROUS: &[&str] = &[
    "rm",
    "del",
    "erase",
    "rd",
    "rmdir",
    "format",
    "diskpart",
    "fdisk",
    "mkfs",
    "shutdown",
    "reboot",
    "restart",
    "halt",
    "poweroff",
    "sudo",
    "su",
    "runas",
    "chmod",
    "chown",
    "attrib",
    "cacls",
    "icacls",
    "reg",
    "regedit",
    "taskkill",
    "kill",
    "pkill",
    "tskill",
    "mount",
    "umount",
    "msiexec",
    "mshta",
    "sc",
    "net",
    "bcdedit",
    "bootrec",
    "vssadmin",
    "wevtutil",
    "cipher",
    "takeown",
    "remove-item",
];

const INSTALLERS: &[&str] = &[
    "npm",
    "pnpm",
    "yarn",
    "bun",
    "pip",
    "pip3",
    "poetry",
    "conda",
    "cargo",
    "go",
    "gem",
    "nuget",
    "dotnet",
    "brew",
    "port",
    "apt",
    "apt-get",
    "dpkg",
    "yum",
    "dnf",
    "rpm",
    "pacman",
    "choco",
    "scoop",
    "winget",
    "composer",
    "docker",
    "docker-compose",
    "podman",
    "npx",
];

/// 命令风险分类：safe | install | dangerous
pub(crate) fn classify_command(cmd_str: &str) -> &'static str {
    let inner = unwrap_shell_wrapper(cmd_str, 5);
    let cmds = extract_all_command_names(&inner);
    for c in &cmds {
        if DANGEROUS.contains(&c.as_str()) {
            return "dangerous";
        }
    }
    for c in &cmds {
        if INSTALLERS.contains(&c.as_str()) {
            return "install";
        }
    }
    "safe"
}

pub(crate) fn risk_info(risk: &str) -> (String, String) {
    match risk {
        "dangerous" => (
            "高危命令".to_string(),
            "此命令可能对系统造成破坏，请确认是否执行".to_string(),
        ),
        "install" => (
            "安装命令".to_string(),
            "此命令会修改系统环境或下载外部代码，请确认是否执行".to_string(),
        ),
        _ => ("执行命令".to_string(), String::new()),
    }
}

// ==================== 权限三态（与 TS `src/domain/permission` 逐字对齐） ====================

/// 终端命令权限 name（与 TS `src/domain/permission/index.ts` 逐字对齐）
pub(crate) const PERM_TERMINAL_NORMAL: &str = "terminal.normal.execute";
pub(crate) const PERM_TERMINAL_INSTALL: &str = "terminal.install.execute";
pub(crate) const PERM_TERMINAL_DANGEROUS: &str = "terminal.dangerous.execute";
/// 脚本执行权限 name
pub(crate) const PERM_SCRIPT: &str = "script.execute";
/// 沙盒脱壳（申请不使用沙盒执行）权限 name —— 命令执行
pub(crate) const PERM_SANDBOX_COMMAND: &str = "sandbox.command.execute";
/// 沙盒脱壳（申请不使用沙盒执行）权限 name —— 脚本执行
pub(crate) const PERM_SANDBOX_SCRIPT: &str = "sandbox.script.execute";

/// 权限三态
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PermissionDecision {
    Allow,
    Ask,
    Deny,
}

impl PermissionDecision {
    fn parse(s: &str) -> Option<Self> {
        match s {
            "allow" => Some(Self::Allow),
            "ask" => Some(Self::Ask),
            "deny" => Some(Self::Deny),
            _ => None,
        }
    }

    /// 严格度：allow(0) < ask(1) < deny(2) —— 用于「取更严格者」合并两项权限
    fn strictness(&self) -> u8 {
        match self {
            Self::Allow => 0,
            Self::Ask => 1,
            Self::Deny => 2,
        }
    }
}

/// 风险分类 → 权限 name
pub(crate) fn permission_for_risk(risk: &str) -> &'static str {
    match risk {
        "install" => PERM_TERMINAL_INSTALL,
        "dangerous" => PERM_TERMINAL_DANGEROUS,
        _ => PERM_TERMINAL_NORMAL,
    }
}

/// 权限默认决策（与 TS 注册表默认值对齐）：正常命令 allow，其余 ask
fn default_decision(name: &str) -> PermissionDecision {
    match name {
        PERM_TERMINAL_NORMAL => PermissionDecision::Allow,
        _ => PermissionDecision::Ask,
    }
}

/// 旧 `commandApprovalMode` → 决策（仅在 permissions 表缺失时兜底，兼容老客户端 / 测试）
fn legacy_decision(mode: &str, risk: &str) -> PermissionDecision {
    match mode {
        "all" => PermissionDecision::Ask,
        "risky" => {
            if risk == "dangerous" {
                PermissionDecision::Ask
            } else {
                PermissionDecision::Allow
            }
        }
        "install" => {
            if risk == "safe" {
                PermissionDecision::Allow
            } else {
                PermissionDecision::Ask
            }
        }
        "none" => PermissionDecision::Allow,
        _ => PermissionDecision::Ask,
    }
}

/// 取权限决策：`permissions` 表优先 → 回退 legacy `approval_mode` → 回退注册表默认。
pub(crate) fn command_decision(
    permissions: &std::collections::BTreeMap<String, String>,
    approval_mode: &str,
    name: &str,
    risk: &str,
) -> PermissionDecision {
    if let Some(v) = permissions.get(name) {
        if let Some(d) = PermissionDecision::parse(v) {
            return d;
        }
    }
    if !approval_mode.is_empty() {
        return legacy_decision(approval_mode, risk);
    }
    default_decision(name)
}

/// 最终决策（严格度递进）：
/// - `deny` 永远优先；
/// - 申请绕过沙盒（`escape_decision` 为「沙盒脱壳」权限决策）→ 与基础决策**取更严格者**
///   （脱壳权限默认 `ask`；用户可设为 `allow` 静默脱壳、`deny` 直接禁止）；
/// - 终端内确认 → 强制至少 `ask`。
///
/// `escape_decision` 为 `None` 表示本次未申请绕过沙盒（不参与合并）。
pub(crate) fn resolve_decision(
    base: PermissionDecision,
    escape_decision: Option<PermissionDecision>,
    confirm_terminal: bool,
) -> PermissionDecision {
    let mut d = base;
    if let Some(e) = escape_decision {
        if e.strictness() > d.strictness() {
            d = e;
        }
    }
    if d == PermissionDecision::Deny {
        return PermissionDecision::Deny;
    }
    if confirm_terminal {
        return PermissionDecision::Ask;
    }
    d
}

/// 权限中文名（拒绝提示用；与 TS `permissionLabel` 对齐）
pub(crate) fn permission_label(name: &str) -> &'static str {
    match name {
        PERM_TERMINAL_NORMAL => "终端正常命令执行",
        PERM_TERMINAL_INSTALL => "终端安装命令执行",
        PERM_TERMINAL_DANGEROUS => "终端危险命令执行",
        PERM_SCRIPT => "脚本命令执行",
        PERM_SANDBOX_COMMAND => "沙盒脱壳·命令执行",
        PERM_SANDBOX_SCRIPT => "沙盒脱壳·脚本执行",
        _ => "该操作",
    }
}

/// 申请绕过沙盒时追加到风险提示后的警告文案。
///
/// 与 `risk_info` 一致：这里的弹窗文案由 Rust 侧直接下发给 JS（不进 i18n）。
pub(crate) const SANDBOX_BYPASS_HINT: &str = "⚠️ 该命令申请「不使用沙盒」执行：不受写隔离与受限令牌限制，可写入任意路径。仅当该命令确实需要管道 stdio（如 vitest / vite / jest / node-gyp）时允许。";

/// 把绕过沙盒的警告拼到基础提示后（基础提示可能为空）。
pub(crate) fn with_bypass_hint(base_hint: &str) -> String {
    if base_hint.is_empty() {
        SANDBOX_BYPASS_HINT.to_string()
    } else {
        format!("{base_hint}\n{SANDBOX_BYPASS_HINT}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_classify_command() {
        assert_eq!(classify_command("git status"), "safe");
        assert_eq!(classify_command("node --version"), "safe");
        assert_eq!(classify_command("rm -rf /tmp/x"), "dangerous");
        assert_eq!(classify_command("npm install"), "install");
        assert_eq!(classify_command("cmd /c \"npm install\""), "install");
        assert_eq!(classify_command("echo hi && rm x"), "dangerous");
    }

    #[test]
    fn test_classify_command_respects_quotes() {
        // 引号内的 ; / && / || 不应被当作命令分隔符展开
        assert_eq!(classify_command("echo \"a;b\""), "safe");
        assert_eq!(classify_command("echo \"a&&b\""), "safe");
        assert_eq!(classify_command("echo \"a||b\""), "safe");
        assert_eq!(classify_command("echo 'rm -rf /'"), "safe");
        assert_eq!(classify_command("echo \"rm -rf /; whoami\""), "safe");
        assert_eq!(classify_command("git commit -m \"fix; bug\""), "safe");
        // 引号外的分隔符仍然生效
        assert_eq!(classify_command("echo safe; rm -rf /"), "dangerous");
        assert_eq!(classify_command("echo safe && rm -rf /"), "dangerous");
        assert_eq!(classify_command("echo safe || npm install"), "install");
        // 带引号的命令名可正确提取（引号内空格不拆）
        assert_eq!(
            extract_command_name("\"C:/Program Files/app.exe\" --flag"),
            "app"
        );
        assert_eq!(extract_command_name("'my app' --help"), "my app");

        // ---- 双引号 / 单引号互相嵌套 ----
        // 双引号内含单引号：单引号只是普通字符
        assert_eq!(classify_command("echo \"it's a; test\""), "safe");
        // 单引号内含双引号：双引号只是普通字符
        assert_eq!(classify_command("echo 'say \"hi; there\"'"), "safe");
        // 两种引号在同一命令中互相嵌套
        assert_eq!(classify_command("echo \"a'b'c\" && echo 'x\"y\"z'"), "safe");
        // 双引号内转义引号后，分隔符仍在引号内
        assert_eq!(classify_command("echo \"a\\\"b;c\""), "safe");
        // 单引号内反斜杠不转义：`'a\'` 在 \ 后的 ' 处闭合，; 是真正的分隔符
        // （两个子命令都是 echo，仍判 safe）
        assert_eq!(classify_command("echo 'a\\'; echo hi"), "safe");
        assert_eq!(
            extract_all_command_names("echo 'a\\'; echo hi"),
            vec!["echo"]
        );
        // 转义反斜杠后引号真正闭合，外部 rm 仍应被识别
        assert_eq!(classify_command("echo \"a\\\\\"; rm -rf /"), "dangerous");
    }

    #[test]
    fn test_extract_command_name() {
        assert_eq!(extract_command_name("git status"), "git");
        assert_eq!(extract_command_name("C:/Users/x/app.exe --flag"), "app");
        assert_eq!(extract_command_name("'npm' install"), "npm");
        assert_eq!(extract_command_name("./run.sh"), "run");
    }
}
