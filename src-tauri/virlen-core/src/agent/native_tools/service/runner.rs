//! service — 后台服务运行器：spawn（沙盒 / 裸跑双路径）+ 常驻读任务 + 常驻等待任务。
//!
//! 与 `execute/common/runner` 的关系：**同源不同寿命**。这里的 spawn、shell 选择、环境变量注入、
//! 沙盒会话准备、Job Object 落组都与命令执行共用（`prepare_sandbox_session` / `ProcessTreeGuard` /
//! `TerminalDecoder`），差别只有一个 —— **工具返回后进程继续活着**：
//!
//! - 两条常驻读任务（stdout / stderr）阻塞读到 EOF，把解码后的文本推进 `ServiceState` 的输出窗口；
//! - 一条常驻等待任务蹲在进程退出上，把退出码落成终态；
//! - 工具侧只等「状态变化 / 等待窗口到点 / 用户取消」，到点就把 `Arc` 交回注册表走人。
//!
//! ⚠️ 因此**不要**把「工具结束就杀进程」那套收尾带进来（只注销前端终止按钮的注册表项）。
//!
//! **两条 spawn 路径**（P3）：
//! - Windows：**伪控制台（ConPTY）** —— 服务跑在真终端里，用户在面板弹窗里能直接敲键盘
//!   （`pty.rs` 的句柄挂在条目上）；伪控制台建不起来 / spawn 失败 → 降级回匿名管道（只是不能交互）；
//! - 其他平台：匿名管道（Unix PTY 尚未接入）。

use std::collections::BTreeMap;
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use crate::agent::native_tools::execute::common::{
    kill_process_tree, prepare_sandbox_session, register_running_command, sandbox_mode,
    unregister_running_command, SandboxBypass, SandboxMode, TerminalDecoder, Terminator,
};

use super::super::{NativeToolCtx, NativeToolOutcome};
use super::common::status;
use super::pty::ServicePty;
use super::registry::{ServiceEntry, ServiceState};

/// 等待窗口内的状态轮询间隔（「状态已变」的兜底：`Notify` 解决延迟，轮询解决「通知发在注册前」的竞态）。
pub(super) const STATUS_TICK: Duration = Duration::from_millis(50);

/// 一次成功 spawn 的结果（交给 [`supervise`] 长期接管）。
pub(super) struct Spawned {
    /// 进程 pid（「启动失败」这种情况不会走到这里）
    pub(super) pid: u32,
    /// 本次实际沙盒模式（`uiData.sandbox` 词表）
    pub(super) sandbox: &'static str,
    /// 首行环境提示（模型侧英文）
    pub(super) env_note: String,
    pub(super) stdout: Option<Box<dyn Read + Send>>,
    pub(super) stderr: Option<Box<dyn Read + Send>>,
    /// 终止器（已捕获 Job / 沙盒子进程句柄）
    pub(super) terminator: Terminator,
    /// 阻塞等待退出码（在常驻任务里跑一次）
    pub(super) wait: Box<dyn FnOnce() -> Option<i32> + Send>,
    /// 交互控制台（伪控制台，P3）：`None` = 该服务跑在管道下（非 Windows / 伪控制台不可用）
    pub(super) console: Option<Arc<ServicePty>>,
}

/// 启动一个后台服务进程（平台分发）。
///
/// - **Windows**：优先伪控制台路径（[`spawn_service_pty`]，服务可交互）；伪控制台建不起来 /
///   spawn 失败 → 降级回匿名管道（与命令路径同一条降级策略：语义不丢，只是不能交互）；
/// - **其他平台**：匿名管道。
///
/// 两条路径的沙盒策略完全一致（同一个设置项、同一份实现、同一套降级），见 [`spawn_service_pipes`]。
pub(super) async fn spawn_service(
    ctx: &NativeToolCtx<'_>,
    cmd_str: &str,
    bypass: SandboxBypass,
) -> Result<Spawned, String> {
    #[cfg(target_os = "windows")]
    {
        match spawn_service_pty(ctx, cmd_str, bypass).await {
            Ok(spawned) => return Ok(spawned),
            Err(e) => eprintln!("[pty] service degraded to pipes: {e}"),
        }
    }
    spawn_service_pipes(ctx, cmd_str, bypass).await
}

