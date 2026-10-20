//! 提交。
//!
//! 两条刻意的口径（方案 §5.5）：
//! - 提交信息走 **stdin**（`--file -`），不让它进 argv：argv 的编码 / 换行处理与平台相关；
//! - `--cleanup=whitespace`（不是 `strip`）：我们**不往信息里注入注释行**，而 `strip` 会把用户
//!   合法正文里以 `#` 开头的行悄悄吃掉 —— 静默改内容的事不能做。
//!
//! hooks 照常执行（不传 `--no-verify`），且输出必须带回给界面：pre-commit 可能改文件、
//! commit-msg 可能拒绝提交，用户得看得见原因。

use super::cli::{GitCmd, GitError};
use super::repo::root_of;
use super::status::snapshot_at_root;
use super::{CommitResult, ResetPreview, StatusSnapshot, WriteGate};

/// 提交已暂存的内容。**不做**「无暂存就自动全暂存」——那是界面的选择，不是引擎的。
pub fn commit(dir: &str, gate: &WriteGate, message: &str) -> Result<CommitResult, GitError> {
    commit_with(dir, gate, message, false)
}

/// 把暂存内容并入**上一条**提交（`git commit --amend`）。
///
/// 与 [`commit`] 共用一套 stdin / cleanup 口径：信息走 stdin、`--cleanup=whitespace`（理由见模块头）。
pub fn amend(dir: &str, gate: &WriteGate, message: &str) -> Result<CommitResult, GitError> {
    commit_with(dir, gate, message, true)
}

fn commit_with(
    dir: &str,
    gate: &WriteGate,
    message: &str,
    amend: bool,
) -> Result<CommitResult, GitError> {
    gate.ensure()?;
    if message.trim().is_empty() {
        return Err(GitError::new("提交信息不能为空"));
    }

    // 提交与随后的回读一律在**仓库根**下跑（路径基准不变式，见 [`super::repo::root_of`]）
    let root = root_of(dir)?;
    let mut cmd = GitCmd::write(&root)
        .arg("commit")
        .arg("--file")
        .arg("-")
        .arg("--cleanup=whitespace");
    if amend {
        cmd = cmd.arg("--amend");
    }
    let out = cmd.stdin_bytes(message.as_bytes().to_vec()).run()?;

    // ⚠️ git 把提交摘要写在 **stdout**，hooks 的输出写在 **stderr**；两边都要留，且**分开留**
    //    （界面只有在 stderr 非空时才展示输出块，否则每次提交都会贴一段「1 file changed」噪声）。
    let mut output = out.stdout_str();
    let stderr = out.stderr.clone();
    if !stderr.trim().is_empty() {
        if !output.is_empty() && !output.ends_with('\n') {
            output.push('\n');
        }
        output.push_str(&stderr);
    }
    if !out.ok() {
        return Err(GitError {
            message: "提交失败".into(),
            stderr: output,
            code: out.code,
        });
    }

    // 提交后的真实 oid / 标题以 git 为准（`--cleanup` 会改动信息首尾空白，别用入参回显）
    let oid = GitCmd::read(&root)
        .arg("rev-parse")
        .arg("HEAD")
        .run()
        .map(|o| o.stdout_str().trim().to_string())
        .unwrap_or_default();
    let summary = GitCmd::read(&root)
        .arg("log")
        .arg("-1")
        .arg("--pretty=%s")
        .run()
        .map(|o| o.stdout_str().trim().to_string())
        .unwrap_or_default();

    Ok(CommitResult {
        oid,
        summary,
        output,
        stderr,
    })
}

/// 撤销最后一次提交：**改动全部保留在暂存区**（`reset --soft`）。
///
/// 两条分支：
/// - 有父提交（含 merge：撤的是第一条父向的合并结果 —— `HEAD~1` 就是这个口径）→ `reset --soft HEAD~1`；
/// - root 提交（仓库只有一条提交）→ `HEAD~1` 不存在，改走 `update-ref -d HEAD`（删除分支引用，
///   index 与工作区**原样保留**）—— 否则界面上「第一个提交撤不掉」。
///
/// ⚠️ root 分支只对**符号引用**（在分支上）成立：游离 HEAD 时 HEAD 自己就是那个直接引用，
/// `update-ref -d HEAD` 会把 `.git/HEAD` 删掉、仓库直接不再是仓库 → 必须拒绝（见下）。
///
/// ⚠️ 不提供 `--hard`：那会真丢数据，与「丢弃」一样必须是一次显式、单独的确认。
pub fn undo_last(dir: &str, gate: &WriteGate) -> Result<StatusSnapshot, GitError> {
    gate.ensure()?;
    let root = root_of(dir)?;
    if !has_commit(&root, "HEAD") {
        return Err(GitError::new("还没有任何提交可撤销"));
    }
    if has_commit(&root, "HEAD~1") {
        GitCmd::write(&root)
            .arg("reset")
            .arg("--soft")
            .arg("HEAD~1")
            .run()?
            .into_result("reset --soft HEAD~1")?;
    } else {
        // ⚠️ fail-closed：`update-ref -d HEAD` 删的是 **HEAD 指向的那个 ref**。符号引用（在分支上）
        //    时删分支、仓库变 unborn，这是「撤销根提交」的预期语义；而游离 HEAD 时 HEAD 本身
        //    就是直接引用 → `.git/HEAD` 被删掉，`git status` 直接 `fatal: not a git repository`
        //    （实测）。没有可删的 ref 就不许动。
        let symbolic = GitCmd::read(&root)
            .arg("symbolic-ref")
            .arg("-q")
            .arg("HEAD")
            .run()?;
        if !symbolic.ok() {
            return Err(GitError::new(
                "当前是游离 HEAD（不在任何分支上）且只有一条提交：撤销会破坏仓库引用，请先切回一个分支",
            ));
        }
        GitCmd::write(&root)
            .arg("update-ref")
            .arg("-d")
            .arg("HEAD")
            .run()?
            .into_result("update-ref -d HEAD")?;
    }
    snapshot_at_root(&root, None)
}

