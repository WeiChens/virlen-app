//! `js` 类沙盒规则的**内嵌求值**（D4）
//!
//! 用户可在「设置 → 安全 → 忽略沙盒命令」写一段 JS（参数 `command`，返回真值即命中）。纯 Rust CLI
//! 没有 JS 进程，规则体由**进程内** QuickJS（`quickjs_runtime`，`quickjs-ng` 特性）求值；GUI 默认
//! 引擎（Rust 引擎）同样走这里 —— 因此 GUI 与 CLI 是**同一个实现**。
//!
//! ## 安全边界（规则体是用户代码，在进程内执行）
//!
//! 不注入任何 host 函数（只 `QuickJsRuntimeBuilder::new()`，不注册 fs / 网络 / 定时器 / 模块加载器）、
//! 内存上限 16 MB、栈上限 512 KB（防深递归）、单次求值有超时、每次求值新建 runtime（无跨命令状态
//! 污染）；**异常 / 超时 / OOM 一律 `Err` → 上层按未命中（fail-closed，绝不放行）**。
//!
//! ⚠️ 中断处理器必须总是设置：`quickjs_runtime` 创建 runtime 时无条件把 C 回调注册进 QuickJS，而该
//! 回调会 `unwrap()` 这个字段 —— 不设置的话任何一次 JS 执行都可能 panic（跨 FFI，后果不可控）。我们
//! 用它实现超时，正好也满足了这个前置。
//!
//! ## 与 TS `buildJsFunction` 的写法宽容度对齐
//!
//! 与 `src/domain/security/sandbox-ignore-rules.ts` 的 5 级优先级逐条对应：`async` 开头 → 报错（返回
//! Promise 恒为真值，会放行一切）；`function (command) {...}` 声明 → 包成立即调用；`const match = ...`
//! 赋值式函数 → 末尾补 `return match(command)`；含 `return` → 原样当函数体；其他 → 先当单表达式
//! （补 `return (...)`），编译不过再回退为原样语句体。
//! ⚠️ 第 5 级的回退条件与 TS 有一处实现细节差异：TS 用 `new Function` 只编译不执行，所以只在编译
//! 失败时回退；这里 `eval_sync` 无法只编译，故任何错误都回退一次。结论等价 —— 运行期抛错的写法两种
//! 都抛错，最终都是「未命中」，不会因此放行。

use once_cell::sync::Lazy;
use quickjs_runtime::builder::QuickJsRuntimeBuilder;
use quickjs_runtime::jsutils::Script;
use regex::Regex;
use std::time::{Duration, Instant};

/// 单次求值的内存上限（规则体只做字符串判断，16 MB 已远超所需）
const MEMORY_LIMIT_BYTES: u64 = 16 * 1024 * 1024;
/// 栈上限（防 `function f(){ f() }` 这类深递归）
const MAX_STACK_BYTES: u64 = 512 * 1024;
/// 单次求值时限。命令匹配是**每条命令一次**的交互前哨，宁可判「未命中」也不能拖住执行。
const TIMEOUT: Duration = Duration::from_millis(200);

/// 去掉开头的空白与注释（`//` / `/* *\/`），只看「真正第一行是什么」。
///
/// 与 TS `stripLeadingComments` 同一正则语义：用户很可能在代码前写注释
/// （默认模板本身就带注释），若直接拿 trim 后的首词判断，`function` 声明会被误判成
/// 「语句体」→ 静默不命中。
static LEADING_COMMENTS: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^(?:\s+|//[^\n]*|(?s:/\*.*?\*/))+").expect("valid regex"));

/// 形如 `const match = (command) => ...` / `const match = function (command) {...}` 的赋值式函数。
///
/// 字符类显式写成 ASCII（`[A-Za-z0-9_$]`）而不是 `\w`：Rust 的 `\w` 是 Unicode 语义，
/// 会接受中文标识符，与 JS 的 `\w`（ASCII）不同 —— 这里必须精确对齐 TS。
static ASSIGNED_FN: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"^(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s+)?(?:function\b|\(?[A-Za-z0-9_$,\s()]*\)?\s*=>)",
    )
    .expect("valid regex")
});

/// 是否含 `return` 关键字（TS 用 `/\breturn\b/`）
static HAS_RETURN: Lazy<Regex> = Lazy::new(|| Regex::new(r"\breturn\b").expect("valid regex"));

/// 规则体的包装方式（对应 TS `buildJsFunction` 的分支）
enum Wrapped {
    /// 直接作为函数体
    Body(String),
    /// 先当单表达式（补 `return (...)`），失败再退回原样语句体
    TryExprThenRaw(String),
}

/// 求值：用户规则体 + 命令 → 是否命中。
///
/// `Err` 表示编译 / 运行 / 超时 / 超内存 —— 调用方**必须**按未命中处理。
pub fn match_command(pattern: &str, command: &str) -> Result<bool, String> {
    let wrapped = build_wrapped(pattern)?;
    // 命令以 JSON 字符串字面量注入（合法 JS 字符串字面量），避免手写转义出错
    let arg = js_string_literal(command);
    match wrapped {
        Wrapped::Body(body) => eval_body(&body, &arg),
        Wrapped::TryExprThenRaw(t) => match eval_body(&format!("return ({t});"), &arg) {
            Ok(hit) => Ok(hit),
            Err(_) => eval_body(&t, &arg),
        },
    }
}

