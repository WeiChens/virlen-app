//! 「忽略沙盒命令」规则 —— 纯 Rust 匹配器（text / regex / js）
//!
//! ## 为什么 Rust 要自己实现一份
//!
//! 规则支持三种 `kind`：`text`（完全/前缀/后缀）、`regex`、`js`（用户自写函数）。
//! 原实现里「匹配只有 JS 一份」，Rust 侧经内部交互 `sandbox_rule_check` 问 JS ——
//! 但那要求**存在一个 JS 宿主**：纯 Rust CLI 没有 JS 进程，问不到，只能白等超时后
//! 按未命中处理（规则在 CLI 下完全失效）。
//!
//! 现在把匹配下沉到 Rust（**默认引擎 + CLI 的权威实现**），与 TS 侧逐条对齐：
//! - 对齐由两侧**共读**的 golden 用例保证：`src/tests/fixtures/sandbox-rules.golden.json`
//!   （TS: `src/tests/domain/sandbox-rules-golden.test.ts`；Rust: 本文件 `tests` 模块）；
//! - TS 侧实现（`src/domain/security/sandbox-ignore-rules.ts`）**仍然保留**：
//!   浏览器 dev / 用户关闭 Rust 引擎时没有 Rust 可用，设置页的「测试」按钮与
//!   保存期 `compileSandboxRule` 也依赖它。
//!
//! ## 已知差异（记录在案；方向都是「不放行」或仅影响非 ASCII）
//! - `regex`：Rust `regex` **不支持 lookaround / backreference**。这类规则在 Rust 侧
//!   编译失败 → 按**未命中**处理（JS 侧能编译且可能命中）—— 即「CLI 比 GUI 更保守」，
//!   绝不会静默放行；
//! - `\d` / `\w` / `\s`：Rust 默认 Unicode 语义，比 JS（ASCII 语义）更宽。命令本身
//!   基本都是 ASCII，影响面仅限「非 ASCII 输入 + 简写字符类」的组合；
//! - 两侧**都不**做「跨规则状态共享」：每条命令独立求值。
//!
//! 匹配顺序：按列表顺序取**第一条命中且已启用**的规则（列表顺序即优先级）。

use once_cell::sync::Lazy;
use regex::Regex;
use serde::Deserialize;
use serde_json::Value;

/// 规则的匹配类型
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
#[derive(Default)]
pub enum SandboxRuleKind {
    #[default]
    Text,
    Regex,
    Js,
    /// 未知类型（前端将来新增）—— TS 侧 `kind` 的 else 分支按 `text` 处理，这里保持一致
    #[serde(other)]
    Unknown,
}


/// 文本规则的比较方式
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
#[derive(Default)]
pub enum SandboxTextMode {
    #[default]
    Exact,
    Prefix,
    Suffix,
    /// 未知值 → 按 `exact` 处理（对齐 TS `rule.textMode ?? 'exact'` 的 else 分支）
    #[serde(other)]
    Unknown,
}


/// 一条「忽略沙盒命令」规则
///
/// 字段名 / 默认值**逐条对齐** TS `SandboxIgnoreRule`（`camelCase`）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxIgnoreRule {
    // 规则 id 由前端生成，Rust 侧只做匹配（按顺序取第一条命中的），不需要它 ——
    // 但它是**随配置下发的线格式**的一部分（前端 identity / 后续去重与缓存键），
    // 删掉字段会让反序列化丢失信息，故保留并显式允许「未被读取」。
    #[allow(dead_code)]
    #[serde(default)]
    pub id: String,
    /// 规则名称（用户可读；只用于提示与日志，**不进埋点**，见 AGENTS §9）
    #[serde(default)]
    pub name: String,
    /// 是否启用。
    ///
    /// ⚠️ 默认 **false**（缺字段 = 不启用）：TS 侧 `if (!rule.enabled) continue`
    /// 把缺失字段当「未启用」跳过；这里必须一致，否则会出现「TS 跳过、Rust 却命中」的分叉。
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub kind: SandboxRuleKind,
    #[serde(default)]
    pub text_mode: SandboxTextMode,
    /// 匹配内容：text=字面量，regex=正则源码，js=函数体
    #[serde(default)]
    pub pattern: String,
    /// 是否区分大小写（text / regex 有效；js 由用户自行处理）
    #[serde(default)]
    pub case_sensitive: bool,
}

