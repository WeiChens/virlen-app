//! `list_skills` 工具（原生）— 列出本 agent 启用的技能（元信息）
//!
//! ⚠️ 只读操作，不提供写能力。
//! ⚠️ 与 TS 侧 `src/infrastructure/tools/skill/list-skills.ts` **逐字对齐**（铁律 1）：
//! `content` 固定英文（模型侧），`uiData.skills` 为语言无关的结构化数据（UI 侧本地化渲染）。
//!
//! 语义（与 TS 一致）：
//! - `ctx.skills` 为空 → 「本 agent 未启用任何技能」；
//! - 只返回**本 agent 启用**且能在技能目录里扫到的技能；
//! - 技能目录不可用（`skills_dir` 为空 / 不存在）→ 视作「无技能」，不报错
//!   （TS 侧同样如此：注册表为空 → 走同一条空结果分支）。

use super::common::{SkillEntry, scan_skills};
use crate::agent::native_tools::{NativeToolCtx, NativeToolOutcome};
use serde_json::{Map, Value, json};

/// 单个技能交给 UI 的最小结构化信息（语言无关，供组件本地化渲染）
fn skill_brief(entry: &SkillEntry) -> Value {
    let mut brief = Map::new();
    brief.insert("name".into(), json!(entry.name));
    // TS 侧 description 恒为字符串（可能为空串）→ 始终下发
    brief.insert("description".into(), json!(entry.description));
    if let Some(version) = &entry.version {
        brief.insert("version".into(), json!(version));
    }
    if let Some(tags) = &entry.tags {
        brief.insert("tags".into(), json!(tags));
    }
    Value::Object(brief)
}

fn empty_result() -> NativeToolOutcome {
    NativeToolOutcome::Value {
        content: "No skills are currently enabled for this agent.".to_string(),
        ui_data: Some(json!({ "skills": [] })),
    }
}

pub(crate) async fn list_skills_tool(
    ctx: &NativeToolCtx<'_>,
    _args: &Value,
) -> Result<NativeToolOutcome, String> {
    let enabled: &[String] = ctx.skills.unwrap_or(&[]);
    if enabled.is_empty() {
        return Ok(empty_result());
    }

    let Some(skills_dir) = ctx.security.skills_dir.as_deref() else {
        return Ok(empty_result());
    };

    let all = scan_skills(skills_dir);
    // 只返回当前 agent 拥有的技能
    let skills: Vec<&SkillEntry> = all.iter().filter(|s| enabled.contains(&s.name)).collect();
    if skills.is_empty() {
        // 技能已注册但未启用（或目录里根本没有）
        return Ok(empty_result());
    }

    let mut lines: Vec<String> = vec![format!("Enabled skills ({})", skills.len()), String::new()];
    for s in &skills {
        lines.push(format!("  📌 **{}**", s.name));
        if !s.description.is_empty() {
            lines.push(format!("     {}", s.description));
        }
        if let Some(version) = &s.version {
            lines.push(format!("     Version: {}", version));
        }
        if let Some(tags) = &s.tags {
            if !tags.is_empty() {
                lines.push(format!("     Tags: {}", tags.join(", ")));
            }
        }
        lines.push(String::new());
    }
    lines.push("💡 Use `read_skill_source` to inspect a skill's source code.".to_string());

    Ok(NativeToolOutcome::Value {
        content: lines.join("\n"),
        ui_data: Some(json!({
            "skills": skills.iter().map(|s| skill_brief(s)).collect::<Vec<_>>(),
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

    /// 建一个技能目录，写入两个技能，返回目录路径
    fn fixture(tag: &str) -> String {
        let dir = std::env::temp_dir().join(format!("virlen_list_{}_{}", tag, uuid::Uuid::new_v4()));
        let alpha = dir.join("alpha");
        std::fs::create_dir_all(&alpha).unwrap();
        std::fs::write(
            alpha.join("SKILL.md"),
            "---\nname: alpha\ndescription: A 描述\nversion: 1.0.0\ntags: [x, y]\n---\n",
        )
        .unwrap();
        let beta = dir.join("beta");
        std::fs::create_dir_all(&beta).unwrap();
        std::fs::write(beta.join("SKILL.md"), "# 🎯 Beta Tool\n> B 描述\n").unwrap();
        dir.to_string_lossy().replace('\\', "/")
    }

    async fn run(skills_dir: Option<&str>, enabled: Option<&[String]>) -> NativeToolOutcome {
        let mut sec = test_security_bare("/tmp/virlen_ws");
        sec.skills_dir = skills_dir.map(|s| s.to_string());
        let sink = TestEventSink::new();
        let bridge = AgentBridgeState::default();
        let cancel = CancellationToken::new();
        let ctx = NativeToolCtx {
            session_id: "s1",
            tool_call_id: "tc_list_skills",
            cancel: &cancel,
            sink: &sink,
            bridge: &bridge,
            security: &sec,
            repo: noop_repo(),
            skills: enabled,
            host: crate::host::default_host().as_ref(),
        };
        execute_native_tool(&ctx, "list_skills", &json!({}))
            .await
            .expect("list_skills 不应返回 Err")
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
    async fn no_enabled_skills_is_empty_result() {
        let dir = fixture("none");
        // 目录里有技能，但本 agent 没启用任何技能
        let outcome = run(Some(&dir), Some(&[])).await;
        assert_eq!(
            content_of(&outcome),
            "No skills are currently enabled for this agent."
        );
        assert_eq!(ui_of(&outcome)["skills"].as_array().unwrap().len(), 0);
        std::fs::remove_dir_all(Path::new(&dir)).ok();
    }

    #[tokio::test]
    async fn missing_dir_is_empty_result() {
        let enabled = vec!["alpha".to_string()];
        let outcome = run(None, Some(&enabled)).await;
        assert!(content_of(&outcome).starts_with("No skills"));
        let outcome = run(Some("/definitely/missing/virlen"), Some(&enabled)).await;
        assert!(content_of(&outcome).starts_with("No skills"));
    }

    #[tokio::test]
    async fn lists_only_enabled_skills() {
        let dir = fixture("enabled");
        let enabled = vec!["alpha".to_string(), "beta-tool".to_string()];
        let outcome = run(Some(&dir), Some(&enabled)).await;

        let text = content_of(&outcome);
        assert!(text.starts_with("Enabled skills (2)\n\n"));
        assert!(text.contains("  📌 **alpha**\n     A 描述\n     Version: 1.0.0\n     Tags: x, y\n"));
        assert!(text.contains(
            "  📌 **beta-tool**\n     B 描述\n\n💡 Use `read_skill_source` to inspect a skill's source code."
        ));

        let ui = ui_of(&outcome);
        assert_eq!(ui["skills"][0]["name"], "alpha");
        assert_eq!(ui["skills"][0]["version"], "1.0.0");
        assert_eq!(ui["skills"][0]["tags"], json!(["x", "y"]));
        // 无 version / tags 的技能只下发 name + description
        assert_eq!(ui["skills"][1]["name"], "beta-tool");
        assert!(ui["skills"][1].get("version").is_none());
        assert!(ui["skills"][1].get("tags").is_none());

        std::fs::remove_dir_all(Path::new(&dir)).ok();
    }

    #[tokio::test]
    async fn enabled_but_not_on_disk_is_empty_result() {
        let dir = fixture("ghost");
        let enabled = vec!["ghost-skill".to_string()];
        let outcome = run(Some(&dir), Some(&enabled)).await;
        assert_eq!(
            content_of(&outcome),
            "No skills are currently enabled for this agent."
        );
        std::fs::remove_dir_all(Path::new(&dir)).ok();
    }
}
