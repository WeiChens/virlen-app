//! 差异的两侧内容 —— **不解析 patch 文本**，而是取「旧 / 新」两份内容交给前端已有的 diff 内核。
//!
//! 为什么这么做：本项目「左右对比」的唯一实现是 `src/utils/diff.ts::buildDiffRows`（jsdiff 的
//! `diffLines` + 组内 `diffChars`）+ `SideBySideDiff`（`edit_file` 在用，见方案 §2.3）。
//! 再写一个 patch 解析器 = 第二份 diff 实现，显示口径迟早与 `edit_file` 分叉。
//!
//! 代价（**已接受，见方案 §5.3 / §11.3**）：拿到的是文件原始字节，没走 `.gitattributes` 的
//! filter / textconv —— LFS 指针文件会显示成指针文本。
//!
//! ⚠️ **两侧一律归一化换行为 LF**（[`crate::file_ops::normalize_content`]，与 `edit_file` 的匹配口径同一份）：
//! 旧侧来自 git 对象库（`core.autocrlf=true` / `text` 属性下已经是 LF），新侧是工作区磁盘原文
//! （Windows 上通常是 CRLF）—— 不归一化就是「两侧每一行都不同」，界面上表现为「整个文件全变 /
//! diff 没起作用」，而 `git add` 之后（两侧都来自对象库）又突然正常了。

use super::cli::{GitCmd, GitError};
use super::DiffSides;
use crate::file_ops::normalize_content;
use std::path::Path;

/// 单侧内容上限：超过即截断并置 `truncated`（界面必须如实提示，不许假装完整）。
pub const MAX_SIDE_CHARS: usize = 512 * 1024;

/// 二进制嗅探字节数 —— 与 git 自己的 `buffer_is_binary` 同口径（前 8000 字节里找 NUL）。
const BINARY_SNIFF_BYTES: usize = 8000;

/// 取一条路径在某个对比基准下的两侧内容。
///
/// - `dir`：**工作目录**（可以是仓库的任意子目录）—— 内部统一到仓库根；
/// - `scope = Worktree`（未暂存）：旧 = index（`:<path>`），新 = 工作区文件；
///   ⚠️ 该路径若处于**冲突（未合并）**状态，改取 stage 2（ours）/ stage 3（theirs）—— 见 [`is_unmerged`]；
/// - `scope = Index`（已暂存）：旧 = `HEAD:<path>`，新 = index
pub fn sides(
    dir: &str,
    path: &str,
    scope: super::DiffScope,
    orig_path: Option<&str>,
) -> Result<DiffSides, GitError> {
    sides_with_cancel(dir, path, scope, orig_path, None)
}

/// 同上，但接受取消标志（单侧内容上限 512KB，正常很快；大仓库的 blob 解压仍需可中断）
pub fn sides_with_cancel(
    dir: &str,
    path: &str,
    scope: super::DiffScope,
    orig_path: Option<&str>,
    cancel: Option<&std::sync::Arc<std::sync::atomic::AtomicBool>>,
) -> Result<DiffSides, GitError> {
    // ⚠️ 一律切到仓库根再跑：`<rev>:<path>` 取的是**仓库根相对**路径，写成 `:./<path>` 会变成
    //    cwd 相对 —— 工作目录是子目录时直接 `fatal: ambiguous argument ... unknown revision`。
    let root = super::repo::root_of(dir)?;
    // rename：旧侧要去旧路径取（否则会显示成「整文件新增 + 整文件删除」）
    let old_path = orig_path.unwrap_or(path);
    // ⚠️ 冲突路径在 index 里**没有 stage 0**，`:<path>` 会直接 128（`path 'x' is in the index,
    //    but not at stage 0`），而 [`blob_bytes`] 把非 0 退出码当成「这一侧没有内容」—— 于是弹窗
    //    里整份文件（连 `<<<<<<<` 冲突标记一起）被显示成「全新增」。要看的是两侧各自的内容：
    //    stage 2 = ours（当前分支）、stage 3 = theirs（合入的那边）；某侧不存在（删除 / 新增）→ 空栏。
    let unmerged = matches!(scope, super::DiffScope::Worktree)
        && is_unmerged(&root, path, cancel)?;
    let (old_rev, new_rev): (Option<String>, Option<String>) = if unmerged {
        (
            Some(format!(":2:{}", old_path)),
            Some(format!(":3:{}", path)),
        )
    } else {
        match scope {
            super::DiffScope::Worktree => (Some(format!(":{}", old_path)), None),
            super::DiffScope::Index => (
                Some(format!("HEAD:{}", old_path)),
                Some(format!(":{}", path)),
            ),
        }
    };

    let old_bytes = match old_rev {
        Some(rev) => blob_bytes(&root, &rev, cancel)?,
        None => None,
    };
    let new_bytes = match new_rev {
        Some(rev) => blob_bytes(&root, &rev, cancel)?,
        None => read_worktree(&root, path)?,
    };

    let (old_label, new_label) = if unmerged {
        ("ours（当前分支）", "theirs（合入的）")
    } else {
        match scope {
            super::DiffScope::Worktree => ("INDEX", "工作区"),
            super::DiffScope::Index => ("HEAD", "INDEX"),
        }
    };
    Ok(assemble(old_bytes, new_bytes, old_label, new_label))
}