/// 管道路径（非 Windows 的唯一路径；Windows 上作为伪控制台不可用时的降级）。
///
/// 路径选择与 `execute_command` **完全一致**（同一个设置项、同一份沙盒实现）：
/// 1. `bypass`（AI 传 `sandbox:"off"` 或命中忽略规则）→ 裸跑；
/// 2. 沙盒模式 `off` → 裸跑（`no_sandbox_disabled`）；
/// 3. 其余 → 沙盒（受限令牌 + 写隔离；`readonly` 则完全不可写）；
/// 4. 沙盒 prepare / spawn 失败 → 降级裸跑（`no_sandbox_degraded`，与命令路径同策略）。
async fn spawn_service_pipes(
    ctx: &NativeToolCtx<'_>,
    cmd_str: &str,
    bypass: SandboxBypass,
) -> Result<Spawned, String> {
    let bypass_sandbox = bypass.is_bypass();
    let mut sandbox_degraded = false;
    if !bypass_sandbox && sandbox_mode(ctx) != SandboxMode::Off {
        match spawn_sandboxed(ctx, cmd_str).await {
            Ok(spawned) => return Ok(spawned),
            Err(e) => {
                // 与命令路径同一条降级策略：沙盒不可用时裸跑，并把「已降级」如实写进结果。
                eprintln!("[sandbox] service degraded to bare run: {e}");
                sandbox_degraded = true;
            }
        }
    }
    spawn_bare(ctx, cmd_str, bypass, sandbox_degraded)
}

/// 沙盒路径（受限令牌 + 写隔离）。
async fn spawn_sandboxed(ctx: &NativeToolCtx<'_>, cmd_str: &str) -> Result<Spawned, String> {
    let readonly_mode = sandbox_mode(ctx) == SandboxMode::Readonly;
    // ⚠️ Windows 沙盒进程跑在受限令牌下，PowerShell 进入约束语言模式（CLM）：
    // `[Console]::OutputEncoding = ...` 会被拒绝，故这里**不加** UTF-8 前缀
    //（与 `run_command_sandboxed` 一字不差；中文靠解码器的 GBK 兜底）。
    #[cfg(target_os = "windows")]
    let (shell, args): (&str, Vec<String>) = (
        "powershell",
        vec!["-NoProfile".into(), "-Command".into(), cmd_str.to_string()],
    );
    #[cfg(target_os = "macos")]
    let (shell, args): (&str, Vec<String>) = ("zsh", vec!["-c".into(), cmd_str.to_string()]);
    #[cfg(target_os = "linux")]
    let (shell, args): (&str, Vec<String>) = ("sh", vec!["-c".into(), cmd_str.to_string()]);

    let session = prepare_sandbox_session(ctx).await?;
    let argv: Vec<String> = std::iter::once(shell.to_string())
        .chain(args.iter().cloned())
        .collect();
    let env_extra = service_env_extra(ctx);
    let mut child = session
        .spawn(&argv, None, &env_extra)
        .map_err(|e| format!("sandbox spawn failed: {e}"))?;
    // 令牌不再需要（子进程已经起来了），尽早关闭；子进程由下面的常驻任务照看。
    drop(session);

    let pid = child.pid();
    let stdout = child.stdout.take().map(|f| Box::new(f) as Box<dyn Read + Send>);
    let stderr = child.stderr.take().map(|f| Box::new(f) as Box<dyn Read + Send>);
    let child = Arc::new(child);
    let child_for_kill = child.clone();
    let terminator: Terminator = Arc::new(move || child_for_kill.terminate());
    let wait: Box<dyn FnOnce() -> Option<i32> + Send> =
        Box::new(move || child.wait_and_read_exit_code());

    let sandbox = if readonly_mode {
        "readonly"
    } else {
        "write_isolation"
    };
    let env_note = env_note(ctx, shell, sandbox);
    Ok(Spawned {
        pid,
        sandbox,
        env_note,
        stdout,
        stderr,
        terminator,
        wait,
        console: None,
    })
}

