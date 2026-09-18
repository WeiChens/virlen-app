//! execute — 代码执行分类公共模块（分类 id: execute）
//!
//! 供本分类下的 `execute_command` / `execute_script` 复用：
//!   1. 终端输出解码（UTF-8 优先、GBK 兜底；跨 8KB 分块安全）
//!   2. 命令解析与风险分类（safe | install | dangerous）+ 风险文案
//!   3. 运行中命令注册表（前端 ToolOutput.kill → 终止整棵进程树）
//!   4. 终端输出处理（\r 覆盖 / ANSI 转义序列）
//!   5. 统一运行器 run_command_native（沙盒优先，失败降级裸跑；`bypass_sandbox` 时直接裸跑）

use crate::agent::native_tools::{NativeToolCtx, NativeToolOutcome};
use serde_json::{json, Value};

use super::pty_session;
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

/// 单条流的内存上限（1 MB）与截断后保留的末尾长度（256 KB）。
///
/// 目的：让 `yes` / `cat 大文件` 这类命令打不爆内存（`docs/pty-research.md` §6.2）。
/// 「会话日志 append-only 落盘 + 内存只留有界 tail cache」的完整方案属于后续阶段，
/// 这里先做「有界 + 提示」这一步。
const STREAM_CAP: usize = 1024 * 1024;
const STREAM_KEEP: usize = 256 * 1024;
/// 发生截断时插在输出开头的提示。
const STREAM_TRUNCATED_NOTE: &str = "（输出过长，早期内容已丢弃）\n";

/// Step 2 ④：判定「超时前全程几乎无输出」的输出上限（trim 后字符数）。
///
/// 低于此值即认为命令卡在等待输入（密码 / `y/n` / REPL）——这是 PTY 交互场景里
/// 最常见的超时原因，值得在结果里显式引导模型（与管道路径同样适用，见 D5）。
const TIMEOUT_IDLE_HINT_MAX_OUTPUT: usize = 16;

/// 超时且全程无输出时追加到结果末尾的引导文案（面向模型，非 i18n）。
const TIMEOUT_IDLE_HINT: &str = "（该命令在超时前几乎没有产生输出，通常意味着它在等待输入：密码 / y/n 确认 / REPL。\
可让用户直接在终端中键击输入，或适当放宽超时时间。）";

/// ② 超时预算的心跳周期（接管冻结 / 预算扣减都按它推进，Step 2 ②）。
const TICK: Duration = Duration::from_millis(250);

/// ② 接管硬上限（对齐 WinkTerm 的 TTL，决策点 D3）：接管**不等于**无限期挂起。
const PTY_HOLD_MAX: Duration = Duration::from_secs(30 * 60);

/// ② 取接管上限。单测用 `HOLD_MAX_OVERRIDE_SECS` 缩短，避免真等 30 分钟。
fn pty_hold_max() -> Duration {
    #[cfg(test)]
    {
        let secs = HOLD_MAX_OVERRIDE_SECS.load(Ordering::SeqCst);
        if secs > 0 {
            return Duration::from_secs(secs);
        }
    }
    PTY_HOLD_MAX
}

/// 仅测试用：可注入的接管上限（秒；0 = 用默认 `PTY_HOLD_MAX`）。
#[cfg(test)]
static HOLD_MAX_OVERRIDE_SECS: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);

/// 有界追加**文本**：超过 `STREAM_CAP` 后丢弃最早的部分，只保留末尾 `STREAM_KEEP` 字节，
/// 并在开头插入一次截断提示。按 UTF-8 边界对齐，避免把多字节字符切成两半。
fn push_bounded(buf: &mut String, chunk: &str) {
    buf.push_str(chunk);
    if buf.len() <= STREAM_CAP {
        return;
    }
    let mut cut = buf.len() - STREAM_KEEP;
    while cut < buf.len() && !buf.is_char_boundary(cut) {
        cut += 1;
    }
    let tail = buf[cut..].to_string();
    buf.clear();
    buf.push_str(STREAM_TRUNCATED_NOTE);
    buf.push_str(&tail);
}

/// 有界追加**原始字节**（读线程用，末尾整体解码）。返回是否发生了截断。
///
/// 这里按字节切、不保证 UTF-8 边界 —— 被切碎的字符最坏会多出一个替换字符，
/// 而被截断的输出本来就不是完整内容，可以接受。
fn push_bytes_bounded(buf: &mut Vec<u8>, chunk: &[u8]) -> bool {
    buf.extend_from_slice(chunk);
    if buf.len() <= STREAM_CAP {
        return false;
    }
    let cut = buf.len() - STREAM_KEEP;
    buf.drain(..cut);
    true
}

