//! 系统提示词组装（Rust 侧）—— 与 TS `domain/agent/compose-prompt.ts` 对齐
//!
//! 纯字符串拼接，**不做任何 I/O**：取数（环境信息、项目规则文件、技能列表）由调用方
//! 准备好后作为参数传入 —— 这样 CLI / GUI / 测试可以各取所需，组装结果却必须一致。
//!
//! 与 TS 侧的对应关系（改任何一处都要两边一起改，golden 测试会兜底）：
//! | Rust | TS |
//! |---|---|
//! | `base_system_prompt()` | `baseSystemPrompt()` |
//! | `compose_system_prompt()` | `composeSystemPrompt()` |
//! | `build_project_rules_prompt()` | `domain/agent/project-rules.ts::buildProjectRulesPrompt` |
//!
//! ## 调用方（改本模块前先确认不破坏谁）
//!
//! - **CLI（生产）**：`virlen-cli` 的 `session_rt/resources.rs::build_system_prompt` ——
//!   headless 下没有前端，系统提示词只能在这里拼；
//! - **GUI**：组装仍在 TS（`services/agent-service.ts::assembleAgentPrompt`，结果快照进
//!   `session.systemPrompt`）；对 GUI 而言本模块只承担「golden 比对的另一半」。
//!
//! ## ⚠️ CLI 与 GUI 的**已知差异**（golden 守不住这一层，别误以为「已完全对齐」）
//!
//! 顺序与分隔符由 golden 逐字节锁定、两侧一致；但**喂进来的 `PromptParts` 两侧不同** ——
//! golden 用的是**固定输入**，它守的是「组装规则」，守不住「输入内容」：
//!
//! | 片段 | GUI（`agent-service.ts`） | CLI（`session_rt/resources.rs`） |
//! |---|---|---|
//! | 环境信息 | `get_env_info`：`- OS: Windows 10.0.19045` + 每个工具版本（`- node:24.10.0`） | `std::env::consts::OS`：`- OS: windows (x86_64)`，**不含工具版本**（headless 不探测） |
//! | 项目规则 | `buildProjectRulesPrompt` 包装：带 `# Project Rules (AGENTS.md)` 标题与「优先级高于通用说明」声明 | ⚠️ 目前**直接塞文件原文**（未经 `build_project_rules_prompt`），与 `PromptParts::project_rules` 的契约不符 —— **待确认是否应一并包装** |
//! | 角色 / 身份 / 性格 / 技能 | 由 Agent 配置 + 技能注册表注入 | **不注入**（headless 没有这些输入，是「没有数据」而非「另一份实现」） |
//!
//! 结论：环境信息**无法**逐字节同源（CLI 拿不到 OS 版本号、也不探测工具版本），只能保证
//! 「格式与位置一致」；角色/技能同理（无输入）。改这里请同步本表与 `docs/rust-engine.md` §12.2。

use super::{CORE_PRINCIPLES, TOOL_CALL_SPEC};

/// 技能元信息（只取注入提示词需要的两项）
#[derive(Debug, Clone, Copy)]
pub struct SkillMeta<'a> {
    pub name: &'a str,
    pub description: &'a str,
}

/// 组装输入（全部由调用方提供，本模块不读取任何状态）
#[derive(Debug, Default, Clone)]
pub struct PromptParts<'a> {
    /// 环境信息片段；`None` 表示不注入（对应 `settings.allowEnvPrompt` 关闭）
    pub env_prompt: Option<&'a str>,
    /// 项目规则片段（`build_project_rules_prompt` 的产物）；`None`/空串表示不注入
    pub project_rules: Option<&'a str>,
    pub agent_name: &'a str,
    pub agent_description: &'a str,
    pub identity: Option<&'a str>,
    pub personality: Option<&'a str>,
    /// 已按 Agent 白名单过滤后的技能；空切片表示不注入
    pub skills: &'a [SkillMeta<'a>],
}

/// 基础提示词：工具调用规范 + 核心原则（两侧共用同一份 md）
pub fn base_system_prompt() -> String {
    format!("{}\n\n{}", TOOL_CALL_SPEC, CORE_PRINCIPLES)
}