/// 裸跑路径（无沙盒）。
fn spawn_bare(
    ctx: &NativeToolCtx<'_>,
    cmd_str: &str,
    bypass: SandboxBypass,
    sandbox_degraded: bool,
) -> Result<Spawned, String> {
    let bypass_sandbox = bypass.is_bypass();
    let platform = std::env::consts::OS;
    // ⚠️ 与裸跑命令路径同源同序（改一处要改两处：`runner/pipes.rs` 的 `sandbox_kind` 判定）
    let sandbox = if bypass_sandbox {
        if matches!(bypass, SandboxBypass::Rule) {
            "no_sandbox_rule"
        } else {
            "no_sandbox_bypass"
        }
    } else if sandbox_mode(ctx) == SandboxMode::Off {
        "no_sandbox_disabled"
    } else if sandbox_degraded {
        "no_sandbox_degraded"
    } else {
        "no_sandbox"
    };

    let (shell, args): (&str, Vec<String>) = if platform == "windows" {
        // 服务与命令用同一套 shell 选择：Windows 统一 Windows PowerShell 5.1。
        // 先切 UTF-8 输出，避免中文系统默认 GBK 使管道输出乱码（服务有充足时间跑这条语句）。
        let prefixed = format!(
            "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; {}",
            cmd_str
        );
        (
            "powershell",
            vec!["-NoProfile".into(), "-Command".into(), prefixed],
        )
    } else if platform == "macos" {
        ("zsh", vec!["-c".into(), cmd_str.to_string()])
    } else {
        ("sh", vec!["-c".into(), cmd_str.to_string()])
    };

    let mut cmd = std::process::Command::new(shell);
    cmd.args(&args);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // 隐藏控制台窗口（与 kill_process_tree / load_env / pipes 一致）
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    // 服务不读 stdin：给它一个空流，避免它以为自己能拿到输入而卡在提示符上。
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    if !ctx.security.workspace.is_empty() {
        cmd.current_dir(&ctx.security.workspace);
    }
    for (k, v) in service_env_extra(ctx) {
        cmd.env(k, v);
    }

    let mut child = cmd.spawn().map_err(|e| format!("[{shell} error] {e}"))?;
    let pid = child.id();

    // Job Object（**带 KILL_ON_JOB_CLOSE**）：一键杀整棵树，且应用崩溃/被强杀时不留孤儿服务。
    let guard = crate::agent::process_tree::ProcessTreeGuard::create_kill_on_close().map(Arc::new);
    if let Some(g) = &guard {
        let _ = g.assign_pid(pid);
    }
    let guard_for_kill = guard.clone();
    let terminator: Terminator = Arc::new(move || {
        if let Some(g) = &guard_for_kill {
            g.terminate();
        }
        kill_process_tree(pid);
    });

    let stdout = child.stdout.take().map(|f| Box::new(f) as Box<dyn Read + Send>);
    let stderr = child.stderr.take().map(|f| Box::new(f) as Box<dyn Read + Send>);
    let wait: Box<dyn FnOnce() -> Option<i32> + Send> = Box::new(move || {
        let mut child = child;
        child.wait().ok().and_then(|s| s.code())
    });

    let env_note = env_note(ctx, shell, sandbox);

    Ok(Spawned {
        pid,
        sandbox,
        env_note,
        stdout,
        stderr,
        terminator,
        wait,
        console: None,
    })
}

