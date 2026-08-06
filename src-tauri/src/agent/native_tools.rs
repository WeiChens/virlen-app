//! 原生工具执行器 — 高价值工具在 Rust 侧直接执行（无需 JS 桥往返）
//!
//! 覆盖工具（与 JS `toolRegistry` 同名工具对齐）：
//! - `execute_command`：shell 命令执行（风险分类 → 审批 → 原生 spawn + 超时/取消）
//! - `read_file` / `edit_file` / `write_file` / `list_files` / `delete_file` / `file_info`
//! - `search_files_by_name` / `search_text_in_files`
//! - `search_knowledge_base` / `list_knowledge_bases` / `list_knowledge_base_documents`
//!   / `get_knowledge_base_document` / `delete_knowledge_base_document` / `write_to_knowledge_base`
//!
//! 未覆盖的工具（skill、vision、web、user_choice 等）仍走 JS 桥。
//! 安全策略与前端 `securityService.resolveSafePath` / `securityPort.isPathAllowed` 对齐。

use super::bridge::{AgentBridgeState, BridgeInteractionResult};
use super::cancellation::CancellationToken;
use super::event_sink::EventSink;
use super::types::NativeToolSecurity;
use crate::file_ops;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

// ==================== 统一结果 ====================

/// 原生工具结果 — 与 `BridgeToolResult` 对齐，便于下游统一处理
#[derive(Debug, Clone)]
pub enum NativeToolOutcome {
    Value { content: String, ui_data: Option<Value> },
    Error(String),
    /// 保留：原生工具需要用户交互时（如 user_choice 原生化）返回此变体
    #[allow(dead_code)]
    Interaction { interaction_type: String, interaction_data: Value },
    /// 用户暂存交互 — 由 `execute_single_step` 转换为 `__SHELVED__` 暂停标记
    Shelved,
}

/// 原生工具执行上下文
pub struct NativeToolCtx<'a> {
    pub session_id: &'a str,
    pub tool_call_id: &'a str,
    pub cancel: &'a CancellationToken,
    pub sink: &'a dyn EventSink,
    pub bridge: &'a AgentBridgeState,
    pub security: &'a NativeToolSecurity,
}

/// 是否由原生 Rust 直接执行（否则走 JS 桥）
pub fn is_native_tool(name: &str) -> bool {
    matches!(
        name,
        "execute_command"
            | "read_file"
            | "edit_file"
            | "write_file"
            | "list_files"
            | "delete_file"
            | "file_info"
            | "copy_move_file"
            | "search_files_by_name"
            | "search_text_in_files"
            | "search_knowledge_base"
            | "list_knowledge_bases"
            | "list_knowledge_base_documents"
            | "get_knowledge_base_document"
            | "delete_knowledge_base_document"
            | "write_to_knowledge_base"
    )
}

/// 执行原生工具
pub async fn execute_native_tool(
    ctx: &NativeToolCtx<'_>,
    tool_name: &str,
    args: &Value,
) -> Result<NativeToolOutcome, String> {
    match tool_name {
        "execute_command" => execute_command_tool(ctx, args).await,
        "read_file" => read_file_tool(ctx, args).await,
        "edit_file" => edit_file_tool(ctx, args).await,
        "write_file" => write_file_tool(ctx, args).await,
        "list_files" => list_files_tool(ctx, args).await,
        "delete_file" => delete_file_tool(ctx, args).await,
        "file_info" => file_info_tool(ctx, args).await,
        "copy_move_file" => copy_move_file_tool(ctx, args).await,
        "search_files_by_name" => search_files_by_name_tool(ctx, args).await,
        "search_text_in_files" => search_text_in_files_tool(ctx, args).await,
        "search_knowledge_base" => search_knowledge_base_tool(ctx, args).await,
        "list_knowledge_bases" => list_knowledge_bases_tool(ctx, args).await,
        "list_knowledge_base_documents" => list_knowledge_base_documents_tool(ctx, args).await,
        "get_knowledge_base_document" => get_knowledge_base_document_tool(ctx, args).await,
        "delete_knowledge_base_document" => delete_knowledge_base_document_tool(ctx, args).await,
        "write_to_knowledge_base" => write_to_knowledge_base_tool(ctx, args).await,
        _ => Err(format!("Tool \"{}\" not implemented natively", tool_name)),
    }
}

// ==================== 参数辅助 ====================

fn arg_str(args: &Value, key: &str) -> Option<String> {
    args.get(key).and_then(|v| v.as_str()).map(|s| s.to_string())
}
fn arg_i64(args: &Value, key: &str) -> Option<i64> {
    args.get(key).and_then(|v| v.as_i64())
}
fn arg_bool(args: &Value, key: &str) -> Option<bool> {
    args.get(key).and_then(|v| v.as_bool())
}

fn format_size(bytes: usize) -> String {
    if bytes == 0 {
        return "0 B".to_string();
    }
    let units = ["B", "KB", "MB", "GB", "TB"];
    let k = 1024f64;
    let i = ((bytes as f64).log(k).floor() as usize).min(units.len() - 1);
    let val = bytes as f64 / k.powi(i as i32);
    if i > 0 {
        format!("{:.1} {}", val, units[i])
    } else {
        format!("{} B", val as u64)
    }
}

// ==================== 安全路径解析（对齐 securityService.resolveSafePath） ====================

fn canonicalize_partial(path: &str) -> Option<String> {
    let p = std::path::Path::new(path);
    if let Ok(c) = p.canonicalize() {
        return Some(c.to_string_lossy().replace('\\', "/"));
    }
    let normalized = path.replace('\\', "/");
    let normalized = normalized.trim_end_matches('/');
    let parts: Vec<&str> = normalized.split('/').collect();
    for i in (1..parts.len()).rev() {
        let parent = parts[..i].join("/");
        let pp = std::path::Path::new(&parent);
        if let Ok(c) = pp.canonicalize() {
            return Some(c.to_string_lossy().replace('\\', "/"));
        }
    }
    None
}

/// 路径白名单/黑名单校验 — 与 `securityPort.isPathAllowed` 逻辑一致
pub fn is_path_allowed(target: &str, mode: &str, security: &NativeToolSecurity) -> Result<(), String> {
    let canonical_target =
        canonicalize_partial(target).ok_or_else(|| "路径无法解析".to_string())?;

    // 1. 黑名单 > 一切
    for b in &security.blacklist {
        if let Some(canon) = canonicalize_partial(b) {
            if canonical_target == canon || canonical_target.starts_with(&format!("{}/", canon)) {
                return Err(format!("路径已被黑名单拦截: {}", target));
            }
        }
    }

    // 2. 白名单 > 工作目录
    for w in &security.whitelist {
        if let Some(canon) = canonicalize_partial(w) {
            if canonical_target == canon || canonical_target.starts_with(&format!("{}/", canon)) {
                return Ok(());
            }
        }
    }

    // 3. 工作目录
    let raw_workspace = security.workspace.replace('\\', "/");
    let raw_workspace = raw_workspace.trim_end_matches('/');
    if !raw_workspace.is_empty() {
        if let Some(canon_ws) = canonicalize_partial(raw_workspace) {
            if canonical_target == canon_ws
                || canonical_target.starts_with(&format!("{}/", canon_ws))
            {
                return Ok(());
            }
        }
    }

    // 4. 其他路径
    if mode == "w" {
        return Err("路径不在白名单或工作目录内，且写权限仅允许白名单与工作目录".to_string());
    }
    Ok(())
}

