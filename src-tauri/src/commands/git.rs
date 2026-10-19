//! git 源代码管理（GUI 壳）：只做参数兜底、写操作准入（只读沙盒 fail-closed）与转交 `virlen_core::git`。
//! ⚠️ 新增命令必须登记到 `lib.rs` 的 `generate_handler![...]`，否则 `invoke` 静默 404。
//! ⚠️ `dir` = 工作目录（可为仓库任意子目录），路径基准由 `repo::root_of` 统一，本层不做路径拼接。
//! ⚠️ 埋点只报动作 / 结果 / 退出码 / 耗时：**不报仓库路径、分支名、提交信息正文**（可能是敏感数据）。

use serde_json::json;
use std::sync::Arc;
use virlen_core::git::cli::GitError;
use virlen_core::git::{
    BranchInfo, CommitDetail, CommitLogEntry, CommitResult, DiffScope, DiffSides, LogScope,
    MergeResult, RemoteInfo, RepoInfo, StashDropResult, StashEntry, StashResult, StatReport,
    StatusSnapshot, SyncResult, WriteGate,
};
use virlen_core::session_db::SettingsRepo;

/// 把阻塞的 git 调用挪到阻塞线程池（子进程 + 阻塞读管道不许占 async 线程），
/// 埋点也收口在这里：一次命令一条 `git.op`（动作 / 成败 / 退出码 / 耗时）。
async fn blocking<T, F>(op: &'static str, f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, GitError> + Send + 'static,
    T: Send + 'static,
{
    let started = crate::telemetry::now_ms();
    let joined = tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| format!("Task join error: {}", e))?;
    let props = match &joined {
        Ok(_) => json!({ "op": op, "ok": true, "ms": crate::telemetry::now_ms().saturating_sub(started) }),
        Err(e) => json!({
            "op": op,
            "ok": false,
            "code": e.code,
            "ms": crate::telemetry::now_ms().saturating_sub(started),
        }),
    };
    crate::telemetry::track("git.op", props);
    joined.map_err(|e| e.to_string())
}

/// 写操作准入：从 `app_settings` 读 `sandboxMode`（读失败按拒绝写，fail-closed）
async fn gate(settings: &tauri::State<'_, Arc<dyn SettingsRepo>>) -> WriteGate {
    WriteGate::from_settings(settings.inner().as_ref()).await
}

// ==================== 只读 ====================

/// 探测目录是不是 git 仓库；`None` = 不是（**正常结果**，界面给空态）
#[tauri::command]
pub async fn git_repo_info(dir: String) -> Result<Option<RepoInfo>, String> {
    blocking("repo_info", move || virlen_core::git::repo::discover(&dir)).await
}

/// 在当前目录初始化仓库（`git init`）—— 面板在「不是仓库」时给的唯一出口
#[tauri::command]
pub async fn git_init(
    settings: tauri::State<'_, Arc<dyn SettingsRepo>>,
    dir: String,
) -> Result<RepoInfo, String> {
    let gate = gate(&settings).await;
    blocking("init", move || virlen_core::git::repo::init(&dir, &gate)).await
}

/// 状态快照（分支头 + 全部变更条目）。`task_id` 供超大仓库中途取消。
#[tauri::command]
pub async fn git_status(dir: String, task_id: String) -> Result<StatusSnapshot, String> {
    let cancel = crate::task_manager::register(&task_id);
    let result = blocking("status", move || {
        virlen_core::git::status::status_with_cancel(&dir, Some(&cancel))
    })
    .await;
    crate::task_manager::unregister(&task_id);
    result
}

/// 逐文件行数统计（面板里的「+12 −3」与顶部合计）。只在面板打开时取 —— 它比 `status` 贵。
/// `task_id` 供未跟踪文件逐个数行时中断。
#[tauri::command]
pub async fn git_numstat(dir: String, task_id: String) -> Result<StatReport, String> {
    let cancel = crate::task_manager::register(&task_id);
    let result = blocking("numstat", move || {
        virlen_core::git::numstat::stats_with_cancel(&dir, Some(&cancel))
    })
    .await;
    crate::task_manager::unregister(&task_id);
    result
}