/// 环境提示首行（模型侧英文）—— 管道 / 伪控制台两条路径**共用同一份**（避免措辞在两处漂移）。
///
/// 与命令路径（`execute/common/runner`）的措辞只差沙盒分支里的 `(background service)` 标注：
/// 服务是常驻的，模型需要知道「这条命令不会自己结束」。
fn env_note(ctx: &NativeToolCtx<'_>, shell: &str, sandbox: &str) -> String {
    match sandbox {
        "readonly" => format!("Terminal environment: {shell} · read-only (no writes)"),
        "write_isolation" => {
            if ctx.security.workspace.is_empty() {
                format!("Terminal environment: {shell} · write isolation (background service)")
            } else {
                format!(
                    "Terminal environment: {shell} · write isolation (writable roots: {}; writes outside are rejected)",
                    ctx.security.workspace
                )
            }
        }
        "no_sandbox_rule" => format!(
            "Terminal environment: {shell} · no sandbox (matched ignore rule, full permissions)"
        ),
        "no_sandbox_bypass" => format!(
            "Terminal environment: {shell} · no sandbox (bypass approved by the user, full permissions)"
        ),
        "no_sandbox_disabled" => {
            format!("Terminal environment: {shell} · no sandbox (disabled, full permissions)")
        }
        "no_sandbox_degraded" => format!(
            "Terminal environment: {shell} · no sandbox (unavailable, downgraded, full permissions)"
        ),
        _ => format!("Terminal environment: {shell} · no sandbox (full permissions)"),
    }
}

