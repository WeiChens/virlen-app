//! plan — 任务清单分类（分类 id: plan）：`todo_write`（清单全量替换，无状态；清单随 tool_result
//! 的 `content` + `uiData` 落库）；`common.rs` 为清单归一化 / 统计 / 软校验 / 渲染。
//!
//! ⚠️ 与 TS `domain/todo/state.ts` 对应函数逐字对齐（铁律 1）—— 原生路径与 JS 回退路径必须产出
//! 同一份文本与 uiData。

mod common;
mod todo_write;

pub(crate) use todo_write::todo_write_tool;
// 压缩模块（`agent::compress`）复用同一套清单渲染：把「当前活跃清单」补进 summary 正文，
// 保证上下文压缩后模型仍记得清单（铁律 1：与 TS `renderTodoContent` 逐字对齐）。
pub(crate) use common::render_todo_content;