/// 分支列表（本地 + 远程，已在 Rust 侧排好序）
#[tauri::command]
pub async fn git_branches(dir: String) -> Result<Vec<BranchInfo>, String> {
    blocking("branches", move || virlen_core::git::branch::list(&dir)).await
}

/// 提交记录；`skip` 由「加载更多」推进，Rust 侧不缓存。
/// `scope` = `head`（提交记录弹窗）/ `all`（全部 + 标签，提交图弹窗）；两个 op 名只为埋点里分得开用量。
#[tauri::command]
pub async fn git_log(
    dir: String,
    skip: u32,
    limit: u32,
    scope: Option<LogScope>,
    task_id: String,
) -> Result<Vec<CommitLogEntry>, String> {
    let cancel = crate::task_manager::register(&task_id);
    let scope = scope.unwrap_or(LogScope::Head);
    let op = if scope == LogScope::All { "log_graph" } else { "log" };
    let result = blocking(op, move || {
        virlen_core::git::log::log(&dir, skip, limit, scope, Some(&cancel))
    })
    .await;
    crate::task_manager::unregister(&task_id);
    result
}

/// 一条路径在某个对比基准下的两侧内容（差异视图的数据源）
#[tauri::command]
pub async fn git_diff_sides(
    dir: String,
    path: String,
    scope: DiffScope,
    orig_path: Option<String>,
    task_id: String,
) -> Result<DiffSides, String> {
    let cancel = crate::task_manager::register(&task_id);
    let result = blocking("diff_sides", move || {
        virlen_core::git::diff::sides_with_cancel(
            &dir,
            &path,
            scope,
            orig_path.as_deref(),
            Some(&cancel),
        )
    })
    .await;
    crate::task_manager::unregister(&task_id);
    result
}

/// 分支名合法性 —— **唯一权威判定**是 `git check-ref-format`（前端不许自己写正则）
#[tauri::command]
pub async fn git_check_ref_format(dir: String, name: String) -> Result<bool, String> {
    blocking("check_ref_format", move || {
        virlen_core::git::branch::check_ref_format(&dir, &name)
    })
    .await
}

/// 单个提交的详情（头信息 + 完整信息 + 变更清单）。清单是**相对第一个父提交**的
/// （merge 提交相对谁看没有唯一答案）。
#[tauri::command]
pub async fn git_commit_detail(dir: String, oid: String) -> Result<CommitDetail, String> {
    blocking("commit_detail", move || {
        virlen_core::git::show::detail(&dir, &oid)
    })
    .await
}

/// 某路径在指定提交里的两侧内容（旧 = `<oid>^`，新 = `<oid>`）。按需取：一次拉整个 diff 在大提交上几十 MB。
#[tauri::command]
pub async fn git_commit_file_sides(
    dir: String,
    oid: String,
    path: String,
    orig_path: Option<String>,
    task_id: String,
) -> Result<DiffSides, String> {
    let cancel = crate::task_manager::register(&task_id);
    let result = blocking("commit_diff", move || {
        virlen_core::git::show::file_sides(
            &dir,
            &oid,
            &path,
            orig_path.as_deref(),
            Some(&cancel),
        )
    })
    .await;
    crate::task_manager::unregister(&task_id);
    result
}

/// 远程仓库列表（`git remote -v`）—— 同步浮层据此显示地址与类型（SSH / HTTPS）
#[tauri::command]
pub async fn git_remotes(dir: String) -> Result<Vec<RemoteInfo>, String> {
    blocking("remotes", move || virlen_core::git::remote::list(&dir)).await
}