/// 伪控制台路径（Windows）：服务跑在 ConPTY 里 —— 交互终端的底座（P3）。
///
/// 与命令路径（`execute/common/runner/pty.rs`）同源同序：同一条降级链（沙盒 → 裸跑）、
/// 同一份 shell 选择、同一份环境变量。**唯一的差别是寿命**：伪控制台（`HPCON` + 输入写端）
/// 交给注册表长期持有 —— `ClosePseudoConsole` 会终止仍附着的进程树，
/// 所以它**绝不能**在工具返回时被顺手 drop（见 `pty.rs` 的三条约束）。
#[cfg(target_os = "windows")]
async fn spawn_service_pty(
    ctx: &NativeToolCtx<'_>,
    cmd_str: &str,
    bypass: SandboxBypass,
) -> Result<Spawned, String> {
    use crate::sandbox::pty::{
        create_bare_process_pty, current_env, PseudoConsole, DEFAULT_COLS, DEFAULT_ROWS,
        INTERACTIVE_DESKTOP,
    };

    let bypass_sandbox = bypass.is_bypass();
    // 1) 伪控制台。初始尺寸用默认值（240×50）：服务启动时还没有终端在看它，默认值足以减少硬换行；
    //    用户打开弹窗后前端会改到真实尺寸（`ServicePty` 的尺寸去重保证同尺寸不重绘）。
    let mut pty = PseudoConsole::create(DEFAULT_COLS, DEFAULT_ROWS)
        .map_err(|e| format!("CreatePseudoConsole failed: {e}"))?;

    // 2) 沙盒优先（prepare 失败 → 降级裸跑，与管道 / 命令路径同一条规则）
    let mut sandbox_degraded = false;
    let mut session = if !bypass_sandbox && sandbox_mode(ctx) != SandboxMode::Off {
        match prepare_sandbox_session(ctx).await {
            Ok(s) => Some(s),
            Err(e) => {
                eprintln!("[sandbox] service degraded to bare run: {e}");
                sandbox_degraded = true;
                None
            }
        }
    } else {
        None
    };
    let readonly_mode = sandbox_mode(ctx) == SandboxMode::Readonly;

    let shell = "powershell".to_string();
    let env_extra = service_env_extra(ctx);
    // 3) spawn（沙盒优先；沙盒 spawn 失败 → 释放会话，按裸跑重试）
    let mut child = None;
    if let Some(sess) = session.as_ref() {
        // 沙盒内 PowerShell 会进入约束语言模式（CLM）：`[Console]::OutputEncoding = ...` 会被拒绝，
        // 故这里**不加** UTF-8 前缀（中文由伪控制台自身保证 UTF-8），与命令路径一字不差。
        let argv = vec![
            shell.clone(),
            "-NoProfile".to_string(),
            "-Command".to_string(),
            cmd_str.to_string(),
        ];
        match sess.spawn_pty(&argv, None, &env_extra, pty.raw_hpc()) {
            Ok(c) => child = Some(c),
            Err(e) => {
                eprintln!("[sandbox] service spawn failed, degraded to bare run: {e}");
                session = None;
                sandbox_degraded = true;
            }
        }
    }
    let ran_sandboxed = session.is_some();
    if child.is_none() {
        // 裸跑：先切 UTF-8 输出（与管道路径同一条语句；服务有充足时间跑它），
        // cwd 优先用会话 workspace（为空则继承当前目录）。
        let prefixed = format!(
            "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; {}",
            cmd_str
        );
        let argv = vec![
            shell.clone(),
            "-NoProfile".to_string(),
            "-Command".to_string(),
            prefixed,
        ];
        let cwd = if ctx.security.workspace.is_empty() {
            std::env::current_dir().map_err(|e| format!("[{shell} error] {e}"))?
        } else {
            std::path::PathBuf::from(&ctx.security.workspace)
        };
        let mut env = current_env();
        for (k, v) in &env_extra {
            env.insert(k.clone(), v.clone());
        }
        let c =
            create_bare_process_pty(&argv, None, &cwd, &env, INTERACTIVE_DESKTOP, pty.raw_hpc())
                .map_err(|e| format!("[{shell} error] {e}"))?;
        child = Some(c);
    }
    let child = child.expect("child spawned above");
    let pid = child.pid();
    let child = Arc::new(child);
    // 受限令牌只在 spawn 时用得上，尽早释放（与命令路径一致）。
    drop(session.take());

    // 4) 终止器：
    //    - 沙盒：`PtyChild::terminate`（带 KILL_ON_JOB_CLOSE 的 Job，一键杀树）；
    //    - 裸跑：与管道裸跑同一语义 —— Job(kill_on_close) + kill_process_tree 兜底，
    //      因此应用崩溃 / 条目被清出时不会留下孤儿服务。
    let terminator: Terminator = if ran_sandboxed {
        let child_for_kill = child.clone();
        Arc::new(move || child_for_kill.terminate())
    } else {
        let guard = crate::agent::process_tree::ProcessTreeGuard::create_kill_on_close().map(Arc::new);
        if let Some(g) = &guard {
            let _ = g.assign_pid(pid);
        }
        let guard_for_kill = guard.clone();
        Arc::new(move || {
            if let Some(g) = &guard_for_kill {
                g.terminate();
            }
            kill_process_tree(pid);
        })
    };

    // 5) 输出（单流：PTY 下 stdout/stderr 已合并）+ 交互控制台（输入写端 + HPCON）。
    let stdout = pty
        .take_output()
        .map(|f| Box::new(f) as Box<dyn Read + Send>);
    // ⚠️ `pty` 本体一并交给控制台：HPCON 必须在服务活着期间一直有效
    let console = pty.take_input().map(|input| {
        Arc::new(ServicePty::new(input, pty, DEFAULT_COLS, DEFAULT_ROWS))
    });
    let wait: Box<dyn FnOnce() -> Option<i32> + Send> = {
        let child = child.clone();
        Box::new(move || child.wait_and_read_exit_code())
    };

    // 本次实际沙盒模式：结构化下发（UI 徽标）+ 运行中即时事件。
    // ⚠️ 与 `env_note` 的判定**同源同序**，任何一侧改动都要同步另一侧。
    let sandbox = if ran_sandboxed {
        if readonly_mode {
            "readonly"
        } else {
            "write_isolation"
        }
    } else if sandbox_degraded {
        "no_sandbox_degraded"
    } else if bypass_sandbox {
        if matches!(bypass, SandboxBypass::Rule) {
            "no_sandbox_rule"
        } else {
            "no_sandbox_bypass"
        }
    } else if sandbox_mode(ctx) == SandboxMode::Off {
        "no_sandbox_disabled"
    } else {
        "no_sandbox"
    };
    // 交互终端的额外说明：模型要如实知道「输出是合并流」且「用户能往里敲键盘」（P3）
    let env_note = format!(
        "{} · interactive terminal (stdout/stderr merged; the user can type into it)",
        env_note(ctx, &shell, sandbox)
    );

    Ok(Spawned {
        pid,
        sandbox,
        env_note,
        stdout,
        stderr: None,
        terminator,
        wait,
        console,
    })
}

