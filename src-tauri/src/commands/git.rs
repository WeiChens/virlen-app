//! git —— 源代码管理（GUI 壳）。
//!
//! 这里只做三件事：**参数兜底**、**写操作准入判定**（只读沙盒模式 fail-closed，见
//! `virlen_core::git::WriteGate`）、**转交 `virlen_core::git`**。业务语义一行都不在这层。
//!
//! ⚠️ 新增命令必须登记到 `lib.rs` 的 `tauri::generate_handler![...]`（铁律 4），否则 `invoke` 静默 404。
//! ⚠️ 各命令的 `dir` 参数语义 = **工作目录**（可以是仓库的任意子目录）：路径基准由
//!    `virlen_core::git::repo::root_of` 统一到仓库根，**本层不做任何路径拼接**（§11.53 ⑫）。
//! ⚠️ 埋点只报「动作 / 结果 / 退出码 / 耗时」：**不报仓库路径、分支名、提交信息正文**
//!    （remote URL 与提交信息都可能是敏感数据，见 `docs/git-management-plan.md` §6）。
//!
//! 方案与全部坑：`docs/git-management-plan.md`。

use serde_json::json;
use std::sync::Arc;
use virlen_core::git::cli::GitError;
use virlen_core::git::{
    BranchInfo, CommitLogEntry, CommitResult, DiffScope, DiffSides, RepoInfo, StatusSnapshot,
    WriteGate,
};
use virlen_core::session_db::SettingsRepo;

/// 把阻塞的 git 调用挪到阻塞线程池 —— git 是「子进程 + 阻塞读管道」，不许占着 async 线程。
///
/// 埋点收口在这里：一次命令一条 `git.op`，只带动作名 / 是否成功 / 退出码 / 耗时。
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

/// 分支列表（本地 + 远程，已在 Rust 侧排好序）
#[tauri::command]
pub async fn git_branches(dir: String) -> Result<Vec<BranchInfo>, String> {
    blocking("branches", move || virlen_core::git::branch::list(&dir)).await
}

/// 提交记录（从 HEAD 往回；`skip` 由界面「加载更多」推进，Rust 侧不缓存）
#[tauri::command]
pub async fn git_log(
    dir: String,
    skip: u32,
    limit: u32,
    task_id: String,
) -> Result<Vec<CommitLogEntry>, String> {
    let cancel = crate::task_manager::register(&task_id);
    let result = blocking("log", move || {
        virlen_core::git::log::log(&dir, skip, limit, Some(&cancel))
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

// ==================== 写操作（一律先过 gate） ====================

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

/// 切换 / 新建并切换分支（脏工作区与目标冲突时 git 会拒绝，我们如实回传原因）
#[tauri::command]
pub async fn git_branch_switch(
    settings: tauri::State<'_, Arc<dyn SettingsRepo>>,
    dir: String,
    name: String,
    create: Option<bool>,
    start_point: Option<String>,
) -> Result<StatusSnapshot, String> {
    let gate = gate(&settings).await;
    blocking("branch_switch", move || {
        virlen_core::git::branch::switch(
            &dir,
            &gate,
            &name,
            create.unwrap_or(false),
            start_point.as_deref(),
        )
    })
    .await
}
