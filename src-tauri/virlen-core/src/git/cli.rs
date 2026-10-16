//! git 子进程的**唯一封装**。
//!
//! ⚠️ 全项目只允许经 [`GitCmd`] 起 git，不得在别处 `Command::new("git")` —— 下面这些姿势
//! 少一样就是一个线上坑（见 `docs/git-management-plan.md` §6 / §7）：
//!
//! | 姿势 | 不做会怎样 |
//! |---|---|
//! | `GIT_TERMINAL_PROMPT=0` + `stdin(null)` | git 在**没人看得见的地方等输入**（要凭据时），界面表现为永久卡住 |
//! | Windows `CREATE_NO_WINDOW` | 每次调用闪一个黑框（GUI 进程起控制台程序） |
//! | 另开线程读走 stdout/stderr | 输出超过管道缓冲（64KB）时子进程写满即阻塞，我们又等它退出 → 死锁 |
//! | 超时 + cancel flag + 进程树回收 | 卡住的 git 收不回来；hook / credential helper 等**子进程**会残留 |
//! | 逐参数 `args([...])` + `--` 分隔 | 参数注入（分支名 / 路径以 `-` 开头会被当成选项） |
//! | 写操作用 [`GitCmd::write`] | 同一仓库并发写 → `index.lock exists` |
//!
//! 另外两条与「读输出」有关的口径：
//! - stdout 保留**原始字节**（[`GitOutput::stdout`]），解码由调用方决定（[`GitOutput::stdout_str`]）；
//! - stderr **原样透传**给用户，不解析它做分支判断（分类靠前置探测 + 退出码，见方案 §7 第 3 条）。

use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

/// 只读命令的默认超时（与 `search_files_by_name` 等既有命令的 30s 口径一致）。
/// 超大仓库的 `status` 是这条超时为谁而设的：宁可失败并报「超时」，也不把界面挂死。
pub const READ_TIMEOUT: Duration = Duration::from_secs(30);

/// 写命令的默认超时（`add` / `commit` / `switch` 在大仓库上会明显更慢；commit 还要跑 hooks）。
pub const WRITE_TIMEOUT: Duration = Duration::from_secs(60);

/// 轮询间隔：等子进程退出时的检查粒度，也是 cancel / 超时的响应精度。
const POLL_INTERVAL: Duration = Duration::from_millis(40);

/// git 调用失败（含超时 / 取消 / git 不存在）。
#[derive(Debug, Clone)]
pub struct GitError {
    /// 面向用户的简述（不含 stderr 原文）
    pub message: String,
    /// git 的原始 stderr（可能是空；**不加工、不翻译**）
    pub stderr: String,
    /// 退出码（超时 / 取消 / 未启动为 -1）
    pub code: i32,
}

impl std::fmt::Display for GitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)?;
        if !self.stderr.trim().is_empty() {
            write!(f, "\n{}", self.stderr.trim())?;
        }
        Ok(())
    }
}

impl std::error::Error for GitError {}

impl GitError {
    pub fn new(message: impl Into<String>) -> Self {
        Self { message: message.into(), stderr: String::new(), code: -1 }
    }
}

/// 单次 git 调用的结果。
#[derive(Debug)]
pub struct GitOutput {
    pub code: i32,
    /// 原始 stdout 字节（porcelain 输出是 UTF-8；**别按平台代码页解**，§11.1 的坑）
    pub stdout: Vec<u8>,
    /// stderr 已按 lossy UTF-8 解码（给用户看的）
    pub stderr: String,
}

impl GitOutput {
    pub fn ok(&self) -> bool {
        self.code == 0
    }

    /// stdout 按 UTF-8 解码（非法序列用替换字符，**不猜 GBK** —— 猜错会把路径写坏）
    pub fn stdout_str(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }

    /// 退出码非 0 时转成错误（stderr 原文带上）
    pub fn into_result(self, what: &str) -> Result<Self, GitError> {
        if self.ok() {
            Ok(self)
        } else {
            Err(GitError {
                message: format!("git {} 失败（退出码 {}）", what, self.code),
                stderr: self.stderr,
                code: self.code,
            })
        }
    }
}

/// 一条 git 命令（构建器）。用法：
/// ```ignore
/// GitCmd::read(repo).arg("status").arg("--porcelain=v2").run()?;
/// ```
pub struct GitCmd {
    dir: String,
    /// 子命令与它自己的参数（全局选项已由构造器放好）
    args: Vec<String>,
    timeout: Duration,
    /// 运行中随时被置位即中断（由 Tauri 命令壳接 `task_manager` 的 cancel flag）
    cancel: Option<std::sync::Arc<AtomicBool>>,
    /// 写操作 → 走 per-repo 串行队列（见 [`super::lock`]）
    write: bool,
    /// 要喂给 git 标准输入的内容（目前只有提交信息用它：走 stdin 避开 argv 的编码 / 换行差异）
    input: Option<Vec<u8>>,
}
impl GitCmd {
    /// 只读命令：带 `--no-optional-locks`（读的时候不去抢 index 锁，避免干扰用户在编辑器 / 终端里的 git）
    pub fn read(dir: &str) -> Self {
        Self {
            dir: dir.to_string(),
            args: vec![
                "-c".into(),
                "core.quotepath=false".into(),
                "--no-optional-locks".into(),
            ],
            timeout: READ_TIMEOUT,
            cancel: None,
            write: false,
            input: None,
        }
    }

