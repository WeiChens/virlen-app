//! `execute_script` 工具（原生）— 创建脚本文件并执行，可选执行后立即删除。
//!
//! 流程：沙盒校验路径 → （按 script.execute 权限三态审批）→ 写脚本 → 执行 → 按 end_del_file 删除。

use crate::agent::bridge::BridgeInteractionResult;
use crate::agent::native_tools::common::{arg_bool, arg_i64, arg_str, resolve_safe_path};
use crate::agent::native_tools::{NativeToolCtx, NativeToolOutcome};
use crate::file_ops;
use serde_json::{json, Value};

use super::common::{
    classify_command, command_decision, permission_label, resolve_decision, risk_info,
    run_command_native, sandbox_mode, with_bypass_hint, PermissionDecision, SandboxMode,
    PERM_SANDBOX_SCRIPT, PERM_SCRIPT,
};

/// 执行脚本工具（原生）— 创建脚本文件并执行，可选执行后立即删除。
///
/// 流程：沙盒校验路径 → （按 script.execute 权限三态审批）→ 写脚本 → 执行 → 按 end_del_file 删除。
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

    // sandbox:"off" → 申请「不使用沙盒」执行脚本（与 execute_command 同语义）。
    // ⚠️ 只读模式直接拒绝（否则只读保护会被绕过）。
    let bypass_sandbox = matches!(
        arg_str(args, "sandbox")
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str(),
        "off" | "none"
    );
    if bypass_sandbox && sandbox_mode(ctx) == SandboxMode::Readonly {
        return Err(
            "沙盒处于只读模式，不支持绕过沙盒执行脚本；请先在设置中切换沙盒模式（或改用常规终端）"
                .to_string(),
        );
    }

    // 沙盒校验（写权限），非法路径快速失败
    let full_path = resolve_safe_path(&file_path, "w", ctx.security)?;

    // 目标文件已存在则驳回，避免覆盖既有文件
    if std::path::Path::new(&full_path).exists() {
        return Err(format!(
            "错误：脚本文件已存在，已驳回以免覆盖 — {}",
            full_path
        ));
    }

    // 权限：脚本执行独立门禁（script.execute，默认每次弹窗；与命令风险分类无关）。
    // permissions 表优先，回退 legacy approval_mode（兼容老客户端 / 测试）。
    let base = command_decision(
        &ctx.security.permissions,
        &ctx.security.approval_mode,
        PERM_SCRIPT,
        "safe",
    );
    // 申请绕过沙盒且沙盒启用（readonly 已在上方直接拒绝）→ 额外过「沙盒脱壳·脚本执行」门禁
    // （与脚本权限**取更严格者**，默认 ask）。沙盒模式 off 时无沙盒可脱，不参与门禁。
    // 脱壳权限无 legacy 对应项 → approval_mode 传空串，只用权限表 / 注册表默认（ask）。
    let escape_decision = if bypass_sandbox && sandbox_mode(ctx) != SandboxMode::Off {
        Some(command_decision(
            &ctx.security.permissions,
            "",
            PERM_SANDBOX_SCRIPT,
            "safe",
        ))
    } else {
        None
    };
    match resolve_decision(base, escape_decision, false) {
        PermissionDecision::Deny => {
            let denied = if escape_decision == Some(PermissionDecision::Deny) {
                PERM_SANDBOX_SCRIPT
            } else {
                PERM_SCRIPT
            };
            return Err(format!(
                "操作已被权限设置禁止：{}",
                permission_label(denied)
            ));
        }
        PermissionDecision::Allow => {
            return finalize_script_run(
                ctx,
                &cmd_str,
                timeout,
                &full_path,
                &content,
                end_del_file,
                bypass_sandbox,
            )
            .await;
        }
        PermissionDecision::Ask => {}
    }

    // ask → 弹窗审批：脚本内容无法静态分析（命令名可能只是 node/python，
    // 但脚本内部可能是任意代码），一律交由用户确认。
    let risk = classify_command(&cmd_str);
    let (_base_label, base_hint) = risk_info(risk);
    let hint = if base_hint.is_empty() {
        "此操作会创建并执行脚本文件，请确认是否允许".to_string()
    } else {
        base_hint
    };
    // 申请绕过沙盒：在提示后追加强警告（让用户看到后果）
    let hint = if bypass_sandbox {
        with_bypass_hint(&hint)
    } else {
        hint
    };
    // 触发本次确认的权限（同上：仅因沙盒脱壳时展示脱壳权限）
    let shown_perm = if bypass_sandbox
        && base == PermissionDecision::Allow
        && escape_decision == Some(PermissionDecision::Ask)
    {
        PERM_SANDBOX_SCRIPT
    } else {
        PERM_SCRIPT
    };
    let tips = arg_str(args, "tips").unwrap_or_default();
    let mut data = json!({
        // 通用授权字段（弹窗展示）
        "permName": shown_perm,
        "title": permission_label(shown_perm),
        "subTitle": tips,
        // ⚠️ 正文展示**脚本内容**（用户据此判断是否放行），运行命令放在 command 作说明
        "desc": content,
        "command": cmd_str,
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
                return finalize_script_run(
                    ctx,
                    &cmd_str,
                    timeout,
                    &full_path,
                    &content,
                    end_del_file,
                    bypass_sandbox,
                )
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

/// 目标文件是否为 PowerShell 脚本（Windows PowerShell 5.1 会按系统 ANSI 代码页解析无 BOM 的这类文件）。
fn is_powershell_script(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.ends_with(".ps1") || lower.ends_with(".psm1")
}

/// 给脚本内容补 UTF-8 BOM（幂等）—— 与 JS 侧 `applyScriptBom` 等价。
///
/// ⚠️ 为什么必须加：Windows PowerShell 5.1 读取**无 BOM** 的 .ps1 时不猜 UTF-8，
/// 而是按系统 ANSI 代码页（中文系统 CP936/GBK）解析源文件，脚本里的中文字面量
/// 在「解析阶段」就变成乱码（"脚本" → "鑴氭湰"）—— 之后无论怎么设置
/// `[Console]::OutputEncoding` 都还原不回来（输出侧本来就对，问题在输入端）。
/// 带 BOM 后 5.1 会按 UTF-8 解析。
///
/// 只对 Windows 上的 .ps1/.psm1 生效：其它脚本加 BOM 有害（.sh 的 shebang 会失效，
/// .js/.py 虽能容忍但没必要）。
fn with_script_bom(path: &str, content: &str, is_windows: bool) -> String {
    if is_windows && is_powershell_script(path) && !content.starts_with('\u{FEFF}') {
        format!("\u{FEFF}{}", content)
    } else {
        content.to_string()
    }
}

/// 脚本执行收尾：写脚本 → 执行命令 → 按 end_del_file 删除脚本。
///
/// `bypass_sandbox`：`sandbox:"off"` 申请（已在上方过「沙盒脱壳」权限门禁）→ 裸跑。
async fn finalize_script_run(
    ctx: &NativeToolCtx<'_>,
    cmd_str: &str,
    timeout_secs: i64,
    full_path: &str,
    content: &str,
    end_del_file: bool,
    bypass_sandbox: bool,
) -> Result<NativeToolOutcome, String> {
    // 1. 写脚本文件（自动创建父目录）
    let full_path_c = full_path.to_string();
    // ⚠️ 落盘内容可能与入参不同：Windows 上的 .ps1/.psm1 需补 UTF-8 BOM（见 with_script_bom）
    let content_c = with_script_bom(full_path, content, cfg!(target_os = "windows"));
    let write_res =
        tokio::task::spawn_blocking(move || file_ops::write_file(&full_path_c, &content_c)).await;
    match write_res {
        Ok(Ok(_)) => {}
        Ok(Err(e)) => return Err(format!("错误：写入脚本文件失败 — {}", e)),
        Err(e) => return Err(format!("Task join error: {}", e)),
    }

    // 2. 执行命令（bypass_sandbox 来自 sandbox:"off" 申请，已在上方过权限门禁）
    let outcome = run_command_native(ctx, cmd_str, timeout_secs, bypass_sandbox).await;

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
        Err(e) => format!(
            "⚠️ 脚本文件删除失败: {} — Task join error: {}",
            full_path, e
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::{is_powershell_script, with_script_bom};

    #[test]
    fn powershell_script_ext_detection() {
        assert!(is_powershell_script("C:/ws/temp/run.ps1"));
        assert!(is_powershell_script("C:\\ws\\temp\\run.PSM1"));
        assert!(!is_powershell_script("C:/ws/temp/run.js"));
        assert!(!is_powershell_script("C:/ws/temp/run.sh"));
        assert!(!is_powershell_script("C:/ws/temp/ps1"));
        assert!(!is_powershell_script("C:/ws/temp/run.ps1.bak"));
    }

    #[test]
    fn bom_only_for_windows_powershell() {
        // Windows + .ps1 → 补 BOM（PowerShell 5.1 据此按 UTF-8 解析，中文才不乱码）
        let out = with_script_bom("C:/ws/run.ps1", "Write-Output \"脚本\"", true);
        assert!(out.starts_with('\u{FEFF}'));
        assert_eq!(&out[3..], "Write-Output \"脚本\"");
        // 非 Windows → 不加（macOS/Linux 的 pwsh 默认按 UTF-8 解析）
        assert_eq!(with_script_bom("C:/ws/run.ps1", "x", false), "x");
        // Windows 上的非 PowerShell 脚本 → 不加（.sh 加 BOM 会让 shebang 失效）
        assert_eq!(with_script_bom("C:/ws/run.sh", "x", true), "x");
        assert_eq!(with_script_bom("C:/ws/run.js", "x", true), "x");
    }

    #[test]
    fn bom_is_idempotent() {
        let once = with_script_bom("C:/ws/run.ps1", "abc", true);
        let twice = with_script_bom("C:/ws/run.ps1", &once, true);
        assert_eq!(once, twice);
    }
}
