//! 跨平台进程树管理 — 解决「命令超时/终止后子进程不被销毁、一直存活」的根因
//!
//! 问题背景：
//! - Windows 的 `taskkill /F /T` 依赖父-子进程树关系。node/npm/python 等进程一旦
//!   被 reparent（父进程退出后被系统收养）或脱离树（`start`/`Start-Process`/detach），
//!   `/T` 就枚举不到，进程逃出树继续存活。
//! - Unix 的 `kill -<pid>`（负 PID=进程组）只有在子进程是进程组组长时才有效；
//!   `std::process::Command` 默认不创建新进程组，信号发到不存在的进程组 → 静默失败。
//!   `pkill -P` 又只杀直接子进程一层，孙进程存活。
//!
//! 修复：
//! 1. `ProcessTreeGuard`：Windows 上使用 Job Object，把命令进程及其所有后代纳入一个
//!    Job，终止时 `TerminateJobObject` 一键全杀（不依赖进程树关系，无竞态）。
//! 2. `kill_process_tree(pid)`：两端都做「递归枚举后代 → 逐个强杀」兜底，
//!    即使 Job 分配失败（嵌套 Job 限制）或进程未被 Job 管理（JS 桥路径）也能杀干净。

use std::collections::HashMap;

// ═══════════════════════════════════════════════════════════════════════════
// Windows Job Object Guard
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(target_os = "windows")]
pub struct ProcessTreeGuard {
    job: std::os::windows::io::RawHandle,
}

#[cfg(target_os = "windows")]
unsafe impl Send for ProcessTreeGuard {}
#[cfg(target_os = "windows")]
unsafe impl Sync for ProcessTreeGuard {}

#[cfg(target_os = "windows")]
impl ProcessTreeGuard {
    /// 创建 Job Object。失败返回 None（调用方回退到递归 taskkill）。
    pub fn create() -> Option<ProcessTreeGuard> {
        use windows_sys::Win32::System::JobObjects::CreateJobObjectW;
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return None;
            }
            // 不设置 JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE：
            // 命令正常结束时若残留后台进程（start /b、nohup），保留现有语义让其继续，
            // 只有显式 kill（超时/终止/取消）才 TerminateJobObject。
            Some(ProcessTreeGuard { job })
        }
    }

    /// 把已存在的进程（按 PID）加入 Job，之后其所有后代自动继承入组。
    pub fn assign_pid(&self, pid: u32) -> bool {
        use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_QUOTA,
            PROCESS_TERMINATE,
        };
        unsafe {
            let process = OpenProcess(
                PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION,
                0,
                pid,
            );
            if process.is_null() {
                return false;
            }
            let ok = AssignProcessToJobObject(self.job, process) != 0;
            let _ = windows_sys::Win32::Foundation::CloseHandle(process);
            ok
        }
    }

    /// 终止 Job 内所有进程（幂等）。
    pub fn terminate(&self) {
        use windows_sys::Win32::System::JobObjects::TerminateJobObject;
        unsafe {
            let _ = TerminateJobObject(self.job, 1);
        }
    }
}

#[cfg(target_os = "windows")]
impl Drop for ProcessTreeGuard {
    fn drop(&mut self) {
        unsafe {
            let _ = windows_sys::Win32::Foundation::CloseHandle(self.job);
        }
    }
}

/// 非 Windows 平台空实现（保持调用点一致）
#[cfg(not(target_os = "windows"))]
pub struct ProcessTreeGuard;

#[cfg(not(target_os = "windows"))]
impl ProcessTreeGuard {
    pub fn create() -> Option<ProcessTreeGuard> {
        None
    }
    pub fn assign_pid(&self, _pid: u32) -> bool {
        false
    }
    pub fn terminate(&self) {}
}

// ═══════════════════════════════════════════════════════════════════════════
// 递归枚举后代进程
// ═══════════════════════════════════════════════════════════════════════════

