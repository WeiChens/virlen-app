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
use super::{CommitResult, StatusSnapshot, WriteGate};

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
