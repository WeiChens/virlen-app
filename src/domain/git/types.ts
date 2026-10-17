/**
 * git 跨层类型（与 Rust virlen-core/src/git/mod.rs 的 serde 结构逐字对应）。
 *
 * ⚠️ 两个方向不要搞混：字段名是 snake_case（Rust 无 rename_all）；命令参数名是 camelCase
 *（Tauri v2 默认转换）。
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

/** 一条变更。x = 已暂存侧、y = 未暂存侧，`.` = 未改动 */
export interface GitChangeEntry {
  path: string
  /** rename / copy 的旧路径 */
  orig_path: string | null
  x: string
  y: string
  kind: GitEntryKind
}

/** 分支头（(initial) → oid = null；(detached) → branch = null） */
export interface GitHeadInfo {
  oid: string | null
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
}

/** 状态快照。truncated = true 表示条目被上限截断（界面必须提示，不许假装完整） */
export interface GitStatusSnapshot {
  head: GitHeadInfo
  entries: GitChangeEntry[]
  truncated: boolean
}

/** 差异基准：未暂存（工作区 vs index）/ 已暂存（index vs HEAD） */
export type GitDiffScope = 'worktree' | 'index'

/**
 * 提交记录的取数范围。
 * ⚠️ all 不是 `git log --all`：那个会把 refs/stash 的 WIP 提交也带上。
 */
export type GitLogScope = 'head' | 'all'

/**
 * 差异的两侧内容（null = 空侧：新增 / 未跟踪的左侧、删除的右侧）。
 * ⚠️ 是文件原始字节，未经 .gitattributes 的 filter / textconv。
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
  /** git 完整输出（stdout 的提交摘要 + stderr） */
  output: string
  /**
   * git 的 stderr（正常提交为空；hooks 与警告写在这里）。面板的「提交输出」块只看它：
   * output 里还有「[main abc] msg / 1 file changed」这类每次提交都有的话，一律展示就是噪声。
   */
  stderr: string
}

/** 提交里的一条文件变更（Rust `git::CommitFile`，`--name-status` 的忠实映射） */
export interface GitCommitFile {
  path: string
  /** rename / copy 的旧路径 */
  orig_path: string | null
  /** git 自己的状态字母：A 新增 / M 修改 / D 删除 / R 改名 / C 复制 / T 类型变更 */
  status: string
}

/** 单个提交的详情（Rust `git::CommitDetail`） */
export interface GitCommitDetail {
  oid: string
  short_oid: string
  author_name: string
  author_email: string
  /** %aI（原始时区，展示成本地时间是前端的口径） */
  author_time: string
  /** 完整提交信息（标题 + 正文），不是列表里的单行标题 */
  message: string
  parents: string[]
  /** ⚠️ 相对第一个父提交的变更（merge 提交相对谁看没有唯一答案） */
  files: GitCommitFile[]
}

/** 一条提交记录（`git log` 的忠实映射） */
export interface GitCommitLogEntry {
  /** 完整 oid（40 位）—— 悬停提示与后续「复制 hash」用它 */
  oid: string
  /** 短 oid（git 自己按仓库规模定的长度，前端不自己截） */
  short_oid: string
  author_name: string
  author_email: string
  /** %aI = ISO 8601 strict，带作者当时的时区偏移 */
  author_time: string
  /**
   * %P：父提交 oid（merge 有多个、root 为空数组）。提交图的连线只认它。
   */
  parents: string[]
  /**
   * %D（--decorate=full）：指向本提交的引用全名，形如 refs/heads/master、
   * refs/remotes/origin/master、tag: refs/tags/v1.1.55、HEAD -> refs/heads/master。
   * 拆解口径在 domain/git/graph.ts::parseCommitRefs。
   */
  refs: string[]
  /** %s = 提交标题（单行：git 已把信息首段的换行折成空格） */
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
  /** upstream 被删了（[gone]）—— 与「没有 upstream」不是一回事 */
  upstream_gone: boolean
  /** 最后一条提交的标题 */
  subject: string
  updated_at: string | null
}

/** 一个文件的行数统计（`git diff --numstat`）。`added` / `deleted` 为 `null` = 数不出来（二进制 / 过大） */
export interface GitFileStat {
  /** 当前路径（rename / copy 用新路径，与变更条目的 `path` 对齐） */
  path: string
  /** rename / copy 的旧路径 */
  orig_path: string | null
  added: number | null
  deleted: number | null
}

/** 一次行数统计：两个对比基准各一份（未跟踪文件在 `worktree` 里 = 全文新增） */
export interface GitStatReport {
  /** INDEX ↔ HEAD（已暂存段） */
  staged: GitFileStat[]
  /** 工作区 ↔ INDEX（未暂存段，含未跟踪） */
  worktree: GitFileStat[]
}

/**
 * 远程地址的种类。只用于展示与提示，不参与任何认证决策 —— 凭据策略固定是 SSH。
 */
export type GitRemoteKind = 'ssh' | 'https' | 'http' | 'git' | 'file' | 'other'

/** 一个远程仓库（`git remote -v`，同名 fetch / push 已合并） */
export interface GitRemoteInfo {
  name: string
  /** fetch 地址。⚠️ 已抹掉 userinfo（令牌不会进界面） */
  url: string
  push_url: string
  kind: GitRemoteKind
}

/** 一次网络操作（fetch / pull / push / ls-remote）的结果 */export interface GitSyncResult {
  remote: string
  /** 实际用的地址（同样已抹掉 userinfo） */
  url: string
  /** 操作所在的分支（fetch 不要求分支 → null） */
  branch: string | null
  /** git 的原始输出（stdout + stderr 合并，过长时由 Rust 截断） */
  output: string
}
