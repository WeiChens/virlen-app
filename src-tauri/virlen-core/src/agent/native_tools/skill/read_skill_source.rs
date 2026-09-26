//! `read_skill_source` 工具（原生）— 读取技能源码目录结构 + SKILL.md 全文
//!
//! 同时返回技能文件夹的绝对路径，AI 可据此用 `read_file` 读取其他文件。只读操作，不提供写能力。
//!
//! ⚠️ 与 TS 侧 `src/infrastructure/tools/skill/read-skill-source.ts` 逐字对齐（铁律 1）：`content` 固定
//! 英文（模型侧）；`uiData: { skillPath, tree, md }` 为语言无关的结构化数据（UI 侧据此渲染卡片）。
//!
//! 语义（与 TS 一致）：必须给 `name`；`ctx.skills` 非空时才校验「该技能是否已启用」（为空 = 不限制，历
//! 史行为）；技能未注册（扫不到）→ 明确报错；结果分段先过滤空串再 `\n` 拼接 —— 复刻 TS 的
//! `.filter(Boolean)`（它把原意是空行的 `''` 也丢掉了）。

use super::common::{read_file_tree, render_file_tree, scan_skills};
use crate::agent::native_tools::{NativeToolCtx, NativeToolOutcome};
use serde_json::{Value, json};
use std::path::Path;

fn error_result(content: String) -> NativeToolOutcome {
    NativeToolOutcome::Value {
        content,
        ui_data: None,
    }
}

