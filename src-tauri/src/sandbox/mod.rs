//! 终端执行安全沙盒（OS 级写隔离）。
//!
//! 平台实现：
//!   - Windows: 受限令牌（WRITE_RESTRICTED）+ NTFS ACL + Job Object（见 `windows/`）
//!   - Linux:   Landlock LSM（见 `linux/`）
//!   - macOS:   sandbox-exec + Seatbelt profile（见 `macos/`）
//!
//! 各平台实现等价的安全目标：
//!   - 子进程只能写「可写根」目录（cwd + extra_roots），区外写入被 OS 层拒绝；
//!   - 可写根内部的保护子路径(.git/.codex/.agents 等)不可写；
//!   - readonly 模式：不授予任何写根，连 cwd 都不可写。

use std::path::PathBuf;

pub mod paths;
pub mod state;

#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;

#[cfg(target_os = "windows")]
#[allow(unused_imports)]
pub use windows::{SandboxSession, SandboxChild};
#[cfg(target_os = "linux")]
#[allow(unused_imports)]
pub use linux::{SandboxSession, SandboxChild};
#[cfg(target_os = "macos")]
#[allow(unused_imports)]
pub use macos::{SandboxSession, SandboxChild};

#[cfg(target_os = "windows")]
#[allow(unused_imports)]
pub use windows::{diagnostics, SandboxDiagnostics};

/// 一次沙盒执行的请求描述（跨平台）。
#[derive(Debug, Clone)]
pub struct SandboxRequest {
    /// 命令工作目录 = 主可写根。
    pub cwd: PathBuf,
    /// 附加可写根。
    pub extra_roots: Vec<PathBuf>,
    /// 附加 deny-write 绝对路径（不存在则创建，防止沙盒先写再被保护）。
    pub protect: Vec<PathBuf>,
    /// 只读模式：不授予任何写根能力。
    pub readonly: bool,
}

/// 免提权后端默认保护的可写根内部子路径名。
pub const DEFAULT_PROTECTED_SUBDIRS: &[&str] = &[".git", ".hg", ".svn", ".codex", ".agents"];
