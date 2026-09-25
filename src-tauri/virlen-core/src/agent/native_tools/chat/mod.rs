//! chat — 会话消息分类（分类 id: chat）
//!
//! 一个工具一个文件：
//! - `list_messages`：列出「已被上下文压缩掉」的历史消息时序（含 id / 关键词定位）
//! - `read_messages`：按消息 id + 相对窗口读取该区间内的消息正文
//!
//! `common.rs` 为分类内公共：模型侧文本格式化 / 输出上限 / 单会话字符预算。
//! ⚠️ 与 TS 侧 `src/infrastructure/tools/chat/*` **逐字对齐**（铁律 1）——
//! 两个引擎（Rust 原生默认 / TS 回退）必须产出同一份 `content` 与同一份 `uiData`。

mod common;
mod list_messages;
mod read_messages;

pub(crate) use list_messages::list_messages_tool;
pub(crate) use read_messages::read_messages_tool;
