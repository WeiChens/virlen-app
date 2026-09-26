//! `execute_script` 工具（原生）— 创建脚本文件并执行，可选执行后立即删除。
//!
//! 流程：沙盒校验路径 → （按 script.execute 权限三态审批）→ 写脚本 → 执行 → 按 end_del_file 删除。

use crate::agent::bridge::BridgeInteractionResult;
use crate::agent::native_tools::common::{arg_bool, arg_i64, arg_str, resolve_safe_path};
use crate::agent::native_tools::{NativeToolCtx, NativeToolOutcome};
use crate::file_ops;
use serde_json::{json, Value};

use super::common::{
    apply_rule_clearance, match_sandbox_ignore_rule, classify_command, command_decision,
    permission_label, resolve_decision, risk_info, run_command_native, sandbox_mode,
    with_bypass_hint, with_rule_hint, PermissionDecision, SandboxMode, PERM_SANDBOX_SCRIPT,
    PERM_SCRIPT,
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
    // ⚠️ 只读模式直接拒绝，否则只读保护会被绕过。
    let ai_requested_bypass = matches!(
        arg_str(args, "sandbox")
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str(),
        "off" | "none"
    );
    if ai_requested_bypass && sandbox_mode(ctx) == SandboxMode::Readonly {
        return Err(
            "The sandbox is in read-only mode, so bypassing it to run a script is not allowed; switch the sandbox mode in settings first (or use a regular terminal)"
                .to_string(),
        );
    }

    // 沙盒校验（写权限），非法路径快速失败
    let full_path = resolve_safe_path(&file_path, "w", ctx.security)?;

    // 目标文件已存在则驳回，避免覆盖既有文件
    if std::path::Path::new(&full_path).exists() {
        return Err(format!(
            "Error: the script file already exists; refusing to overwrite it — {}",
            full_path
        ));
    }

    // 「忽略沙盒命令」规则（设置 → 安全）：与 execute_command 同语义 —— 命中即免脱壳审批并强制无沙盒执行
    // （AI 没传 sandbox:"off" 也生效），匹配对象是运行命令（不是脚本正文，见 `common::rules` 模块头注释）。
    // 放在「脚本已存在」快速失败之后：不值得为一条必然报错的调用多判一次规则。
    // ⚠️ 只在沙盒启用时判定：off 时无沙盒可脱；readonly 时脱壳被禁止（规则静默忽略）。
    let rule_hit = if sandbox_mode(ctx) == SandboxMode::On {
        match_sandbox_ignore_rule(ctx, &cmd_str).await
    } else {
        None
    };
    if rule_hit.is_some() {
        // 留痕（只记工具名 / 原因，不记命令正文与规则名，遵循 §9）
        crate::telemetry::track(
            "tool.sandbox.bypass",
            json!({ "tool_name": "execute_script", "status": "auto_rule" }),
        );
    }
    // 实际是否以「不使用沙盒」方式执行：AI 显式申请 ∪ 命中规则
    let bypass_sandbox = ai_requested_bypass || rule_hit.is_some();

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
        let configured = command_decision(
            &ctx.security.permissions,
            "",
            PERM_SANDBOX_SCRIPT,
            "safe",
        );
        // 命中「忽略沙盒命令」规则 → 用户已用规则预先授权脱壳（ask 视作 allow）；
        // ⚠️ deny 仍优先：规则不能推翻显式禁止
        Some(if rule_hit.is_some() {
            apply_rule_clearance(configured)
        } else {
            configured
        })
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
            // 只报**权限 name**（稳定 key，与设置页一一对应）：语言无关，
            // 且与 TS 执行器（`tools/execute/execute-script.ts`）逐字对齐（铁律 1）。
            return Err(format!(
                "Operation denied by the permission settings: {}",
                denied
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
    // 追加沙盒脱壳警告（让用户看到后果）：命中规则时说明「为什么没申请也脱壳了」
    let hint = match &rule_hit {
        Some(rule_name) => with_rule_hint(&hint, rule_name),
        None if bypass_sandbox => with_bypass_hint(&hint),
        None => hint,
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
        // 正文展示脚本内容（用户据此判断是否放行），运行命令放在 command 作说明
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
            // 未实际执行（拒绝/其他）→ 未落盘，无需清理。
            // 必须走 Error 通道：脚本一行都没跑，UI 不能显示成绿色「成功」。
            Ok(NativeToolOutcome::error(interaction_msg))
        }
        BridgeInteractionResult::Error { content, ui_data } => {
            Ok(NativeToolOutcome::Error { content, ui_data })
        }
        BridgeInteractionResult::Shelved => Ok(NativeToolOutcome::Shelved),
        // 用户拒绝授权 / Esc 取消 → 脚本未落盘、未执行 → 同样按失败回报
        // （与 execute_command 原生路径、JS 桥路径、TS 引擎保持一致）
        BridgeInteractionResult::Cancelled => {
            Ok(NativeToolOutcome::error("[User cancelled]"))
        }
    }
}

/// 目标文件是否为 PowerShell 脚本（Windows PowerShell 5.1 会按系统 ANSI 代码页解析无 BOM 的这类文件）。
fn is_powershell_script(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.ends_with(".ps1") || lower.ends_with(".psm1")
}

/// 给脚本内容补 UTF-8 BOM（幂等）—— 与 JS 侧 `applyScriptBom` 等价。
///
/// 必须加：PowerShell 5.1 读无 BOM 的 .ps1 时按系统 ANSI 代码页解析，中文字面量在解析阶段就变乱码
/// （"脚本" → "鑴氭湰"），之后再设 `[Console]::OutputEncoding` 也还原不回来。只对 Windows 的 .ps1/.psm1
/// 生效（.sh 加 BOM 会让 shebang 失效）。
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
    // 落盘内容可能与入参不同：Windows 的 .ps1/.psm1 需补 UTF-8 BOM（见 with_script_bom）
    let content_c = with_script_bom(full_path, content, cfg!(target_os = "windows"));
    let write_res =
        tokio::task::spawn_blocking(move || file_ops::write_file(&full_path_c, &content_c)).await;
    match write_res {
        Ok(Ok(_)) => {}
        Ok(Err(e)) => return Err(format!("Error: failed to write the script file — {}", e)),
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
            content: format!("{}\n{}", content, del_note.text),
            ui_data: attach_note(ui_data, &del_note),
        }),
        Ok(NativeToolOutcome::Error { content, ui_data }) => Ok(NativeToolOutcome::Error {
            content: format!("{}\n{}", content, del_note.text),
            // 失败同样保留结构化字段（并在有 note 时补上）——UI 才能按界面语言渲染（L6）
            ui_data: attach_note(ui_data, &del_note),
        }),
        Err(e) => Err(format!("{}\n{}", e, del_note.text)),
        Ok(other) => Ok(other),
    }
}

