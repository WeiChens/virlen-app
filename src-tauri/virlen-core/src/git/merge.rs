//! 合并（merge）：把某个分支并进当前 HEAD，以及查看 / 中止进行中的合并。
//!
//! 四条口径：
//! 1. **一律 `--no-edit`**：`git merge` 要为合并提交生成信息时会**打开编辑器**（`core.editor`，
//!    兜底是 vi），而这里没有终端能回答它 —— 不加就是界面一直等到写超时。
//! 2. **冲突不是「干干净净地失败」**：退出码 1 时工作区已经留下冲突标记，仓库进入「合并中」
//!    （`.git/MERGE_HEAD` 存在）。而且冲突清单在 **stdout**（`CONFLICT (content): ...`）：
//!    只回 stderr 等于把唯一有用的信息吞掉 —— 这里把两股输出合并后原样带走。
//! 3. **引用先校验再执行**：以 `-` 开头的直接拒（会被当成选项），再用
//!    `rev-parse --verify <ref>^{commit}` 确认它真的解析到一个提交（本地分支 / 远程分支 / tag 都行）。
//! 4. **「合并中」的唯一出路是 `merge --abort`**：界面上没有终端可用，中止必须是一条命令
//!    （`reset --merge` 的语义：冲突标记与合并带入的改动一起撤掉）。

use super::cli::{GitCmd, GitError, GitOutput};
use super::repo::root_of;
use super::status::snapshot_at_root;
use super::{MergeResult, StatusSnapshot, WriteGate};

/// 是否处于「合并中」（`.git/MERGE_HEAD` 存在）。读操作：不过写门禁、不加锁。
pub fn state(dir: &str) -> Result<bool, GitError> {
    merging_at(&root_of(dir)?)
}

fn merging_at(root: &str) -> Result<bool, GitError> {
    // `MERGE_HEAD` 只在「合并未完成」时存在；`--verify --quiet` 找不到时打印为空、退出码 1
    let out = GitCmd::read(root)
        .arg("rev-parse")
        .arg("--verify")
        .arg("--quiet")
        .arg("MERGE_HEAD")
        .run()?;
    Ok(out.ok())
}

/// 把 `reference` 合并进当前 HEAD。`no_ff` = `--no-ff`（即使能快进也生成合并提交）。
pub fn merge(
    dir: &str,
    gate: &WriteGate,
    reference: &str,
    no_ff: bool,
) -> Result<MergeResult, GitError> {
    gate.ensure()?;
    let root = root_of(dir)?;
    // ① 先解析成 oid：既做校验（不存在的分支名不该走到 git merge），也给「是否快进」留判据
    let target = resolve_at(&root, reference)?;
    // ② 上一次合并没结束就再合一次：git 会拒（`You have not concluded your merge`），
    //    但那句话太含糊 —— 这里直接说下一步（冲突这条路上用户最需要知道的两条出路）
    if merging_at(&root)? {
        return Err(GitError::new(
            "上一次合并还没有结束：先解决冲突并提交，或点击「中止合并」",
        ));
    }
    let before = snapshot_at_root(&root, None)?;

    let mut cmd = GitCmd::write(&root).arg("merge").arg("--no-edit");
    if no_ff {
        cmd = cmd.arg("--no-ff");
    }
    // 传**引用名**而不是 oid：合并提交的信息要用到它（`Merge branch 'feat'`）——
    // 换成 40 位 oid 之后那条信息就变成 `Merge commit '<oid>'`，人读不懂
    let out = cmd.arg(reference.trim()).run()?;
    let output = joined_output(&out);
    if !out.ok() {
        let conflicted =
            output.contains("CONFLICT") || output.contains("Automatic merge failed");
        let message = if conflicted {
            "合并产生冲突：解决冲突后提交，或中止这次合并"
        } else {
            "合并失败"
        };
        return Err(GitError {
            message: format!("{}（退出码 {}）", message, out.code),
            stderr: output,
            code: out.code,
        });
    }

    let after = snapshot_at_root(&root, None)?;
    Ok(MergeResult {
        up_to_date: before.head.oid == after.head.oid,
        fast_forward: before.head.oid != after.head.oid
            && after.head.oid.as_deref() == Some(target.as_str()),
        snapshot: after,
        output,
    })
}

/// 中止进行中的合并（`merge --abort`）：工作区回到合并之前。
pub fn abort(dir: &str, gate: &WriteGate) -> Result<StatusSnapshot, GitError> {
    gate.ensure()?;
    let root = root_of(dir)?;
    if !merging_at(&root)? {
        return Err(GitError::new("当前没有进行中的合并"));
    }
    GitCmd::write(&root)
        .arg("merge")
        .arg("--abort")
        .run()?
        .into_result("merge --abort")?;
    snapshot_at_root(&root, None)
}

/// 校验引用并解析成完整 oid（本地分支 / 远程分支 / tag / oid 都行，解析不到就拒）。
fn resolve_at(root: &str, reference: &str) -> Result<String, GitError> {
    let text = reference.trim();
    if text.is_empty() {
        return Err(GitError::new("没有指定要合并的分支"));
    }
    // 以 `-` 开头会被 git 当成选项（位置参数也一样）—— 必须在拼进 argv 之前拦住
    if text.starts_with('-') {
        return Err(GitError::new("分支名不能以 - 开头"));
    }
    let out = GitCmd::read(root)
        .arg("rev-parse")
        .arg("--verify")
        .arg("--quiet")
        .arg(format!("{}^{{commit}}", text))
        .run()?;
    let oid = out.stdout_str().trim().to_string();
    if !out.ok() || oid.is_empty() {
        return Err(GitError::new(format!("找不到要合并的分支：{}", text)));
    }
    Ok(oid)
}

/// stdout + stderr 合并（摘要 / 冲突清单在 stdout，警告在 stderr）。
fn joined_output(out: &GitOutput) -> String {
    let mut text = out.stdout_str();
    let stderr = out.stderr.trim_end();
    if !stderr.is_empty() {
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        text.push_str(stderr);
    }
    text.trim().to_string()
}