/// Windows：用 Toolhelp32 快照收集 `root_pid` 的全部后代 PID（含多级、含 reparent 场景）。
#[cfg(target_os = "windows")]
fn windows_descendants(root_pid: u32) -> Vec<u32> {
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS as u32, 0);
        if snapshot.is_null() {
            return Vec::new();
        }
        let mut map: HashMap<u32, Vec<u32>> = HashMap::new();
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        if Process32FirstW(snapshot, &mut entry) != 0 {
            loop {
                map.entry(entry.th32ParentProcessID)
                    .or_default()
                    .push(entry.th32ProcessID);
                if Process32NextW(snapshot, &mut entry) == 0 {
                    break;
                }
            }
        }
        let _ = windows_sys::Win32::Foundation::CloseHandle(snapshot);

        // BFS 收集后代
        let mut result = Vec::new();
        let mut queue: Vec<u32> = map.get(&root_pid).cloned().unwrap_or_default();
        let mut seen = std::collections::HashSet::new();
        while let Some(pid) = queue.pop() {
            if !seen.insert(pid) {
                continue;
            }
            result.push(pid);
            if let Some(children) = map.get(&pid) {
                queue.extend(children.iter().copied());
            }
        }
        result
    }
}

/// Unix：用 `ps -eo pid=,ppid=` 收集 `root_pid` 的全部后代 PID（含多级）。
#[cfg(not(target_os = "windows"))]
fn unix_descendants(root_pid: u32) -> Vec<u32> {
    let out = std::process::Command::new("ps")
        .args(["-eo", "pid=,ppid="])
        .output();
    let out = match out {
        Ok(o) if o.status.success() => o,
        _ => return Vec::new(),
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        if let (Some(pid_s), Some(ppid_s)) = (parts.next(), parts.next()) {
            if let (Ok(pid), Ok(ppid)) = (pid_s.parse::<u32>(), ppid_s.parse::<u32>()) {
                children.entry(ppid).or_default().push(pid);
            }
        }
    }
    let mut result = Vec::new();
    let mut queue: Vec<u32> = children.get(&root_pid).cloned().unwrap_or_default();
    let mut seen = std::collections::HashSet::new();
    while let Some(pid) = queue.pop() {
        if !seen.insert(pid) {
            continue;
        }
        result.push(pid);
        if let Some(children) = children.get(&pid) {
            queue.extend(children.iter().copied());
        }
    }
    result
}

// ═══════════════════════════════════════════════════════════════════════════
// 通用进程树强杀
// ═══════════════════════════════════════════════════════════════════════════

/// 递归收集 `root_pid` 的全部后代 PID（不包含 root 本身）。
pub fn collect_descendants(root_pid: u32) -> Vec<u32> {
    #[cfg(target_os = "windows")]
    {
        windows_descendants(root_pid)
    }
    #[cfg(not(target_os = "windows"))]
    {
        unix_descendants(root_pid)
    }
}

/// 强杀单个 PID。
#[cfg(target_os = "windows")]
fn force_kill_pid(pid: u32) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let _ = std::process::Command::new("taskkill")
        .args(["/F", "/T", "/PID", &pid.to_string()])
        .creation_flags(CREATE_NO_WINDOW)
        .status();
}

#[cfg(not(target_os = "windows"))]
fn force_kill_pid(pid: u32) {
    // 先 TERM，若进程是 shell/守护进程可能忽略；再 KILL 兜底
    let _ = std::process::Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .status();
    let _ = std::process::Command::new("kill")
        .args(["-KILL", &pid.to_string()])
        .status();
}

/// 跨平台强杀进程树（进程 + 全部后代）。
///
/// - Windows：递归枚举后代后逐个 taskkill /F /T（自身也带 /T，双保险），
///   不依赖一次性 `/T` 的树关系，reparent/detach 的子进程也能被杀到。
/// - Unix：递归枚举后代后逐个 kill -KILL，最后杀根进程；
///   不依赖进程组，孙进程也能被杀到。
pub fn kill_process_tree(pid: u32) {
    if pid == 0 {
        return;
    }
    // 先杀后代（深到浅：BFS 收集后逆序，先杀最深的）
    let descendants = collect_descendants(pid);
    for p in descendants.iter().rev() {
        force_kill_pid(*p);
    }
    // 最后杀根进程
    force_kill_pid(pid);
}
