//! 贮藏（stash）：列表 / 新建 / 应用 / 应用并删除（pop）/ 删除 / 删除后恢复。
//!
//! 五条口径，**全部来自真仓库实测**（git 2.51，用例见 `tests.rs`）：
//! 1. **身份用 oid，`stash@{n}` 只在写操作内部解析**：`apply` 接受任意提交 oid，而 `pop` / `drop`
//!    只认 stash ref（`error: '<oid>' is not a stash reference`）。而 `stash@{n}` 是**列表位置**，
//!    外部一次 push / drop 就会整体重编号 —— 拿旧 selector 盲操作会动到别人的条目。
//! 2. **不能拿退出码判断「有没有贮藏到东西」**：无改动时 `stash push` 退出码 **0**，只打印
//!    `No local changes to save`。所以先看快照，并在执行后用「栈顶 oid 变了没有」复核。
//! 3. **冲突态（unmerged）不能 push**：git 报 `needs merge` / `could not write index`（退出码 1）。
//! 4. **未跟踪文件默认不进贮藏**（要 `-u`）；它们在 stash 提交的**第三个父提交**里，
//!    `<stash>:<未跟踪路径>` 取不到（差异视图要用 `<stash>^3`）。
//! 5. **应用失败不等于「什么都没发生」**：工作区有同类改动时 git 会 `Aborting`（工作区不动），
//!    但内容真冲突时退出码 1 且**工作区留下冲突标记** —— 这句提示在前端（`git-service.applyStash`）。
//!
//! ⚠️ `pop` / `drop` 的「解析 selector → 执行」必须在**同一把仓库锁内**完成（否则两次调用之间
//! 列表被外部改动就会删错条目）。锁不可重入：锁内的 git 调用一律走 [`GitCmd::run_in_lock`]。

use super::cli::{GitCmd, GitError};
use super::lock::with_repo_lock;
use super::repo::root_of;
use super::status::snapshot_at_root;
use super::{EntryKind, StashDropResult, StashEntry, StashResult, WriteGate};

/// 贮藏列表（新 → 旧，git 自己的顺序）。
pub fn list(dir: &str) -> Result<Vec<StashEntry>, GitError> {
    list_at(&root_of(dir)?)
}

fn list_at(root: &str) -> Result<Vec<StashEntry>, GitError> {
    // `%x00` 分隔：reflog 消息是用户自由文本（可以有空格 / 制表符 / 中文），
    // 而制表符在消息里是合法字符 —— 只有 NUL 不可能出现在字段里
    let out = GitCmd::read(root)
        .arg("stash")
        .arg("list")
        .arg("--format=%H%x00%gd%x00%gs%x00%cI%x00")
        .run()?;
    // `refs/stash` 不存在时 git 输出为空、退出码 0 —— 空列表是**正常结果**，不是错误
    let out = out.into_result("stash list")?;
    Ok(parse_entries(&out.stdout_str()))
}

/// `--format` 输出 → 条目（纯函数）。
///
/// 布局（每条）：`<oid>\0<stash@{n}>\0<消息>\0<时间>\0` + 一条换行。换行会粘在**下一条**的 oid 前，
/// 所以 oid 要 trim。⚠️ git 会把 `-m` 里的换行折成空格（实测），但空格 / 制表符仍会原样保留 ——
/// 不能按空白或行来切。
pub fn parse_entries(text: &str) -> Vec<StashEntry> {
    let mut fields: Vec<&str> = text.split('\0').collect();
    while fields.last().map(|s| s.trim().is_empty()).unwrap_or(false) {
        fields.pop();
    }
    fields
        .chunks(4)
        .filter(|chunk| chunk.len() == 4)
        .map(|chunk| StashEntry {
            oid: chunk[0].trim().to_string(),
            selector: chunk[1].trim().to_string(),
            message: chunk[2].trim_end_matches(['\r', '\n']).to_string(),
            time: chunk[3].trim().to_string(),
        })
        .filter(|entry| !entry.oid.is_empty())
        .collect()
}

