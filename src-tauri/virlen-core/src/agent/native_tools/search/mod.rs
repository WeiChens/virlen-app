//! search — 搜索分类（分类 id: search）：`search_files_by_name`（按文件名：文本 / 正则 / glob）、
//! `search_text_in_files`（按内容正则）；`common.rs` 为 glob 模式 → 正则转换。

mod common;
mod search_files_by_name;
mod search_text_in_files;

pub(crate) use search_files_by_name::search_files_by_name_tool;
pub(crate) use search_text_in_files::search_text_in_files_tool;
