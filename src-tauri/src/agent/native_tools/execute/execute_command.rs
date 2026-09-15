//! `execute_command` 工具（原生）— shell 命令执行
//!
//! 流程：风险分类 → （按 approvalMode 弹窗审批）→ 原生 spawn（沙盒优先）→ 超时/取消/终止。

use crate::agent::bridge::BridgeInteractionResult;
use crate::agent::native_tools::common::{arg_i64, arg_str};
use crate::agent::native_tools::{NativeToolCtx, NativeToolOutcome};
use serde_json::{json, Value};

use super::common::{classify_command, risk_info, run_command_native};

/// 执行 shell 命令（原生）
pub(crate) async fn execute_command_tool(
    ctx: &NativeToolCtx<'_>,
    args: &Value,
) -> Result<NativeToolOutcome, String> {
    let cmd_str = arg_str(args, "command").unwrap_or_default();
    if cmd_str.trim().is_empty() {
        return Err("Missing required parameter: \"command\"".to_string());
    }
    let mut timeout = arg_i64(args, "timeout").unwrap_or(30);
    if timeout < 0 {
        timeout = 30;
    }
    if timeout > 300 {
        timeout = 300;
    }

    let risk = classify_command(&cmd_str);
    let mode = ctx.security.approval_mode.as_str();
    let needs_approval = match mode {
        "all" => true,
        "risky" => risk == "dangerous",
        "install" => risk != "safe",
        _ => false,
    };

    if needs_approval {
        // 走用户交互桥（type=confirm_command_native），由 JS 复用同一个确认弹窗。
        // 审批在本地完成：用户「允许」后直接原生执行命令，避免命令参数跨桥丢失。
        let (label, hint) = risk_info(risk);
        let tips = arg_str(args, "tips").unwrap_or_default();
        let mut data = json!({
            "command": cmd_str,
            "risk": risk,
            "label": label,
            "hint": hint,
            "tips": tips,
        });
        if let Value::Object(map) = &mut data {
            map.insert(
                "toolCallId".into(),
                Value::String(ctx.tool_call_id.to_string()),
            );
        }

        let payload = ctx
            .bridge
            .request_user_interaction(ctx.sink, ctx.session_id, "confirm_command_native", data)
            .await
            .map_err(|e| format!("error: {}", e))?;

        match BridgeInteractionResult::parse(&payload) {
            BridgeInteractionResult::Value { content, .. } => {
                // 用户允许 → 执行命令；其他文本（如 `[error] xxx`）原样返回
                let normalized = content.trim().to_lowercase();
                if normalized == "approved" || normalized == "允许" || content == "ok" {
                    return run_command_native(ctx, &cmd_str, timeout).await;
                }
                return Ok(NativeToolOutcome::Value {
                    content,
                    ui_data: None,
                });
            }
            BridgeInteractionResult::Error(msg) => Ok(NativeToolOutcome::Error(msg)),
            BridgeInteractionResult::Shelved => Ok(NativeToolOutcome::Shelved),
            BridgeInteractionResult::Cancelled => Ok(NativeToolOutcome::Value {
                content: "[User cancelled]".to_string(),
                ui_data: None,
            }),
        }
    } else {
        run_command_native(ctx, &cmd_str, timeout).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::bridge::AgentBridgeState;
    use crate::agent::cancellation::CancellationToken;
    use crate::agent::event_sink::TestEventSink;
    use crate::agent::native_tools::test_util::{is_process_alive, test_security_bare};
    use crate::agent::native_tools::execute_native_tool;
    use std::time::Duration;

    /// 集成测试：真实 spawn 一个长命令，中途触发「终止」，
    /// 验证工具能及时返回、不会因进程树没杀干净而无限挂起（前端终止按钮失效的根因）。
    #[tokio::test]
    async fn test_execute_command_kill_returns_promptly() {
        let dir = std::env::temp_dir().join(format!("virlen_native_kill_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let sec = test_security_bare(&dir.to_string_lossy());
        let sink = TestEventSink::new();
        let bridge = AgentBridgeState::default();
        let cancel = CancellationToken::new();
        let tool_call_id = "tc_kill_test";
        let ctx = NativeToolCtx {
            session_id: "s_kill",
            tool_call_id,
            cancel: &cancel,
            sink: &sink,
            bridge: &bridge,
            security: &sec,
        };

        // 长命令：确保 kill 发生在执行中途
        let cmd = if cfg!(target_os = "windows") {
            "ping -n 60 127.0.0.1"
        } else {
            "sleep 60"
        };
        let args = json!({ "command": cmd, "timeout": 300 });

        // 独立任务：1.5s 后触发终止（kill 入口在命令 spawn 时注册）
        let killer_tool_call_id = tool_call_id.to_string();
        let killer = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(1500)).await;
            assert!(
                super::super::kill_running_command(&killer_tool_call_id),
                "kill entry should exist"
            );
        });

        // 终止后应尽快返回（清理等待有 3s 上限），10s 上限防止测试本身挂起
        let outcome = tokio::time::timeout(
            Duration::from_secs(10),
            execute_native_tool(&ctx, "execute_command", &args),
        )
        .await
        .expect("execute_command should return promptly after kill")
        .expect("execute_command should not error");

        killer.await.unwrap();

        match outcome {
            NativeToolOutcome::Value { content, .. } => {
                assert!(
                    content.contains("命令已被用户取消"),
                    "unexpected content: {}",
                    content
                );
            }
            other => panic!("expected Value, got {:?}", other),
        }

        std::fs::remove_dir_all(&dir).ok();
    }

    /// 集成测试：模拟用户场景 —— 命令里用 Start-Process 拉起子进程（输出重定向到文件）。
    /// 验证：终止后工具及时返回，且 Start-Process 的子进程也被 taskkill /T 连带杀死（不留孤儿）。
    #[tokio::test]
    async fn test_execute_command_kill_kills_start_process_child() {
        let dir = std::env::temp_dir()
            .join(format!("virlen_native_kill_sp_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let pid_file = dir.join("child.pid");
        let pid_file_str = pid_file.to_string_lossy().replace('\\', "/");
        let out_file = dir.join("sc_out.txt").to_string_lossy().replace('\\', "/");
        let err_file = dir.join("sc_err.txt").to_string_lossy().replace('\\', "/");

        let sec = test_security_bare(&dir.to_string_lossy());
        let sink = TestEventSink::new();
        let bridge = AgentBridgeState::default();
        let cancel = CancellationToken::new();
        let tool_call_id = "tc_kill_sp_test";
        let ctx = NativeToolCtx {
            session_id: "s_kill_sp",
            tool_call_id,
            cancel: &cancel,
            sink: &sink,
            bridge: &bridge,
            security: &sec,
        };

        // 用户场景的结构：Start-Process 拉起一个长跑子进程（stdout/stderr 重定向到文件），
        // 把子进程 PID 写到文件，然后脚本无限等待（等待期间管道无输出）。
        let cmd = format!(
            "$out = '{}'; $p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c ping -n 60 127.0.0.1' -PassThru -NoNewWindow -RedirectStandardOutput '{}' -RedirectStandardError '{}'; Set-Content -Path $out -Value $p.Id; while ($true) {{ Start-Sleep -Milliseconds 500 }}",
            pid_file_str, out_file, err_file
        );
        let args = json!({ "command": cmd, "timeout": 300 });

        let killer_tool_call_id = tool_call_id.to_string();
        let killer = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(2500)).await;
            assert!(
                super::super::kill_running_command(&killer_tool_call_id),
                "kill entry should exist"
            );
        });

        let outcome = tokio::time::timeout(
            Duration::from_secs(10),
            execute_native_tool(&ctx, "execute_command", &args),
        )
        .await
        .expect("should return promptly after kill")
        .expect("should not error");

        killer.await.unwrap();

        match &outcome {
            NativeToolOutcome::Value { content, .. } => {
                assert!(
                    content.contains("命令已被用户取消"),
                    "unexpected content: {}",
                    content
                );
            }
            other => panic!("expected Value, got {:?}", other),
        }

        // 检查 Start-Process 的子进程是否被连带杀死（等 taskkill 生效）
        if let Ok(pid_str) = std::fs::read_to_string(&pid_file) {
            let child_pid: u32 = pid_str.trim().parse().unwrap_or(0);
            if child_pid > 0 {
                tokio::time::sleep(Duration::from_millis(1500)).await;
                assert!(
                    !is_process_alive(child_pid),
                    "Start-Process child pid {} should be killed by taskkill /T (no orphan)",
                    child_pid
                );
            }
        }

        std::fs::remove_dir_all(&dir).ok();
    }

    /// 集成测试：命令超时（timeout 路径，非手动终止）后，命令派生的孙进程也必须被杀干净。
    /// 这是用户报告的复现场景：`execute_command` 超时返回「已终止」，但 node/npm/python
    /// 等后代进程仍存活。Job Object + 递归枚举兜底应保证整棵进程树（含两层孙进程）全灭。
    #[tokio::test]
    async fn test_execute_command_timeout_kills_grandchildren() {
        let dir = std::env::temp_dir()
            .join(format!("virlen_native_timeout_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let child_pid_file = dir.join("t_child.pid").to_string_lossy().replace('\\', "/");
        let gc_pid_file = dir.join("t_gc.pid").to_string_lossy().replace('\\', "/");
        let out_file = dir.join("t_out.txt").to_string_lossy().replace('\\', "/");
        let err_file = dir.join("t_err.txt").to_string_lossy().replace('\\', "/");

        let sec = test_security_bare(&dir.to_string_lossy());
        let sink = TestEventSink::new();
        let bridge = AgentBridgeState::default();
        let cancel = CancellationToken::new();
        let tool_call_id = "tc_timeout_test";
        let ctx = NativeToolCtx {
            session_id: "s_timeout",
            tool_call_id,
            cancel: &cancel,
            sink: &sink,
            bridge: &bridge,
            security: &sec,
        };

        // powershell 拉起 cmd → ping（两层后代），把子/孙 PID 写到文件，然后无限 sleep。
        // 超时 2s 触发 → 应整棵进程树全灭。
        let cmd = format!(
            "$child = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c ping -n 60 127.0.0.1' -PassThru -NoNewWindow -RedirectStandardOutput '{out}' -RedirectStandardError '{err}'; Set-Content -Path '{child}' -Value $child.Id; Start-Sleep -Seconds 2; $g = Get-CimInstance Win32_Process -Filter \"ParentProcessId = $($child.Id)\" | Select-Object -First 1; if ($g) {{ Set-Content -Path '{gc}' -Value $g.ProcessId }}; while ($true) {{ Start-Sleep -Milliseconds 500 }}",
            out = out_file,
            err = err_file,
            child = child_pid_file,
            gc = gc_pid_file,
        );
        let args = json!({ "command": cmd, "timeout": 2 });

        let outcome = tokio::time::timeout(
            Duration::from_secs(15),
            execute_native_tool(&ctx, "execute_command", &args),
        )
        .await
        .expect("execute_command should return promptly after timeout")
        .expect("should not error");

        match &outcome {
            NativeToolOutcome::Value { content, .. } => {
                assert!(
                    content.contains("超时"),
                    "unexpected content: {}",
                    content
                );
            }
            other => panic!("expected Value, got {:?}", other),
        }

        // 等 taskkill / Job Object 生效后，子进程、孙进程都应已死亡
        tokio::time::sleep(Duration::from_millis(2000)).await;
        if let Ok(pid_str) = std::fs::read_to_string(&child_pid_file) {
            let child_pid: u32 = pid_str.trim().parse().unwrap_or(0);
            if child_pid > 0 {
                assert!(
                    !is_process_alive(child_pid),
                    "child pid {} should be killed after timeout (no orphan)",
                    child_pid
                );
            }
        }
        if let Ok(pid_str) = std::fs::read_to_string(&gc_pid_file) {
            let gc_pid: u32 = pid_str.trim().parse().unwrap_or(0);
            if gc_pid > 0 {
                assert!(
                    !is_process_alive(gc_pid),
                    "grandchild pid {} should be killed after timeout (no orphan)",
                    gc_pid
                );
            }
        }

        std::fs::remove_dir_all(&dir).ok();
    }
}