/// 新建贮藏。
///
/// `keep_index` = `--keep-index`：已暂存的内容**既进贮藏、又留在索引 / 工作区**（实测如此）——
/// 文案要说清，否则「只贮藏未暂存部分」的期待会落空。
pub fn push(
    dir: &str,
    gate: &WriteGate,
    message: Option<&str>,
    include_untracked: bool,
    keep_index: bool,
) -> Result<StashResult, GitError> {
    gate.ensure()?;
    let root = root_of(dir)?;
    let before = snapshot_at_root(&root, None)?;

    // ① 未诞生 HEAD：git 直接 exit 1（`You do not have the initial commit yet`）
    if before.head.oid.is_none() {
        return Err(GitError::new("仓库还没有提交，无法贮藏（先提交一次再试）"));
    }
    // ② 未解决的冲突：git 报 `needs merge` / `could not write index`（exit 1）
    if before
        .entries
        .iter()
        .any(|entry| entry.kind == EntryKind::Unmerged)
    {
        return Err(GitError::new("有未解决的冲突，解决后再贮藏"));
    }
    let untracked = before
        .entries
        .iter()
        .filter(|entry| entry.kind == EntryKind::Untracked)
        .count();
    let tracked = before.entries.len() - untracked;
    // ③ 无改动：`stash push` 退出码是 **0** —— 这一条只能靠快照判
    if tracked == 0 {
        if untracked == 0 {
            return Err(GitError::new("没有可贮藏的改动"));
        }
        if !include_untracked {
            return Err(GitError::new(
                "只有未跟踪文件：勾选「包含未跟踪文件」后再贮藏",
            ));
        }
    }

    let before_top = list_at(&root)?.first().map(|entry| entry.oid.clone());

    let mut cmd = GitCmd::write(&root).arg("stash").arg("push");
    if include_untracked {
        // ⚠️ 只加 `-u`（未跟踪），**绝不加 `-a`**：`-a` 会把被 .gitignore 排除的东西也写进对象库
        cmd = cmd.arg("--include-untracked");
    }
    if keep_index {
        cmd = cmd.arg("--keep-index");
    }
    if let Some(text) = message.map(str::trim).filter(|text| !text.is_empty()) {
        // 消息作为**单个 argv** 传给 git（不拼 shell）：引号 / 分号 / `$` 都不会被解释
        cmd = cmd.arg("-m").arg(text);
    }
    cmd.run()?.into_result("stash push")?;

    let stashes = list_at(&root)?;
    // ④ 兜底复核：走到这里说明快照里确实有改动；若栈顶没变，就是这期间被外部改掉了
    //    （`stash push` 在「没东西可贮藏」时仍是 exit 0，不能当成功）
    if stashes.first().map(|entry| &entry.oid) == before_top.as_ref() {
        return Err(GitError::new(
            "没有可贮藏的改动（工作区在操作期间被改动了）",
        ));
    }
    Ok(StashResult {
        snapshot: snapshot_at_root(&root, None)?,
        stashes,
    })
}

/// 应用（`pop = false`）或应用并删除（`pop = true`）。
///
/// `restore_index` = `--index`：试图同时恢复「当初已暂存」那一层；目标提交改过同一文件时会失败
/// （git 文档口径），所以默认关。
pub fn apply(
    dir: &str,
    gate: &WriteGate,
    oid: &str,
    restore_index: bool,
    pop: bool,
) -> Result<StashResult, GitError> {
    gate.ensure()?;
    let root = root_of(dir)?;
    if !is_object_name(oid) {
        return Err(GitError::new("贮藏条目的 oid 不合法"));
    }
    with_repo_lock(&root, || {
        let selector = entry_at(&root, oid)?.selector;
        let mut cmd = GitCmd::write(&root).arg("stash");
        cmd = if pop { cmd.arg("pop") } else { cmd.arg("apply") };
        if restore_index {
            cmd = cmd.arg("--index");
        }
        // 锁已在本闭包里持有 → 只能走 run_in_lock（再走 run() 会二次加锁 → 死锁）
        cmd.arg(selector)
            .run_in_lock()?
            .into_result(if pop { "stash pop" } else { "stash apply" })?;
        Ok(StashResult {
            snapshot: snapshot_at_root(&root, None)?,
            stashes: list_at(&root)?,
        })
    })
}