pub(crate) async fn read_skill_source_tool(
    ctx: &NativeToolCtx<'_>,
    args: &Value,
) -> Result<NativeToolOutcome, String> {
    let skill_name = args.get("name").and_then(Value::as_str).unwrap_or("");
    if skill_name.is_empty() {
        return Ok(error_result(
            "Error: please provide a skill name (the \"name\" parameter).".to_string(),
        ));
    }

    // 检查当前 agent 是否有此技能（`ctx.skills` 为空时不限制 —— 与 TS 一致）
    let agent_skills: &[String] = ctx.skills.unwrap_or(&[]);
    if !agent_skills.is_empty() && !agent_skills.iter().any(|s| s == skill_name) {
        return Ok(error_result(format!(
            "Error: the current agent does not have the \"{}\" skill enabled. Use list_skills to see enabled skills.",
            skill_name
        )));
    }

    let not_registered = || {
        error_result(format!(
            "Error: skill \"{}\" is not registered. Import it in Settings first.",
            skill_name
        ))
    };

    let Some(skills_dir) = ctx.security.skills_dir.as_deref() else {
        return Ok(not_registered());
    };

    // 与 TS `getRegisteredSkill(name)` 同口径：按 lowercase + trim 查
    let lookup = skill_name.trim().to_lowercase();
    let all = scan_skills(skills_dir);
    let Some(skill) = all.iter().find(|s| s.name == lookup) else {
        return Ok(not_registered());
    };

    // 1. 目录结构（不含文件内容）
    let tree_entries = match read_file_tree(Path::new(&skill.path)) {
        Ok(entries) => entries,
        Err(e) => {
            return Ok(error_result(format!(
                "Failed to read skill \"{}\": {}",
                skill_name, e
            )));
        }
    };
    // 2. SKILL.md 全文
    let md = match std::fs::read_to_string(Path::new(&skill.path).join("SKILL.md")) {
        Ok(md) => md,
        Err(e) => {
            return Ok(error_result(format!(
                "Failed to read skill \"{}\": {}",
                skill_name, e
            )));
        }
    };

    let mut lines: Vec<String> = vec![format!("📂 {}/", skill.name)];
    render_file_tree(&tree_entries, "  ", &mut lines);
    let tree = lines.join("\n");

    // 逐字复刻 TS：数组里的空串（原意是空行）会被 `.filter(Boolean)` 丢掉
    let parts: Vec<String> = vec![
        format!("**📁 Skill path**: `{}`", skill.path),
        String::new(),
        "---".to_string(),
        String::new(),
        "# 📂 Directory structure".to_string(),
        tree.clone(),
        String::new(),
        "---".to_string(),
        String::new(),
        "# 📄 SKILL.md".to_string(),
        String::new(),
        md.clone(),
    ];
    let content = parts
        .into_iter()
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join("\n");

    Ok(NativeToolOutcome::Value {
        content,
        ui_data: Some(json!({
            "skillPath": skill.path,
            "tree": tree,
            "md": md,
        })),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::bridge::AgentBridgeState;
    use crate::agent::cancellation::CancellationToken;
    use crate::agent::event_sink::TestEventSink;
    use crate::agent::native_tools::execute_native_tool;
    use crate::agent::native_tools::noop_repo;
    use crate::agent::native_tools::test_util::test_security_bare;
    use std::path::Path;

    const MD: &str = "---\nname: demo\ndescription: 演示技能\nversion: 2.1.0\n---\n\n# 正文\n";

    /// 建一个技能目录（demo：SKILL.md + scripts/run.js + 隐藏文件），返回目录路径
    fn fixture(tag: &str) -> String {
        let root = std::env::temp_dir().join(format!("virlen_read_{}_{}", tag, uuid::Uuid::new_v4()));
        let demo = root.join("demo");
        std::fs::create_dir_all(demo.join("scripts")).unwrap();
        std::fs::write(demo.join("SKILL.md"), MD).unwrap();
        std::fs::write(demo.join("scripts/run.js"), "console.log(1)\n").unwrap();
        std::fs::write(demo.join(".hidden"), "x").unwrap();
        root.to_string_lossy().replace('\\', "/")
    }

    async fn run(skills_dir: &str, enabled: Option<&[String]>, args: Value) -> NativeToolOutcome {
        let mut sec = test_security_bare("/tmp/virlen_ws");
        sec.skills_dir = Some(skills_dir.to_string());
        let sink = TestEventSink::new();
        let bridge = AgentBridgeState::default();
        let cancel = CancellationToken::new();
        let ctx = NativeToolCtx {
            session_id: "s1",
            tool_call_id: "tc_read_skill",
            cancel: &cancel,
            sink: &sink,
            bridge: &bridge,
            security: &sec,
            repo: noop_repo(),
            skills: enabled,
            host: crate::host::default_host().as_ref(),
            settings: crate::agent::native_tools::noop_settings(),
        };
        execute_native_tool(&ctx, "read_skill_source", &args)
            .await
            .expect("read_skill_source 不应返回 Err")
    }

    fn content_of(outcome: &NativeToolOutcome) -> String {
        match outcome {
            NativeToolOutcome::Value { content, .. } => content.clone(),
            other => panic!("unexpected outcome: {other:?}"),
        }
    }

    fn ui_of(outcome: &NativeToolOutcome) -> Value {
        match outcome {
            NativeToolOutcome::Value { ui_data, .. } => ui_data.clone().unwrap_or(Value::Null),
            other => panic!("unexpected outcome: {other:?}"),
        }
    }

    #[tokio::test]
    async fn requires_name() {
        let dir = fixture("noname");
        let outcome = run(&dir, None, json!({})).await;
        assert_eq!(
            content_of(&outcome),
            "Error: please provide a skill name (the \"name\" parameter)."
        );
        std::fs::remove_dir_all(Path::new(&dir)).ok();
    }

    #[tokio::test]
    async fn rejects_disabled_skill_when_agent_has_skills() {
        let dir = fixture("disabled");
        let enabled = vec!["other".to_string()];
        let outcome = run(&dir, Some(&enabled), json!({ "name": "demo" })).await;
        assert_eq!(
            content_of(&outcome),
            "Error: the current agent does not have the \"demo\" skill enabled. Use list_skills to see enabled skills."
        );
        std::fs::remove_dir_all(Path::new(&dir)).ok();
    }

    #[tokio::test]
    async fn rejects_unregistered_skill() {
        let dir = fixture("ghost");
        let outcome = run(&dir, None, json!({ "name": "ghost" })).await;
        assert_eq!(
            content_of(&outcome),
            "Error: skill \"ghost\" is not registered. Import it in Settings first."
        );
        std::fs::remove_dir_all(Path::new(&dir)).ok();
    }

    #[tokio::test]
    async fn returns_tree_and_md_with_structured_ui_data() {
        let dir = fixture("ok");
        let outcome = run(&dir, None, json!({ "name": "demo" })).await;

        let text = content_of(&outcome);
        // TS 的 `.filter(Boolean)` 把空行也过滤掉了 → 各段紧邻
        assert!(text.starts_with("**📁 Skill path**: `"));
        assert!(text.contains("`\n---\n# 📂 Directory structure\n📂 demo/\n  ├── SKILL.md\n  └── scripts/\n      └── run.js\n---\n# 📄 SKILL.md\n"));
        assert!(text.ends_with(MD), "SKILL.md 全文必须原样附上");
        assert!(!text.contains(".hidden"), "隐藏文件不出现");
        // 头部（SKILL.md 之前的各段）不应有连续空行 —— 复刻 TS `.filter(Boolean)` 的效果
        // （MD 自身可能含空行，所以只检查头部）
        let head = &text[..text.find("# 📄 SKILL.md").unwrap()];
        assert!(!head.contains("\n\n"), "过滤空串后头部不应有连续空行: {head}");

        let ui = ui_of(&outcome);
        assert!(ui["skillPath"].as_str().unwrap().ends_with("/demo"));
        assert_eq!(ui["tree"], "📂 demo/\n  ├── SKILL.md\n  └── scripts/\n      └── run.js");
        assert_eq!(ui["md"], MD);

        std::fs::remove_dir_all(Path::new(&dir)).ok();
    }

    /// `ctx.skills` 为空串数组时不限制（与 TS `agentSkills.length > 0` 的判断一致）
    #[tokio::test]
    async fn empty_agent_skills_does_not_restrict() {
        let dir = fixture("open");
        let outcome = run(&dir, Some(&[]), json!({ "name": "demo" })).await;
        assert!(content_of(&outcome).starts_with("**📁 Skill path**: `"));
        std::fs::remove_dir_all(Path::new(&dir)).ok();
    }

    /// 名称大小写不敏感（与 TS `getRegisteredSkill` 的 lowercase + trim 查表一致）
    #[tokio::test]
    async fn lookup_is_case_insensitive() {
        let dir = fixture("case");
        let outcome = run(&dir, None, json!({ "name": "  DEMO  " })).await;
        assert!(content_of(&outcome).starts_with("**📁 Skill path**: `"));
        std::fs::remove_dir_all(Path::new(&dir)).ok();
    }
}
