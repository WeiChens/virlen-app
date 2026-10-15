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
use super::{CommitResult, WriteGate};

/// 提交已暂存的内容。**不做**「无暂存就自动全暂存」——那是界面的选择，不是引擎的。
pub fn commit(dir: &str, gate: &WriteGate, message: &str) -> Result<CommitResult, GitError> {
    gate.ensure()?;
    if message.trim().is_empty() {
        return Err(GitError::new("提交信息不能为空"));
    }

    // 提交与随后的回读一律在**仓库根**下跑（路径基准不变式，见 [`super::repo::root_of`]）
    let root = root_of(dir)?;
    let out = GitCmd::write(&root)
        .arg("commit")
        .arg("--file")
        .arg("-")
        .arg("--cleanup=whitespace")
        .stdin_bytes(message.as_bytes().to_vec())
        .run()?;

    // ⚠️ git 把提交摘要写在 **stdout**，hooks 的输出写在 **stderr**；两边都要留。
    let mut output = out.stdout_str();
    if !out.stderr.trim().is_empty() {
        if !output.is_empty() && !output.ends_with('\n') {
            output.push('\n');
        }
        output.push_str(&out.stderr);
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
    })
}
