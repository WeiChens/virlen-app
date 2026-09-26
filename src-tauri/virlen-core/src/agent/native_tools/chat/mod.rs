//! chat — 会话消息分类（分类 id: chat）
//!
//! 一个工具一个文件：`list_messages`（列出历史消息时序，含 id / 关键词定位）、`read_messages`（按 id +
//! 相对窗口读取正文）。`common.rs` 为分类内公共：模型侧文本格式化 / 输出上限 / 单会话字符预算。
//!
//! ⚠️ 与 TS 侧 `src/infrastructure/tools/chat/*` 逐字对齐（铁律 1）—— 原生路径（默认）与 JS 回退路径必须
//! 产出同一份 `content` 与同一份 `uiData`。

mod common;
mod list_messages;
mod read_messages;

pub(crate) use list_messages::list_messages_tool;
pub(crate) use read_messages::read_messages_tool;
