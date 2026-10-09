//! `start_background_service` 工具（原生）—— 起一个**常驻**命令（dev server / watch / 长跑任务）。
//!
//! 流程与 `execute_command` **同一条审批链**（分类 → 权限三态 → 沙盒脱壳门禁 → 忽略规则 →
//! 交互弹窗），差别只在两点：
//! 1. 基础决策用**新权限** `terminal.background.execute`（用户可单独控制「后台服务」要不要问）；
//! 2. 审批通过后进程进入后台（`runner::supervise`），工具只在 `defaultWaitTime` 内等启动输出。

use std::sync::Arc;

use crate::agent::bridge::BridgeInteractionResult;
use crate::agent::native_tools::execute::common::{
    apply_rule_clearance, classify_command, command_decision, match_sandbox_ignore_rule,
    permission_label, resolve_decision, risk_info, sandbox_mode, with_bypass_hint, with_rule_hint,
    PermissionDecision, SandboxBypass, SandboxMode, PERM_SANDBOX_COMMAND, PERM_TERMINAL_BACKGROUND,
};
use crate::agent::native_tools::{NativeToolCtx, NativeToolOutcome};
use serde_json::{json, Value};

use super::common::{
    arg_clamped_i64, arg_trimmed, base_ui, cap_output, render_output, with_output, DEFAULT_WAIT_MS,
    MAX_WAIT_MS, SERVICE_START_HINT,
};
use super::registry::{self, ServiceEntry, ServiceState};
use super::runner::{self, WaitOutcome};

