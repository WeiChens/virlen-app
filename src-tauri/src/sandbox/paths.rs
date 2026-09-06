//! 路径规范化与比较工具（对应 codex path_normalization.rs）。

use std::path::Path;
use std::path::PathBuf;

/// canonicalize + 失败时退回原路径。
pub fn canonicalize_path(path: &Path) -> PathBuf {
    dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// 规范化路径键：统一分隔符；Windows/macOS 再统一小写（两者默认大小写不敏感）。
/// Linux 保留原大小写（大小写敏感），避免 `/Foo` 与 `/foo` 被误判为同一路径。
pub fn canonical_path_key(path: &Path) -> String {
    let normalized = canonicalize_path(path).to_string_lossy().replace('\\', "/");
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    {
        normalized.to_ascii_lowercase()
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        normalized
    }
}

pub fn same_path_key(a: &Path, b: &Path) -> bool {
    canonical_path_key(a) == canonical_path_key(b)
}

/// root 是否包含 path（均按规范化后比较，按前缀判定目录包含关系）。
pub fn root_contains_path(root: &Path, path: &Path) -> bool {
    let r = canonical_path_key(root);
    let p = canonical_path_key(path);
    p == r || p.starts_with(&format!("{r}/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(any(target_os = "windows", target_os = "macos"))]
    #[test]
    fn key_normalizes_case_and_separators() {
        assert_eq!(
            canonical_path_key(Path::new(r"C:\Users\Dev\Repo")),
            canonical_path_key(Path::new("c:/users/dev/repo"))
        );
    }

    #[test]
    fn containment_uses_prefix() {
        let root = Path::new(r"C:\work\proj");
        assert!(root_contains_path(root, Path::new(r"C:\work\proj\src\a.rs")));
        assert!(!root_contains_path(root, Path::new(r"C:\work\proj2")));
    }
}
