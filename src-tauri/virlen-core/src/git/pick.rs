//! 挑选（cherry-pick）与还原（revert）——「把别处的提交搬到当前分支」与「把某笔提交的改动反向撤销」。
//!
//! 四条口径：
//! 1. **`revert` 必须 `--no-edit`**：它默认要打开编辑器让用户改还原信息（`core.editor`，兜底 vi），
//!    而这里没有终端能回答它 —— 不加就是界面一直等到写超时。`cherry-pick` 默认复用原提交信息、
//!    不开编辑器，所以不加（**不要**为了对称给它加 `--no-edit`：对称不是理由，行为才是）。
//! 2. **冲突不是「干干净净地失败」**：退出码 1 时工作区已经留下冲突标记，仓库进入「挑选中 / 还原中」
//!    （`.git/CHERRY_PICK_HEAD` / `.git/REVERT_HEAD`），而且冲突清单在 **stdout** —— 只回 stderr
//!    等于把唯一有用的信息吞掉，所以两股输出合并后原样带走。
//! 3. **未了结就拒绝**：合并 / 挑选 / 还原三种状态都占着 index 与 HEAD，硬叠上去只会得到一句难懂的
//!    git 报错（见 [`refuse_if_pending`]）。
//! 4. **一次只处理一条提交**：多提交区间（`A..B`）会启动 sequencer，需要 continue / skip 一整套
//!    状态机，而界面上没有终端可用 —— 那是另一件事，这里不装作支持。
//!
//! ⚠️ 冲突后的两条出路都必须给：[`abort`]（回到动作之前）与 [`resume`]（冲突已解决并暂存）。
//! 只给 abort，用户辛苦解完的冲突要丢掉重来；只给 resume，冲突解不动的用户无路可走。

use super::cli::{GitCmd, GitError};
use super::repo::root_of;
use super::status::snapshot_at_root;
use super::{PickKind, PickResult, PickState, StatusSnapshot, WriteGate};

impl PickKind {
    /// git 的子命令名（`cherry-pick` / `revert`）
    fn sub(self) -> &'static str {
        match self {
            PickKind::CherryPick => "cherry-pick",
            PickKind::Revert => "revert",
        }
    }

    /// 进行中的标记文件：存在就代表这个动作没结束
    fn head_file(self) -> &'static str {
        match self {
            PickKind::CherryPick => "CHERRY_PICK_HEAD",
            PickKind::Revert => "REVERT_HEAD",
        }
    }

    /// 面向用户的名词。文案里说「挑选 / 还原」而不是英文子命令 —— 界面全是中文
    fn verb(self) -> &'static str {
        match self {
            PickKind::CherryPick => "挑选",
            PickKind::Revert => "还原",
        }
    }
}

/// 是否有未了结的挑选 / 还原（读操作：不过写门禁、不加锁）
pub fn state(dir: &str) -> Result<Option<PickState>, GitError> {
    state_at(&root_of(dir)?)
}

fn state_at(root: &str) -> Result<Option<PickState>, GitError> {
    for kind in [PickKind::CherryPick, PickKind::Revert] {
        // `--verify --quiet` 在标记文件不存在时打印为空、退出码 1（与 `merge::state` 同一判据）
        let out = GitCmd::read(root)
            .arg("rev-parse")
            .arg("--verify")
            .arg("--quiet")
            .arg(kind.head_file())
            .run()?;
        if out.ok() {
            let oid = out.stdout_str().trim().to_string();
            return Ok(Some(PickState {
                kind,
                oid: if oid.is_empty() { None } else { Some(oid) },
            }));
        }
    }
    Ok(None)
}

/// 动手前的统一前置检查：合并 / 挑选 / 还原任一未了结就拒（文案直接说下一步）。
pub(crate) fn refuse_if_pending(root: &str) -> Result<(), GitError> {
    if let Some(state) = state_at(root)? {
        return Err(GitError::new(format!(
            "上一次{}还没有结束：先解决冲突并继续，或中止它",
            state.kind.verb()
        )));
    }
    if super::merge::state(root)? {
        return Err(GitError::new(
            "上一次合并还没有结束：先解决冲突并提交，或中止这次合并",
        ));
    }
    Ok(())
}