/// 测试远程连接（`git ls-remote`：只读、不动本地 refs）—— 验证 SSH 密钥 / 主机指纹 / 网络
#[tauri::command]
pub async fn git_remote_test(
    dir: String,
    remote: Option<String>,
    task_id: String,
) -> Result<SyncResult, String> {
    let cancel = crate::task_manager::register(&task_id);
    let result = blocking("remote_test", move || {
        virlen_core::git::remote::test_connection(&dir, remote.as_deref(), Some(&cancel))
    })
    .await;
    crate::task_manager::unregister(&task_id);
    result
}

// ==================== 写操作（一律先过 gate） ====================

/// 获取（`git fetch`）：只更新远程跟踪分支，不动工作区
#[tauri::command]
pub async fn git_fetch(
    settings: tauri::State<'_, Arc<dyn SettingsRepo>>,
    dir: String,
    remote: Option<String>,
    task_id: String,
) -> Result<SyncResult, String> {
    let gate = gate(&settings).await;
    let cancel = crate::task_manager::register(&task_id);
    let result = blocking("fetch", move || {
        virlen_core::git::remote::fetch(&dir, &gate, remote.as_deref(), Some(&cancel))
    })
    .await;
    crate::task_manager::unregister(&task_id);
    result
}

/// 拉取（`git pull --ff-only`）：**只允许快进**，快进不了就如实失败
#[tauri::command]
pub async fn git_pull(
    settings: tauri::State<'_, Arc<dyn SettingsRepo>>,
    dir: String,
    remote: Option<String>,
    task_id: String,
) -> Result<SyncResult, String> {
    let gate = gate(&settings).await;
    let cancel = crate::task_manager::register(&task_id);
    let result = blocking("pull", move || {
        virlen_core::git::remote::pull(&dir, &gate, remote.as_deref(), Some(&cancel))
    })
    .await;
    crate::task_manager::unregister(&task_id);
    result
}

/// 推送（`git push`，无上游时自动 `-u`）。⚠️ 不提供强制推送
#[tauri::command]
pub async fn git_push(
    settings: tauri::State<'_, Arc<dyn SettingsRepo>>,
    dir: String,
    remote: Option<String>,
    task_id: String,
) -> Result<SyncResult, String> {
    let gate = gate(&settings).await;
    let cancel = crate::task_manager::register(&task_id);
    let result = blocking("push", move || {
        virlen_core::git::remote::push(&dir, &gate, remote.as_deref(), Some(&cancel))
    })
    .await;
    crate::task_manager::unregister(&task_id);
    result
}

/// 暂存（含未跟踪文件）
#[tauri::command]
pub async fn git_stage(
    settings: tauri::State<'_, Arc<dyn SettingsRepo>>,
    dir: String,
    paths: Vec<String>,
) -> Result<StatusSnapshot, String> {
    let gate = gate(&settings).await;
    blocking("stage", move || {
        virlen_core::git::stage::stage(&dir, &gate, &paths)
    })
    .await
}

/// 取消暂存（首次提交前走 `rm --cached` 兜底）
#[tauri::command]
pub async fn git_unstage(
    settings: tauri::State<'_, Arc<dyn SettingsRepo>>,
    dir: String,
    paths: Vec<String>,
) -> Result<StatusSnapshot, String> {
    let gate = gate(&settings).await;
    blocking("unstage", move || {
        virlen_core::git::stage::unstage(&dir, &gate, &paths)
    })
    .await
}

/// 丢弃改动（⚠️ 已跟踪文件的改动**不可恢复**，二次确认在界面层；未跟踪文件走回收站）
#[tauri::command]
pub async fn git_discard(
    settings: tauri::State<'_, Arc<dyn SettingsRepo>>,
    dir: String,
    paths: Vec<String>,
) -> Result<StatusSnapshot, String> {
    let gate = gate(&settings).await;
    blocking("discard", move || {
        virlen_core::git::stage::discard(&dir, &gate, &paths)
    })
    .await
}

