//! 仓库探测与 git 版本 / 能力集（进程级缓存一次）。

use super::cli::{self, GitCmd, GitError};
use super::{GitCaps, RepoInfo};
use std::sync::OnceLock;

/// 探测 `dir` 是不是 git 仓库。
///
/// - `Ok(Some(_))` 是仓库；`Ok(None)` 不是仓库（**正常结果，不是错误**：界面上给空态）；
/// - `Err(_)` 只有「git 本身起不来 / 超时」这类硬故障 —— 由界面转成可读提示。
pub fn discover(dir: &str) -> Result<Option<RepoInfo>, GitError> {
    // 分两次调 `rev-parse`：bare 仓库上 `--show-toplevel` 会失败，混在一条里没法判断是
    // 「不是仓库」还是「是 bare 仓库」。
    let probe = GitCmd::read(dir)
        .arg("rev-parse")
        .arg("--absolute-git-dir")
        .arg("--is-bare-repository")
        .run()?;
    if !probe.ok() {
        // 128 = not a git repository；退出码不同也不猜原因，一律按「不是仓库」处理
        return Ok(None);
    }

    let text = probe.stdout_str();
    let mut lines = text.lines();
    let git_dir = match lines.next() {
        Some(v) if !v.trim().is_empty() => normalize(v.trim()),
        _ => return Ok(None),
    };
    let bare = lines.next().map(|v| v.trim() == "true").unwrap_or(false);

    let root = if bare {
        git_dir.clone()
    } else {
        match GitCmd::read(dir).arg("rev-parse").arg("--show-toplevel").run() {
            Ok(out) if out.ok() && !out.stdout_str().trim().is_empty() => {
                normalize(out.stdout_str().trim())
            }
            // 拿不到工作区根（罕见的 worktree / 权限问题）→ 退回 git 目录，别让整个功能哑掉
            _ => git_dir.clone(),
        }
    };

    let version = version_string();
    Ok(Some(RepoInfo {
        root,
        git_dir,
        bare,
        caps: caps_for(&version),
        version,
    }))
}

/// 把「工作目录」解析成**仓库根** —— 每条按路径操作的 git 命令都以它作为 cwd。
///
/// ⚠️ 这是本模块最重要的一条路径不变式（踩过的坑见 `docs/agents/14-git-management.md` §11.53 ⑫）：
/// `status`（带 `-z`）给出的路径是**仓库根相对**的，而 `git add` / `git restore` 按 **cwd** 解释
/// 收到的路径。两者一旦不一致（工作目录是仓库子目录、写操作又没切到根），界面上的路径就会与 git
/// 的解析对不上，报出 `warning: could not open directory ...` + `fatal: pathspec '...' did not
/// match any files`（退出码 128）。
///
/// 因此全模块统一：**cwd = 仓库根，路径 = 仓库根相对**；公开接口一律接受「仓库内的任意目录」。
///
/// 不做缓存：多一次 `rev-parse`（十几毫秒）换掉「目录被移动 / 换了仓库之后仍用旧根」的一类错误。
pub fn root_of(dir: &str) -> Result<String, GitError> {
    let top = GitCmd::read(dir).arg("rev-parse").arg("--show-toplevel").run()?;
    let text = top.stdout_str();
    if top.ok() && !text.trim().is_empty() {
        return Ok(normalize(text.trim()));
    }
    // bare 仓库没有工作区（`--show-toplevel` 失败）→ 退回 git 目录；再拿不到才算「不是仓库」
    let git_dir = GitCmd::read(dir).arg("rev-parse").arg("--absolute-git-dir").run()?;
    let text = git_dir.stdout_str();
    if git_dir.ok() && !text.trim().is_empty() {
        return Ok(normalize(text.trim()));
    }
    Err(GitError::new(format!("不是 Git 仓库：{}", dir)))
}

/// `git --version`（进程级缓存：一次进程生命周期里只问一次）。
///
/// 输出形如 `git version 2.55.0.windows.5`；拿不到时回退空串 → 能力集全 false（走降级分支）。
pub fn version_string() -> String {
    static VERSION: OnceLock<String> = OnceLock::new();
    VERSION
        .get_or_init(|| {
            match cli::run_bare(&["--version"], cli::READ_TIMEOUT) {
                Ok(out) if out.ok() => {
                    let text = out.stdout_str();
                    text.trim()
                        .strip_prefix("git version ")
                        .unwrap_or(text.trim())
                        .trim()
                        .to_string()
                }
                _ => String::new(),
            }
        })
        .clone()
}

/// 版本号 → 能力集。解析失败一律 false（**fail-closed**：宁可按旧版降级，也不要用了不存在的开关）。
pub fn caps_for(version: &str) -> GitCaps {
    let nums = parse_version(version);
    let at_least = |major: u32, minor: u32| match nums {
        Some((ma, mi, _)) => (ma, mi) >= (major, minor),
        None => false,
    };
    GitCaps {
        porcelain_v2: at_least(2, 11),
        switch: at_least(2, 23),
        restore: at_least(2, 23),
    }
}

/// 取版本号前三段数字（`2.55.0.windows.5` → `(2, 55, 0)`；只有两段也认）
fn parse_version(version: &str) -> Option<(u32, u32, u32)> {
    let mut it = version.split('.');
    let major = it.next()?.trim().parse::<u32>().ok()?;
    let minor = it.next()?.trim().parse::<u32>().ok()?;
    let patch = it
        .next()
        .and_then(|v| {
            let digits: String = v.chars().take_while(|c| c.is_ascii_digit()).collect();
            digits.parse::<u32>().ok()
        })
        .unwrap_or(0);
    Some((major, minor, patch))
}

/// git 在 Windows 上输出反斜杠路径，前端一律用正斜杠（与项目其余部分口径一致）
fn normalize(p: &str) -> String {
    p.replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_parsing_handles_git_build_suffixes() {
        assert_eq!(parse_version("2.55.0.windows.5"), Some((2, 55, 0)));
        assert_eq!(parse_version("2.43.0"), Some((2, 43, 0)));
        assert_eq!(parse_version("2.23"), Some((2, 23, 0)));
        assert_eq!(parse_version(""), None);
        assert_eq!(parse_version("nonsense"), None);
    }

    #[test]
    fn caps_follow_version_thresholds() {
        let old = caps_for("2.10.0");
        assert!(!old.porcelain_v2 && !old.switch && !old.restore);
        let mid = caps_for("2.20.1");
        assert!(mid.porcelain_v2 && !mid.switch && !mid.restore);
        let modern = caps_for("2.55.0.windows.5");
        assert!(modern.porcelain_v2 && modern.switch && modern.restore);
        // 空版本（git 不存在 / 输出异常）→ 全 false，走降级
        let unknown = caps_for("");
        assert!(!unknown.porcelain_v2 && !unknown.switch && !unknown.restore);
    }
}