/// 起一个后台服务。
pub(crate) async fn start_background_service_tool(
    ctx: &NativeToolCtx<'_>,
    args: &Value,
) -> Result<NativeToolOutcome, String> {
    let name = arg_trimmed(args, "name")
        .ok_or_else(|| "Missing required parameter: \"name\"".to_string())?;
    if name.chars().count() > 80 {
        return Err("\"name\" is too long (max 80 characters)".to_string());
    }
    let cmd = arg_trimmed(args, "cmd")
        .ok_or_else(|| "Missing required parameter: \"cmd\"".to_string())?;
    let wait_ms = arg_clamped_i64(args, "defaultWaitTime", DEFAULT_WAIT_MS, 0, MAX_WAIT_MS);

    // sandbox:"off" → 申请无沙盒执行（与 execute_command 同语义、同一份权限门禁）。
    let ai_requested_bypass = matches!(
        arg_trimmed(args, "sandbox")
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str(),
        "off" | "none"
    );
    if ai_requested_bypass && sandbox_mode(ctx) == SandboxMode::Readonly {
        return Err(
            "The sandbox is in read-only mode, so bypassing it to run a command is not allowed; switch the sandbox mode in settings first (or use a regular terminal)"
                .to_string(),
        );
    }

    // 「忽略沙盒命令」规则（设置 → 安全）：命中即免脱壳审批 + 强制无沙盒执行。
    // ⚠️ 只在沙盒启用时判定（off 时无沙盒可脱；readonly 时脱壳被禁止，规则静默忽略）。
    let rule_hit = if sandbox_mode(ctx) == SandboxMode::On {
        match_sandbox_ignore_rule(ctx, &cmd).await
    } else {
        None
    };
    if rule_hit.is_some() {
        crate::telemetry::track(
            "tool.sandbox.bypass",
            json!({ "tool_name": "start_background_service", "status": "auto_rule" }),
        );
    }
    let bypass_sandbox = ai_requested_bypass || rule_hit.is_some();
    let bypass = if rule_hit.is_some() {
        SandboxBypass::Rule
    } else if ai_requested_bypass {
        SandboxBypass::Requested
    } else {
        SandboxBypass::None
    };

    // 风险分类仅用于弹窗配色 / 提示 / 埋点；**基础决策走新权限**（后台服务单独可控）。
    // ⚠️ 新权限没有 legacy 对应项 → approval_mode 传空串，避免老客户端的 approvalMode 顶掉它。
    let risk = classify_command(&cmd);
    let base = command_decision(
        &ctx.security.permissions,
        "",
        PERM_TERMINAL_BACKGROUND,
        risk,
    );
    let escape_decision = if bypass_sandbox && sandbox_mode(ctx) != SandboxMode::Off {
        let configured = command_decision(&ctx.security.permissions, "", PERM_SANDBOX_COMMAND, risk);
        Some(if rule_hit.is_some() {
            apply_rule_clearance(configured)
        } else {
            configured
        })
    } else {
        None
    };
    let decision = resolve_decision(base, escape_decision, false);

    if decision == PermissionDecision::Deny {
        let denied = if escape_decision == Some(PermissionDecision::Deny) {
            PERM_SANDBOX_COMMAND
        } else {
            PERM_TERMINAL_BACKGROUND
        };
        return Err(format!(
            "Operation denied by the permission settings: {}",
            denied
        ));
    }

    // 容量 / 重名检查**放在审批之前**：不想让用户先点「允许」再被告知放不下。
    registry::ensure_capacity(ctx.session_id)?;
    if let Some(existing) = registry::find_running_by_name(ctx.session_id, &name) {
        return Err(format!(
            "A background service named \"{name}\" is already running in this conversation (id: {}, pid {}). \
             Use get_background_service to read its output, or kill_background_service to stop it first.",
            existing.id, existing.pid
        ));
    }

    if decision == PermissionDecision::Ask {
        let (_label, hint) = risk_info(risk);
        let hint = match &rule_hit {
            Some(rule_name) => with_rule_hint(&hint, rule_name),
            None if bypass_sandbox => with_bypass_hint(&hint),
            None => hint,
        };
        // 服务专属说明垫在最后：用户点「允许」前必须知道它是常驻的（与命令的区别就在这儿）。
        let hint = if hint.is_empty() {
            SERVICE_START_HINT.to_string()
        } else {
            format!("{hint}\n{SERVICE_START_HINT}")
        };
        let shown_perm = if bypass_sandbox
            && base == PermissionDecision::Allow
            && escape_decision == Some(PermissionDecision::Ask)
        {
            PERM_SANDBOX_COMMAND
        } else {
            PERM_TERMINAL_BACKGROUND
        };
        let tips = arg_trimmed(args, "tips").unwrap_or_default();
        let mut data = json!({
            "permName": shown_perm,
            "title": permission_label(shown_perm),
            "subTitle": tips,
            "desc": cmd,
            "hint": hint,
            "risk": risk,
        });
        if let Value::Object(map) = &mut data {
            map.insert(
                "toolCallId".into(),
                Value::String(ctx.tool_call_id.to_string()),
            );
            // 让前端弹窗能区分「这是个常驻服务」（老前端忽略未知字段，向后兼容）
            map.insert("backgroundService".into(), Value::Bool(true));
            if bypass_sandbox {
                map.insert("sandboxBypass".into(), Value::Bool(true));
            }
        }

        let payload = ctx
            .bridge
            .request_user_interaction(
                ctx.sink,
                ctx.session_id,
                "confirm_command_native",
                data,
            )
            .await
            .map_err(|e| format!("error: {e}"))?;
        match BridgeInteractionResult::parse(&payload) {
            BridgeInteractionResult::Value { content, .. } => {
                if !is_approved(&content) {
                    // 用户没放行 → 一行都没跑，按失败回报（与 execute_command 同口径）
                    return Ok(NativeToolOutcome::error(content));
                }
                if bypass_sandbox {
                    crate::telemetry::track(
                        "tool.sandbox.bypass",
                        json!({ "tool_name": "start_background_service", "risk": risk, "status": "approved" }),
                    );
                }
            }
            BridgeInteractionResult::Error { content, ui_data } => {
                return Ok(NativeToolOutcome::Error { content, ui_data })
            }
            BridgeInteractionResult::Shelved => return Ok(NativeToolOutcome::Shelved),
            BridgeInteractionResult::Cancelled => return Ok(NativeToolOutcome::error("[User cancelled]")),
        }
    }

    // ===== spawn =====
    let spawned = match runner::spawn_service(ctx, &cmd, bypass).await {
        Ok(s) => s,
        Err(e) => return Ok(runner::failed_outcome(&name, &cmd, &e)),
    };
    let now = crate::telemetry::now_ms();
    let state = Arc::new(ServiceState::new());
    let id = registry::next_id();
    let env_note = spawned.env_note.clone();
    let sandbox = spawned.sandbox.to_string();
    let pid = spawned.pid;
    let terminator = spawned.terminator.clone();
    // 运行中事件（前端徽标）：与命令路径同一个事件名与字段（`agent:tool-env`）。
    crate::agent::native_tools::execute::common::emit_sandbox_env(ctx, &sandbox);

    let entry = Arc::new(ServiceEntry::new(
        id.clone(),
        ctx.session_id.to_string(),
        name.clone(),
        cmd.clone(),
        pid,
        now,
        sandbox,
        state.clone(),
        terminator.clone(),
    ));
    // 先入表，再交常驻任务接管：等待任务在进程退出时要发「结束通知」，而通知要读条目的
    // name / id / cmd（见 `runner::supervise` / `notice.rs`）。
    registry::insert(entry.clone());
    // 常驻接管：读任务 + 等待任务。**必须在工具返回前挂上**（否则工具返回后没人收输出）。
    runner::supervise(spawned, entry.clone());

    // 等待窗口（前端「终止」按钮在这个窗口内可用）。
    // ⚠️ 给注册表包一层：前端点「终止」走的是**运行中命令注册表**的终止器，它会直接杀进程 ——
    // 若不先把「被终止」置位，等待任务可能先把状态落成「自行退出」，模型就分不清是哪种了。
    let state_for_click = state.clone();
    let registry_terminator: crate::agent::native_tools::execute::common::Terminator = {
        let inner = terminator.clone();
        Arc::new(move || {
            state_for_click.kill_requested.store(true, std::sync::atomic::Ordering::SeqCst);
            inner();
        })
    };
    let kill_requested = runner::register_call(ctx, pid, &registry_terminator);
    let outcome = runner::wait_window(ctx, &state, wait_ms, &kill_requested).await;
    runner::unregister_call(ctx);

    // 用户取消 / 点了「终止」：前端终止按钮走的是「运行中命令注册表」的终止器，
    // 它只会杀进程、不会置位本服务的 `kill_requested` —— 这里补一刀（幂等）并等状态落定，
    // 否则快照会拿到 killed=false，模型分不清「被终止」与「自己退出」。
    if matches!(outcome, WaitOutcome::Cancelled) {
        entry.terminate();
        let _ = state.wait_finished(500).await;
    }
    // 等待窗口到此结束：「窗口内退出」由本工具的返回（已退出 + 退出码 + 窗口内输出）交代，
    // 不再另发一条「服务已结束」通知 —— 同一件事说两遍（`ServiceState::startup_window`）。
    state.close_startup_window();

    let (status, code, killed) = entry.snapshot();
    let (stdout, stderr, dropped) = read_new(&entry);
    let (text, truncated) = cap_output(&render_output(&stdout, &stderr));

    // 结果文案（模型侧固定英文）
    let mut content = String::new();
    if !env_note.is_empty() {
        content.push_str(&env_note);
        content.push('\n');
    }
    match status {
        super::common::status::RUNNING => {
            content.push_str(&format!(
                "Background service \"{name}\" is running (id: {id}, pid {pid}).\n"
            ));
        }
        super::common::status::EXITED => {
            content.push_str(&format!(
                "Background service \"{name}\" already exited during the first {:.3}s (id: {id}, pid {pid}).\n",
                wait_ms as f64 / 1000.0
            ));
        }
        _ => {
            content.push_str(&format!(
                "Background service \"{name}\" state: {status} (id: {id}).\n"
            ));
        }
    }
    content.push_str(&format!("Command: {cmd}\n"));
    if status == super::common::status::EXITED {
        content.push_str(&format!(
            "Exit code: {}\n",
            code.map(|c| c.to_string()).unwrap_or_else(|| "null".into())
        ));
    }
    if dropped {
        content.push_str("(earlier output was discarded; only the most recent output is kept)\n");
    }
    if !text.is_empty() {
        content.push_str(&format!(
            "Output during the first {:.3}s:\n{text}\n",
            wait_ms as f64 / 1000.0
        ));
    }
    match status {
        super::common::status::RUNNING => content.push_str(
            "It keeps running in the background after this tool call, and it exists only in this conversation. \
             Use get_background_service to read new output and kill_background_service to stop it.",
        ),
        super::common::status::EXITED => content.push_str(
            "It is not running now. Read the output above to find out why, then fix the command and start it again.",
        ),
        _ => {}
    }
    content = content.trim_end().to_string();

    let mut ui = with_output(
        base_ui(&entry, crate::telemetry::now_ms()),
        &stdout,
        &stderr,
        truncated,
    );
    if let Value::Object(map) = &mut ui {
        map.insert("mode".into(), Value::String("start".into()));
        map.insert("waitedMs".into(), Value::Number(wait_ms.into()));
        map.insert("unreadChars".into(), Value::Number(entry.unread().into()));
    }

    // 用户取消 / 点了「终止」：服务已被杀（cancel 路径要自己补一刀），不能报成功 ——
    // 否则模型会以为它还在跑，往后一直去 get 一个已经死掉的服务。
    if matches!(outcome, WaitOutcome::Cancelled) {
        entry.terminate();
        return Ok(NativeToolOutcome::error_with_ui(
            format!(
                "Background service \"{name}\" (id: {id}) was terminated before the wait finished.\nCommand: {cmd}"
            ),
            ui,
        ));
    }
    // 等待窗口内就退出且退出码非 0 / 被终止 → 启动失败，按失败回报
    //（与 execute_command 的「退出码 >= 2 → Error」同口径）。
    if status == super::common::status::EXITED && (killed || code.unwrap_or(0) != 0) {
        return Ok(NativeToolOutcome::error_with_ui(content, ui));
    }

    Ok(NativeToolOutcome::Value {
        content,
        ui_data: Some(ui),
    })
}

/// 读取某个服务自上次读取以来的新输出（stdout / stderr 分开返回 + 是否丢了开头）。
fn read_new(entry: &Arc<ServiceEntry>) -> (String, String, bool) {
    let (stdout, dropped_out) = entry.state.stdout.lock().unwrap().read_new();
    let (stderr, dropped_err) = entry.state.stderr.lock().unwrap().read_new();
    (stdout, stderr, dropped_out || dropped_err)
}

/// 审批回传文本是否表示「允许」。
///
/// 原生命令审批路径固定回 `'approved'`（`services/tool-service/command_confirm.ts`）；
/// 另外两个是历史弹窗路径的放行词，一并接受（与 `execute_command` 的白名单一致）。
fn is_approved(content: &str) -> bool {
    let trimmed = content.trim();
    let normalized = trimmed.to_lowercase();
    normalized == "approved" || normalized == "允许" || trimmed == "ok"
}
