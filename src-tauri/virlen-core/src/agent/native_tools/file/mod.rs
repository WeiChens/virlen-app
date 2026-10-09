//! file — 文件操作分类（分类 id: file）
//!
//! 一个工具一个文件（9 个）：
//! `read_file` / `write_file` / `edit_file` / `delete_file`
//! / `copy_move_file` / `list_files` / `file_info` / `mkdir` / `parse_document`
//!
//! `common.rs` 为分类内公共：`format_size` / `ensure_parent_dir` / `format_system_time`。

mod common;
mod copy_move_file;
mod delete_file;
mod edit_file;
mod file_info;
mod list_files;
mod mkdir;
mod parse_document;
mod read_file;
mod write_file;

pub(crate) use copy_move_file::copy_move_file_tool;
pub(crate) use delete_file::delete_file_tool;
pub(crate) use edit_file::edit_file_tool;
pub(crate) use file_info::file_info_tool;
pub(crate) use list_files::list_files_tool;
pub(crate) use mkdir::mkdir_tool;
// 文档解析：GUI 命令 `cmd_parse_document` 与原生工具共用同一个组装入口 + 默认值兜底
// （见该文件模块头；`default_max_chars` 必须两边共用，否则默认预览长度会分叉）
pub use parse_document::{default_max_chars, parse_targets, ParseAggregate, ParseTarget};
pub(crate) use parse_document::parse_document_tool;
pub(crate) use read_file::read_file_tool;
pub(crate) use write_file::write_file_tool;

#[cfg(test)]
mod tests {
    use crate::file_ops;

    #[test]
    fn test_write_read_roundtrip() {
        let dir = std::env::temp_dir().join(format!("virlen_native_test_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("hello.txt");
        let path = file.to_string_lossy().to_string();

        let w = file_ops::write_file(&path, "hello\nworld\n").unwrap();
        assert!(!w.existed);
        let r = file_ops::read_file(&path).unwrap();
        assert_eq!(r.content, "hello\nworld\n");
        assert_eq!(r.hash10, w.hash10);

        // 再次写入（覆盖）
        let w2 = file_ops::write_file(&path, "new content").unwrap();
        assert!(w2.existed);
        let r2 = file_ops::read_file(&path).unwrap();
        assert_eq!(r2.content, "new content");
        assert_ne!(r2.hash10, w.hash10);

        std::fs::remove_dir_all(&dir).ok();
    }
}
