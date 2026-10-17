//! 逐文件行数统计（`git diff --numstat -z`）—— 界面上「+12 −3」与顶部合计的来源。
//!
//! 三个口径：
//! - **两侧分开统计**：已暂存 = INDEX ↔ HEAD，未暂存 = 工作区 ↔ INDEX（与 [`super::DiffScope`] 同义），
//!   界面按行所属的段取对应那一份；同一个文件两段都有改动就两行各算各的；
//! - **未跟踪不在 diff 里**：`git diff` 只比已跟踪的内容，所以未跟踪文件由本模块按行数直接数文件
//!   （上限见 [`MAX_UNTRACKED_BYTES`] / [`MAX_UNTRACKED_FILES`]，超了给 `None` —— 界面显示「—」，
//!   绝不假装 0）；
//! - **二进制给 `None`**：`--numstat` 对二进制输出 `-`，本模块原样保留成 `None`（不是 0 行）。
//!
//! ⚠️ 解析是纯函数 [`parse_numstat`]：`-z` 下 rename / copy 的记录是「三列 + NUL + 旧路径 + NUL +
//! 新路径」，按行切或过滤空段都会把它读错（只会在改过名的文件上静默出错）。

use super::cli::{GitCmd, GitError};
use super::{FileStat, StatReport};
use std::path::Path;

/// 未跟踪文件超过这个大小就不再读来数行（读它只为一行数字，代价不该随文件变大）
const MAX_UNTRACKED_BYTES: u64 = 2 * 1024 * 1024;

/// 最多数多少个未跟踪文件（`node_modules` 没进 `.gitignore` 时可能是几万个）
const MAX_UNTRACKED_FILES: usize = 200;

/// 二进制嗅探字节数 —— 与 git 的 `buffer_is_binary` 同口径（前 8000 字节里找 NUL）
const BINARY_SNIFF_BYTES: usize = 8000;

/// 取一份行数统计（`dir` 是**工作目录**，可位于仓库任意子目录）。
pub fn stats(dir: &str) -> Result<StatReport, GitError> {
    stats_with_cancel(dir, None)
}

/// 同上，但接受取消标志（未跟踪文件要逐个读来数行，大仓库里要能中断）。
pub fn stats_with_cancel(
    dir: &str,
    cancel: Option<&std::sync::Arc<std::sync::atomic::AtomicBool>>,
) -> Result<StatReport, GitError> {
    let root = super::repo::root_of(dir)?;
    let staged = numstat_at_root(&root, true, cancel)?;
    let mut worktree = numstat_at_root(&root, false, cancel)?;
    worktree.extend(untracked_stats(&root, cancel)?);
    Ok(StatReport { staged, worktree })
}

fn numstat_at_root(
    root: &str,
    cached: bool,
    cancel: Option<&std::sync::Arc<std::sync::atomic::AtomicBool>>,
) -> Result<Vec<FileStat>, GitError> {
    let mut cmd = GitCmd::read(root).arg("diff").arg("--numstat").arg("-z");
    if cached {
        cmd = cmd.arg("--cached");
    }
    let out = cmd.cancel_opt(cancel).run()?.into_result("diff --numstat")?;
    Ok(parse_numstat(&out.stdout))
}

/// 未跟踪文件：`ls-files -o` 列路径，本模块自己数行。
fn untracked_stats(
    root: &str,
    cancel: Option<&std::sync::Arc<std::sync::atomic::AtomicBool>>,
) -> Result<Vec<FileStat>, GitError> {
    let out = GitCmd::read(root)
        .arg("ls-files")
        .arg("-o")
        .arg("--exclude-standard")
        .arg("-z")
        .cancel_opt(cancel)
        .run()?
        .into_result("ls-files -o")?;

    let mut stats = Vec::new();
    for chunk in out.stdout.split(|b| *b == 0) {
        if chunk.is_empty() {
            continue;
        }
        // 中断检查放在读文件之前：一次最多读 2 MiB，用户点了取消就不该继续吞
        if let Some(flag) = cancel {
            if flag.load(std::sync::atomic::Ordering::Relaxed) {
                break;
            }
        }
        if stats.len() >= MAX_UNTRACKED_FILES {
            break;
        }
        let path = String::from_utf8_lossy(chunk).into_owned();
        let added = count_file_lines(&Path::new(root).join(&path));
        stats.push(FileStat {
            path,
            orig_path: None,
            added,
            // 未跟踪 = 相对 index 全是新增；数不出来（二进制 / 过大）时两侧一起留空
            deleted: added.map(|_| 0),
        });
    }
    Ok(stats)
}

/// 数一个文件的行数；二进制 / 读不到 / 过大 → `None`
fn count_file_lines(full: &Path) -> Option<u32> {
    let meta = std::fs::metadata(full).ok()?;
    if !meta.is_file() || meta.len() > MAX_UNTRACKED_BYTES {
        return None;
    }
    let bytes = std::fs::read(full).ok()?;
    count_lines(&bytes)
}

/// 行数 = 换行符个数（末尾没有换行时最后一行也算一行 —— 与 git 的计数一致）
fn count_lines(bytes: &[u8]) -> Option<u32> {
    if bytes.iter().take(BINARY_SNIFF_BYTES).any(|b| *b == 0) {
        return None;
    }
    let newlines = bytes.iter().filter(|b| **b == b'\n').count();
    let tail = usize::from(!bytes.is_empty() && !bytes.ends_with(b"\n"));
    Some((newlines + tail) as u32)
}

/// 解析 `git diff --numstat -z`。
///
/// 记录布局：
/// ```text
/// <added>\t<deleted>\t<path>\0                 普通改动
/// <added>\t<deleted>\t\0<旧路径>\0<新路径>\0      rename / copy（第三列是空的）
/// ```
/// `added` / `deleted` 为 `-` 表示二进制 → `None`。
pub fn parse_numstat(raw: &[u8]) -> Vec<FileStat> {
    let chunks: Vec<&[u8]> = raw.split(|b| *b == 0).collect();
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < chunks.len() {
        let chunk = chunks[i];
        i += 1;
        if chunk.is_empty() {
            continue;
        }
        let line = String::from_utf8_lossy(chunk);
        let mut parts = line.splitn(3, '\t');
        let added = parse_count(parts.next().unwrap_or(""));
        let deleted = parse_count(parts.next().unwrap_or(""));
        let rest = parts.next().unwrap_or("");
        if rest.is_empty() {
            // ⚠️ rename / copy：旧路径与路径各占一条 NUL 记录（消费掉，别当成独立条目）
            let old = chunks
                .get(i)
                .map(|c| String::from_utf8_lossy(c).into_owned())
                .unwrap_or_default();
            let new = chunks
                .get(i + 1)
                .map(|c| String::from_utf8_lossy(c).into_owned())
                .unwrap_or_default();
            i += 2;
            if new.is_empty() {
                continue;
            }
            out.push(FileStat {
                path: new,
                orig_path: Some(old),
                added,
                deleted,
            });
        } else {
            out.push(FileStat {
                path: rest.to_string(),
                orig_path: None,
                added,
                deleted,
            });
        }
    }
    out
}

fn parse_count(s: &str) -> Option<u32> {
    if s == "-" {
        return None;
    }
    s.parse().ok()
}
