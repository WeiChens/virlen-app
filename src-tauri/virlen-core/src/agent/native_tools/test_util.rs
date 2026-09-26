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

/// 检查进程是否存活（Windows 用 Get-Process，其他平台用 kill -0）
///
/// ⚠️ 当前**只有 Windows 用例**（`execute_command/tests.rs` 的进程树 kill 验证，同样带
///    Windows 门禁）在调用它 → 非 Windows 下这个函数没有调用者。它本身是「两平台各自实现」
///    的探针，非 Windows 分支（`kill -0`）是给今后 Linux 用例留的，故按平台 allow 而不是删掉。
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
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
