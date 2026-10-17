/**
 * git — 源代码管理的数据入口（唯一）。
 *
 * 只做两件事：**调命令**、**把 Rust 的错误原样带出来**。
 * 这里**不缓存任何状态**（权威在 git 自己 + Rust 侧的串行队列）：界面每次都拿新快照，
 * 免得用户在编辑器 / 终端里改了文件之后，面板还在展示一份过期的「干净」。
 *
 * 错误语义分两类（调用方必须区别对待）：
 * - **用户主动的操作**（暂存 / 提交 / 丢弃 / 切换分支）：失败**向上抛** —— 静默失败会让人以为已经生效；
 * - **旁路读取**（探测 / 分支列表）：失败由 `git-service` 兜成空态，不打断页面。
 *
 * ⚠️ 参数名一律 camelCase（Tauri v2 的默认转换，Rust 侧是 snake_case）：
 * `taskId` ↔ `task_id`、`origPath` ↔ `orig_path`、`startPoint` ↔ `start_point`、`detach` ↔ `detach`。
 *
 * 方案与坑：`docs/git-management-plan.md`。
 */
import { invoke } from '@tauri-apps/api/core'
import type {
  GitBranchInfo,
  GitCommitDetail,
  GitCommitLogEntry,
  GitCommitResult,
  GitDiffScope,
  GitDiffSides,
  GitLogScope,
  GitRemoteInfo,
  GitRepoInfo,
  GitStatusSnapshot,
  GitSyncResult,
} from '@/domain/git'

