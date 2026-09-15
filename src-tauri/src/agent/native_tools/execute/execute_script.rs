//! `execute_script` 工具（原生）— 创建脚本文件并执行，可选执行后立即删除。
//!
//! 流程：沙盒校验路径 → （无沙盒保护时按 approvalMode 审批）→ 写脚本 → 执行 → 按 end_del_file 删除。

use crate::agent::bridge::BridgeInteractionResult;
use crate::agent::native_tools::common::{arg_bool, arg_i64, arg_str, resolve_safe_path};
use crate::agent::native_tools::{NativeToolCtx, NativeToolOutcome};
use crate::file_ops;
use serde_json::{json, Value};

use super::common::{classify_command, risk_info, run_command_native, sandbox_mode, SandboxMode};

/// 执行脚本工具（原生）— 创建脚本文件并执行，可选执行后立即删除。
///
/// 流程：沙盒校验路径 → （按 commandApprovalMode 审批）→ 写脚本 → 执行 → 按 end_del_file 删除。
pub(crate) async fn execute_script_tool(
    ctx: &NativeToolCtx<'_>,
    args: &Value,
) -> Result<NativeToolOutcome, String> {
    let file_path = arg_str(args, "file_path").unwrap_or_default();
    if file_path.trim().is_empty() {
        return Err("Missing required parameter: \"file_path\"".to_string());
    }
    let content = arg_str(args, "file_content").unwrap_or_default();
    let cmd_str = arg_str(args, "command").unwrap_or_default();
    if cmd_str.trim().is_empty() {
        return Err("Missing required parameter: \"command\"".to_string());
    }
    let end_del_file = arg_bool(args, "end_del_file").unwrap_or(true);
    let mut timeout = arg_i64(args, "timeout").unwrap_or(30);
    if timeout < 0 {
        timeout = 30;
    }
    if timeout > 300 {
        timeout = 300;
    }

    // 沙盒校验（写权限），非法路径快速失败
    let full_path = resolve_safe_path(&file_path, "w", ctx.security)?;

    // 目标文件已存在则驳回，避免覆盖既有文件
    if std::path::Path::new(&full_path).exists() {
        return Err(format!("错误：脚本文件已存在，已驳回以免覆盖 — {}", full_path));
    }

    // 沙盒模式判定：沙盒开启（默认 on）或只读（readonly）时已有 OS 级隔离，
    // 无需再弹窗；仅「完全访问模式」（off）才强制确认。
    if sandbox_mode(ctx) != SandboxMode::Off {
        return finalize_script_run(ctx, &cmd_str, timeout, &full_path, &content, end_del_file).await;
    }

    // 无沙盒保护 → 强制弹窗审批：脚本内容无法静态分析（命令名可能只是 node/python，
    // 但脚本内部可能是任意代码），一律交由用户确认。
    let risk = classify_command(&cmd_str);
    let (base_label, base_hint) = risk_info(risk);
    let label = if risk == "safe" {
        "执行脚本".to_string()
    } else {
        base_label
    };
    let hint = if base_hint.is_empty() {
        "此操作会创建并执行脚本文件，请确认是否允许".to_string()
    } else {
        base_hint
    };
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
        BridgeInteractionResult::Value {
            content: interaction_msg,
            ..
        } => {
            let normalized = interaction_msg.trim().to_lowercase();
            if normalized == "approved" || normalized == "允许" || interaction_msg == "ok" {
                // 用户允许 → 写脚本 + 执行 + 按需删除
                return finalize_script_run(ctx, &cmd_str, timeout, &full_path, &content, end_del_file)
                    .await;
            }
            // 未实际执行（拒绝/其他）→ 未落盘，无需清理
            Ok(NativeToolOutcome::Value {
                content: interaction_msg,
                ui_data: None,
            })
        }
        BridgeInteractionResult::Error(msg) => Ok(NativeToolOutcome::Error(msg)),
        BridgeInteractionResult::Shelved => Ok(NativeToolOutcome::Shelved),
        BridgeInteractionResult::Cancelled => Ok(NativeToolOutcome::Value {
            content: "[User cancelled]".to_string(),
            ui_data: None,
        }),
    }
}

/// 脚本执行收尾：写脚本 → 执行命令 → 按 end_del_file 删除脚本。
async fn finalize_script_run(
    ctx: &NativeToolCtx<'_>,
    cmd_str: &str,
    timeout_secs: i64,
    full_path: &str,
    content: &str,
    end_del_file: bool,
) -> Result<NativeToolOutcome, String> {
    // 1. 写脚本文件（自动创建父目录）
    let full_path_c = full_path.to_string();
    let content_c = content.to_string();
    let write_res =
        tokio::task::spawn_blocking(move || file_ops::write_file(&full_path_c, &content_c)).await;
    match write_res {
        Ok(Ok(_)) => {}
        Ok(Err(e)) => return Err(format!("错误：写入脚本文件失败 — {}", e)),
        Err(e) => return Err(format!("Task join error: {}", e)),
    }

    // 2. 执行命令
    let outcome = run_command_native(ctx, cmd_str, timeout_secs).await;

    // 3. 按需删除脚本（含失败/超时）
    if !end_del_file {
        return outcome;
    }
    let del_note = delete_script_file(full_path).await;
    match outcome {
        Ok(NativeToolOutcome::Value { content, ui_data }) => Ok(NativeToolOutcome::Value {
            content: format!("{}\n{}", content, del_note),
            ui_data: attach_note(ui_data, &del_note),
        }),
        Ok(NativeToolOutcome::Error(msg)) => {
            Ok(NativeToolOutcome::Error(format!("{}\n{}", msg, del_note)))
        }
        Err(e) => Err(format!("{}\n{}", e, del_note)),
        Ok(other) => Ok(other),
    }
}

/// 把删除提示写入 ui_data.note（供 UI 展示），保留原有字段。
fn attach_note(ui_data: Option<Value>, note: &str) -> Option<Value> {
    match ui_data {
        Some(Value::Object(mut map)) => {
            map.insert("note".into(), Value::String(note.to_string()));
            Some(Value::Object(map))
        }
        Some(other) => Some(json!({ "data": other, "note": note })),
        None => Some(json!({ "note": note })),
    }
}

/// 删除脚本文件（移至回收站），返回 UI 提示文本。
async fn delete_script_file(full_path: &str) -> String {
    let p = full_path.to_string();
    match tokio::task::spawn_blocking(move || trash::delete(&p)).await {
        Ok(Ok(_)) => format!("🗑️ 已删除脚本文件: {}", full_path),
        Ok(Err(e)) => format!("⚠️ 脚本文件删除失败: {} — {}", full_path, e),
        Err(e) => format!("⚠️ 脚本文件删除失败: {} — Task join error: {}", full_path, e),
    }
}
