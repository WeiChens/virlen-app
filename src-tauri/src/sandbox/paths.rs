//! 路径规范化与比较工具（对应 codex path_normalization.rs）。

use std::path::Path;
use std::path::PathBuf;

/// canonicalize + 失败时退回原路径。
pub fn canonicalize_path(path: &Path) -> PathBuf {
    dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// 规范化路径键：统一分隔符、统一小写（Windows 路径大小写不敏感）。
pub fn canonical_path_key(path: &Path) -> String {
    canonicalize_path(path)
        .to_string_lossy()
        .replace('\\', "/")
        .to_ascii_lowercase()
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
