//! `kill_background_service` 工具（原生）—— 杀掉后台服务（整棵进程树）。
//!
//! 语义：发出终止信号（Job Object 一键全杀 + 递归强杀兜底），最多再等 [`KILL_WAIT_MS`] 拿退出码，
//! 然后**如实**回报（等不到就说「已发信号，尚未确认退出」—— 不谎报成功）。
//! 对已结束的服务是幂等的：不杀，只把现状 + 未读输出回给模型。
//! 会话隔离：只在本会话内按 id 查。无审批（回收自己的资源）。

use crate::agent::native_tools::{NativeToolCtx, NativeToolOutcome};
use serde_json::{json, Value};

use super::common::{
    arg_trimmed, base_ui, cap_output, parse_read_mode, read_mode_name, render_output, status,
    with_output, KILL_WAIT_MS,
};
use super::registry;

/// 终止某个后台服务。
pub(crate) async fn kill_background_service_tool(
    ctx: &NativeToolCtx<'_>,
    args: &Value,
) -> Result<NativeToolOutcome, String> {
    let id = arg_trimmed(args, "id")
        .ok_or_else(|| "Missing required parameter: \"id\"".to_string())?;
    let entry = registry::get(ctx.session_id, &id).ok_or_else(|| {
        format!(
            "No background service with id \"{id}\" in this conversation. \
             Use list_background_services to see the ids that exist here."
        )
    })?;

    let (state_before, _, _) = entry.snapshot();
    let mut waited = false;
    if state_before == status::RUNNING {
        // AI 自己 kill：工具结果里已经有收尾状态 + 输出 → 不再另发「服务已结束」通知
        //（用户从面板终止是另一条路，那条要通知）。
        entry.state.mute_notice();
        entry.terminate();
        waited = entry.state.wait_finished(KILL_WAIT_MS).await;
        crate::telemetry::track(
            "tool.service.kill",
            json!({ "status": if waited { "exited" } else { "signalled" } }),
        );
    }

    let mode = parse_read_mode(args);
    let (stdout, stderr, dropped) = entry.read_output(&mode);
    let (text, truncated) = cap_output(&render_output(&stdout, &stderr));
    let (state, code, killed) = entry.snapshot();
    let now = crate::telemetry::now_ms();

    // 模型侧文案（固定英文）
    let mut content = format!(
        "Background service \"{}\" (id: {}) — status: {state}\nCommand: {}\n",
        entry.name, entry.id, entry.cmd
    );
    if state_before == status::RUNNING {
        if waited {
            content.push_str(&format!(
                "Stopped (whole process tree terminated{}) — exit code: {}\n",
                if killed { ", terminated by request" } else { "" },
                code.map(|c| c.to_string()).unwrap_or_else(|| "null".into())
            ));
        } else {
            content.push_str(&format!(
                "Termination signal sent, but the process had not exited after {}ms. \
                 It may still be shutting down — call get_background_service to confirm.\n",
                KILL_WAIT_MS
            ));
        }
    } else {
        content.push_str("It had already stopped, so nothing was killed.\n");
        if state == status::EXITED {
            content.push_str(&format!(
                "Exit code: {}\n",
                code.map(|c| c.to_string()).unwrap_or_else(|| "null".into())
            ));
        }
    }
    if dropped {
        content.push_str("(earlier output was discarded; only the most recent output is kept)\n");
    }
    if text.is_empty() {
        content.push_str(&format!("No unread output (mode: {}).", read_mode_name(&mode)));
    } else {
        content.push_str(&format!(
            "Output before stopping (mode: {}):\n{text}",
            read_mode_name(&mode)
        ));
    }

    let mut ui = with_output(base_ui(&entry, now), &stdout, &stderr, truncated);
    if let Value::Object(map) = &mut ui {
        map.insert("mode".into(), Value::String(read_mode_name(&mode).into()));
        map.insert("unreadChars".into(), Value::Number(entry.unread().into()));
        map.insert("killConfirmed".into(), Value::Bool(waited));
    }
    // 已确认退出 → 条目没必要再占会话名额（收尾输出已经随本次结果交给模型）。
    // ⚠️ 只在「本次真的杀了且已确认」时清；「发给信号但没等到」还得留着让模型复查。
    if state_before == status::RUNNING && waited {
        registry::remove(&entry.id);
    }

    Ok(NativeToolOutcome::Value {
        content: content.trim_end().to_string(),
        ui_data: Some(ui),
    })
}
