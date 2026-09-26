//! `agent` 子命令的单测
//!
//! 交互部分喂脚本跑（`Prompter` 的 `tty = false`）：`AgentEnv` 手工造一个小环境
//! （2 个工具 / 1 个技能 / 1 个供应商），这样脚本短、断言清楚，且**不碰网络、不读库**。

use super::*;
use serde_json::json;
use std::io::Cursor;

fn args(v: &[&'static str]) -> Vec<&'static str> {
    v.to_vec()
}

/// 造一个输入脚本游标。
///
/// ⚠️ 必须补行尾换行：末尾的空串不占一行，否则会「少一行输入」在半路 EOF。
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
    assert_eq!(parse(args(&["add"])), Ok(AgentCmd::Add));
    assert_eq!(parse(args(&["edit"])), Ok(AgentCmd::Edit { id: None }));
    assert_eq!(
        parse(args(&["edit", "a1"])),
        Ok(AgentCmd::Edit {
            id: Some("a1".into())
        })
    );
    assert_eq!(
        parse(args(&["rm", "a1"])),
        Ok(AgentCmd::Rm {
            id: "a1".into(),
            yes: false
        })
    );
    assert_eq!(
        parse(args(&["rm", "a1", "--yes"])),
        Ok(AgentCmd::Rm {
            id: "a1".into(),
            yes: true
        })
    );
    assert_eq!(parse(args(&["list"])), Ok(AgentCmd::List { json: false }));
    assert_eq!(parse(args(&["-h"])), Ok(AgentCmd::Help));
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
    ] {
        assert!(parse(bad.clone()).is_err(), "{:?} 应报用法错误", bad);
    }
}

// ==================== 项目规则文件路径 ====================

/// 与 `src/domain/agent/project-rules.ts` 的用例一一对应 —— 两侧规则必须一致
#[test]
fn project_rules_path_mirrors_ts_rules() {
    for ok in [
        "AGENTS.md",
        ".cursor/rules.md",
        "./AGENTS.md",
        ".\\docs\\MEMORY.md", // 反斜杠归一化
        "a/b/c.md",
    ] {
        assert!(
            validate_project_rules_path(ok).is_ok(),
            "应接受: {}（{:?}）",
            ok,
            validate_project_rules_path(ok)
        );
    }

    // 空 = 不注入，是**合法**值（「清空」正是关闭该特性的唯一方式）
    assert!(validate_project_rules_path("").is_ok());
    assert!(validate_project_rules_path("   ").is_ok());

    for bad in [
        "/etc/passwd",     // 绝对路径
        "~/x",             // 家目录
        "C:\\Windows\\x",  // 盘符
        "c:/x",            // 小写盘符
        "a/../../b",       // 任意 .. 段
        "..",              // 纯 ..
        "./",              // 只有 . 段
        ".",
    ] {
        assert!(
            validate_project_rules_path(bad).is_err(),
            "应拒绝: {}（{:?}）",
            bad,
            validate_project_rules_path(bad)
        );
    }

    // 超长（>200 字符）
    let long = "a".repeat(201);
    assert!(validate_project_rules_path(&long).is_err());
}

// ==================== 数值参数 ====================

#[test]
fn temperature_and_top_p_ranges() {
    assert!(validate_temperature("0").is_ok());
    assert!(validate_temperature("2").is_ok());
    assert!(validate_temperature("0.7").is_ok());
    assert!(validate_temperature("2.1").is_err());
    assert!(validate_temperature("-1").is_err());
    assert!(validate_temperature("abc").is_err());

    assert!(validate_top_p("0").is_ok());
    assert!(validate_top_p("1").is_ok());
    assert!(validate_top_p("1.1").is_err());
    assert!(validate_top_p("").is_err());
}

// ==================== 向导（喂脚本） ====================

fn test_env() -> AgentEnv {
    AgentEnv {
        tools: vec![
            ("read_file".into(), "Read a file".into()),
            ("write_file".into(), "Write a file".into()),
        ],
        skills: vec!["reviewer".into(), "planner".into()],
        providers: vec![ProviderOption {
            id: "p1".into(),
            label: "我的供应商  [p1]".into(),
            models: vec!["m1".into(), "m2".into()],
        }],
        default_workspace: "D:/ws".into(),
    }
}

fn existing_agent() -> Value {
    json!({
        "id": "a1",
        "name": "助手",
        "description": "干活用的",
        "identity": "你是助手",
        "personality": "严谨",
        "defaultWorkspace": "D:/proj",
        "projectRulesFile": "AGENTS.md",
        "defaultModel": { "providerConfigId": "p1", "modelId": "m2" },
        "allowTools": ["read_file"],
        "skills": ["reviewer"],
        "defaultParams": { "temperature": 0.5, "topP": 0.9 },
        "createdAt": 1,
        "updatedAt": 1
    })
}

/// 编辑流程共消费 13 行输入
/// （名称 / 描述 / 身份 / 性格 / 工作目录 / 规则文件 / 供应商 / 模型 / 工具 / 技能 / 温度 / topP / 确认）
fn edit_script() -> Vec<&'static str> {
    vec![
        "", "", "", "", "", "", "", "", "", "", "", "", "y",
    ]
}

