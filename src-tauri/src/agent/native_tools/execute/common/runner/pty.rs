//! ConPTY 运行器（Windows）—— 命令在一个伪控制台里跑。
//!
//! 与管道路径的关键差异（均已实测，见 `docs/pty-research.md` §5）：
//!   1. stdout/stderr **合并**为一条 VT 流（伪控制台只有一条输出通道）；
//!   2. 通信通道必须是**同步** I/O，所以读线程走 `spawn_blocking` + 阻塞 `Read`；
//!   3. **结束判定不能用「输出通道 EOF」**：输出管道要等 `ClosePseudoConsole` 之后才断开
//!      （Spike 实测），因此主循环以「进程退出」为结束条件，收尾时先关伪控制台再等读线程；
//!   4. 输出严格为 UTF-8（中文直接可读）→ §11.1 的 GBK 兜底在 PTY 路径上几乎不触发。
//!
//! ⚠️ 已知语义变化：`ClosePseudoConsole` 会终止仍附着在伪控制台上的进程，因此
//! **裸跑路径下 `start` 之类拉起的后台进程不再存活**（沙盒路径本来就会杀，见 windows/mod.rs）。

use crate::agent::native_tools::{NativeToolCtx, NativeToolOutcome};
use serde_json::json;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use super::super::super::pty_session;
use super::super::decode::{decode_tail, push_bounded, push_bytes_bounded, TerminalDecoder};
use super::super::registry::{
    kill_process_tree, register_running_command, unregister_running_command, wait_for_kill_request,
    Terminator,
};
use super::pipes::run_command_native_pipes;
use super::sandbox::prepare_sandbox_session;
use super::{build_command_result, pty_hold_max, sandbox_mode, SandboxMode, PAGER_DISABLED, TICK};

