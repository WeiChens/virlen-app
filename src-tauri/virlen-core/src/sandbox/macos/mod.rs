//! macOS 沙盒实现（sandbox-exec + Seatbelt profile）。
//!
//! macOS 没有类似 Linux Landlock 的无特权内核 API，这里复用系统内置的
//! `sandbox-exec`（Seatbelt）以 `.sb` profile 限制子进程文件写入。
//!
//! 注意：`sandbox-exec` 已被 Apple 标记 deprecated，但在 Sonoma/Sequoia 上仍可用；
//! 缺失/被移除时 `prepare` 返回 Err，上层降级裸跑。
//!
//! 语义（与 Windows/Linux 等价）：
//!   - `(deny default)` 默认拒绝一切，再逐条 `(allow ...)` 放行；
//!   - 全机可读，仅可写根（workspace + extra_roots）+ 临时目录可写；
//!   - readonly 模式不授予任何可写根。
//!
//! 注意：readonly 模式下仍保留 `/private/tmp`、`/var/folders` 的写权限（编译器/包管理器
//! 需要临时目录），因此不是严格意义上的「整个系统只读」，只是「不授予任何业务写根」。

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

use anyhow::{bail, Context, Result};

use crate::sandbox::paths::canonicalize_path;
use crate::sandbox::state::SandboxState;
use crate::sandbox::{SandboxRequest, DEFAULT_PROTECTED_SUBDIRS};

const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

/// macOS 沙盒会话。
pub struct SandboxSession {
    pub cwd: PathBuf,
    pub readonly: bool,
    profile_path: PathBuf,
}

/// macOS 沙盒子进程。
pub struct SandboxChild {
    pub pid: u32,
    pub stdout: Option<std::fs::File>,
    pub stderr: Option<std::fs::File>,
    child: Arc<Mutex<Option<std::process::Child>>>,
}

impl SandboxSession {
    pub fn prepare(req: &SandboxRequest, state: &SandboxState) -> Result<Self> {
        if !Path::new(SANDBOX_EXEC).exists() {
            bail!("sandbox-exec not found (deprecated/removed on this macOS)");
        }

        let cwd = dunce::canonicalize(&req.cwd)
            .with_context(|| format!("cwd {} does not exist", req.cwd.display()))?;
        if !cwd.is_dir() {
            bail!("cwd is not a directory: {}", cwd.display());
        }

        // 收集可写根（去重）。
        let mut write_roots: Vec<PathBuf> = Vec::new();
        let mut seen = std::collections::BTreeSet::new();
        let mut push = |p: PathBuf| {
            let key = crate::sandbox::paths::canonical_path_key(&p);
            if seen.insert(key) {
                write_roots.push(p);
            }
        };
        push(cwd.clone());
        for extra in &req.extra_roots {
            let canon = dunce::canonicalize(extra)
                .with_context(|| format!("extra root {} does not exist", extra.display()))?;
            if !canon.is_dir() {
                bail!("extra root is not a directory: {}", canon.display());
            }
            push(canon);
        }

        // 保护路径（deny-write）：显式 protect + 各可写根内的默认保护子目录
        // （.git/.hg/.svn/.codex/.agents/.virlen-sandbox），仅规范化已存在的路径。
        let mut protect: BTreeSet<PathBuf> = BTreeSet::new();
        for p in &req.protect {
            if p.exists() {
                protect.insert(canonicalize_path(p));
            }
        }
        for root in &write_roots {
            for name in DEFAULT_PROTECTED_SUBDIRS {
                let candidate = root.join(name);
                if candidate.exists() {
                    protect.insert(canonicalize_path(&candidate));
                }
            }
        }
        let protect: Vec<PathBuf> = protect.into_iter().collect();

        // 惰性清理历史遗留 profile：spawn 后立即删文件会与 sandbox-exec 读文件竞态，
        // 因此不随 session drop 删除，而是每次 prepare 时回收过期的旧文件。
        gc_stale_profiles(&state.state_dir);

        // 生成 profile 文件（状态目录内，进程+纳秒保证唯一）。
        let profile = build_profile(&write_roots, &protect, req.readonly);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let profile_path = state
            .state_dir
            .join(format!("seatbelt-{}-{}.sb", std::process::id(), nanos));
        std::fs::write(&profile_path, &profile)
            .with_context(|| format!("write profile {}", profile_path.display()))?;

        Ok(Self {
            cwd,
            readonly: req.readonly,
            profile_path,
        })
    }

