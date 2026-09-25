//! 沙盒状态目录（跨平台）。
//!
//! Windows 用它存放能力 SID 映射（cap_sid.json）；Linux/macOS 用它存放
//! 各自的状态文件（如 macOS 的 Seatbelt profile）。

use std::path::PathBuf;

use anyhow::{Context, Result};

#[derive(Clone, Debug)]
pub struct SandboxState {
    pub state_dir: PathBuf,
}

impl SandboxState {
    /// 默认状态目录：`$HOME/.virlen-sandbox`（Windows 上 HOME 不存在时回退 `%USERPROFILE%`）。
    pub fn default_dir() -> PathBuf {
        std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir)
            .join(".virlen-sandbox")
    }

    pub fn new(state_dir: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(&state_dir)
            .with_context(|| format!("create state dir {}", state_dir.display()))?;
        Ok(Self { state_dir })
    }

    pub fn from_default_or(override_dir: Option<PathBuf>) -> Result<Self> {
        let dir = override_dir.unwrap_or_else(Self::default_dir);
        Self::new(dir)
    }
}
