//! file — 文件操作分类公共函数（分类 id: file）
//!
//! 供本分类下的文件工具复用：
//! `read_file` / `write_file` / `edit_file` / `delete_file`
//! / `copy_move_file` / `list_files` / `file_info` / `mkdir`

/// 格式化字节大小（B / KB / MB / GB / TB）
pub(super) fn format_size(bytes: usize) -> String {
    if bytes == 0 {
        return "0 B".to_string();
    }
    let units = ["B", "KB", "MB", "GB", "TB"];
    let k = 1024f64;
    let i = ((bytes as f64).log(k).floor() as usize).min(units.len() - 1);
    let val = bytes as f64 / k.powi(i as i32);
    if i > 0 {
        format!("{:.1} {}", val, units[i])
    } else {
        format!("{} B", val as u64)
    }
}

/// 确保目标路径的父目录存在
pub(super) fn ensure_parent_dir(path: &str) -> Result<(), String> {
    let normalized = path.replace('\\', "/");
    if let Some(parent) = normalized.rfind('/') {
        let parent_dir = &normalized[..parent];
        if !parent_dir.is_empty() {
            std::fs::create_dir_all(parent_dir)
                .map_err(|e| format!("创建目录失败: {}", e))?;
        }
    }
    Ok(())
}

/// 系统时间 → 本地时区字符串（%Y-%m-%d %H:%M:%S）
pub(super) fn format_system_time(t: std::time::SystemTime) -> String {
    let dt: chrono::DateTime<chrono::Local> = t.into();
    dt.format("%Y-%m-%d %H:%M:%S").to_string()
}
