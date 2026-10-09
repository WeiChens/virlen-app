//! service — **交互控制台句柄**：用户键击 / 尺寸 / 关停（P3）。
//!
//! 与 `execute::pty_session` 的关系：**同一套底层（ConPTY），不同的寿命与归属**。
//! 命令的伪控制台以 `tool_call_id` 为键、命令一结束就注销；服务的伪控制台活到**进程退出或
//! 条目被清出注册表**，因此它挂在本模块的服务条目上（`ServiceState::pty`）。
//!
//! 三条必须守住的约束：
//! 1. **关伪控制台 = 杀附着进程**（`ClosePseudoConsole` 的语义）：所以句柄只能由
//!    [`ServicePty::close`] 在「进程已退出」之后调用，绝不能在工具返回时顺手 drop；
//! 2. **尺寸去重**：ConPTY 在屏幕已有内容后收到 `ResizePseudoConsole` 会整屏重绘并补空行，
//!    而前端 `ResizeObserver` 会重复上报同一尺寸 —— 复用 `pty_session::SizeTracker`；
//! 3. **非 Windows 没有伪控制台实现**（Unix PTY 尚未接入）：空壳方法一律拒绝，
//!    让上层（registry / panel / runner）不必到处 `#[cfg]`。

#[cfg(target_os = "windows")]
use std::fs::File;
#[cfg(target_os = "windows")]
use std::io::Write;
#[cfg(target_os = "windows")]
use std::sync::Mutex;

#[cfg(target_os = "windows")]
use crate::agent::native_tools::execute::pty_session::SizeTracker;
#[cfg(target_os = "windows")]
use crate::sandbox::pty::PseudoConsole;

/// 一个服务的伪控制台句柄（输入写端 + `HPCON`）。
pub(crate) struct ServicePty {
    /// 输入写端：用户键击写这里（`None` = 已关闭 / 从未拿到）。
    #[cfg(target_os = "windows")]
    input: Mutex<Option<File>>,
    /// 伪控制台本体（持有 `HPCON`；`None` = 已 close）。
    /// ⚠️ **它还在 = 附着进程还活着**：drop/close 都会终止该进程树。
    #[cfg(target_os = "windows")]
    pty: Mutex<Option<PseudoConsole>>,
    /// 当前尺寸（列, 行）—— 跳过「没有变化」的 resize（见 [`SizeTracker`]）。
    #[cfg(target_os = "windows")]
    size: Mutex<SizeTracker>,
}

#[cfg(target_os = "windows")]
impl ServicePty {
    /// `cols` / `rows`：伪控制台**创建时**的尺寸（写入去重器，使「与初始尺寸相同」的
    /// 首次上报也成为 no-op）。
    pub(super) fn new(input: File, pty: PseudoConsole, cols: i16, rows: i16) -> Self {
        let mut tracker = SizeTracker::default();
        tracker.changed(cols, rows);
        Self {
            input: Mutex::new(Some(input)),
            pty: Mutex::new(Some(pty)),
            size: Mutex::new(tracker),
        }
    }

    /// 写入用户键击（或粘贴内容）。空串视为成功（no-op），便于前端无脑转发。
    ///
    /// `false` = 写不进去（控制台已关闭 / 管道已断）—— 前端据此复位输入。
    /// ⚠️ 与命令路径一样**不记录内容**：PTY 里敲的常是密码 / token（§9 密钥红线）。
    pub(super) fn write(&self, data: &str) -> bool {
        if data.is_empty() {
            return true;
        }
        let mut guard = match self.input.lock() {
            Ok(g) => g,
            // 锁中毒也继续用（内部只是一个 File 句柄，不存在被破坏的不变量）
            Err(poisoned) => poisoned.into_inner(),
        };
        let Some(file) = guard.as_mut() else {
            return false;
        };
        file.write_all(data.as_bytes()).is_ok()
    }

    /// 调整伪控制台尺寸。返回是否**可以继续**（`false` = 控制台已关闭，前端会停止重试）。
    ///
    /// 与上报尺寸相同 → 直接回 true、不调 `ResizePseudoConsole`（见 [`SizeTracker`]）。
    /// ⚠️ 持锁调用 `resize_raw`：`HPCON` 是裸句柄，必须保证 `close()` 不能与之并发
    /// （两者共用同一把锁）。
    pub(super) fn resize(&self, cols: u16, rows: u16) -> bool {
        let guard = match self.pty.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        let Some(pty) = guard.as_ref() else {
            return false;
        };
        let mut size = match self.size.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        if !size.changed(cols as i16, rows as i16) {
            return true;
        }
        crate::sandbox::pty::resize_raw(pty.raw_hpc(), cols as i16, rows as i16)
    }

    /// 关闭控制台（幂等）：关 `HPCON`（读线程随后收到 EOF）+ 释放输入写端。
    ///
    /// `ClosePseudoConsole` 会终止仍附着在伪控制台上的进程树 —— 调用点只有两处，
    /// 都发生在「进程已经退出」之后：`runner::supervise` 的常驻等待任务、以及条目被清出时的 drop。
    pub(super) fn close(&self) {
        let mut guard = match self.pty.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        if let Some(mut pty) = guard.take() {
            pty.close();
        }
        drop(guard);
        if let Ok(mut input) = self.input.lock() {
            *input = None;
        }
    }
}

/// 非 Windows：没有伪控制台实现（Unix PTY 尚未接入，服务仍跑匿名管道）。
///
/// 空壳存在的唯一理由是让上层的平台无关代码（`ServiceState::pty` / `panel.rs`）照常编译 ——
/// 它**永远不会被构造**（`runner` 只在 Windows 上建控制台）。
#[cfg(not(target_os = "windows"))]
impl ServicePty {
    /// 非 Windows 恒 `false`（没有可写的伪控制台）
    pub(super) fn write(&self, _data: &str) -> bool {
        false
    }

    /// 非 Windows 恒 `false`（没有可调尺寸的伪控制台）
    pub(super) fn resize(&self, _cols: u16, _rows: u16) -> bool {
        false
    }

    /// 非 Windows 无操作
    pub(super) fn close(&self) {}
}