/// 从 `app_settings` 的 `sandboxIgnoreRules` 键解析规则列表。
///
/// **逐条**解析：单条坏数据只跳过那一条，不让整份规则失效
/// （与 `session_db::settings::read_all` 的「坏行退化」同一思路）。
pub fn parse_rules(value: &Value) -> Vec<SandboxIgnoreRule> {
    match value.as_array() {
        Some(arr) => arr
            .iter()
            .filter_map(|v| serde_json::from_value::<SandboxIgnoreRule>(v.clone()).ok())
            .collect(),
        None => Vec::new(),
    }
}

/// 单条规则匹配一条命令。
///
/// - `Ok(true)` = 命中；`Ok(false)` = 未命中；
/// - `Err(msg)` = 编译 / 运行错误 —— **语义上等同未命中**（fail-closed），
///   只是把原因交给调用方记日志（UI 上不该暴露给用户，见规则模块头）。
///
/// 刻意**不看** `enabled`（与 TS `testSandboxRule` 一致）：设置页「测试」按钮要对
/// 禁用中的草稿也能试；实际放行请用 [`find_matching_rule`]。
pub fn test_rule(rule: &SandboxIgnoreRule, command: &str) -> Result<bool, String> {
    // 与 TS 一致：两侧都先 trim，任一为空即未命中
    let input = command.trim();
    let pattern = rule.pattern.trim();
    if input.is_empty() || pattern.is_empty() {
        return Ok(false);
    }
    match rule.kind {
        SandboxRuleKind::Regex => regex_matches(pattern, rule.case_sensitive, input),
        SandboxRuleKind::Js => super::js_rule::match_command(pattern, input),
        // text，以及未知类型（TS 的 else 分支）
        SandboxRuleKind::Text | SandboxRuleKind::Unknown => Ok(text_matches(
            rule.text_mode,
            rule.case_sensitive,
            input,
            pattern,
        )),
    }
}

/// 找出第一条命中该命令的**已启用**规则；无命中返回 `None`。
///
/// 规则体抛错（`Err`）按**未命中**继续往后找 —— 与 TS `findMatchingSandboxRule` 一致
/// （`testSandboxRule(...).matched` 为 false）。
pub fn find_matching_rule(
    rules: &[SandboxIgnoreRule],
    command: &str,
) -> Option<SandboxIgnoreRule> {
    for rule in rules {
        if !rule.enabled {
            continue;
        }
        match test_rule(rule, command) {
            Ok(true) => return Some(rule.clone()),
            Ok(false) => {}
            Err(e) => {
                // 不静默：规则名与错误进 stderr（命令正文不打印，遵守 AGENTS §9）
                eprintln!(
                    "[sandbox_rule] 规则「{}」({:?}) 求值失败，按未命中处理: {}",
                    rule.name, rule.kind, e
                );
            }
        }
    }
    None
}

/// text 规则：完全 / 前缀 / 后缀（默认忽略大小写）
fn text_matches(mode: SandboxTextMode, case_sensitive: bool, input: &str, pattern: &str) -> bool {
    let (a, b) = if case_sensitive {
        (input.to_string(), pattern.to_string())
    } else {
        (input.to_lowercase(), pattern.to_lowercase())
    };
    match mode {
        SandboxTextMode::Prefix => a.starts_with(&b),
        SandboxTextMode::Suffix => a.ends_with(&b),
        // Exact 与未知值（TS 的 else 分支）
        SandboxTextMode::Exact | SandboxTextMode::Unknown => a == b,
    }
}

