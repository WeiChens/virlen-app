//! 单个提交的详情（`git show`）——「点一条提交，看它改了什么」。
//!
//! 三条口径：
//! 1. **基准是「第一个父提交」**：merge 提交相对谁看，git 自己没有唯一答案（`git show` 给的是
//!    combined diff —— 只有冲突的那几行，不是「这个合并带来了什么」）。这里显式取 `parents[0]`，
//!    root 提交（无父）走 `--root` 全量；界面上要说清这是「相对第一个父提交」。
//! 2. **清单与两侧内容分两次取**（[`detail`] / [`file_sides`]）：一次把整个提交的 diff 拉回来，
//!    大提交上是几十 MB（还可能含二进制），而用户往往只看一两个文件 —— 与 `status` / `diff`
//!    同一取舍：按需取、不缓存。
//! 3. 两侧内容复用 [`super::diff::sides_of_revs`]（原始字节 / 二进制嗅探 / LF 归一化只有一份），
//!    rev 换成 `<oid>^` / `<oid>`。

use super::cli::{GitCmd, GitError};
use super::diff::sides_of_revs;
use super::repo::root_of;
use super::{CommitDetail, CommitFile, DiffSides};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

/// 字段数与顺序必须与 [`BODY_FORMAT`] 一致，**`%B`（正文）必须在最后**（它是唯一的自由文本）。
const FIELD_COUNT: usize = 7;
/// US（unit separator）分字段：sha / 邮箱 / ISO 时间里都不可能有它。
const FIELD_SEP: char = '\u{1f}';

/// `%H` oid · `%h` 短 oid · `%an` / `%ae` 作者 · `%aI` 作者时间 · `%P` 父提交（空格分隔）·
/// `%B` 完整提交信息（**必须最后**）
const BODY_FORMAT: &str = "%H\u{1f}%h\u{1f}%an\u{1f}%ae\u{1f}%aI\u{1f}%P\u{1f}%B";

/// 取一个提交的详情（头信息 + 提交信息正文 + 变更文件清单）。
pub fn detail(dir: &str, oid: &str) -> Result<CommitDetail, GitError> {
    let root = root_of(dir)?;
    // `-s` = 不要 diff（清单另取，见口径 2）；`--no-color` 防用户在配置里开了 color.ui
    let out = GitCmd::read(&root)
        .arg("show")
        .arg("-s")
        .arg("--no-color")
        .arg(format!("--format={}", BODY_FORMAT))
        .arg(oid)
        .run()?
        .into_result("show")?;

    let text = out.stdout_str();
    let mut fields = text.splitn(FIELD_COUNT, FIELD_SEP);
    let mut next = || fields.next().unwrap_or("").to_string();
    let full_oid = next();
    let short_oid = next();
    let author_name = next();
    let author_email = next();
    let author_time = next();
    let parents: Vec<String> = next()
        .split_whitespace()
        .map(|s| s.to_string())
        .collect();
    // `%B` 是原始正文（自带结尾换行），末尾空白对界面没有意义
    let message = next().trim_end().to_string();

    // 取不到 oid 就是空提交 —— 交给界面按空态处理，不把它当错误
    let files = if full_oid.is_empty() {
        Vec::new()
    } else {
        files_at(&root, &full_oid, parents.first().map(|s| s.as_str()))?
    };

    Ok(CommitDetail {
        oid: if full_oid.is_empty() { oid.to_string() } else { full_oid },
        short_oid,
        author_name,
        author_email,
        author_time,
        message,
        parents,
        files,
    })
}

/// 提交里某条路径的两侧内容（旧 = `<oid>^`，新 = `<oid>`）。
///
/// 取不到的一侧照例是空侧：root 提交没有父、删除的文件在 `<oid>` 下不存在、新增的文件在
/// `<oid>^` 下不存在 —— 三种情况界面上都表现为「单栏」。
pub fn file_sides(
    dir: &str,
    oid: &str,
    path: &str,
    orig_path: Option<&str>,
    cancel: Option<&Arc<AtomicBool>>,
) -> Result<DiffSides, GitError> {
    let root = root_of(dir)?;
    // rename：旧侧要去旧路径取，否则会显示成「整文件新增 + 整文件删除」
    let old_path = orig_path.unwrap_or(path);
    sides_of_revs(
        &root,
        &format!("{}^:{}", oid, old_path),
        &format!("{}:{}", oid, path),
        "父提交",
        "本次提交",
        cancel,
    )
}

