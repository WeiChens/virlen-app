//! 状态目录与能力 SID 持久化（对应 codex cap.rs）。
//!
//! 核心思想：能力 SID 是**随机生成、只有安装方知道**的 SID。
//! 它被写进文件/目录的 ACL（允许或拒绝），并作为受限令牌的
//! restricting SID 注入子进程令牌。子进程自身永远无法得知该 SID
//! 的字符串值，因此无法「自我授权」。
use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;

use anyhow::{Context, Result};
use rand::rngs::SmallRng;
use rand::RngCore;
use rand::SeedableRng;
use serde::{Deserialize, Serialize};

use crate::sandbox::paths::canonical_path_key;

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct CapSids {
    /// 全局只读能力 SID：readonly 模式下注入令牌，但没有任何 ACL 会授予它写权限。
    pub readonly: String,
    /// 按规范化的 cwd 字符串 → 工作区能力 SID（写 cwd 时需要）。
    pub workspace_by_cwd: HashMap<String, String>,
    /// 按规范化路径 → 额外可写根能力 SID（写额外 root 时需要）。
    pub writable_root_by_path: HashMap<String, String>,
}

fn make_random_cap_sid_string() -> String {
    let mut rng = SmallRng::from_entropy();
    format!(
        "S-1-5-21-{}-{}-{}-{}",
        rng.next_u32(),
        rng.next_u32(),
        rng.next_u32(),
        rng.next_u32()
    )
}

pub fn cap_sid_file(state_dir: &Path) -> PathBuf {
    state_dir.join("cap_sid.json")
}

pub fn load_or_create_cap_sids(state_dir: &Path) -> Result<CapSids> {
    std::fs::create_dir_all(state_dir)
        .with_context(|| format!("create state dir {}", state_dir.display()))?;
    let path = cap_sid_file(state_dir);
    if let Ok(txt) = std::fs::read_to_string(&path) {
        if let Ok(caps) = serde_json::from_str::<CapSids>(&txt) {
            return Ok(caps);
        }
    }
    let caps = CapSids {
        readonly: make_random_cap_sid_string(),
        workspace_by_cwd: HashMap::new(),
        writable_root_by_path: HashMap::new(),
    };
    persist_caps(&path, &caps)?;
    Ok(caps)
}

fn persist_caps(path: &Path, caps: &CapSids) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    // 原子写，避免半截文件。
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(caps)?)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// cwd（工作区）对应的工作区能力 SID。
pub fn workspace_cap_sid_for_cwd(state_dir: &Path, cwd: &Path) -> Result<String> {
    let path = cap_sid_file(state_dir);
    let mut caps = load_or_create_cap_sids(state_dir)?;
    let key = canonical_path_key(cwd);
    if let Some(sid) = caps.workspace_by_cwd.get(&key) {
        return Ok(sid.clone());
    }
    let sid = make_random_cap_sid_string();
    caps.workspace_by_cwd.insert(key, sid.clone());
    persist_caps(&path, &caps)?;
    Ok(sid)
}

/// 额外可写根目录对应的能力 SID。
pub fn writable_root_cap_sid_for_path(state_dir: &Path, root: &Path) -> Result<String> {
    let path = cap_sid_file(state_dir);
    let mut caps = load_or_create_cap_sids(state_dir)?;
    let key = canonical_path_key(root);
    if let Some(sid) = caps.writable_root_by_path.get(&key) {
        return Ok(sid.clone());
    }
    let sid = make_random_cap_sid_string();
    caps.writable_root_by_path.insert(key, sid.clone());
    persist_caps(&path, &caps)?;
    Ok(sid)
}

/// 读能力 SID（readonly 令牌用）。
pub fn readonly_cap_sid(state_dir: &Path) -> Result<String> {
    Ok(load_or_create_cap_sids(state_dir)?.readonly)
}

/// 把「可写根」映射为 (根路径, 能力 SID)。
pub fn write_root_capability_sids(
    state_dir: &Path,
    cwd: &Path,
    roots: &[PathBuf],
) -> Result<Vec<(PathBuf, String)>> {
    let mut out = Vec::with_capacity(roots.len());
    for root in roots {
        // cwd 使用 per-cwd 的 SID（保证每个工作区互相隔离）；
        // 其他额外根使用 per-path 的 SID。
        let sid = if crate::sandbox::paths::same_path_key(cwd, root) {
            workspace_cap_sid_for_cwd(state_dir, cwd)?
        } else {
            writable_root_cap_sid_for_path(state_dir, root)?
        };
        out.push((root.clone(), sid));
    }
    Ok(out)
}
