//! PTY 会话注册表 —— `tool_call_id` → 伪控制台输入通道。
//!
//! 用途：让用户在命令执行中「插键盘」（`docs/pty-research.md` §6.3）。
//!
//!   - 运行器建好伪控制台后，把**输入写端**登记到本表；
//!   - 前端 `invoke('pty_write', { toolCallId, data })` 直接写进去 —— 走 Tauri 命令而不是
//!     引擎事件总线，因此**不污染 `AgentEventType` 四方契约**（铁律 2）；
//!   - 命令结束（或超时/取消）时注销，避免写到已关闭的句柄。
//!
//! 会话 key 直接复用 `toolCallId`：前端 `TerminalView` 已持有它，
//! `rust-engine.ts` 也已按它注册 kill 入口 → **无需新增映射事件**，改动量最小的接法。
//!
//! ⚠️ 中断语义（实测结论，§5.6）：`\x03` 只能影响「正在读 stdin 的进程」
//! （shell 提示符 / REPL / `y/n` 提示）。Windows 的控制台控制事件是在**有人读输入缓冲**时
//! 才生成的，`ping` 这类从不读 stdin 的前台程序**不会**被 `\x03` 打断 —— 因此
//! **中断主通道仍然是 Job Object / `agent_kill_command`**，本模块只是补充手段。

use std::collections::HashMap;
use std::fs::File;
use std::io::Write;
use std::sync::{Arc, LazyLock, Mutex};

/// 一个运行中的 PTY 会话句柄。
pub struct PtySession {
    /// 伪控制台输入写端。取值时加锁：`pty_write` 可能来自任意 Tauri 命令线程。
    /// `File::write_all` 对管道句柄是同步且无缓冲的，不需要额外 flush。
    input: Mutex<Option<File>>,
    /// Windows：`HPCON` 的副本，供 `pty_resize` 使用；非 Windows 平台暂为 0。
    #[allow(dead_code)]
    hpc: isize,
}

impl PtySession {
    pub fn new(input: File, hpc: isize) -> Self {
        Self {
            input: Mutex::new(Some(input)),
            hpc,
        }
    }

    /// 写入数据（用户键入内容或控制字节，如 `\x03`）。返回是否写入成功。
    ///
    /// 空串视为成功（no-op），便于前端无脑转发。
    pub fn write(&self, data: &str) -> bool {
        if data.is_empty() {
            return true;
        }
        // 锁中毒也继续用（内部只是一个 File 句柄，不存在被破坏的不变量）
        let mut guard = match self.input.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        let Some(file) = guard.as_mut() else {
            return false;
        };
        file.write_all(data.as_bytes()).is_ok()
    }

    /// 关闭输入通道（命令结束时调用；`File` 的 Drop 会关闭底层句柄）。
    pub fn close_input(&self) {
        let mut guard = match self.input.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        *guard = None;
    }

    /// `HPCON` 副本（`0` 表示不可用）。
    #[allow(dead_code)]
    pub fn hpc(&self) -> isize {
        self.hpc
    }
}

/// 运行中的 PTY 会话表：`tool_call_id` → 会话句柄。
static PTY_SESSIONS: LazyLock<Mutex<HashMap<String, Arc<PtySession>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// 登记一个会话（运行器 spawn 成功后立即调用）。
pub fn register(tool_call_id: &str, session: Arc<PtySession>) {
    PTY_SESSIONS
        .lock()
        .unwrap()
        .insert(tool_call_id.to_string(), session);
}

/// 注销会话并返回句柄（调用方据此关闭输入通道），命令结束时调用。
///
/// 返回而非直接 Drop：调用方需要先关闭输入通道、再关伪控制台（§5.5 的关停顺序）。
pub fn unregister(tool_call_id: &str) -> Option<Arc<PtySession>> {
    PTY_SESSIONS.lock().unwrap().remove(tool_call_id)
}

fn lookup(tool_call_id: &str) -> Option<Arc<PtySession>> {
    PTY_SESSIONS.lock().unwrap().get(tool_call_id).cloned()
}

/// 向指定会话写入数据（`pty_write` 命令入口）。返回是否找到并写入成功。
pub fn pty_write(tool_call_id: &str, data: &str) -> bool {
    match lookup(tool_call_id) {
        Some(session) => session.write(data),
        None => false,
    }
}

/// 调整指定会话的伪控制台尺寸（`pty_resize` 命令入口）。
pub fn pty_resize(tool_call_id: &str, cols: u16, rows: u16) -> bool {
    let Some(session) = lookup(tool_call_id) else {
        return false;
    };
    #[cfg(target_os = "windows")]
    {
        return crate::sandbox::pty::resize_raw(session.hpc(), cols as i16, rows as i16);
    }
    #[cfg(not(target_os = "windows"))]
    {
        // 非 Windows 平台尚未实现 PTY（仍在匿名管道路径），尺寸调整无意义。
        let _ = (session, cols, rows);
        false
    }
}