/// 相对路径相对 workspace，绝对路径走安全校验
pub fn resolve_safe_path(
    input_path: &str,
    mode: &str,
    security: &NativeToolSecurity,
) -> Result<String, String> {
    let workspace = &security.workspace;
    if workspace.is_empty() {
        return Err("resolveSafePath: workspace 是必填参数".to_string());
    }
    if input_path.is_empty() {
        return Ok(workspace.clone());
    }

    let is_absolute = input_path.starts_with('/')
        || input_path.starts_with('\\')
        || {
            let bytes = input_path.as_bytes();
            bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
        };

    let absolute = if is_absolute {
        input_path.to_string()
    } else {
        let sep = if workspace.ends_with('/') || workspace.ends_with('\\') {
            ""
        } else {
            "/"
        };
        format!("{}{}{}", workspace, sep, input_path.replace('\\', "/"))
    };

    is_path_allowed(&absolute, mode, security)?;
    Ok(absolute)
}

// ==================== execute_command ====================

/// 检测命令是否包含 cmd 特有语法（与 JS hasCmdSyntax 对齐）
fn has_cmd_syntax(cmd: &str) -> bool {
    if cmd.contains("&&") || cmd.contains("||") {
        return true;
    }
    let nul_re = regex::Regex::new(r"[12]?>nul\b").unwrap();
    if nul_re.is_match(cmd) {
        return true;
    }
    let nul_re2 = regex::Regex::new(r"<nul\b").unwrap();
    if nul_re2.is_match(cmd) {
        return true;
    }
    let echo_re = regex::Regex::new(r"(?i)\becho\b").unwrap();
    if echo_re.is_match(cmd) && (cmd.contains('>') || cmd.contains('|')) {
        return true;
    }
    false
}