/// 按固定顺序拼接系统提示词。
///
/// 顺序即优先级：基础规范 → 环境 → 项目规则 → 角色/身份/性格 → 技能。
/// 片段之间用空行分隔；技能段内部用单换行（末尾保留一个换行）。
pub fn compose_system_prompt(parts: &PromptParts) -> String {
    let mut out: Vec<String> = vec![base_system_prompt()];

    // `None` 才代表「不注入」；空串是「注入了但内容为空」（与 TS 侧 `!== undefined` 同语义）
    if let Some(env) = parts.env_prompt {
        out.push(env.to_string());
    }
    if let Some(rules) = parts.project_rules {
        if !rules.is_empty() {
            out.push(rules.to_string());
        }
    }

    if !parts.agent_name.is_empty() || !parts.agent_description.is_empty() {
        let desc = if parts.agent_description.is_empty() {
            String::new()
        } else {
            format!(", {}", parts.agent_description)
        };
        out.push(format!("# Role\nYou are {}{}", parts.agent_name, desc));
    }
    if let Some(identity) = parts.identity {
        if !identity.is_empty() {
            out.push(format!("# Identity\n{}", identity));
        }
    }
    if let Some(personality) = parts.personality {
        if !personality.is_empty() {
            out.push(format!("# Personality\n{}", personality));
        }
    }

    if !parts.skills.is_empty() {
        let mut lines: Vec<String> = vec!["# Enabled Skills".to_string(), String::new()];
        for skill in parts.skills {
            lines.push(format!("## {}", skill.name));
            lines.push(skill.description.to_string());
            lines.push(String::new());
        }
        lines.push("You can use the following tools to inspect and manage skills:".to_string());
        lines.push(
            "- `read_skill_source`: show the source-code directory structure of a skill and the full text of its SKILL.md"
                .to_string(),
        );
        lines.push(String::new());
        out.push(lines.join("\n"));
    }

    out.join("\n\n")
}

