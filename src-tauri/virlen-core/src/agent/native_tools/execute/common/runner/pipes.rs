//! 匿名管道运行器 —— 非 Windows 平台主路径，也是 Windows 上伪控制台不可用时的降级兜底。

use crate::agent::native_tools::{NativeToolCtx, NativeToolOutcome};
use serde_json::json;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use super::super::decode::{decode_tail, push_bounded, push_bytes_bounded, TerminalDecoder};
use super::super::registry::{
    kill_process_tree, register_running_command, unregister_running_command, wait_for_kill_request,
    Terminator,
};
use super::sandbox::run_command_sandboxed;
use super::{build_command_result, sandbox_mode, SandboxMode};

/// 匿名管道运行器（改造前的实现）。
///
/// 保留为**两条用途**：非 Windows 平台的主路径、Windows 上伪控制台不可用时的降级兜底。
pub(super) async fn run_command_native_pipes(
    ctx: &NativeToolCtx<'_>,
    cmd_str: &str,
    timeout_secs: i64,
    bypass_sandbox: bool,
) -> Result<NativeToolOutcome, String> {
    use tokio::io::AsyncReadExt;
    use tokio::process::Command;
    use tokio::time::sleep;

    let platform = std::env::consts::OS;
    let is_win = platform == "windows";

    // 三平台：优先走沙盒（OS 级写隔离）。以下三种情况走下方裸跑路径：
    //   1) bypass_sandbox = true（sandbox:"off"，已在 execute_command 侧强制审批）；
    //   2) 沙盒模式为 off；
    //   3) prepare/spawn 失败（降级，见下方 eprintln）。
    let mut sandbox_degraded = false;
    if !bypass_sandbox && sandbox_mode(ctx) != SandboxMode::Off {
        match run_command_sandboxed(ctx, cmd_str, timeout_secs).await {
            Ok(outcome) => return Ok(outcome),
            Err(e) => {
                eprintln!("[sandbox] degraded to bare run: {e}");
                sandbox_degraded = true;
            }
        }
    }

    let (shell, args): (&str, Vec<String>) = if is_win {
        // Windows 统一走 Windows PowerShell 5.1（powershell.exe），不再混用 cmd：
        // 命令按 PowerShell 语法书写（不支持 &&/||，改用 ; 或 if ($LASTEXITCODE)）。
        // 先切到 UTF-8 输出，避免中文系统默认 GBK 使管道输出乱码。
        let prefixed = format!(
            "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; {}",
            cmd_str
        );
        (
            "powershell",
            vec!["-NoProfile".into(), "-Command".into(), prefixed],
        )
    } else if platform == "macos" {
        ("zsh", vec!["-c".into(), cmd_str.into()])
    } else {
        ("sh", vec!["-c".into(), cmd_str.into()])
    };

    let mut cmd = Command::new(shell);
    // Windows 统一为 PowerShell，其 .NET 解析器认得 \" 能正确还原引号，普通 .arg() 即可
    // （不再使用 cmd，故无需 raw_arg 原样透传）。
    cmd.args(&args);
    #[cfg(target_os = "windows")]
    {
        // 隐藏控制台窗口：Windows 上 spawn powershell 默认会弹出黑窗口，
        // 与 kill_process_tree / load_env 的 CREATE_NO_WINDOW 保持一致
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    if !ctx.security.workspace.is_empty() {
        cmd.current_dir(&ctx.security.workspace);
    }
    cmd.env("PYTHONIOENCODING", "utf-8");
    if let Some(skills_dir) = &ctx.security.skills_dir {
        cmd.env("SKILL_ROOT", skills_dir);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("[{} error] {}", shell, e))?;
    let pid = child.id().unwrap_or(0);

    // Windows：创建 Job Object 并把命令进程纳入，之后命令派生的所有后代自动入组。
    // 超时/终止时 TerminateJobObject 一键全杀，不依赖 taskkill /T 的进程树关系
    // （node/npm/python 被 reparent 或脱离树后 /T 会漏杀）。Job 创建/分配失败时
    // 静默回退到 kill_process_tree 的递归枚举兜底。
    let guard = crate::agent::process_tree::ProcessTreeGuard::create();
    if let Some(g) = &guard {
        let _ = g.assign_pid(pid);
    }
    let guard = guard.map(std::sync::Arc::new);

    // 注册到运行中命令表，支持前端「终止」按钮（ToolOutput.kill）
    let terminator: Option<Terminator> = guard
        .clone()
        .map(|g| Arc::new(move || g.terminate()) as Terminator);
    let kill_requested = register_running_command(ctx.tool_call_id, pid, terminator);

    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();

    // 实时输出推送通道：读取任务把 stdout/stderr 数据块发回主任务，
    // 主任务通过 sink 向 JS 推送 `agent:tool-output` 事件（对齐 JS ctx.write → toolOutputStore）
    use tokio::sync::mpsc;
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<(String, String)>(); // (stream, chunk)

    let stdout_tx = out_tx.clone();
    let stderr_tx = out_tx.clone();
    drop(out_tx); // 主任务不再持有发送端，stdout/stderr 任务结束后 out_rx 会自动关闭

    let stdout_handle = tokio::spawn(async move {
        if let Some(mut out) = stdout_pipe {
            let mut raw: Vec<u8> = Vec::new();
            let mut truncated = false;
            let mut chunk = vec![0u8; 8192];
            let mut decoder = TerminalDecoder::new();
            loop {
                let n = match out.read(&mut chunk).await {
                    Ok(0) => break,
                    Ok(n) => n,
                    Err(_) => break,
                };
                truncated |= push_bytes_bounded(&mut raw, &chunk[..n]);
                let text = decoder.push(&chunk[..n]);
                if !text.is_empty() {
                    let _ = stdout_tx.send(("stdout".to_string(), text));
                }
            }
            let tail = decoder.finish();
            if !tail.is_empty() {
                let _ = stdout_tx.send(("stdout".to_string(), tail));
            }
            decode_tail(&raw, truncated)
        } else {
            String::new()
        }
    });
    let stderr_handle = tokio::spawn(async move {
        if let Some(mut err) = stderr_pipe {
            let mut raw: Vec<u8> = Vec::new();
            let mut truncated = false;
            let mut chunk = vec![0u8; 8192];
            let mut decoder = TerminalDecoder::new();
            loop {
                let n = match err.read(&mut chunk).await {
                    Ok(0) => break,
                    Ok(n) => n,
                    Err(_) => break,
                };
                truncated |= push_bytes_bounded(&mut raw, &chunk[..n]);
                let text = decoder.push(&chunk[..n]);
                if !text.is_empty() {
                    let _ = stderr_tx.send(("stderr".to_string(), text));
                }
            }
            let tail = decoder.finish();
            if !tail.is_empty() {
                let _ = stderr_tx.send(("stderr".to_string(), tail));
            }
            decode_tail(&raw, truncated)
        } else {
            String::new()
        }
    });

    // 等待子进程退出（与超时/取消并行），退出码通过 done 通道回传
    let (done_tx, mut done_rx) = mpsc::unbounded_channel::<Option<i32>>();
    let wait_handle = tokio::spawn(async move {
        let code = child.wait().await.ok().and_then(|s| s.code());
        let _ = done_tx.send(code);
    });

    let mut stdout = String::new();
    let mut stderr = String::new();
    let mut exit_code: Option<Option<i32>> = None;
    let mut out_closed = false;
    let mut got_exit = false;
    let mut killed_by_timeout = false;
    let mut killed_by_user = false;
    let mut timeout_fut = Box::pin(sleep(Duration::from_secs((timeout_secs.max(1)) as u64)));

    loop {
        tokio::select! {
            maybe = out_rx.recv() => {
                match maybe {
                    Some((stream, chunk)) => {
                        if stream == "stdout" {
                            push_bounded(&mut stdout, &chunk);
                        } else {
                            push_bounded(&mut stderr, &chunk);
                        }
                        // 实时推送（与 JS `ctx.write(chunk)` 对齐）
                        ctx.sink.emit_raw("agent:tool-output", json!({
                            "sessionId": ctx.session_id,
                            "toolCallId": ctx.tool_call_id,
                            "stream": stream,
                            "chunk": chunk,
                        }));
                    }
                    None => out_closed = true,
                }
            }
            code = done_rx.recv() => {
                exit_code = code;
                got_exit = true;
                // kill 请求已置位：进程退出是 kill 的结果，按用户取消处理，
                // 避免与 done_rx 竞态导致返回「退出码」而非「已取消」。
                if kill_requested.load(Ordering::SeqCst) {
                    killed_by_user = true;
                }
            }
            // 前端「终止」按钮：kill_running_command 已杀进程树，这里按用户取消处理
            _ = wait_for_kill_request(&kill_requested), if !killed_by_timeout && !killed_by_user => {
                killed_by_user = true;
            }
            _ = &mut timeout_fut, if !killed_by_timeout && !killed_by_user => {
                if let Some(g) = &guard {
                    g.terminate();
                }
                kill_process_tree(pid);
                killed_by_timeout = true;
            }
            _ = ctx.cancel.cancelled(), if !killed_by_timeout && !killed_by_user => {
                if let Some(g) = &guard {
                    g.terminate();
                }
                kill_process_tree(pid);
                killed_by_user = true;
            }
        }
        if killed_by_timeout || killed_by_user {
            break;
        }
        // 输出流已全部读取 且 已拿到退出码 → 结束
        if out_closed && got_exit {
            break;
        }
    }

    // 收尾：等待读取任务和 wait 任务结束，拿到完整输出。
    // ⚠️ 被终止/超时/取消后，若进程树没杀干净（如 taskkill 权限不足、detached 子进程仍持有
    // 管道），直接 .await 会无限挂起 → 工具永远不返回，前端「终止」按钮看似失效（命令一直显示
    // 运行中）。因此 kill/超时路径限制等待窗口：3 秒内收不完就补刀强杀并 abort 任务，用已流式
    // 收到的输出返回。
    let stdout_abort = stdout_handle.abort_handle();
    let stderr_abort = stderr_handle.abort_handle();
    let wait_abort = wait_handle.abort_handle();
    let stdout_final;
    let stderr_final;
    if killed_by_user || killed_by_timeout {
        let cleanup = async {
            let so = stdout_handle.await;
            let se = stderr_handle.await;
            let _ = wait_handle.await;
            (so, se)
        };
        match tokio::time::timeout(Duration::from_secs(3), cleanup).await {
            Ok((so, se)) => {
                stdout_final = so.unwrap_or_default();
                stderr_final = se.unwrap_or_default();
            }
            Err(_) => {
                // 进程还活着：Job Object 补刀 + 再强杀，然后 abort 读取/等待任务，避免任务泄漏
                if let Some(g) = &guard {
                    g.terminate();
                }
                kill_process_tree(pid);
                stdout_abort.abort();
                stderr_abort.abort();
                wait_abort.abort();
                stdout_final = String::new();
                stderr_final = String::new();
            }
        }
    } else {
        stdout_final = stdout_handle.await.unwrap_or_default();
        stderr_final = stderr_handle.await.unwrap_or_default();
        let _ = wait_handle.await;
    }
    if !stdout_final.is_empty() {
        stdout = stdout_final;
    }
    if !stderr_final.is_empty() {
        stderr = stderr_final;
    }
    // 移除运行中命令注册
    unregister_running_command(ctx.tool_call_id);
    let exit_code = if killed_by_timeout || killed_by_user {
        None
    } else {
        exit_code.flatten()
    };

    let env_note = {
        let mode = if bypass_sandbox {
            "no sandbox (bypass approved by the user, full permissions)"
        } else if sandbox_mode(ctx) == SandboxMode::Off {
            "no sandbox (disabled, full permissions)"
        } else if sandbox_degraded {
            "no sandbox (unavailable, downgraded, full permissions)"
        } else {
            "no sandbox (full permissions)"
        };
        format!("Terminal environment: {shell} · {mode}")
    };

    Ok(build_command_result(
        stdout,
        stderr,
        exit_code,
        killed_by_user,
        killed_by_timeout,
        timeout_secs,
        &env_note,
        false, // 管道路径：stdout/stderr 分流，不是 PTY
        None,  // 管道路径无 PTY 会话 → 无干预摘要
        false,
    ))
}
