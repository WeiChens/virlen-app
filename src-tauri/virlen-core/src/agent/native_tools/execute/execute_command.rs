//! `execute_command` 工具（原生）— shell 命令执行
//!
//! 流程：风险分类 → （按权限三态/legacy approvalMode 弹窗审批）→ 原生 spawn（沙盒优先）→ 超时/取消/终止。

use crate::agent::bridge::BridgeInteractionResult;
use crate::agent::native_tools::common::{arg_i64, arg_str};
use crate::agent::native_tools::{NativeToolCtx, NativeToolOutcome};
use serde_json::{json, Value};

use super::common::{
    apply_rule_clearance, match_sandbox_ignore_rule, classify_command, command_decision,
    permission_for_risk, permission_label, pty_available, resolve_decision, risk_info,
    run_command_native, sandbox_mode, with_bypass_hint, with_rule_hint, PermissionDecision,
    SandboxMode, PERM_SANDBOX_COMMAND,
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
    let ai_requested_bypass = matches!(
        arg_str(args, "sandbox")
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

    // confirm:"terminal" → 终端内确认（Step 2 ①，WinkTerm `write_command` 的 L2 等价物）。
    // 仅当伪控制台可用时才真正走终端呈现；否则前端自动回落现有弹窗（降级可见）。
    let confirm_terminal = arg_str(args, "confirm")
        .map(|s| s.trim().eq_ignore_ascii_case("terminal"))
        .unwrap_or(false);
    // ⚠️ Rust 是「是否走终端」的唯一判定方（前端不猜平台，避免三平台 / 降级行为分叉）。
    let terminal_presentation = confirm_terminal && pty_available();

    // 「忽略沙盒命令」规则（设置 → 安全）：命中即**免脱壳审批 + 强制无沙盒执行**，
    // 所以即使 AI 没传 sandbox:"off" 也要判一次（见 common::rules 模块头注释）。
    // ⚠️ 判定完全在 Rust 侧本地完成（规则随 security 快照下发）：
    // 既无桥往返、也无 IO；text / regex 原生求值，js 交内嵌 QuickJS。
    // ⚠️ 只在沙盒**启用**时判定：off 时无沙盒可脱；readonly 时脱壳被禁止（规则静默忽略，
    // 命令继续走沙盒，绝不因命中规则而拒绝执行）。
    let rule_hit = if sandbox_mode(ctx) == SandboxMode::On {
        match_sandbox_ignore_rule(ctx, &cmd_str).await
    } else {
        None
    };
    if rule_hit.is_some() {
        // 留痕（只记工具名 / 原因，不记命令正文与规则名，遵循 §9）
        crate::telemetry::track(
            "tool.sandbox.bypass",
            json!({ "tool_name": "execute_command", "status": "auto_rule" }),
        );
    }
    // 实际是否以「不使用沙盒」方式执行：AI 显式申请 ∪ 命中规则
    let bypass_sandbox = ai_requested_bypass || rule_hit.is_some();

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
        let configured = command_decision(
            &ctx.security.permissions,
            "",
            PERM_SANDBOX_COMMAND,
            risk,
        );
        // 命中「忽略沙盒命令」规则 → 用户已用规则预先授权脱壳（ask 视作 allow）；
        // ⚠️ deny 仍然优先：规则不能推翻显式禁止
        Some(if rule_hit.is_some() {
            apply_rule_clearance(configured)
        } else {
            configured
        })
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
        // 只报**权限 name**（稳定 key，与设置页一一对应）：语言无关，
        // 且与 TS 执行器（`tools/execute/execute-command.ts`）逐字对齐（铁律 1）。
        return Err(format!(
            "Operation denied by the permission settings: {}",
            denied
        ));
    }

    if decision == PermissionDecision::Ask {
        // 走用户交互桥（type=confirm_command_native），由 JS 复用同一个「授权确认」弹窗。
        // 审批在本地完成：用户「允许」后直接原生执行命令，避免命令参数跨桥丢失。
        let (_label, hint) = risk_info(risk);
        // 追加沙盒脱壳警告（让用户看到后果）：
        // 命中规则时说明「为什么没申请也脱壳了」；AI 显式申请时用原警告。
        let hint = match &rule_hit {
            Some(rule_name) => with_rule_hint(&hint, rule_name),
            None if bypass_sandbox => with_bypass_hint(&hint),
            None => hint,
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
                // 用户没有放行（既非「批准」也不是「允许」）→ 命令一行都没跑，
                // ⚠️ 必须按**失败**回报：否则 tool 消息 is_error=false，工具卡片显示成绿色「成功」。
                Ok(NativeToolOutcome::error(content))
            }
            BridgeInteractionResult::Error { content, ui_data } => {
                Ok(NativeToolOutcome::Error { content, ui_data })
            }
            BridgeInteractionResult::Shelved => Ok(NativeToolOutcome::Shelved),
            // 用户拒绝授权 / Esc 取消 → 未执行任何命令。
            // ⚠️ 同样走 Error 通道（status=failed），与 JS 桥路径（tool_executor.rs::handle_user_interaction）
            // 和 TS 引擎保持一致，避免「拒绝授权」被渲染成绿色成功。
            BridgeInteractionResult::Cancelled => {
                Ok(NativeToolOutcome::error("[User cancelled]"))
            }
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
mod tests;
