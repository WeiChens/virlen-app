//! execute — 代码执行分类公共模块（分类 id: execute）
//!
//! 供本分类下的 `execute_command` / `execute_script` 复用：
//!   1. 终端输出解码（UTF-8 优先、GBK 兜底；跨 8KB 分块安全）
//!   2. 命令解析与风险分类（safe | install | dangerous）+ 风险文案
//!   3. 运行中命令注册表（前端 ToolOutput.kill → 终止整棵进程树）
//!   4. 终端输出处理（\r 覆盖 / ANSI 转义序列）
//!   5. 统一运行器 run_command_native（沙盒优先，失败降级裸跑；`bypass_sandbox` 时直接裸跑）

use crate::agent::native_tools::{NativeToolCtx, NativeToolOutcome};
use serde_json::json;
use std::collections::BTreeMap;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

// ==================== 1. 终端输出解码 ====================

/// 将输出字节流解码为字符串：优先 UTF-8；失败时按 Windows ANSI 代码页兜底。
/// 中文 Windows 上 Windows PowerShell 5.1 通过管道输出时默认使用 GBK/CP936，
/// 若一律按 UTF-8 硬解会出现 `�` 乱码（如中文文件名显示为 ��������.wav）。
fn decode_output(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return String::new();
    }
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(_) => {
            #[cfg(target_os = "windows")]
            {
                // encoding_rs::GBK 即 CP936，覆盖中文系统最常见场景。
                // 其他 ANSI 代码页（CP932/CP950 等）可后续按 GetACP/GetOEMCP 扩展。
                let (cow, _, _) = encoding_rs::GBK.decode(bytes);
                cow.into_owned()
            }
            #[cfg(not(target_os = "windows"))]
            {
                String::from_utf8_lossy(bytes).into_owned()
            }
        }
    }
}

/// 流式解码器：跨 8KB 分块保留多字节序列尾部，避免字符在块边界被切断成乱码。
/// 内部区分三态：全部合法 UTF-8 / 尾部是跨块的不完整 UTF-8 序列 / 出现非 UTF-8 字节（GBK 等）。
struct TerminalDecoder {
    pending: Vec<u8>,
}

enum Utf8Status {
    /// 全部字节可构成合法 UTF-8
    Complete,
    /// pos 之前是合法 UTF-8，pos 开始是跨块的不完整序列（等更多字节）
    Incomplete { pos: usize },
    /// pos 处出现无法按 UTF-8 解释的字节（可能是 GBK 等编码）
    NotUtf8 { pos: usize },
}

impl TerminalDecoder {
    fn new() -> Self {
        Self { pending: Vec::new() }
    }

    /// 追加一段原始字节，返回本次可安全解码出的文本
    fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        match self.utf8_status() {
            Utf8Status::Complete => {
                match std::str::from_utf8(&self.pending) {
                    Ok(_) => String::from_utf8(std::mem::take(&mut self.pending)).unwrap(),
                    Err(_) => {
                        // 结构看似 UTF-8 但实际非法（overlong/surrogate）→ 兜底解码
                        let text = decode_output(&self.pending);
                        self.pending.clear();
                        text
                    }
                }
            }
            Utf8Status::Incomplete { pos } => {
                if pos == 0 {
                    // 全部是跨块的不完整序列，等更多字节
                    String::new()
                } else {
                    let text = String::from_utf8(self.pending[..pos].to_vec()).unwrap();
                    self.pending.drain(..pos);
                    text
                }
            }
            Utf8Status::NotUtf8 { pos } => {
                if pos > 0 {
                    // 先输出前面合法的 UTF-8 前缀，GBK 部分留到后续整体兜底
                    let text = String::from_utf8(self.pending[..pos].to_vec()).unwrap();
                    self.pending.drain(..pos);
                    text
                } else {
                    // 整体按兜底编码解码（GBK 等），清空
                    let text = decode_output(&self.pending);
                    self.pending.clear();
                    text
                }
            }
        }
    }

    /// 流结束时解码剩余字节
    fn finish(&mut self) -> String {
        let text = decode_output(&self.pending);
        self.pending.clear();
        text
    }

    /// 判断当前 pending 的 UTF-8 状态（从前往后扫描）
    fn utf8_status(&self) -> Utf8Status {
        let bytes = &self.pending;
        let n = bytes.len();
        let mut i = 0;
        while i < n {
            let b = bytes[i];
            if b < 0x80 {
                i += 1;
                continue;
            }
            if (0xC2..=0xF4).contains(&b) {
                let seq = if b >= 0xF0 { 4 } else if b >= 0xE0 { 3 } else { 2 };
                if i + seq > n {
                    // 序列不完整：可能跨块，也可能真不是 UTF-8，先保守等待
                    return Utf8Status::Incomplete { pos: i };
                }
                let all_cont = (1..seq).all(|k| (0x80..=0xBF).contains(&bytes[i + k]));
                if !all_cont {
                    return Utf8Status::NotUtf8 { pos: i };
                }
                i += seq;
                continue;
            }
            // 0x80-0xBF 单独出现 / 0xC0、0xC1 等非法起始 → 不是 UTF-8
            return Utf8Status::NotUtf8 { pos: i };
        }
        Utf8Status::Complete
    }
}

