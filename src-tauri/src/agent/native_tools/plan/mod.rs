//! plan — 任务清单分类（分类 id: plan）
//!
//! 一个工具一个文件：
//! - `todo_write`：任务清单**全量替换**（无状态；清单随 tool_result 的 `content` + `uiData` 落库）
//!
//! `common.rs` 为分类内公共：清单归一化 / 统计 / 软校验 / 渲染。
//! ⚠️ 与 TS 侧 `src/domain/todo/state.ts` 的对应函数**逐字对齐**（铁律 1）——
//! 同一个工具在 Rust 引擎（原生）与 TS 引擎（JS 执行器）下必须产出同一份文本与同一份 uiData。

mod common;
mod todo_write;

pub(crate) use todo_write::todo_write_tool;
