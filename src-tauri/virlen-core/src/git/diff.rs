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
/// - `scope = Worktree`（未暂存）：旧 = index（`:<path>`），新 = 工作区文件
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
    let (old_rev, new_rev): (Option<String>, Option<String>) = match scope {
        super::DiffScope::Worktree => (Some(format!(":{}", old_path)), None),
        super::DiffScope::Index => (
            Some(format!("HEAD:{}", old_path)),
            Some(format!(":{}", path)),
        ),
    };

    let old_bytes = match old_rev {
        Some(rev) => blob_bytes(&root, &rev, cancel)?,
        None => None,
    };
    let new_bytes = match new_rev {
        Some(rev) => blob_bytes(&root, &rev, cancel)?,
        None => read_worktree(&root, path)?,
    };

    let binary = is_binary(&old_bytes) || is_binary(&new_bytes);
    let (old_text, mut truncated) = to_text(old_bytes, binary);
    let (new_text, new_truncated) = to_text(new_bytes, binary);
    truncated |= new_truncated;

    let (old_label, new_label) = match scope {
        super::DiffScope::Worktree => ("INDEX".to_string(), "工作区".to_string()),
        super::DiffScope::Index => ("HEAD".to_string(), "INDEX".to_string()),
    };

    Ok(DiffSides {
        old_text,
        new_text,
        old_label,
        new_label,
        binary,
        truncated,
    })
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