/// regex 规则：`new RegExp(pattern, caseSensitive ? '' : 'i')` 的 Rust 等价
///
/// ⚠️ lookaround / backreference 不被支持 → 返回 `Err` → 上层按未命中（见模块头）。
fn regex_matches(pattern: &str, case_sensitive: bool, input: &str) -> Result<bool, String> {
    static CACHE: Lazy<std::sync::Mutex<std::collections::HashMap<String, Regex>>> =
        Lazy::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

    // 缓存键 = 大小写标志 + 源码（与 TS `buildRegExp` 的键同一构造）
    let key = format!("{}|{}", if case_sensitive { 's' } else { 'i' }, pattern);
    if let Ok(cache) = CACHE.lock() {
        if let Some(re) = cache.get(&key) {
            return Ok(re.is_match(input));
        }
    }

    let re = regex::RegexBuilder::new(pattern)
        .case_insensitive(!case_sensitive)
        .build()
        .map_err(|e| e.to_string())?;

    if let Ok(mut cache) = CACHE.lock() {
        // 规则集很小（个位数～几十），超限整体清空即可（与 TS CACHE_LIMIT 同样的取舍）
        if cache.len() > 200 {
            cache.clear();
        }
        cache.insert(key, re.clone());
    }
    Ok(re.is_match(input))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rule(v: Value) -> SandboxIgnoreRule {
        serde_json::from_value(v).expect("rule should deserialize")
    }

    fn text(pattern: &str, mode: &str, case_sensitive: bool) -> SandboxIgnoreRule {
        rule(json!({
            "id": "t1", "name": "t", "enabled": true, "kind": "text",
            "textMode": mode, "pattern": pattern, "caseSensitive": case_sensitive
        }))
    }

    #[test]
    fn text_modes_and_case() {
        // 完全匹配（默认忽略大小写）
        assert!(test_rule(&text("npm install", "exact", false), "NPM INSTALL").unwrap());
        assert!(!test_rule(&text("npm install", "exact", false), "npm install --save").unwrap());
        // 前缀 / 后缀
        assert!(test_rule(&text("pnpm", "prefix", false), "pnpm test").unwrap());
        assert!(!test_rule(&text("pnpm", "suffix", false), "pnpm test").unwrap());
        assert!(test_rule(&text("test", "suffix", false), "pnpm test").unwrap());
        // 区分大小写
        assert!(!test_rule(&text("npm", "prefix", true), "NPM test").unwrap());
        // 未知 textMode → exact（对齐 TS else 分支）
        assert!(test_rule(&text("npm", "weird", false), "npm").unwrap());
    }

    #[test]
    fn empty_input_or_pattern_never_matches() {
        assert!(!test_rule(&text("npm", "prefix", false), "   ").unwrap());
        assert!(!test_rule(&text("", "exact", false), "npm").unwrap());
    }

    #[test]
    fn regex_presets_from_ts_side() {
        // 与 `SANDBOX_RULE_PRESETS` 逐条一致
        let install = rule(json!({
            "id": "r1", "name": "安装依赖", "enabled": true, "kind": "regex",
            "textMode": "exact", "pattern": "^(npm|pnpm|yarn|bun) (i|install|ci|add)\\b",
            "caseSensitive": false
        }));
        assert!(test_rule(&install, "pnpm install").unwrap());
        assert!(test_rule(&install, "npm ci").unwrap());
        assert!(test_rule(&install, "BUN I").unwrap());
        assert!(!test_rule(&install, "echo npm install").unwrap());

        let node_gyp = rule(json!({
            "id": "r2", "name": "原生模块编译", "enabled": true, "kind": "regex",
            "textMode": "exact", "pattern": "\\bnode-gyp\\b", "caseSensitive": false
        }));
        assert!(test_rule(&node_gyp, "node-gyp rebuild").unwrap());
        assert!(test_rule(&node_gyp, "npx node-gyp build").unwrap());
        assert!(!test_rule(&node_gyp, "echo node-gypx").unwrap());

        let pytest = rule(json!({
            "id": "r3", "name": "Python 测试", "enabled": true, "kind": "regex",
            "textMode": "exact", "pattern": "^(python -m )?pytest\\b", "caseSensitive": false
        }));
        assert!(test_rule(&pytest, "pytest -q").unwrap());
        assert!(test_rule(&pytest, "python -m pytest").unwrap());
        assert!(!test_rule(&pytest, "python setup.py pytest").unwrap());
    }

    #[test]
    fn invalid_regex_is_error_not_panic() {
        let bad = rule(json!({
            "id": "bad", "name": "坏正则", "enabled": true, "kind": "regex",
            "textMode": "exact", "pattern": "([unclosed", "caseSensitive": false
        }));
        assert!(test_rule(&bad, "anything").is_err());
        // 坏规则不影响后续规则：跳过它继续找
        let ok = rule(json!({
            "id": "ok", "name": "ok", "enabled": true, "kind": "text",
            "textMode": "prefix", "pattern": "npm", "caseSensitive": false
        }));
        let hit = find_matching_rule(&[bad, ok], "npm install").expect("第二条应命中");
        assert_eq!(hit.id, "ok");
    }

    #[test]
    fn js_kind_delegates_to_embedded_engine() {
        let js = rule(json!({
            "id": "js1", "name": "js", "enabled": true, "kind": "js",
            "textMode": "exact",
            "pattern": "function matchCommand(command) { return command.startsWith('cargo ') }",
            "caseSensitive": false
        }));
        assert!(test_rule(&js, "cargo test").unwrap());
        assert!(!test_rule(&js, "npm test").unwrap());
    }

    #[test]
    fn list_order_is_priority_and_disabled_is_skipped() {
        let first = rule(json!({
            "id": "a", "name": "a", "enabled": false, "kind": "text",
            "textMode": "prefix", "pattern": "npm", "caseSensitive": false
        }));
        let second = rule(json!({
            "id": "b", "name": "b", "enabled": true, "kind": "text",
            "textMode": "prefix", "pattern": "npm", "caseSensitive": false
        }));
        // 第一条禁用 → 取第二条
        assert_eq!(find_matching_rule(&[first, second], "npm i").unwrap().id, "b");

        let third = rule(json!({
            "id": "a2", "name": "a2", "enabled": true, "kind": "text",
            "textMode": "prefix", "pattern": "npm", "caseSensitive": false
        }));
        let fourth = rule(json!({
            "id": "b2", "name": "b2", "enabled": true, "kind": "text",
            "textMode": "prefix", "pattern": "npm", "caseSensitive": false
        }));
        // 都启用 → 取列表顺序靠前的
        assert_eq!(find_matching_rule(&[third, fourth], "npm i").unwrap().id, "a2");
    }

    /// ⚠️ 缺 `enabled` 字段 → TS 侧 `!rule.enabled` 视为未启用而跳过；
    /// Rust 必须同样跳过，否则产生「GUI 跳过、CLI 命中」的分叉。
    #[test]
    fn missing_enabled_field_defaults_to_disabled() {
        let no_enabled = rule(json!({
            "id": "n", "name": "n", "kind": "text",
            "textMode": "prefix", "pattern": "npm", "caseSensitive": false
        }));
        assert!(!no_enabled.enabled, "缺 enabled 必须按未启用");
        assert!(find_matching_rule(&[no_enabled], "npm i").is_none());
    }

    #[test]
    fn parse_rules_skips_bad_entries_only() {
        let value = json!([
            { "id": "ok", "name": "ok", "enabled": true, "kind": "text",
              "textMode": "prefix", "pattern": "npm", "caseSensitive": false },
            "not an object",
            42
        ]);
        let rules = parse_rules(&value);
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].id, "ok");
        // 非数组 / null → 空列表（不 panic）
        assert!(parse_rules(&json!(null)).is_empty());
        assert!(parse_rules(&json!({ "a": 1 })).is_empty());
    }

    // ==================== golden（与 TS 共读同一份 fixture） ====================

    /// 契约文件路径：与 TS 侧 `src/tests/domain/sandbox-rules-golden.test.ts` 同一份
    /// （先例：`agent/prompts/assemble.rs::golden_path` 的 `system-prompt.golden.txt`）
    fn golden_path() -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("src")
            .join("tests")
            .join("fixtures")
            .join("sandbox-rules.golden.json")
    }

    /// 两侧共读的 golden：同一批「规则 × 命令」必须给出**同一个**判定结果。
    ///
    /// 一旦两侧实现漂移（新增分支、默认值改动、大小写处理不一致），此用例立即失败。
    #[test]
    fn golden_matches_ts_implementation() {
        let raw = std::fs::read_to_string(golden_path()).expect("golden fixture 必须存在");
        let doc: Value = serde_json::from_str(&raw).expect("golden fixture 必须是合法 JSON");

        let rules = parse_rules(&doc["rules"]);
        assert!(!rules.is_empty(), "golden 必须带规则");

        let cases = doc["cases"].as_array().expect("golden 必须带 cases");
        assert!(!cases.is_empty(), "golden 必须带用例");

        let mut checked = 0;
        for case in cases {
            let command = case["command"].as_str().unwrap_or_default();
            let expect = case["expectRuleId"].as_str(); // null → 未命中
            let hit = find_matching_rule(&rules, command);
            assert_eq!(
                hit.as_ref().map(|r| r.id.as_str()),
                expect,
                "命令 {:?} 的判定与 TS 不一致（两侧必须收敛）",
                command
            );
            checked += 1;
        }
        assert!(checked >= 15, "golden 用例太少（{}），覆盖不足", checked);
    }
}