pub(super) async fn run_command_native_pty(
    ctx: &NativeToolCtx<'_>,
    cmd_str: &str,
    timeout_secs: i64,
    bypass_sandbox: bool,
) -> Result<NativeToolOutcome, String> {
    use crate::sandbox::pty::{
        create_bare_process_pty, current_env, PseudoConsole, DEFAULT_COLS, DEFAULT_ROWS,
        INTERACTIVE_DESKTOP,
    };
    use std::io::Read;
    use tokio::sync::mpsc;

    // 1) 伪控制台。建不起来就降级回匿名管道（保留改造前的实现作兜底）。
    //
    // 初始尺寸优先用「最近一次客户端上报的尺寸」：若与客户端实际尺寸一致，前端随后的
    // `pty_resize` 就是 no-op，ConPTY 不会重绘、也就不会在内容下方补出多余空行
    // （见 pty_session::SizeTracker 与 docs/pty-research.md §5.7）。
    //
    // ⚠️ `initial_size` 会在缓存为空时**短暂等待**客户端上报（最多 ~800ms）——
    // 这是 TS 引擎路径的关键：`pty_run_command` 往往先于终端挂载，不等待就会用 240×50
    // 建控制台，首帧按 50 行铺满 → 一大堆空行（见 §5.7.2）。
    let (init_cols, init_rows) = pty_session::initial_size((DEFAULT_COLS, DEFAULT_ROWS)).await;
    let mut pty = match PseudoConsole::create(init_cols, init_rows) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[pty] CreatePseudoConsole unavailable, degraded to pipes: {e}");
            return run_command_native_pipes(ctx, cmd_str, timeout_secs, bypass_sandbox).await;
        }
    };

    // 2) 沙盒优先（prepare 失败 → 降级裸跑，与管道路径的降级规则一致）
    let sandbox_requested = !bypass_sandbox && sandbox_mode(ctx) != SandboxMode::Off;
    let mut sandbox_degraded = false;
    let mut session = if sandbox_requested {
        match prepare_sandbox_session(ctx).await {
            Ok(s) => Some(s),
            Err(e) => {
                eprintln!("[sandbox] degraded to bare run: {e}");
                sandbox_degraded = true;
                None
            }
        }
    } else {
        None
    };
    let readonly_mode = sandbox_mode(ctx) == SandboxMode::Readonly;

    // 与管道路径一致的额外环境变量。
    let mut env_extra = BTreeMap::new();
    env_extra.insert("PYTHONIOENCODING".to_string(), "utf-8".to_string());
    if let Some(skills_dir) = &ctx.security.skills_dir {
        env_extra.insert("SKILL_ROOT".to_string(), skills_dir.clone());
    }
    // 禁用分页器（PTY 下 stdout 是 TTY，否则 git/gh/bat 会起 `less`/`more` 停在界面等按键，
    // AI 无法按 q 退出 → 表现为「命令跑完却卡在最后」。三者取值均有工具源码佐证，
    // 且都**不会真调 `cat`**；详见上方 `PAGER_DISABLED`）：
    env_extra.insert("GIT_PAGER".to_string(), PAGER_DISABLED.to_string()); // git
    env_extra.insert("GH_PAGER".to_string(), PAGER_DISABLED.to_string()); // gh
    env_extra.insert("BAT_PAGING".to_string(), "never".to_string()); // bat

    // 3) spawn（沙盒优先；沙盒 spawn 失败 → 释放会话，按裸跑重试）
    let shell = "powershell".to_string();
    let mut child = None;
    if let Some(sess) = session.as_ref() {
        // 沙盒内 PowerShell 会进入约束语言模式（CLM），`[Console]::OutputEncoding = ...`
        // 这类属性设置会被拒绝，所以这里**不**加 UTF-8 前缀（中文由伪控制台自身保证 UTF-8）。
        let argv = vec![
            shell.clone(),
            "-NoProfile".to_string(),
            "-Command".to_string(),
            cmd_str.to_string(),
        ];
        let mode = if readonly_mode { "readonly" } else { "on" };
        match sess.spawn_pty(&argv, None, &env_extra, pty.raw_hpc()) {
            Ok(c) => {
                crate::telemetry::track(
                    "rust.sandbox.spawn",
                    json!({
                        "tool_name": "execute_command",
                        "sandbox_mode": mode,
                        "status": "success",
                        "stdio": "pty",
                    }),
                );
                child = Some(c);
            }
            Err(e) => {
                crate::telemetry::track(
                    "rust.sandbox.spawn",
                    json!({
                        "tool_name": "execute_command",
                        "sandbox_mode": mode,
                        "status": "fail",
                        "error": format!("sandbox spawn failed: {e}"),
                        "stdio": "pty",
                    }),
                );
                eprintln!("[sandbox] spawn failed, degraded to bare run: {e}");
                session = None;
                sandbox_degraded = true;
            }
        }
    }
    let ran_sandboxed = session.is_some();
    if child.is_none() {
        // 裸跑：先切 UTF-8 输出（与改造前的裸跑路径一致），中文系统默认 GBK 会乱码。
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
        // 裸跑没有沙盒 prepare 提供的 cwd，这里自己解析（workspace 为空则继承当前目录）。
        let cwd = if ctx.security.workspace.is_empty() {
            std::env::current_dir().map_err(|e| format!("[{shell} error] {e}"))?
        } else {
            PathBuf::from(&ctx.security.workspace)
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
    // 受限令牌只在 spawn 时用得上，尽早释放（与管道路径一致）。
    drop(session.take());

    // 4) 注册「运行中命令」（前端终止按钮）与「PTY 会话」（前端插键盘）
    let child_for_kill = child.clone();
    let terminator: Option<Terminator> = Some(Arc::new(move || child_for_kill.terminate()));
    let kill_requested = register_running_command(ctx.tool_call_id, pid, terminator);
    // 裸跑路径额外挂 ProcessTreeGuard，与管道路径的裸跑语义保持一致。
    let guard = if ran_sandboxed {
        None
    } else {
        crate::agent::process_tree::ProcessTreeGuard::create()
    };
    if let Some(g) = &guard {
        let _ = g.assign_pid(pid);
    }
    let guard = guard.map(Arc::new);
    let pty_session_handle: Option<Arc<pty_session::PtySession>> =
        if let Some(input) = pty.take_input() {
            let session = Arc::new(pty_session::PtySession::new(
                input,
                pty.raw_hpc(),
                init_cols,
                init_rows,
            ));
            pty_session::register(ctx.tool_call_id, session.clone());
            Some(session)
        } else {
            None
        };

    // 5) 输出：管道读端在 spawn_blocking 线程里阻塞 read，经 mpsc 回传
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<(String, String)>();
    // 伪控制台的读端交给独立线程；官方要求每条通道用单独线程服务，避免缓冲区互等死锁。
    let out = pty.take_output();
    let stdout_handle = tokio::task::spawn_blocking(move || {
        let Some(mut out) = out else {
            return String::new();
        };
        let mut tail: Vec<u8> = Vec::new();
        let mut truncated = false;
        let mut chunk = vec![0u8; 8192];
        let mut decoder = TerminalDecoder::new();
        loop {
            let n = match out.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => n,
                Err(_) => break,
            };
            truncated |= push_bytes_bounded(&mut tail, &chunk[..n]);
            let text = decoder.push(&chunk[..n]);
            if !text.is_empty() {
                // PTY 只有一条输出流：stderr 已合并进 stdout（stream 恒为 "stdout"）
                let _ = out_tx.send(("stdout".to_string(), text));
            }
        }
        let tail_text = decoder.finish();
        if !tail_text.is_empty() {
            let _ = out_tx.send(("stdout".to_string(), tail_text));
        }
        decode_tail(&tail, truncated)
    });

    // 等待子进程退出（与超时/取消并行），退出码通过 done 通道回传
    let (done_tx, mut done_rx) = mpsc::unbounded_channel::<Option<i32>>();
    let wait_child = child.clone();
    let wait_handle = tokio::task::spawn_blocking(move || {
        let code = wait_child.wait_and_read_exit_code();
        let _ = done_tx.send(code);
    });

    let mut stdout = String::new();
    let mut exit_code: Option<Option<i32>> = None;
    let mut out_closed = false;
    let mut got_exit = false;
    let mut killed_by_timeout = false;
    let mut killed_by_user = false;
    let mut hold_timed_out = false;
    // ② 超时改为「预算 + 心跳」：Step 1 的单次 `sleep` 无法暂停，而接管时必须冻结预算。
    //    预算剩多少是**显式状态**（好断言、好排查）；每 250ms 醒一次，对 CPU 无实质影响。
    let mut remaining = Duration::from_secs(timeout_secs.max(1) as u64);
    let mut held_elapsed = Duration::ZERO;
    let mut tick = tokio::time::interval_at(tokio::time::Instant::now() + TICK, TICK);

    loop {
        tokio::select! {
            maybe = out_rx.recv(), if !out_closed => {
                match maybe {
                    Some((stream, chunk)) => {
                        push_bounded(&mut stdout, &chunk);
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
            _ = wait_for_kill_request(&kill_requested), if !killed_by_timeout && !killed_by_user => {
                killed_by_user = true;
            }
            _ = tick.tick(), if !killed_by_timeout && !killed_by_user => {
                // ② 接管期间冻结预算（人在慢慢输密码），只在非接管时扣减；
                //    接管累计超过硬上限则强制终止（防止「忘了交还」无限期挂起）。
                let held = pty_session_handle
                    .as_ref()
                    .map(|s| s.is_held())
                    .unwrap_or(false);
                if held {
                    held_elapsed += TICK;
                    if held_elapsed >= pty_hold_max() {
                        child.terminate();
                        if let Some(g) = &guard {
                            g.terminate();
                        }
                        kill_process_tree(pid);
                        killed_by_timeout = true;
                        hold_timed_out = true;
                    }
                } else if remaining > TICK {
                    remaining -= TICK;
                } else {
                    child.terminate();
                    if let Some(g) = &guard {
                        g.terminate();
                    }
                    kill_process_tree(pid);
                    killed_by_timeout = true;
                }
            }
            _ = ctx.cancel.cancelled(), if !killed_by_timeout && !killed_by_user => {
                child.terminate();
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
        // ⚠️ 不能用「输出通道 EOF」作为结束条件：输出管道要等 ClosePseudoConsole 之后
        // 才断开（Spike 实测）。命令结束的判定是**进程退出**；收尾时再关伪控制台，
        // 让读线程把剩余输出排空并自然收到 EOF。
        if got_exit {
            break;
        }
    }

    // ---- 收尾：杀树（仅超时/取消）→ 关伪控制台 → 等读线程 EOF → 取退出码 ----
    let stdout_abort = stdout_handle.abort_handle();
    let wait_abort = wait_handle.abort_handle();
    if killed_by_user || killed_by_timeout {
        child.terminate();
        if let Some(g) = &guard {
            g.terminate();
        }
        kill_process_tree(pid);
    }
    // §5.5 关停顺序：关伪控制台时**读线程必须仍在排空**，所以先不要 abort 它。
    let _ = tokio::task::spawn_blocking(move || {
        pty.close();
    })
    .await;
    // 等读线程把剩余输出收完；3 秒看门狗避免通道异常时工具永不返回。
    let stdout_final = match tokio::time::timeout(Duration::from_secs(3), stdout_handle).await {
        Ok(Ok(text)) => text,
        _ => {
            // 通道没在 3s 内断开：补刀杀树 + abort，用已流式收到的输出返回。
            child.terminate();
            if let Some(g) = &guard {
                g.terminate();
            }
            kill_process_tree(pid);
            stdout_abort.abort();
            String::new()
        }
    };
    // 等 wait 任务收尾（进程已退出时几乎立即返回）
    if tokio::time::timeout(Duration::from_secs(3), wait_handle)
        .await
        .is_err()
    {
        wait_abort.abort();
    }
    if !stdout_final.is_empty() {
        stdout = stdout_final;
    }
    // 注销：先移除表项再关输入通道，保证 `pty_write` 不会写到已关闭的句柄
    if let Some(s) = pty_session::unregister(ctx.tool_call_id) {
        s.close_input();
    }
    // ② 干预摘要（**只记计数**）：keys/enters/ctrlC 来自会话记账，heldSeconds 由预算心跳累计。
    let mut interventions = pty_session_handle
        .as_ref()
        .map(|s| s.interventions())
        .unwrap_or_default();
    interventions.held_seconds = held_elapsed.as_secs();
    unregister_running_command(ctx.tool_call_id);
    let exit_code = if killed_by_timeout || killed_by_user {
        None
    } else {
        exit_code.flatten()
    };

    let env_note = if ran_sandboxed {
        if readonly_mode {
            format!("终端环境: {shell} · 只读（不可写）")
        } else if ctx.security.workspace.is_empty() {
            format!("终端环境: {shell} · 写隔离")
        } else {
            format!(
                "终端环境: {shell} · 写隔离（可写根: {}；区外写入会被拒绝）",
                ctx.security.workspace
            )
        }
    } else if sandbox_degraded {
        format!("终端环境: {shell} · 无沙盒（沙盒不可用，已降级，完整权限）")
    } else if bypass_sandbox {
        format!("终端环境: {shell} · 无沙盒（用户已批准绕过沙盒，完整权限）")
    } else if sandbox_mode(ctx) == SandboxMode::Off {
        format!("终端环境: {shell} · 无沙盒（已关闭，完整权限）")
    } else {
        format!("终端环境: {shell} · 无沙盒（完整权限）")
    };

    Ok(build_command_result(
        stdout,
        // PTY 只有一条输出流：stderr 已合并进 stdout，因此 stderr 恒为空。
        String::new(),
        exit_code,
        killed_by_user,
        killed_by_timeout,
        timeout_secs,
        &env_note,
        true,
        Some(&interventions),
        hold_timed_out,
    ))
}