/// 解码读线程的原始字节缓冲；被截断过时在开头插入提示。
fn decode_tail(buf: &[u8], truncated: bool) -> String {
    let text = decode_output(buf);
    if truncated {
        format!("{STREAM_TRUNCATED_NOTE}{text}")
    } else {
        text
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
        } else if ch == '\x1b' && i + 1 < chars.len() {
            // ---- ANSI 转义序列：必须**完整吞掉**，否则参数会被当成正文写进输出 ----
            // 改造前只认 `ESC [` 且只吃 0-9;，于是 `\x1b[?25l`（隐藏光标）这类私有模式的
            // 参数会被漏成正文（"25l"）。ConPTY 输出的这类序列非常密集（§6.2 / §7 #9），
            // 因此这里按 ECMA-48 完整解析：参数字节 + 中间字节 + 结束字节。
            let kind = chars[i + 1];
            if kind == '[' {
                // CSI: ESC [ 0x30-0x3F(参数) 0x20-0x2F(中间) 0x40-0x7E(结束)
                let mut j = i + 2;
                let mut params = String::new();
                while j < chars.len()
                    && matches!(chars[j], '0'..='9' | ';' | ':' | '<' | '=' | '>' | '?')
                {
                    params.push(chars[j]);
                    j += 1;
                }
                // 中间字节（空格、!、"、#、$、%、&、'、*、+、-、.、/）不属于参数，跳过
                while j < chars.len() && (' '..='/').contains(&chars[j]) {
                    j += 1;
                }
                let cmd = if j < chars.len() { chars[j] } else { ' ' };
                i = (j + 1).min(chars.len());
                // 带 ? < = > 前缀的是私有模式（DECSET/DECRST 等）→ 忽略，但必须已整体吞掉
                let private = params.starts_with(['?', '<', '=', '>']);
                let num_str = params.trim_start_matches(['?', '<', '=', '>']);
                let num: usize = num_str
                    .split(';')
                    .next()
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(1);
                if !private {
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
                        'H' | 'f' => {
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
                        // 'X'（擦除 n 个字符，光标不动）、'm'（颜色/样式）等对纯文本无影响
                        _ => {}
                    }
                }
            } else if kind == ']' {
                // OSC: ESC ] ... 由 BEL 或 ST(ESC \) 结束 —— 典型是改窗口标题 `\x1b]0;…\x07`
                let mut j = i + 2;
                while j < chars.len() {
                    if chars[j] == '\x07' {
                        j += 1;
                        break;
                    }
                    if chars[j] == '\x1b' && j + 1 < chars.len() && chars[j + 1] == '\\' {
                        j += 2;
                        break;
                    }
                    j += 1;
                }
                i = j.min(chars.len());
            } else if (' '..='/').contains(&kind) {
                // 带中间字节的**三字节**转义（ESC ( 0 切字符集 / ESC # 8 / ESC % G 等）
                i = (i + 3).min(chars.len());
            } else {
                // 两字符转义（ESC 7 保存光标 / ESC = 等）
                i = (i + 2).min(chars.len());
            }
        } else if ch == '\u{8}' {
            // 退格：光标左移一格（ConPTY 的擦除/重绘里会出现）
            col = col.saturating_sub(1);
            i += 1;
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

/// 伪控制台当前是否可用（Step 2 ①：决定「终端内确认」是否走终端呈现）。
///
/// 试建一个伪控制台再立即丢弃 —— 判定与真正执行时一致（同一 API / 同一令牌与环境）。
/// 不可用时 Rust **不下发** `presentation:"terminal"`，前端自动回落现有审批弹窗
/// （语义不变，降级可见）。非 Windows 平台无 PTY → 恒 false。
pub(super) fn pty_available() -> bool {
    #[cfg(target_os = "windows")]
    {
        use crate::sandbox::pty::{PseudoConsole, DEFAULT_COLS, DEFAULT_ROWS};
        // 试建成功即可；PseudoConsole 的 Drop 会关掉它，不留句柄。
        PseudoConsole::create(DEFAULT_COLS, DEFAULT_ROWS).is_ok()
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

/// 统一运行器 —— 平台分发入口。
///
/// - **Windows**：走 ConPTY 路径（`run_command_native_pty`）。命令在伪控制台里跑，于是
///   ANSI/中文输出正确、交互式提示可用、用户可经 `pty_write` 中途插键盘（Step 1 的全部收益）。
///   伪控制台不可用时降级回匿名管道路径。
/// - **其他平台**：仍走匿名管道路径（Unix PTY 留待后续，见 docs/pty-research.md §8）。
///
/// `bypass_sandbox`：调用方已完成用户审批的「不使用沙盒」请求（execute_command 的
/// `sandbox:"off"`）。为 true 时跳过沙盒、直接走裸跑路径；典型用途是沙盒下必然
/// 失败的场景：子进程需要用管道 stdio 拉起孙进程（vitest/vite/jest/node-gyp 等），
/// 受限令牌会使那次 spawn 报 EPERM（根因见 AGENTS §11.2）。
///
/// `pub(crate)`：除工具层外，TS 引擎路径经 `pty_run_command` 也复用本运行器（§7 #14）。
pub(crate) async fn run_command_native(
    ctx: &NativeToolCtx<'_>,
    cmd_str: &str,
    timeout_secs: i64,
    bypass_sandbox: bool,
) -> Result<NativeToolOutcome, String> {
    #[cfg(target_os = "windows")]
    {
        return run_command_native_pty(ctx, cmd_str, timeout_secs, bypass_sandbox).await;
    }
    #[cfg(not(target_os = "windows"))]
    {
        run_command_native_pipes(ctx, cmd_str, timeout_secs, bypass_sandbox).await
    }
}

/// 匿名管道运行器（改造前的实现）。
///
/// 保留为**两条用途**：非 Windows 平台的主路径、Windows 上伪控制台不可用时的降级兜底。
async fn run_command_native_pipes(
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
            let mut raw: Vec<u8> = Vec::new();
            let mut truncated = false;
            let mut chunk = vec![0u8; 8192];
            let mut decoder = TerminalDecoder::new();
            loop {
                let n = match out.read(&mut chunk).await {
                    Ok(0) => break,
                    Ok(n) => n,
                    Err(_) => break,
                };
                truncated |= push_bytes_bounded(&mut raw, &chunk[..n]);
                let text = decoder.push(&chunk[..n]);
                if !text.is_empty() {
                    let _ = stdout_tx.send(("stdout".to_string(), text));
                }
            }
            let tail = decoder.finish();
            if !tail.is_empty() {
                let _ = stdout_tx.send(("stdout".to_string(), tail));
            }
            decode_tail(&raw, truncated)
        } else {
            String::new()
        }
    });
    let stderr_handle = tokio::spawn(async move {
        if let Some(mut err) = stderr_pipe {
            let mut raw: Vec<u8> = Vec::new();
            let mut truncated = false;
            let mut chunk = vec![0u8; 8192];
            let mut decoder = TerminalDecoder::new();
            loop {
                let n = match err.read(&mut chunk).await {
                    Ok(0) => break,
                    Ok(n) => n,
                    Err(_) => break,
                };
                truncated |= push_bytes_bounded(&mut raw, &chunk[..n]);
                let text = decoder.push(&chunk[..n]);
                if !text.is_empty() {
                    let _ = stderr_tx.send(("stderr".to_string(), text));
                }
            }
            let tail = decoder.finish();
            if !tail.is_empty() {
                let _ = stderr_tx.send(("stderr".to_string(), tail));
            }
            decode_tail(&raw, truncated)
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
                            push_bounded(&mut stdout, &chunk);
                        } else {
                            push_bounded(&mut stderr, &chunk);
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
        false, // 管道路径：stdout/stderr 分流，不是 PTY
        None,  // 管道路径无 PTY 会话 → 无干预摘要
        false,
    ))
}

/// ConPTY 运行器（Windows）—— 命令在一个伪控制台里跑。
///
/// 与管道路径的关键差异（均已实测，见 `docs/pty-research.md` §5）：
///   1. stdout/stderr **合并**为一条 VT 流（伪控制台只有一条输出通道）；
///   2. 通信通道必须是**同步** I/O，所以读线程走 `spawn_blocking` + 阻塞 `Read`；
///   3. **结束判定不能用「输出通道 EOF」**：输出管道要等 `ClosePseudoConsole` 之后才断开
///      （Spike 实测），因此主循环以「进程退出」为结束条件，收尾时先关伪控制台再等读线程；
///   4. 输出严格为 UTF-8（中文直接可读）→ §11.1 的 GBK 兜底在 PTY 路径上几乎不触发。
///
/// ⚠️ 已知语义变化：`ClosePseudoConsole` 会终止仍附着在伪控制台上的进程，因此
/// **裸跑路径下 `start` 之类拉起的后台进程不再存活**（沙盒路径本来就会杀，见 windows/mod.rs）。
#[cfg(target_os = "windows")]
async fn run_command_native_pty(
    ctx: &NativeToolCtx<'_>,
    cmd_str: &str,
    timeout_secs: i64,
    bypass_sandbox: bool,
) -> Result<NativeToolOutcome, String> {
    use crate::sandbox::pty::{
        create_bare_process_pty, current_env, PseudoConsole, DEFAULT_COLS, DEFAULT_ROWS,
        INTERACTIVE_DESKTOP,
    };
    use std::io::Read;
    use tokio::sync::mpsc;

    // 1) 伪控制台。建不起来就降级回匿名管道（保留改造前的实现作兜底）。
    //
    // 初始尺寸优先用「最近一次客户端上报的尺寸」：若与客户端实际尺寸一致，前端随后的
    // `pty_resize` 就是 no-op，ConPTY 不会重绘、也就不会在内容下方补出多余空行
    // （见 pty_session::SizeTracker 与 docs/pty-research.md §5.7）。
    //
    // ⚠️ `initial_size` 会在缓存为空时**短暂等待**客户端上报（最多 ~800ms）——
    // 这是 TS 引擎路径的关键：`pty_run_command` 往往先于终端挂载，不等待就会用 240×50
    // 建控制台，首帧按 50 行铺满 → 一大堆空行（见 §5.7.2）。
    let (init_cols, init_rows) = pty_session::initial_size((DEFAULT_COLS, DEFAULT_ROWS)).await;
    let mut pty = match PseudoConsole::create(init_cols, init_rows) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[pty] CreatePseudoConsole unavailable, degraded to pipes: {e}");
            return run_command_native_pipes(ctx, cmd_str, timeout_secs, bypass_sandbox).await;
        }
    };

    // 2) 沙盒优先（prepare 失败 → 降级裸跑，与管道路径的降级规则一致）
    let sandbox_requested = !bypass_sandbox && sandbox_mode(ctx) != SandboxMode::Off;
    let mut sandbox_degraded = false;
    let mut session = if sandbox_requested {
        match prepare_sandbox_session(ctx).await {
            Ok(s) => Some(s),
            Err(e) => {
                eprintln!("[sandbox] degraded to bare run: {e}");
                sandbox_degraded = true;
                None
            }
        }
    } else {
        None
    };
    let readonly_mode = sandbox_mode(ctx) == SandboxMode::Readonly;

    // 与管道路径一致的额外环境变量。
    let mut env_extra = BTreeMap::new();
    env_extra.insert("PYTHONIOENCODING".to_string(), "utf-8".to_string());
    if let Some(skills_dir) = &ctx.security.skills_dir {
        env_extra.insert("SKILL_ROOT".to_string(), skills_dir.clone());
    }

    // 3) spawn（沙盒优先；沙盒 spawn 失败 → 释放会话，按裸跑重试）
    let shell = "powershell".to_string();
    let mut child = None;
    if let Some(sess) = session.as_ref() {
        // 沙盒内 PowerShell 会进入约束语言模式（CLM），`[Console]::OutputEncoding = ...`
        // 这类属性设置会被拒绝，所以这里**不**加 UTF-8 前缀（中文由伪控制台自身保证 UTF-8）。
        let argv = vec![
            shell.clone(),
            "-NoProfile".to_string(),
            "-Command".to_string(),
            cmd_str.to_string(),
        ];
        let mode = if readonly_mode { "readonly" } else { "on" };
        match sess.spawn_pty(&argv, None, &env_extra, pty.raw_hpc()) {
            Ok(c) => {
                crate::telemetry::track(
                    "rust.sandbox.spawn",
                    json!({
                        "tool_name": "execute_command",
                        "sandbox_mode": mode,
                        "status": "success",
                        "stdio": "pty",
                    }),
                );
                child = Some(c);
            }
            Err(e) => {
                crate::telemetry::track(
                    "rust.sandbox.spawn",
                    json!({
                        "tool_name": "execute_command",
                        "sandbox_mode": mode,
                        "status": "fail",
                        "error": format!("sandbox spawn failed: {e}"),
                        "stdio": "pty",
                    }),
                );
                eprintln!("[sandbox] spawn failed, degraded to bare run: {e}");
                session = None;
                sandbox_degraded = true;
            }
        }
    }
    let ran_sandboxed = session.is_some();
    if child.is_none() {
        // 裸跑：先切 UTF-8 输出（与改造前的裸跑路径一致），中文系统默认 GBK 会乱码。
        let prefixed = format!(
            "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; {}",
            cmd_str
        );
        let argv = vec![
            shell.clone(),
            "-NoProfile".to_string(),
            "-Command".to_string(),
            prefixed,
        ];
        // 裸跑没有沙盒 prepare 提供的 cwd，这里自己解析（workspace 为空则继承当前目录）。
        let cwd = if ctx.security.workspace.is_empty() {
            std::env::current_dir().map_err(|e| format!("[{shell} error] {e}"))?
        } else {
            PathBuf::from(&ctx.security.workspace)
        };
        let mut env = current_env();
        for (k, v) in &env_extra {
            env.insert(k.clone(), v.clone());
        }
        let c =
            create_bare_process_pty(&argv, None, &cwd, &env, INTERACTIVE_DESKTOP, pty.raw_hpc())
                .map_err(|e| format!("[{shell} error] {e}"))?;
        child = Some(c);
    }
    let child = child.expect("child spawned above");
    let pid = child.pid();
    let child = Arc::new(child);
    // 受限令牌只在 spawn 时用得上，尽早释放（与管道路径一致）。
    drop(session.take());

    // 4) 注册「运行中命令」（前端终止按钮）与「PTY 会话」（前端插键盘）
    let child_for_kill = child.clone();
    let terminator: Option<Terminator> = Some(Arc::new(move || child_for_kill.terminate()));
    let kill_requested = register_running_command(ctx.tool_call_id, pid, terminator);
    // 裸跑路径额外挂 ProcessTreeGuard，与管道路径的裸跑语义保持一致。
    let guard = if ran_sandboxed {
        None
    } else {
        crate::agent::process_tree::ProcessTreeGuard::create()
    };
    if let Some(g) = &guard {
        let _ = g.assign_pid(pid);
    }
    let guard = guard.map(Arc::new);
    let pty_session_handle: Option<Arc<pty_session::PtySession>> =
        if let Some(input) = pty.take_input() {
            let session = Arc::new(pty_session::PtySession::new(
                input,
                pty.raw_hpc(),
                init_cols,
                init_rows,
            ));
            pty_session::register(ctx.tool_call_id, session.clone());
            Some(session)
        } else {
            None
        };

    // 5) 输出：管道读端在 spawn_blocking 线程里阻塞 read，经 mpsc 回传
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<(String, String)>();
    // 伪控制台的读端交给独立线程；官方要求每条通道用单独线程服务，避免缓冲区互等死锁。
    let out = pty.take_output();
    let stdout_handle = tokio::task::spawn_blocking(move || {
        let Some(mut out) = out else {
            return String::new();
        };
        let mut tail: Vec<u8> = Vec::new();
        let mut truncated = false;
        let mut chunk = vec![0u8; 8192];
        let mut decoder = TerminalDecoder::new();
        // ⚠️ 临时诊断：读取序号，便于看分块边界
        let mut dbg_index = 0usize;
        eprintln!(
            "[pty-dbg] t={}ms == PTY read loop start ==",
            pty_session::debug_ms()
        );
        loop {
            let n = match out.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => n,
                Err(_) => break,
            };
            // ⚠️ 临时诊断：每次 read 的原始字节（看清 ConPTY 回显的分块边界）
            dbg_index += 1;
            eprintln!(
                "[pty-dbg] t={}ms OUT #{} n={} {}",
                pty_session::debug_ms(),
                dbg_index,
                n,
                pty_session::debug_escape(&String::from_utf8_lossy(&chunk[..n]))
            );
            truncated |= push_bytes_bounded(&mut tail, &chunk[..n]);
            let text = decoder.push(&chunk[..n]);
            if !text.is_empty() {
                // PTY 只有一条输出流：stderr 已合并进 stdout（stream 恒为 "stdout"）
                let _ = out_tx.send(("stdout".to_string(), text));
            }
        }
        let tail_text = decoder.finish();
        if !tail_text.is_empty() {
            let _ = out_tx.send(("stdout".to_string(), tail_text));
        }
        decode_tail(&tail, truncated)
    });

    // 等待子进程退出（与超时/取消并行），退出码通过 done 通道回传
    let (done_tx, mut done_rx) = mpsc::unbounded_channel::<Option<i32>>();
    let wait_child = child.clone();
    let wait_handle = tokio::task::spawn_blocking(move || {
        let code = wait_child.wait_and_read_exit_code();
        let _ = done_tx.send(code);
    });

    let mut stdout = String::new();
    let mut exit_code: Option<Option<i32>> = None;
    let mut out_closed = false;
    let mut got_exit = false;
    let mut killed_by_timeout = false;
    let mut killed_by_user = false;
    let mut hold_timed_out = false;
    // ② 超时改为「预算 + 心跳」：Step 1 的单次 `sleep` 无法暂停，而接管时必须冻结预算。
    //    预算剩多少是**显式状态**（好断言、好排查）；每 250ms 醒一次，对 CPU 无实质影响。
    let mut remaining = Duration::from_secs(timeout_secs.max(1) as u64);
    let mut held_elapsed = Duration::ZERO;
    let mut tick = tokio::time::interval_at(tokio::time::Instant::now() + TICK, TICK);

    loop {
        tokio::select! {
            maybe = out_rx.recv(), if !out_closed => {
                match maybe {
                    Some((stream, chunk)) => {
                        push_bounded(&mut stdout, &chunk);
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
            _ = tick.tick(), if !killed_by_timeout && !killed_by_user => {
                // ② 接管期间冻结预算（人在慢慢输密码），只在非接管时扣减；
                //    接管累计超过硬上限则强制终止（防止「忘了交还」无限期挂起）。
                let held = pty_session_handle
                    .as_ref()
                    .map(|s| s.is_held())
                    .unwrap_or(false);
                if held {
                    held_elapsed += TICK;
                    if held_elapsed >= pty_hold_max() {
                        child.terminate();
                        if let Some(g) = &guard {
                            g.terminate();
                        }
                        kill_process_tree(pid);
                        killed_by_timeout = true;
                        hold_timed_out = true;
                    }
                } else if remaining > TICK {
                    remaining -= TICK;
                } else {
                    child.terminate();
                    if let Some(g) = &guard {
                        g.terminate();
                    }
                    kill_process_tree(pid);
                    killed_by_timeout = true;
                }
            }
            _ = ctx.cancel.cancelled(), if !killed_by_timeout && !killed_by_user => {
                child.terminate();
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
        // ⚠️ 不能用「输出通道 EOF」作为结束条件：输出管道要等 ClosePseudoConsole 之后
        // 才断开（Spike 实测）。命令结束的判定是**进程退出**；收尾时再关伪控制台，
        // 让读线程把剩余输出排空并自然收到 EOF。
        if got_exit {
            break;
        }
    }

    // ---- 收尾：杀树（仅超时/取消）→ 关伪控制台 → 等读线程 EOF → 取退出码 ----
    let stdout_abort = stdout_handle.abort_handle();
    let wait_abort = wait_handle.abort_handle();
    if killed_by_user || killed_by_timeout {
        child.terminate();
        if let Some(g) = &guard {
            g.terminate();
        }
        kill_process_tree(pid);
    }
    // §5.5 关停顺序：关伪控制台时**读线程必须仍在排空**，所以先不要 abort 它。
    let _ = tokio::task::spawn_blocking(move || {
        pty.close();
    })
    .await;
    // 等读线程把剩余输出收完；3 秒看门狗避免通道异常时工具永不返回。
    let stdout_final = match tokio::time::timeout(Duration::from_secs(3), stdout_handle).await {
        Ok(Ok(text)) => text,
        _ => {
            // 通道没在 3s 内断开：补刀杀树 + abort，用已流式收到的输出返回。
            child.terminate();
            if let Some(g) = &guard {
                g.terminate();
            }
            kill_process_tree(pid);
            stdout_abort.abort();
            String::new()
        }
    };
    // 等 wait 任务收尾（进程已退出时几乎立即返回）
    if tokio::time::timeout(Duration::from_secs(3), wait_handle)
        .await
        .is_err()
    {
        wait_abort.abort();
    }
    if !stdout_final.is_empty() {
        stdout = stdout_final;
    }
    // 注销：先移除表项再关输入通道，保证 `pty_write` 不会写到已关闭的句柄
    if let Some(s) = pty_session::unregister(ctx.tool_call_id) {
        s.close_input();
    }
    // ② 干预摘要（**只记计数**）：keys/enters/ctrlC 来自会话记账，heldSeconds 由预算心跳累计。
    let mut interventions = pty_session_handle
        .as_ref()
        .map(|s| s.interventions())
        .unwrap_or_default();
    interventions.held_seconds = held_elapsed.as_secs();
    unregister_running_command(ctx.tool_call_id);
    let exit_code = if killed_by_timeout || killed_by_user {
        None
    } else {
        exit_code.flatten()
    };

    let env_note = if ran_sandboxed {
        if readonly_mode {
            format!("终端环境: {shell} · 只读（不可写）")
        } else if ctx.security.workspace.is_empty() {
            format!("终端环境: {shell} · 写隔离")
        } else {
            format!(
                "终端环境: {shell} · 写隔离（可写根: {}；区外写入会被拒绝）",
                ctx.security.workspace
            )
        }
    } else if sandbox_degraded {
        format!("终端环境: {shell} · 无沙盒（沙盒不可用，已降级，完整权限）")
    } else if bypass_sandbox {
        format!("终端环境: {shell} · 无沙盒（用户已批准绕过沙盒，完整权限）")
    } else if sandbox_mode(ctx) == SandboxMode::Off {
        format!("终端环境: {shell} · 无沙盒（已关闭，完整权限）")
    } else {
        format!("终端环境: {shell} · 无沙盒（完整权限）")
    };

    Ok(build_command_result(
        stdout,
        // PTY 只有一条输出流：stderr 已合并进 stdout，因此 stderr 恒为空。
        String::new(),
        exit_code,
        killed_by_user,
        killed_by_timeout,
        timeout_secs,
        &env_note,
        true,
        Some(&interventions),
        hold_timed_out,
    ))
}

/// 组装命令执行结果（三条路径共用）。`env_note` 为首行环境提示。
///
/// `pty`：是否来自伪控制台路径。uiData 里加这个标记后，UI 可据此走 xterm 单流渲染
/// （PTY 下 stdout/stderr 已合并，`[标准错误]` 分段与 `stream` 字段失去意义，§6.2）。
///
/// `waitReason`（Step 2 ④）：`exit` | `timeout` | `cancelled`。由结束原因直接推导，
/// **管道路径也下发**（D5：语义统一，UI 与模型侧都不必按路径分叉）。
///
/// `interventions`（Step 2 ②）：用户干预摘要（**只记计数，不记内容**，D4）。
/// PTY 路径传 `Some`；管道路径 / 无会话时传 `None`（则 uiData 不含该字段）。
/// `hold_timed_out`：是否因接管到达硬上限被终止（`waitReason=timeout` 的子情况）。
fn build_command_result(
    stdout: String,
    stderr: String,
    exit_code: Option<i32>,
    killed_by_user: bool,
    killed_by_timeout: bool,
    timeout_secs: i64,
    env_note: &str,
    pty: bool,
    interventions: Option<&pty_session::InterventionCounts>,
    hold_timed_out: bool,
) -> NativeToolOutcome {
    // 结束原因：用户终止 / 预算耗尽（含接管到顶）/ 进程自行退出
    let wait_reason = if killed_by_user {
        "cancelled"
    } else if killed_by_timeout {
        "timeout"
    } else {
        "exit"
    };
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
    // ④：超时且全程几乎无输出 → 追加面向模型的引导（等待输入是最常见的原因）
    if wait_reason == "timeout"
        && stdout.trim().chars().count() <= TIMEOUT_IDLE_HINT_MAX_OUTPUT
    {
        result.push('\n');
        result.push_str(TIMEOUT_IDLE_HINT);
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
        ui_data: Some({
            let mut ui = json!({
                "stdout": stdout,
                "stderr": stderr,
                "exitCode": exit_code,
                "pty": pty,
                // Step 2 ④：结束原因（exit | timeout | cancelled）
                "waitReason": wait_reason,
            });
            if let Value::Object(map) = &mut ui {
                // ② 用户干预摘要（只记计数，不记内容，D4）
                if let Some(iv) = interventions {
                    map.insert(
                        "userInterventions".into(),
                        json!({
                            "keys": iv.keys,
                            "enters": iv.enters,
                            "ctrlC": iv.ctrl_c,
                            "heldSeconds": iv.held_seconds,
                        }),
                    );
                }
                if hold_timed_out {
                    map.insert("holdTimedOut".into(), Value::Bool(true));
                }
            }
            ui
        }),
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

/// 准备沙盒会话：算可写根（含包管理器缓存探测）→ 应用 ACL → 建受限令牌。
///
/// 与「怎么跑」解耦，便于 PTY 路径（`run_command_native_pty`）与管道路径
/// （`run_command_sandboxed`）共用：两条路径的 spawn 方式不同，prepare 完全一致。
async fn prepare_sandbox_session(
    ctx: &NativeToolCtx<'_>,
) -> Result<crate::sandbox::SandboxSession, String> {
    // 写根 = workspace + whitelist 中「存在且是目录」的可写目录（排除 skills_dir）；
    // 保护 = skills_dir（deny-write）；.git/.hg/.svn/.codex/.agents 由 prepare 默认保护。
    // whitelist 可能含 %VAR% 占位符或已失效路径，逐条展开并过滤，避免单条失败导致整体降级。
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
    Ok(session)
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

    // 2) 沙盒会话：与 PTY 路径共用同一份 prepare（算可写根 → 应用 ACL → 建受限令牌）
    let readonly_mode = sandbox_mode(ctx) == SandboxMode::Readonly;
    let session = prepare_sandbox_session(ctx).await?;

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
            let mut raw: Vec<u8> = Vec::new();
            let mut truncated = false;
            let mut chunk = vec![0u8; 8192];
            let mut decoder = TerminalDecoder::new();
            loop {
                let n = match out.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(n) => n,
                    Err(_) => break,
                };
                truncated |= push_bytes_bounded(&mut raw, &chunk[..n]);
                let text = decoder.push(&chunk[..n]);
                if !text.is_empty() {
                    let _ = stdout_tx.send(("stdout".to_string(), text));
                }
            }
            let tail = decoder.finish();
            if !tail.is_empty() {
                let _ = stdout_tx.send(("stdout".to_string(), tail));
            }
            decode_tail(&raw, truncated)
        } else {
            String::new()
        }
    });
    let stderr_handle = tokio::task::spawn_blocking(move || {
        if let Some(mut err) = stderr {
            let mut raw: Vec<u8> = Vec::new();
            let mut truncated = false;
            let mut chunk = vec![0u8; 8192];
            let mut decoder = TerminalDecoder::new();
            loop {
                let n = match err.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(n) => n,
                    Err(_) => break,
                };
                truncated |= push_bytes_bounded(&mut raw, &chunk[..n]);
                let text = decoder.push(&chunk[..n]);
                if !text.is_empty() {
                    let _ = stderr_tx.send(("stderr".to_string(), text));
                }
            }
            let tail = decoder.finish();
            if !tail.is_empty() {
                let _ = stderr_tx.send(("stderr".to_string(), tail));
            }
            decode_tail(&raw, truncated)
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
                            push_bounded(&mut stdout, &chunk);
                        } else {
                            push_bounded(&mut stderr, &chunk);
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
        false, // 管道路径：stdout/stderr 分流，不是 PTY
        None,  // 管道路径无 PTY 会话 → 无干预摘要
        false,
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

    /// ConPTY 输出的转义序列不能漏成正文（Step 1 硬要求，§6.2 / §7 #9）。
    ///
    /// 改造前的解析器只认 `ESC [` 且只吃 0-9;，于是 `\x1b[?25l`（隐藏光标）会把 "25l"
    /// 漏成正文 —— 而伪控制台输出的这类序列非常密集。
    #[test]
    fn test_process_terminal_output_ansi_sequences() {
        // 私有模式（DECSET/DECRST）：整条吞掉，不留残渣
        assert_eq!(process_terminal_output("\x1b[?25lhi\x1b[?25h"), "hi");
        assert_eq!(process_terminal_output("\x1b[?25labc"), "abc");
        // 擦除字符（ECH，光标不动）：不产生正文
        assert_eq!(process_terminal_output("ab\x1b[10Xcd"), "abcd");
        // OSC（改窗口标题）：直到 BEL 都吞掉
        assert_eq!(process_terminal_output("\x1b]0;title\x07ok"), "ok");
        // OSC 用 ST（ESC \）结束
        assert_eq!(process_terminal_output("\x1b]0;title\x1b\\ok"), "ok");
        // 带中间字节的 CSI（`\x1b[1 q` 设置光标形状）
        assert_eq!(process_terminal_output("\x1b[1 qx"), "x");
        // 两字符转义（ESC 7 保存光标 / ESC ( 0 切字符集）
        assert_eq!(process_terminal_output("\x1b7A\x1b(0B"), "AB");
        // 光标定位 + 擦行（PowerShell 重绘提示符的常见组合）
        assert_eq!(process_terminal_output("\x1b[1;1H\x1b[Kab"), "ab");
        // 颜色 + 私有模式混排（真实 PTY 流的典型形状）
        assert_eq!(
            process_terminal_output("\x1b[?25l\x1b[32mOK\x1b[0m\x1b[?25h"),
            "OK"
        );
    }

    /// 退格键要移动光标（ConPTY 重绘里会出现）。
    #[test]
    fn test_process_terminal_output_backspace() {
        assert_eq!(process_terminal_output("ab\x08c"), "ac");
    }

    /// 内存有界：超过上限后丢弃早期内容并插入一次提示，尾部内容保留。
    #[test]
    fn test_push_bounded_drops_earliest() {
        let mut buf = String::new();
        push_bounded(&mut buf, &"x".repeat(STREAM_CAP + 1024));
        assert!(buf.starts_with(STREAM_TRUNCATED_NOTE));
        assert!(buf.len() <= STREAM_KEEP + STREAM_TRUNCATED_NOTE.len() + 8);
        // 再次超限：提示仍然存在（不会被一起裁掉）
        push_bounded(&mut buf, &"y".repeat(STREAM_CAP));
        assert!(buf.starts_with(STREAM_TRUNCATED_NOTE));
        assert!(buf.ends_with('y'));
    }

    /// 有界缓冲要按 UTF-8 边界裁剪，不能把中文切成半个字。
    #[test]
    fn test_push_bounded_keeps_utf8_boundary() {
        let mut buf = String::new();
        let n = STREAM_CAP / '中'.len_utf8() + 10;
        push_bounded(&mut buf, &"中".repeat(n));
        assert!(!buf.contains('\u{FFFD}'));
        assert!(buf[STREAM_TRUNCATED_NOTE.len()..]
            .chars()
            .all(|c| c == '中'));
    }

    /// 内存有界（字节版）：读线程的原始缓冲同样有上限，`yes` 不能打爆内存。
    #[test]
    fn test_push_bytes_bounded() {
        let mut buf: Vec<u8> = Vec::new();
        assert!(!push_bytes_bounded(&mut buf, b"abc"));
        assert_eq!(buf, b"abc");
        let mut big: Vec<u8> = Vec::new();
        assert!(push_bytes_bounded(&mut big, &vec![b'z'; STREAM_CAP + 1]));
        assert!(big.len() <= STREAM_KEEP);
    }

    /// Step 1 端到端：**沙盒开启**时 PTY 路径能拿到正确输出、退出码与中文。
    ///
    /// 核心验收：受限令牌 + Job Object + ConPTY 三者共存（Spike 已验证），
    /// 且命令真的能跑完、输出经伪控制台回传、中文直接可读（无需 GBK 兜底）。
    ///
    /// ⚠️ 这里故意用 **readonly** 模式：
    ///   1. readonly 不触发包管理器缓存探测（`prepare_sandbox_session` 里已短路），
    ///      避免与 `package_cache_roots` 的进程级全局状态并行相互污染；
    ///   2. 也避免测试去改用户**真实**缓存目录（~/.npm、~/.cargo）的 ACL。
    /// 「可写根 + 受限令牌 + ConPTY」的组合由 Spike（`conpty_with_restricted_token`）覆盖。
    #[tokio::test]
    async fn test_execute_command_pty_sandboxed_end_to_end() {
        use crate::agent::bridge::AgentBridgeState;
        use crate::agent::cancellation::CancellationToken;
        use crate::agent::event_sink::TestEventSink;
        use crate::agent::native_tools::execute_native_tool;
        use crate::agent::native_tools::test_util::test_security;

        let dir = std::env::temp_dir().join(format!("virlen_pty_e2e_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut sec = test_security(&dir.to_string_lossy());
        sec.sandbox_mode = "readonly".to_string();
        let sink = TestEventSink::new();
        let bridge = AgentBridgeState::default();
        let cancel = CancellationToken::new();
        let ctx = NativeToolCtx {
            session_id: "s_pty_e2e",
            tool_call_id: "tc_pty_e2e",
            cancel: &cancel,
            sink: &sink,
            bridge: &bridge,
            security: &sec,
        };

        let args = json!({
            "command": "Write-Output 'PTY_ROUTE_OK'; Write-Output '中文输出可读'",
            "timeout": 60
        });
        let outcome = tokio::time::timeout(
            Duration::from_secs(60),
            execute_native_tool(&ctx, "execute_command", &args),
        )
        .await
        .expect("execute_command 不应挂死")
        .expect("execute_command 不应报错");

        match outcome {
            NativeToolOutcome::Value { content, ui_data } => {
                assert!(content.contains("PTY_ROUTE_OK"), "content: {content}");
                assert!(
                    content.contains("中文输出可读"),
                    "中文应直接可读（PTY 输出为 UTF-8）: {content}"
                );
                let ui = ui_data.expect("ui_data");
                assert_eq!(ui["pty"], serde_json::json!(true));
                assert_eq!(ui["exitCode"], serde_json::json!(0));
                assert!(
                    content.contains("只读（不可写）"),
                    "readonly 模式应真的跑在沙盒里（而不是降级裸跑）: {content}"
                );
            }
            other => panic!("expected Value, got {other:?}"),
        }

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Step 1 端到端：用户可在命令执行中「插键盘」——`pty_write` 把输入送进伪控制台。
    ///
    /// `Read-Host` 会真的去读控制台输入：改造前（stdin = NULL / 管道）它只能拿到 EOF，
    /// 所以这条用例是「用户可干预」的直接证据。同时顺带验证 `pty_resize` 能命中会话。
    #[tokio::test]
    async fn test_execute_command_pty_write_interaction() {
        use crate::agent::bridge::AgentBridgeState;
        use crate::agent::cancellation::CancellationToken;
        use crate::agent::event_sink::TestEventSink;
        use crate::agent::native_tools::execute_native_tool;
        use crate::agent::native_tools::test_util::test_security;

        let dir = std::env::temp_dir().join(format!("virlen_pty_in_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        // 同 `test_execute_command_pty_sandboxed_end_to_end`：readonly 避开缓存探测与真实目录 ACL
        let mut sec = test_security(&dir.to_string_lossy());
        sec.sandbox_mode = "readonly".to_string();
        let sink = TestEventSink::new();
        let bridge = AgentBridgeState::default();
        let cancel = CancellationToken::new();
        let tool_call_id = "tc_pty_write";
        let ctx = NativeToolCtx {
            session_id: "s_pty_write",
            tool_call_id,
            cancel: &cancel,
            sink: &sink,
            bridge: &bridge,
            security: &sec,
        };

        // 会话在 spawn 后立刻注册，这里轮询等到它出现再写（避免时序竞态）。
        let writer = tokio::spawn(async move {
            for _ in 0..200 {
                if pty_session::pty_write(tool_call_id, "hello\r\n") {
                    // 顺带验证尺寸调整能命中同一个会话
                    let resized = pty_session::pty_resize(tool_call_id, 120, 40);
                    return (true, resized);
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            (false, false)
        });

        let args = json!({
            "command": "$x = Read-Host; Write-Output \"GOT=$x\"",
            "timeout": 60
        });
        let outcome = tokio::time::timeout(
            Duration::from_secs(60),
            execute_native_tool(&ctx, "execute_command", &args),
        )
        .await
        .expect("execute_command 不应挂死")
        .expect("execute_command 不应报错");

        let (wrote, resized) = writer.await.unwrap();
        assert!(wrote, "命名 PTY 会话应已注册，pty_write 才能命中");
        assert!(resized, "pty_resize 应命中已注册的会话");

        match outcome {
            NativeToolOutcome::Value { content, .. } => {
                assert!(
                    content.contains("GOT=hello"),
                    "用户在执行中写入的输入应被命令读到: {content}"
                );
            }
            other => panic!("expected Value, got {other:?}"),
        }

        std::fs::remove_dir_all(&dir).ok();
    }

    /// PTY 路径的 uiData 必须带 `pty: true`（UI 据此走 xterm 单流渲染）。
    #[test]
    fn test_build_command_result_pty_flag() {
        let pty = build_command_result(
            "out\n".into(),
            String::new(),
            Some(0),
            false,
            false,
            30,
            "终端环境: powershell · 写隔离",
            true,
            None,
            false,
        );
        match pty {
            NativeToolOutcome::Value { content, ui_data } => {
                let ui = ui_data.expect("ui_data");
                assert_eq!(ui["pty"], serde_json::json!(true));
                assert_eq!(ui["stderr"], serde_json::json!(""));
                // PTY 下 stderr 已合并进 stdout，不应出现「[标准错误]」分段
                assert!(!content.contains("[标准错误]"));
            }
            other => panic!("expected Value, got {other:?}"),
        }

        // 管道路径不带 pty 标记，并保留 [标准错误] 分段（向后兼容旧渲染分支）
        let pipes = build_command_result(
            "a\n".into(),
            "w\n".into(),
            Some(0),
            false,
            false,
            30,
            "",
            false,
            None,
            false,
        );
        match pipes {
            NativeToolOutcome::Value { content, ui_data } => {
                assert_eq!(ui_data.expect("ui_data")["pty"], serde_json::json!(false));
                assert!(content.contains("[标准错误]"));
            }
            other => panic!("expected Value, got {other:?}"),
        }
    }

    /// Step 2 ④：`waitReason` 三个取值 + 管道路径同样下发 + 超时无输出的模型引导。
    #[test]
    fn test_build_command_result_wait_reason() {
        // exit：进程自行退出
        let exit = build_command_result(
            "ok\n".into(),
            String::new(),
            Some(0),
            false,
            false,
            30,
            "",
            false,
            None,
            false,
        );
        match exit {
            NativeToolOutcome::Value { content, ui_data } => {
                let ui = ui_data.expect("ui_data");
                assert_eq!(ui["waitReason"], serde_json::json!("exit"));
                // D5：管道路径也要下发同名 waitReason
                assert_eq!(ui["pty"], serde_json::json!(false));
                assert!(!content.contains("等待输入"));
            }
            other => panic!("expected Value, got {other:?}"),
        }

        // cancelled：用户主动终止
        let cancelled = build_command_result(
            "partial\n".into(),
            String::new(),
            None,
            true,
            false,
            30,
            "",
            true,
            None,
            false,
        );
        match cancelled {
            NativeToolOutcome::Value { ui_data, .. } => {
                assert_eq!(
                    ui_data.expect("ui_data")["waitReason"],
                    serde_json::json!("cancelled")
                );
            }
            other => panic!("expected Value, got {other:?}"),
        }

        // timeout + 全程无输出 → timeout，且追加「疑似等待输入」引导
        let idle_timeout = build_command_result(
            String::new(),
            String::new(),
            None,
            false,
            true,
            5,
            "",
            true,
            None,
            false,
        );
        match idle_timeout {
            NativeToolOutcome::Value { content, ui_data } => {
                assert_eq!(
                    ui_data.expect("ui_data")["waitReason"],
                    serde_json::json!("timeout")
                );
                assert!(
                    content.contains("等待输入"),
                    "超时无输出应引导等待输入: {content}"
                );
            }
            other => panic!("expected Value, got {other:?}"),
        }

        // timeout + 有持续输出（超过阈值）→ 不追加引导
        let busy_timeout = build_command_result(
            "下载中...正在解压...持续输出内容已超过引导阈值\n".into(),
            String::new(),
            None,
            false,
            true,
            5,
            "",
            true,
            None,
            false,
        );
        match busy_timeout {
            NativeToolOutcome::Value { content, .. } => {
                assert!(!content.contains("等待输入"), "有输出时不应引导: {content}");
            }
            other => panic!("expected Value, got {other:?}"),
        }
    }

    /// 仅测试用：串行化“接管”相关用例，避免 `HOLD_MAX_OVERRIDE_SECS` 全局态互踩。
    /// 其余 PTY 用例不接管（held=false）→ 不读该 override，无需锁。
    static HOLD_TEST_LOCK: LazyLock<tokio::sync::Mutex<()>> =
        LazyLock::new(|| tokio::sync::Mutex::new(()));

    /// Step 2 ②：接管期间冻结超时预算（人在慢慢输密码，不该被超时杀掉）。
    #[tokio::test]
    async fn test_pty_hold_freezes_timeout() {
        use crate::agent::bridge::AgentBridgeState;
        use crate::agent::cancellation::CancellationToken;
        use crate::agent::event_sink::TestEventSink;
        use crate::agent::native_tools::execute_native_tool;
        use crate::agent::native_tools::test_util::test_security;

        let _guard = HOLD_TEST_LOCK.lock().await;
        let dir =
            std::env::temp_dir().join(format!("virlen_pty_hold_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut sec = test_security(&dir.to_string_lossy());
        sec.sandbox_mode = "readonly".to_string();
        let sink = TestEventSink::new();
        let bridge = AgentBridgeState::default();
        let cancel = CancellationToken::new();
        let tool_call_id = "tc_hold_freeze";
        let ctx = NativeToolCtx {
            session_id: "s_hold_freeze",
            tool_call_id,
            cancel: &cancel,
            sink: &sink,
            bridge: &bridge,
            security: &sec,
        };

        // 会话一注册就接管（全程冻结）。timeout=1s 而命令跑 2.5s：
        // 若不冻结，1s 就会被杀（waitReason=timeout）；冻结后命令自然退出（waitReason=exit）。
        let holder = tokio::spawn(async move {
            for _ in 0..200 {
                if pty_session::pty_set_held(tool_call_id, true) {
                    return true;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            false
        });

        let started = std::time::Instant::now();
        let args = json!({
            "command": "Start-Sleep -Milliseconds 2500; Write-Output 'HOLD_OK'",
            "timeout": 1
        });
        let outcome = tokio::time::timeout(
            Duration::from_secs(30),
            execute_native_tool(&ctx, "execute_command", &args),
        )
        .await
        .expect("execute_command 不应挂死")
        .expect("execute_command 不应报错");
        let elapsed = started.elapsed();
        assert!(holder.await.unwrap(), "会话应已注册，pty_set_held 才能命中");

        assert!(
            elapsed >= Duration::from_millis(2200),
            "冻结后总耗时应接近命令真实时长，实际 {elapsed:?}"
        );
        match outcome {
            NativeToolOutcome::Value { content, ui_data } => {
                let ui = ui_data.expect("ui_data");
                assert_eq!(
                    ui["waitReason"],
                    serde_json::json!("exit"),
                    "接管期间不应超时: {content}"
                );
                assert!(content.contains("HOLD_OK"), "content: {content}");
                let held = ui["userInterventions"]["heldSeconds"]
                    .as_u64()
                    .unwrap_or(0);
                assert!(held >= 2, "heldSeconds 应 >= 2，实际 {held}");
            }
            other => panic!("expected Value, got {other:?}"),
        }

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Step 2 ②：接管到达硬上限 → 强制终止，`waitReason=timeout` 且 `holdTimedOut=true`。
    #[tokio::test]
    async fn test_pty_hold_hard_cap() {
        use crate::agent::bridge::AgentBridgeState;
        use crate::agent::cancellation::CancellationToken;
        use crate::agent::event_sink::TestEventSink;
        use crate::agent::native_tools::execute_native_tool;
        use crate::agent::native_tools::test_util::test_security;

        let _guard = HOLD_TEST_LOCK.lock().await;
        // 把 30min 硬上限缩短到 1s（仅测试）
        HOLD_MAX_OVERRIDE_SECS.store(1, Ordering::SeqCst);

        let dir = std::env::temp_dir().join(format!("virlen_pty_cap_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut sec = test_security(&dir.to_string_lossy());
        sec.sandbox_mode = "readonly".to_string();
        let sink = TestEventSink::new();
        let bridge = AgentBridgeState::default();
        let cancel = CancellationToken::new();
        let tool_call_id = "tc_hold_cap";
        let ctx = NativeToolCtx {
            session_id: "s_hold_cap",
            tool_call_id,
            cancel: &cancel,
            sink: &sink,
            bridge: &bridge,
            security: &sec,
        };

        let holder = tokio::spawn(async move {
            for _ in 0..200 {
                if pty_session::pty_set_held(tool_call_id, true) {
                    return true;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            false
        });

        let started = std::time::Instant::now();
        // timeout=300s，但接管到顶（1s）应远早于此
        let args = json!({ "command": "Start-Sleep -Seconds 60", "timeout": 300 });
        let outcome = tokio::time::timeout(
            Duration::from_secs(20),
            execute_native_tool(&ctx, "execute_command", &args),
        )
        .await
        .expect("execute_command 不应挂死")
        .expect("execute_command 不应报错");
        let elapsed = started.elapsed();
        assert!(holder.await.unwrap(), "会话应已注册，pty_set_held 才能命中");
        HOLD_MAX_OVERRIDE_SECS.store(0, Ordering::SeqCst);

        assert!(
            elapsed < Duration::from_secs(15),
            "到顶应尽快终止，实际 {elapsed:?}"
        );
        match outcome {
            NativeToolOutcome::Value { content, ui_data } => {
                let ui = ui_data.expect("ui_data");
                assert_eq!(ui["waitReason"], serde_json::json!("timeout"));
                assert_eq!(ui["holdTimedOut"], serde_json::json!(true));
                assert!(content.contains("超时"), "content: {content}");
            }
            other => panic!("expected Value, got {other:?}"),
        }

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Step 2 ②：干预计数正确，且**干预摘要不含用户输入正文**（D4 回归保护）。
    ///
    /// 命令不读 stdin（Start-Sleep）→ 控制台不会回显，因此 uiData 全串都应无正文；
    /// 若将来有人把正文塞进干预摘要，本用例立即失败。
    #[tokio::test]
    async fn test_pty_interventions_counted() {
        use crate::agent::bridge::AgentBridgeState;
        use crate::agent::cancellation::CancellationToken;
        use crate::agent::event_sink::TestEventSink;
        use crate::agent::native_tools::execute_native_tool;
        use crate::agent::native_tools::test_util::test_security;

        let dir =
            std::env::temp_dir().join(format!("virlen_pty_iv_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut sec = test_security(&dir.to_string_lossy());
        sec.sandbox_mode = "readonly".to_string();
        let sink = TestEventSink::new();
        let bridge = AgentBridgeState::default();
        let cancel = CancellationToken::new();
        let tool_call_id = "tc_interv";
        let ctx = NativeToolCtx {
            session_id: "s_interv",
            tool_call_id,
            cancel: &cancel,
            sink: &sink,
            bridge: &bridge,
            security: &sec,
        };

        const SECRET: &str = "SECRET_TOKEN_123";
        let writer = tokio::spawn(async move {
            for _ in 0..200 {
                if pty_session::pty_write(tool_call_id, SECRET) {
                    pty_session::pty_write(tool_call_id, "\r");
                    return true;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            false
        });

        let args = json!({
            "command": "Start-Sleep -Milliseconds 1500; Write-Output 'DONE'",
            "timeout": 30
        });
        let outcome = tokio::time::timeout(
            Duration::from_secs(30),
            execute_native_tool(&ctx, "execute_command", &args),
        )
        .await
        .expect("execute_command 不应挂死")
        .expect("execute_command 不应报错");
        assert!(writer.await.unwrap(), "pty_write 应命中会话");

        match outcome {
            NativeToolOutcome::Value { content, ui_data } => {
                assert!(content.contains("DONE"), "content: {content}");
                let ui = ui_data.expect("ui_data");
                let iv = &ui["userInterventions"];
                assert_eq!(iv["keys"], serde_json::json!(2));
                assert_eq!(iv["enters"], serde_json::json!(1));
                assert_eq!(iv["ctrlC"], serde_json::json!(0));
                // D4：只记计数，不记正文
                let ui_json = serde_json::to_string(&ui).unwrap();
                assert!(
                    !ui_json.contains(SECRET),
                    "uiData 不应包含用户输入正文（D4）: {ui_json}"
                );
            }
            other => panic!("expected Value, got {other:?}"),
        }

        std::fs::remove_dir_all(&dir).ok();
    }
}
