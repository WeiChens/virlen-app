//! `git status --porcelain=v2 -z --branch` 的驱动与解析。
//!
//! ⚠️ 解析是**纯函数** [`parse_status`]，字段布局由 `tests.rs` 的真仓库用例钉住（方案 §10 第 6 条）——
//! 尤其类型 `2`（rename / copy）在 `-z` 下把**两个路径拆在两条 NUL 记录**里，写错只会在
//! 「改过名的文件」上静默出错。

use super::cli::{GitCmd, GitError};
use super::{ChangeEntry, EntryKind, HeadInfo, StatusSnapshot};

/// 变更条目上限。未配 `.gitignore` 的 `node_modules` 会让 `-uall` 吐出几十万条，
/// 截断后由界面提示「仅显示前 N 条」—— **不静默截断**。
pub const MAX_ENTRIES: usize = 5_000;

/// 取一次状态快照（`dir` 是**工作目录**，可以是仓库的任意子目录 —— 路径基准由
/// [`super::repo::root_of`] 统一到仓库根）。
///
/// - `--no-optional-locks`（由 [`GitCmd::read`] 加上）：只读不去抢 index 锁，不干扰用户在
///   编辑器 / 终端里的 git；
/// - `-c core.quotepath=false`（同上）：非 ASCII 路径不转义（§11.1 中文编码一脉）；
/// - `-z`：路径以 NUL 分隔，空格 / 换行 / 引号路径原样；**且它同时决定路径基准** ——
///   不带 `-z` 时 porcelain 的路径相对 **cwd**（子目录里得到 `../x`），带上才是**仓库根相对**。
///   我们对外承诺仓库根相对，所以 `-z` 不能删（`porcelain_v2_path_basis_depends_on_z` 用真 git 钉住）。
pub fn status(dir: &str) -> Result<StatusSnapshot, GitError> {
    status_with_cancel(dir, None)
}

/// 同上，但接受取消标志（超大仓库的 `status` 可能过秒，用户在界面上要能取消）
pub fn status_with_cancel(
    dir: &str,
    cancel: Option<&std::sync::Arc<std::sync::atomic::AtomicBool>>,
) -> Result<StatusSnapshot, GitError> {
    snapshot_at_root(&super::repo::root_of(dir)?, cancel)
}

/// 已经拿到仓库根时走这里 —— 同一个操作里连着取快照（暂存 / 切分支 / 丢弃后回读）时省一次 `rev-parse`。
///
/// ⚠️ **cwd 必须是仓库根**：`-z` 让 status 给出**仓库根相对**路径，而写操作（`git add` 等）按
/// **cwd** 解释路径 —— 拿子目录当 cwd 就是「界面上的路径 git 不认」（退出码 128）。
pub(crate) fn snapshot_at_root(
    root: &str,
    cancel: Option<&std::sync::Arc<std::sync::atomic::AtomicBool>>,
) -> Result<StatusSnapshot, GitError> {
    let out = GitCmd::read(root)
        .arg("status")
        .arg("--porcelain=v2")
        .arg("-z")
        .arg("--branch")
        .arg("--untracked-files=all")
        .cancel_opt(cancel)
        .run()?;
    let out = out.into_result("status")?;
    let snapshot = parse_status(&out.stdout, MAX_ENTRIES).map_err(GitError::new)?;
    ensure_root_relative(&snapshot)?;
    Ok(snapshot)
}

/// ⚠️ 不变式自检（**fail-closed**）：cwd 已经统一到仓库根，porcelain 的路径就不可能带 `..`。
/// 出现即说明上面那条不变式被破坏了 —— 宁可报错，也不要把一份「按别的目录解释」的路径交给界面
/// （用户点暂存只会得到 128，而且完全无从自查）。
pub(crate) fn ensure_root_relative(snapshot: &StatusSnapshot) -> Result<(), GitError> {
    let bad = snapshot.entries.iter().find(|e| {
        !is_root_relative(&e.path)
            || e.orig_path
                .as_deref()
                .map(|p| !is_root_relative(p))
                .unwrap_or(false)
    });
    match bad {
        None => Ok(()),
        Some(e) => Err(GitError::new(format!(
            "内部错误：git 返回了非仓库根相对路径（{}）",
            e.path
        ))),
    }
}

/// 仓库根相对 = 不以 `..` 开头，也不含 `..` 路径段（仓库内的合法文件名不可能是 `..`）
pub(crate) fn is_root_relative(p: &str) -> bool {
    !p.is_empty()
        && p != ".."
        && !p.starts_with("../")
        && !p.contains("/../")
        && !p.ends_with("/..")
}