/// 删除一条贮藏。⚠️ 破坏性动作（二次确认在界面层）：删错只能靠 `stash store`（本模块的
/// [`restore`]）或 git reflog 找回。
pub fn drop(dir: &str, gate: &WriteGate, oid: &str) -> Result<StashDropResult, GitError> {
    gate.ensure()?;
    let root = root_of(dir)?;
    if !is_object_name(oid) {
        return Err(GitError::new("贮藏条目的 oid 不合法"));
    }
    with_repo_lock(&root, || {
        let all = list_at(&root)?;
        let entry = all
            .iter()
            .find(|item| item.oid == oid)
            .cloned()
            .ok_or_else(|| GitError::new("这条贮藏已不存在（可能已在别处删除）"))?;
        let out = GitCmd::write(&root)
            .arg("stash")
            .arg("drop")
            .arg(&entry.selector)
            .run_in_lock()?
            .into_result("stash drop")?;

        // git 回一行 `Dropped stash@{n} (<oid>)`：用它**事后核对**删的是不是这一条。
        // 极端竞态（外部进程在「解析」与「执行」之间改了 refs/stash）下 selector 会指偏 ——
        // 删错人的条目比删不掉严重得多，所以误删要尽量放回去再报错。
        if let Some(victim_oid) = parse_dropped_oid(&out.stdout_str()).filter(|dropped| dropped != oid) {
            if let Some(victim) = all.iter().find(|item| item.oid == victim_oid) {
                let _ = store_locked(&root, &victim.oid, &victim.message);
            }
            return Err(GitError::new(
                "贮藏列表在操作期间被改动，未删除目标条目（误删的已尝试恢复），请刷新后重试",
            ));
        }

        Ok(StashDropResult {
            oid: oid.to_string(),
            message: entry.message,
            stashes: list_at(&root)?,
        })
    })
}

/// 把删掉的贮藏放回列表**顶部**（`git stash store`）—— 界面上的「撤销删除」。
pub fn restore(
    dir: &str,
    gate: &WriteGate,
    oid: &str,
    message: &str,
) -> Result<Vec<StashEntry>, GitError> {
    gate.ensure()?;
    let root = root_of(dir)?;
    if !is_object_name(oid) {
        return Err(GitError::new("贮藏条目的 oid 不合法"));
    }
    with_repo_lock(&root, || {
        store_locked(&root, oid, message)?;
        list_at(&root)
    })
}

fn entry_at(root: &str, oid: &str) -> Result<StashEntry, GitError> {
    list_at(root)?
        .into_iter()
        .find(|entry| entry.oid == oid)
        .ok_or_else(|| GitError::new("这条贮藏已不存在（可能已在别处删除）"))
}

/// ⚠️ 调用方必须**已持仓库锁**（本函数走 [`GitCmd::run_in_lock`]）。
fn store_locked(root: &str, oid: &str, message: &str) -> Result<(), GitError> {
    let text = message.trim();
    let text = if text.is_empty() { "恢复的贮藏" } else { text };
    GitCmd::write(root)
        .arg("stash")
        .arg("store")
        .arg("-m")
        .arg(text)
        .arg(oid)
        .run_in_lock()?
        .into_result("stash store")?;
    Ok(())
}

/// `Dropped stash@{0} (4f6bfd6...)` → oid（纯函数）
fn parse_dropped_oid(stdout: &str) -> Option<String> {
    let open = stdout.rfind('(')?;
    let close = stdout[open..].find(')')? + open;
    let inner = stdout[open + 1..close].trim();
    is_object_name(inner).then(|| inner.to_string())
}

/// 只接受十六进制（7–64 位）：既挡住 `-` 开头的参数注入，也挡住把 `stash@{0}` 当 oid 传进来
fn is_object_name(text: &str) -> bool {
    (7..=64).contains(&text.len()) && text.chars().all(|c| c.is_ascii_hexdigit())
}
