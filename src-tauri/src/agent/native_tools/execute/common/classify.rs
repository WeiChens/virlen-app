//! 命令解析与风险分类（safe | install | dangerous）+ 风险/审批文案。
//!
//! - 命令名提取、shell 包装剥离、引号感知的分段（`extract_*` / `split_*`）。
//! - 风险分类 `classify_command`，审批文案 `risk_info` / `needs_command_approval`。
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
    let re2 =
        regex::Regex::new(r#"(?i)^(?:powershell|pwsh)(?:\.exe)?\s+-Command\s+"?([^"]+)"?$"#)
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
    "rm", "del", "erase", "rd", "rmdir", "format", "diskpart", "fdisk", "mkfs", "shutdown",
    "reboot", "restart", "halt", "poweroff", "sudo", "su", "runas", "chmod", "chown", "attrib",
    "cacls", "icacls", "reg", "regedit", "taskkill", "kill", "pkill", "tskill", "mount", "umount",
    "msiexec", "mshta", "sc", "net", "bcdedit", "bootrec", "vssadmin", "wevtutil", "cipher",
    "takeown", "remove-item",
];

const INSTALLERS: &[&str] = &[
    "npm", "pnpm", "yarn", "bun", "pip", "pip3", "poetry", "conda", "cargo", "go", "gem",
    "nuget", "dotnet", "brew", "port", "apt", "apt-get", "dpkg", "yum", "dnf", "rpm", "pacman",
    "choco", "scoop", "winget", "composer", "docker", "docker-compose", "podman", "npx",
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

/// 是否需要弹窗审批。
///
/// `bypass_sandbox`（execute_command 的 `sandbox:"off"`，申请不使用沙盒/受限令牌）
/// **一律强制审批**，不受 `commandApprovalMode` 影响——写隔离是安全底线，不允许静默绕过。
pub(crate) fn needs_command_approval(approval_mode: &str, risk: &str, bypass_sandbox: bool) -> bool {
    if bypass_sandbox {
        return true;
    }
    match approval_mode {
        "all" => true,
        "risky" => risk == "dangerous",
        "install" => risk != "safe",
        _ => false,
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
        assert_eq!(extract_command_name("\"C:/Program Files/app.exe\" --flag"), "app");
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
        assert_eq!(extract_all_command_names("echo 'a\\'; echo hi"), vec!["echo"]);
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
