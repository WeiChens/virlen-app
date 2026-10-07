//! chat — 会话消息分类（分类 id: chat）：`list_messages`（历史消息时序 + 关键词定位）、
//! `read_messages`（按 id + 相对窗口读正文）；`common.rs` 为文本格式化 / 输出上限 / 字符预算。
//!
//! ⚠️ 与 TS `infrastructure/tools/chat/*` 逐字对齐（铁律 1）—— 原生路径与 JS 回退路径产出同一份
//! `content` / `uiData`。

mod common;
mod list_messages;
mod read_messages;

pub(crate) use list_messages::list_messages_tool;
pub(crate) use read_messages::read_messages_tool;
