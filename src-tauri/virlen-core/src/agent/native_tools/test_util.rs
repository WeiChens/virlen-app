//! native_tools — 测试辅助（仅 `#[cfg(test)]` 下编译）
//!
//! 各分类测试共用的构造器与探针，避免在每个测试模块里重复定义。

use crate::agent::types::NativeToolSecurity;

pub(crate) fn test_security(workspace: &str) -> NativeToolSecurity {
    NativeToolSecurity {
        workspace: workspace.to_string(),
        approval_mode: "risky".to_string(),
        skip_dirs: vec!["node_modules".to_string()],
        blacklist: vec![],
        whitelist: vec![],
        skills_dir: None,
        sandbox_mode: "on".to_string(),
        // 测试默认给空表 → 决策回退 legacy approval_mode（保持既有测试语义）
        permissions: std::collections::BTreeMap::new(),
        // 默认无规则 → 决策与旧版一致（不脱壳），且判定不需要任何 IO
        sandbox_ignore_rules: vec![],
    }
}

/// 裸跑路径的 security（sandbox off）：用于测试 kill/timeout 的 taskkill /T 兜底逻辑，
/// 与沙盒路径的 Job Object 终止分开验证（沙盒 kill 见 sandbox::tests）。
pub(crate) fn test_security_bare(workspace: &str) -> NativeToolSecurity {
    let mut sec = test_security(workspace);
    sec.sandbox_mode = "off".to_string();
    sec
}