/// 解析 porcelain=v2 的 `-z` 输出（纯函数，便于用固定字节 + 真仓库两种方式测）。
///
/// 记录布局（`-z` 下每条记录以 NUL 结尾）：
/// ```text
/// # branch.oid <oid> | (initial)
/// # branch.head <branch> | (detached)
/// # branch.upstream <upstream>
/// # branch.ab +<ahead> -<behind>
/// 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
/// 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>     ← 旧路径在下一条 NUL 记录
/// u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
/// ? <path>
/// ! <path>        （本模块不带 --ignored，正常不会出现）
/// ```
/// 路径含空格 → 用 `splitn` 切「固定字段数」，最后一段整体当路径（**不能**按空白全切）。
pub fn parse_status(raw: &[u8], max_entries: usize) -> Result<StatusSnapshot, String> {
    let mut head = HeadInfo {
        oid: None,
        branch: None,
        upstream: None,
        ahead: 0,
        behind: 0,
    };
    let mut entries: Vec<ChangeEntry> = Vec::new();
    let mut truncated = false;

    let chunks: Vec<&[u8]> = raw.split(|b| *b == 0).collect();
    let mut i = 0usize;
    while i < chunks.len() {
        let chunk = chunks[i];
        i += 1;
        if chunk.is_empty() {
            continue;
        }
        // 正常情况下「一条记录 = 一个 NUL 段 = 一行」；这里再按换行切一次，
        // 只是为了让「头部行以换行结尾」的实现差异不至于把后面几条记录一起吞掉。
        for line in String::from_utf8_lossy(chunk).split('\n') {
            if line.is_empty() {
                continue;
            }
            if let Some(rest) = line.strip_prefix("# ") {
                parse_head_line(rest, &mut head);
                continue;
            }
            if entries.len() >= max_entries {
                truncated = true;
                break;
            }
            if line.starts_with("2 ") {
                // ⚠️ 类型 2 的旧路径是**紧接着的下一条 NUL 记录**：必须在这里消费掉它，
                //    否则它会被当成一条独立记录解析（表现为「凭空多出一个文件」）。
                let orig = if i < chunks.len() {
                    let v = String::from_utf8_lossy(chunks[i]).into_owned();
                    i += 1;
                    v
                } else {
                    String::new()
                };
                if let Some(entry) = parse_type2(line, orig) {
                    entries.push(entry);
                }
                continue;
            }
            if let Some(entry) = parse_change_line(line) {
                entries.push(entry);
            }
            // 其余未知记录类型：跳过而不是报错（git 加新类型时不该让整个面板打不开）
        }
        if truncated {
            break;
        }
    }

    Ok(StatusSnapshot {
        head,
        entries,
        truncated,
    })
}

/// `# branch.oid <oid>` / `branch.head <b>` / `branch.upstream <u>` / `branch.ab +A -B`
fn parse_head_line(rest: &str, head: &mut HeadInfo) {
    let (key, value) = match rest.split_once(' ') {
        Some(pair) => pair,
        None => return,
    };
    match key {
        "branch.oid" => {
            // (initial) = 仓库还没有任何提交 —— 与「oid 未知」是同一件事，统一成 None
            head.oid = if value == "(initial)" {
                None
            } else {
                Some(value.to_string())
            };
        }
        "branch.head" => {
            // (detached) = 游离 HEAD，没有分支名
            head.branch = if value == "(detached)" {
                None
            } else {
                Some(value.to_string())
            };
        }
        "branch.upstream" => head.upstream = Some(value.to_string()),
        "branch.ab" => {
            // 形如 "+1 -2"，只在有 upstream 时出现
            for part in value.split_whitespace() {
                if let Some(n) = part.strip_prefix('+') {
                    head.ahead = n.parse().unwrap_or(0);
                } else if let Some(n) = part.strip_prefix('-') {
                    head.behind = n.parse().unwrap_or(0);
                }
            }
        }
        _ => {}
    }
}

/// 类型 `1` / `u` / `?` 的单行记录；类型 `2` 与未知类型返回 `None`。
fn parse_change_line(line: &str) -> Option<ChangeEntry> {
    let tag = line.chars().next()?;
    let rest = line.get(tag.len_utf8()..)?.strip_prefix(' ')?;
    match tag {
        // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path> → 8 段，最后一段是路径
        '1' => {
            let f = split_fields(rest, 8)?;
            Some(change(f[7].to_string(), None, EntryKind::Ordinary, f[0]))
        }
        // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path> → 10 段
        'u' => {
            let f = split_fields(rest, 10)?;
            Some(change(f[9].to_string(), None, EntryKind::Unmerged, f[0]))
        }
        '?' => Some(change(rest.to_string(), None, EntryKind::Untracked, "??")),
        _ => None,
    }
}

/// 类型 `2`（rename / copy）：字段来自本行，旧路径来自紧随其后的那条记录。
fn parse_type2(line: &str, orig_path: String) -> Option<ChangeEntry> {
    let rest = line.strip_prefix("2 ")?;
    // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path> → 9 段
    let f = split_fields(rest, 9)?;
    // `<X><score>` 的第一位区分改名与复制（C = copy）
    let kind = if f[7].starts_with('C') {
        EntryKind::Copied
    } else {
        EntryKind::Renamed
    };
    Some(change(f[8].to_string(), Some(orig_path), kind, f[0]))
}

/// 把 `rest` 按「前 n-1 个字段 + 最后一段整体当路径」切分（路径可含空格）
fn split_fields(rest: &str, n: usize) -> Option<Vec<&str>> {
    let parts: Vec<&str> = rest.splitn(n, ' ').collect();
    if parts.len() < n {
        return None;
    }
    Some(parts)
}

fn change(path: String, orig_path: Option<String>, kind: EntryKind, xy: &str) -> ChangeEntry {
    let mut chars = xy.chars();
    let x = chars.next().unwrap_or('.');
    let y = chars.next().unwrap_or('.');
    ChangeEntry {
        path,
        orig_path,
        x,
        y,
        kind,
    }
}
