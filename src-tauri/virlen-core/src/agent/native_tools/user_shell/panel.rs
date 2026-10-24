//! user_shell — **给界面的公开 API**（Tauri 命令层只做转交）。
//!
//! 与 `service/panel.rs` 的形状**故意一样**：开始 / 读 / 写 / 改尺寸 / 关闭 / 列表，
//! 读取同样按绝对偏移续接（`text` / `reset` / `next` / `headDropped`），前端因此能复用
//! 同一套轮询与「环形丢弃后整段重放」逻辑。
//!
//! 三条与服务的差别（都来自「这是用户自己的终端」）：
//! 1. **关闭 = 杀进程 + 摘条目**：终端只有一份用途，关掉以后没有「已结束但仍要看列表」的需求
//!    （服务的注册表要留给 AI 读收尾输出，所以那边终止不摘条目）；
//! 2. **不发结束通知**：用户看着屏幕，不需要一条「你的终端结束了」的消息；
//! 3. **不做审批、不写任何输入内容到日志**：键击里常是密码 / token（与 `pty_write` 同一条红线）。
//!
//! 另多一条「有哪些 shell 可选」（[`list_shells`]）：四种类型里 `pwsh` / `gitbash` 要另外安装，
//! 界面必须能先把「装没装」问清楚（探测在 [`super::shells`]）。

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{json, Value};

use super::shells;
use super::{
    ensure_capacity, get, insert, list, next_id, remove, supervise, ShellEntry, ShellState, Spawned,
};

/// 工作目录必须是**存在**的绝对路径。
///
/// 只校验形态，不校验「在不在工作区里」：终端的工作目录由宿主按「会话工作区 → 已选目录 →
/// 全局默认目录」解析后传下来，core 拿不到那张会话表。空串 = 当前会话没有工作区，明确报错，
/// 不悄悄退到进程当前目录（那会让人以为终端开在了项目里，实际开在了安装目录）。
fn resolve_cwd(raw: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("这个会话没有工作区目录，无法在这里打开终端。".to_string());
    }
    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        return Err(format!("终端的工作目录必须是绝对路径：{trimmed}"));
    }
    if !path.is_dir() {
        return Err(format!("工作目录不存在或不是目录：{trimmed}"));
    }
    Ok(path)
}

/// 起一个终端。返回 `{ id, shell, command, cwd, pid, startedAt }`（前端据此建标签）。
///
/// `shell` 是 shell 类型 id（`cmd` / `powershell` / `pwsh` / `gitbash`）：
/// - `None` / 空串 → 默认（Windows PowerShell，没装则退到第一个装了的）；
/// - 认不出的 id → 报错（调用方的 bug，不默默换成默认）；
/// - 认得但没装（例如选了没装 Git Bash）→ 报「没找到 bash.exe（查过 …）」。
///
/// ⚠️ 必须在 tokio 运行时内调用（常驻读 / 等待任务要 `spawn_blocking`）。
pub fn start_terminal(
    session_id: &str,
    cwd: &str,
    cols: u16,
    rows: u16,
    shell: Option<&str>,
) -> Result<Value, String> {
    let path = resolve_cwd(cwd)?;
    let kind = shells::parse(shell)?;
    ensure_capacity(session_id)?;
    let Spawned {
        pid,
        shell,
        command,
        stdout,
        terminator,
        wait,
        console,
    } = super::spawn::spawn_shell(&path, cols, rows, kind)?;

    let id = next_id();
    let started_at = crate::telemetry::now_ms();
    let cwd_text = path.to_string_lossy().to_string();
    let state = Arc::new(ShellState::new());
    let entry = Arc::new(ShellEntry::new(
        id.clone(),
        session_id.to_string(),
        shell.clone(),
        cwd_text.clone(),
        pid,
        started_at,
        state.clone(),
        terminator,
    ));
    // 先入表再接管：读任务一开跑就可能有人来读（顺序与服务那边一致）。
    insert(entry);
    supervise(stdout, wait, console, state, session_id, &id);

    Ok(json!({
        "id": id,
        "shell": shell,
        "command": command,
        "cwd": cwd_text,
        "pid": pid,
        "startedAt": started_at,
    }))
}

