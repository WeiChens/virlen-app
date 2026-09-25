//! search — 搜索分类（分类 id: search）
//!
//! 一个工具一个文件：
//! - `search_files_by_name`：按文件名（纯文本 / 正则 / glob）搜索
//! - `search_text_in_files`：按文件内容（正则）搜索
//!
//! `common.rs` 为分类内公共：glob 模式 → 正则转换。

mod common;
mod search_files_by_name;
mod search_text_in_files;

pub(crate) use search_files_by_name::search_files_by_name_tool;
pub(crate) use search_text_in_files::search_text_in_files_tool;