// ==================== 2. 命令解析与风险分类 ====================

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
pub(super) fn classify_command(cmd_str: &str) -> &'static str {
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

pub(super) fn risk_info(risk: &str) -> (String, String) {
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
pub(super) fn needs_command_approval(approval_mode: &str, risk: &str, bypass_sandbox: bool) -> bool {
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
pub(super) const SANDBOX_BYPASS_HINT: &str = "⚠️ 该命令申请「不使用沙盒」执行：不受写隔离与受限令牌限制，可写入任意路径。仅当该命令确实需要管道 stdio（如 vitest / vite / jest / node-gyp）时允许。";

/// 把绕过沙盒的警告拼到基础提示后（基础提示可能为空）。
pub(super) fn with_bypass_hint(base_hint: &str) -> String {
    if base_hint.is_empty() {
        SANDBOX_BYPASS_HINT.to_string()
    } else {
        format!("{base_hint}\n{SANDBOX_BYPASS_HINT}")
    }
}

// ==================== 3. 运行中命令注册表 ====================
// 支持前端「终止」按钮（ToolOutput.kill）

/// 跨平台强杀进程树（进程 + 全部后代）。
/// 委托给 `process_tree` 模块：Windows 递归 Toolhelp32 枚举后代逐个 taskkill，
/// Unix 递归 `ps` 枚举后代逐个 kill，不依赖进程树关系 / 进程组。
fn kill_process_tree(pid: u32) {
    crate::agent::process_tree::kill_process_tree(pid);
}

/// 终止器：一键杀整棵进程树（闭包捕获 Job Object / 沙盒 Job 等）。
type Terminator = Arc<dyn Fn() + Send + Sync>;

/// 运行中命令条目：记录子进程 pid、kill 请求标志和终止器
struct RunningCommand {
    pid: u32,
    /// 前端点击「终止」后置位，等待循环检测到后按用户取消处理
    kill_requested: Arc<AtomicBool>,
    /// 终止器：一键杀整棵进程树（无则为 None，仅递归 taskkill 兜底）
    terminator: Option<Terminator>,
}

/// 运行中命令注册表：tool_call_id → RunningCommand
static RUNNING_COMMANDS: LazyLock<Mutex<HashMap<String, RunningCommand>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// 注册一个运行中的命令（run_command_native 内部调用）
fn register_running_command(
    tool_call_id: &str,
    pid: u32,
    terminator: Option<Terminator>,
) -> Arc<AtomicBool> {
    let kill_requested = Arc::new(AtomicBool::new(false));
    RUNNING_COMMANDS.lock().unwrap().insert(
        tool_call_id.to_string(),
        RunningCommand {
            pid,
            kill_requested: kill_requested.clone(),
            terminator,
        },
    );
    kill_requested
}

/// 移除已结束的命令
fn unregister_running_command(tool_call_id: &str) {
    RUNNING_COMMANDS.lock().unwrap().remove(tool_call_id);
}

/// 按 tool_call_id 终止正在运行的命令（前端 ToolOutput.kill 回调调用）
///
/// 返回是否找到并发送了 kill 请求。
pub(crate) fn kill_running_command(tool_call_id: &str) -> bool {
    let entry = {
        let map = RUNNING_COMMANDS.lock().unwrap();
        map.get(tool_call_id)
            .map(|c| (c.pid, c.kill_requested.clone(), c.terminator.clone()))
    };
    if let Some((pid, kill_requested, terminator)) = entry {
        kill_requested.store(true, Ordering::SeqCst);
        // 优先 Job Object 一键全杀；再递归 taskkill 兜底
        if let Some(t) = &terminator {
            t();
        }
        kill_process_tree(pid);
        true
    } else {
        false
    }
}

/// 等待前端「终止」请求（kill_requested 被置位）
async fn wait_for_kill_request(kill_requested: &Arc<AtomicBool>) {
    loop {
        if kill_requested.load(Ordering::SeqCst) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

// ==================== 4. 终端输出处理 ====================

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

// ==================== 5. 统一运行器 ====================

/// 统一运行器（裸跑与沙盒两条路径共用入口）。
///
/// `bypass_sandbox`：调用方已完成用户审批的「不使用沙盒」请求（execute_command 的
/// `sandbox:"off"`）。为 true 时跳过沙盒、直接走下方裸跑路径；典型用途是沙盒下必然
/// 失败的场景：子进程需要用管道 stdio 拉起孙进程（vitest/vite/jest/node-gyp 等），
/// 受限令牌会使那次 spawn 报 EPERM（根因见 AGENTS §11.2）。
pub(super) async fn run_command_native(
    ctx: &NativeToolCtx<'_>,
    cmd_str: &str,
    timeout_secs: i64,
    bypass_sandbox: bool,
) -> Result<NativeToolOutcome, String> {
    use tokio::io::AsyncReadExt;
    use tokio::process::Command;
    use tokio::time::sleep;

    let platform = std::env::consts::OS;
    let is_win = platform == "windows";

    // 三平台：优先走沙盒（OS 级写隔离）。以下三种情况走下方裸跑路径：
    //   1) bypass_sandbox = true（sandbox:"off"，已在 execute_command 侧强制审批）；
    //   2) 沙盒模式为 off；
    //   3) prepare/spawn 失败（降级，见下方 eprintln）。
    let mut sandbox_degraded = false;
    if !bypass_sandbox && sandbox_mode(ctx) != SandboxMode::Off {
        match run_command_sandboxed(ctx, cmd_str, timeout_secs).await {
            Ok(outcome) => return Ok(outcome),
            Err(e) => {
                eprintln!("[sandbox] degraded to bare run: {e}");
                sandbox_degraded = true;
            }
        }
    }

    let (shell, args): (&str, Vec<String>) = if is_win {
        // Windows 统一走 Windows PowerShell 5.1（powershell.exe），不再混用 cmd：
        // 命令按 PowerShell 语法书写（不支持 &&/||，改用 ; 或 if ($LASTEXITCODE)）。
        // 先切到 UTF-8 输出，避免中文系统默认 GBK 使管道输出乱码。
        let prefixed = format!(
            "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; {}",
            cmd_str
        );
        (
            "powershell",
            vec!["-NoProfile".into(), "-Command".into(), prefixed.into()],
        )
    } else if platform == "macos" {
        ("zsh", vec!["-c".into(), cmd_str.into()])
    } else {
        ("sh", vec!["-c".into(), cmd_str.into()])
    };

    let mut cmd = Command::new(shell);
    // Windows 统一为 PowerShell，其 .NET 解析器认得 \" 能正确还原引号，普通 .arg() 即可
    // （不再使用 cmd，故无需 raw_arg 原样透传）。
    cmd.args(&args);
    #[cfg(target_os = "windows")]
    {
        // 隐藏控制台窗口：Windows 上 spawn powershell 默认会弹出黑窗口，
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

    // Windows：创建 Job Object 并把命令进程纳入，之后命令派生的所有后代自动入组。
    // 超时/终止时 TerminateJobObject 一键全杀，不依赖 taskkill /T 的进程树关系
    // （node/npm/python 被 reparent 或脱离树后 /T 会漏杀）。Job 创建/分配失败时
    // 静默回退到 kill_process_tree 的递归枚举兜底。
    let guard = crate::agent::process_tree::ProcessTreeGuard::create();
    if let Some(g) = &guard {
        let _ = g.assign_pid(pid);
    }
    let guard = guard.map(std::sync::Arc::new);

    // 注册到运行中命令表，支持前端「终止」按钮（ToolOutput.kill）
    let terminator: Option<Terminator> = guard
        .clone()
        .map(|g| Arc::new(move || g.terminate()) as Terminator);
    let kill_requested = register_running_command(ctx.tool_call_id, pid, terminator);

    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();

    // 实时输出推送通道：读取任务把 stdout/stderr 数据块发回主任务，
    // 主任务通过 sink 向 JS 推送 `agent:tool-output` 事件（对齐 JS ctx.write → toolOutputStore）
    use tokio::sync::mpsc;
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<(String, String)>(); // (stream, chunk)

    let stdout_tx = out_tx.clone();
    let stderr_tx = out_tx.clone();
    drop(out_tx); // 主任务不再持有发送端，stdout/stderr 任务结束后 out_rx 会自动关闭

    let stdout_handle = tokio::spawn(async move {
        if let Some(mut out) = stdout_pipe {
            let mut buf = Vec::new();
            let mut chunk = vec![0u8; 8192];
            let mut decoder = TerminalDecoder::new();
            loop {
                let n = match out.read(&mut chunk).await {
                    Ok(0) => break,
                    Ok(n) => n,
                    Err(_) => break,
                };
                buf.extend_from_slice(&chunk[..n]);
                let text = decoder.push(&chunk[..n]);
                if !text.is_empty() {
                    let _ = stdout_tx.send(("stdout".to_string(), text));
                }
            }
            let tail = decoder.finish();
            if !tail.is_empty() {
                let _ = stdout_tx.send(("stdout".to_string(), tail));
            }
            decode_output(&buf)
        } else {
            String::new()
        }
    });
    let stderr_handle = tokio::spawn(async move {
        if let Some(mut err) = stderr_pipe {
            let mut buf = Vec::new();
            let mut chunk = vec![0u8; 8192];
            let mut decoder = TerminalDecoder::new();
            loop {
                let n = match err.read(&mut chunk).await {
                    Ok(0) => break,
                    Ok(n) => n,
                    Err(_) => break,
                };
                buf.extend_from_slice(&chunk[..n]);
                let text = decoder.push(&chunk[..n]);
                if !text.is_empty() {
                    let _ = stderr_tx.send(("stderr".to_string(), text));
                }
            }
            let tail = decoder.finish();
            if !tail.is_empty() {
                let _ = stderr_tx.send(("stderr".to_string(), tail));
            }
            decode_output(&buf)
        } else {
            String::new()
        }
    });

    // 等待子进程退出（与超时/取消并行），退出码通过 done 通道回传
    let (done_tx, mut done_rx) = mpsc::unbounded_channel::<Option<i32>>();
    let wait_handle = tokio::spawn(async move {
        let code = child.wait().await.ok().and_then(|s| s.code());
        let _ = done_tx.send(code);
    });

    let mut stdout = String::new();
    let mut stderr = String::new();
    let mut exit_code: Option<Option<i32>> = None;
    let mut out_closed = false;
    let mut got_exit = false;
    let mut killed_by_timeout = false;
    let mut killed_by_user = false;
    let mut timeout_fut = Box::pin(sleep(Duration::from_secs((timeout_secs.max(1)) as u64)));

    loop {
        tokio::select! {
            maybe = out_rx.recv() => {
                match maybe {
                    Some((stream, chunk)) => {
                        if stream == "stdout" {
                            stdout.push_str(&chunk);
                        } else {
                            stderr.push_str(&chunk);
                        }
                        // 实时推送（与 JS `ctx.write(chunk)` 对齐）
                        ctx.sink.emit_raw("agent:tool-output", json!({
                            "sessionId": ctx.session_id,
                            "toolCallId": ctx.tool_call_id,
                            "stream": stream,
                            "chunk": chunk,
                        }));
                    }
                    None => out_closed = true,
                }
            }
            code = done_rx.recv() => {
                exit_code = code;
                got_exit = true;
                // kill 请求已置位：进程退出是 kill 的结果，按用户取消处理，
                // 避免与 done_rx 竞态导致返回「退出码」而非「已取消」。
                if kill_requested.load(Ordering::SeqCst) {
                    killed_by_user = true;
                }
            }
            // 前端「终止」按钮：kill_running_command 已杀进程树，这里按用户取消处理
            _ = wait_for_kill_request(&kill_requested), if !killed_by_timeout && !killed_by_user => {
                killed_by_user = true;
            }
            _ = &mut timeout_fut, if !killed_by_timeout && !killed_by_user => {
                if let Some(g) = &guard {
                    g.terminate();
                }
                kill_process_tree(pid);
                killed_by_timeout = true;
            }
            _ = ctx.cancel.cancelled(), if !killed_by_timeout && !killed_by_user => {
                if let Some(g) = &guard {
                    g.terminate();
                }
                kill_process_tree(pid);
                killed_by_user = true;
            }
        }
        if killed_by_timeout || killed_by_user {
            break;
        }
        // 输出流已全部读取 且 已拿到退出码 → 结束
        if out_closed && got_exit {
            break;
        }
    }

    // 收尾：等待读取任务和 wait 任务结束，拿到完整输出。
    // ⚠️ 被终止/超时/取消后，若进程树没杀干净（如 taskkill 权限不足、detached 子进程仍持有管道），
    // 直接 .await 会无限挂起 → 工具永远不返回，前端「终止」按钮看似失效（命令一直显示运行中）。
    // 因此 kill/超时路径限制等待窗口：3 秒内收不完就补刀强杀并 abort 任务，用已流式收到的输出返回。
    let stdout_abort = stdout_handle.abort_handle();
    let stderr_abort = stderr_handle.abort_handle();
    let wait_abort = wait_handle.abort_handle();
    let stdout_final;
    let stderr_final;
    if killed_by_user || killed_by_timeout {
        let cleanup = async {
            let so = stdout_handle.await;
            let se = stderr_handle.await;
            let _ = wait_handle.await;
            (so, se)
        };
        match tokio::time::timeout(Duration::from_secs(3), cleanup).await {
            Ok((so, se)) => {
                stdout_final = so.unwrap_or_default();
                stderr_final = se.unwrap_or_default();
            }
            Err(_) => {
                // 进程还活着：Job Object 补刀 + 再强杀，然后 abort 读取/等待任务，避免任务泄漏
                if let Some(g) = &guard {
                    g.terminate();
                }
                kill_process_tree(pid);
                stdout_abort.abort();
                stderr_abort.abort();
                wait_abort.abort();
                stdout_final = String::new();
                stderr_final = String::new();
            }
        }
    } else {
        stdout_final = stdout_handle.await.unwrap_or_default();
        stderr_final = stderr_handle.await.unwrap_or_default();
        let _ = wait_handle.await;
    }
    if !stdout_final.is_empty() {
        stdout = stdout_final;
    }
    if !stderr_final.is_empty() {
        stderr = stderr_final;
    }
    // 移除运行中命令注册
    unregister_running_command(ctx.tool_call_id);
    let exit_code = if killed_by_timeout || killed_by_user {
        None
    } else {
        exit_code.flatten()
    };

    let env_note = {
        let mode = if bypass_sandbox {
            "无沙盒（用户已批准绕过沙盒，完整权限）"
        } else if sandbox_mode(ctx) == SandboxMode::Off {
            "无沙盒（已关闭，完整权限）"
        } else if sandbox_degraded {
            "无沙盒（沙盒不可用，已降级，完整权限）"
        } else {
            "无沙盒（完整权限）"
        };
        format!("终端环境: {shell} · {mode}")
    };

    Ok(build_command_result(
        stdout,
        stderr,
        exit_code,
        killed_by_user,
        killed_by_timeout,
        timeout_secs,
        &env_note,
    ))
}

/// 组装命令执行结果（裸跑与沙盒两条路径共用）。`env_note` 为首行环境提示。
fn build_command_result(
    stdout: String,
    stderr: String,
    exit_code: Option<i32>,
    killed_by_user: bool,
    killed_by_timeout: bool,
    timeout_secs: i64,
    env_note: &str,
) -> NativeToolOutcome {
    let mut result = String::new();
    if !env_note.is_empty() {
        result.push_str(env_note);
        result.push('\n');
    }
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
            return NativeToolOutcome::Error(out);
        }
    }

    NativeToolOutcome::Value {
        content: out,
        ui_data: Some(json!({
            "stdout": stdout,
            "stderr": stderr,
            "exitCode": exit_code,
        })),
    }
}

/// 终端沙盒运行模式。
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum SandboxMode {
    On,
    Off,
    Readonly,
}

/// 解析当前沙盒模式：环境变量 VIRLEN_SANDBOX 优先（临时覆盖），
/// 否则回退到 security.sandbox_mode（默认 on）。
pub(super) fn sandbox_mode(ctx: &NativeToolCtx<'_>) -> SandboxMode {
    if let Ok(v) = std::env::var("VIRLEN_SANDBOX") {
        match v.to_ascii_lowercase().as_str() {
            "off" | "0" | "false" => return SandboxMode::Off,
            "readonly" | "ro" => return SandboxMode::Readonly,
            "on" | "1" | "true" => return SandboxMode::On,
            _ => {}
        }
    }
    match ctx.security.sandbox_mode.to_ascii_lowercase().as_str() {
        "off" | "0" | "false" => SandboxMode::Off,
        "readonly" | "ro" => SandboxMode::Readonly,
        _ => SandboxMode::On,
    }
}

/// 展开路径中的环境变量占位符：%VAR%（Windows）与 ~（Unix）。
fn expand_env_vars(path: &str) -> PathBuf {
    let s = path.replace('\\', "/");
    // Unix：展开 ~ 为用户主目录。
    let s = if s == "~" || s.starts_with("~/") {
        std::env::var("HOME")
            .map(|h| format!("{}{}", h, &s[1..]))
            .unwrap_or(s)
    } else {
        s
    };
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '%' {
            if let Some(j) = (i + 1..chars.len()).position(|k| chars[k] == '%') {
                let name: String = chars[i + 1..i + 1 + j].iter().collect();
                let val = std::env::var(&name).unwrap_or_else(|_| format!("%{name}%"));
                out.push_str(&val.replace('\\', "/"));
                i += j + 2;
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    PathBuf::from(out)
}

/// 从 whitelist 收集终端可写根（M6 映射）。
///
/// 规则：
///   1. 展开 %VAR%/~ 环境变量占位符；
///   2. 跳过 skills_dir（只读，走 protect）；
///   3. 只保留「存在且是目录」的路径（不存在的跳过，避免 prepare 失败降级）；
///   4. 跳过「包含 workspace 的祖先目录」——workspace 本身已是写根，祖先目录会把
///      整个父目录变成终端可写，破坏写隔离（如 whitelist 默认含 Documents，
///      而 workspace 是 Documents/test/demo 时，绝不能让 demo2 也变得可写）。
fn collect_extra_roots(
    whitelist: &[String],
    workspace: &str,
    skills_dir: Option<&str>,
) -> Vec<PathBuf> {
    let workspace_path = PathBuf::from(workspace);
    let mut extra_roots: Vec<PathBuf> = Vec::new();
    for w in whitelist {
        let p = expand_env_vars(w);
        if let Some(sd) = skills_dir {
            if crate::sandbox::paths::same_path_key(p.as_path(), std::path::Path::new(sd)) {
                continue;
            }
        }
        if !p.is_dir() {
            continue;
        }
        if crate::sandbox::paths::root_contains_path(p.as_path(), workspace_path.as_path()) {
            continue;
        }
        extra_roots.push(p);
    }
    extra_roots
}

async fn run_command_sandboxed(
    ctx: &NativeToolCtx<'_>,
    cmd_str: &str,
    timeout_secs: i64,
) -> Result<NativeToolOutcome, String> {
    use std::io::Read;
    use tokio::sync::mpsc;
    use tokio::time::sleep;

    // 1) 选择 shell（平台自适应）。
    // 注意：Windows 沙盒进程运行在受限令牌下，PowerShell 会进入约束语言模式（CLM），
    // `[Console]::OutputEncoding = ...` 这类属性设置会被拒绝，因此这里**不**加 UTF-8 前缀，
    // 中文输出靠 decode_output 的 GBK 兜底解码（与裸跑路径的 UTF-8 前缀不同）。
    #[cfg(target_os = "windows")]
    let (shell, args, raw_cmdline): (&str, Vec<String>, Option<String>) = (
        "powershell",
        vec!["-NoProfile".into(), "-Command".into(), cmd_str.to_string()],
        None,
    );
    #[cfg(target_os = "macos")]
    let (shell, args, raw_cmdline): (&str, Vec<String>, Option<String>) =
        ("zsh", vec!["-c".into(), cmd_str.to_string()], None);
    #[cfg(target_os = "linux")]
    let (shell, args, raw_cmdline): (&str, Vec<String>, Option<String>) =
        ("sh", vec!["-c".into(), cmd_str.to_string()], None);

    // 2) 构建沙盒请求
    //    写根 = workspace + whitelist 中「存在且是目录」的可写目录（排除 skills_dir）；
    //    保护 = skills_dir（deny-write）；.git/.hg/.svn/.codex/.agents 由 prepare 默认保护。
    //    whitelist 可能含 %VAR% 占位符或已失效路径，逐条展开并过滤，避免单条失败导致整体降级。
    let readonly_mode = sandbox_mode(ctx) == SandboxMode::Readonly;
    let skills_dir = ctx.security.skills_dir.clone();
    let mut extra_roots = if readonly_mode {
        // readonly 模式不授予任何写根（whitelist 也不映射为可写根），否则 prepare 会因
        // 「readonly + extra_roots」冲突而失败 → 静默降级裸跑，丧失只读保护。
        Vec::new()
    } else {
        collect_extra_roots(&ctx.security.whitelist, &ctx.security.workspace, skills_dir.as_deref())
    };
    // 包管理器缓存目录自动豁免：npm/pnpm/cargo 等安装命令会先写用户级缓存目录
    // （~/.npm、pnpm store、~/.cargo…）再复制到 workspace 的 node_modules，默认写隔离
    // 会拦截（表现为 `npm install` EACCES/EPERM mkdir cache）。动态探测真实缓存目录并
    // 加入可写根，对齐 Claude Code sandbox.filesystem.allowWrite / Codex writable_roots
    // 的做法。readonly 模式不授予任何额外写根；workspace 祖先/已覆盖目录在模块内过滤。
    // 探测可能含子进程等待（npm/pnpm config），放 spawn_blocking 避免阻塞 async runtime。
    if !readonly_mode && !ctx.security.workspace.is_empty() {
        let ws_path = PathBuf::from(&ctx.security.workspace);
        let existing = extra_roots.clone();
        let cache_roots = tokio::task::spawn_blocking(move || {
            crate::agent::package_cache_roots::cache_roots_for_workspace(&ws_path, &existing)
        })
        .await
        .unwrap_or_else(|e| {
            // 缓存探测是 best-effort 增强：失败（含闭包内 panic / 锁中毒）不应让整条命令失败，
            // 静默降级为「不追加缓存根」，沙盒仍按 workspace + whitelist 正常启动。
            eprintln!("[sandbox] package cache roots probe failed, skipping: {e}");
            Vec::new()
        });
        extra_roots.extend(cache_roots);
    }
    let mut protect: Vec<PathBuf> = Vec::new();
    if let Some(sd) = &skills_dir {
        let sp = PathBuf::from(sd);
        if sp.exists() {
            protect.push(sp);
        }
    }

    let req = crate::sandbox::SandboxRequest {
        cwd: PathBuf::from(&ctx.security.workspace),
        extra_roots,
        protect,
        readonly: readonly_mode,
    };
    let state = crate::sandbox::state::SandboxState::from_default_or(None)
        .map_err(|e| format!("sandbox state init failed: {e}"))?;
    let session = crate::sandbox::SandboxSession::prepare(&req, &state)
        .map_err(|e| format!("sandbox prepare failed: {e}"))?;

    // 3) 环境变量（与裸跑路径一致）
    let mut env_extra = BTreeMap::new();
    env_extra.insert("PYTHONIOENCODING".to_string(), "utf-8".to_string());
    if let Some(skills_dir) = &ctx.security.skills_dir {
        env_extra.insert("SKILL_ROOT".to_string(), skills_dir.clone());
    }

    // 4) spawn（受限令牌 + CreateProcessAsUserW）
    let command_argv: Vec<String> = std::iter::once(shell.to_string())
        .chain(args.iter().cloned())
        .collect();
    let child = match session.spawn(&command_argv, raw_cmdline.as_deref(), &env_extra) {
        Ok(c) => {
            crate::telemetry::track(
                "rust.sandbox.spawn",
                json!({
                    "tool_name": "execute_command",
                    "sandbox_mode": if readonly_mode { "readonly" } else { "on" },
                    "status": "success",
                }),
            );
            c
        }
        Err(e) => {
            crate::telemetry::track(
                "rust.sandbox.spawn",
                json!({
                    "tool_name": "execute_command",
                    "sandbox_mode": if readonly_mode { "readonly" } else { "on" },
                    "status": "fail",
                    "error": format!("sandbox spawn failed: {e}"),
                }),
            );
            return Err(format!("sandbox spawn failed: {e}"));
        }
    };
    // token 已不再需要，尽早关闭（也避免 HANDLE 跨 await）。
    drop(session);

    let mut child = child;
    let pid = child.pid();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let child = Arc::new(child);

    // 注册到运行中命令表，支持前端「终止」按钮
    let child_for_kill = child.clone();
    let terminator: Option<Terminator> = Some(Arc::new(move || child_for_kill.terminate()));
    let kill_requested = register_running_command(ctx.tool_call_id, pid, terminator);

    // 5) 实时输出：管道读端在 spawn_blocking 线程里阻塞 read，经 mpsc 回传
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<(String, String)>();
    let stdout_tx = out_tx.clone();
    let stderr_tx = out_tx.clone();
    drop(out_tx);

    let stdout_handle = tokio::task::spawn_blocking(move || {
        if let Some(mut out) = stdout {
            let mut buf = Vec::new();
            let mut chunk = vec![0u8; 8192];
            let mut decoder = TerminalDecoder::new();
            loop {
                let n = match out.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(n) => n,
                    Err(_) => break,
                };
                buf.extend_from_slice(&chunk[..n]);
                let text = decoder.push(&chunk[..n]);
                if !text.is_empty() {
                    let _ = stdout_tx.send(("stdout".to_string(), text));
                }
            }
            let tail = decoder.finish();
            if !tail.is_empty() {
                let _ = stdout_tx.send(("stdout".to_string(), tail));
            }
            decode_output(&buf)
        } else {
            String::new()
        }
    });
    let stderr_handle = tokio::task::spawn_blocking(move || {
        if let Some(mut err) = stderr {
            let mut buf = Vec::new();
            let mut chunk = vec![0u8; 8192];
            let mut decoder = TerminalDecoder::new();
            loop {
                let n = match err.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(n) => n,
                    Err(_) => break,
                };
                buf.extend_from_slice(&chunk[..n]);
                let text = decoder.push(&chunk[..n]);
                if !text.is_empty() {
                    let _ = stderr_tx.send(("stderr".to_string(), text));
                }
            }
            let tail = decoder.finish();
            if !tail.is_empty() {
                let _ = stderr_tx.send(("stderr".to_string(), tail));
            }
            decode_output(&buf)
        } else {
            String::new()
        }
    });

    // 6) 等待退出
    let (done_tx, mut done_rx) = mpsc::unbounded_channel::<Option<i32>>();
    let wait_child = child.clone();
    let wait_handle = tokio::task::spawn_blocking(move || {
        let code = wait_child.wait_and_read_exit_code();
        let _ = done_tx.send(code);
    });

    let mut stdout = String::new();
    let mut stderr = String::new();
    let mut exit_code: Option<Option<i32>> = None;
    let mut out_closed = false;
    let mut got_exit = false;
    let mut killed_by_timeout = false;
    let mut killed_by_user = false;
    // 超时计时器必须在循环外创建并固定，否则 select! 每轮都会新建 sleep，
    // 输出一刷屏就把计时归零，导致超时永远不触发。
    let mut timeout_fut = Box::pin(sleep(Duration::from_secs((timeout_secs.max(1)) as u64)));

    loop {
        tokio::select! {
            maybe = out_rx.recv() => {
                match maybe {
                    Some((stream, chunk)) => {
                        if stream == "stdout" {
                            stdout.push_str(&chunk);
                        } else {
                            stderr.push_str(&chunk);
                        }
                        ctx.sink.emit_raw("agent:tool-output", json!({
                            "sessionId": ctx.session_id,
                            "toolCallId": ctx.tool_call_id,
                            "stream": stream,
                            "chunk": chunk,
                        }));
                    }
                    None => out_closed = true,
                }
            }
            code = done_rx.recv() => {
                exit_code = code;
                got_exit = true;
                // kill 请求已置位：进程退出是 kill 的结果，按用户取消处理，
                // 避免与 done_rx 竞态导致返回「退出码」而非「已取消」。
                if kill_requested.load(Ordering::SeqCst) {
                    killed_by_user = true;
                }
            }
            _ = wait_for_kill_request(&kill_requested), if !killed_by_timeout && !killed_by_user => {
                killed_by_user = true;
            }
            _ = &mut timeout_fut, if !killed_by_timeout && !killed_by_user => {
                child.terminate();
                kill_process_tree(pid);
                killed_by_timeout = true;
            }
            _ = ctx.cancel.cancelled(), if !killed_by_timeout && !killed_by_user => {
                child.terminate();
                kill_process_tree(pid);
                killed_by_user = true;
            }
        }
        if killed_by_timeout || killed_by_user {
            break;
        }
        if out_closed && got_exit {
            break;
        }
    }

    let stdout_abort = stdout_handle.abort_handle();
    let stderr_abort = stderr_handle.abort_handle();
    let wait_abort = wait_handle.abort_handle();
    let stdout_final;
    let stderr_final;
    if killed_by_user || killed_by_timeout {
        let cleanup = async {
            let so = stdout_handle.await;
            let se = stderr_handle.await;
            let _ = wait_handle.await;
            (so, se)
        };
        match tokio::time::timeout(Duration::from_secs(3), cleanup).await {
            Ok((so, se)) => {
                stdout_final = so.unwrap_or_default();
                stderr_final = se.unwrap_or_default();
            }
            Err(_) => {
                child.terminate();
                kill_process_tree(pid);
                stdout_abort.abort();
                stderr_abort.abort();
                wait_abort.abort();
                stdout_final = String::new();
                stderr_final = String::new();
            }
        }
    } else {
        stdout_final = stdout_handle.await.unwrap_or_default();
        stderr_final = stderr_handle.await.unwrap_or_default();
        let _ = wait_handle.await;
    }
    if !stdout_final.is_empty() {
        stdout = stdout_final;
    }
    if !stderr_final.is_empty() {
        stderr = stderr_final;
    }
    unregister_running_command(ctx.tool_call_id);
    let exit_code = if killed_by_timeout || killed_by_user {
        None
    } else {
        exit_code.flatten()
    };

    let env_note = if readonly_mode {
        format!("终端环境: {shell} · 只读（不可写）")
    } else if ctx.security.workspace.is_empty() {
        format!("终端环境: {shell} · 写隔离")
    } else {
        format!(
            "终端环境: {shell} · 写隔离（可写根: {}；区外写入会被拒绝）",
            ctx.security.workspace
        )
    };

    Ok(build_command_result(
        stdout,
        stderr,
        exit_code,
        killed_by_user,
        killed_by_timeout,
        timeout_secs,
        &env_note,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(target_os = "windows")]
    fn test_expand_env_vars() {
        std::env::set_var("VIRLEN_TEST_VAR", "C:/foo/bar");
        assert_eq!(
            expand_env_vars("%VIRLEN_TEST_VAR%/baz"),
            PathBuf::from("C:/foo/bar/baz")
        );
        // 反斜杠统一为斜杠
        assert_eq!(
            expand_env_vars("%VIRLEN_TEST_VAR%\\baz"),
            PathBuf::from("C:/foo/bar/baz")
        );
        // 无法解析的占位符保持原样
        assert_eq!(
            expand_env_vars("%NO_SUCH_VAR_XYZ%/x"),
            PathBuf::from("%NO_SUCH_VAR_XYZ%/x")
        );
        // 无占位符：分隔符归一化
        assert_eq!(expand_env_vars("C:\\work"), PathBuf::from("C:/work"));
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn test_collect_extra_roots_skips_workspace_ancestor() {
        let base = std::env::temp_dir().join(format!(
            "virlen-extra-root-test-{}",
            std::process::id()
        ));
        let ws = base.join("Documents").join("test").join("demo");
        let docs = base.join("Documents");
        let sibling = base.join("sibling");
        std::fs::create_dir_all(&ws).expect("create ws");
        std::fs::create_dir_all(&sibling).expect("create sibling");

        let whitelist = vec![
            docs.to_string_lossy().to_string(), // workspace 祖先 → 跳过
            base.join("does-not-exist").to_string_lossy().to_string(), // 不存在 → 跳过
            sibling.to_string_lossy().to_string(), // 普通目录 → 保留
        ];
        let roots = collect_extra_roots(&whitelist, ws.to_string_lossy().as_ref(), None);
        assert_eq!(roots.len(), 1, "应只保留 sibling");
        assert!(crate::sandbox::paths::same_path_key(&roots[0], &sibling));

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn test_decode_output() {
        // UTF-8 原样
        assert_eq!(decode_output("后面杂音.wav".as_bytes()), "后面杂音.wav");
        // GBK 字节（CP936）→ 正确解码（中文 Windows PowerShell 管道输出的典型情况）
        let gbk = "后面杂音.wav";
        let (gbk_bytes, _, _) = encoding_rs::GBK.encode(gbk);
        assert_eq!(decode_output(&gbk_bytes), gbk);
        // ASCII 不变
        assert_eq!(decode_output(b"Name : 979244"), "Name : 979244");
        // 空
        assert_eq!(decode_output(b""), "");
    }

    #[test]
    fn test_terminal_decoder_utf8_split() {
        // 模拟 UTF-8 多字节字符被 8KB 分块切断（最极端：逐字节喂入），应正确还原
        let text = "a后面杂音b";
        let bytes = text.as_bytes();
        let mut d = TerminalDecoder::new();
        let mut out = String::new();
        for i in 0..bytes.len() {
            out.push_str(&d.push(&bytes[i..i + 1]));
        }
        out.push_str(&d.finish());
        assert_eq!(out, text);
    }

    #[test]
    fn test_terminal_decoder_gbk_chunks() {
        // GBK 输出按完整双字节块喂入（8KB 分块不会拆开字符的常见情况）
        let gbk_text = "后面杂音.wav";
        let (gbk_bytes, _, _) = encoding_rs::GBK.encode(gbk_text);
        let gbk_bytes = gbk_bytes.into_owned();
        let mut d = TerminalDecoder::new();
        let mut out = String::new();
        for i in (0..gbk_bytes.len()).step_by(2) {
            let end = (i + 2).min(gbk_bytes.len());
            out.push_str(&d.push(&gbk_bytes[i..end]));
        }
        out.push_str(&d.finish());
        assert_eq!(out, gbk_text);
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
}
