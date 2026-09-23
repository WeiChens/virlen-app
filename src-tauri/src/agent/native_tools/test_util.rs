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
        // 默认无规则 → 原生工具不会多做一次「规则查询」的桥往返（保持既有测试语义）
        has_sandbox_ignore_rules: false,
    }
}

/// 裸跑路径的 security（sandbox off）：用于测试 kill/timeout 的 taskkill /T 兜底逻辑，
/// 与沙盒路径的 Job Object 终止分开验证（沙盒 kill 见 sandbox::tests）。
pub(crate) fn test_security_bare(workspace: &str) -> NativeToolSecurity {
    let mut sec = test_security(workspace);
    sec.sandbox_mode = "off".to_string();
    sec
}

/// 检查进程是否存活（Windows 用 Get-Process，其他平台用 kill -0）
pub(crate) fn is_process_alive(pid: u32) -> bool {
    #[cfg(target_os = "windows")]
    {
        let out = std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                &format!(
                    "if (Get-Process -Id {} -ErrorAction SilentlyContinue) {{ 'ALIVE' }} else {{ 'DEAD' }}",
                    pid
                ),
            ])
            .output()
            .unwrap();
        let s = String::from_utf8_lossy(&out.stdout);
        s.contains("ALIVE")
    }
    #[cfg(not(target_os = "windows"))]
    {
        let out = std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .output()
            .unwrap();
        out.status.success()
    }
}
