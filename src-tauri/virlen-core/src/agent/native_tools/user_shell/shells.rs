//! user_shell — **支持哪几种 shell，以及这台机器上装没装**。
//!
//! 四种：`cmd.exe` / Windows PowerShell 5.1 / PowerShell 7（`pwsh.exe`）/ Git Bash。
//! 前两种是系统自带；后两种**必须先探测**：没装就老老实实显示「未安装」，
//! 不能让用户点了以后收到一句「启动 pwsh 失败：系统找不到指定的文件」。
//!
//! ## 探测口径（顺序即优先级）
//!
//! | kind | 先查 | 再查 |
//! |---|---|---|
//! | `cmd` | `%COMSPEC%` | `%SystemRoot%\System32\cmd.exe`、PATH |
//! | `powershell` | `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` | PATH |
//! | `pwsh` | `%ProgramFiles%\PowerShell\{7,6}\pwsh.exe`、`%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe`（商店版别名） | PATH |
//! | `gitbash` | Git 的常见安装目录、**由 PATH 上的 `git.exe` 反推**（`<git>\cmd\git.exe` → `<git>\bin\bash.exe`） | PATH 上的 `bash.exe`（**跳过 System32 / WindowsApps 里的 WSL bash**） |
//!
//! 最后一条不是锦上添花：Git for Windows 默认只把 `<git>\cmd` 加进 PATH（`git` 能用），
//! `<git>\bin` 并不在 PATH 上 —— 只按 PATH 找 `bash.exe` 会在装了 Git 的机器上判「未安装」。
//!
//! ⚠️ `C:\Windows\System32\bash.exe` 是 **WSL** 的入口，不是 Git Bash：PATH 搜索必须排除它
//! （否则会把 WSL 当成 Git Bash 起起来，用户看到的 prompt 与预期完全不同）。
//!
//! ⚠️ 探测只做**存在性**判断，不真的去执行 shell（那是一秒级的冷启动，不该在菜单里跑）。

use std::path::{Path, PathBuf};

/// 支持的交互 shell。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellKind {
    /// `cmd.exe`（系统自带）
    Cmd,
    /// Windows PowerShell 5.1（系统自带，改造前的唯一选择）
    PowerShell,
    /// PowerShell 7+（`pwsh.exe`，需要另外安装）
    Pwsh,
    /// Git for Windows 的 bash（需要另外安装）
    GitBash,
}

impl ShellKind {
    /// 全部类型（**顺序即界面菜单顺序**：系统自带的在前，需要安装的在后）
    pub const ALL: [ShellKind; 4] = [
        ShellKind::PowerShell,
        ShellKind::Cmd,
        ShellKind::Pwsh,
        ShellKind::GitBash,
    ];

    /// 没有指定 / 没有记忆时的首选：与改造前一致（Windows PowerShell 5.1）
    pub const DEFAULT: ShellKind = ShellKind::PowerShell;