    pub fn spawn(
        &self,
        command: &[String],
        _raw_cmdline: Option<&str>,
        env_extra: &BTreeMap<String, String>,
    ) -> Result<SandboxChild> {
        if command.is_empty() {
            bail!("empty command");
        }

        let mut cmd = Command::new(SANDBOX_EXEC);
        cmd.arg("-f").arg(&self.profile_path);
        cmd.arg("--");
        cmd.arg(&command[0]);
        cmd.args(&command[1..]);
        cmd.current_dir(&self.cwd);
        for (k, v) in env_extra {
            cmd.env(k, v);
        }
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        let mut child = cmd.spawn().context("spawn sandbox-exec")?;
        let pid = child.id();
        let stdout = child
            .stdout
            .take()
            .map(|s| std::fs::File::from(std::os::fd::OwnedFd::from(s)));
        let stderr = child
            .stderr
            .take()
            .map(|s| std::fs::File::from(std::os::fd::OwnedFd::from(s)));
        Ok(SandboxChild {
            pid,
            stdout,
            stderr,
            child: Arc::new(Mutex::new(Some(child))),
        })
    }
}

impl SandboxChild {
    pub fn pid(&self) -> u32 {
        self.pid
    }

    pub fn terminate(&self) {
        crate::agent::process_tree::kill_process_tree(self.pid);
    }

    pub fn wait_and_read_exit_code(&self) -> Option<i32> {
        let mut guard = self.child.lock().ok()?;
        guard.as_mut()?.wait().ok()?.code()
    }

    pub fn read_exit_code(&self) -> Option<i32> {
        let mut guard = self.child.lock().ok()?;
        guard.as_mut()?.try_wait().ok().flatten().and_then(|s| s.code())
    }
}

/// 生成 Seatbelt profile 文本。
///
/// 写隔离：`(deny default)` + 全机可读 + 仅可写根/临时目录可写。
/// 注意：
///   - 可写根路径直接拼进 `(subpath "...")`，workspace 路径通常不含双引号；
///   - Seatbelt 同一规则内多个 filter 默认按 AND 组合，因此临时目录的两条 subpath
///     拆成两条独立 allow 规则（否则会退化为「既在 /private/tmp 又在 /var/folders」
///     的空集，导致临时目录反而不可写）。
fn build_profile(write_roots: &[PathBuf], protect: &[PathBuf], readonly: bool) -> String {
    let mut lines: Vec<String> = vec![
        "(version 1)".to_string(),
        "(deny default)".to_string(),
        "(allow process*)".to_string(),
        "(allow signal (target self))".to_string(),
        "(allow mach*)".to_string(),
        "(allow sysctl-read)".to_string(),
        // 全机可读（枚举路径会导致 SIGABRT，因此用整机可读兜底）。
        "(allow file-read* (subpath \"/\"))".to_string(),
        // 临时目录可写（编译器/包管理器需要）。
        "(allow file-read* file-write* (subpath \"/private/tmp\"))".to_string(),
        "(allow file-read* file-write* (subpath \"/var/folders\"))".to_string(),
    ];

    if !readonly {
        for root in write_roots {
            lines.push(format!(
                "(allow file-read* file-write* (subpath \"{}\"))",
                root.display()
            ));
        }
    }

    for p in protect {
        lines.push(format!(
            "(deny file-write* (subpath \"{}\"))",
            p.display()
        ));
    }

    lines.push("(allow network*)".to_string());
    lines.join("\n") + "\n"
}

/// 回收状态目录中过期的 Seatbelt profile 文件（`seatbelt-*.sb`）。
///
/// profile 不能随 session drop 立即删除：`spawn()` 返回时 `sandbox-exec` 可能尚未读完
/// profile 文件，立即删除会产生竞态。因此改为惰性 GC——只删除超过 1 小时的旧文件，
/// 正常运行中的沙盒完全不受影响。
fn gc_stale_profiles(state_dir: &Path) {
    let Ok(entries) = std::fs::read_dir(state_dir) else {
        return;
    };
    let now = std::time::SystemTime::now();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if !name.starts_with("seatbelt-") || !name.ends_with(".sb") {
            continue;
        }
        if let Ok(meta) = entry.metadata() {
            if let Ok(modified) = meta.modified() {
                if let Ok(age) = now.duration_since(modified) {
                    if age > std::time::Duration::from_secs(3600) {
                        let _ = std::fs::remove_file(entry.path());
                    }
                }
            }
        }
    }
}
