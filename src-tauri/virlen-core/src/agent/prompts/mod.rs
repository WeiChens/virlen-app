//! 系统提示词 —— md 文本的唯一存放地 + 组装 / 取值出口。
//!
//! 前端不再自带副本：Tauri 经 `cmd_agent_prompts` 取，浏览器 dev / vitest 直读本目录同一份 md（`?raw`）。
//! 这么搬是为了去掉 `include_str!("../../../../../src/domain/agent/prompts/…")` 那种「Rust 编译依赖前端
//! 目录布局」—— 现在每个提示词只有一个物理源，依赖方向单向（与工具定义「机制 C」同构）。
//!
//! [`assemble`] 负责组装（顺序 / 分隔符，与 TS `domain/agent/compose-prompt.ts` 对齐）；本模块负责提示词
//! 资源本身。⚠️ md 在工作区是 CRLF / LF，`include_str!` 原样嵌入，与 TS 比对须先归一化行尾。

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

/// 记忆再蒸馏：把一批已有记忆合并成更少、更完整的条目
/// （占位符 `{{scope}}` / `{{max_items}}` / `{{memories}}`）
pub const MEMORY_REDISTILL: &str = include_str!("memory-redistill.md");

/// 全部提示词文本 —— **前端取值的唯一出口**（Tauri 命令 `cmd_agent_prompts` 的载荷）
///
/// 一次性全量返回（六个文件合计约 8 KB）：前端启动阶段水合一次，此后同步读取。
/// 比「一个提示词一个命令」简单，也避开了「只水合了一半」这种中间态。
///
/// ⚠️ `memory_redistill` **前端运行时不消费**（再蒸馏全在 Rust 侧跑）——它进注册表只为
/// 「提示词只有一个物理源」这条纪律：前端契约测试按同一份清单断言，漏一个就在那里红。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptTexts {
    pub tool_call_spec: &'static str,
    pub core_principles: &'static str,
    pub compress_context: &'static str,
    pub generate_title: &'static str,
    pub verify_prompt: &'static str,
    pub memory_redistill: &'static str,
}

/// 取全部提示词文本
pub fn all_prompt_texts() -> PromptTexts {
    PromptTexts {
        tool_call_spec: TOOL_CALL_SPEC,
        core_principles: CORE_PRINCIPLES,
        compress_context: COMPRESS_CONTEXT,
        generate_title: GENERATE_TITLE,
        verify_prompt: VERIFY_PROMPT,
        memory_redistill: MEMORY_REDISTILL,
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
        assert_eq!(t.memory_redistill, MEMORY_REDISTILL);
    }

    /// 所有文件都是真内容（防止有人清空文件后构建仍然通过）
    #[test]
    fn all_prompts_are_non_empty() {
        let t = all_prompt_texts();
        for (name, body) in [
            ("tool_call_spec", t.tool_call_spec),
            ("core_principles", t.core_principles),
            ("compress_context", t.compress_context),
            ("generate_title", t.generate_title),
            ("verify_prompt", t.verify_prompt),
            ("memory_redistill", t.memory_redistill),
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

    /// 再蒸馏模板保留三个占位符 —— 组装只有一份实现（`memory::redistill::plan::build_prompt`）
    #[test]
    fn memory_redistill_carries_all_placeholders() {
        for ph in ["{{scope}}", "{{max_items}}", "{{memories}}"] {
            assert!(MEMORY_REDISTILL.contains(ph), "缺 {} 占位符", ph);
        }
        // 级别由来源推导，模型一侧不给这个口子（永久污染面最大）
        assert!(MEMORY_REDISTILL.contains("Do **not** output `level`"));
    }
}
