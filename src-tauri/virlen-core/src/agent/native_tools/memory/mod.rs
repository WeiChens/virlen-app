//! memory — 长期记忆分类（分类 id: memory），含 `memory_search` / `memory_recall` /
//! `memory_write`（与 JS 回退路径 `infrastructure/tools/memory/` 对应）。
//!
//! 语义实现在 core 的 `agent::memory::tools`（与 GUI 命令 `cmd_memory_*` 共用），本目录只做
//! 「取依赖 + 转 [`NativeToolOutcome`]」。

mod common;
mod memory_recall;
mod memory_search;
mod memory_write;

pub(crate) use memory_recall::memory_recall_tool;
pub(crate) use memory_search::memory_search_tool;
pub(crate) use memory_write::memory_write_tool;