/// 提取命令名（第一个 token，去路径/扩展名/引号）
fn extract_command_name(raw: &str) -> String {
    let trimmed = raw.trim_start();
    let first_token = trimmed
        .split(|c: char| matches!(c, ' ' | '|' | '&' | ';' | '<' | '>' | '(' | ')'))
        .find(|t| !t.is_empty())
        .unwrap_or("");
    // 同时剥掉首尾引号（JS 只剥开头，这里补上结尾，`'npm'` → `npm` 更准确）
    let mut t = first_token
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

/// 提取命令中所有被 &&、||、; 分隔的命令名（去重）
fn extract_all_command_names(raw: &str) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for seg1 in raw.split("&&") {
        for seg2 in seg1.split("||") {
            for seg3 in seg2.split(';') {
                let name = extract_command_name(seg3);
                if !name.is_empty() && !names.contains(&name) {
                    names.push(name);
                }
            }
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
fn classify_command(cmd_str: &str) -> &'static str {
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

fn risk_info(risk: &str) -> (String, String) {
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

/// 跨平台杀进程树（与 lib.rs kill_process_tree 一致）
fn kill_process_tree(pid: u32) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .status();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = std::process::Command::new("kill")
            .args(["--", &format!("-{}", pid)])
            .status();
        let _ = std::process::Command::new("pkill")
            .args(["-P", &pid.to_string()])
            .status();
    }
}

/// 确保缓冲区存在第 row 行（不足则补空行）
fn ensure_row(buffer: &mut Vec<Vec<char>>, row: usize) {
    while buffer.len() <= row {
        buffer.push(Vec::new());
    }
}

/// 模拟虚拟终端处理输出（与 JS processTerminalOutput 对齐，UTF-8 安全）
fn process_terminal_output(raw: &str) -> String {
    if raw.is_empty() {
        return String::new();
    }
    let mut buffer: Vec<Vec<char>> = vec![Vec::new()];
    let mut row: usize = 0;
    let mut col: usize = 0;
    let chars: Vec<char> = raw.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        if ch == '\r' {
            col = 0;
            i += 1;
        } else if ch == '\n' {
            row += 1;
            col = 0;
            ensure_row(&mut buffer, row);
            i += 1;
        } else if ch == '\x1b' && i + 1 < chars.len() && chars[i + 1] == '[' {
            let mut j = i + 2;
            let mut num_str = String::new();
            while j < chars.len() && (chars[j].is_ascii_digit() || chars[j] == ';') {
                num_str.push(chars[j]);
                j += 1;
            }
            let cmd = if j < chars.len() { chars[j] } else { ' ' };
            let num: usize = num_str
                .split(';')
                .next()
                .and_then(|s| s.parse().ok())
                .unwrap_or(1);
            i = j + 1;
            match cmd {
                'A' => row = row.saturating_sub(num),
                'B' => row = (row + num).min(buffer.len().saturating_sub(1)),
                'C' => col += num,
                'D' => col = col.saturating_sub(num),
                'K' => {
                    ensure_row(&mut buffer, row);
                    let cut = col.min(buffer[row].len());
                    buffer[row].truncate(cut);
                }
                'J' => {
                    let mode: usize = num_str.parse().unwrap_or(0);
                    if mode == 2 || mode == 3 {
                        buffer.clear();
                        buffer.push(Vec::new());
                        row = 0;
                        col = 0;
                    }
                }
                'H' => {
                    let parts: Vec<&str> = num_str.split(';').collect();
                    let r: usize = parts
                        .first()
                        .and_then(|s| s.parse().ok())
                        .unwrap_or(1)
                        .max(1);
                    let c: usize = parts
                        .get(1)
                        .and_then(|s| s.parse().ok())
                        .unwrap_or(1)
                        .max(1);
                    row = r.saturating_sub(1);
                    col = c.saturating_sub(1);
                }
                _ => {}
            }
        } else if ch == '\t' {
            ensure_row(&mut buffer, row);
            let tab_stop = 8usize;
            let next_col = (col + tab_stop) / tab_stop * tab_stop;
            while col < next_col {
                if col >= buffer[row].len() {
                    buffer[row].push(' ');
                }
                col += 1;
            }
            i += 1;
        } else if ch >= ' ' {
            ensure_row(&mut buffer, row);
            if col >= buffer[row].len() {
                buffer[row].push(ch);
            } else {
                buffer[row][col] = ch;
            }
            col += 1;
            i += 1;
        } else {
            i += 1;
        }
    }
    while buffer.len() > 1 && buffer.last().map(|l| l.is_empty()).unwrap_or(false) {
        buffer.pop();
    }
    buffer
        .into_iter()
        .map(|l| l.into_iter().collect::<String>())
        .collect::<Vec<_>>()
        .join("\n")
}

/// 执行 shell 命令（原生）
async fn execute_command_tool(
    ctx: &NativeToolCtx<'_>,
    args: &Value,
) -> Result<NativeToolOutcome, String> {
    let cmd_str = arg_str(args, "command").unwrap_or_default();
    if cmd_str.trim().is_empty() {
        return Err("Missing required parameter: \"command\"".to_string());
    }
    let mut timeout = arg_i64(args, "timeout").unwrap_or(30);
    if timeout < 0 {
        timeout = 30;
    }
    if timeout > 300 {
        timeout = 300;
    }

    let risk = classify_command(&cmd_str);
    let mode = ctx.security.approval_mode.as_str();
    let needs_approval = match mode {
        "all" => true,
        "risky" => risk == "dangerous",
        "install" => risk != "safe",
        _ => false,
    };

    if needs_approval {
        // 走用户交互桥（type=confirm_command_native），由 JS 复用同一个确认弹窗。
        // 审批在本地完成：用户「允许」后直接原生执行命令，避免命令参数跨桥丢失。
        let (label, hint) = risk_info(risk);
        let mut data = json!({
            "command": cmd_str,
            "risk": risk,
            "label": label,
            "hint": hint,
        });
        if let Value::Object(map) = &mut data {
            map.insert(
                "toolCallId".into(),
                Value::String(ctx.tool_call_id.to_string()),
            );
        }

        let payload = ctx
            .bridge
            .request_user_interaction(ctx.sink, ctx.session_id, "confirm_command_native", data)
            .await
            .map_err(|e| format!("error: {}", e))?;

        match BridgeInteractionResult::parse(&payload) {
            BridgeInteractionResult::Value { content, .. } => {
                // 用户允许 → 执行命令；其他文本（如 `[error] xxx`）原样返回
                let normalized = content.trim().to_lowercase();
                if normalized == "approved" || normalized == "允许" || content == "ok" {
                    return run_command_native(ctx, &cmd_str, timeout).await;
                }
                return Ok(NativeToolOutcome::Value {
                    content,
                    ui_data: None,
                });
            }
            BridgeInteractionResult::Error(msg) => Ok(NativeToolOutcome::Error(msg)),
            BridgeInteractionResult::Shelved => Ok(NativeToolOutcome::Shelved),
            BridgeInteractionResult::Cancelled => Ok(NativeToolOutcome::Value {
                content: "[User cancelled]".to_string(),
                ui_data: None,
            }),
        }
    } else {
        run_command_native(ctx, &cmd_str, timeout).await
    }
}

async fn run_command_native(
    ctx: &NativeToolCtx<'_>,
    cmd_str: &str,
    timeout_secs: i64,
) -> Result<NativeToolOutcome, String> {
    use tokio::io::AsyncReadExt;
    use tokio::process::Command;
    use tokio::time::sleep;

    let platform = std::env::consts::OS;
    let is_win = platform == "windows";

    let (shell, args): (&str, Vec<String>) = if is_win {
        if has_cmd_syntax(cmd_str) {
            ("cmd", vec!["/s".into(), "/c".into(), cmd_str.into()])
        } else {
            ("powershell", vec!["-Command".into(), cmd_str.into()])
        }
    } else if platform == "macos" {
        ("zsh", vec!["-c".into(), cmd_str.into()])
    } else {
        ("sh", vec!["-c".into(), cmd_str.into()])
    };

    let mut cmd = Command::new(shell);
    cmd.args(&args);
    #[cfg(target_os = "windows")]
    {
        // 隐藏控制台窗口：Windows 上 spawn cmd/powershell 默认会弹出黑窗口，
        // 与 kill_process_tree / load_env 的 CREATE_NO_WINDOW 保持一致
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    if !ctx.security.workspace.is_empty() {
        cmd.current_dir(&ctx.security.workspace);
    }
    cmd.env("PYTHONIOENCODING", "utf-8");
    if let Some(skills_dir) = &ctx.security.skills_dir {
        cmd.env("SKILL_ROOT", skills_dir);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("[{} error] {}", shell, e))?;
    let pid = child.id().unwrap_or(0);

    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();

    let stdout_handle = tokio::spawn(async move {
        if let Some(mut out) = stdout_pipe {
            let mut buf = Vec::new();
            let _ = out.read_to_end(&mut buf).await;
            String::from_utf8_lossy(&buf).to_string()
        } else {
            String::new()
        }
    });
    let stderr_handle = tokio::spawn(async move {
        if let Some(mut err) = stderr_pipe {
            let mut buf = Vec::new();
            let _ = err.read_to_end(&mut buf).await;
            String::from_utf8_lossy(&buf).to_string()
        } else {
            String::new()
        }
    });

    let (exit_code, killed_by_timeout, killed_by_user) = tokio::select! {
        status = child.wait() => {
            (status.ok().and_then(|s| s.code()), false, false)
        }
        _ = sleep(Duration::from_secs((timeout_secs.max(1)) as u64)) => {
            kill_process_tree(pid);
            let _ = child.wait().await;
            (None, true, false)
        }
        _ = ctx.cancel.cancelled() => {
            kill_process_tree(pid);
            let _ = child.wait().await;
            (None, false, true)
        }
    };

    let stdout = stdout_handle.await.unwrap_or_default();
    let stderr = stderr_handle.await.unwrap_or_default();

    let mut result = String::new();
    if killed_by_user {
        result.push_str("命令已被用户取消\n");
    } else if killed_by_timeout {
        result.push_str(&format!("命令在 {:.3} 秒后超时并被终止\n", timeout_secs as f64));
    } else {
        result.push_str(&format!("退出码: {}\n", exit_code.map(|c| c.to_string()).unwrap_or_else(|| "null".into())));
    }
    if !stdout.is_empty() {
        result.push_str(&process_terminal_output(&stdout));
    }
    if !stdout.is_empty() && !stderr.is_empty() {
        result.push_str("\n");
    }
    if !stderr.is_empty() {
        result.push_str("[标准错误]\n");
        result.push_str(&process_terminal_output(&stderr));
    }

    const MAX: usize = 32000;
    let out = if result.len() > MAX {
        format!("{}...（已截断，共 {} 字符）", &result[..MAX], result.len())
    } else {
        result
    };

    if let Some(code) = exit_code {
        if code >= 2 {
            return Ok(NativeToolOutcome::Error(out));
        }
    }

    Ok(NativeToolOutcome::Value {
        content: out,
        ui_data: Some(json!({
            "stdout": stdout,
            "stderr": stderr,
            "exitCode": exit_code,
        })),
    })
}

// ==================== 文件工具 ====================

async fn read_file_tool(
    ctx: &NativeToolCtx<'_>,
    args: &Value,
) -> Result<NativeToolOutcome, String> {
    let path = arg_str(args, "path").unwrap_or_default();
    let full_path = resolve_safe_path(&path, "r", ctx.security)?;
    // 与 JS `+(max_lines) || 2000` 一致：缺失或 <=0 时取 2000
    let max_lines = match arg_i64(args, "max_lines") {
        Some(n) if n > 0 => n as usize,
        _ => 2000,
    };
    let start_line = arg_i64(args, "start_line").unwrap_or(1).max(1) as usize;

    let full_path_c = full_path.clone();
    let result = tokio::task::spawn_blocking(move || file_ops::read_file(&full_path_c))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
        .map_err(|e| format!("错误：读取文件失败 — {}", e))?;

    let lines: Vec<&str> = result.content.split('\n').collect();
    let total_lines = lines.len();
    let start_idx = (start_line - 1).min(total_lines);
    let end_idx = (start_idx + max_lines).min(total_lines);
    let slice = &lines[start_idx..end_idx];

    let display_start = start_idx + 1;
    let display_end = end_idx;

    let mut header = vec![
        format!("📄 {}", full_path),
        format!("📝 {} 行 / {}", total_lines, format_size(result.byte_size)),
        format!("🔑 SHA256: {}", result.hash),
        format!("🔢 显示: 第 {}-{} 行 (共 {} 行)", display_start, display_end, total_lines),
    ];
    if start_idx > 0 {
        header.push(format!("💡 提示: 使用 start_line={} 读取后续内容", display_end + 1));
    }
    if display_end < total_lines {
        header.push(format!(
            "💡 提示: 文件内容未完整显示，剩余 {} 行。使用 start_line={} 读取后续内容",
            total_lines - display_end,
            display_end + 1
        ));
    }

    let displayed = slice.join("\n");
    Ok(NativeToolOutcome::Value {
        content: format!("{}\n\n{}", header.join("\n"), displayed),
        ui_data: Some(json!({
            "content": displayed,
            "hash": result.hash,
            "line_count": result.line_count,
            "byte_size": result.byte_size,
            "fullPath": full_path,
            "startLine": display_start,
            "endLine": display_end,
        })),
    })
}

async fn edit_file_tool(
    ctx: &NativeToolCtx<'_>,
    args: &Value,
) -> Result<NativeToolOutcome, String> {
    let path = arg_str(args, "path").unwrap_or_default();
    let full_path = resolve_safe_path(&path, "w", ctx.security)?;
    let old_string = arg_str(args, "old_string").unwrap_or_default();
    let new_string = arg_str(args, "new_string").unwrap_or_default();
    let expected_hash = arg_str(args, "expected_hash").unwrap_or_default();
    // 与 JS `replaceCount === 0 ? 999999 : replaceCount` 一致：0 表示全部替换
    let mut replace_count = arg_i64(args, "replace_count").unwrap_or(1) as usize;
    if replace_count == 0 {
        replace_count = usize::MAX;
    }

    let result = {
        let full_path_c = full_path.clone();
        tokio::task::spawn_blocking(move || {
            file_ops::edit_file(&full_path_c, &old_string, &new_string, &expected_hash, replace_count)
        })
        .await
        .map_err(|e| format!("Task join error: {}", e))?
        .map_err(|msg| format!("错误：编辑失败 — {}", msg))?
    };

    let old_line_count = result.old_string_context.split('\n').count();
    let new_line_count = result.new_string_context.split('\n').count();

    let content = format!(
        "✅ 已编辑文件: {}\n  - 替换: {} 处\n  - 共 {} 行\n  - SHA256: {}",
        full_path, result.replaced_count, result.line_count, result.hash
    );

    Ok(NativeToolOutcome::Value {
        content,
        ui_data: Some(json!({
            "fullPath": full_path,
            "oldStartLine": result.old_start_line,
            "oldEndLine": result.old_start_line + old_line_count - 1,
            "newEndLine": result.old_start_line + new_line_count - 1,
            "oldString": result.old_string_context,
            "newString": result.new_string_context,
        })),
    })
}

async fn write_file_tool(
    ctx: &NativeToolCtx<'_>,
    args: &Value,
) -> Result<NativeToolOutcome, String> {
    let path = arg_str(args, "path").unwrap_or_default();
    let full_path = resolve_safe_path(&path, "w", ctx.security)?;
    let content = arg_str(args, "content").unwrap_or_default();

    let result = {
        let full_path_c = full_path.clone();
        let content_c = content.clone();
        tokio::task::spawn_blocking(move || file_ops::write_file(&full_path_c, &content_c))
            .await
            .map_err(|e| format!("Task join error: {}", e))?
            .map_err(|e| format!("错误：写入文件失败 — {}", e))?
    };

    let existed = result.existed;
    let return_content = if existed {
        format!("✅ 已覆写文件 ({}): {}", format_size(result.byte_size), full_path)
    } else {
        format!("✅ 已创建文件 ({}): {}", format_size(result.byte_size), full_path)
    };

    Ok(NativeToolOutcome::Value {
        content: format!("{}\n🔑 SHA256: {}", return_content, result.hash),
        ui_data: Some(json!({
            "hash": result.hash,
            "fullPath": full_path,
            "lineCount": result.line_count,
            "byteSize": result.byte_size,
        })),
    })
}

fn build_tree_rec(entries: &[crate::search::DirEntry], idx: &mut usize) -> Vec<TreeNode> {
    use crate::search::DirEntryType;
    let mut nodes = Vec::new();
    while *idx < entries.len() {
        match entries[*idx].r#type {
            DirEntryType::EnterDir => {
                let name = entries[*idx].name.clone();
                *idx += 1;
                let children = build_tree_rec(entries, idx);
                nodes.push(TreeNode {
                    name,
                    is_dir: true,
                    size: None,
                    children,
                });
            }
            DirEntryType::LeaveDir => {
                *idx += 1;
                return nodes;
            }
            _ => {
                nodes.push(TreeNode {
                    name: entries[*idx].name.clone(),
                    is_dir: entries[*idx].r#type == DirEntryType::Dir,
                    size: entries[*idx].size,
                    children: vec![],
                });
                *idx += 1;
            }
        }
    }
    nodes
}

struct TreeNode {
    name: String,
    is_dir: bool,
    size: Option<u64>,
    children: Vec<TreeNode>,
}

fn render_tree(
    nodes: &[TreeNode],
    prefix: &str,
    skip_dirs: &[String],
    lines: &mut Vec<String>,
    count: &mut usize,
    max: usize,
) {
    for (i, node) in nodes.iter().enumerate() {
        if *count >= max {
            break;
        }
        let is_last = i == nodes.len() - 1;
        let connector = if is_last { "└── " } else { "├── " };
        let next_prefix = format!("{}{}", prefix, if is_last { "    " } else { "│   " });
        let size_str = if !node.is_dir {
            if let Some(sz) = node.size {
                format!("  ({})", format_size(sz as usize))
            } else {
                String::new()
            }
        } else {
            String::new()
        };
        let skip_mark = if node.is_dir && skip_dirs.contains(&node.name) {
            "  # 内部省略"
        } else {
            ""
        };
        lines.push(format!(
            "{}{}{}{}{}{}",
            prefix,
            connector,
            node.name,
            if node.is_dir { "/" } else { "" },
            size_str,
            skip_mark
        ));
        *count += 1;
        if !node.children.is_empty() {
            render_tree(&node.children, &next_prefix, skip_dirs, lines, count, max);
        }
    }
}

async fn list_files_tool(
    ctx: &NativeToolCtx<'_>,
    args: &Value,
) -> Result<NativeToolOutcome, String> {
    use crate::search::DirEntryType;
    let dir_path = arg_str(args, "path").unwrap_or_else(|| ".".into());
    let recursive = arg_bool(args, "recursive").unwrap_or(false);
    let include_hidden = arg_bool(args, "includeHidden").unwrap_or(false);
    let max_depth = arg_i64(args, "maxDepth").unwrap_or(5).max(0) as usize;

    let raw_dir = resolve_safe_path(&dir_path, "r", ctx.security)?;
    let skip_dirs = ctx.security.skip_dirs.clone();

    let cancel_flag = Arc::new(AtomicBool::new(false));
    let flag = cancel_flag.clone();
    let raw_dir_c = raw_dir.clone();
    let skip_c = skip_dirs.clone();
    let task = tokio::task::spawn_blocking(move || {
        crate::search::list_directory(
            &raw_dir_c,
            recursive,
            include_hidden,
            max_depth,
            &skip_c,
            &flag,
        )
    });

    let entries = tokio::select! {
        _ = ctx.cancel.cancelled() => {
            cancel_flag.store(true, Ordering::SeqCst);
            return Ok(NativeToolOutcome::Error("[Search cancelled] Directory listing was cancelled.".into()));
        }
        r = task => r.map_err(|e| format!("Directory listing failed: {}", e))?,
    };

    if entries.is_empty() {
        return Ok(NativeToolOutcome::Value {
            content: "（空目录）".to_string(),
            ui_data: None,
        });
    }

    // 构建相对路径条目（uiData）
    let mut path_stack: Vec<String> = Vec::new();
    let mut items: Vec<Value> = Vec::new();
    for e in &entries {
        match e.r#type {
            DirEntryType::EnterDir => {
                path_stack.push(e.name.clone());
                items.push(json!({ "path": path_stack.join("/"), "isDir": true }));
            }
            DirEntryType::LeaveDir => {
                path_stack.pop();
            }
            _ => {
                let full = if path_stack.is_empty() {
                    e.name.clone()
                } else {
                    format!("{}/{}", path_stack.join("/"), e.name)
                };
                items.push(json!({ "path": full, "isDir": e.r#type == DirEntryType::Dir }));
            }
        }
    }

    const MAX_ITEMS: usize = 600;
    let total_items = items.len();
    let truncated = total_items > MAX_ITEMS;
    items.truncate(MAX_ITEMS);

    let tree = {
        let mut idx = 0;
        build_tree_rec(&entries, &mut idx)
    };

    let mut lines: Vec<String> = vec![raw_dir.clone()];
    let mut count = 0usize;
    render_tree(&tree, "", &skip_dirs, &mut lines, &mut count, MAX_ITEMS);

    let summary = if truncated {
        format!("\n\n⚠️ 文件数量超过限制，仅显示前 {} 项（共 {} 项）", MAX_ITEMS, total_items)
    } else {
        format!("\n\n总计 {} 项", total_items)
    };

    Ok(NativeToolOutcome::Value {
        content: lines.join("\n") + &summary,
        ui_data: Some(json!({ "count": items.len(), "items": items })),
    })
}

async fn delete_file_tool(
    ctx: &NativeToolCtx<'_>,
    args: &Value,
) -> Result<NativeToolOutcome, String> {
    let path = arg_str(args, "path").unwrap_or_default();
    let full_path = resolve_safe_path(&path, "w", ctx.security)?;

    if !std::path::Path::new(&full_path).exists() {
        return Ok(NativeToolOutcome::Value {
            content: format!("错误：路径不存在 — {}", full_path),
            ui_data: None,
        });
    }

    let full_path_c = full_path.clone();
    let result = tokio::task::spawn_blocking(move || trash::delete(&full_path_c))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
        .map_err(|e| format!("错误：删除失败 — {}", e))?;
    let _ = result;

    Ok(NativeToolOutcome::Value {
        content: format!("🗑️ 已移至回收站: {}", full_path),
        ui_data: None,
    })
}

async fn file_info_tool(
    ctx: &NativeToolCtx<'_>,
    args: &Value,
) -> Result<NativeToolOutcome, String> {
    let path = arg_str(args, "path").unwrap_or_default();
    let full_path = resolve_safe_path(&path, "r", ctx.security)?;

    if !std::path::Path::new(&full_path).exists() {
        return Ok(NativeToolOutcome::Value {
            content: format!("错误：路径不存在 — {}", full_path),
            ui_data: None,
        });
    }

    let metadata = std::fs::metadata(&full_path)
        .map_err(|e| format!("错误：获取信息失败 — {}", e))?;

    let is_dir = metadata.is_dir();
    let size = metadata.len();
    let atime = metadata
        .accessed()
        .ok()
        .map(|t| format_system_time(t))
        .unwrap_or_default();
    let mtime = metadata
        .modified()
        .ok()
        .map(|t| format_system_time(t))
        .unwrap_or_default();

    let lines = vec![
        format!("📋 {}", full_path),
        format!("  类型: {}", if is_dir { "📁 目录" } else { "📄 文件" }),
        format!("  大小: {}", format_size(size as usize)),
        if atime.is_empty() {
            String::new()
        } else {
            format!("  访问时间: {}", atime)
        },
        if mtime.is_empty() {
            String::new()
        } else {
            format!("  修改时间: {}", mtime)
        },
    ];

    Ok(NativeToolOutcome::Value {
        content: lines.into_iter().filter(|l| !l.is_empty()).collect::<Vec<_>>().join("\n"),
        ui_data: None,
    })
}

fn format_system_time(t: std::time::SystemTime) -> String {
    let dt: chrono::DateTime<chrono::Local> = t.into();
    dt.format("%Y-%m-%d %H:%M:%S").to_string()
}

/// 确保目标路径的父目录存在
fn ensure_parent_dir(path: &str) -> Result<(), String> {
    let normalized = path.replace('\\', "/");
    if let Some(parent) = normalized.rfind('/') {
        let parent_dir = &normalized[..parent];
        if !parent_dir.is_empty() {
            std::fs::create_dir_all(parent_dir)
                .map_err(|e| format!("创建目录失败: {}", e))?;
        }
    }
    Ok(())
}

async fn copy_move_file_tool(
    ctx: &NativeToolCtx<'_>,
    args: &Value,
) -> Result<NativeToolOutcome, String> {
    let source = arg_str(args, "source").unwrap_or_default();
    let dest = arg_str(args, "destination").unwrap_or_default();
    let mode = arg_str(args, "mode").unwrap_or_else(|| "move".to_string());

    let source_path = resolve_safe_path(&source, "r", ctx.security)?;
    let dest_path = resolve_safe_path(&dest, "w", ctx.security)?;

    if !std::path::Path::new(&source_path).exists() {
        return Ok(NativeToolOutcome::Value {
            content: format!("错误：源路径不存在 — {}", source_path),
            ui_data: None,
        });
    }
    if std::path::Path::new(&dest_path).exists() {
        return Ok(NativeToolOutcome::Value {
            content: format!("错误：目标路径已存在 — {}，请先删除或选择其他路径", dest_path),
            ui_data: None,
        });
    }

    let is_dir = std::fs::metadata(&source_path)
        .map(|m| m.is_dir())
        .unwrap_or(false);

    if mode == "move" {
        match std::fs::rename(&source_path, &dest_path) {
            Ok(_) => {}
            Err(e) => {
                // rename 跨设备会失败，此时尝试 copy+remove（仅文件）
                let cross_device = matches!(
                    e.raw_os_error(),
                    Some(18) | Some(17) // Unix EXDEV / Windows ERROR_NOT_SAME_DEVICE
                );
                if cross_device && !is_dir {
                    ensure_parent_dir(&dest_path)?;
                    std::fs::copy(&source_path, &dest_path)
                        .map_err(|e| format!("错误：移动失败 — {}", e))?;
                    std::fs::remove_file(&source_path)
                        .map_err(|e| format!("错误：移动失败（清理源文件） — {}", e))?;
                } else {
                    return Err(format!("错误：移动失败 — {}", e));
                }
            }
        }
        let type_str = if is_dir { "目录" } else { "文件" };
        Ok(NativeToolOutcome::Value {
            content: format!("✅ 已移动{}: {}\n   → {}", type_str, source_path, dest_path),
            ui_data: Some(json!({
                "mode": "move",
                "source": source_path,
                "destination": dest_path,
                "isDirectory": is_dir,
            })),
        })
    } else {
        if is_dir {
            return Ok(NativeToolOutcome::Value {
                content: "错误：暂不支持复制目录，请使用 move 模式移动目录，或逐个复制目录内的文件".to_string(),
                ui_data: None,
            });
        }
        ensure_parent_dir(&dest_path)?;
        std::fs::copy(&source_path, &dest_path)
            .map_err(|e| format!("错误：复制失败 — {}", e))?;
        Ok(NativeToolOutcome::Value {
            content: format!("✅ 已复制文件: {}\n   → {}", source_path, dest_path),
            ui_data: Some(json!({
                "mode": "copy",
                "source": source_path,
                "destination": dest_path,
                "isDirectory": false,
            })),
        })
    }
}

// ==================== 搜索工具 ====================

/// 将 Glob 模式转换为正则表达式（与 JS globToRegex 对齐）
fn glob_to_regex(pattern: &str) -> String {
    if pattern.is_empty() {
        return "^$".to_string();
    }
    let mut re = String::new();
    let chars: Vec<char> = pattern.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '*' {
            if i + 1 < chars.len() && chars[i + 1] == '*' {
                re.push_str(".*");
                i += 1;
            } else {
                re.push_str("[^/]*");
            }
        } else if c == '?' {
            re.push_str("[^/]");
        } else if c == '{' {
            if let Some(end) = chars[i + 1..].iter().position(|&x| x == '}') {
                let end = i + 1 + end;
                let opts: Vec<String> = pattern[i + 1..end]
                    .split(',')
                    .map(|o| escape_regex(o))
                    .collect();
                re.push('(');
                re.push_str(&opts.join("|"));
                re.push(')');
                i = end;
            } else {
                re.push_str("\\{");
            }
        } else if matches!(c, '.' | '+' | '^' | '$' | '{' | '}' | '(' | ')' | '|' | '[' | ']' | '\\') {
            re.push('\\');
            re.push(c);
        } else {
            re.push(c);
        }
        i += 1;
    }
    format!("^{}$", re)
}

fn escape_regex(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        if matches!(c, '.' | '+' | '^' | '$' | '{' | '}' | '(' | ')' | '|' | '[' | ']' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

async fn search_files_by_name_tool(
    ctx: &NativeToolCtx<'_>,
    args: &Value,
) -> Result<NativeToolOutcome, String> {
    let query = arg_str(args, "query").unwrap_or_default();
    if query.trim().is_empty() {
        return Ok(NativeToolOutcome::Value {
            content: "Missing required parameter: \"query\". Please provide a filename pattern to search for.".to_string(),
            ui_data: Some(json!({ "length": 0, "items": [] })),
        });
    }

    let root = resolve_safe_path(&arg_str(args, "path").unwrap_or_else(|| ".".into()), "r", ctx.security)?;
    let use_regex = arg_bool(args, "use_regex").unwrap_or(false);
    let glob = arg_bool(args, "glob").unwrap_or(false);
    let max_results = arg_i64(args, "max_results").unwrap_or(30).clamp(1, 500) as usize;

    let mut effective_query = query.clone();
    let mut effective_use_regex = use_regex;
    if glob {
        effective_query = glob_to_regex(&query);
        effective_use_regex = true;
    }

    let cancel_flag = Arc::new(AtomicBool::new(false));
    let flag = cancel_flag.clone();
    let root_c = root.clone();
    let q = effective_query.clone();
    let task = tokio::task::spawn_blocking(move || {
        crate::search::search_files_by_name(&root_c, &q, effective_use_regex, max_results, &flag)
    });

    let results = tokio::select! {
        _ = ctx.cancel.cancelled() => {
            cancel_flag.store(true, Ordering::SeqCst);
            return Ok(NativeToolOutcome::Error(format!("[Search cancelled] Search for \"{}\" was cancelled.", query)));
        }
        r = task => r.map_err(|e| format!("Search failed: {}", e))?,
    };

    let results: Vec<String> = results.into_iter().map(|r| r.path).collect();

    if results.is_empty() {
        return Ok(NativeToolOutcome::Value {
            content: format!("No files matching \"{}\" found in {}.", query, arg_str(args, "path").unwrap_or_else(|| ".".into())),
            ui_data: Some(json!({ "length": 0, "items": [] })),
        });
    }

    let content = format!(
        "🔍 {} file(s) matching \"{}\":\n{}",
        results.len(),
        query,
        results.iter().map(|p| format!("  📄 {}", p)).collect::<Vec<_>>().join("\n")
    );

    Ok(NativeToolOutcome::Value {
        content,
        ui_data: Some(json!({ "length": results.len(), "items": results })),
    })
}

async fn search_text_in_files_tool(
    ctx: &NativeToolCtx<'_>,
    args: &Value,
) -> Result<NativeToolOutcome, String> {
    let query = arg_str(args, "query").unwrap_or_default();
    if query.trim().is_empty() {
        return Ok(NativeToolOutcome::Value {
            content: "Missing required parameter: \"query\". Please provide a text or regex pattern to search for.".to_string(),
            ui_data: Some(json!({ "length": 0 })),
        });
    }

    let root = resolve_safe_path(&arg_str(args, "path").unwrap_or_else(|| ".".into()), "r", ctx.security)?;
    let max_results = arg_i64(args, "max_results").unwrap_or(30).clamp(1, 500) as usize;

    let cancel_flag = Arc::new(AtomicBool::new(false));
    let flag = cancel_flag.clone();
    let root_c = root.clone();
    let q = query.clone();
    let task = tokio::task::spawn_blocking(move || {
        crate::search::search_text_in_files(&root_c, &q, max_results, &flag)
    });

    let results = tokio::select! {
        _ = ctx.cancel.cancelled() => {
            cancel_flag.store(true, Ordering::SeqCst);
            return Ok(NativeToolOutcome::Error(format!("[Search cancelled] Search for \"{}\" was cancelled.", query)));
        }
        r = task => r.map_err(|e| format!("Search failed: {}", e))?,
    };

    const MAX_CHARS: usize = 32000;
    let mut output = format!("🔍 {} match(es) for \"{}\":\n", results.len(), query);
    for r in &results {
        let line = format!("  📄 {}:{}  {}", r.path, r.line_number, r.line.trim());
        if output.len() + line.len() + 1 > MAX_CHARS {
            output.push_str(&format!("\n... (truncated, {} total matches)", results.len()));
            break;
        }
        output.push_str(&line);
        output.push('\n');
    }

    Ok(NativeToolOutcome::Value {
        content: output,
        ui_data: Some(json!({ "length": results.len() })),
    })
}

// ==================== 知识库工具 ====================

/// 调用 RAG 服务的阻塞任务包装
fn rag_service() -> Result<&'static crate::rag::rag_service::RagService, String> {
    crate::rag::get_service()
}

fn build_search_context(results: &[crate::rag::vector_store::ChunkResult], query: &str, kb_id: &str) -> String {
    let mut lines = vec![
        format!("Search results from knowledge base \"{}\" for query: \"{}\"", kb_id, query),
        String::new(),
    ];
    for (i, r) in results.iter().enumerate() {
        lines.push(format!("[{}] Document: {}", i + 1, r.document_name));
        lines.push(format!("    Document ID: {}", r.document_id));
        lines.push(format!("    Similarity: {:.1}%", r.score * 100.0));
        lines.push(format!("    Content: {}", r.content));
        lines.push(String::new());
    }
    lines.push("---".to_string());
    lines.push("To delete or edit a document, use its Document ID above.".to_string());
    lines.join("\n")
}

async fn search_knowledge_base_tool(
    _ctx: &NativeToolCtx<'_>,
    args: &Value,
) -> Result<NativeToolOutcome, String> {
    let query = arg_str(args, "query").unwrap_or_default();
    if query.trim().is_empty() {
        return Ok(NativeToolOutcome::Value {
            content: "Missing required parameter: \"query\". Please provide a search query.".to_string(),
            ui_data: None,
        });
    }
    let kb_id = arg_str(args, "knowledge_base_id").unwrap_or_default();
    if kb_id.is_empty() {
        return Ok(NativeToolOutcome::Value {
            content: "Missing required parameter: \"knowledge_base_id\". Use list_knowledge_bases to discover available knowledge bases and their IDs.".to_string(),
            ui_data: None,
        });
    }
    let top_k = arg_i64(args, "top_k").unwrap_or(5).clamp(1, 20) as usize;

    let service = rag_service()?;
    let kb_id_c = kb_id.clone();
    let query_c = query.trim().to_string();
    let results = tokio::task::spawn_blocking(move || service.query(&kb_id_c, &query_c, top_k))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
        .map_err(|e| format!("Error searching knowledge base: {}", e))?;

    if results.is_empty() {
        return Ok(NativeToolOutcome::Value {
            content: format!("No relevant information found in knowledge base \"{}\" for query: \"{}\".", kb_id, query),
            ui_data: Some(json!({ "length": 0, "query": query })),
        });
    }

    let context = build_search_context(&results, &query, &kb_id);
    let ui_results: Vec<Value> = results
        .iter()
        .map(|r| {
            json!({
                "id": r.id,
                "document_name": r.document_name,
                "document_id": r.document_id,
                "score": r.score,
                "snippet": r.content.chars().take(200).collect::<String>(),
            })
        })
        .collect();

    Ok(NativeToolOutcome::Value {
        content: context,
        ui_data: Some(json!({
            "length": results.len(),
            "results": ui_results,
            "query": query,
            "knowledge_base_id": kb_id,
        })),
    })
}

async fn list_knowledge_bases_tool(
    _ctx: &NativeToolCtx<'_>,
    _args: &Value,
) -> Result<NativeToolOutcome, String> {
    let service = rag_service()?;
    let kbs = tokio::task::spawn_blocking(move || service.list_knowledge_bases())
        .await
        .map_err(|e| format!("Task join error: {}", e))?
        .map_err(|e| format!("Error listing knowledge bases: {}", e))?;

    if kbs.is_empty() {
        return Ok(NativeToolOutcome::Value {
            content: "No knowledge bases found. Create a knowledge base first and upload documents to it, or use write_to_knowledge_base to create new content.".to_string(),
            ui_data: Some(json!({ "length": 0 })),
        });
    }

    let mut lines = vec![format!("📚 Available Knowledge Bases ({} total):", kbs.len()), String::new()];
    let mut ui_kbs: Vec<Value> = Vec::new();

    for (i, kb) in kbs.iter().enumerate() {
        // 每个知识库列出最多 20 个文档标题
        let docs = service.list_documents(&kb.id).unwrap_or_default();
        let doc_titles: Vec<String> = docs.iter().take(20).map(|d| d.file_name.clone()).collect();

        lines.push(format!("[{}] {}", i + 1, kb.name));
        lines.push(format!("    ID: {}", kb.id));
        lines.push(format!("    Description: {}", if kb.description.is_empty() { "No description".to_string() } else { kb.description.clone() }));
        lines.push(format!("    Documents: {}", kb.document_count));
        lines.push(format!("    Chunks: {}", kb.chunk_count));
        if !doc_titles.is_empty() {
            lines.push(format!("    Document titles (showing {} of {}):", doc_titles.len(), kb.document_count));
            for (idx, title) in doc_titles.iter().enumerate() {
                lines.push(format!("      {}. {}", idx + 1, title));
            }
        }
        lines.push(String::new());

        ui_kbs.push(json!({
            "id": kb.id,
            "name": kb.name,
            "description": kb.description,
            "documentCount": kb.document_count,
        }));
    }

    lines.push("---".to_string());
    lines.push("Use list_knowledge_base_documents with the knowledge_base_id to see all documents and their IDs.".to_string());
    lines.push("Use search_knowledge_base with the knowledge_base_id to search within a specific knowledge base.".to_string());
    lines.push("Use write_to_knowledge_base with the knowledge_base_id to save new content.".to_string());

    Ok(NativeToolOutcome::Value {
        content: lines.join("\n"),
        ui_data: Some(json!({ "length": kbs.len(), "knowledgeBases": ui_kbs })),
    })
}

async fn list_knowledge_base_documents_tool(
    _ctx: &NativeToolCtx<'_>,
    args: &Value,
) -> Result<NativeToolOutcome, String> {
    let kb_id = arg_str(args, "knowledge_base_id").unwrap_or_default();
    if kb_id.is_empty() {
        return Ok(NativeToolOutcome::Value {
            content: "Missing required parameter: \"knowledge_base_id\". Use list_knowledge_bases to discover available knowledge bases.".to_string(),
            ui_data: None,
        });
    }

    let service = rag_service()?;
    let kb_id_c = kb_id.clone();
    let docs = tokio::task::spawn_blocking(move || service.list_documents(&kb_id_c))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
        .map_err(|e| format!("Error listing documents: {}", e))?;

    if docs.is_empty() {
        return Ok(NativeToolOutcome::Value {
            content: format!("No documents found in knowledge base \"{}\". Use write_to_knowledge_base to create new content, or upload documents through the UI.", kb_id),
            ui_data: Some(json!({ "length": 0, "knowledge_base_id": kb_id })),
        });
    }

    let mut lines = vec![format!("📄 Documents in knowledge base \"{}\" ({} total):", kb_id, docs.len()), String::new()];
    let mut ui_docs: Vec<Value> = Vec::new();

    for (i, d) in docs.iter().enumerate() {
        lines.push(format!("[{}] {}", i + 1, d.file_name));
        lines.push(format!("    Document ID: {}", d.id));
        lines.push(format!("    Type: {}", d.file_type));
        lines.push(format!("    Chunks: {}", d.chunk_count));
        lines.push(format!("    Status: {}", d.status));
        lines.push(String::new());

        ui_docs.push(json!({
            "id": d.id,
            "file_name": d.file_name,
            "file_type": d.file_type,
            "chunk_count": d.chunk_count,
            "status": d.status,
        }));
    }

    lines.push("---".to_string());
    lines.push("Use search_knowledge_base to search within this knowledge base.".to_string());
    lines.push("Use delete_knowledge_base_document with a Document ID to remove it.".to_string());

    Ok(NativeToolOutcome::Value {
        content: lines.join("\n"),
        ui_data: Some(json!({ "length": docs.len(), "knowledge_base_id": kb_id, "documents": ui_docs })),
    })
}

async fn get_knowledge_base_document_tool(
    _ctx: &NativeToolCtx<'_>,
    args: &Value,
) -> Result<NativeToolOutcome, String> {
    let kb_id = arg_str(args, "knowledge_base_id").unwrap_or_default();
    if kb_id.is_empty() {
        return Ok(NativeToolOutcome::Value {
            content: "Missing required parameter: \"knowledge_base_id\". Use list_knowledge_bases to discover available knowledge bases.".to_string(),
            ui_data: None,
        });
    }
    let doc_id = arg_str(args, "document_id").unwrap_or_default();
    if doc_id.is_empty() {
        return Ok(NativeToolOutcome::Value {
            content: "Missing required parameter: \"document_id\". Use list_knowledge_base_documents to find document IDs.".to_string(),
            ui_data: None,
        });
    }

    let service = rag_service()?;
    let kb_id_c = kb_id.clone();
    let doc_id_c = doc_id.clone();
    let content = tokio::task::spawn_blocking(move || service.get_document_content(&kb_id_c, &doc_id_c))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
        .map_err(|e| format!("Error retrieving document: {}", e))?;

    Ok(NativeToolOutcome::Value {
        content: format!("Full content of document \"{}\" from knowledge base (ID: {}):\n\n---\n{}\n---", doc_id, kb_id, content),
        ui_data: Some(json!({ "document_id": doc_id, "knowledge_base_id": kb_id })),
    })
}

async fn delete_knowledge_base_document_tool(
    _ctx: &NativeToolCtx<'_>,
    args: &Value,
) -> Result<NativeToolOutcome, String> {
    let kb_id = arg_str(args, "knowledge_base_id").unwrap_or_default();
    if kb_id.is_empty() {
        return Ok(NativeToolOutcome::Value {
            content: "Missing required parameter: \"knowledge_base_id\". Use list_knowledge_bases to discover available knowledge bases.".to_string(),
            ui_data: None,
        });
    }
    let doc_id = arg_str(args, "document_id").unwrap_or_default();
    if doc_id.is_empty() {
        return Ok(NativeToolOutcome::Value {
            content: "Missing required parameter: \"document_id\". Use search_knowledge_base to find document IDs within a knowledge base.".to_string(),
            ui_data: None,
        });
    }

    let service = rag_service()?;
    let kb_id_c = kb_id.clone();
    let doc_id_c = doc_id.clone();
    tokio::task::spawn_blocking(move || service.remove_document(&kb_id_c, &doc_id_c))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
        .map_err(|e| format!("Error deleting document from knowledge base: {}", e))?;

    Ok(NativeToolOutcome::Value {
        content: format!("Successfully deleted document \"{}\" from knowledge base (ID: {}). The document and all its chunks have been permanently removed.", doc_id, kb_id),
        ui_data: Some(json!({ "document_id": doc_id, "knowledge_base_id": kb_id })),
    })
}

async fn write_to_knowledge_base_tool(
    _ctx: &NativeToolCtx<'_>,
    args: &Value,
) -> Result<NativeToolOutcome, String> {
    let kb_id = arg_str(args, "knowledge_base_id").unwrap_or_default();
    if kb_id.is_empty() {
        return Ok(NativeToolOutcome::Value {
            content: "Missing required parameter: \"knowledge_base_id\". Use list_knowledge_bases to discover available knowledge bases.".to_string(),
            ui_data: None,
        });
    }
    let doc_name = arg_str(args, "document_name").unwrap_or_default();
    if doc_name.trim().is_empty() {
        return Ok(NativeToolOutcome::Value {
            content: "Missing required parameter: \"document_name\". Please provide a descriptive name for the document.".to_string(),
            ui_data: None,
        });
    }
    let content = arg_str(args, "content").unwrap_or_default();
    if content.trim().is_empty() {
        return Ok(NativeToolOutcome::Value {
            content: "Missing required parameter: \"content\". Please provide the text content to save.".to_string(),
            ui_data: None,
        });
    }

    let service = rag_service()?;
    let kb_id_c = kb_id.clone();
    let doc_name_c = doc_name.trim().to_string();
    let content_c = content.trim().to_string();
    let doc = tokio::task::spawn_blocking(move || service.add_text_document(&kb_id_c, &doc_name_c, &content_c))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
        .map_err(|e| format!("Error writing to knowledge base: {}", e))?;

    Ok(NativeToolOutcome::Value {
        content: format!(
            "Successfully saved \"{}\" to knowledge base (ID: {}). Document ID: {}. The content has been chunked into {} segments and is now available for semantic search.",
            doc.file_name, kb_id, doc.id, doc.chunk_count
        ),
        ui_data: Some(json!({
            "document_id": doc.id,
            "document_name": doc.file_name,
            "knowledge_base_id": kb_id,
            "chunk_count": doc.chunk_count,
        })),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_security(workspace: &str) -> NativeToolSecurity {
        NativeToolSecurity {
            workspace: workspace.to_string(),
            approval_mode: "risky".to_string(),
            skip_dirs: vec!["node_modules".to_string()],
            blacklist: vec![],
            whitelist: vec![],
            skills_dir: None,
        }
    }

    #[test]
    fn test_has_cmd_syntax() {
        assert!(has_cmd_syntax("dir && echo hi"));
        assert!(has_cmd_syntax("echo hi > nul"));
        assert!(has_cmd_syntax("echo hi 2>nul"));
        assert!(has_cmd_syntax("echo hi <nul"));
        assert!(!has_cmd_syntax("git status"));
        assert!(!has_cmd_syntax("dir /b"));
    }

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
    fn test_extract_command_name() {
        assert_eq!(extract_command_name("git status"), "git");
        assert_eq!(extract_command_name("C:/Users/x/app.exe --flag"), "app");
        assert_eq!(extract_command_name("'npm' install"), "npm");
        assert_eq!(extract_command_name("./run.sh"), "run");
    }

    #[test]
    fn test_glob_to_regex() {
        assert_eq!(glob_to_regex("**/*.ts"), "^.*/[^/]*\\.ts$");
        assert_eq!(glob_to_regex("*.json"), "^[^/]*\\.json$");
        assert_eq!(glob_to_regex("src/**/*.css"), "^src/.*/[^/]*\\.css$");
    }

    #[test]
    fn test_process_terminal_output() {
        assert_eq!(process_terminal_output("hello"), "hello");
        // \r 覆盖
        assert_eq!(process_terminal_output("progress: 10%\rprogress: 20%"), "progress: 20%");
        // ANSI 颜色剥离
        assert_eq!(process_terminal_output("\x1b[31mred\x1b[0m"), "red");
        // CRLF 归一化
        assert_eq!(process_terminal_output("a\r\nb"), "a\nb");
    }

    #[test]
    fn test_resolve_safe_path_relative() {
        let dir = std::env::temp_dir().join(format!("virlen_native_test_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let sec = test_security(&dir.to_string_lossy());
        let resolved = resolve_safe_path("sub/file.txt", "r", &sec).unwrap();
        assert!(resolved.ends_with("/sub/file.txt") || resolved.ends_with("\\sub/file.txt"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_resolve_safe_path_write_outside_workspace() {
        let dir = std::env::temp_dir().join(format!("virlen_native_test_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let sec = test_security(&dir.to_string_lossy());
        // 非白名单/工作目录外的写路径应被拒绝（除非是绝对路径在临时目录外）
        // 这里使用一个不存在且不在 workspace 下的绝对路径
        let outside = std::env::temp_dir().join("some_outside_file.txt");
        let outside_str = outside.to_string_lossy().replace('\\', "/");
        if !outside_str.starts_with(&dir.to_string_lossy().replace('\\', "/")) {
            let r = resolve_safe_path(&outside_str, "w", &sec);
            // workspace 是临时目录，outside 在 /tmp 下且 /tmp 不在 workspace 内 → 应拒绝
            assert!(r.is_err());
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_write_read_roundtrip() {
        let dir = std::env::temp_dir().join(format!("virlen_native_test_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("hello.txt");
        let path = file.to_string_lossy().to_string();

        let w = file_ops::write_file(&path, "hello\nworld\n").unwrap();
        assert!(w.existed == false);
        let r = file_ops::read_file(&path).unwrap();
        assert_eq!(r.content, "hello\nworld\n");
        assert_eq!(r.hash, w.hash);

        // 再次写入（覆盖）
        let w2 = file_ops::write_file(&path, "new content").unwrap();
        assert!(w2.existed);
        let r2 = file_ops::read_file(&path).unwrap();
        assert_eq!(r2.content, "new content");
        assert_ne!(r2.hash, w.hash);

        std::fs::remove_dir_all(&dir).ok();
    }

    /// 通过 execute_native_tool 分发器走一遍 写→读→搜索 完整链路
    #[tokio::test]
    async fn test_native_dispatcher_write_read_search() {
        use crate::agent::bridge::AgentBridgeState;
        use crate::agent::cancellation::CancellationToken;
        use crate::agent::event_sink::TestEventSink;

        let dir = std::env::temp_dir().join(format!("virlen_native_dispatch_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let sec = test_security(&dir.to_string_lossy());
        let sink = TestEventSink::new();
        let bridge = AgentBridgeState::default();
        let cancel = CancellationToken::new();
        let ctx = NativeToolCtx {
            session_id: "s1",
            tool_call_id: "tc_1",
            cancel: &cancel,
            sink: &sink,
            bridge: &bridge,
            security: &sec,
        };

        // 1. write_file（相对路径 → workspace 下，自动建父目录）
        let args = json!({ "path": "a/b.txt", "content": "hello world" });
        let outcome = execute_native_tool(&ctx, "write_file", &args).await.unwrap();
        let content = match outcome {
            NativeToolOutcome::Value { content, .. } => content,
            other => panic!("expected value, got {:?}", other),
        };
        assert!(content.contains("b.txt"), "write result: {}", content);

        // 2. read_file
        let args = json!({ "path": "a/b.txt" });
        let outcome = execute_native_tool(&ctx, "read_file", &args).await.unwrap();
        let content = match outcome {
            NativeToolOutcome::Value { content, .. } => content,
            other => panic!("expected value, got {:?}", other),
        };
        assert!(content.contains("hello world"), "read result: {}", content);

        // 3. search_files_by_name
        let args = json!({ "path": ".", "query": "b.txt" });
        let outcome = execute_native_tool(&ctx, "search_files_by_name", &args).await.unwrap();
        let content = match outcome {
            NativeToolOutcome::Value { content, .. } => content,
            other => panic!("expected value, got {:?}", other),
        };
        assert!(content.contains("b.txt"), "search result: {}", content);

        // 4. 写权限越界（绝对路径在 workspace 外）应被拒绝
        let outside = std::env::temp_dir().join(format!("virlen_outside_{}", uuid::Uuid::new_v4()));
        let outside_str = outside.to_string_lossy().replace('\\', "/");
        if !outside_str.starts_with(&dir.to_string_lossy().replace('\\', "/")) {
            let args = json!({ "path": outside_str, "content": "x" });
            let outcome = execute_native_tool(&ctx, "write_file", &args).await;
            assert!(
                matches!(outcome, Err(_)),
                "write outside workspace should fail"
            );
        }

        std::fs::remove_dir_all(&dir).ok();
    }
}
