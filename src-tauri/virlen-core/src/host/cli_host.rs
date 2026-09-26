//! CLI / headless 宿主实现 —— 无 `tauri::` 依赖
//!
//! 资源与数据目录全部由「环境变量 + 可执行文件位置」推导。
//!
//! ⚠️ `data_dir()` 的默认值必须与 GUI 的 `app_data_dir()` 一致：Tauri v2 的 `app_data_dir()`
//! = `dirs::data_dir()/<bundle identifier>`，因此这里也按 `<平台数据根>/<identifier>` 拼，CLI 与 GUI
//! 才会落到同一个 `virlen.db`。identifier 取自 `src-tauri/tauri.conf.json`（改一处必须改另一处）。
//!
//! 覆盖链：
//! ```text
//! 资源根：编译期资源根（= `src-tauri/resources`，见 `compile_time_resource_root`）> $VIRLEN_RESOURCE_DIR
//!         > <exe_dir>/resources  >  <exe_dir>
//! 数据根：$VIRLEN_DATA_DIR  >  <平台数据根>/<identifier>
//! ```

use crate::agent::host::{compile_time_resource_root, HostEnv};
use std::path::{Path, PathBuf};

/// 与 `src-tauri/tauri.conf.json` 的 `identifier` **必须一致**（见文件头说明）。
pub const BUNDLE_IDENTIFIER: &str = "JianWeichen.virlen";

pub struct CliHost {
    resource_roots: Vec<PathBuf>,
    data_dir: PathBuf,
}

impl CliHost {
    /// 从环境变量与当前可执行文件位置推导（生产 CLI 入口）。
    pub fn from_env() -> Self {
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(Path::to_path_buf));
        Self::new(
            resolve_resource_roots(env_path("VIRLEN_RESOURCE_DIR"), exe_dir),
            resolve_data_dir(env_path("VIRLEN_DATA_DIR"), default_data_root()),
        )
    }

    /// 显式构造（嵌入方 / 测试使用；生产 CLI 入口走 [`CliHost::from_env`]）。
    pub fn new(resource_roots: Vec<PathBuf>, data_dir: PathBuf) -> Self {
        Self {
            resource_roots,
            data_dir,
        }
    }
}

impl HostEnv for CliHost {
    fn resource_candidates(&self) -> Vec<PathBuf> {
        self.resource_roots.clone()
    }

    fn data_dir(&self) -> PathBuf {
        self.data_dir.clone()
    }
}

// ==================== 纯函数（无全局状态 → 可测且并行安全） ====================

fn env_path(key: &str) -> Option<PathBuf> {
    std::env::var(key)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

/// 资源候选推导：编译期根打头（与 GUI 一致，开发期行为不变），
/// 其后依次是环境变量覆盖、`<exe_dir>/resources`、`<exe_dir>`。
fn resolve_resource_roots(
    resource_override: Option<PathBuf>,
    exe_dir: Option<PathBuf>,
) -> Vec<PathBuf> {
    let mut out = vec![compile_time_resource_root()];
    if let Some(p) = resource_override {
        out.push(p);
    }
    if let Some(dir) = exe_dir {
        out.push(dir.join("resources"));
        out.push(dir);
    }
    out
}

/// 数据根推导：`$VIRLEN_DATA_DIR` 优先，否则 `<平台数据根>/<identifier>`。
fn resolve_data_dir(data_override: Option<PathBuf>, default_root: Option<PathBuf>) -> PathBuf {
    match data_override {
        Some(p) => p,
        None => default_root
            .unwrap_or_else(|| PathBuf::from("."))
            .join(BUNDLE_IDENTIFIER),
    }
}

/// 平台数据根（对应 Rust `dirs` crate 的 `data_dir()`，刻意不为此新增依赖）。
fn default_data_root() -> Option<PathBuf> {
    if cfg!(target_os = "windows") {
        env_path("APPDATA")
    } else if cfg!(target_os = "macos") {
        env_path("HOME").map(|h| h.join("Library").join("Application Support"))
    } else {
        env_path("XDG_DATA_HOME")
            .or_else(|| env_path("HOME").map(|h| h.join(".local").join("share")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resource_roots_keep_compile_time_root_first() {
        let roots = resolve_resource_roots(Some(PathBuf::from("/custom/res")), Some(PathBuf::from("/exe")));
        assert_eq!(roots[0], compile_time_resource_root());
        assert_eq!(roots[1], PathBuf::from("/custom/res"));
        assert_eq!(roots[2], PathBuf::from("/exe").join("resources"));
        assert_eq!(roots[3], PathBuf::from("/exe"));
    }

    #[test]
    fn resource_roots_without_overrides_and_without_exe() {
        let roots = resolve_resource_roots(None, None);
        assert_eq!(roots, vec![compile_time_resource_root()]);
    }

    #[test]
    fn data_dir_defaults_to_platform_root_with_identifier() {
        let dir = resolve_data_dir(None, Some(PathBuf::from("/data")));
        assert_eq!(dir, PathBuf::from("/data").join(BUNDLE_IDENTIFIER));
    }

    #[test]
    fn data_dir_override_wins_verbatim() {
        // 覆盖值必须原样使用（不再拼 identifier）—— 测试 / 便携安装靠它指到临时目录
        let dir = resolve_data_dir(Some(PathBuf::from("/tmp/portable")), Some(PathBuf::from("/data")));
        assert_eq!(dir, PathBuf::from("/tmp/portable"));
    }

    /// CLI 与 GUI 必须落在同一个数据目录：默认值 = `<平台数据根>/<identifier>`。
    #[test]
    fn default_data_dir_matches_tauri_app_data_dir_shape() {
        let root = default_data_root();
        if root.is_none() {
            return; // 无 APPDATA / HOME 的环境跳过
        }
        let dir = resolve_data_dir(None, root);
        assert_eq!(dir.file_name().and_then(|n| n.to_str()), Some(BUNDLE_IDENTIFIER));
    }

    #[test]
    fn cli_host_exposes_injected_values() {
        let host = CliHost::new(vec![PathBuf::from("/a")], PathBuf::from("/b"));
        assert_eq!(host.resource_candidates(), vec![PathBuf::from("/a")]);
        assert_eq!(host.data_dir(), PathBuf::from("/b"));
    }
}