    /// 稳定 id（前端传参 / 界面 key；**不要**改成展示名 —— 那是界面的事）
    pub fn id(self) -> &'static str {
        match self {
            ShellKind::Cmd => "cmd",
            ShellKind::PowerShell => "powershell",
            ShellKind::Pwsh => "pwsh",
            ShellKind::GitBash => "gitbash",
        }
    }

    /// 由 id 解析（大小写不敏感；顺手接受几种常见别名，老版本 / 手写配置不会因为拼法失效）
    pub fn from_id(raw: &str) -> Option<Self> {
        let key = raw.trim().to_ascii_lowercase().replace(['_', ' '], "-");
        match key.as_str() {
            "cmd" | "cmd.exe" | "command-prompt" => Some(ShellKind::Cmd),
            "powershell" | "powershell.exe" | "windows-powershell" | "ps" => {
                Some(ShellKind::PowerShell)
            }
            "pwsh" | "pwsh.exe" | "powershell7" | "powershell-7" => Some(ShellKind::Pwsh),
            "gitbash" | "git-bash" | "bash" | "bash.exe" => Some(ShellKind::GitBash),
            _ => None,
        }
    }

    /// 可执行文件名（PATH 搜索 + 诊断文案用）
    pub fn exe(self) -> &'static str {
        match self {
            ShellKind::Cmd => "cmd.exe",
            ShellKind::PowerShell => "powershell.exe",
            ShellKind::Pwsh => "pwsh.exe",
            ShellKind::GitBash => "bash.exe",
        }
    }

    /// 启动参数。
    ///
    /// 一律**不带 `-NoProfile`**：终端是用户自己的环境，别名 / 函数 / prompt 都该生效
    ///（与「AI 执行命令」那边刻意带 `-NoProfile` 正好相反 —— 那边要的是可复现）。
    pub fn args(self) -> &'static [&'static str] {
        match self {
            ShellKind::Cmd => &[],
            ShellKind::PowerShell => &["-NoLogo"],
            ShellKind::Pwsh => &["-NoLogo"],
            // `-l` 读登录脚本（~/.bash_profile 里的 PATH 等），`-i` 交互：
            // Windows Terminal 的 Git Bash 配置就是 `-li`，prompt 与颜色才正常。
            ShellKind::GitBash => &["-li"],
        }
    }

    /// 这种 shell 的**已知安装位置**（按优先级；没命中再看 PATH）
    fn known_paths(self) -> Vec<PathBuf> {
        match self {
            ShellKind::Cmd => {
                let mut out = Vec::new();
                if let Some(comspec) = env_path("COMSPEC") {
                    out.push(comspec);
                }
                out.extend(system_path("System32/cmd.exe"));
                out
            }
            ShellKind::PowerShell => system_path("System32/WindowsPowerShell/v1.0/powershell.exe"),
            ShellKind::Pwsh => {
                let mut out = Vec::new();
                // 7 优先（当前主版本），6 是历史上的长期预览版，装了也能用
                out.extend(program_files_path("PowerShell/7/pwsh.exe"));
                out.extend(program_files_path("PowerShell/6/pwsh.exe"));
                // 商店版 / winget 版留下的「应用执行别名」（0 字节转发点，仍然可执行）
                out.extend(local_appdata_path("Microsoft/WindowsApps/pwsh.exe"));
                out
            }
            ShellKind::GitBash => {
                let mut out = Vec::new();
                // ① 常见安装目录
                out.extend(program_files_path("Git/bin/bash.exe"));
                out.extend(program_files_path("Git/usr/bin/bash.exe"));
                out.extend(program_files_x86_path("Git/bin/bash.exe"));
                out.extend(local_appdata_path("Programs/Git/bin/bash.exe"));
                // ② 由 PATH 上的 git.exe 反推：Git 通常只把 <git>\cmd 加进 PATH
                if let Some(bash) = git_sibling_bash() {
                    out.push(bash);
                }
                out
            }
        }
    }
}

/// 一次探测的结果。
pub struct ShellInfo {
    pub kind: ShellKind,
    /// 找到的可执行文件绝对路径（`None` = 这台机器上没装）
    pub command: Option<PathBuf>,
    /// 没找到时给用户 / 诊断看的说明（查过哪些地方）
    pub hint: Option<String>,
}

impl ShellInfo {
    pub fn available(&self) -> bool {
        self.command.is_some()
    }
}

/// 探测全部支持的 shell（顺序同 [`ShellKind::ALL`]）。
pub fn detect_all() -> Vec<ShellInfo> {
    ShellKind::ALL
        .into_iter()
        .map(|kind| {
            let found = find_executable(kind);
            let hint = if found.is_none() {
                Some(unavailable_hint(kind))
            } else {
                None
            };
            ShellInfo {
                kind,
                command: found,
                hint,
            }
        })
        .collect()
}

/// 解析一个 id（`None` = 没指定 → 首选；认不出的 id = 调用方的 bug，如实报错）。
pub fn parse(id: Option<&str>) -> Result<ShellKind, String> {
    let Some(raw) = id.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(preferred_kind());
    };
    ShellKind::from_id(raw).ok_or_else(|| {
        format!("不认识的终端类型：{raw}（可选：cmd / powershell / pwsh / gitbash）")
    })
}

/// 默认该开哪一种：首选（powershell）装了就用它，否则退到第一个装了的。
///
/// 不会返回「没装的那个」：`powershell.exe` 在 Windows 上必然存在，这条兜底只是为了
/// 万一被裁剪过的系统镜像（比如精简版 Server Core）也能开出一个终端。
pub fn preferred_kind() -> ShellKind {
    if find_executable(ShellKind::DEFAULT).is_some() {
        return ShellKind::DEFAULT;
    }
    ShellKind::ALL
        .into_iter()
        .find(|kind| find_executable(*kind).is_some())
        .unwrap_or(ShellKind::DEFAULT)
}

