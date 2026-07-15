use serde::Serialize;
use std::process::Command;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[derive(Serialize)]
pub struct EnvInfo {
    pub os: String,
    pub os_version: String,
    pub cwd: String,
    pub tools: Vec<ToolVersion>,
}

#[derive(Serialize)]
pub struct ToolVersion {
    pub name: String,
    pub version: String,
}

/// 获取 OS 版本字符串
fn get_os_version() -> String {
    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .args(["/c", "ver"])
            .output()
            .ok()
            .and_then(|o| {
                if o.status.success() {
                    let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
                    if s.is_empty() { None } else { Some(s) }
                } else {
                    None
                }
            })
            .unwrap_or_default()
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("sw_vers")
            .arg("-productVersion")
            .output()
            .ok()
            .and_then(|o| {
                if o.status.success() {
                    let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
                    if s.is_empty() { None } else { Some(s) }
                } else {
                    None
                }
            })
            .unwrap_or_default()
    }

    #[cfg(target_os = "linux")]
    {
        std::fs::read_to_string("/etc/os-release")
            .ok()
            .and_then(|content| {
                for line in content.lines() {
                    if line.starts_with("PRETTY_NAME=") {
                        return Some(
                            line.trim_start_matches("PRETTY_NAME=")
                                .trim_matches('"')
                                .to_string(),
                        );
                    }
                }
                None
            })
            .unwrap_or_else(|| "Linux".to_string())
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        String::new()
    }
}

/// 执行命令并取第一行非空输出（先 stdout，失败则 stderr）
///
/// Windows 上的 npm、pnpm、yarn 等本质是 .cmd 批处理，不是 exe，
/// 直接用 Command::new("npm") 可能找不到（PATH 里的是 npm.cmd）。
/// 因此 Windows 下统一走 cmd /c 来确保 shell 环境变量生效。
fn get_tool_version(cmd: &str, args: &[&str]) -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        // Windows: 通过 cmd /c 执行，确保 .cmd/.bat 能被 PATH 找到
        let full_cmd = format!("{} {}", cmd, args.join(" "));
        let output = Command::new("cmd")
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .args(["/c", &full_cmd])
            .output()
            .ok()?;
        capture_output(output)
    }

    #[cfg(not(target_os = "windows"))]
    {
        // macOS/Linux: 直接执行（脚本文件有 shebang，PATH 解析正常）
        let output = Command::new(cmd).args(args).output().ok()?;
        capture_output(output)
    }
}

/// 从 Command Output 中提取第一行版本号
///
/// 规则：
/// - 只有命令成功退出（status.success()）才视为有效
/// - 先读 stdout，如果为空再读 stderr（`java -version` 输出到 stderr）
/// - 只取第一行
fn capture_output(output: std::process::Output) -> Option<String> {
    // 命令执行失败（找不到命令、退出码非零），不纳入结果
    if !output.status.success() {
        return None;
    }

    let s = {
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !stdout.is_empty() {
            stdout
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            if stderr.is_empty() {
                return None;
            }
            stderr
        }
    };

    // 只取第一行
    Some(s.lines().next()?.trim().to_string())
}

#[tauri::command]
pub fn get_env_info() -> EnvInfo {
    let os_platform = if cfg!(target_os = "windows") {
        "Windows"
    } else if cfg!(target_os = "macos") {
        "macOS"
    } else if cfg!(target_os = "linux") {
        "Linux"
    } else {
        std::env::consts::OS
    };

    let os_version = get_os_version();
    let cwd = std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    let mut tools = Vec::new();

    // 常见工具检测列表：(显示名称, 执行命令, 参数)
    let checks: &[(&str, &str, &[&str])] = &[
        ("Node.js", "node", &["--version"]),
        ("npm", "npm", &["--version"]),
        ("pnpm", "pnpm", &["--version"]),
        ("Yarn", "yarn", &["--version"]),
        ("Rustc", "rustc", &["--version"]),
        ("Cargo", "cargo", &["--version"]),
        ("Python", "python", &["--version"]),
        ("Python3", "python3", &["--version"]),
        ("Go", "go", &["version"]),
        ("Git", "git", &["--version"]),
        ("Java", "java", &["-version"]),
        ("Deno", "deno", &["--version"]),
        ("Bun", "bun", &["--version"]),
    ];

    for &(display_name, cmd, args) in checks {
        if let Some(ver) = get_tool_version(cmd, args) {
            tools.push(ToolVersion {
                name: display_name.to_string(),
                version: ver,
            });
        }
    }

    EnvInfo {
        os: os_platform.to_string(),
        os_version,
        cwd,
        tools,
    }
}