/// 提交（信息走 stdin；hooks 照常执行，输出一并带回）
#[tauri::command]
pub async fn git_commit(
    settings: tauri::State<'_, Arc<dyn SettingsRepo>>,
    dir: String,
    message: String,
) -> Result<CommitResult, String> {
    let gate = gate(&settings).await;
    blocking("commit", move || {
        virlen_core::git::commit::commit(&dir, &gate, &message)
    })
    .await
}

/// 修改上一次提交（`--amend`：把暂存内容并入上一条，或只改提交信息）
#[tauri::command]
pub async fn git_commit_amend(
    settings: tauri::State<'_, Arc<dyn SettingsRepo>>,
    dir: String,
    message: String,
) -> Result<CommitResult, String> {
    let gate = gate(&settings).await;
    blocking("commit_amend", move || {
        virlen_core::git::commit::amend(&dir, &gate, &message)
    })
    .await
}

/// 撤销最后一次提交（`reset --soft`：**改动全留在暂存区**，不丢代码）
#[tauri::command]
pub async fn git_commit_undo_last(
    settings: tauri::State<'_, Arc<dyn SettingsRepo>>,
    dir: String,
) -> Result<StatusSnapshot, String> {
    let gate = gate(&settings).await;
    blocking("commit_undo", move || {
        virlen_core::git::commit::undo_last(&dir, &gate)
    })
    .await
}

/// 切换 / 新建并切换 / 游离到某个分支（脏工作区与目标冲突时 git 会拒绝，我们如实回传原因）
#[tauri::command]
pub async fn git_branch_switch(
    settings: tauri::State<'_, Arc<dyn SettingsRepo>>,
    dir: String,
    name: String,
    create: Option<bool>,
    start_point: Option<String>,
    detach: Option<bool>,
) -> Result<StatusSnapshot, String> {
    let gate = gate(&settings).await;
    blocking("branch_switch", move || {
        virlen_core::git::branch::switch(
            &dir,
            &gate,
            &name,
            create.unwrap_or(false),
            start_point.as_deref(),
            detach.unwrap_or(false),
        )
    })
    .await
}

/// 删除本地分支（`force = false` 时未合并的分支会被 git 拒 —— 这是安全网，不许默默改成强删）
#[tauri::command]
pub async fn git_branch_delete(
    settings: tauri::State<'_, Arc<dyn SettingsRepo>>,
    dir: String,
    name: String,
    force: Option<bool>,
) -> Result<Vec<BranchInfo>, String> {
    let gate = gate(&settings).await;
    blocking("branch_delete", move || {
        virlen_core::git::branch::delete(&dir, &gate, &name, force.unwrap_or(false))
    })
    .await
}

/// 重命名分支（新名字仍过 `check-ref-format`）
#[tauri::command]
pub async fn git_branch_rename(
    settings: tauri::State<'_, Arc<dyn SettingsRepo>>,
    dir: String,
    from: String,
    to: String,
) -> Result<Vec<BranchInfo>, String> {
    let gate = gate(&settings).await;
    blocking("branch_rename", move || {
        virlen_core::git::branch::rename(&dir, &gate, &from, &to)
    })
    .await
}

// ==================== 合并（merge） ====================

/// 是否处于「合并中」（`.git/MERGE_HEAD` 存在）。读操作：不过写门禁
#[tauri::command]
pub async fn git_merge_state(dir: String) -> Result<bool, String> {
    blocking("merge_state", move || virlen_core::git::merge::state(&dir)).await
}

/// 把某个分支合并到当前 HEAD。⚠️ 冲突时退出码 1 且工作区**已留下冲突标记**：
/// 冲突清单在 git 的 stdout 里，由 Rust 合并两股输出后整段回传（只回 stderr 等于吞掉它）。
#[tauri::command]
pub async fn git_merge(
    settings: tauri::State<'_, Arc<dyn SettingsRepo>>,
    dir: String,
    reference: String,
    no_ff: Option<bool>,
) -> Result<MergeResult, String> {
    let gate = gate(&settings).await;
    blocking("merge", move || {
        virlen_core::git::merge::merge(&dir, &gate, &reference, no_ff.unwrap_or(false))
    })
    .await
}