/// 这台机器上支持哪些 shell，装没装（界面菜单直接按这个列表渲染）。
///
/// 每项：`{ id, exe, available, command, args, default, hint }`。
/// - `available = false` 的项**也要返回**：菜单里灰显 + 标「未安装」，用户才知道
///   「Git Bash 是没装，不是这里没有」；`hint` 就是给那句话做底的（查过哪些目录）；
/// - `default = true` 的是没记忆时的首选（与 [`start_terminal`] 传 `None` 一致）。
/// - 展示名不在这里：那是界面文案（中文即 key，见 `en-US.json`），core 只给稳定 id。
pub fn list_shells() -> Vec<Value> {
    let preferred = shells::preferred_kind();
    shells::detect_all()
        .into_iter()
        .map(|info| {
            json!({
                "id": info.kind.id(),
                "exe": info.kind.exe(),
                "available": info.available(),
                "command": info
                    .command
                    .as_ref()
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_default(),
                "args": info.kind.args(),
                "default": info.kind == preferred,
                "hint": info.hint,
            })
        })
        .collect()
}

/// 读输出（自绝对偏移 `from` 起的增量）。`None` = 本会话里没有这个终端。
///
/// 字段：
/// - `text` / `reset` / `next` / `headDropped`：与 `read_service_console` 同一套续接协议；
/// - `running` / `interactive`：进程还在跑、以及**现在能不能输入**（`running && 控制台还活着`）；
/// - `exitCode` / `killed`：结束后如实回报退出码与「是不是被关掉的」。
pub fn read_terminal(session_id: &str, id: &str, from: u64) -> Option<Value> {
    let entry = get(session_id, id)?;
    let (text, reset, next, head_dropped) = entry.state.console.lock().unwrap().read_from(from);
    let (status, code, killed) = entry.state.snapshot();
    let running = status == "running";
    let interactive = running && entry.state.pty().is_some();
    Some(json!({
        "text": text,
        "reset": reset,
        "next": next,
        "headDropped": head_dropped,
        "running": running,
        "interactive": interactive,
        "exitCode": code,
        "killed": killed,
    }))
}

/// 把用户键入的字节写进伪控制台。`false` = 没写进去（非本会话 / 已结束 / 没有控制台）。
///
/// ⚠️ **只记「发生了写」，不记内容**：终端里敲的常是密码 / token。
pub fn write_terminal(session_id: &str, id: &str, data: &str) -> bool {
    let Some(entry) = get(session_id, id) else {
        return false;
    };
    if !entry.is_running() {
        return false;
    }
    match entry.state.pty() {
        Some(pty) => pty.write(data),
        None => false,
    }
}

/// 调整伪控制台尺寸。`false` = 没有可调的控制台（非本会话 / 已结束）。
///
/// 同尺寸重复上报由 `ServicePty` 内部的去重器吞掉（ConPTY 重绘补空行的坑）。
pub fn resize_terminal(session_id: &str, id: &str, cols: u16, rows: u16) -> bool {
    let Some(entry) = get(session_id, id) else {
        return false;
    };
    if !entry.is_running() {
        return false;
    }
    match entry.state.pty() {
        Some(pty) => pty.resize(cols, rows),
        None => false,
    }
}

/// 关掉一个终端：终止整棵进程树并**摘掉条目**（幂等）。`false` = 本会话里没有这个 id。
///
/// 摘条目同时放下 `Terminator`（带 `KILL_ON_JOB_CLOSE` 的 Job），所以即使
/// `terminate` 被漏掉，进程树也会跟着结束 —— 「关标签 = 关终端」不靠调用方记性。
pub fn kill_terminal(session_id: &str, id: &str) -> bool {
    let Some(entry) = get(session_id, id) else {
        return false;
    };
    if entry.is_running() {
        entry.terminate();
    }
    remove(&entry.id);
    true
}

/// 本会话的终端快照（按启动时间升序）—— 诊断 / 以后做「恢复上次终端」用。
pub fn list_terminals(session_id: &str) -> Vec<Value> {
    let now = crate::telemetry::now_ms();
    list(session_id)
        .iter()
        .map(|e| {
            let (status, code, killed) = e.state.snapshot();
            json!({
                "id": e.id,
                "shell": e.shell,
                "cwd": e.cwd,
                "pid": e.pid,
                "startedAt": e.started_at,
                "uptimeMs": now.saturating_sub(e.started_at),
                "status": status,
                "exitCode": code,
                "killed": killed,
            })
        })
        .collect()
}