/// 服务子进程的环境变量（与命令路径一致：Python 输出编码 + SKILL_ROOT）。
fn service_env_extra(ctx: &NativeToolCtx<'_>) -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();
    env.insert("PYTHONIOENCODING".to_string(), "utf-8".to_string());
    if let Some(skills_dir) = &ctx.security.skills_dir {
        env.insert("SKILL_ROOT".to_string(), skills_dir.clone());
    }
    env
}

/// 长期接管：两条常驻读任务 + 一条常驻等待任务（+ 交互控制台的挂载与关停）+ **退出后的结束通知**。
///
/// ⚠️ 必须在 tokio 运行时内调用（工具都在运行时里跑）。工具返回**不影响**这些任务。
/// ⚠️ 关停顺序（定死）：**进程退出 → 落终态 → 关伪控制台 → 发结束通知**。读任务在关控制台后把剩余输出
/// 排空并自然收到 EOF（输出管道要等 `ClosePseudoConsole` 才断开，先等 EOF 会死等）。
///
/// 传 `entry` 而不是 `state`：结束通知要带 name / id / cmd / 起跑时间（注册表条目的信息），
/// 而 `entry.state` 就是同一个 `Arc<ServiceState>`。呼叫方因此必须先 `registry::insert` 再 `supervise`。
pub(super) fn supervise(spawned: Spawned, entry: Arc<ServiceEntry>) {
    let state = entry.state.clone();
    // 交互控制台（有则挂上）：它活到进程退出 / 条目被清出，中间随时接用户键击。
    if let Some(pty) = spawned.console {
        state.attach_pty(pty);
    }
    if let Some(reader) = spawned.stdout {
        spawn_reader(reader, state.clone(), false);
    }
    if let Some(reader) = spawned.stderr {
        spawn_reader(reader, state.clone(), true);
    }
    let wait = spawned.wait;
    tokio::task::spawn_blocking(move || {
        let code = wait();
        let killed = state.kill_requested.load(Ordering::SeqCst);
        state.finish(code, killed);
        // 进程已经退出 —— 此时才能关伪控制台（关掉 = 终止附着进程树；提前关会把服务杀了）。
        state.close_pty();
        // 结束通知：发给 AI（轮次边界注入）还是发给界面（空闲时立刻上屏）由 `notice.rs` 判定；
        // 启动窗口内退出 / AI 自己 kill / 整批收摊都在那里被抑制。
        super::notice::on_service_exit(&entry);
    });
}

/// 一个流的常驻读任务（阻塞读到 EOF；边读边解码边入窗口）。
fn spawn_reader(mut reader: Box<dyn Read + Send>, state: Arc<ServiceState>, is_stderr: bool) {
    tokio::task::spawn_blocking(move || {
        // 与命令路径共用同一份流式解码器（跨块多字节 / GBK 兜底都在里面）
        let mut decoder = TerminalDecoder::new();
        let mut chunk = [0u8; 8192];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    let text = decoder.push(&chunk[..n]);
                    if !text.is_empty() {
                        state.push_output(is_stderr, &text);
                    }
                }
                Err(_) => break,
            }
        }
        let tail = decoder.finish();
        if !tail.is_empty() {
            state.push_output(is_stderr, &tail);
        }
    });
}

