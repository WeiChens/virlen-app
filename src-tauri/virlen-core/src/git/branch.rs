//! 分支列表 / 切换 / 新建，以及分支名合法性的**唯一权威判定**。
//!
//! ⚠️ 名字合法性只信 `git check-ref-format --branch`（方案 §5.6）—— 自己写正则必然漏规则
//!（`..` / 结尾 `.lock` / 控制字符 / 前后 `/` …），漏了就是「git 报错、界面却放行」的错位。
//!
//! 分支列表用一条 `for-each-ref` 拿全（不用 `branch -vv`：后者是**给人看的**输出，
//! 含 `*` 标记、颜色、对齐填充，解析它等于解析界面文本）。

use super::cli::{GitCmd, GitError};
use super::repo::root_of;
use super::status::snapshot_at_root;
use super::{BranchInfo, StatusSnapshot, WriteGate};

/// 一条 `for-each-ref` 记录的字段数（含最后可含制表符的 subject）
const FIELD_COUNT: usize = 8;

/// 列出本地 + 远程分支。顺序固定为：当前分支 → 其余本地分支 → 远程分支（各自按名字排）——
/// 排序放在 Rust 侧，前端不必再实现一遍同样的规则。
pub fn list(dir: &str) -> Result<Vec<BranchInfo>, GitError> {
    // 字段用制表符分隔：**分支名不可能含制表符**（check-ref-format 禁控制字符），
    // 只有最后的 subject 是用户自由文本 → 必须放最后，用 splitn 一次切完，subject 里的
    // 制表符就原样保留（放中间会被切开）。
    let root = root_of(dir)?;
    let out = GitCmd::read(&root)
        .arg("for-each-ref")
        .arg(
            "--format=%(refname)\t%(refname:short)\t%(HEAD)\t%(objectname:short)\t\
             %(upstream:short)\t%(upstream:track)\t%(committerdate:iso-strict)\t%(contents:subject)",
        )
        .arg("refs/heads")
        .arg("refs/remotes")
        .run()?;
    let out = out.into_result("for-each-ref")?;
    Ok(parse_refs(&out.stdout_str()))
}

/// `for-each-ref` 输出 → [`BranchInfo`]（纯函数）
pub fn parse_refs(text: &str) -> Vec<BranchInfo> {
    // 先归并成一条条完整记录：记录以换行分隔，而 subject 极端情况下若含换行会多出一行 ——
    // 该行制表符不够，拼回上一条（宁可不丢分支，也不要把半条记录解析成一条）
    let mut records: Vec<String> = Vec::new();
    for raw_line in text.lines() {
        let enough_fields = raw_line.matches('\t').count() + 1 >= FIELD_COUNT;
        if enough_fields {
            records.push(raw_line.to_string());
        } else if let Some(last) = records.last_mut() {
            last.push('\n');
            last.push_str(raw_line);
        }
    }

    let mut list: Vec<BranchInfo> = records.iter().filter_map(|r| parse_one(r)).collect();
    list.sort_by(|a, b| {
        b.is_head
            .cmp(&a.is_head)
            .then(a.is_remote.cmp(&b.is_remote))
            .then_with(|| a.name.cmp(&b.name))
    });
    list
}

fn parse_one(line: &str) -> Option<BranchInfo> {
    let f: Vec<&str> = line.splitn(FIELD_COUNT, '\t').collect();
    if f.len() < FIELD_COUNT {
        return None;
    }
    let refname = f[0];
    // 远程仓库的 `refs/remotes/origin/HEAD` 是个符号引用（指向默认分支），列出来只会误导
    if refname.ends_with("/HEAD") {
        return None;
    }
    let (ahead, behind, gone) = parse_track(f[5]);
    Some(BranchInfo {
        name: f[1].to_string(),
        is_remote: refname.starts_with("refs/remotes/"),
        is_head: f[2].trim() == "*",
        upstream: if f[4].is_empty() {
            None
        } else {
            Some(f[4].to_string())
        },
        ahead,
        behind,
        upstream_gone: gone,
        subject: f[7].to_string(),
        updated_at: if f[6].is_empty() {
            None
        } else {
            Some(f[6].to_string())
        },
    })
}

/// `%(upstream:track)` → (ahead, behind, gone)。取值形如 `[ahead 1, behind 2]` / `[ahead 1]` /
/// `[behind 2]` / `[gone]` / 空串。**空串 ≠ gone**：前者是「没有 upstream」，后者是「upstream 被删了」。
fn parse_track(track: &str) -> (u32, u32, bool) {
    let t = track.trim();
    if t.is_empty() {
        return (0, 0, false);
    }
    if t.contains("gone") {
        return (0, 0, true);
    }
    let mut ahead = 0;
    let mut behind = 0;
    for part in t.trim_matches(|c| c == '[' || c == ']').split(',') {
        let p = part.trim();
        if let Some(n) = p.strip_prefix("ahead ") {
            ahead = n.trim().parse().unwrap_or(0);
        } else if let Some(n) = p.strip_prefix("behind ") {
            behind = n.trim().parse().unwrap_or(0);
        }
    }
    (ahead, behind, false)
}

/// 分支名是否合法（`git check-ref-format --branch`）。
///
/// 以 `-` 开头的名字会被 git 先按选项解析而报错 → 退出码非 0 → 这里如实返回 `false`
///（这正是我们想要的：拒绝它，而不是把它当选项传下去）。
pub fn check_ref_format(dir: &str, name: &str) -> Result<bool, GitError> {
    check_ref_format_at(&root_of(dir)?, name)
}

/// 已经拿到仓库根时走这里（`check-ref-format` 不依赖库内目录，省一次 `rev-parse`）
pub(crate) fn check_ref_format_at(root: &str, name: &str) -> Result<bool, GitError> {
    if name.trim().is_empty() {
        return Ok(false);
    }
    let out = GitCmd::read(root)
        .arg("check-ref-format")
        .arg("--branch")
        .arg(name)
        .run()?;
    Ok(out.ok())
}

/// 切换（或新建并切换）分支。
///
/// ⚠️ **不动 `-f`**：脏工作区与目标分支冲突时，git 自己会拒绝（安全）—— 我们如实把原因给用户，
/// 绝不为了「看起来成功了」而强制切换。切换失败时工作区原样不动。
pub fn switch(
    dir: &str,
    gate: &WriteGate,
    name: &str,
    create: bool,
    start_point: Option<&str>,
) -> Result<StatusSnapshot, GitError> {
    gate.ensure()?;
    let root = root_of(dir)?;
    if !check_ref_format_at(&root, name)? {
        return Err(GitError::new(format!("不是合法的分支名：{}", name)));
    }
    // 能力集只依赖 git 版本（进程级缓存），不必为一个开关再探测一次仓库
    let caps = super::repo::caps_for(&super::repo::version_string());
    let use_switch = caps.switch;

    let mut cmd = GitCmd::write(&root);
    cmd = if create {
        if use_switch {
            cmd.arg("switch").arg("-c").arg(name)
        } else {
            cmd.arg("checkout").arg("-b").arg(name)
        }
    } else if use_switch {
        cmd.arg("switch").arg(name)
    } else {
        cmd.arg("checkout").arg(name)
    };
    if create {
        if let Some(sp) = start_point {
            // 起点可能是个合法的 ref（含远程分支），但仍防它以 `-` 开头被当选项
            if sp.starts_with('-') {
                return Err(GitError::new(format!("不是合法的起点：{}", sp)));
            }
            cmd = cmd.arg(sp);
        }
    }

    cmd.run()?.into_result("switch")?;
    snapshot_at_root(&root, None)
}
