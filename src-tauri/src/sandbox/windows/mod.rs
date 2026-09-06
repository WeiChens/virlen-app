//! Windows 沙盒实现：受限令牌（WRITE_RESTRICTED）+ NTFS ACL + Job Object。
//!
//! 二改自 sandbox-win，对应 codex legacy 免提权后端。
//!
//! 安全机制：
//!   能力 SID(cap.rs) + WRITE_RESTRICTED 受限令牌(token.rs) + NTFS ACL(acl.rs)
//!   + CreateProcessAsUserW 拉起子进程(spawn.rs)。
//!
//! 语义：
//!   - 子进程令牌是当前用户令牌的受限派生，写入任何对象都必须命中
//!     restricting SID 中某个 SID 的 Allow-Write ACE；
//!   - 只有「可写根」目录的 ACL 被授予了随机的「工作区能力 SID」，
//!     因此子进程只能写这些目录（及其继承的子路径）；
//!   - 可写根内部的保护子路径(.git/.codex/.agents 等)额外添加 Deny-Write ACE；
//!   - 令牌只保留 SeChangeNotifyPrivilege，其余特权全部禁用；
//!   - 子进程纳入带 KILL_ON_JOB_CLOSE 的 Job Object：命令正常结束后若仍残留后台
//!     子进程（如 `cmd /c "start server.exe"`），会随 Job 句柄关闭被连带终止。
//!     这是**故意为之**——沙盒不允许逃逸后台进程；与裸跑路径 ProcessTreeGuard 的
//!     「保留后台进程」语义不同。

pub mod acl;
pub mod cap;
pub mod spawn;
pub mod token;

mod runner;
pub use runner::SandboxSession;

pub use spawn::SandboxChild;

/// 私有桌面（与受限令牌无关，这里固定指向交互桌面；私有桌面属于阶段3）。
pub const INTERACTIVE_DESKTOP: &str = "Winsta0\\Default";

/// 沙盒诊断信息（供 sandbox_diagnostics 命令返回）。
#[derive(serde::Serialize)]
pub struct SandboxDiagnostics {
    pub state_dir: String,
    pub cap_sid_file_exists: bool,
    pub readonly_cap_sid: String,
    pub workspace_cap_sids: std::collections::BTreeMap<String, String>,
    pub writable_root_cap_sids: std::collections::BTreeMap<String, String>,
    pub env_override: Option<String>,
}

/// 收集沙盒诊断：状态目录、能力 SID、环境变量覆盖（只读，无副作用）。
pub fn diagnostics() -> SandboxDiagnostics {
    let state_dir = crate::sandbox::state::SandboxState::default_dir();
    let cap_file = cap::cap_sid_file(&state_dir);
    let cap_file_exists = cap_file.exists();
    let caps = std::fs::read_to_string(&cap_file)
        .ok()
        .and_then(|txt| serde_json::from_str::<cap::CapSids>(&txt).ok())
        .unwrap_or_default();
    SandboxDiagnostics {
        state_dir: state_dir.to_string_lossy().to_string(),
        cap_sid_file_exists: cap_file_exists,
        readonly_cap_sid: caps.readonly,
        workspace_cap_sids: caps.workspace_by_cwd.into_iter().collect(),
        writable_root_cap_sids: caps.writable_root_by_path.into_iter().collect(),
        env_override: std::env::var("VIRLEN_SANDBOX").ok(),
    }
}

#[cfg(test)]
mod tests;