/// 按 TS 的 5 级优先策略构建函数体
fn build_wrapped(pattern: &str) -> Result<Wrapped, String> {
    let t = pattern.trim();
    if t.is_empty() {
        return Err("empty js body".into());
    }
    let head = LEADING_COMMENTS.replace(t, "").to_string();

    if starts_with_word(&head, "async") {
        // async 函数返回 Promise（恒为真值）→ 会放行所有命令，必须挡住（与 TS 同文案语义）
        return Err(
            "不支持 async 函数：返回值是 Promise（恒为真值），请改用同步函数体".to_string(),
        );
    }
    if starts_with_word(&head, "function") {
        return Ok(Wrapped::Body(format!("return ({t})(command);")));
    }
    if let Some(caps) = ASSIGNED_FN.captures(&head) {
        let name = caps
            .get(1)
            .map(|m| m.as_str())
            .unwrap_or("matchCommand")
            .to_string();
        return Ok(Wrapped::Body(format!("{t}\nreturn {name}(command);")));
    }
    if HAS_RETURN.is_match(t) {
        return Ok(Wrapped::Body(t.to_string()));
    }
    Ok(Wrapped::TryExprThenRaw(t.to_string()))
}

/// 在一个**受限且一次性**的 runtime 里求值 `body`（函数体，参数名固定为 `command`）。
fn eval_body(body: &str, arg_literal: &str) -> Result<bool, String> {
    let start = Instant::now();
    let rt = QuickJsRuntimeBuilder::new()
        .memory_limit(MEMORY_LIMIT_BYTES)
        .max_stack_size(MAX_STACK_BYTES)
        // 超时 → 返回 true → QuickJS 中断执行（抛 Interrupted）→ 下方 Err → 按未命中
        .set_interrupt_handler(move |_rt| start.elapsed() >= TIMEOUT)
        .build();

    // `!!` 归一化为布尔：TS 侧是 `!!buildJsFunction(pattern)(input)`（真值判断，
    // 不是严格布尔），这里保持一致 —— 返回 0/''/null 都算未命中。
    let source = format!("!!((function(command){{\n{body}\n}})({arg_literal}))");
    match rt.eval_sync(None, Script::new("<sandbox-rule>", &source)) {
        Ok(value) => Ok(value.get_bool()),
        Err(e) => Err(e.to_string()),
    }
}

/// 把任意字符串变成安全的 JS 字符串字面量。
///
/// 直接用 `serde_json` 的编码（JSON 字符串字面量语法是 JS 字符串字面量的子集），
/// 只补一个洞：`U+2028` / `U+2029` 在 ES2019 之前是非法行终止符，而 serde_json 不转义它们。
fn js_string_literal(s: &str) -> String {
    let encoded = serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_string());
    if encoded.contains('\u{2028}') || encoded.contains('\u{2029}') {
        return encoded
            .replace('\u{2028}', "\\u2028")
            .replace('\u{2029}', "\\u2029");
    }
    encoded
}

/// `s` 是否以「独立单词」`word` 开头（`^word\b` 的等价，按 JS 的 ASCII `\b` 语义）
fn starts_with_word(s: &str, word: &str) -> bool {
    match s.strip_prefix(word) {
        Some(rest) => rest.chars().next().map(|c| !is_word_char(c)).unwrap_or(true),
        None => false,
    }
}