/// 解析成「可执行文件绝对路径 + 参数」。没装 → 给用户看的中文原因。
pub fn resolve(kind: ShellKind) -> Result<(PathBuf, Vec<String>), String> {
    let command = find_executable(kind).ok_or_else(|| unavailable_hint(kind))?;
    let args = kind.args().iter().map(|s| s.to_string()).collect();
    Ok((command, args))
}

// ==================== 探测实现 ====================

fn find_executable(kind: ShellKind) -> Option<PathBuf> {
    if !cfg!(target_os = "windows") {
        // 非 Windows 没有 ConPTY，这几种 shell 也都不存在 —— 不假装能用
        return None;
    }
    // 已知位置优先：避免 PATH 上的同名程序（比如 scoop / chocolatey 的同名 shim）
    // 抢先命中一个「其实不是你想的那个」版本
    if let Some(hit) = first_existing(kind.known_paths()) {
        return Some(hit);
    }
    let hit = search_path(kind.exe())?;
    // WSL 的 bash 不等于 Git Bash（见模块头），直接不认
    if kind == ShellKind::GitBash && is_wsl_bash(&hit) {
        return None;
    }
    Some(hit)
}

/// 按优先级取第一个存在的路径
fn first_existing(candidates: Vec<PathBuf>) -> Option<PathBuf> {
    candidates.into_iter().find(|p| exists(p))
}

/// `is_file` 对「应用执行别名」这类重解析点可能返回 false，用元数据兜一层
fn exists(path: &Path) -> bool {
    path.is_file() || path.symlink_metadata().is_ok()
}

/// 在 PATH 里找 `exe`（只认带扩展名的精确文件名，不查 PATHEXT —— 我们要的就是 .exe）
fn search_path(exe: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(exe))
        .find(|candidate| exists(candidate))
}

/// PATH 上的 `git.exe` 旁边的 bash：`<git>\cmd\git.exe` → `<git>\bin\bash.exe`
///（Git for Windows 默认只把 `<git>\cmd` 加进 PATH，`<git>\bin` 不在里面）
fn git_sibling_bash() -> Option<PathBuf> {
    let git = search_path("git.exe")?;
    // <git>\cmd\git.exe 或 <git>\bin\git.exe → <git>
    let root = git.parent()?.parent()?;
    [root.join("bin/bash.exe"), root.join("usr/bin/bash.exe")]
        .into_iter()
        .find(|candidate| exists(candidate))
}

/// `System32\bash.exe` / WindowsApps 里的 `bash.exe` 是 WSL 的入口，不是 Git Bash
fn is_wsl_bash(path: &Path) -> bool {
    let text = path.to_string_lossy().to_ascii_lowercase();
    text.contains("windowsapps") || text.ends_with("system32\\bash.exe") || text.ends_with("system32/bash.exe")
}

fn unavailable_hint(kind: ShellKind) -> String {
    if !cfg!(target_os = "windows") {
        return format!(
            "{} 只能在 Windows 上启动（交互终端依赖 ConPTY）。",
            kind.exe()
        );
    }
    let looked = kind
        .known_paths()
        .iter()
        .filter_map(|p| p.parent().map(|d| d.to_string_lossy().to_string()))
        .collect::<Vec<_>>();
    let mut hint = format!("没找到 {}（查过 PATH", kind.exe());
    if !looked.is_empty() {
        hint.push_str(" 与 ");
        hint.push_str(&looked.join("、"));
    }
    hint.push('）');
    match kind {
        ShellKind::GitBash => hint.push_str("。装 Git for Windows 之后重新打开终端的菜单。"),
        ShellKind::Pwsh => hint.push_str("。装 PowerShell 7 之后重新打开终端的菜单。"),
        _ => hint.push('。'),
    }
    hint
}

// ==================== 路径来源 ====================

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

fn system_path(relative: &str) -> Vec<PathBuf> {
    env_path("SystemRoot")
        .map(|root| vec![root.join(relative.replace('/', "\\"))])
        .unwrap_or_default()
}

fn program_files_path(relative: &str) -> Vec<PathBuf> {
    // ProgramW6432 是 32 位进程看 64 位 Program Files 的唯一办法
    ["ProgramFiles", "ProgramW6432"]
        .into_iter()
        .filter_map(env_path)
        .map(|root| root.join(relative.replace('/', "\\")))
        .collect()
}

fn program_files_x86_path(relative: &str) -> Vec<PathBuf> {
    env_path("ProgramFiles(x86)")
        .map(|root| vec![root.join(relative.replace('/', "\\"))])
        .unwrap_or_default()
}

