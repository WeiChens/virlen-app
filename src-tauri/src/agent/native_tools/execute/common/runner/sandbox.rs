//! 沙盒会话准备与沙盒内（管道）运行。
//!
//! - `expand_env_vars` / `collect_extra_roots`：算终端可写根（M6 映射）。
//! - `prepare_sandbox_session`：算可写根（含包管理器缓存探测）→ 应用 ACL → 建受限令牌，
//!   与「怎么跑」解耦，PTY 路径与管道路径共用。
//! - `run_command_sandboxed`：受限令牌 + 匿名管道的沙盒运行。

use crate::agent::native_tools::{NativeToolCtx, NativeToolOutcome};
use serde_json::json;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use super::super::decode::{decode_tail, push_bounded, push_bytes_bounded, TerminalDecoder};
use super::super::registry::{
    kill_process_tree, register_running_command, unregister_running_command, wait_for_kill_request,
    Terminator,
};
use super::{build_command_result, sandbox_mode, SandboxMode};

/// 展开路径中的环境变量占位符：%VAR%（Windows）与 ~（Unix）。
pub(super) fn expand_env_vars(path: &str) -> PathBuf {
    let s = path.replace('\\', "/");
    // Unix：展开 ~ 为用户主目录。
    let s = if s == "~" || s.starts_with("~/") {
        std::env::var("HOME")
            .map(|h| format!("{}{}", h, &s[1..]))
            .unwrap_or(s)
    } else {
        s
    };
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '%' {
            if let Some(j) = (i + 1..chars.len()).position(|k| chars[k] == '%') {
                let name: String = chars[i + 1..i + 1 + j].iter().collect();
                let val = std::env::var(&name).unwrap_or_else(|_| format!("%{name}%"));
                out.push_str(&val.replace('\\', "/"));
                i += j + 2;
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    PathBuf::from(out)
}

/// 从 whitelist 收集终端可写根（M6 映射）。
///
/// 规则：
///   1. 展开 %VAR%/~ 环境变量占位符；
///   2. 跳过 skills_dir（只读，走 protect）；
///   3. 只保留「存在且是目录」的路径（不存在的跳过，避免 prepare 失败降级）；
///   4. 跳过「包含 workspace 的祖先目录」——workspace 本身已是写根，祖先目录会把
///      整个父目录变成终端可写，破坏写隔离（如 whitelist 默认含 Documents，
///      而 workspace 是 Documents/test/demo 时，绝不能让 demo2 也变得可写）。
pub(super) fn collect_extra_roots(
    whitelist: &[String],
    workspace: &str,
    skills_dir: Option<&str>,
) -> Vec<PathBuf> {
    let workspace_path = PathBuf::from(workspace);
    let mut extra_roots: Vec<PathBuf> = Vec::new();
    for w in whitelist {
        let p = expand_env_vars(w);
        if let Some(sd) = skills_dir {
            if crate::sandbox::paths::same_path_key(p.as_path(), std::path::Path::new(sd)) {
                continue;
            }
        }
        if !p.is_dir() {
            continue;
        }
        if crate::sandbox::paths::root_contains_path(p.as_path(), workspace_path.as_path()) {
            continue;
        }
        extra_roots.push(p);
    }
    extra_roots
}

/// 准备沙盒会话：算可写根（含包管理器缓存探测）→ 应用 ACL → 建受限令牌。
///
/// 与「怎么跑」解耦，便于 PTY 路径（`run_command_native_pty`）与管道路径
/// （`run_command_sandboxed`）共用：两条路径的 spawn 方式不同，prepare 完全一致。
pub(super) async fn prepare_sandbox_session(
    ctx: &NativeToolCtx<'_>,
) -> Result<crate::sandbox::SandboxSession, String> {
    // 写根 = workspace + whitelist 中「存在且是目录」的可写目录（排除 skills_dir）；
    // 保护 = skills_dir（deny-write）；.git/.hg/.svn/.codex/.agents 由 prepare 默认保护。
    // whitelist 可能含 %VAR% 占位符或已失效路径，逐条展开并过滤，避免单条失败导致整体降级。
    let readonly_mode = sandbox_mode(ctx) == SandboxMode::Readonly;
    let skills_dir = ctx.security.skills_dir.clone();
    let mut extra_roots = if readonly_mode {
        // readonly 模式不授予任何写根（whitelist 也不映射为可写根），否则 prepare 会因
        // 「readonly + extra_roots」冲突而失败 → 静默降级裸跑，丧失只读保护。
        Vec::new()
    } else {
        collect_extra_roots(&ctx.security.whitelist, &ctx.security.workspace, skills_dir.as_deref())
    };
    // 包管理器缓存目录自动豁免：npm/pnpm/cargo 等安装命令会先写用户级缓存目录
    // （~/.npm、pnpm store、~/.cargo…）再复制到 workspace 的 node_modules，默认写隔离
    // 会拦截（表现为 `npm install` EACCES/EPERM mkdir cache）。动态探测真实缓存目录并
    // 加入可写根，对齐 Claude Code sandbox.filesystem.allowWrite / Codex writable_roots
    // 的做法。readonly 模式不授予任何额外写根；workspace 祖先/已覆盖目录在模块内过滤。
    // 探测可能含子进程等待（npm/pnpm config），放 spawn_blocking 避免阻塞 async runtime。
    if !readonly_mode && !ctx.security.workspace.is_empty() {
        let ws_path = PathBuf::from(&ctx.security.workspace);
        let existing = extra_roots.clone();
        let cache_roots = tokio::task::spawn_blocking(move || {
            crate::agent::package_cache_roots::cache_roots_for_workspace(&ws_path, &existing)
        })
        .await
        .unwrap_or_else(|e| {
            // 缓存探测是 best-effort 增强：失败（含闭包内 panic / 锁中毒）不应让整条命令失败，
            // 静默降级为「不追加缓存根」，沙盒仍按 workspace + whitelist 正常启动。
            eprintln!("[sandbox] package cache roots probe failed, skipping: {e}");
            Vec::new()
        });
        extra_roots.extend(cache_roots);
    }
    let mut protect: Vec<PathBuf> = Vec::new();
    if let Some(sd) = &skills_dir {
        let sp = PathBuf::from(sd);
        if sp.exists() {
            protect.push(sp);
        }
    }

    let req = crate::sandbox::SandboxRequest {
        cwd: PathBuf::from(&ctx.security.workspace),
        extra_roots,
        protect,
        readonly: readonly_mode,
    };
    let state = crate::sandbox::state::SandboxState::from_default_or(None)
        .map_err(|e| format!("sandbox state init failed: {e}"))?;
    let session = crate::sandbox::SandboxSession::prepare(&req, &state)
        .map_err(|e| format!("sandbox prepare failed: {e}"))?;
    Ok(session)
}

pub(super) async fn run_command_sandboxed(
    ctx: &NativeToolCtx<'_>,
    cmd_str: &str,
    timeout_secs: i64,
) -> Result<NativeToolOutcome, String> {
    use std::io::Read;
    use tokio::sync::mpsc;
    use tokio::time::sleep;

    // 1) 选择 shell（平台自适应）。
    // 注意：Windows 沙盒进程运行在受限令牌下，PowerShell 会进入约束语言模式（CLM），
    // `[Console]::OutputEncoding = ...` 这类属性设置会被拒绝，因此这里**不**加 UTF-8 前缀，
    // 中文输出靠 decode_output 的 GBK 兜底解码（与裸跑路径的 UTF-8 前缀不同）。
    #[cfg(target_os = "windows")]
    let (shell, args, raw_cmdline): (&str, Vec<String>, Option<String>) = (
        "powershell",
        vec!["-NoProfile".into(), "-Command".into(), cmd_str.to_string()],
        None,
    );
    #[cfg(target_os = "macos")]
    let (shell, args, raw_cmdline): (&str, Vec<String>, Option<String>) =
        ("zsh", vec!["-c".into(), cmd_str.to_string()], None);
    #[cfg(target_os = "linux")]
    let (shell, args, raw_cmdline): (&str, Vec<String>, Option<String>) =
        ("sh", vec!["-c".into(), cmd_str.to_string()], None);

    // 2) 沙盒会话：与 PTY 路径共用同一份 prepare（算可写根 → 应用 ACL → 建受限令牌）
    let readonly_mode = sandbox_mode(ctx) == SandboxMode::Readonly;
    let session = prepare_sandbox_session(ctx).await?;

    // 3) 环境变量（与裸跑路径一致）
    let mut env_extra = BTreeMap::new();
    env_extra.insert("PYTHONIOENCODING".to_string(), "utf-8".to_string());
    if let Some(skills_dir) = &ctx.security.skills_dir {
        env_extra.insert("SKILL_ROOT".to_string(), skills_dir.clone());
    }

    // 4) spawn（受限令牌 + CreateProcessAsUserW）
    let command_argv: Vec<String> = std::iter::once(shell.to_string())
        .chain(args.iter().cloned())
        .collect();
    let child = match session.spawn(&command_argv, raw_cmdline.as_deref(), &env_extra) {
        Ok(c) => {
            crate::telemetry::track(
                "rust.sandbox.spawn",
                json!({
                    "tool_name": "execute_command",
                    "sandbox_mode": if readonly_mode { "readonly" } else { "on" },
                    "status": "success",
                }),
            );
            c
        }
        Err(e) => {
            crate::telemetry::track(
                "rust.sandbox.spawn",
                json!({
                    "tool_name": "execute_command",
                    "sandbox_mode": if readonly_mode { "readonly" } else { "on" },
                    "status": "fail",
                    "error": format!("sandbox spawn failed: {e}"),
                }),
            );
            return Err(format!("sandbox spawn failed: {e}"));
        }
    };
    // token 已不再需要，尽早关闭（也避免 HANDLE 跨 await）。
    drop(session);

    let mut child = child;
    let pid = child.pid();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let child = Arc::new(child);

    // 注册到运行中命令表，支持前端「终止」按钮
    let child_for_kill = child.clone();
    let terminator: Option<Terminator> = Some(Arc::new(move || child_for_kill.terminate()));
    let kill_requested = register_running_command(ctx.tool_call_id, pid, terminator);

    // 5) 实时输出：管道读端在 spawn_blocking 线程里阻塞 read，经 mpsc 回传
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<(String, String)>();
    let stdout_tx = out_tx.clone();
    let stderr_tx = out_tx.clone();
    drop(out_tx);

    let stdout_handle = tokio::task::spawn_blocking(move || {
        if let Some(mut out) = stdout {
            let mut raw: Vec<u8> = Vec::new();
            let mut truncated = false;
            let mut chunk = vec![0u8; 8192];
            let mut decoder = TerminalDecoder::new();
            loop {
                let n = match out.read(&mut chunk) {
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
    let stderr_handle = tokio::task::spawn_blocking(move || {
        if let Some(mut err) = stderr {
            let mut raw: Vec<u8> = Vec::new();
            let mut truncated = false;
            let mut chunk = vec![0u8; 8192];
            let mut decoder = TerminalDecoder::new();
            loop {
                let n = match err.read(&mut chunk) {
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

    // 6) 等待退出
    let (done_tx, mut done_rx) = mpsc::unbounded_channel::<Option<i32>>();
    let wait_child = child.clone();
    let wait_handle = tokio::task::spawn_blocking(move || {
        let code = wait_child.wait_and_read_exit_code();
        let _ = done_tx.send(code);
    });

    let mut stdout = String::new();
    let mut stderr = String::new();
    let mut exit_code: Option<Option<i32>> = None;
    let mut out_closed = false;
    let mut got_exit = false;
    let mut killed_by_timeout = false;
    let mut killed_by_user = false;
    // 超时计时器必须在循环外创建并固定，否则 select! 每轮都会新建 sleep，
    // 输出一刷屏就把计时归零，导致超时永远不触发。
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
            _ = &mut timeout_fut, if !killed_by_timeout && !killed_by_user => {
                child.terminate();
                kill_process_tree(pid);
                killed_by_timeout = true;
            }
            _ = ctx.cancel.cancelled(), if !killed_by_timeout && !killed_by_user => {
                child.terminate();
                kill_process_tree(pid);
                killed_by_user = true;
            }
        }
        if killed_by_timeout || killed_by_user {
            break;
        }
        if out_closed && got_exit {
            break;
        }
    }

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
                child.terminate();
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
    unregister_running_command(ctx.tool_call_id);
    let exit_code = if killed_by_timeout || killed_by_user {
        None
    } else {
        exit_code.flatten()
    };

    let env_note = if readonly_mode {
        format!("终端环境: {shell} · 只读（不可写）")
    } else if ctx.security.workspace.is_empty() {
        format!("终端环境: {shell} · 写隔离")
    } else {
        format!(
            "终端环境: {shell} · 写隔离（可写根: {}；区外写入会被拒绝）",
            ctx.security.workspace
        )
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
