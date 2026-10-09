//! `get_background_service` 工具（原生）—— 看某个后台服务的状态 / 新输出 / 退出码。
//!
//! 会话隔离：只在本会话内按 id 查；跨会话的 id 一律回「本会话没有该服务」（不泄露别处是否存在）。
//! 无审批（只读自己的资源）。

use crate::agent::native_tools::{NativeToolCtx, NativeToolOutcome};
use serde_json::Value;

use super::common::{
    arg_clamped_i64, arg_trimmed, base_ui, cap_output, format_uptime, parse_read_mode,
    read_mode_name, render_output, status, with_output,
};
use super::registry;
use super::runner::STATUS_TICK;

/// `waitMs` 上限（等构建完成 / 等服务退出都在这个窗口内）
const MAX_GET_WAIT_MS: i64 = 60_000;

/// 读取某个后台服务的输出与状态。
pub(crate) async fn get_background_service_tool(
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

    // 可选的「先等一等」：等到进程退出（`waitMs` 到点为止），或等到输出里出现 `waitFor`。
    // 这是给 dev server 用的：「等它打印 ready / Local:」比盲等固定时间靠谱。
    let wait_ms = arg_clamped_i64(args, "waitMs", 0, 0, MAX_GET_WAIT_MS);
    let wait_for = arg_trimmed(args, "waitFor");
    let mut matched = false;
    if wait_ms > 0 || wait_for.is_some() {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(wait_ms.max(0) as u64);
        loop {
            if !entry.is_running() {
                break;
            }
            if let Some(needle) = &wait_for {
                if output_contains(&entry, needle) {
                    matched = true;
                    break;
                }
            } else if wait_ms == 0 {
                break;
            }
            if tokio::time::Instant::now() >= deadline {
                break;
            }
            // 新输出 / 状态变化都会唤醒；`STATUS_TICK` 兜住「通知发在注册前」的竞态
            tokio::select! {
                _ = entry.state.notify.notified() => {}
                _ = tokio::time::sleep(STATUS_TICK) => {}
            }
        }
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
    content.push_str(&format!(
        "Process id: {} · started {} ago\n",
        entry.pid,
        format_uptime(now - entry.started_at)
    ));
    if state == status::EXITED {
        content.push_str(&format!(
            "Exit code: {} ({})\n",
            code.map(|c| c.to_string()).unwrap_or_else(|| "null".into()),
            if killed { "terminated" } else { "exited on its own" }
        ));
    }
    if dropped {
        content.push_str("(earlier output was discarded; only the most recent output is kept)\n");
    }
    if let Some(needle) = &wait_for {
        content.push_str(&format!(
            "Waited for output containing \"{needle}\": {}\n",
            if matched {
                "matched"
            } else {
                "not matched before the wait ended"
            }
        ));
    }
    if text.is_empty() {
        content.push_str(&format!(
            "No new output (mode: {}).",
            read_mode_name(&mode)
        ));
    } else {
        content.push_str(&format!("Output (mode: {}):\n{text}", read_mode_name(&mode)));
    }

    let mut ui = with_output(base_ui(&entry, now), &stdout, &stderr, truncated);
    if let Value::Object(map) = &mut ui {
        map.insert("mode".into(), Value::String(read_mode_name(&mode).into()));
        map.insert("unreadChars".into(), Value::Number(entry.unread().into()));
        map.insert("waitMatched".into(), Value::Bool(matched));
    }

    Ok(NativeToolOutcome::Value {
        content: content.trim_end().to_string(),
        ui_data: Some(ui),
    })
}

/// 输出（stdout + stderr 窗口）里是否出现 `needle`（大小写不敏感）。
///
/// 只看**窗口内的尾部**（环形容量 20 万字符）：dev server 的 ready 提示总在最近一段输出里。
fn output_contains(entry: &super::registry::ServiceEntry, needle: &str) -> bool {
    let needle = needle.to_lowercase();
    let out = entry.state.stdout.lock().unwrap();
    if out.window().to_lowercase().contains(&needle) {
        return true;
    }
    let err = entry.state.stderr.lock().unwrap();
    err.window().to_lowercase().contains(&needle)
}