/// 中止进行中的合并（`merge --abort`）：工作区回到合并之前（二次确认在界面层）
#[tauri::command]
pub async fn git_merge_abort(
    settings: tauri::State<'_, Arc<dyn SettingsRepo>>,
    dir: String,
) -> Result<StatusSnapshot, String> {
    let gate = gate(&settings).await;
    blocking("merge_abort", move || {
        virlen_core::git::merge::abort(&dir, &gate)
    })
    .await
}

// ==================== 贮藏（stash） ====================

/// 贮藏列表（读；`refs/stash` 不存在 = 空数组，不是错误）
#[tauri::command]
pub async fn git_stash_list(dir: String) -> Result<Vec<StashEntry>, String> {
    blocking("stash_list", move || virlen_core::git::stash::list(&dir)).await
}

/// 新建贮藏。⚠️ 无改动 / 未诞生 HEAD / 有冲突时**在 Rust 侧就拒绝**：`git stash push` 在
/// 「没东西可贮藏」时退出码是 0，靠退出码判断会得到「提示成功但没有条目」。
/// `paths` = 只贮藏这些路径的改动（仓库根相对）；**缺省 / 空数组 = 全部**。
#[tauri::command]
pub async fn git_stash_push(
    settings: tauri::State<'_, Arc<dyn SettingsRepo>>,
    dir: String,
    message: Option<String>,
    include_untracked: Option<bool>,
    keep_index: Option<bool>,
    paths: Option<Vec<String>>,
) -> Result<StashResult, String> {
    let gate = gate(&settings).await;
    blocking("stash_push", move || {
        virlen_core::git::stash::push(
            &dir,
            &gate,
            message.as_deref(),
            include_untracked.unwrap_or(false),
            keep_index.unwrap_or(false),
            paths.as_deref().unwrap_or(&[]),
        )
    })
    .await
}

/// 应用 / 应用并删除（`pop`）。⚠️ 条目身份是 oid：`stash@{n}` 由 Rust 在**仓库锁内**解析，
/// 前端不许传 selector（它是列表位置，会随外部操作漂移）。
#[tauri::command]
pub async fn git_stash_apply(
    settings: tauri::State<'_, Arc<dyn SettingsRepo>>,
    dir: String,
    oid: String,
    restore_index: Option<bool>,
    pop: Option<bool>,
) -> Result<StashResult, String> {
    let gate = gate(&settings).await;
    blocking("stash_apply", move || {
        virlen_core::git::stash::apply(
            &dir,
            &gate,
            &oid,
            restore_index.unwrap_or(false),
            pop.unwrap_or(false),
        )
    })
    .await
}

/// 删除一条贮藏（⚠️ 破坏性：二次确认在界面层）。返回被删的那条供「撤销删除」。
#[tauri::command]
pub async fn git_stash_drop(
    settings: tauri::State<'_, Arc<dyn SettingsRepo>>,
    dir: String,
    oid: String,
) -> Result<StashDropResult, String> {
    let gate = gate(&settings).await;
    blocking("stash_drop", move || {
        virlen_core::git::stash::drop(&dir, &gate, &oid)
    })
    .await
}

/// 把删掉的贮藏放回列表顶部（`git stash store`）—— 界面上的「撤销删除」
#[tauri::command]
pub async fn git_stash_restore(
    settings: tauri::State<'_, Arc<dyn SettingsRepo>>,
    dir: String,
    oid: String,
    message: String,
) -> Result<Vec<StashEntry>, String> {
    let gate = gate(&settings).await;
    blocking("stash_restore", move || {
        virlen_core::git::stash::restore(&dir, &gate, &oid, &message)
    })
    .await
}
