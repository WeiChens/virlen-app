//! 沙盒状态目录（对应 codex 的 $CODEX_HOME/.sandbox 与 cap_sid 文件）。
use std::path::PathBuf;

use anyhow::{Context, Result};

#[derive(Clone, Debug)]
pub struct SandboxState {
    pub state_dir: PathBuf,
}

impl SandboxState {
    /// 默认状态目录：%USERPROFILE%\.virlen-sandbox
    pub fn default_dir() -> PathBuf {
        std::env::var_os("USERPROFILE")
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

    pub fn cap_sids(&self) -> Result<crate::sandbox::cap::CapSids> {
        crate::sandbox::cap::load_or_create_cap_sids(&self.state_dir)
    }
}
