//! native_tools — 跨分类公共模块
//!
//! 不属于任何单一工具分类、被多个分类共同使用的函数：
//! - 参数取值辅助 `arg_str` / `arg_i64` / `arg_bool` / `arg_str_array`
//!   （execute / file / search / knowledge_base 四个分类都在用）
//! - 安全路径解析 `resolve_safe_path` / `is_path_allowed`
//!   （对齐前端 `securityService.resolveSafePath` / `securityPort.isPathAllowed`）

use crate::agent::types::NativeToolSecurity;
use serde_json::Value;

// ==================== 参数辅助 ====================

pub(super) fn arg_str(args: &Value, key: &str) -> Option<String> {
    args.get(key).and_then(|v| v.as_str()).map(|s| s.to_string())
}
pub(super) fn arg_i64(args: &Value, key: &str) -> Option<i64> {
    args.get(key).and_then(|v| v.as_i64())
}
pub(super) fn arg_bool(args: &Value, key: &str) -> Option<bool> {
    args.get(key).and_then(|v| v.as_bool())
}

pub(super) fn arg_str_array(args: &Value, key: &str) -> Vec<String> {
    match args.get(key) {
        Some(Value::Array(arr)) => arr
            .iter()
            .filter_map(|v| v.as_str())
            .map(|s| s.to_string())
            .filter(|s| !s.trim().is_empty())
            .collect(),
        _ => Vec::new(),
    }
}

// ==================== 安全路径解析（对齐 securityService.resolveSafePath） ====================

fn canonicalize_partial(path: &str) -> Option<String> {
    let p = std::path::Path::new(path);
    if let Ok(c) = p.canonicalize() {
        return Some(c.to_string_lossy().replace('\\', "/"));
    }
    let normalized = path.replace('\\', "/");
    let normalized = normalized.trim_end_matches('/');
    let parts: Vec<&str> = normalized.split('/').collect();
    for i in (1..parts.len()).rev() {
        let parent = parts[..i].join("/");
        let pp = std::path::Path::new(&parent);
        if let Ok(c) = pp.canonicalize() {
            return Some(c.to_string_lossy().replace('\\', "/"));
        }
    }
    None
}

/// 路径白名单/黑名单校验 — 与 `securityPort.isPathAllowed` 逻辑一致
pub fn is_path_allowed(target: &str, mode: &str, security: &NativeToolSecurity) -> Result<(), String> {
    let canonical_target =
        canonicalize_partial(target).ok_or_else(|| "路径无法解析".to_string())?;

    // 1. 黑名单 > 一切
    for b in &security.blacklist {
        if let Some(canon) = canonicalize_partial(b) {
            if canonical_target == canon || canonical_target.starts_with(&format!("{}/", canon)) {
                return Err(format!("路径已被黑名单拦截: {}", target));
            }
        }
    }

    // 2. 白名单 > 工作目录
    for w in &security.whitelist {
        if let Some(canon) = canonicalize_partial(w) {
            if canonical_target == canon || canonical_target.starts_with(&format!("{}/", canon)) {
                return Ok(());
            }
        }
    }

    // 3. 工作目录
    let raw_workspace = security.workspace.replace('\\', "/");
    let raw_workspace = raw_workspace.trim_end_matches('/');
    if !raw_workspace.is_empty() {
        if let Some(canon_ws) = canonicalize_partial(raw_workspace) {
            if canonical_target == canon_ws
                || canonical_target.starts_with(&format!("{}/", canon_ws))
            {
                return Ok(());
            }
        }
    }

    // 4. 其他路径
    if mode == "w" {
        return Err("路径不在白名单或工作目录内，且写权限仅允许白名单与工作目录".to_string());
    }
    Ok(())
}

/// 相对路径相对 workspace，绝对路径走安全校验
pub fn resolve_safe_path(
    input_path: &str,
    mode: &str,
    security: &NativeToolSecurity,
) -> Result<String, String> {
    let workspace = &security.workspace;
    if workspace.is_empty() {
        return Err("resolveSafePath: workspace 是必填参数".to_string());
    }
    if input_path.is_empty() {
        return Ok(workspace.clone());
    }

    let is_absolute = input_path.starts_with('/')
        || input_path.starts_with('\\')
        || {
            let bytes = input_path.as_bytes();
            bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
        };

    let absolute = if is_absolute {
        input_path.to_string()
    } else {
        let sep = if workspace.ends_with('/') || workspace.ends_with('\\') {
            ""
        } else {
            "/"
        };
        format!("{}{}{}", workspace, sep, input_path.replace('\\', "/"))
    };

    is_path_allowed(&absolute, mode, security)?;
    Ok(absolute)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::native_tools::test_util::test_security;

    #[test]
    fn test_resolve_safe_path_relative() {
        let dir = std::env::temp_dir().join(format!("virlen_native_test_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let sec = test_security(&dir.to_string_lossy());
        let resolved = resolve_safe_path("sub/file.txt", "r", &sec).unwrap();
        assert!(resolved.ends_with("/sub/file.txt") || resolved.ends_with("\\sub/file.txt"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_resolve_safe_path_write_outside_workspace() {
        let dir = std::env::temp_dir().join(format!("virlen_native_test_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let sec = test_security(&dir.to_string_lossy());
        // 非白名单/工作目录外的写路径应被拒绝（除非是绝对路径在临时目录外）
        // 这里使用一个不存在且不在 workspace 下的绝对路径
        let outside = std::env::temp_dir().join("some_outside_file.txt");
        let outside_str = outside.to_string_lossy().replace('\\', "/");
        if !outside_str.starts_with(&dir.to_string_lossy().replace('\\', "/")) {
            let r = resolve_safe_path(&outside_str, "w", &sec);
            // workspace 是临时目录，outside 在 /tmp 下且 /tmp 不在 workspace 内 → 应拒绝
            assert!(r.is_err());
        }
        std::fs::remove_dir_all(&dir).ok();
    }
}