/// 终点状态检查：要中止 / 继续的那个动作必须**正是**进行中的那个。
///
/// 不做这一步，`revert --abort` 会在一次 cherry-pick 进行中被 git 拒绝，报出一句
/// `no cherry-pick or revert in progress` 之类的话 —— 用户看不出自己点错了哪个。
fn ensure_in_progress(root: &str, kind: PickKind) -> Result<(), GitError> {
    match state_at(root)? {
        Some(s) if s.kind == kind => Ok(()),
        Some(s) => Err(GitError::new(format!(
            "当前进行中的是{}，不是{}",
            s.kind.verb(),
            kind.verb()
        ))),
        None => Err(GitError::new(format!("当前没有进行中的{}", kind.verb()))),
    }
}

/// 把某笔提交搬到当前分支（cherry-pick）／把它的改动反向撤销（revert）。
pub fn pick(
    dir: &str,
    gate: &WriteGate,
    kind: PickKind,
    oid: &str,
) -> Result<PickResult, GitError> {
    gate.ensure()?;
    let root = root_of(dir)?;
    let target = super::resolve_commit(&root, oid)?
        .ok_or_else(|| GitError::new(format!("找不到要{}的提交：{}", kind.verb(), oid.trim())))?;
    refuse_if_pending(&root)?;

    let mut cmd = GitCmd::write(&root).arg(kind.sub());
    if kind == PickKind::Revert {
        cmd = cmd.arg("--no-edit");
    }
    // 传**完整 oid**而不是短 oid / 引用名：目标就是被点的那一行，不留任何重解析的余地
    let out = cmd.arg(&target).run()?;
    let output = out.joined_text();
    if !out.ok() {
        let conflicted = output.contains("CONFLICT")
            || output.contains("could not apply")
            || output.contains("After resolving the conflicts");
        let message = if conflicted {
            format!(
                "{}这条提交时发生冲突：解决冲突后暂存并继续，或中止这次{}",
                kind.verb(),
                kind.verb()
            )
        } else {
            format!("git {} 失败（退出码 {}）", kind.sub(), out.code)
        };
        return Err(GitError {
            message,
            stderr: output,
            code: out.code,
        });
    }

    let after = snapshot_at_root(&root, None)?;
    Ok(PickResult {
        // 成功时 HEAD 一定在（revert / cherry-pick 都会生成提交）；取不到就回空串，不 panic
        oid: after.head.oid.clone().unwrap_or_default(),
        snapshot: after,
        output,
    })
}

/// 中止进行中的挑选 / 还原（回到动作之前）。
pub fn abort(dir: &str, gate: &WriteGate, kind: PickKind) -> Result<StatusSnapshot, GitError> {
    gate.ensure()?;
    let root = root_of(dir)?;
    ensure_in_progress(&root, kind)?;
    GitCmd::write(&root)
        .arg(kind.sub())
        .arg("--abort")
        .run()?
        .into_result(&format!("{} --abort", kind.sub()))?;
    snapshot_at_root(&root, None)
}

/// 继续进行中的挑选 / 还原（前提：冲突已解决并**暂存**，否则 git 会拒）。
///
/// ⚠️ `--continue` 内部会跑 `git commit`，而 `git commit` 默认打开编辑器；`--no-edit` 对
/// `--continue` 不适用 —— 唯一可靠的办法是把编辑器换成 true（退出 0、内容原样）。
pub fn resume(dir: &str, gate: &WriteGate, kind: PickKind) -> Result<StatusSnapshot, GitError> {
    gate.ensure()?;
    let root = root_of(dir)?;
    ensure_in_progress(&root, kind)?;
    let out = GitCmd::write(&root)
        .arg(kind.sub())
        .arg("--continue")
        .env("GIT_EDITOR", "true")
        .run()?;
    if !out.ok() {
        return Err(GitError {
            message: format!(
                "{}失败（退出码 {}）：冲突要全部解决并暂存后才能继续",
                kind.sub(),
                out.code
            ),
            stderr: out.joined_text(),
            code: out.code,
        });
    }
    snapshot_at_root(&root, None)
}