/// 变更文件清单：相对**第一个父提交**（`base = None` 即 root 提交，走 `--root` 全量）。
fn files_at(root: &str, oid: &str, base: Option<&str>) -> Result<Vec<CommitFile>, GitError> {
    let mut cmd = GitCmd::read(root)
        .arg("diff-tree")
        .arg("-r")
        // 只要清单，不要 `diff-tree` 惯常打头的那行 commit id
        .arg("--no-commit-id")
        .arg("--name-status")
        // ⚠️ `-z`：改名在**非** -z 下是 `R100\told\tnew` 一行三列，路径里有制表符就切歪；
        //    -z 下每个字段都独立成一条 NUL 记录（与 status 的 `-z` 同一条口径）
        .arg("-z")
        .arg("--find-renames");
    match base {
        Some(parent) => {
            cmd = cmd.arg(parent);
        }
        None => {
            cmd = cmd.arg("--root");
        }
    }
    let out = cmd.arg(oid).run()?.into_result("diff-tree")?;
    Ok(parse_name_status(&out.stdout))
}

/// `--name-status -z` 的解析（**纯函数**，字段布局由 `tests.rs` 的真仓库用例钉住）。
fn parse_name_status(raw: &[u8]) -> Vec<CommitFile> {
    let text = String::from_utf8_lossy(raw);
    let mut it = text.split('\0');
    let mut files = Vec::new();
    while let Some(status) = it.next() {
        if status.is_empty() {
            continue;
        }
        // 状态形如 `M` / `R100` / `C75` —— 只留字母，相似度分数对界面没有意义
        let letter = status.chars().next().unwrap_or('?');
        let Some(path) = it.next() else { break };
        // ⚠️ rename / copy 在 `-z` 下把**两个路径拆成两条 NUL 记录**：先旧路径、后新路径。
        //    按「一条记录一个路径」读会把下一个文件的状态字母当成路径（与 status 类型 2 同一个坑）
        let (orig_path, path) = if matches!(letter, 'R' | 'C') {
            match it.next() {
                Some(new_path) => (Some(path.to_string()), new_path.to_string()),
                None => break,
            }
        } else {
            (None, path.to_string())
        };
        files.push(CommitFile {
            path,
            orig_path,
            status: letter,
        });
    }
    files
}

#[cfg(test)]
mod tests {
    use super::parse_name_status;

    /// 固定字节：普通 / 改名 / 带空格路径 —— 这三条是「错了只会静默出错」的地方
    #[test]
    fn parse_name_status_pins_field_layout() {
        // M\0a.txt\0R100\0old.txt\0new file.txt\0D\0gone.txt\0
        let raw = b"M\0a.txt\0R100\0old.txt\0new file.txt\0D\0gone.txt\0";
        let files = parse_name_status(raw);
        assert_eq!(files.len(), 3);
        assert_eq!(files[0].path, "a.txt");
        assert_eq!(files[0].status, 'M');
        assert_eq!(files[0].orig_path, None);
        assert_eq!(files[1].path, "new file.txt");
        assert_eq!(files[1].orig_path.as_deref(), Some("old.txt"));
        assert_eq!(files[1].status, 'R');
        assert_eq!(files[2].path, "gone.txt");
        assert_eq!(files[2].status, 'D');
    }

    #[test]
    fn parse_name_status_tolerates_empty() {
        assert!(parse_name_status(b"").is_empty());
        // 结尾多余的 NUL 不该造出一个「空路径」的条目
        assert!(parse_name_status(b"\0").is_empty());
    }
}
