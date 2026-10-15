//! 终端执行安全沙盒（OS 级写隔离）。
//!
//! 平台实现：
//!   - Windows: 受限令牌（WRITE_RESTRICTED）+ NTFS ACL + Job Object（见 `windows/`）
//!   - Linux:   Landlock LSM（见 `linux/`）
//!   - macOS:   sandbox-exec + Seatbelt profile（见 `macos/`）
//!
//! 各平台实现等价的安全目标：
//!   - 子进程只能写「可写根」目录（cwd + extra_roots），区外写入被 OS 层拒绝；
//!   - 默认模式（写隔离）下额外**恒定**授予平台临时目录（见 `temp_write_roots`）；
//!   - 可写根内部的保护子路径(.git/.codex/.agents 等)不可写；
//!   - readonly 模式：不授予任何写根，连 cwd 都不可写。

use std::path::{Path, PathBuf};

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

/// Step 1（PTY 改造）：伪控制台（ConPTY）对外入口。
///
/// `windows` 子模块本身是**平台实现细节**（私有），这里只导出「执行器」与
/// 「PTY 会话注册表」需要的最小面，避免把整个 windows 模块提升为 crate 可见。
#[cfg(target_os = "windows")]
pub(crate) mod pty {
    pub use super::windows::conpty::{resize_raw, PseudoConsole, DEFAULT_COLS, DEFAULT_ROWS};
    pub use super::windows::spawn::{create_bare_process_pty, current_env};
    pub use super::windows::INTERACTIVE_DESKTOP;
}

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
pub const DEFAULT_PROTECTED_SUBDIRS: &[&str] =
    &[".git", ".hg", ".svn", ".codex", ".agents", ".virlen-sandbox"];

/// 默认模式（写隔离）下**恒定**授予写权限的平台临时目录。
///
/// 为什么恒定授予：编译器 / 包管理器 / 各类工具都会写临时目录（`%TEMP%`、`/tmp`），
/// 而它几乎不可能落在工作目录或白名单里 —— 不授予就等于让 `cargo build`、`pip install`
/// 这类命令在沙盒里莫名失败。macOS 的 Seatbelt profile 一直如此（恒定放行
/// `/private/tmp` + `/var/folders`，连 readonly 也放行），这里把 Windows / Linux 对齐到同一语义。
///
/// 取舍：临时目录内容按定义可丢弃（不构成「误删用户资产」风险），且读权限在所有平台
/// 都不受写沙盒限制，因此「临时目录不当工作区用」这条隔离线让位于「命令能正常跑」。
/// 包管理器**缓存**（`~/.npm` / pnpm store / `~/.cargo`…）不在此列，仍须走白名单或忽略规则。
///
/// 两条边界：
///   - 只返回**存在**的目录：不存在的路径不进写根，避免 prepare 因路径缺失整体降级裸跑；
///   - **`cwd` 落在某临时目录内部的，该目录一律不授予**：那等于把工作目录的父级整片开放
///     （临时目录里可能另有别人的工作区），与 `collect_extra_roots` 跳过白名单祖先目录同一条规则；
///     隔离边界优先于「临时目录可写」，此时行为与改造前一致。
///
/// readonly 模式不使用本函数（不授予任何写根）。
pub fn temp_write_roots(cwd: &Path) -> Vec<PathBuf> {
    temp_write_roots_impl()
        .into_iter()
        .filter(|p| p.is_dir() && !paths::root_contains_path(p, cwd))
        .collect()
}

#[cfg(target_os = "windows")]
fn temp_write_roots_impl() -> Vec<PathBuf> {
    // %TEMP%（缺失时 std 自动回退 %TMP% / %USERPROFILE%\AppData\Local\Temp）。
    vec![std::env::temp_dir()]
}

#[cfg(target_os = "linux")]
fn temp_write_roots_impl() -> Vec<PathBuf> {
    // $TMPDIR（缺省 /tmp）+ /var/tmp（FHS 的跨重启临时区，工具在 /tmp 满时会退到这里）。
    vec![std::env::temp_dir(), PathBuf::from("/var/tmp")]
}

#[cfg(target_os = "macos")]
fn temp_write_roots_impl() -> Vec<PathBuf> {
    // macOS 的临时目录已由 Seatbelt profile 恒定放行（/private/tmp + /var/folders，
    // readonly 下亦然），这里不再重复列为写根，免得同一件事两处规则各说各话。
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 进写根的临时目录必须真实存在（prepare 对不存在的 extra root 会整体失败）。
    #[test]
    fn temp_write_roots_are_existing_dirs() {
        for p in temp_write_roots(Path::new("/")) {
            assert!(p.is_dir(), "临时写根必须存在: {}", p.display());
        }
    }

    /// Windows / Linux 靠这张表拿写权限；macOS 走 profile（返回空是预期）——
    /// cwd 取文件系统根（永不在临时目录内），故三平台之外的断言必须成立。
    #[cfg(not(target_os = "macos"))]
    #[test]
    fn temp_write_roots_present_when_cwd_is_outside_temp() {
        assert!(
            !temp_write_roots(Path::new("/")).is_empty(),
            "默认模式必须给临时目录留写根"
        );
    }

    /// 回归：cwd 长在临时目录里（本机单测的 TestEnv 就是 `%TEMP%\…`）时，
    /// 绝不能把整个临时目录当成写根 —— 否则工作目录的兄弟目录全部可写。
    #[test]
    fn temp_write_roots_skip_temp_dirs_containing_cwd() {
        let nested = std::env::temp_dir().join(format!("virlen_tmp_root_{}", std::process::id()));
        std::fs::create_dir_all(&nested).expect("create nested cwd");
        let roots = temp_write_roots(&nested);
        for root in &roots {
            assert!(
                !paths::root_contains_path(root, &nested),
                "包含 cwd 的临时目录不该进写根: {}",
                root.display()
            );
        }
        assert!(
            !roots.iter().any(|p| paths::same_path_key(p, &std::env::temp_dir())),
            "cwd 的临时目录祖先必须被排除: {}",
            std::env::temp_dir().display()
        );
        let _ = std::fs::remove_dir_all(&nested);
    }
}