    /// 写命令：**不**带 `--no-optional-locks`（写操作本来就该拿锁），并走 per-repo 串行队列
    pub fn write(dir: &str) -> Self {
        Self {
            dir: dir.to_string(),
            args: vec!["-c".into(), "core.quotepath=false".into()],
            timeout: WRITE_TIMEOUT,
            cancel: None,
            write: true,
            input: None,
        }
    }
    pub fn arg(mut self, a: impl Into<String>) -> Self {
        self.args.push(a.into());
        self
    }

    /// 追加一组位置参数（**每个元素逐个传参**，不是拼成一行给 shell）
    pub fn args<I, S>(mut self, list: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.args.extend(list.into_iter().map(Into::into));
        self
    }

    /// 路径参数：先补 `--` 再逐个追加，杜绝「路径以 `-` 开头被当成选项」
    pub fn paths<I, S>(mut self, list: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.args.push("--".into());
        self.args.extend(list.into_iter().map(Into::into));
        self
    }

    pub fn timeout(mut self, t: Duration) -> Self {
        self.timeout = t;
        self
    }

    pub fn cancel(mut self, flag: &std::sync::Arc<AtomicBool>) -> Self {
        self.cancel = Some(flag.clone());
        self
    }

    /// `Option` 形式（命令壳把 `task_manager` 的 cancel flag 一路带下来时用）
    pub fn cancel_opt(mut self, flag: Option<&std::sync::Arc<AtomicBool>>) -> Self {
        self.cancel = flag.cloned();
        self
    }

    /// 喂标准输入（内容写完即关管道 —— 不能只写不关，git 会一直等 EOF）
    pub fn stdin_bytes(mut self, data: Vec<u8>) -> Self {
        self.input = Some(data);
        self
    }

    /// 执行（写命令持 per-repo 锁）。
    pub fn run(self) -> Result<GitOutput, GitError> {
        if self.write {
            let key = self.dir.clone();
            crate::git::lock::with_repo_lock(&key, || self.run_inner())
        } else {
            self.run_inner()
        }
    }

    fn run_inner(self) -> Result<GitOutput, GitError> {
        let mut cmd = Command::new("git");
        cmd.current_dir(&self.dir).args(&self.args);
        exec(cmd, self.timeout, self.cancel.as_deref(), self.input)
    }
}

/// 直接跑一条 git（用于 `--version` 这种没有仓库上下文的场景）。
pub fn run_bare(args: &[&str], timeout: Duration) -> Result<GitOutput, GitError> {
    let mut cmd = Command::new("git");
    cmd.args(args);
    exec(cmd, timeout, None, None)
}

/// 统一的 spawn + 读管道 + 超时/取消 + 收尸。
fn exec(
    mut cmd: Command,
    timeout: Duration,
    cancel: Option<&AtomicBool>,
    input: Option<Vec<u8>>,
) -> Result<GitOutput, GitError> {
    cmd.stdin(if input.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    })
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
        // 要凭据时立刻失败，而不是在无人可见处等输入（fail-closed）
        .env("GIT_TERMINAL_PROMPT", "0")
        // 这三个变量若从父进程漏进来，`-C <dir>` 会被无视（git 会去操作另一个仓库）
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE");

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            GitError::new("未检测到 git：请先安装 Git 并确保它在 PATH 中")
        } else {
            GitError {
                message: format!("无法启动 git: {}", e),
                stderr: String::new(),
                code: -1,
            }
        }
    })?;

    let pid = child.id();
    let mut in_pipe = child.stdin.take();
    let mut out_pipe = child.stdout.take();
    let mut err_pipe = child.stderr.take();

    // 标准输入另开一线程写完即 drop（关管道）—— git 读到 EOF 才会开始干活；
    // 内容通常只有一条提交信息，写不完也绝不会卡住（管道有缓冲）。
    if let Some(data) = input {
        std::thread::spawn(move || {
            if let Some(p) = in_pipe.as_mut() {
                let _ = p.write_all(&data);
            }
            drop(in_pipe.take());
        });
    }

    // ⚠️ 必须另开线程持续读走管道：输出超过管道缓冲会写满，子进程随之阻塞，
    //    而我们正等着它退出 —— 那就是死锁（超大仓库的 status / checkout 输出很容易超 64KB）。
    let out_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(p) = out_pipe.as_mut() {
            let _ = p.read_to_end(&mut buf);
        }
        buf
    });
    let err_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(p) = err_pipe.as_mut() {
            let _ = p.read_to_end(&mut buf);
        }
        buf
    });

    let deadline = Instant::now() + timeout;
    let mut cancelled = false;
    let mut timed_out = false;
    let code: Option<i32> = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) => {}
            Err(_) => break None,
        }
        if cancel.map(|c| c.load(Ordering::SeqCst)).unwrap_or(false) {
            cancelled = true;
        } else if Instant::now() >= deadline {
            timed_out = true;
        }
        if cancelled || timed_out {
            // 先收进程树再收本体：hook / credential helper 这些**子进程**也持有管道，
            // 只 kill 本体的话下面的 join 会一直等它们松手。
            crate::agent::process_tree::kill_process_tree(pid);
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(POLL_INTERVAL);
    };

    let stdout = out_handle.join().unwrap_or_default();
    let stderr_bytes = err_handle.join().unwrap_or_default();
    let stderr = String::from_utf8_lossy(&stderr_bytes).into_owned();

    if cancelled {
        return Err(GitError {
            message: "git 操作已取消".into(),
            stderr: String::new(),
            code: -1,
        });
    }
    if timed_out {
        return Err(GitError {
            message: format!("git 操作超时（{}s）", timeout.as_secs()),
            stderr: String::new(),
            code: -1,
        });
    }

    Ok(GitOutput {
        // 信号终止（如被杀）时为 None —— 报成 -1，交由调用方按失败处理
        code: code.unwrap_or(-1),
        stdout,
        stderr,
    })
}
