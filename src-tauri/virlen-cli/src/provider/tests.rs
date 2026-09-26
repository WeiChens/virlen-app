//! `provider` 子命令的单测
//!
//! 交互部分**喂脚本**跑（`Prompter` 的 `tty = false`，见 `wizard.rs` 文件头约束 3）——
//! 因此整条向导（不含网络）都能在 CI 里回归。
//!
//! ⚠️ 有网的两条路径（拉模型列表、连通性验证）在测试里走的是「**不触发**」的分支：
//! 编辑一个 `apiKey` 为空的供应商 → 跳过自动拉取；验证那步脚本答 `n`。

use super::*;
use serde_json::json;
use std::io::Cursor;

fn args(v: &[&'static str]) -> Vec<&'static str> {
    v.to_vec()
}

/// 造一个输入脚本游标。
///
/// ⚠️ 必须**补行尾换行**：`["6", ""]` 直接 `join("\n")` 只得到 `"6\n"` ——
/// 末尾那个空串不占一行，会「少一行输入」而在半路 EOF（真踩过）。
fn cursor<S: AsRef<str>>(lines: &[S]) -> Cursor<Vec<u8>> {
    let mut text = lines
        .iter()
        .map(|s| s.as_ref())
        .collect::<Vec<_>>()
        .join("\n");
    if !lines.is_empty() {
        text.push('\n');
    }
    Cursor::new(text.into_bytes())
}

// ==================== 参数解析 ====================

#[test]
fn parses_subcommands() {
    assert_eq!(parse(args(&["add"])), Ok(ProvCmd::Add));
    assert_eq!(parse(args(&["edit"])), Ok(ProvCmd::Edit { id: None }));
    assert_eq!(
        parse(args(&["edit", "provider-1"])),
        Ok(ProvCmd::Edit {
            id: Some("provider-1".into())
        })
    );
    assert_eq!(
        parse(args(&["rm", "provider-1"])),
        Ok(ProvCmd::Rm {
            id: "provider-1".into(),
            yes: false
        })
    );
    assert_eq!(
        parse(args(&["rm", "provider-1", "--yes"])),
        Ok(ProvCmd::Rm {
            id: "provider-1".into(),
            yes: true
        })
    );
    assert_eq!(parse(args(&["list"])), Ok(ProvCmd::List { json: false }));
    assert_eq!(
        parse(args(&["list", "--json"])),
        Ok(ProvCmd::List { json: true })
    );
    assert_eq!(
        parse(args(&["test", "provider-1"])),
        Ok(ProvCmd::Test {
            id: "provider-1".into()
        })
    );
    assert_eq!(parse(args(&["-h"])), Ok(ProvCmd::Help));
    assert_eq!(parse(args(&["help"])), Ok(ProvCmd::Help));
}

#[test]
fn usage_errors_are_readable() {
    for bad in [
        vec![],
        vec!["nope"],
        vec!["add", "x"],
        vec!["edit", "a", "b"],
        vec!["rm"],
        vec!["rm", "a", "b"],
        vec!["rm", "--nope"],
        vec!["list", "--nope"],
        vec!["test"],
        vec!["test", "a", "b"],
    ] {
        let err = parse(bad.clone()).unwrap_err();
        assert!(!err.is_empty(), "用法错误必须给文案: {:?}", bad);
    }
}

// ==================== 小工具 ====================

#[test]
fn mask_keeps_only_last_four_chars() {
    assert_eq!(mask("sk-1234567890"), "****7890");
    assert_eq!(mask("abcd"), "****");
    assert_eq!(mask(""), "****");
}

#[test]
fn list_json_masks_secrets_recursively() {
    let v = json!({
        "id": "p1",
        "apiKey": "sk-abcdefgh",
        "nested": { "api_key": "zzzzzzzz" },
        "models": ["m1"]
    });
    let masked = mask_secret_fields(&v);
    assert_eq!(masked["apiKey"], "****efgh");
    assert_eq!(masked["nested"]["api_key"], "****zzzz");
    assert_eq!(masked["models"][0], "m1");

    // 空 key 保持空串（掩码不能把「没配」说成「配了」）
    let empty = mask_secret_fields(&json!({ "apiKey": "" }));
    assert_eq!(empty["apiKey"], "");
}

#[test]
fn base_url_must_have_scheme() {
    assert!(validate_base_url("https://api.openai.com/v1").is_ok());
    assert!(validate_base_url("http://127.0.0.1:8080").is_ok());
    assert!(validate_base_url("").is_err());
    assert!(validate_base_url("api.openai.com").is_err());
    assert!(validate_base_url("ftp://x").is_err());
}

#[test]
fn provider_id_is_unique_and_readable() {
    let arr = vec![json!({ "id": "provider-1000" })];
    assert_eq!(unique_provider_id(&arr, 1000), "provider-1000-1");
    assert_eq!(unique_provider_id(&arr, 2000), "provider-2000");
}

// ==================== 向导（喂脚本） ====================

/// 一个「已经存在」的供应商：**apiKey 为空** + 自定义模板（无多协议）
///
/// 为什么故意把 apiKey 留空：`collect_models` 看到空 key 会跳过自动拉取 → 整条用例不碰网络。
fn existing_provider() -> Value {
    json!({
        "id": "provider-1",
        "name": "我的自定义",
        "templateName": "custom",
        "type": "openai",
        "apiKey": "",
        "baseUrl": "https://api.example.com/v1",
        "models": ["m1", "m2"],
        "reasoningEffortList": ["low", "high"],
        "reasoningEffort": "high",
        "enabled": true,
        "createdAt": 1,
        "updatedAt": 1
    })
}

/// 编辑流程共消费 9 行输入（模板 / 名称 / 地址 / Key / 模型 / 档位 / 默认档位 / 验证 / 确认）
fn edit_script() -> Vec<&'static str> {
    vec!["", "", "", "", "", "", "", "n", "y"]
}

#[tokio::test]
async fn edit_wizard_collects_existing_values_as_defaults() {
    let catalog = provider_catalog().expect("内置目录必须可解析");
    let existing = existing_provider();
    let script = edit_script();

    let mut input = cursor(&script);
    let mut out: Vec<u8> = Vec::new();
    let draft = collect(&mut input, &mut out, false, &catalog, "provider-1", Some(&existing))
        .await
        .expect("向导应走完");
    let printed = String::from_utf8_lossy(&out).to_string();

    assert_eq!(draft.id, "provider-1");
    assert_eq!(draft.name, "我的自定义");
    assert_eq!(draft.template_name, "custom");
    assert_eq!(draft.type_, "openai");
    assert_eq!(draft.base_url, "https://api.example.com/v1");
    assert_eq!(draft.api_key, None, "留空 = 保留旧 key（不是清空）");
    assert_eq!(draft.models, vec!["m1", "m2"]);
    assert_eq!(
        draft.reasoning_effort_list,
        vec!["low", "high"],
        "档位必须按并集顺序（multi 返回升序下标）"
    );
    assert_eq!(draft.reasoning_effort, "high");

    // 步号连续、关键提示都在
    assert!(printed.contains("第 1 步：选择模板"), "{}", printed);
    assert!(printed.contains("第 9 步：确认写入"), "{}", printed);
    assert!(printed.contains("跳过自动拉取"), "{}", printed);
    assert!(printed.contains("已跳过验证。"), "{}", printed);
    // ⚠️ 目录里没有 apiKey，回显里也不该出现任何 key
    assert!(!printed.contains("apiKey"), "{}", printed);
}

#[tokio::test]
async fn wizard_aborts_when_final_confirm_is_declined() {
    let catalog = provider_catalog().unwrap();
    let existing = existing_provider();
    let mut script = edit_script();
    *script.last_mut().unwrap() = "n"; // 最后一步答「否」

    let mut input = cursor(&script);
    let mut out: Vec<u8> = Vec::new();
    let err = collect(&mut input, &mut out, false, &catalog, "provider-1", Some(&existing))
        .await
        .expect_err("确认被拒时不应返回草稿");
    assert!(err.contains("已取消"), "{}", err);
}

#[tokio::test]
async fn wizard_rejects_gemini_protocol_early() {
    let catalog = provider_catalog().unwrap();
    // 模板选 gemini（目录里的第 6 个）→ 协议不是 openai/anthropic → 立刻拒绝
    let gemini_index = catalog
        .templates
        .iter()
        .position(|t| t.template_name == "gemini")
        .unwrap();
    let script = vec![(gemini_index + 1).to_string(), "".to_string()];

    let mut input = cursor(&script);
    let mut out: Vec<u8> = Vec::new();
    let err = collect(&mut input, &mut out, false, &catalog, "p-new", None)
        .await
        .expect_err("gemini 必须被提前拒绝");
    assert!(err.contains("gemini"), "{}", err);
    assert!(err.contains("openai"), "提示里应给出替代做法: {}", err);
}

/// 新增：Base URL 写错要**当场重问**，而不是留到第一次请求才炸
///
/// ⚠️ 脚本在「重问」处**直接 EOF**：这样用例不碰网络（一旦继续下去就会去拉模型列表），
/// 同时又能断言「错误提示出现了」与「确实重新提问了」两件事。
#[tokio::test]
async fn wizard_reprompts_on_invalid_base_url() {
    let catalog = provider_catalog().unwrap();
    let custom_index = catalog
        .templates
        .iter()
        .position(|t| t.template_name == "custom")
        .unwrap();
    let script = vec![
        (custom_index + 1).to_string(), // 模板 custom
        "新供应商".to_string(),         // 名称
        "api.example.com".to_string(),  // 地址：缺协议头 → 驳回
    ];

    let mut input = cursor(&script);
    let mut out: Vec<u8> = Vec::new();
    let err = collect(&mut input, &mut out, false, &catalog, "p-new", None)
        .await
        .expect_err("EOF 应结束向导");
    let printed = String::from_utf8_lossy(&out).to_string();

    assert!(
        printed.contains("必须以 http:// 或 https:// 开头"),
        "{}",
        printed
    );
    // 提问出现了**两次** = 驳回后确实重问了（用提问文案里的独有片段计数，避开步标题里的「API 地址」）
    assert_eq!(
        printed.matches("含 /v1 之类的路径").count(),
        2,
        "应重问一次: {}",
        printed
    );
    assert!(err.contains("输入结束"), "{}", err);
}
