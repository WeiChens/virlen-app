//! 「忽略沙盒命令」规则 —— 脱壳决策与 JS 侧判定查询（execute 分类共用）
//!
//! 用户在「设置 → 安全 → 忽略沙盒命令」维护一组命令规则。命中规则的命令：
//!   1. **免除「沙盒脱壳」审批**（`sandbox.command.execute` / `sandbox.script.execute`
//!      的 `ask` 视作 `allow`）；
//!   2. **强制以「不使用沙盒」方式执行** —— 即使 AI 没传 `sandbox:"off"`。
//!
//! 典型用途：`npm/pnpm install`、`vitest` / `vite` / `jest` / `node-gyp` 等需要管道
//! stdio 的命令（沙盒的受限令牌会让子进程 spawn 直接 EPERM，见 AGENTS §11.2），
//! 用户不想每次都点一次授权弹窗。
//!
//! ⚠️ **匹配逻辑只有一份（JS）**：规则支持 `js` 类型（用户自写的函数），Rust 无法求值，
//! 所以这里不重实现匹配，而是通过桥向 JS 问一次判定（内部交互类型 `sandbox_rule_check`，
//! **不弹窗、不经 UI**，JS 侧在 `services/tool-service` 里同步判定后原样回传）。
//! 这样 TS / Rust 两条执行路径的语义严格一致（铁律 1）：
//! **命中的命令 = JS `findMatchingSandboxRule` 命中的命令**。
//!
//! 失败一律按「未命中」处理（fail-closed）：桥不可用 / 超时 / 应答解析失败 → 不脱壳。
//!
//! ⚠️ 安全边界（改这里必须连同 TS 侧 `tools/execute/*.ts` 一起看）：
//! - 规则**只**免「沙盒脱壳」审批：命令本身的风险审批（`terminal.*` / `script.execute`）
//!   仍按权限表执行；
//! - 「沙盒脱壳」权限被显式设为 `deny` 时 **`deny` 仍然优先**（规则不能推翻显式禁止）；
//! - 只读沙盒模式（`SandboxMode::Readonly`）下规则不生效（脱壳本就被禁止）；
//! - 沙盒已关闭（`SandboxMode::Off`）时不查询（本来就不进沙盒，没有沙盒可脱）。

use crate::agent::bridge::BridgeInteractionResult;
use crate::agent::native_tools::NativeToolCtx;
use serde_json::json;
use std::time::Duration;

use super::classify::PermissionDecision;

/// 内部查询超时。JS 侧是纯内存匹配（正常 < 10ms），超时按「未命中」处理 ——
/// 不能让 JS 侧异常把整条命令卡住（宁可退回沙盒执行，也不静默放行）。
const RULE_CHECK_TIMEOUT: Duration = Duration::from_secs(5);

/// 经桥询问 JS：「这条命令是否命中忽略沙盒命令规则」。命中返回规则名。
///
/// 无 UI、无审批：JS 侧 `tool-service` 直接读规则表并回传判定
/// （应答体是 JSON 字符串，见 `parse_rule_check`）。
/// 任何异常（无处理器 / 超时 / 应答不是预期 JSON）→ `None`（不脱壳）。
pub(crate) async fn check_sandbox_ignore_rule(
    ctx: &NativeToolCtx<'_>,
    tool_name: &str,
    command: &str,
) -> Option<String> {
    let data = json!({ "command": command, "tool": tool_name });
    let request = ctx.bridge.request_user_interaction(
        ctx.sink,
        ctx.session_id,
        "sandbox_rule_check",
        data,
    );
    let payload = match tokio::time::timeout(RULE_CHECK_TIMEOUT, request).await {
        Ok(Ok(payload)) => payload,
        Ok(Err(e)) => {
            eprintln!("[sandbox_rule_check] 桥请求失败，按未命中处理：{}", e);
            return None;
        }
        Err(_) => {
            eprintln!("[sandbox_rule_check] 查询超时，按未命中处理");
            return None;
        }
    };
    match BridgeInteractionResult::parse(&payload) {
        BridgeInteractionResult::Value { content, .. } => parse_rule_check(&content),
        // shelved / cancelled（无处理器）/ error → 一律未命中
        _ => None,
    }
}

