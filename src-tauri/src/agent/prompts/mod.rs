//! 系统提示词资源与组装（Rust 侧）
//!
//! 目标：让 Rust 引擎也能组装系统提示词（为 headless / CLI 做前置），
//! 同时**不产生第二份静态文本**。因此：
//!
//! - 静态 md **直接引用 TS 侧现有路径**（`include_str!`），不复制副本；
//! - 组装逻辑在 `assemble` 里实现一份，与 TS `domain/agent/compose-prompt.ts` 对齐；
//! - 两侧用同一组输入的结果由 golden 测试**逐字节锁定**（任一侧改动都会让另一边失败）。
//!
//! ⚠️ 行尾差异：md 在工作区是 CRLF（Windows）/ LF（Linux CI），`include_str!` 原样嵌入。
//! 因此两侧的比对必须先归一化行尾（见测试里的 `normalize`），比对的是「文本内容」而非字节。

pub mod assemble;

/// 工具调用规范 —— 唯一事实源在 TS 侧，此处只引用
pub const TOOL_CALL_SPEC: &str =
    include_str!("../../../../src/domain/agent/prompts/tool-call-spec.md");

/// 核心原则 —— 唯一事实源在 TS 侧，此处只引用
pub const CORE_PRINCIPLES: &str =
    include_str!("../../../../src/domain/agent/prompts/core-principles.md");
