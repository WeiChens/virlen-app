/**
 * git — 跨层类型（与 Rust `virlen-core/src/git/mod.rs` 的 serde 结构**逐字对应**）。
 *
 * ⚠️ 两个方向的命名不要搞混（踩过就知道）：
 * - **字段名**：Rust 侧结构体没加 `rename_all`，所以 JSON 里是 **snake_case**（`git_dir` / `orig_path`）；
 * - **命令参数名**：Tauri 命令的入参在 JS 侧一律写成 **camelCase**（`taskId` ↔ Rust `task_id`）——
 *   这是 Tauri v2 的默认转换，本项目既有命令（`stop_task` / `cmd_list_background_services`）都这么用。
 */

/** git 能力集（按版本探测）—— 用于降级 */
export interface GitCaps {
  porcelain_v2: boolean
  switch: boolean
  restore: boolean
}

/** 仓库探测结果 */
export interface GitRepoInfo {
  /** 工作区根（正斜杠） */
  root: string
  git_dir: string
  bare: boolean
  /** `git --version` 的版本号部分 */
  version: string
  caps: GitCaps
}

/** 变更类型（porcelain=v2 的记录种类） */
export type GitEntryKind =
  | 'ordinary'
  | 'renamed'
  | 'copied'
  | 'unmerged'
  | 'untracked'

/** 一条变更。`x` = index vs HEAD（已暂存侧）、`y` = worktree vs index（未暂存侧），`.` = 未改动 */
export interface GitChangeEntry {
  path: string
  /** rename / copy 的旧路径 */
  orig_path: string | null
  x: string
  y: string
  kind: GitEntryKind
}

/** 分支头（`(initial)` → `oid = null`；`(detached)` → `branch = null`） */
export interface GitHeadInfo {
  oid: string | null
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
}

/** 状态快照。`truncated = true` 表示条目被上限截断（界面必须提示，不许假装完整） */
export interface GitStatusSnapshot {
  head: GitHeadInfo
  entries: GitChangeEntry[]
  truncated: boolean
}

/** 差异基准：未暂存（工作区 vs index）/ 已暂存（index vs HEAD） */
export type GitDiffScope = 'worktree' | 'index'

/**
 * 差异的两侧内容（`null` = 空侧：新增 / 未跟踪的左侧、删除的右侧）。
 * ⚠️ 是文件原始字节，未经 `.gitattributes` 的 filter / textconv（见方案 §5.3 / §11.3）。
 */
export interface GitDiffSides {
  old_text: string | null
  new_text: string | null
  old_label: string
  new_label: string
  binary: boolean
  truncated: boolean
}

/** 一次提交的结果 */
export interface GitCommitResult {
  oid: string
  summary: string
  /** git 原始输出（含 hooks 的 stdout / stderr）—— 要能看见它 */
  output: string
}

/** 一条提交记录（`git log` 的忠实映射，与 Rust `git::CommitLogEntry` **逐字对应**） */
export interface GitCommitLogEntry {
  /** 完整 oid（40 位）—— 悬停提示与后续「复制 hash」用它 */
  oid: string
  /** 短 oid（git 自己按仓库规模定的长度，前端**不自己截**） */
  short_oid: string
  author_name: string
  author_email: string
  /** `%aI` = ISO 8601 strict，带**作者当时**的时区偏移（展示成什么时间是前端的口径） */
  author_time: string
  /** `%s` = 提交标题（**单行**：git 已把信息首段的换行折成空格） */
  subject: string
}

/** 一个分支（本地 / 远程） */
export interface GitBranchInfo {
  name: string
  is_remote: boolean
  is_head: boolean
  upstream: string | null
  ahead: number
  behind: number
  /** upstream 被删了（`[gone]`）—— 与「没有 upstream」不是一回事 */
  upstream_gone: boolean
  /** 最后一条提交的标题 */
  subject: string
  updated_at: string | null
}