/// 解析 JS 应答：`{"matched":true,"ruleName":"npm 安装"}` → `Some("npm 安装")`。
///
/// 规则名只用于弹窗提示与日志（**不进埋点**，用户自定义文本可能含命令正文，见 §9）。
pub(crate) fn parse_rule_check(content: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(content.trim()).ok()?;
    if !v.get("matched").and_then(|b| b.as_bool()).unwrap_or(false) {
        return None;
    }
    let name = v
        .get("ruleName")
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .trim();
    Some(if name.is_empty() {
        "未命名规则".to_string()
    } else {
        name.to_string()
    })
}

/// 命中规则时，「沙盒脱壳」权限的最终决策：`ask` 视作 `allow`（用户已用规则预先授权）；
/// `deny` **仍然优先**（规则不能推翻显式禁止）。
pub(crate) fn apply_rule_clearance(decision: PermissionDecision) -> PermissionDecision {
    if decision == PermissionDecision::Ask {
        PermissionDecision::Allow
    } else {
        decision
    }
}

/// 命中规则时追加到风险提示后的说明文案。
///
/// ⚠️ 与 TS 侧 `SANDBOX_RULE_BYPASS_HINT`（i18n key，`tools/execute/common.ts`）**逐字对齐** ——
/// 两条路径的弹窗文案必须一致（与 `SANDBOX_BYPASS_HINT` 同样的约定：Rust 侧直接下发中文）。
pub(crate) fn with_rule_hint(base_hint: &str, rule_name: &str) -> String {
    let note = format!(
        "⚠️ 该命令命中「忽略沙盒命令」规则「{}」，将以「不使用沙盒」方式执行：不受写隔离与受限令牌限制，可写入任意路径。",
        rule_name
    );
    if base_hint.is_empty() {
        note
    } else {
        format!("{base_hint}\n{note}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_js_rule_check_response() {
        assert_eq!(
            parse_rule_check(r#"{"matched":true,"ruleName":"npm 安装"}"#),
            Some("npm 安装".to_string())
        );
        // 未命中 / 名字为空 / 非法 JSON / 类型不对 → 一律 None（不放行）
        assert_eq!(parse_rule_check(r#"{"matched":false}"#), None);
        assert_eq!(parse_rule_check(r#"{"matched":true,"ruleName":""}"#), Some("未命名规则".into()));
        assert_eq!(parse_rule_check("not json"), None);
        assert_eq!(parse_rule_check(""), None);
        assert_eq!(parse_rule_check(r#"{"matched":"yes"}"#), None);
        // 字符串形态（JS 侧序列化异常）不能当命中
        assert_eq!(parse_rule_check(r#""matched""#), None);
    }

    #[test]
    fn rule_clearance_downgrades_ask_only() {
        // ask → allow（用户已用规则预先授权脱壳）
        assert_eq!(
            apply_rule_clearance(PermissionDecision::Ask),
            PermissionDecision::Allow
        );
        // deny 优先：规则不能推翻显式禁止
        assert_eq!(
            apply_rule_clearance(PermissionDecision::Deny),
            PermissionDecision::Deny
        );
        assert_eq!(
            apply_rule_clearance(PermissionDecision::Allow),
            PermissionDecision::Allow
        );
    }

    #[test]
    fn rule_hint_appends_to_base() {
        let hint = with_rule_hint("", "装依赖");
        assert!(hint.contains("忽略沙盒命令"));
        assert!(hint.contains("装依赖"));
        assert!(hint.starts_with("⚠️"));

        let with_base = with_rule_hint("基础提示", "装依赖");
        assert!(with_base.starts_with("基础提示\n"));
        assert_eq!(with_base.lines().count(), 2);
    }
}
