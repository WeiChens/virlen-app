//! memory — 长期记忆分类（分类 id: memory）
//!
//! 一个工具一个文件（3 个）：`memory_search` / `memory_recall` / `memory_write`，
//! 与 JS 侧回退路径 `src/infrastructure/tools/memory/` 一一对应。
//!
//! 三者的**语义实现在 core 的 `agent::memory::tools`**（与 GUI 命令 `cmd_memory_*` 共用一份），
//! 本目录只做两件事：从 [`NativeToolCtx`] 取依赖、把结果转成 [`NativeToolOutcome`]。

mod common;
mod memory_recall;
mod memory_search;
mod memory_write;

pub(crate) use memory_recall::memory_recall_tool;
pub(crate) use memory_search::memory_search_tool;
pub(crate) use memory_write::memory_write_tool;