// ==================== 工具侧等待窗口 ====================

/// 等待窗口的结束原因。
pub(super) enum WaitOutcome {
    /// 进程在窗口内结束（终态已落定）
    Finished,
    /// 窗口到点，进程仍在跑
    TimedOut,
    /// 用户取消 / 点了「终止」→ 已杀掉
    Cancelled,
}

/// 等待窗口：状态变化 / 到点 / 用户取消 / 前端「终止」按钮，四者取先到者。
///
/// 窗口内把服务的实时输出转发到 `agent:tool-output`（前端终端块在「运行中」就能看到启动日志，
/// 与 `execute_command` 的观感一致）；返回前清掉实时通道（之后的输出只进缓冲区）。
pub(super) async fn wait_window(
    ctx: &NativeToolCtx<'_>,
    state: &Arc<ServiceState>,
    wait_ms: i64,
    kill_requested: &Arc<AtomicBool>,
) -> WaitOutcome {
    use tokio::sync::mpsc;
    use tokio::time::Instant;

    let (tx, mut rx) = mpsc::unbounded_channel::<(bool, String)>();
    *state.live.lock().unwrap() = Some(tx);

    let deadline = Instant::now() + Duration::from_millis(wait_ms.max(0) as u64);
    let outcome = loop {
        // 先看「终止」标志：用户点终止时进程会随之而死，若先判 `is_running`，
        // 可能把「被终止」误报成「自己退出」（两者对模型的含义完全不同）。
        if kill_requested.load(Ordering::SeqCst) {
            break WaitOutcome::Cancelled;
        }
        if !state.is_running() {
            break WaitOutcome::Finished;
        }
        if Instant::now() >= deadline {
            break WaitOutcome::TimedOut;
        }
        tokio::select! {
            chunk = rx.recv() => {
                if let Some((is_stderr, text)) = chunk {
                    ctx.sink.emit_raw("agent:tool-output", serde_json::json!({
                        "sessionId": ctx.session_id,
                        "toolCallId": ctx.tool_call_id,
                        "stream": if is_stderr { "stderr" } else { "stdout" },
                        "chunk": text,
                    }));
                }
            }
            // 状态变化：立刻醒（`notify` 负责延迟，`STATUS_TICK` 负责兜住竞态）
            _ = state.notify.notified() => {}
            _ = tokio::time::sleep(STATUS_TICK) => {}
            _ = ctx.cancel.cancelled() => break WaitOutcome::Cancelled,
        }
        if kill_requested.load(Ordering::SeqCst) {
            break WaitOutcome::Cancelled;
        }
    };

    // 清掉实时通道：之后再来的输出只进缓冲区，不再往已完成的气泡里推。
    *state.live.lock().unwrap() = None;
    outcome
}

/// 注销「运行中命令」（前端终止按钮只在本工具调用期间有效）。
pub(super) fn unregister_call(ctx: &NativeToolCtx<'_>) {
    unregister_running_command(ctx.tool_call_id);
}

/// 注册「运行中命令」：让前端「终止」按钮在等待窗口内可用（语义 = 杀掉该服务）。
pub(super) fn register_call(
    ctx: &NativeToolCtx<'_>,
    pid: u32,
    terminator: &Terminator,
) -> Arc<AtomicBool> {
    register_running_command(ctx.tool_call_id, pid, Some(terminator.clone()))
}

/// 组装「启动失败」结果（spawn 都没成功；无 pid、无输出）。
pub(super) fn failed_outcome(name: &str, cmd: &str, error: &str) -> NativeToolOutcome {
    NativeToolOutcome::error_with_ui(
        format!("Background service \"{name}\" failed to start.\nCommand: {cmd}\nError: {error}"),
        serde_json::json!({
            "name": name,
            "cmd": cmd,
            "status": status::FAILED,
            "error": error,
        }),
    )
}
