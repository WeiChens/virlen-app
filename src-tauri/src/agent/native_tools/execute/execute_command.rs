//! `execute_command` 工具（原生）— shell 命令执行
//!
//! 流程：风险分类 → （按权限三态/legacy approvalMode 弹窗审批）→ 原生 spawn（沙盒优先）→ 超时/取消/终止。

use crate::agent::bridge::BridgeInteractionResult;
use crate::agent::native_tools::common::{arg_i64, arg_str};
use crate::agent::native_tools::{NativeToolCtx, NativeToolOutcome};
use serde_json::{json, Value};

use super::common::{
    classify_command, command_decision, permission_for_risk, permission_label, pty_available,
    resolve_decision, risk_info, run_command_native, sandbox_mode, with_bypass_hint,
    PermissionDecision, SandboxMode, PERM_SANDBOX_COMMAND,
};

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

    // sandbox:"off" → 申请「不使用沙盒（受限令牌）」执行本命令。
    // 用途：沙盒下必然失败的场景——命令的子进程需要用管道 stdio 拉起孙进程
    // （vitest / vite / jest / ts-node / node-gyp…），受限令牌会让那次 spawn 直接 EPERM，
    // 根因见 AGENTS §11.2。
    // ⚠️ 安全：该请求过「沙盒脱壳」权限门禁（与命令风险权限取更严格者；默认弹窗）；
    // readonly 模式直接拒绝（否则只读保护会被绕过）。
    let bypass_sandbox = matches!(
        arg_str(args, "sandbox")
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str(),
        "off" | "none"
    );
    if bypass_sandbox && sandbox_mode(ctx) == SandboxMode::Readonly {
        return Err(
            "沙盒处于只读模式，不支持绕过沙盒执行命令；请先在设置中切换沙盒模式（或改用常规终端）"
                .to_string(),
        );
    }

    // confirm:"terminal" → 终端内确认（Step 2 ①，WinkTerm `write_command` 的 L2 等价物）。
    // 仅当伪控制台可用时才真正走终端呈现；否则前端自动回落现有弹窗（降级可见）。
    let confirm_terminal = arg_str(args, "confirm")
        .map(|s| s.trim().eq_ignore_ascii_case("terminal"))
        .unwrap_or(false);
    // ⚠️ Rust 是「是否走终端」的唯一判定方（前端不猜平台，避免三平台 / 降级行为分叉）。
    let terminal_presentation = confirm_terminal && pty_available();

    let risk = classify_command(&cmd_str);
    let perm = permission_for_risk(risk);
    // 权限三态：permissions 表优先，回退 legacy approval_mode（兼容老客户端 / 测试）
    let base = command_decision(
        &ctx.security.permissions,
        &ctx.security.approval_mode,
        perm,
        risk,
    );
    // 申请绕过沙盒且沙盒启用（readonly 已在上方直接拒绝）→ 额外过「沙盒脱壳」权限门禁
    // （与风险权限**取更严格者**，默认 ask；用户可设为 allow 静默脱壳 / deny 直接禁止）。
    // ⚠️ 沙盒模式 off 时无沙盒可脱，不参与门禁（否则会对无关命令弹窗）。
    // 脱壳权限无 legacy 对应项 → approval_mode 传空串，只用权限表 / 注册表默认（ask）。
    let escape_decision = if bypass_sandbox && sandbox_mode(ctx) != SandboxMode::Off {
        Some(command_decision(
            &ctx.security.permissions,
            "",
            PERM_SANDBOX_COMMAND,
            risk,
        ))
    } else {
        None
    };
    // deny 优先；终端内确认强制至少 ask（安全底线）
    let decision = resolve_decision(base, escape_decision, confirm_terminal);

    if decision == PermissionDecision::Deny {
        let denied = if escape_decision == Some(PermissionDecision::Deny) {
            PERM_SANDBOX_COMMAND
        } else {
            perm
        };
        return Err(format!("操作已被权限设置禁止：{}", permission_label(denied)));
    }

    if decision == PermissionDecision::Ask {
        // 走用户交互桥（type=confirm_command_native），由 JS 复用同一个「授权确认」弹窗。
        // 审批在本地完成：用户「允许」后直接原生执行命令，避免命令参数跨桥丢失。
        let (_label, hint) = risk_info(risk);
        // 申请绕过沙盒：在风险提示后追加强警告（沙盒不可用时的退路，必须让用户看到后果）
        let hint = if bypass_sandbox {
            with_bypass_hint(&hint)
        } else {
            hint
        };
        // 触发本次确认的权限：仅因沙盒脱壳（基础 allow、脱壳 ask）时展示脱壳权限，
        // 让用户知道要放行的是哪条权限；否则展示命令风险权限。
        let shown_perm = if bypass_sandbox
            && base == PermissionDecision::Allow
            && escape_decision == Some(PermissionDecision::Ask)
        {
            PERM_SANDBOX_COMMAND
        } else {
            perm
        };
        let tips = arg_str(args, "tips").unwrap_or_default();
        let mut data = json!({
            // 通用授权字段（弹窗展示）：权限唯一 key + 权限名 + 说明 + 内容
            "permName": shown_perm,
            "title": permission_label(shown_perm),
            "subTitle": tips,
            "desc": cmd_str,
            "hint": hint,
            "risk": risk,
        });
        if let Value::Object(map) = &mut data {
            map.insert(
                "toolCallId".into(),
                Value::String(ctx.tool_call_id.to_string()),
            );
            if bypass_sandbox {
                // 供弹窗高亮 / 埋点识别（文案已在 hint 里）
                map.insert("sandboxBypass".into(), Value::Bool(true));
            }
            if terminal_presentation {
                // Step 2 ①：让前端在该 toolCallId 的终端块里渲染「待确认命令行」，
                // 而不是弹 modal。只加字段不加类型（桥载荷向后兼容）。
                map.insert("presentation".into(), Value::String("terminal".into()));
            }
        }

        let payload = ctx
            .bridge
            .request_user_interaction(ctx.sink, ctx.session_id, "confirm_command_native", data)
            .await
            .map_err(|e| format!("error: {}", e))?;

        match BridgeInteractionResult::parse(&payload) {
            BridgeInteractionResult::Value { content, .. } => {
                // 用户允许 → 执行命令；其他文本（如 `[error] xxx`）原样返回。
                // 终端内确认会回传 JSON（可能带用户改后的命令），弹窗路径仍是旧白名单。
                let (approved, exec_cmd) = parse_approval(&content, &cmd_str);
                if approved {
                    // 用户本人就是审批人 → 不二次审批；但改后的命令**必须重新分类**
                    // （风险升高只埋点、不记正文，见 §9 / §7 #20），且仍走沙盒 + PTY 同一条路径。
                    if exec_cmd != cmd_str {
                        let new_risk = classify_command(&exec_cmd);
                        if risk_rank(new_risk) > risk_rank(risk) {
                            crate::telemetry::track(
                                "interaction.command.confirm.escalated",
                                json!({ "from": risk, "to": new_risk }),
                            );
                        }
                    }
                    if bypass_sandbox {
                        // 审计：用户批准了「绕过沙盒」执行（不记录命令正文，遵循 §9 密钥/正文不采集）
                        crate::telemetry::track(
                            "tool.sandbox.bypass",
                            json!({ "tool_name": "execute_command", "risk": risk, "status": "approved" }),
                        );
                    }
                    return run_command_native(ctx, &exec_cmd, timeout, bypass_sandbox).await;
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
        run_command_native(ctx, &cmd_str, timeout, bypass_sandbox).await
    }
}

/// 命令风险等级排序（仅用于「编辑后风险升高」的埋点判定，不参与审批策略）。
fn risk_rank(risk: &str) -> u8 {
    match risk {
        "dangerous" => 2,
        "install" => 1,
        _ => 0,
    }
}

/// 解析审批回传文本，返回 `(是否放行, 实际要执行的命令)`。
///
/// - `content` 以 `{` 开头 → 先按 JSON 解析（终端内确认会回
///   `{"approved":true,"command":"<用户改后的命令>"}`）；
/// - 否则走旧白名单（`approved` / `允许` / `ok`）—— **现有弹窗路径行为完全不受影响**。
///
/// 终端路径必须回传命令正文：用户可能已经改过，只回「批准」会让 Rust 跑**旧命令**，
/// 直接违背「执行的是改后的版本」这条语义；命令正文本来就已经在桥里下发过。
fn parse_approval(content: &str, original: &str) -> (bool, String) {
    let trimmed = content.trim();
    if trimmed.starts_with('{') {
        if let Ok(v) = serde_json::from_str::<Value>(trimmed) {
            let approved = v
                .get("approved")
                .and_then(|b| b.as_bool())
                .unwrap_or(false);
            if approved {
                let cmd = v
                    .get("command")
                    .and_then(|c| c.as_str())
                    .unwrap_or("")
                    .trim()
                    .to_string();
                return (
                    true,
                    if cmd.is_empty() {
                        original.to_string()
                    } else {
                        cmd
                    },
                );
            }
            return (false, original.to_string());
        }
    }
    let normalized = trimmed.to_lowercase();
    if normalized == "approved" || normalized == "允许" || content == "ok" {
        return (true, original.to_string());
    }
    (false, original.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::bridge::AgentBridgeState;
    use crate::agent::cancellation::CancellationToken;
    use crate::agent::event_sink::TestEventSink;
    use crate::agent::native_tools::test_util::{is_process_alive, test_security, test_security_bare};
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

    // 本次新增：绕过沙盒（sandbox:"off"）的审批策略与文案。
    // 显式导入，不依赖 `use super::*` 对父模块 use 绑定的传递。
    use super::super::common::{
        command_decision, resolve_decision, with_bypass_hint, PermissionDecision,
        PERM_SANDBOX_COMMAND, PERM_TERMINAL_DANGEROUS, PERM_TERMINAL_INSTALL, PERM_TERMINAL_NORMAL,
        SANDBOX_BYPASS_HINT,
    };

    /// 决策阶梯：申请脱壳 → 与「沙盒脱壳」权限**取更严格者**（默认 ask）；
    /// deny 永远优先（不被放宽）；终端内确认强制至少 ask。
    #[test]
    fn escape_decision_takes_strictest() {
        // 脱壳权限 ask + 基础 allow/ask → ask（默认弹窗，行为与旧版一致）
        for base in [PermissionDecision::Allow, PermissionDecision::Ask] {
            assert_eq!(
                resolve_decision(base, Some(PermissionDecision::Ask), false),
                PermissionDecision::Ask,
                "脱壳权限 ask → 至少 ask"
            );
        }
        // 脱壳权限 allow + 基础 allow → allow（用户已授权，静默脱壳）
        assert_eq!(
            resolve_decision(
                PermissionDecision::Allow,
                Some(PermissionDecision::Allow),
                false
            ),
            PermissionDecision::Allow
        );
        // 脱壳权限 allow 不能放宽更严格的基础（危险命令仍需确认）
        assert_eq!(
            resolve_decision(
                PermissionDecision::Ask,
                Some(PermissionDecision::Allow),
                false
            ),
            PermissionDecision::Ask
        );
        // 脱壳权限 deny → 直接拒绝
        assert_eq!(
            resolve_decision(
                PermissionDecision::Allow,
                Some(PermissionDecision::Deny),
                false
            ),
            PermissionDecision::Deny
        );
        // 终端内确认 → 强制至少 ask
        assert_eq!(
            resolve_decision(PermissionDecision::Allow, None, true),
            PermissionDecision::Ask
        );
        // deny 永远优先（不被终端内确认 / 脱壳 allow 放宽）
        assert_eq!(
            resolve_decision(
                PermissionDecision::Deny,
                Some(PermissionDecision::Allow),
                true
            ),
            PermissionDecision::Deny,
            "deny 必须优先"
        );
        // 未申请脱壳（None）→ 基础决策不变
        assert_eq!(
            resolve_decision(PermissionDecision::Allow, None, false),
            PermissionDecision::Allow
        );

        // 脱壳权限默认 ask；权限表命中可覆盖；legacy approval_mode 不参与（传空串）
        use std::collections::BTreeMap;
        let empty = BTreeMap::new();
        assert_eq!(
            command_decision(&empty, "", PERM_SANDBOX_COMMAND, "safe"),
            PermissionDecision::Ask
        );
        let mut perms = BTreeMap::new();
        perms.insert(PERM_SANDBOX_COMMAND.to_string(), "allow".to_string());
        assert_eq!(
            command_decision(&perms, "", PERM_SANDBOX_COMMAND, "safe"),
            PermissionDecision::Allow
        );
    }

    /// 权限表优先；缺失时回退 legacy approval_mode（回归保护，语义与旧 commandApprovalMode 一致）。
    #[test]
    fn permission_priority_and_legacy_fallback() {
        use std::collections::BTreeMap;

        // 权限表命中 → 按表决策（表内值覆盖 legacy mode）
        let mut perms = BTreeMap::new();
        perms.insert(PERM_TERMINAL_NORMAL.to_string(), "allow".to_string());
        assert_eq!(
            command_decision(&perms, "all", PERM_TERMINAL_NORMAL, "safe"),
            PermissionDecision::Allow
        );
        perms.insert(PERM_TERMINAL_NORMAL.to_string(), "deny".to_string());
        assert_eq!(
            command_decision(&perms, "none", PERM_TERMINAL_NORMAL, "safe"),
            PermissionDecision::Deny
        );

        // 表缺失 → 回退 legacy approval_mode（与既有语义完全一致）
        let empty = BTreeMap::new();
        assert_eq!(
            command_decision(&empty, "all", PERM_TERMINAL_NORMAL, "safe"),
            PermissionDecision::Ask
        );
        assert_eq!(
            command_decision(&empty, "risky", PERM_TERMINAL_NORMAL, "safe"),
            PermissionDecision::Allow
        );
        assert_eq!(
            command_decision(&empty, "risky", PERM_TERMINAL_INSTALL, "install"),
            PermissionDecision::Allow
        );
        assert_eq!(
            command_decision(&empty, "risky", PERM_TERMINAL_DANGEROUS, "dangerous"),
            PermissionDecision::Ask
        );
        assert_eq!(
            command_decision(&empty, "install", PERM_TERMINAL_NORMAL, "safe"),
            PermissionDecision::Allow
        );
        assert_eq!(
            command_decision(&empty, "install", PERM_TERMINAL_INSTALL, "install"),
            PermissionDecision::Ask
        );
        assert_eq!(
            command_decision(&empty, "install", PERM_TERMINAL_DANGEROUS, "dangerous"),
            PermissionDecision::Ask
        );
        assert_eq!(
            command_decision(&empty, "none", PERM_TERMINAL_DANGEROUS, "dangerous"),
            PermissionDecision::Allow
        );
    }

    /// 绕过沙盒的警告必须拼在基础提示后（基础提示为空时不得产生前导换行）。
    #[test]
    fn bypass_hint_is_appended() {
        let with_base = with_bypass_hint("此命令可能对系统造成破坏，请确认是否执行");
        assert!(with_base.starts_with("此命令可能对系统造成破坏"));
        assert!(with_base.ends_with(SANDBOX_BYPASS_HINT));
        assert!(with_base.contains('\n'));
        assert_eq!(with_bypass_hint(""), SANDBOX_BYPASS_HINT);
    }

    /// readonly 模式必须拒绝绕过沙盒（否则只读保护可被绕过），且在审批之前失败。
    #[tokio::test]
    async fn readonly_mode_rejects_sandbox_bypass() {
        let dir = std::env::temp_dir().join(format!("virlen_native_ro_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut sec = test_security_bare(&dir.to_string_lossy());
        sec.sandbox_mode = "readonly".to_string();
        let sink = TestEventSink::new();
        let bridge = AgentBridgeState::default();
        let cancel = CancellationToken::new();
        let ctx = NativeToolCtx {
            session_id: "s_ro",
            tool_call_id: "tc_ro_test",
            cancel: &cancel,
            sink: &sink,
            bridge: &bridge,
            security: &sec,
        };
        let args = serde_json::json!({ "command": "echo hi", "sandbox": "off" });
        let err = execute_command_tool(&ctx, &args)
            .await
            .expect_err("readonly + sandbox:off 必须被拒绝");
        assert!(err.contains("只读模式"), "unexpected error: {err}");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Step 2 ①：解析审批回传（JSON 优先 → 旧白名单兼容）。
    #[test]
    fn test_parse_approval() {
        // JSON：批准 + 改后命令
        assert_eq!(
            parse_approval("{\"approved\":true,\"command\":\"echo hi\"}", "orig"),
            (true, "echo hi".to_string())
        );
        // JSON：批准但没带命令 → 用原命令
        assert_eq!(
            parse_approval("{\"approved\":true}", "orig"),
            (true, "orig".to_string())
        );
        // JSON：未批准
        assert_eq!(
            parse_approval("{\"approved\":false,\"command\":\"x\"}", "orig"),
            (false, "orig".to_string())
        );
        // JSON 解析失败 → 回退白名单（也不放行乱码）
        assert_eq!(parse_approval("{not json}", "orig"), (false, "orig".to_string()));
        // 旧白名单（弹窗路径，行为不变）
        assert_eq!(parse_approval("approved", "orig"), (true, "orig".to_string()));
        assert_eq!(parse_approval("  Approved ", "orig"), (true, "orig".to_string()));
        assert_eq!(parse_approval("允许", "orig"), (true, "orig".to_string()));
        assert_eq!(parse_approval("ok", "orig"), (true, "orig".to_string()));
        // 其他文本原样返回（不放行）
        assert_eq!(parse_approval("[error] x", "orig"), (false, "orig".to_string()));
    }

    /// Step 2 ①：编辑成危险 / 安装命令 → 风险等级升高（仅埋点，不二次审批）。
    #[test]
    fn test_terminal_confirm_reclassify_escalation() {
        assert_eq!(risk_rank("safe"), 0);
        assert_eq!(risk_rank("install"), 1);
        assert_eq!(risk_rank("dangerous"), 2);
        let safe = risk_rank(classify_command("Write-Output hi"));
        assert!(risk_rank(classify_command("Remove-Item -Recurse -Force X")) > safe);
        assert!(risk_rank(classify_command("npm install")) > safe);
    }

    /// 模拟「前端在终端块里确认」：等 `agent:user-interaction-request` 事件，
    /// 捕获其 `data`，并回传给定 payload。返回 (任务句柄, 捕获到的 data)。
    fn spawn_terminal_confirmer(
        sink: std::sync::Arc<TestEventSink>,
        bridge: std::sync::Arc<AgentBridgeState>,
        response_payload: serde_json::Value,
    ) -> (
        tokio::task::JoinHandle<bool>,
        std::sync::Arc<std::sync::Mutex<serde_json::Value>>,
    ) {
        let captured = std::sync::Arc::new(std::sync::Mutex::new(serde_json::Value::Null));
        let captured_out = captured.clone();
        let handle = tokio::spawn(async move {
            for _ in 0..600 {
                let found = {
                    let evs = sink.events.lock().unwrap();
                    evs.iter().find_map(|(name, payload)| {
                        if name == "agent:user-interaction-request" {
                            Some((
                                payload
                                    .get("requestId")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .to_string(),
                                payload
                                    .get("data")
                                    .cloned()
                                    .unwrap_or(serde_json::Value::Null),
                            ))
                        } else {
                            None
                        }
                    })
                };
                if let Some((rid, data)) = found {
                    if rid.is_empty() {
                        tokio::time::sleep(Duration::from_millis(25)).await;
                        continue;
                    }
                    *captured.lock().unwrap() = data;
                    crate::agent::bridge::handle_user_interaction_response(
                        &bridge,
                        &rid,
                        response_payload.clone(),
                    )
                    .await;
                    return true;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            false
        });
        (handle, captured_out)
    }

    /// Step 2 ①：终端内确认——回传的 JSON 带「改后的命令」，必须执行改后的版本。
    #[tokio::test]
    async fn test_execute_command_terminal_confirm_roundtrip() {
        let dir = std::env::temp_dir().join(format!("virlen_confirm_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        // readonly 避开缓存探测；approval_mode=all 强制走审批，便于驱动交互。
        let mut sec = test_security(&dir.to_string_lossy());
        sec.sandbox_mode = "readonly".to_string();
        sec.approval_mode = "all".to_string();
        let sink = std::sync::Arc::new(TestEventSink::new());
        let bridge = std::sync::Arc::new(AgentBridgeState::default());
        let cancel = CancellationToken::new();
        let ctx = NativeToolCtx {
            session_id: "s_confirm",
            tool_call_id: "tc_confirm",
            cancel: &cancel,
            sink: sink.as_ref(),
            bridge: bridge.as_ref(),
            security: &sec,
        };

        let (confirmer, captured) = spawn_terminal_confirmer(
            sink.clone(),
            bridge.clone(),
            json!({
                "__kind": "value",
                "value": "{\"approved\":true,\"command\":\"Write-Output 'EDITED_OK'\"}"
            }),
        );

        let args = json!({
            "command": "Write-Output 'ORIGINAL'",
            "confirm": "terminal",
            "timeout": 30
        });
        let outcome = tokio::time::timeout(
            Duration::from_secs(30),
            execute_native_tool(&ctx, "execute_command", &args),
        )
        .await
        .expect("execute_command 不应挂死")
        .expect("execute_command 不应报错");
        assert!(confirmer.await.unwrap(), "应出现用户交互请求");

        match outcome {
            NativeToolOutcome::Value { content, .. } => {
                assert!(content.contains("EDITED_OK"), "应执行用户改后的命令: {content}");
                assert!(
                    !content.contains("ORIGINAL"),
                    "不应执行原始命令: {content}"
                );
            }
            other => panic!("expected Value, got {other:?}"),
        }

        // PTY 可用（Windows）→ 交互 data 必须带 presentation:"terminal"；
        // 否则（非 Windows / 伪控制台不可用）必须**不下发**，让前端回落弹窗。
        let d = captured.lock().unwrap().clone();
        #[cfg(target_os = "windows")]
        assert_eq!(
            d.get("presentation").and_then(|v| v.as_str()),
            Some("terminal"),
            "PTY 可用时应下发 presentation=terminal: {d}"
        );
        #[cfg(not(target_os = "windows"))]
        assert!(
            d.get("presentation").is_none(),
            "无 PTY 时不得下发 presentation（降级回弹窗）: {d}"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Step 2 ①：终端内确认取消（Esc / Ctrl+C）→ 工具返回 `[User cancelled]`。
    #[tokio::test]
    async fn test_execute_command_terminal_confirm_cancelled() {
        let dir = std::env::temp_dir().join(format!("virlen_confirm_c_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut sec = test_security(&dir.to_string_lossy());
        sec.sandbox_mode = "readonly".to_string();
        sec.approval_mode = "all".to_string();
        let sink = std::sync::Arc::new(TestEventSink::new());
        let bridge = std::sync::Arc::new(AgentBridgeState::default());
        let cancel = CancellationToken::new();
        let ctx = NativeToolCtx {
            session_id: "s_confirm_c",
            tool_call_id: "tc_confirm_c",
            cancel: &cancel,
            sink: sink.as_ref(),
            bridge: bridge.as_ref(),
            security: &sec,
        };

        let (confirmer, _captured) = spawn_terminal_confirmer(
            sink.clone(),
            bridge.clone(),
            json!({ "__kind": "cancelled" }),
        );

        let args = json!({
            "command": "Write-Output 'SHOULD_NOT_RUN'",
            "confirm": "terminal",
            "timeout": 30
        });
        let outcome = tokio::time::timeout(
            Duration::from_secs(30),
            execute_native_tool(&ctx, "execute_command", &args),
        )
        .await
        .expect("execute_command 不应挂死")
        .expect("execute_command 不应报错");
        assert!(confirmer.await.unwrap(), "应出现用户交互请求");

        match outcome {
            NativeToolOutcome::Value { content, .. } => {
                assert_eq!(content, "[User cancelled]");
            }
            other => panic!("expected Value, got {other:?}"),
        }

        std::fs::remove_dir_all(&dir).ok();
    }
}
