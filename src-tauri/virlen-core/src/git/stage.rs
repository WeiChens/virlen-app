//! 暂存 / 取消暂存 / 丢弃。
//!
//! ⚠️ 两条与「丢数据」直接相关的口径（方案 §5.4 / §6）：
//! 1. **未跟踪文件的「丢弃」不走 `git clean`** —— 那是硬删、进不了回收站。这里走 `trash`（可恢复）；
//! 2. **已跟踪文件的改动丢弃不可恢复**（git 语义本身如此）→ 二次确认在界面层，本模块只管执行。

use super::cli::{GitCmd, GitError};
use super::repo::root_of;
use super::status::snapshot_at_root;
use super::{EntryKind, StatusSnapshot, WriteGate};
use std::collections::HashSet;

/// 暂存（含未跟踪文件；`-A` 口径与 VS Code 的「Stage All」一致由调用方只传全部路径实现）
pub fn stage(dir: &str, gate: &WriteGate, paths: &[String]) -> Result<StatusSnapshot, GitError> {
    gate.ensure()?;
    if paths.is_empty() {
        return Err(GitError::new("未选择要暂存的文件"));
    }
    // ⚠️ cwd 一律切到**仓库根**：`paths` 来自 status（**仓库根相对**），而 `git add` 按 **cwd**
    //    解释路径 —— 工作目录是仓库子目录时直接用 `dir` 会得到 128 `pathspec ... did not match`。
    let root = root_of(dir)?;
    GitCmd::write(&root)
        .arg("add")
        .paths(paths.iter().cloned())
        .run()?
        .into_result("add")?;
    snapshot_at_root(&root, None)
}

/// 取消暂存（回到未暂存）
pub fn unstage(dir: &str, gate: &WriteGate, paths: &[String]) -> Result<StatusSnapshot, GitError> {
    gate.ensure()?;
    if paths.is_empty() {
        return Err(GitError::new("未选择要取消暂存的文件"));
    }
    let root = root_of(dir)?;
    if has_head(&root) {
        GitCmd::write(&root)
            .arg("restore")
            .arg("--staged")
            .paths(paths.iter().cloned())
            .run()?
            .into_result("restore --staged")?;
    } else {
        // ⚠️ 首次提交前（unborn HEAD）没有 HEAD 可回退，`restore --staged` 会直接失败 ——
        //    这个组合是空仓库里最常见的第一个操作，必须走 `rm --cached`。
        //    `-f` 只影响「索引里那份内容与工作区不同」时的拒绝（配合 `--cached` 不会碰工作区文件），
        //    `--ignore-unmatch` 让已不在索引里的路径不至于整体失败。
        GitCmd::write(&root)
            .arg("rm")
            .arg("--cached")
            .arg("-r")
            .arg("-f")
            .arg("--ignore-unmatch")
            .paths(paths.iter().cloned())
            .run()?
            .into_result("rm --cached")?;
    }
    snapshot_at_root(&root, None)
}

/// 丢弃改动。
///
/// **按类别分流**（这是本模块唯一的「聪明」之处，也是唯一会丢数据的路径）：
/// - 已跟踪 → `git restore`（改动不可恢复，界面必须先确认）
/// - 未跟踪 → `trash`（回收站，可恢复）
pub fn discard(dir: &str, gate: &WriteGate, paths: &[String]) -> Result<StatusSnapshot, GitError> {
    gate.ensure()?;
    if paths.is_empty() {
        return Err(GitError::new("未选择要丢弃的文件"));
    }
    let root = root_of(dir)?;
    let snapshot = snapshot_at_root(&root, None)?;
    // ⚠️ 判定必须用**当前快照**，不接受调用方传入的类别：前端传的类别可能已经过期
    //（用户在编辑器里 `git add` 过一嘴），照它执行就会把「已跟踪」当「未跟踪」硬删。
    let untracked: HashSet<&str> = snapshot
        .entries
        .iter()
        .filter(|e| e.kind == EntryKind::Untracked)
        .map(|e| e.path.as_str())
        .collect();

    let (trash_paths, restore_paths): (Vec<&String>, Vec<&String>) =
        paths.iter().partition(|p| untracked.contains(p.as_str()));

    if !restore_paths.is_empty() {
        GitCmd::write(&root)
            .arg("restore")
            .paths(restore_paths.iter().map(|p| (*p).clone()))
            .run()?
            .into_result("restore")?;
    }
    for p in trash_paths {
        // `paths` 是仓库根相对 → 拼回磁盘路径必须用**仓库根**（不是工作目录）
        let full = std::path::Path::new(&root).join(p);
        // 回收站失败（无桌面环境 / 权限）不该让整批操作半途而废：逐条报告，继续处理其余
        if let Err(e) = trash::delete(&full) {
            eprintln!("[git] 移入回收站失败 {}: {}", full.display(), e);
        }
    }
    snapshot_at_root(&root, None)
}

/// 仓库是否已有提交（`(initial)` 时没有）。失败一律按「没有 HEAD」处理 —— 那会走更保守的分支。
fn has_head(dir: &str) -> bool {
    GitCmd::read(dir)
        .arg("rev-parse")
        .arg("--verify")
        .arg("--quiet")
        .arg("HEAD")
        .run()
        .map(|out| out.ok())
        .unwrap_or(false)
}
