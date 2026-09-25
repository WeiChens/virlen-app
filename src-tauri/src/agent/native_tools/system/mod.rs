//! system — 系统分类（分类 id: system）
//!
//! 一个工具一个文件：
//! - `user_choice`：向用户提问（**没有自己的执行逻辑**，只把交互请求交给 UI）
//! - `get_current_time`：当前时间（IANA 时区，`chrono-tz` 内置库）—— 无 JS 的 CLI 也能用

mod get_current_time;
mod user_choice;

pub(crate) use get_current_time::get_current_time_tool;
pub(crate) use user_choice::user_choice_tool;