/// 两个任意 rev（`<rev>:<path>` 形态）之间的两侧内容 —— **提交详情**用它（旧 = `<oid>^`、新 = `<oid>`）。
///
/// 取不到的那一侧照例是 `None`（空侧）：root 提交没有 `<oid>^`、删除的文件在 `<oid>` 下不存在。
pub fn sides_of_revs(
    root: &str,
    old_rev: &str,
    new_rev: &str,
    old_label: &str,
    new_label: &str,
    cancel: Option<&std::sync::Arc<std::sync::atomic::AtomicBool>>,
) -> Result<DiffSides, GitError> {
    let old_bytes = blob_bytes(root, old_rev, cancel)?;
    let new_bytes = blob_bytes(root, new_rev, cancel)?;
    Ok(assemble(old_bytes, new_bytes, old_label, new_label))
}

/// 两侧原始字节 → [`DiffSides`]（二进制嗅探 / 截断 / LF 归一化的**唯一出口**：
/// 「工作区差异」与「提交间差异」必须同一套口径，分开写两份迟早会分叉）。
fn assemble(
    old_bytes: Option<Vec<u8>>,
    new_bytes: Option<Vec<u8>>,
    old_label: &str,
    new_label: &str,
) -> DiffSides {
    let binary = is_binary(&old_bytes) || is_binary(&new_bytes);
    let (old_text, mut truncated) = to_text(old_bytes, binary);
    let (new_text, new_truncated) = to_text(new_bytes, binary);
    truncated |= new_truncated;
    DiffSides {
        old_text,
        new_text,
        old_label: old_label.to_string(),
        new_label: new_label.to_string(),
        binary,
        truncated,
    }
}

/// 这条路径是否处于**冲突（未合并）**状态 —— `ls-files -u` 只列 stage 1/2/3，有输出即未合并。
///
/// 用一次显式探测而不是「取不到 `:path` 就猜是未合并」：后者与「新增 / 未跟踪」不可区分
/// （两者都取不到 stage 0），猜错就会把新文件的差异也当成冲突的两栏。
fn is_unmerged(
    repo_root: &str,
    path: &str,
    cancel: Option<&std::sync::Arc<std::sync::atomic::AtomicBool>>,
) -> Result<bool, GitError> {
    let out = GitCmd::read(repo_root)
        .arg("ls-files")
        .arg("-u")
        .arg("-z")
        .paths([path])
        .cancel_opt(cancel)
        .run()?;
    Ok(out.ok() && !out.stdout.is_empty())
}

/// `git show <rev>` 取 blob。**这不是错误**的两种情况（返回 `None`）：
/// - 该 rev 下没有这条路径（新增 / 未跟踪）
/// - 仓库还没有 HEAD（`(initial)`）
fn blob_bytes(
    repo_root: &str,
    rev: &str,
    cancel: Option<&std::sync::Arc<std::sync::atomic::AtomicBool>>,
) -> Result<Option<Vec<u8>>, GitError> {
    let cmd = GitCmd::read(repo_root)
        .arg("show")
        .arg(rev)
        // 二进制内容原样输出（否则 git 会做文本转换，拿到的不是真字节）
        .arg("--no-textconv")
        .cancel_opt(cancel);
    let out = cmd.run()?;
    if out.ok() {
        Ok(Some(out.stdout))
    } else {
        Ok(None)
    }
}

/// 读工作区文件；不存在（已删除）→ `None`
fn read_worktree(repo_root: &str, path: &str) -> Result<Option<Vec<u8>>, GitError> {
    let full = Path::new(repo_root).join(path);
    match std::fs::read(&full) {
        Ok(v) => Ok(Some(v)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(GitError::new(format!(
            "读取工作区文件失败 {}: {}",
            full.display(),
            e
        ))),
    }
}

/// 前 8000 字节里是否有 NUL（git 的 `buffer_is_binary` 口径）
fn is_binary(bytes: &Option<Vec<u8>>) -> bool {
    match bytes {
        Some(b) => {
            let head = &b[..b.len().min(BINARY_SNIFF_BYTES)];
            head.contains(&0)
        }
        None => false,
    }
}

/// 字节 → 文本（二进制则直接不拉正文；超限则截断到 char 边界；**换行一并归一化成 LF**）
fn to_text(bytes: Option<Vec<u8>>, binary: bool) -> (Option<String>, bool) {
    let Some(raw) = bytes else {
        return (None, false);
    };
    if binary {
        return (None, false);
    }
    let mut truncated = false;
    let slice: &[u8] = if raw.len() > MAX_SIDE_CHARS {
        truncated = true;
        // 截断点必须落在字符边界上，否则 lossy 解码会在末尾吐一个假替换字符
        let mut end = MAX_SIDE_CHARS;
        while end > 0 && (raw[end] & 0xC0) == 0x80 {
            end -= 1;
        }
        &raw[..end]
    } else {
        &raw
    };
    // ⚠️ 旧侧（git 对象）与新侧（工作区磁盘）的换行格式天然不同（见文件头），**必须同口径**：
    //    否则 LCS 会认为每一行都变了，整个文件变成一片红绿（实测反馈的「diff 没起作用」）。
    let text = normalize_content(&String::from_utf8_lossy(slice));
    (Some(text), truncated)
}