/** 是否 Tauri 环境（浏览器 dev / vitest 下没有这些命令） */
export function isGitEnvAvailable(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** 探测目录是不是 git 仓库；`null` = **不是仓库**（正常结果，界面给空态）；git 不存在时抛错 */
export function repoInfo(dir: string): Promise<GitRepoInfo | null> {
  return invoke<GitRepoInfo | null>('git_repo_info', { dir })
}

/** 在当前目录初始化仓库（面板在「不是仓库」时的唯一出口） */
export function initRepo(dir: string): Promise<GitRepoInfo> {
  return invoke<GitRepoInfo>('git_init', { dir })
}

/** 状态快照（`taskId` 供超大仓库取消；取消用既有的 `stop_task` 命令） */
export function status(dir: string, taskId: string): Promise<GitStatusSnapshot> {
  return invoke<GitStatusSnapshot>('git_status', { dir, taskId })
}

/** 分支列表（Rust 侧已排好序：当前分支 → 本地 → 远程） */
export function branches(dir: string): Promise<GitBranchInfo[]> {
  return invoke<GitBranchInfo[]>('git_branches', { dir })
}

/** 一页提交记录（`skip` = 已经拿过多少条；`scope` = head / all；`taskId` 供超大仓库取消） */
export function log(
  dir: string,
  skip: number,
  limit: number,
  scope: GitLogScope,
  taskId: string,
): Promise<GitCommitLogEntry[]> {
  return invoke<GitCommitLogEntry[]>('git_log', { dir, skip, limit, scope, taskId })
}

/** 差异的两侧内容 */
export function diffSides(
  dir: string,
  path: string,
  scope: GitDiffScope,
  origPath: string | null,
  taskId: string,
): Promise<GitDiffSides> {
  return invoke<GitDiffSides>('git_diff_sides', {
    dir,
    path,
    scope,
    origPath,
    taskId,
  })
}

/** 单个提交的详情（头信息 + 完整提交信息 + **相对第一个父提交**的变更文件清单） */
export function commitDetail(dir: string, oid: string): Promise<GitCommitDetail> {
  return invoke<GitCommitDetail>('git_commit_detail', { dir, oid })
}

/** 某条路径**在那个提交里**的两侧内容（旧 = `<oid>^`，新 = `<oid>`） */
export function commitFileSides(
  dir: string,
  oid: string,
  path: string,
  origPath: string | null,
  taskId: string,
): Promise<GitDiffSides> {
  return invoke<GitDiffSides>('git_commit_file_sides', {
    dir,
    oid,
    path,
    origPath,
    taskId,
  })
}

/** 分支名合法性 —— 权威判定在 Rust（`git check-ref-format`），前端不许自己写正则 */
export function checkRefFormat(dir: string, name: string): Promise<boolean> {
  return invoke<boolean>('git_check_ref_format', { dir, name })
}

// ==================== 远程（凭据策略 = SSH） ====================

/** 远程列表（`git remote -v`） */
export function remotes(dir: string): Promise<GitRemoteInfo[]> {
  return invoke<GitRemoteInfo[]>('git_remotes', { dir })
}

/**
 * 测试远程连接（`git ls-remote`：只读、不动本地 refs）。
 * SSH 方案下这是唯一能验证「密钥 / 主机指纹 / 网络」的入口。
 */
export function testRemote(
  dir: string,
  remote: string | null,
  taskId: string,
): Promise<GitSyncResult> {
  return invoke<GitSyncResult>('git_remote_test', { dir, remote, taskId })
}

/** `git fetch`：只更新远程跟踪分支，不动工作区 */
export function fetchRemote(
  dir: string,
  remote: string | null,
  taskId: string,
): Promise<GitSyncResult> {
  return invoke<GitSyncResult>('git_fetch', { dir, remote, taskId })
}

/** `git pull --ff-only`：**只允许快进**，快进不了就失败（不许自动 merge） */
export function pullRemote(
  dir: string,
  remote: string | null,
  taskId: string,
): Promise<GitSyncResult> {
  return invoke<GitSyncResult>('git_pull', { dir, remote, taskId })
}

/** `git push`（无上游时 Rust 侧自动 `-u`）。⚠️ 不提供强制推送 */
export function pushRemote(
  dir: string,
  remote: string | null,
  taskId: string,
): Promise<GitSyncResult> {
  return invoke<GitSyncResult>('git_push', { dir, remote, taskId })
}

// ==================== 写操作（Rust 侧过只读沙盒门禁） ====================

export function stage(dir: string, paths: string[]): Promise<GitStatusSnapshot> {
  return invoke<GitStatusSnapshot>('git_stage', { dir, paths })
}

export function unstage(dir: string, paths: string[]): Promise<GitStatusSnapshot> {
  return invoke<GitStatusSnapshot>('git_unstage', { dir, paths })
}

/** ⚠️ 已跟踪文件的改动**不可恢复**；未跟踪文件走回收站 */
export function discard(dir: string, paths: string[]): Promise<GitStatusSnapshot> {
  return invoke<GitStatusSnapshot>('git_discard', { dir, paths })
}

export function commit(dir: string, message: string): Promise<GitCommitResult> {
  return invoke<GitCommitResult>('git_commit', { dir, message })
}

/** 修改上一次提交（`--amend`：把暂存内容并入上一条，或只改提交信息） */
export function commitAmend(dir: string, message: string): Promise<GitCommitResult> {
  return invoke<GitCommitResult>('git_commit_amend', { dir, message })
}

/** 撤销最后一次提交（`reset --soft`：**改动全留在暂存区**，不丢代码） */
export function undoLastCommit(dir: string): Promise<GitStatusSnapshot> {
  return invoke<GitStatusSnapshot>('git_commit_undo_last', { dir })
}

export function switchBranch(
  dir: string,
  name: string,
  create: boolean,
  startPoint: string | null,
  detach: boolean,
): Promise<GitStatusSnapshot> {
  return invoke<GitStatusSnapshot>('git_branch_switch', {
    dir,
    name,
    create,
    startPoint,
    detach,
  })
}

/** 删除本地分支（`force = false` 时未合并的分支会被 git 拒）；返回刷新后的分支列表 */
export function deleteBranch(
  dir: string,
  name: string,
  force: boolean,
): Promise<GitBranchInfo[]> {
  return invoke<GitBranchInfo[]>('git_branch_delete', { dir, name, force })
}

/** 重命名分支；返回刷新后的分支列表 */
export function renameBranch(
  dir: string,
  from: string,
  to: string,
): Promise<GitBranchInfo[]> {
  return invoke<GitBranchInfo[]>('git_branch_rename', { dir, from, to })
}

/** 通知 Rust 中断一个还在跑的读操作（与既有搜索 / 目录树同一套 `task_manager`） */
export function stopTask(taskId: string): void {
  void invoke('stop_task', { taskId }).catch(() => {})
}