fn local_appdata_path(relative: &str) -> Vec<PathBuf> {
    env_path("LOCALAPPDATA")
        .map(|root| vec![root.join(relative.replace('/', "\\"))])
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 四种类型可以互相转回自己：id 是界面与后端的契约，别名只是容错。
    #[test]
    fn kind_id_round_trips() {
        for kind in ShellKind::ALL {
            assert_eq!(ShellKind::from_id(kind.id()), Some(kind), "{kind:?}");
        }
        assert_eq!(ShellKind::from_id("Git-Bash"), Some(ShellKind::GitBash));
        assert_eq!(ShellKind::from_id(" git_bash "), Some(ShellKind::GitBash));
        assert_eq!(ShellKind::from_id("powershell7"), Some(ShellKind::Pwsh));
        assert_eq!(ShellKind::from_id("nonsense"), None);
    }

    /// id 解析：空 = 首选；认不出的 id 必须报错（而不是悄悄换成默认，掩盖前端传错）。
    #[test]
    fn parse_falls_back_only_when_unspecified() {
        assert_eq!(parse(None).unwrap(), preferred_kind());
        assert_eq!(parse(Some("   ")).unwrap(), preferred_kind());
        assert_eq!(parse(Some("gitbash")).unwrap(), ShellKind::GitBash);
        let err = parse(Some("zsh")).unwrap_err();
        assert!(err.contains("zsh"), "错误里要说清是哪个 id：{err}");
    }

    /// Windows 上 `cmd.exe` 与 Windows PowerShell 必然存在 —— 探测不能把它们判成没装。
    #[cfg(target_os = "windows")]
    #[test]
    fn windows_builtin_shells_are_detected() {
        for kind in [ShellKind::Cmd, ShellKind::PowerShell] {
            let (command, args) = resolve(kind).expect("系统自带 shell 必须能解析");
            assert!(command.is_absolute(), "{kind:?} 要给绝对路径：{command:?}");
            assert!(command.exists(), "{command:?} 应该真的存在");
            assert_eq!(args, kind.args());
        }
        // 首选就是 powershell（与改造前一致）
        assert_eq!(preferred_kind(), ShellKind::PowerShell);
    }

    /// 探测结果覆盖全部四种，且「可用 ⇔ 拿得到绝对路径」，没装的一定带说明。
    #[test]
    fn detect_all_covers_every_kind() {
        let all = detect_all();
        assert_eq!(all.len(), ShellKind::ALL.len());
        for info in &all {
            if info.available() {
                let command = info.command.as_ref().unwrap();
                assert!(command.is_absolute(), "{command:?} 要给绝对路径");
                assert!(info.hint.is_none(), "能用的不该带「未安装」说明");
            } else {
                let hint = info.hint.as_ref().expect("没装要给原因");
                assert!(hint.contains(info.kind.exe()), "说明里要写清找的是什么：{hint}");
            }
        }
    }

    /// Git Bash 只按 PATH 找是不够的：Git for Windows 只把 `<git>\cmd` 加进 PATH。
    /// 只要 `git.exe` 旁边真有 `bash.exe`（本机就是 `C:\config\Git` 这种定制安装），就必须认出来。
    #[test]
    fn git_bash_detection_matches_reality() {
        let info = detect_all()
            .into_iter()
            .find(|i| i.kind == ShellKind::GitBash)
            .expect("列表里必须有 gitbash");
        let found = info.command.clone();
        if let Some(found) = &found {
            assert!(found.ends_with("bash.exe"), "{found:?}");
            assert!(
                !is_wsl_bash(found),
                "不能把 WSL 的 bash 当成 Git Bash：{found:?}"
            );
        }
        if let Some(sibling) = git_sibling_bash() {
            assert!(found.is_some(), "git.exe 旁边有 bash.exe（{sibling:?}）却没认出来");
        }
    }

    /// 解析没装的 shell 必须给出中文原因（前端直接把这句话显示出来）。
    #[test]
    fn resolve_unavailable_shell_explains_why() {
        let missing = detect_all()
            .into_iter()
            .find(|i| !i.available())
            .map(|i| i.kind);
        let Some(kind) = missing else {
            return; // 这台机器四种都装了：没什么可断言的
        };
        let err = resolve(kind).unwrap_err();
        assert!(err.contains(kind.exe()), "{err}");
        assert!(err.contains("没找到") || err.contains("只能在 Windows"), "{err}");
    }
}