#[tokio::test]
async fn edit_wizard_collects_existing_values_as_defaults() {
    let env = test_env();
    let existing = existing_agent();
    let script = edit_script();

    let mut input = cursor(&script);
    let mut out: Vec<u8> = Vec::new();
    let draft = collect(&mut input, &mut out, false, &env, "a1", Some(&existing))
        .await
        .expect("向导应走完");
    let printed = String::from_utf8_lossy(&out).to_string();

    assert_eq!(draft.id, "a1");
    assert_eq!(draft.name, "助手");
    assert_eq!(draft.description, "干活用的");
    assert_eq!(draft.identity, "你是助手");
    assert_eq!(draft.personality, "严谨");
    assert_eq!(draft.default_workspace, "D:/proj");
    assert_eq!(draft.project_rules_file, "AGENTS.md");
    assert_eq!(draft.provider_config_id, "p1");
    assert_eq!(draft.model_id, "m2");
    assert_eq!(draft.allow_tools, vec!["read_file"]);
    assert_eq!(draft.skills, vec!["reviewer"]);
    assert_eq!(draft.temperature, 0.5);
    assert_eq!(draft.top_p, 0.9);

    assert!(printed.contains("第 1 步：名称"), "{}", printed);
    assert!(printed.contains("第 10 步：确认写入"), "{}", printed);
    assert!(printed.contains("默认使用哪个模型？"), "{}", printed);
}

#[tokio::test]
async fn wizard_aborts_when_final_confirm_is_declined() {
    let env = test_env();
    let existing = existing_agent();
    let mut script = edit_script();
    *script.last_mut().unwrap() = "n";

    let mut input = cursor(&script);
    let mut out: Vec<u8> = Vec::new();
    let err = collect(&mut input, &mut out, false, &env, "a1", Some(&existing))
        .await
        .expect_err("确认被拒时不应返回草稿");
    assert!(err.contains("已取消"), "{}", err);
}

/// 新增：没有现有值 → 名称 / 描述必须真的问到，且工具**默认全选**
#[tokio::test]
async fn add_wizard_requires_name_and_selects_all_tools_by_default() {
    let env = test_env();
    // 名称先给空（必填 → 重问）、再给值；描述同理
    let script = vec![
        "", "新助手", // 名称（空 → 重问）
        "", "跑腿的", // 描述（空 → 重问）
        "",     // 身份：空
        "",     // 性格：空
        "",     // 工作目录：取 env 默认（D:/ws）
        "",     // 规则文件：AGENTS.md
        "",     // 供应商：第 1 个
        "",     // 模型：第 1 个
        "",     // 工具：默认全选
        "",     // 技能：默认（无）
        "",     // 温度：0.7
        "",     // topP：1
        "y",    // 确认
    ];

    let mut input = cursor(&script);
    let mut out: Vec<u8> = Vec::new();
    let draft = collect(&mut input, &mut out, false, &env, "a-new", None)
        .await
        .expect("向导应走完");
    let printed = String::from_utf8_lossy(&out).to_string();

    assert_eq!(draft.name, "新助手");
    assert_eq!(draft.description, "跑腿的");
    assert_eq!(draft.default_workspace, "D:/ws");
    assert_eq!(draft.project_rules_file, "AGENTS.md");
    assert_eq!(draft.provider_config_id, "p1");
    assert_eq!(draft.model_id, "m1");
    assert_eq!(
        draft.allow_tools,
        vec!["read_file", "write_file"],
        "新增时默认全选所有工具"
    );
    assert!(draft.skills.is_empty());
    assert_eq!(draft.temperature, 0.7);
    assert_eq!(draft.top_p, 1.0);

    assert!(printed.contains("✗ 不能为空"), "{}", printed);
}

/// 没有启用中的供应商时必须**给出提示并继续**，而不是崩掉或死循环
#[tokio::test]
async fn wizard_survives_without_any_provider() {
    let mut env = test_env();
    env.providers.clear();
    let script = vec![
        "A", "D", "", "", // 名称/描述/身份/性格
        "", "",  // 工作目录 / 规则文件
        "",      // 工具
        "",      // 技能
        "", "",  // 温度 / topP
        "y",
    ];

    let mut input = cursor(&script);
    let mut out: Vec<u8> = Vec::new();
    let draft = collect(&mut input, &mut out, false, &env, "a-x", None)
        .await
        .expect("没有供应商也应能配出一个 Agent");
    let printed = String::from_utf8_lossy(&out).to_string();

    assert!(draft.provider_config_id.is_empty());
    assert!(draft.model_id.is_empty());
    assert!(printed.contains("没有启用中的供应商"), "{}", printed);
}

/// 没有技能目录时不该占一个空步（步号自然跳过），且已有 skills 不该被抹掉
#[tokio::test]
async fn skills_step_is_skipped_when_none_available() {
    let mut env = test_env();
    env.skills.clear();
    // 技能那步被跳过 → 只需 11 个空行 + 最后的 y（共 12 行）
    let script = vec![
        "", "", "", "", "", "", "", "", "", "", "", "y",
    ];

    let mut input = cursor(&script);
    let mut out: Vec<u8> = Vec::new();
    let draft = collect(&mut input, &mut out, false, &env, "a1", Some(&existing_agent()))
        .await
        .expect("向导应走完");
    let printed = String::from_utf8_lossy(&out).to_string();

    assert_eq!(draft.skills, vec!["reviewer"], "已有技能应原样保留");
    assert!(printed.contains("跳过"), "{}", printed);
    assert!(printed.contains("第 9 步：确认写入"), "{}", printed);
}