/// JS `\w` 的 ASCII 语义（Rust 的 `\w` 是 Unicode 语义，不能直接混用）
fn is_word_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '$'
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_template_never_matches() {
        // 与 `SANDBOX_JS_DEFAULT_PATTERN` 逐字一致（带注释的 function 声明 + return false）
        let default_pattern = [
            "function matchCommand(command) {",
            "  // command = AI 实际要执行的命令（已去掉首尾空白）",
            "  // 返回真值即命中：该命令免除「沙盒脱壳」授权审批",
            "  // 例如：return command.startsWith(\"pnpm test\")",
            "  return false",
            "}",
        ]
        .join("\n");
        assert!(!match_command(&default_pattern, "pnpm test").unwrap());
    }

    #[test]
    fn function_declaration_with_leading_comment() {
        // 注释在前 → 不能被误判成「语句体」
        let pattern = "// 我的规则\nfunction matchCommand(command) {\n  return command.startsWith('cargo ')\n}";
        assert!(match_command(pattern, "cargo test").unwrap());
        assert!(!match_command(pattern, "npm test").unwrap());
    }

    #[test]
    fn assigned_arrow_function() {
        assert!(match_command("const m = (command) => command === 'pnpm test'", "pnpm test").unwrap());
        assert!(!match_command("const m = (command) => command === 'pnpm test'", "pnpm test x").unwrap());
        // 赋值式 function 表达式
        assert!(match_command("const m = function (command) { return command.startsWith('go ') }", "go build").unwrap());
    }

    #[test]
    fn body_with_return_is_used_as_is() {
        let pattern = "if (command === 'a') { return true }\nreturn false";
        assert!(match_command(pattern, "a").unwrap());
        assert!(!match_command(pattern, "b").unwrap());
    }

    #[test]
    fn single_expression_is_wrapped() {
        assert!(match_command("command.startsWith('npm')", "npm i").unwrap());
        assert!(!match_command("command.startsWith('npm')", "pnpm i").unwrap());
        // 不是表达式（语句开头）→ 回退为原样语句体（无 return → undefined → 未命中）
        assert!(!match_command("let x = 1", "npm i").unwrap());
    }

    #[test]
    fn truthy_non_boolean_values_are_coerced() {
        // TS 是 `!!fn(input)`：真值即命中
        assert!(match_command("return 1", "x").unwrap());
        assert!(match_command("return 'yes'", "x").unwrap());
        assert!(match_command("return {}", "x").unwrap());
        assert!(!match_command("return 0", "x").unwrap());
        assert!(!match_command("return ''", "x").unwrap());
        assert!(!match_command("return null", "x").unwrap());
        assert!(!match_command("return undefined", "x").unwrap());
    }

    #[test]
    fn async_body_is_rejected() {
        // Promise 恒为真值 → 必须挡住（否则放行一切命令）
        assert!(match_command("async (command) => true", "x").is_err());
        assert!(match_command("async function f(command) { return true }", "x").is_err());
    }

    #[test]
    fn empty_body_is_rejected() {
        assert!(match_command("", "x").is_err());
        assert!(match_command("   \n  ", "x").is_err());
    }

    #[test]
    fn runtime_throw_is_error_not_match() {
        // TS 注释里的真实例子：运行期错误一律按未命中
        assert!(match_command("command.match(/x/)[0]", "no match here").is_err());
        assert!(match_command("throw new Error('boom')", "x").is_err());
    }

    #[test]
    fn non_ascii_command_is_injected_safely() {
        // 中文 / 引号 / 反斜杠 / 换行都必须原样传入（JSON 字面量注入）
        assert!(match_command("command.includes('中文')", "echo 中文路径").unwrap());
        assert!(match_command("command.includes('a\"b')", "echo 'a\"b'").unwrap());
        // 反斜杠要原样传入：用 String.fromCharCode(92) 表达，避免测试源码自身的转义歧义
        assert!(match_command("command.includes(String.fromCharCode(92))", "echo a\u{005C}b").unwrap());
        assert!(match_command("command.includes('\\n')", "echo a\nb").unwrap());
        assert!(!match_command("command.includes('中文')", "echo english").unwrap());
    }

    /// 超时：`while (true) {}` 必须在**有界时间**内返回 Err（不能拖死 CLI）。
    #[test]
    fn infinite_loop_is_interrupted() {
        let begin = Instant::now();
        let result = match_command("while (true) {}", "x");
        let elapsed = begin.elapsed();
        assert!(result.is_err(), "死循环必须按未命中（Err）返回");
        assert!(
            elapsed < Duration::from_secs(5),
            "中断处理器必须在 {}ms 量级内生效，实际 {:?}",
            TIMEOUT.as_millis(),
            elapsed
        );
    }

    /// 内存上限：无限分配必须被拦住（OOM 或超时都算未命中）
    #[test]
    fn memory_limit_stops_runaway_allocation() {
        let result = match_command(
            "const a = []; while (true) { a.push('x'.repeat(100000)) }",
            "x",
        );
        assert!(result.is_err(), "无限分配必须按未命中（Err）返回");
    }

    /// 无 host 函数：规则体碰不到 fs / 网络 / 定时器 / process
    #[test]
    fn no_host_functions_are_exposed() {
        for expr in [
            "typeof require !== 'undefined'",
            "typeof process !== 'undefined'",
            "typeof fetch !== 'undefined'",
            "typeof setTimeout !== 'undefined'",
            "typeof setInterval !== 'undefined'",
            "typeof console !== 'undefined'",
            "typeof globalThis.process !== 'undefined'",
        ] {
            // 这些记号都不存在 → 表达式为 false；用取反断言「确实不存在」
            assert!(
                !match_command(&format!("return ({expr})"), "x").unwrap(),
                "不应暴露 host 能力: {}",
                expr
            );
        }
        // 但纯 JS 内建（String / RegExp / JSON）必须可用，否则规则根本写不了
        assert!(match_command("return typeof JSON.stringify === 'function'", "x").unwrap());
        assert!(match_command("return /^npm/.test('npm i')", "x").unwrap());
    }

    /// 跨命令状态不残留（每次求值都是新 runtime）
    #[test]
    fn state_does_not_leak_between_evaluations() {
        let pattern = "globalThis.__v = (globalThis.__v || 0) + 1; return globalThis.__v > 1";
        assert!(!match_command(pattern, "x").unwrap(), "首次应为 1");
        assert!(!match_command(pattern, "x").unwrap(), "第二次仍应是新 runtime 的 1");
    }
}
