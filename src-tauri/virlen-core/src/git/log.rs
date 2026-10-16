//! 提交记录（`git log`）。
//!
//! 四条口径（都能从「输出格式」上翻车，见 `docs/agents/14-git-management.md` §11.53 ㉝）：
//!
//! 1. **只取标题**（`%s`）：`%s` 是**单行**文本（git 把提交信息首段的换行折成空格），列表要的不是
//!    整段信息。正文不取、界面也不做展开 —— 真要看正文时再单独取一次，而不是让每条记录都背上它。
//! 2. **记录分隔用 NUL（`-z`）、字段分隔用 US（`%x1f`）**：两个分隔符都不出现在 sha / 邮箱 /
//!    ISO 时间里；subject 是**唯一的自由文本**，所以放**最后一个字段**并用 `splitn` 一次切完
//!    （与 `branch.rs` 的 `for-each-ref` 同一条口径）—— 它里面就算含 US 也只会留在最后一段。
//!    ⚠️ 不带 `-z` 时 git 用**换行**分隔记录（实测：输出里一个 NUL 都没有），按行解析会被
//!    「subject 里折成的空格」骗过去 —— 这个开关不能省。
//! 3. **分页交给 git 自己**（`--skip` / `--max-count`）：界面「加载更多」只是换个 skip 再要一次，
//!    本模块**无状态、不缓存**（与 `status` / `diff` 一致：权威永远在 git 自己）。
//! 4. **还没有任何提交（unborn HEAD）不是错误**：`git log` 会以 128 退出，此时回空列表让界面给空态；
//!    但要先确认一次 HEAD 是否真的不存在，否则「仓库损坏」也会被吞成「没有提交记录」。

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use super::cli::{GitCmd, GitError};
use super::repo::root_of;
use super::CommitLogEntry;

/// 一次调用最多取多少条 —— 界面每页 50 条，这里夹一层是因为 `--max-count` 来自入参，
/// 给它一个上界（传多大都不许把几万条记录一次拉回来）。
pub const MAX_LIMIT: u32 = 500;

/// `git log --format` 的字段布局：`FIELD_COUNT` 个字段，**subject 必须在最后**。
const FIELD_COUNT: usize = 6;
/// US（unit separator）：字段分隔。sha / 邮箱 / ISO 时间里不可能有它。
const FIELD_SEP: char = '\u{1f}';
/// `%H` 完整 oid · `%h` 短 oid · `%an` 作者名 · `%ae` 作者邮箱 · `%aI` 作者时间（ISO 8601 strict）· `%s` 标题
const FORMAT: &str = "%H\u{1f}%h\u{1f}%an\u{1f}%ae\u{1f}%aI\u{1f}%s";

/// 从 HEAD 往回取提交记录（`skip` = 已经拿过多少条）。
pub fn log(
    dir: &str,
    skip: u32,
    limit: u32,
    cancel: Option<&Arc<AtomicBool>>,
) -> Result<Vec<CommitLogEntry>, GitError> {
    // cwd 一律 = 仓库根（路径不变式，见 `repo::root_of`）
    log_at(&root_of(dir)?, skip, limit, cancel)
}

/// 已经拿到仓库根时走这里（`log` 的唯一实现体）
fn log_at(
    root: &str,
    skip: u32,
    limit: u32,
    cancel: Option<&Arc<AtomicBool>>,
) -> Result<Vec<CommitLogEntry>, GitError> {
    let out = GitCmd::read(root)
        .arg("log")
        // NUL 分隔记录（见模块头第 2 条：不带它 git 用换行分隔）
        .arg("-z")
        .arg(format!("--max-count={}", limit.clamp(1, MAX_LIMIT)))
        .arg(format!("--skip={}", skip))
        .arg(format!("--format={}", FORMAT))
        .cancel_opt(cancel)
        .run()?;
    if !out.ok() {
        // unborn HEAD：`git log` 没有可走的提交，以 128 退出 —— 这是**正常结果**（界面给空态）。
        // 先确认 HEAD 是否真的不存在，别把「仓库损坏 / 引用异常」也吞成「没有提交记录」。
        return if has_head(root)? {
            Err(out.into_result("log").expect_err("退出码非 0"))
        } else {
            Ok(Vec::new())
        };
    }
    Ok(parse_log(&out.stdout))
}

/// HEAD 是否指向一条真实提交（`rev-parse --verify --quiet HEAD` 的退出码）
fn has_head(root: &str) -> Result<bool, GitError> {
    let out = GitCmd::read(root)
        .arg("rev-parse")
        .arg("--verify")
        .arg("--quiet")
        .arg("HEAD")
        .run()?;
    Ok(out.ok())
}

/// `git log -z --format=…` 的原始 stdout → 提交记录（纯函数）。
///
/// 按 NUL 切记录（最后一条后面那个 NUL 会切出一个空段，丢掉）；每条记录按 US 切字段。
pub fn parse_log(raw: &[u8]) -> Vec<CommitLogEntry> {
    raw.split(|b| *b == 0).filter_map(parse_one).collect()
}

fn parse_one(raw: &[u8]) -> Option<CommitLogEntry> {
    // 逐记录 lossy 解码（与 `status` 同口径：不猜 GBK，猜错会把作者名写坏）
    let text = String::from_utf8_lossy(raw);
    // 只削记录首尾的换行（git 在某些形态下会在 NUL 后补一个换行）——
    // **不削空格**：标题首尾的空格是用户真写的，削掉就是静默改内容
    let line = text.trim_matches(|c| c == '\n' || c == '\r');
    if line.is_empty() {
        return None;
    }
    let f: Vec<&str> = line.splitn(FIELD_COUNT, FIELD_SEP).collect();
    if f.len() < FIELD_COUNT {
        return None;
    }
    Some(CommitLogEntry {
        oid: f[0].to_string(),
        short_oid: f[1].to_string(),
        author_name: f[2].to_string(),
        author_email: f[3].to_string(),
        author_time: f[4].to_string(),
        subject: f[5].to_string(),
    })
}