/// `rev` 是否解析得到一个提交（unborn HEAD / root 的父 都是「否」）
fn has_commit(root: &str, rev: &str) -> bool {
    GitCmd::read(root)
        .arg("rev-parse")
        .arg("--verify")
        .arg("--quiet")
        .arg(rev)
        .run()
        .map(|o| o.ok())
        .unwrap_or(false)
}

// ==================== 重置到某笔提交（reset --soft） ====================

/// 「重置到这笔提交」的前置判定（读；不过写门禁）。
///
/// 两条判据都给界面：
/// - `ancestor`：目标在 HEAD 的祖先链上。为假时「退到这笔提交」不是字面意思 —— 那是把当前分支
///   挪到一段无关历史上（另一种动作，必须在终端里显式做）；
/// - `commits`：会从当前分支上撤掉的提交条数（`rev-list --count <oid>..HEAD`），确认文案要用
///   它说清「会少几条提交」。`0` = 已经在这笔上（重置是空转）。
pub fn reset_preview(dir: &str, oid: &str) -> Result<ResetPreview, GitError> {
    let root = root_of(dir)?;
    let target = super::resolve_commit(&root, oid)?
        .ok_or_else(|| GitError::new(format!("找不到要重置到的提交：{}", oid.trim())))?;
    preview_at(&root, &target)
}

fn preview_at(root: &str, target: &str) -> Result<ResetPreview, GitError> {
    // `merge-base --is-ancestor`：退出码 0 = 是祖先，1 = 不是（**正常结论，不是错误**）
    let ancestor = GitCmd::read(root)
        .arg("merge-base")
        .arg("--is-ancestor")
        .arg(target)
        .arg("HEAD")
        .run()?
        .ok();
    // 不是祖先时这个数没有意义（“撤掉几条”只对祖先链成立）—— 给 0，不猜
    let commits = if ancestor {
        GitCmd::read(root)
            .arg("rev-list")
            .arg("--count")
            .arg(format!("{}..HEAD", target))
            .run()
            .map(|o| o.stdout_str().trim().parse::<u32>().unwrap_or(0))
            .unwrap_or(0)
    } else {
        0
    };
    Ok(ResetPreview { ancestor, commits })
}

/// 把当前分支重置到某笔提交（`reset --soft`：**改动全部保留在暂存区**，不丢代码）。
///
/// ⚠️ 只接受 HEAD 祖先链上的提交，且不接受「已经在这笔上」—— 界面的预览判断（[`reset_preview`]）
/// **不构成准入**：预览与执行之间用户可以切分支、拉到新提交，两条在这里再判一次（fail-closed）。
///
/// ⚠️ 不提供 `--mixed` / `--hard`：前者让改动从暂存区掉回工作区（用户以为什么都没丢，其实状态变了），
/// 后者真丢数据 —— 丢数据的动作必须是另一个独立的、带自己确认的动作（与 [`undo_last`] 同一取舍）。
pub fn reset_soft(dir: &str, gate: &WriteGate, oid: &str) -> Result<StatusSnapshot, GitError> {
    gate.ensure()?;
    let root = root_of(dir)?;
    let target = super::resolve_commit(&root, oid)?
        .ok_or_else(|| GitError::new(format!("找不到要重置到的提交：{}", oid.trim())))?;
    super::pick::refuse_if_pending(&root)?;
    let preview = preview_at(&root, &target)?;
    if !preview.ancestor {
        return Err(GitError::new(
            "这笔提交不在当前分支的历史上：不能把当前分支重置到它",
        ));
    }
    if preview.commits == 0 {
        return Err(GitError::new("当前分支已经在这笔提交上，无需重置"));
    }
    GitCmd::write(&root)
        .arg("reset")
        .arg("--soft")
        .arg(&target)
        .run()?
        .into_result("reset --soft")?;
    snapshot_at_root(&root, None)
}