/// 把项目规则文件内容格式化为提示词片段（与 TS `buildProjectRulesPrompt` 对齐）
///
/// 明确写清「来源」与「优先级」：模型对项目约定与通用说明冲突时的取舍全靠这段文字。
pub fn build_project_rules_prompt(file_name: &str, content: &str) -> String {
    [
        format!("# Project Rules ({})", file_name),
        String::new(),
        format!(
            "The content below comes from `{}` in the current working directory; it is this project's conventions and historical memory.",
            file_name
        ),
        "Treat it as a **project-level requirement**; when it conflicts with the general instructions, this file takes precedence (except for an explicit requirement from the user in the current turn).".to_string(),
        String::new(),
        content.trim().to_string(),
    ]
    .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    // ── 固定输入 ──
    // ⚠️ 必须与 TS 侧 `src/tests/domain/compose-prompt-golden.test.ts` 的常量**逐字一致**，
    //    否则 golden 比对失去意义（两侧输入不同 = 比对的是别的东西）。
    const FIXTURE_FILE_NAME: &str = "AGENTS.md";
    const FIXTURE_RULES_CONTENT: &str =
        "# AGENTS.md — 示例项目\n\n- 规则 A：缩进用 2 空格\n- 规则 B：提交信息用英文\n";
    const FIXTURE_ENV: &str = "# Current Environment\n- OS: Windows 10.0.19045\n- Current working directory: E:/code/virlen/virlen-app\n- node:24.10.0\n- pnpm:11.2.2";
    const FIXTURE_AGENT_NAME: &str = "Virlen";
    const FIXTURE_AGENT_DESC: &str = "全能型 AI 助手，可以使用所有内置工具";
    const FIXTURE_IDENTITY: &str = "你是一名拥有 10 年经验的资深软件架构师";
    const FIXTURE_PERSONALITY: &str = "严谨、逻辑清晰，注重事实和数据";

    fn golden_path() -> PathBuf {
        // 契约文件放在前端测试树（`src/tests/fixtures/`）：TS 侧用 Vite `?raw` 读取，
        // Rust 侧用相对路径读取 —— 两侧共读**同一份文件**，不允许各存一份。
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("src")
            .join("tests")
            .join("fixtures")
            .join("system-prompt.golden.txt")
    }

    /// 归一化行尾：md 在工作区是 CRLF，在 CI（Linux checkout）是 LF，
    /// 两侧比对的应该是「文本内容」而不是行尾字节，因此统一成 LF 再比。
    fn normalize(s: &str) -> String {
        s.replace("\r\n", "\n")
    }

    /// 用固定输入组装一份提示词（golden 的「被比对对象」）
    fn fixture_prompt() -> String {
        let rules = build_project_rules_prompt(FIXTURE_FILE_NAME, FIXTURE_RULES_CONTENT);
        let skills = vec![
            SkillMeta {
                name: "code-reviewer",
                description: "代码审查技能：按清单逐项检查改动",
            },
            SkillMeta {
                name: "xlsx",
                description: "Excel 电子表格生成",
            },
        ];
        compose_system_prompt(&PromptParts {
            env_prompt: Some(FIXTURE_ENV),
            project_rules: Some(&rules),
            agent_name: FIXTURE_AGENT_NAME,
            agent_description: FIXTURE_AGENT_DESC,
            identity: Some(FIXTURE_IDENTITY),
            personality: Some(FIXTURE_PERSONALITY),
            skills: &skills,
        })
    }

    /// golden 比对：TS 与 Rust 的组装结果必须逐字节一致。
    ///
    /// 生成/更新 fixture：`UPDATE_GOLDEN=1 cargo test --lib golden_system_prompt`
    /// （契约文件路径见 `golden_path()`：`src/tests/fixtures/system-prompt.golden.txt`）
    #[test]
    fn golden_system_prompt_matches_fixture() {
        let actual = normalize(&fixture_prompt());
        let path = golden_path();

        if std::env::var("UPDATE_GOLDEN").as_deref() == Ok("1") {
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir).expect("创建 golden 目录失败");
            }
            std::fs::write(&path, &actual).expect("写入 golden 失败");
            eprintln!("[golden] 已更新 {}", path.display());
            return;
        }

        let expected = std::fs::read_to_string(&path).unwrap_or_else(|e| {
            panic!(
                "读取 golden 失败（{}）：{}。\n首次生成请运行 `UPDATE_GOLDEN=1 cargo test --lib golden`",
                path.display(),
                e
            )
        });
        assert_eq!(
            normalize(&expected),
            actual,
            "系统提示词与 golden 不一致 —— TS 与 Rust 的组装已经分叉"
        );
    }

    /// 结构冒烟：基础提示词必须包含两份 md 的首行标题
    #[test]
    fn base_prompt_contains_both_specs() {
        let base = base_system_prompt();
        assert!(base.starts_with("# Tool Call Specification"), "基础提示词应以工具规范开头");
        assert!(base.contains("# Core Principles"), "基础提示词应包含核心原则");
        assert!(base.contains("\n\n"), "两部分之间应有空行");
    }

    /// 空输入时只返回基础提示词（不产生多余分隔符）
    #[test]
    fn empty_parts_produce_base_only() {
        let out = compose_system_prompt(&PromptParts::default());
        assert_eq!(out, base_system_prompt());
    }

    /// 顺序与分隔符：环境 → 项目规则 → 角色（各自之间是空行）
    #[test]
    fn sections_are_separated_by_blank_line() {
        let rules = build_project_rules_prompt("AGENTS.md", "内容");
        let out = compose_system_prompt(&PromptParts {
            env_prompt: Some("ENV"),
            project_rules: Some(&rules),
            agent_name: "A",
            ..Default::default()
        });
        assert!(out.contains("\n\nENV\n\n"));
        assert!(out.contains("内容\n\n# Role\nYou are A"));
        // description 为空时不留「，」
        assert!(out.ends_with("# Role\nYou are A"));
    }

    /// 项目规则片段：标题带文件名，内容去首尾空白
    #[test]
    fn project_rules_prompt_shape() {
        let out = build_project_rules_prompt("docs/RULES.md", "\n  正文  \n");
        assert!(out.starts_with("# Project Rules (docs/RULES.md)\n\n"));
        assert!(out.ends_with("\n\n正文"));
    }
}
