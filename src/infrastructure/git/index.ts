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
 * `taskId` ↔ `task_id`、`origPath` ↔ `orig_path`、`startPoint` ↔ `start_point`。
 *
 * 方案与坑：`docs/git-management-plan.md`。
 */
import { invoke } from '@tauri-apps/api/core'
import type {
  GitBranchInfo,
  GitCommitLogEntry,
  GitCommitResult,
  GitDiffScope,
  GitDiffSides,
  GitRepoInfo,
  GitStatusSnapshot,
} from '@/domain/git'

/** 是否 Tauri 环境（浏览器 dev / vitest 下没有这些命令） */
export function isGitEnvAvailable(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** 探测目录是不是 git 仓库；`null` = **不是仓库**（正常结果，界面给空态）；git 不存在时抛错 */
export function repoInfo(dir: string): Promise<GitRepoInfo | null> {
  return invoke<GitRepoInfo | null>('git_repo_info', { dir })
}

/** 状态快照（`taskId` 供超大仓库取消；取消用既有的 `stop_task` 命令） */
export function status(dir: string, taskId: string): Promise<GitStatusSnapshot> {
  return invoke<GitStatusSnapshot>('git_status', { dir, taskId })
}

/** 分支列表（Rust 侧已排好序：当前分支 → 本地 → 远程） */
export function branches(dir: string): Promise<GitBranchInfo[]> {
  return invoke<GitBranchInfo[]>('git_branches', { dir })
}

/** 一页提交记录（`skip` = 已经拿过多少条；`taskId` 供超大仓库取消） */
export function log(
  dir: string,
  skip: number,
  limit: number,
  taskId: string,
): Promise<GitCommitLogEntry[]> {
  return invoke<GitCommitLogEntry[]>('git_log', { dir, skip, limit, taskId })
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

/** 分支名合法性 —— 权威判定在 Rust（`git check-ref-format`），前端不许自己写正则 */
export function checkRefFormat(dir: string, name: string): Promise<boolean> {
  return invoke<boolean>('git_check_ref_format', { dir, name })
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

export function switchBranch(
  dir: string,
  name: string,
  create: boolean,
  startPoint: string | null,
): Promise<GitStatusSnapshot> {
  return invoke<GitStatusSnapshot>('git_branch_switch', {
    dir,
    name,
    create,
    startPoint,
  })
}

/** 通知 Rust 中断一个还在跑的读操作（与既有搜索 / 目录树同一套 `task_manager`） */
export function stopTask(taskId: string): void {
  void invoke('stop_task', { taskId }).catch(() => {})
}
