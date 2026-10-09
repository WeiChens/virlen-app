//! `list_background_services` 工具（原生）—— 列出**本会话**的后台服务。
//!
//! 会话隔离的直接体现：只列 `ctx.session_id` 名下的服务（其它会话的一个都不出现）。
//! 无审批（只读自己的资源）。

use crate::agent::native_tools::{NativeToolCtx, NativeToolOutcome};
use serde_json::{json, Value};

use super::common::{base_ui, format_uptime, status};
use super::registry;

/// 列出本会话的后台服务（含已结束但还能查看输出的那些）。
pub(crate) async fn list_background_services_tool(
    ctx: &NativeToolCtx<'_>,
    _args: &Value,
) -> Result<NativeToolOutcome, String> {
    let entries = registry::list(ctx.session_id);
    let now = crate::telemetry::now_ms();

    if entries.is_empty() {
        return Ok(NativeToolOutcome::Value {
            content: "No background services in this conversation.".to_string(),
            ui_data: Some(json!({ "mode": "list", "services": [] })),
        });
    }

    // 模型侧文案（固定英文）：一行一个服务，字段顺序固定 —— 模型读得懂，也方便人肉核对。
    let mut content = format!(
        "Background services in this conversation ({}):\n",
        entries.len()
    );
    let mut services: Vec<Value> = Vec::with_capacity(entries.len());
    for entry in &entries {
        let (state, code, killed) = entry.snapshot();
        let uptime = format_uptime(now - entry.started_at);
        let unread = entry.unread();
        let mut line = format!(
            "- {} \"{}\" — {state}, pid {}, up {uptime}, unread output {} chars — {}",
            entry.id, entry.name, entry.pid, unread, entry.cmd
        );
        if state == status::EXITED {
            line.push_str(&format!(
                " (exit code {}, {})",
                code.map(|c| c.to_string()).unwrap_or_else(|| "null".into()),
                if killed { "terminated" } else { "exited on its own" }
            ));
        }
        if !entry.is_running() && unread > 0 {
            line.push_str(" [has unread output — read it with get_background_service]");
        }
        content.push_str(&line);
        content.push('\n');

        let mut ui = base_ui(entry, now);
        if let Value::Object(map) = &mut ui {
            map.insert("unreadChars".into(), Value::Number(unread.into()));
        }
        services.push(ui);
    }
    content.push_str(
        "Use get_background_service with an id to read output, kill_background_service to stop one.",
    );

    Ok(NativeToolOutcome::Value {
        content,
        ui_data: Some(json!({ "mode": "list", "services": services })),
    })
}
