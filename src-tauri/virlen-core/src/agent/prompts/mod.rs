//! 系统提示词 —— **md 文本的唯一存放地** + 组装 / 取值出口
//!
//! 本目录（与 `assemble.rs` 同级）存放**全部**模型侧提示词文本。前端（`virlen-app` / GUI）
//! **不再自带副本**：需要时经 Tauri 命令 `cmd_agent_prompts` 取；浏览器 dev / vitest 则直读
//! 本目录**同一份文件**（`?raw`，见 `src/infrastructure/prompts/prompt-source.ts`）。
//!
//! ## 为什么要搬过来
//!
//! 以前是 `include_str!("../../../../../src/domain/agent/prompts/…")` ——
//! **Rust 的编译依赖前端目录布局**：前端挪一个文件夹就构建失败（且错误信息只指向
//! 缺失路径，看不出是谁的责任）。改成「Rust 持有文本、前端经命令取」后：
//!
//! - 每个提示词只有**一个物理源**（仍不产生第二份静态文本）；
//! - 依赖方向**单向**：Rust 不认前端路径，前端认 Rust 命令（与工具定义「机制 C」同构）。
//!
//! ## 两份职责
//!
//! - [`assemble`]：提示词**组装**（顺序 / 分隔符），与 TS `domain/agent/compose-prompt.ts` 对齐；
//! - 本模块：提示词**资源**（文本本体 + [`all_prompt_texts`] 注册表）。
//!
//! ⚠️ 行尾差异：md 在工作区是 CRLF（Windows）/ LF（Linux CI），`include_str!` 原样嵌入。
//! 因此与 TS 的比对必须先归一化行尾（见 `assemble` 测试里的 `normalize`），
//! 比对的是「文本内容」而非字节。

pub mod assemble;

/// 工具调用规范（`assemble` 的基础段）
pub const TOOL_CALL_SPEC: &str = include_str!("tool-call-spec.md");

/// 核心原则（`assemble` 的基础段）
pub const CORE_PRINCIPLES: &str = include_str!("core-principles.md");

/// 上下文压缩（`ai` 模式）的摘要指令
pub const COMPRESS_CONTEXT: &str = include_str!("compress-context.md");

/// 会话标题生成指令
pub const GENERATE_TITLE: &str = include_str!("generate-title.md");

/// 结果验证模板（占位符 `{{goal}}` / `{{trace}}`）
pub const VERIFY_PROMPT: &str = include_str!("verify-prompt.md");

/// 全部提示词文本 —— **前端取值的唯一出口**（Tauri 命令 `cmd_agent_prompts` 的载荷）
///
/// 一次性全量返回（五个文件合计约 4 KB）：前端启动阶段水合一次，此后同步读取。
/// 比「一个提示词一个命令」简单，也避开了「只水合了一半」这种中间态。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptTexts {
    pub tool_call_spec: &'static str,
    pub core_principles: &'static str,
    pub compress_context: &'static str,
    pub generate_title: &'static str,
    pub verify_prompt: &'static str,
}

/// 取全部提示词文本
pub fn all_prompt_texts() -> PromptTexts {
    PromptTexts {
        tool_call_spec: TOOL_CALL_SPEC,
        core_principles: CORE_PRINCIPLES,
        compress_context: COMPRESS_CONTEXT,
        generate_title: GENERATE_TITLE,
        verify_prompt: VERIFY_PROMPT,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 注册表与常量必须一致（改一处忘了另一处会在这里红）
    #[test]
    fn registry_matches_constants() {
        let t = all_prompt_texts();
        assert_eq!(t.tool_call_spec, TOOL_CALL_SPEC);
        assert_eq!(t.core_principles, CORE_PRINCIPLES);
        assert_eq!(t.compress_context, COMPRESS_CONTEXT);
        assert_eq!(t.generate_title, GENERATE_TITLE);
        assert_eq!(t.verify_prompt, VERIFY_PROMPT);
    }

    /// 五个文件都是真内容（防止有人清空文件后构建仍然通过）
    #[test]
    fn all_prompts_are_non_empty() {
        let t = all_prompt_texts();
        for (name, body) in [
            ("tool_call_spec", t.tool_call_spec),
            ("core_principles", t.core_principles),
            ("compress_context", t.compress_context),
            ("generate_title", t.generate_title),
            ("verify_prompt", t.verify_prompt),
        ] {
            assert!(body.trim().len() > 20, "提示词 `{}` 内容为空或过短", name);
        }
    }

    /// 验证模板保留两个占位符 —— 两侧（Rust `verifier` / TS `verifier.ts`）都靠字符串替换
    #[test]
    fn verify_prompt_carries_both_placeholders() {
        assert!(VERIFY_PROMPT.contains("{{goal}}"), "缺 {{goal}} 占位符");
        assert!(VERIFY_PROMPT.contains("{{trace}}"), "缺 {{trace}} 占位符");
    }
}
