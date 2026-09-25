//! Linux 沙盒实现（Landlock LSM，无特权文件系统写隔离）。
//!
//! 使用内核 Landlock（Linux 5.13+）：默认拒绝被 handle 的写权限，
//! 仅对「可写根」目录授予写访问，实现与 Windows 受限令牌等价的安全目标。
//!
//! 流程：
//!   prepare()  在父进程规范化路径、收集可写根；
//!   spawn()    在父进程构建 Landlock ruleset，经 `pre_exec` 在子进程
//!              （fork 后、exec 前）调用 `restrict_self()` 生效，再 exec 目标命令。

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

use anyhow::{bail, Context, Result};
use landlock::{path_beneath_rules, ABI, AccessFs, Ruleset, RulesetAttr, RulesetCreatedAttr};

use crate::sandbox::state::SandboxState;
use crate::sandbox::SandboxRequest;

/// Linux 沙盒会话。
pub struct SandboxSession {
    pub cwd: PathBuf,
    pub readonly: bool,
    write_roots: Vec<PathBuf>,
}

/// Linux 沙盒子进程。
pub struct SandboxChild {
    pub pid: u32,
    pub stdout: Option<std::fs::File>,
    pub stderr: Option<std::fs::File>,
    child: Arc<Mutex<Option<std::process::Child>>>,
}

impl SandboxSession {
    pub fn prepare(req: &SandboxRequest, _state: &SandboxState) -> Result<Self> {
        let cwd = dunce::canonicalize(&req.cwd)
            .with_context(|| format!("cwd {} does not exist", req.cwd.display()))?;
        if !cwd.is_dir() {
            bail!("cwd is not a directory: {}", cwd.display());
        }

        // 收集可写根（去重）。
        let mut roots: Vec<PathBuf> = Vec::new();
        let mut seen = std::collections::BTreeSet::new();
        let mut push = |p: PathBuf| {
            let key = crate::sandbox::paths::canonical_path_key(&p);
            if seen.insert(key) {
                roots.push(p);
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

        // readonly 模式：不授予任何写根，所有写被 Landlock 拒绝。
        let write_roots = if req.readonly { Vec::new() } else { roots };

        Ok(Self {
            cwd,
            readonly: req.readonly,
            write_roots,
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

        // 1) 父进程构建 Landlock ruleset（默认拒绝写，白名单授予可写根）。
        let ruleset = build_ruleset(&self.write_roots)?;

        // 2) 构造命令。
        let mut cmd = Command::new(&command[0]);
        cmd.args(&command[1..]);
        cmd.current_dir(&self.cwd);
        for (k, v) in env_extra {
            cmd.env(k, v);
        }
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        // 3) 子进程（fork 后、exec 前）应用 Landlock。
        //    restrict_self 只做系统调用；失败路径用 from_raw_os_error 避免 fork 后堆分配。
        use std::os::unix::process::CommandExt;
        let mut ruleset = Some(ruleset);
        // SAFETY: 闭包仅在 fork 出的子进程执行一次，内部只调用 landlock_restrict_self。
        unsafe {
            cmd.pre_exec(move || match ruleset.take() {
                Some(rs) => rs
                    .restrict_self()
                    .map(|_| ())
                    .map_err(|_| std::io::Error::from_raw_os_error(libc::EPERM)),
                None => Err(std::io::Error::from_raw_os_error(libc::EPERM)),
            });
        }

        // 4) spawn。
        let mut child = cmd.spawn().context("spawn sandboxed process")?;
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

/// 构建 Landlock ruleset：handle 所有写权限，对每个可写根授予写权限。
fn build_ruleset(write_roots: &[PathBuf]) -> Result<landlock::RulesetCreated> {
    // ABI V1（Linux 5.13）为最大兼容基线；crate 默认 best-effort 会按内核能力降级。
    let abi = ABI::V1;
    let write_access = AccessFs::from_write(abi);

    let ruleset = Ruleset::default()
        .handle_access(write_access)
        .map_err(|e| anyhow::anyhow!("landlock handle_access failed: {e}"))?;

    let created = ruleset
        .create()
        .map_err(|e| anyhow::anyhow!("landlock create failed: {e}"))?;

    if write_roots.is_empty() {
        return Ok(created);
    }

    created
        .add_rules(path_beneath_rules(write_roots.iter(), write_access))
        .map_err(|e| anyhow::anyhow!("landlock add_rules failed: {e}"))
}