/// 脚本删除结果：模型侧英文文本 + 供 UI 按界面语言渲染的结构化字段。
///
/// ⚠️ 与 JS 侧 `ScriptDeleteNote`（`tools/execute/execute-script.ts`）逐字对齐（铁律 1）：`text` 为模型侧
/// 文案，`kind` / `path` / `error` 是语言无关数据，由 `TerminalBlock` 重建展示文本（旧消息无这些字段 → 回退
/// `note` 文本）。
struct ScriptDeleteNote {
    text: String,
    kind: &'static str,
    path: String,
    error: Option<String>,
}

/// 把删除提示写入 ui_data（供 UI 展示 / 本地化渲染），保留原有字段。
fn attach_note(ui_data: Option<Value>, note: &ScriptDeleteNote) -> Option<Value> {
    let with_note = |mut map: serde_json::Map<String, Value>| {
        map.insert("note".into(), Value::String(note.text.clone()));
        map.insert("noteKind".into(), Value::String(note.kind.to_string()));
        map.insert("notePath".into(), Value::String(note.path.clone()));
        if let Some(err) = &note.error {
            map.insert("noteError".into(), Value::String(err.clone()));
        }
        map
    };
    match ui_data {
        Some(Value::Object(map)) => Some(Value::Object(with_note(map))),
        Some(other) => {
            let mut map = serde_json::Map::new();
            map.insert("data".into(), other);
            Some(Value::Object(with_note(map)))
        }
        None => Some(Value::Object(with_note(serde_json::Map::new()))),
    }
}

/// 删除脚本文件（移至回收站），返回模型侧文本 + 结构化字段。
async fn delete_script_file(full_path: &str) -> ScriptDeleteNote {
    let p = full_path.to_string();
    match tokio::task::spawn_blocking(move || trash::delete(&p)).await {
        Ok(Ok(_)) => ScriptDeleteNote {
            text: format!("🗑️ Script file deleted: {}", full_path),
            kind: "deleted",
            path: full_path.to_string(),
            error: None,
        },
        Ok(Err(e)) => script_delete_failure(full_path, e.to_string()),
        Err(e) => script_delete_failure(full_path, format!("Task join error: {}", e)),
    }
}

/// 删除失败的统一构造（`text` 必须与 TS 侧 `deleteScriptFile` 的失败分支逐字对齐）。
fn script_delete_failure(full_path: &str, error: String) -> ScriptDeleteNote {
    ScriptDeleteNote {
        text: format!(
            "⚠️ Failed to delete the script file: {} — {}",
            full_path, error
        ),
        kind: "delete_failed",
        path: full_path.to_string(),
        error: Some(error),
    }
}

#[cfg(test)]
mod tests {
    use super::{attach_note, is_powershell_script, script_delete_failure, with_script_bom, ScriptDeleteNote};
    use serde_json::json;

    #[test]
    fn script_delete_note_structure() {
        // 失败分支：文案与 TS 侧 `deleteScriptFile` 逐字对齐，且带结构化字段（UI 据此本地化）
        let note = script_delete_failure("C:/ws/run.js", "boom".to_string());
        assert_eq!(note.kind, "delete_failed");
        assert_eq!(
            note.text,
            "⚠️ Failed to delete the script file: C:/ws/run.js — boom"
        );
        assert_eq!(note.error.as_deref(), Some("boom"));
        assert_eq!(note.path, "C:/ws/run.js");
    }

    #[test]
    fn attach_note_preserves_existing_fields() {
        let note = ScriptDeleteNote {
            text: "note-text".to_string(),
            kind: "deleted",
            path: "C:/ws/run.js".to_string(),
            error: None,
        };
        // 原有 ui_data 字段保留，只追加 note*
        let ui = attach_note(Some(json!({ "stdout": "hi" })), &note).unwrap();
        assert_eq!(ui["stdout"], "hi");
        assert_eq!(ui["note"], "note-text");
        assert_eq!(ui["noteKind"], "deleted");
        assert_eq!(ui["notePath"], "C:/ws/run.js");
        assert!(ui.get("noteError").is_none());
        // 非对象 ui_data 也不丢（包进 data）
        let ui2 = attach_note(Some(json!("raw")), &note).unwrap();
        assert_eq!(ui2["data"], "raw");
        assert_eq!(ui2["noteKind"], "deleted");
        // 无 ui_data → 只带 note 字段
        let ui3 = attach_note(None, &note).unwrap();
        assert_eq!(ui3["noteKind"], "deleted");
        assert!(ui3.get("stdout").is_none());
    }

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
