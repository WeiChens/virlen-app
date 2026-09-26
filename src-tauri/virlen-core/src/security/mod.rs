//! security — 安全域（纯 Rust，零 `tauri::`）
//!
//! 目前只包含「忽略沙盒命令」规则的判定：[`rules`]（规则模型 + `text` / `regex` / `js` 三种匹配，与
//! TS 侧共读 golden 对齐）、[`js_rule`]（`js` 规则体的内嵌 QuickJS 求值：无 host 函数 / 内存与超时限制）。
//!
//! ⚠️ 与 `crate::sandbox` 的分工：`sandbox` 是执行机制（Job Object / Landlock / 受限令牌），这里是策略
//! 判定（这条命令要不要免脱壳审批），不碰任何平台执行细节。
//!
//! 消费方：`agent/native_tools/execute/common/rules.rs`（Rust 引擎 + CLI 路径）。TS 实现
//!（`src/domain/security/sandbox-ignore-rules.ts`）保留给浏览器 dev / 设置页「测试」，两侧由 golden
//! 契约收敛。

mod js_rule;
mod rules;

pub use rules::{find_matching_rule, parse_rules, SandboxIgnoreRule};

/// 「忽略沙盒命令」规则在 `app_settings` 里的键名。
///
/// ⚠️ 与前端 `SANDBOX_RULES_SETTINGS_KEY`（`src/infrastructure/securityRepo`）逐字一致 —— 键名字面量
/// 只在这里与前端各出现一次，避免「两侧各写一个字符串」而悄悄漂移（见 `docs/config-sink-plan.md` §6 R6）。
pub(crate) const SANDBOX_RULES_SETTINGS_KEY: &str = "sandboxIgnoreRules";

/// 从配置后端读取「忽略沙盒命令」规则（没有前端时的读取入口）。
///
/// 两条路径读的是同一个 `app_settings` 键，判定实现也是同一份（本模块）：GUI 由前端
/// `resolveSecurityConfig` 读同一键后随 `NativeToolSecurity` 下发（复用同一次 IO，执行时零额外开销）；
/// CLI 没有前端，在构造 `NativeToolSecurity` 时调本函数填 `sandbox_ignore_rules`。
///
/// ⚠️ 读取失败按「无规则」处理（fail-closed：不脱壳，只留一条 stderr 说明）。这条入口存在的意义就是让
/// 「CLI 读同一份规则」只有一处键名 / 解析 / 错误处理。
pub async fn load_sandbox_ignore_rules(
    settings: &dyn crate::session_db::SettingsRepo,
) -> Vec<SandboxIgnoreRule> {
    match settings.get_all().await {
        Ok(all) => all
            .get(SANDBOX_RULES_SETTINGS_KEY)
            .map(parse_rules)
            .unwrap_or_default(),
        Err(e) => {
            eprintln!(
                "[security] 读取「忽略沙盒命令」规则失败，按「无规则」处理: {}",
                e
            );
            Vec::new()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_db::SettingsRepo;
    use serde_json::{json, Map, Value};
    use std::sync::Mutex;

    /// 后端形态（内存 / 恒定失败）；失败分支用于验证 fail-closed
    enum Backend {
        Mem(Mutex<Map<String, Value>>),
        Failing,
    }

    /// 内存版 settings：本模块测的是「读同一个键 → 解析 → 判定」，不需要真库
    /// （真库读写已由 `session_db::settings` 的单测覆盖）
    struct MemSettings(Backend);

    impl MemSettings {
        fn with(entries: Map<String, Value>) -> Self {
            Self(Backend::Mem(Mutex::new(entries)))
        }
        fn failing() -> Self {
            Self(Backend::Failing)
        }
    }

    #[async_trait::async_trait]
    impl SettingsRepo for MemSettings {
        async fn get_all(&self) -> Result<Map<String, Value>, String> {
            match &self.0 {
                Backend::Mem(map) => Ok(map.lock().unwrap().clone()),
                Backend::Failing => Err("模拟读取失败".to_string()),
            }
        }
        async fn upsert(&self, entries: Map<String, Value>) -> Result<(), String> {
            if let Backend::Mem(map) = &self.0 {
                let mut guard = map.lock().unwrap();
                for (k, v) in entries {
                    guard.insert(k, v);
                }
            }
            Ok(())
        }
        async fn import_if_empty(&self, _entries: Map<String, Value>) -> Result<bool, String> {
            Ok(false)
        }
    }

    fn rules_entry() -> Map<String, Value> {
        let mut m = Map::new();
        m.insert(
            SANDBOX_RULES_SETTINGS_KEY.to_string(),
            json!([
                { "id": "r1", "name": "装依赖", "enabled": true, "kind": "text",
                  "textMode": "prefix", "pattern": "pnpm install", "caseSensitive": false }
            ]),
        );
        m
    }

    #[tokio::test]
    async fn empty_backend_yields_no_rules() {
        assert!(
            load_sandbox_ignore_rules(&MemSettings::with(Map::new()))
                .await
                .is_empty()
        );
    }

    /// 端到端：写入（与前端 / CLI 同形）→ 从**同一个键**读出 → 直接喂给匹配器
    #[tokio::test]
    async fn reads_rules_from_same_settings_key_and_feeds_matcher() {
        let settings = MemSettings::with(Map::new());
        settings.upsert(rules_entry()).await.unwrap();

        let rules = load_sandbox_ignore_rules(&settings).await;
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].id, "r1");
        assert_eq!(
            find_matching_rule(&rules, "pnpm install --frozen").map(|r| r.id),
            Some("r1".to_string())
        );
        assert!(find_matching_rule(&rules, "git status").is_none());
    }

    /// 键存在但类型不对 / 读取报错 → 一律「无规则」（fail-closed，不脱壳）
    #[tokio::test]
    async fn malformed_or_failing_backend_yields_no_rules() {
        let mut bad = Map::new();
        bad.insert(
            SANDBOX_RULES_SETTINGS_KEY.to_string(),
            Value::String("nope".into()),
        );
        assert!(load_sandbox_ignore_rules(&MemSettings::with(bad))
            .await
            .is_empty());

        assert!(load_sandbox_ignore_rules(&MemSettings::failing())
            .await
            .is_empty());
    }

    /// 键名必须与前端 `SANDBOX_RULES_SETTINGS_KEY` 逐字一致（两侧各只写一次字面量）
    #[test]
    fn settings_key_is_the_agreed_literal() {
        assert_eq!(SANDBOX_RULES_SETTINGS_KEY, "sandboxIgnoreRules");
    }
}
