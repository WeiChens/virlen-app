//! 「忽略沙盒命令」规则 —— 脱壳决策与 **Rust 侧本地判定**（execute 分类共用）
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
//! ## 判定在哪里做（S7 之后的形态）
//!
//! 规则**整体**随 `NativeToolSecurity.sandbox_ignore_rules` 下发（与 `permissions` /
//! `blacklist` 同一套做法），判定由 **Rust 侧**完成：
//! `crate::security::find_matching_rule`（`text` / `regex` 原生实现，`js` 交内嵌 QuickJS，
//! 见 `crate::security::js_rule`）。
//!
//! 原实现是「经内部交互 `sandbox_rule_check` 问 JS」—— 那要求**存在一个 JS 宿主**：
//! 纯 Rust CLI 问不到，只能白等超时后按未命中（规则在 CLI 下完全失效）。
//! 现在 GUI（Rust 引擎）与 CLI 走**同一个实现**，语义由两侧共读的 golden 保证
//! （`src/tests/fixtures/sandbox-rules.golden.json`）。
//!
//! ## 失败语义（fail-closed，一条都不能破）
//!
//! - 规则集为空 / 全部未命中 → 不脱壳（照常走沙盒）；
//! - 规则体编译失败、抛错、超时、超内存 → 按**未命中**（`security::rules` 负责）；
//! - 「沙盒脱壳」权限被显式设为 `deny` → **`deny` 仍然优先**（规则不能推翻显式禁止）；
//! - 只读沙盒模式（`SandboxMode::Readonly`）→ 规则不生效（脱壳本就被禁止）；
//! - 沙盒已关闭（`SandboxMode::Off`）→ 不判定（本来就不进沙盒，没有沙盒可脱）。

use crate::agent::native_tools::NativeToolCtx;

use super::classify::PermissionDecision;

/// 命中当前命令的规则名（供弹窗提示 / 日志）；无命中返回 `None`。
///
/// 纯本地判定，**不做任何 IO**（规则已随 security 快照下发）。
/// `js` 规则会进内嵌引擎，所以整体放 `spawn_blocking`：引擎内部有 200ms 中断超时兜底，
/// 不会挂住 tokio worker（见 `security::js_rule`）。
pub(crate) async fn match_sandbox_ignore_rule(
    ctx: &NativeToolCtx<'_>,
    command: &str,
) -> Option<String> {
    let rules = ctx.security.sandbox_ignore_rules.clone();
    if rules.is_empty() {
        return None;
    }
    let cmd = command.to_string();
    tokio::task::spawn_blocking(move || find_rule_name(&rules, &cmd))
        .await
        .ok()
        .flatten()
}

/// 从规则集里找命中项并归一化规则名（纯函数，便于单测）。
///
/// 规则名为空时回退「未命名规则」（用户可能没填名字就保存了）。
/// 规则名只用于弹窗提示与日志，**不进埋点**（用户自定义文本可能含命令正文，见 AGENTS §9）。
pub(crate) fn find_rule_name(
    rules: &[crate::security::SandboxIgnoreRule],
    command: &str,
) -> Option<String> {
    if rules.is_empty() || command.trim().is_empty() {
        return None;
    }
    let hit = crate::security::find_matching_rule(rules, command)?;
    let name = hit.name.trim();
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
/// ⚠️ 与 TS 侧 `SANDBOX_RULE_BYPASS_HINT`（i18n key，`tools/execute/common.ts`）逐字对齐 ——
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
    use serde_json::json;

    fn rules_from(v: serde_json::Value) -> Vec<crate::security::SandboxIgnoreRule> {
        crate::security::parse_rules(&v)
    }

    /// 命中 → 返回规则名；规则名为空 → 「未命名规则」
    #[test]
    fn finds_rule_name_or_fallback() {
        let named = rules_from(json!([
            { "id": "a", "name": "装依赖", "enabled": true, "kind": "text",
              "textMode": "prefix", "pattern": "pnpm install", "caseSensitive": false }
        ]));
        assert_eq!(find_rule_name(&named, "pnpm install --frozen"), Some("装依赖".into()));

        let unnamed = rules_from(json!([
            { "id": "a", "name": "   ", "enabled": true, "kind": "text",
              "textMode": "prefix", "pattern": "pnpm install", "caseSensitive": false }
        ]));
        assert_eq!(find_rule_name(&unnamed, "pnpm install"), Some("未命名规则".into()));
    }

    /// fail-closed：空规则集 / 空命令 / 未命中 / 抛错的 js 规则 → 一律 None（不脱壳）
    #[test]
    fn fails_closed() {
        assert_eq!(find_rule_name(&[], "pnpm install"), None);

        let rules = rules_from(json!([
            { "id": "a", "name": "装依赖", "enabled": true, "kind": "text",
              "textMode": "prefix", "pattern": "pnpm install", "caseSensitive": false }
        ]));
        assert_eq!(find_rule_name(&rules, "   "), None);
        assert_eq!(find_rule_name(&rules, "git status"), None);

        // js 规则抛错 → 未命中（不得因抛错而放行）
        let throwing = rules_from(json!([
            { "id": "js", "name": "坏 js", "enabled": true, "kind": "js",
              "textMode": "exact", "pattern": "throw new Error('boom')", "caseSensitive": false }
        ]));
        assert_eq!(find_rule_name(&throwing, "whatever"), None);
    }

    /// regex / js 两类规则也能经同一入口命中（判定下沉后三种 kind 等价可用）
    #[test]
    fn all_kinds_are_evaluated_locally() {
        let rules = rules_from(json!([
            { "id": "re", "name": "正则", "enabled": true, "kind": "regex",
              "textMode": "exact", "pattern": "^(npm|pnpm) (i|install|ci|add)\\b",
              "caseSensitive": false },
            { "id": "js", "name": "js", "enabled": true, "kind": "js",
              "textMode": "exact",
              "pattern": "function matchCommand(command) { return command.startsWith('cargo ') }",
              "caseSensitive": false }
        ]));
        assert_eq!(find_rule_name(&rules, "pnpm ci"), Some("正则".into()));
        assert_eq!(find_rule_name(&rules, "cargo test"), Some("js".into()));
        assert_eq!(find_rule_name(&rules, "echo hi"), None);
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
