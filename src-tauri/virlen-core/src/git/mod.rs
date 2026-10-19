//! git —— 源代码管理（图形化 Git）的核心实现，**零 `tauri::`**：`git` 子进程驱动 + 输出解析 + 纯逻辑。
//! GUI（`virlen-app/src/commands/git.rs`）与未来的 CLI 共用这一份。
//!
//! **为什么是 `git` 子进程而不是 git 库（`git2` / `gix`）**：见 `docs/git-management-plan.md` §2.1。
//! 一句话 —— 本 App 的 AI 一直用 `execute_command` 跑真 git，`git` 已是既有运行环境依赖；
//! 换库会引入「界面一套、AI / 终端另一套」的语义分叉（hooks / credential helper / filter 全不一致）。
//!
//! ⚠️ 一切 git 子进程只经 [`cli::GitCmd`]，不得在别处 `Command::new("git")` —— 环境姿势、超时、
//! 取消、进程树回收、写操作串行都在那里。
//!
//! ⚠️ **路径基准**：命令的 cwd 一律 = **仓库根**（[`repo::root_of`]），对外展示与回传的路径一律
//! = **仓库根相对**（`status` 的 `-z` 就是这个口径的开关，见 [`status::snapshot_at_root`]）。
//! 公开接口一律接受「仓库内的任意目录」作为 `dir`。写操作按 **cwd** 解释路径 —— 没切到根就会得到
//! 「界面上有这条路径、git 却说 did not match」（退出码 128，见 `docs/agents/14-git-management.md` §11.53 ⑫）。
//!
//! 读输出的三条口径：
//! 1. stdout 保留原始字节，解码用 lossy UTF-8（**不猜 GBK**，猜错会写坏路径）；
//! 2. stderr 原样透传给用户，**不解析它做分支判断**（分类靠前置探测 + 退出码）；
//! 3. 所有解析都是纯函数（`parse_status` 等），真仓库的端到端由 `tests.rs` 钉住。

pub mod branch;
pub mod cli;
pub mod commit;
pub mod diff;
pub mod lock;
pub mod log;
pub mod merge;
pub mod numstat;
pub mod remote;
pub mod repo;
pub mod show;
pub mod stage;
pub mod stash;
pub mod status;

#[cfg(test)]
mod tests;

use serde::{Deserialize, Serialize};

/// git 能力集（按 `git --version` 探测）—— 用于**降级**：`switch` / `restore` 要 ≥ 2.23，
/// `porcelain=v2` 要 ≥ 2.11。低于下限时按方案 §7 第 7 条处理（降级或明确提示）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct GitCaps {
    pub porcelain_v2: bool,
    pub switch: bool,
    pub restore: bool,
}

/// 仓库探测结果（`None` = 这个目录不是仓库，或本机没有 git）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepoInfo {
    /// 工作区根（正斜杠）；bare 仓库回退成 git 目录
    pub root: String,
    /// `.git` 目录（worktree / 子模块下与 `root` 不同，P1 只如实展示）
    pub git_dir: String,
    pub bare: bool,
    /// `git --version` 的版本号部分（如 `2.55.0.windows.5`）
    pub version: String,
    pub caps: GitCaps,
}

/// 一条变更的类型（porcelain=v2 的记录种类，**忠实映射**，不做 UI 归类）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    /// 类型 `1`：普通变更
    Ordinary,
    /// 类型 `2` 且 X 为 `R`
    Renamed,
    /// 类型 `2` 且 X 为 `C`
    Copied,
    /// 类型 `u`：未合并（冲突）
    Unmerged,
    /// 类型 `?`
    Untracked,
}

/// 一条变更。
///
/// `x` = index vs HEAD（已暂存侧），`y` = worktree vs index（未暂存侧），`.` = 未改动 ——
/// **分组是前端的纯函数**（`src/domain/git/group.ts`），Rust 只忠实回传这两个字母。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChangeEntry {
    pub path: String,
    /// rename / copy 的旧路径（只有类型 `2` 有）
    pub orig_path: Option<String>,
    pub x: char,
    pub y: char,
    pub kind: EntryKind,
}

/// 分支头（`git status --branch` 的 `# branch.*` 四行）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HeadInfo {
    /// `(initial)`（尚无提交）→ `None`
    pub oid: Option<String>,
    /// `(detached)` → `None`
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
}

/// 一次状态快照。**注意 entry 数量上限**（[`status::MAX_ENTRIES`]）：未跟踪目录巨大的仓库
/// （没配 `.gitignore` 的 `node_modules`）会把列表撑爆，截断时 `truncated = true`，界面要如实提示。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatusSnapshot {
    pub head: HeadInfo,
    pub entries: Vec<ChangeEntry>,
    pub truncated: bool,
}

/// 差异的两种对比基准（第三种「未跟踪」= 空 ↔ 全文，不单列）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DiffScope {
    /// 未暂存的改动：工作区 vs index
    Worktree,
    /// 已暂存的改动：index vs HEAD
    Index,
}

/// 提交记录的取数范围。
///
/// ⚠️ 这里的 `All` **不是** `git log --all`：那个按文档口径会带上 `refs/` 下的**全部**引用，
/// 其中包含 `refs/stash` —— stash 的 WIP 提交有 2–3 个父，画进提交图不是「分支」而是一团乱麻。
/// 我们用 `--branches --tags --remotes HEAD`（= 本地分支 + 远程跟踪分支 + 标签 + HEAD）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogScope {
    /// 只有 HEAD 可达的提交（「提交记录」弹窗）
    Head,
    /// 全部分支 / 标签（「提交图」弹窗，见 [`log`]）
    All,
}

/// 差异的两侧内容（`None` = 空侧：新增 / 未跟踪的左侧、删除的右侧）。
///
/// ⚠️ 这是**文件原始字节**，没走 `.gitattributes` 的 filter / textconv（见方案 §5.3 / §11.3）：
/// LFS 指针文件会显示成指针文本，而不是它指向的真实内容。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiffSides {
    pub old_text: Option<String>,
    pub new_text: Option<String>,
    pub old_label: String,
    pub new_label: String,
    /// 任一侧是二进制（前 8000 字节含 NUL，git 自己的 `buffer_is_binary` 口径）→ 不拉正文
    pub binary: bool,
    /// 单侧内容超过 [`diff::MAX_SIDE_CHARS`] 被截断
    pub truncated: bool,
}

/// 一个文件的行数统计（`git diff --numstat`）。
///
/// `added` / `deleted` 为 `None` = 数不出来（二进制 / 未跟踪文件过大）—— 界面显示「—」，**不当时 0**。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileStat {
    /// 当前路径（rename / copy 用新路径，与 [`ChangeEntry::path`] 对齐）
    pub path: String,
    /// rename / copy 的旧路径
    pub orig_path: Option<String>,
    pub added: Option<u32>,
    pub deleted: Option<u32>,
}

/// 一次行数统计：两个对比基准各一份（含未跟踪文件，它们在 `worktree` 里）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct StatReport {
    /// INDEX ↔ HEAD
    pub staged: Vec<FileStat>,
    /// 工作区 ↔ INDEX（含未跟踪 = 全文新增）
    pub worktree: Vec<FileStat>,
}

/// 一次提交的结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitResult {
    pub oid: String,
    pub summary: String,
    /// git 的完整输出（stdout 的提交摘要 + stderr）—— 悬停 / 排查时可看
    pub output: String,
    /// **git 的 stderr**（正常提交为空；hooks 与警告写在这里）。
    ///
    /// 单独回一个字段而不是让界面从 `output` 里猜：`output` 把两路合并了，正常提交也有「[main abc] msg
    /// 1 file changed」这几行 —— 界面若一律展示就是每次提交都贴一段噪声，一律不展示则 hooks 的输出又
    /// 永远看不见（§5.5：用户得看得见 hook 动了什么）。
    pub stderr: String,
}

/// 一条提交记录（`git log` 的忠实映射，见 [`log`]）。
///
/// 字段名与 git 的 pretty 占位符一一对应：`oid`=`%H`、`short_oid`=`%h`、`author_name`=`%an`、
/// `author_email`=`%ae`、`author_time`=`%aI`（ISO 8601 strict，带时区）、`parents`=`%P`、
/// `refs`=`%D`、`subject`=`%s`（单行）。
/// ⚠️ **只回标题不回正文**：列表要的不是整段信息，正文要看时再单独取（见 [`log`] 模块头）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommitLogEntry {
    pub oid: String,
    pub short_oid: String,
    pub author_name: String,
    pub author_email: String,
    /// `%aI`：`2026-10-16T10:29:46+08:00`（**原始时区**，展示时的本地化是前端的口径）
    pub author_time: String,
    /// `%P`：父提交 oid（**空格分隔**，merge 有多个、root 为空数组）。提交图的连线只认它。
    pub parents: Vec<String>,
    /// `%D`（配 `--decorate=full`）：指向本提交的引用**全名**，如 `refs/heads/master` /
    /// `refs/remotes/origin/master` / `refs/tags/v1.1.55`；指向 HEAD 的那条形如
    /// `HEAD -> refs/heads/master`（拆解与展示口径在前端，Rust 只忠实回传）。
    /// ⚠️ 取全名而不是短名：短名有歧义 —— 本地分支名**可以**含 `/`（本仓库就有
    /// `feat/0914-responses-api`），光看 `origin/master` 分不出本地分支还是远程跟踪分支。
    pub refs: Vec<String>,
    pub subject: String,
}

/// 提交里的一条文件变更（`--name-status` 的忠实映射）。
///
/// `status` 是 git 自己的字母（`A` 新增 / `M` 修改 / `D` 删除 / `R` 改名 / `C` 复制 / `T` 类型变更），
/// **不做界面归类** —— 归类是前端的纯函数（与 status 的 `x` / `y` 同一取舍）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommitFile {
    pub path: String,
    /// rename / copy 的旧路径（只在这两种状态上有）
    pub orig_path: Option<String>,
    pub status: char,
}

/// 单个提交的详情（[`show::detail`]）。
///
/// ⚠️ `files` 是**相对第一个父提交**的差异 —— merge 提交相对谁看没有唯一答案，选第一个父是
/// 界面上唯一能说清楚的口径（见 [`show`] 模块头口径 1）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitDetail {
    pub oid: String,
    pub short_oid: String,
    pub author_name: String,
    pub author_email: String,
    /// `%aI`：与 [`CommitLogEntry::author_time`] 同口径（原始时区，本地化是前端的事）
    pub author_time: String,
    /// **完整**提交信息（`%B`，标题 + 正文），不是列表里的单行标题
    pub message: String,
    pub parents: Vec<String>,
    pub files: Vec<CommitFile>,
}

/// 一个分支（本地 / 远程）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BranchInfo {
    pub name: String,
    pub is_remote: bool,
    pub is_head: bool,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    /// upstream 被删了（`[gone]`）—— 与「没有 upstream」不是一回事，界面要分开说
    pub upstream_gone: bool,
    pub subject: String,
    /// `committerdate:iso-strict`
    pub updated_at: Option<String>,
}

/// 远程地址的种类。
///
/// **只用于展示与给提示**（浮层里标一个「SSH」/「HTTPS」，以及 https 失败时改成 SSH 的指引），
/// **不参与任何认证决策** —— 本应用的凭据策略固定是 SSH，见 [`remote`] 模块头。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RemoteKind {
    /// `git@host:owner/repo.git` 或 `ssh://…`
    Ssh,
    Https,
    Http,
    /// `git://`（无认证、已被 git 弃用）
    Git,
    /// 本地路径 / `file://`（裸仓库、测试、局域网共享）
    File,
    Other,
}

/// 一个远程仓库（`git remote -v` 的忠实映射：同名 fetch / push 合并成一条）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoteInfo {
    pub name: String,
    /// fetch 地址。⚠️ **已抹掉 userinfo**（`https://user:token@host/…` → `https://host/…`）——
    /// 它要显示在界面上，令牌绝不能跟着走（安全红线：界面 / 日志不得出现密钥）。
    pub url: String,
    pub push_url: String,
    pub kind: RemoteKind,
}

/// 一次网络操作（fetch / pull / push / ls-remote）的结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncResult {
    pub remote: String,
    /// 实际使用的远程地址（同上，已抹掉 userinfo）
    pub url: String,
    /// 操作所在的分支（fetch 不要求分支 → `None`）
    pub branch: Option<String>,
    /// git 的原始输出（stdout + stderr 合并，过长时截断）—— 进度 / 摘要 / 警告都在这里，
    /// **不解析它做分支判断**（与全模块同一口径）
    pub output: String,
}

/// 一次合并的结果（见 [`merge`]）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MergeResult {
    /// 合并后（冲突时是「合并中」）的快照 —— 一次 IPC 拿全，界面不再回读
    pub snapshot: StatusSnapshot,
    /// git 的原始输出（stdout + stderr 合并）：快进摘要 / `Already up to date` / 合并提交头都在里面
    pub output: String,
    /// HEAD 没动 = 「已是最新」（`Already up to date`）；靠 oid 判，**不解析输出文本**
    pub up_to_date: bool,
    /// 快进（HEAD 直接落到被合并的那个提交，没有生成合并提交）
    pub fast_forward: bool,
}

/// 一条贮藏（`git stash list` 的忠实映射，见 [`stash`]）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StashEntry {
    /// 完整 oid —— **写操作只认它**
    pub oid: String,
    /// `stash@{n}`：仅 Rust 内部解析用，**不出去**（出去就会被当成身份，见 [`stash`] 模块头口径 1）
    #[serde(skip)]
    pub selector: String,
    /// reflog 消息原文：`On main: <消息>` / `WIP on main: <短 oid> <标题>`。
    /// 拆成「分支 / 消息」是前端的纯函数（`domain/git/stash.ts`），这里只忠实回传。
    pub message: String,
    /// `%cI`（ISO 8601 strict，带时区；本地化是前端的事）
    pub time: String,
}

/// 一次贮藏写操作的结果：**快照 + 新列表一起回** —— 两次 IPC 之间列表不会过期。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StashResult {
    pub snapshot: StatusSnapshot,
    pub stashes: Vec<StashEntry>,
}

/// 删除贮藏的结果：被删的那条（供界面「撤销删除」）+ 新列表。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StashDropResult {
    pub oid: String,
    /// reflog 消息原文 —— 撤销时原样交给 `stash store -m`，恢复出来的条目与原来一致
    pub message: String,
    pub stashes: Vec<StashEntry>,
}

// ==================== 写操作准入（fail-closed） ====================

/// 写操作准入开关。
///
/// ⚠️ 只读沙盒模式（`settings.sandboxMode = readonly`）下**一切 git 写操作直接拒绝**。
/// 判定必须在 Rust 侧做（前端同时禁用按钮只是体验，不构成准入 —— 方案 §6）；
/// **读设置失败按拒绝处理**（fail-closed，与 `security::load_sandbox_ignore_rules` 同一取舍）。
#[derive(Debug, Clone, Copy)]
pub struct WriteGate {
    pub allowed: bool,
}

impl WriteGate {
    /// 从 `app_settings` 读 `sandboxMode`（缺省 `on`）
    pub async fn from_settings(settings: &dyn crate::session_db::SettingsRepo) -> Self {
        match settings.get_all().await {
            Ok(all) => {
                let mode = all
                    .get("sandboxMode")
                    .and_then(|v| v.as_str())
                    .unwrap_or("on");
                Self {
                    allowed: !mode.eq_ignore_ascii_case("readonly"),
                }
            }
            Err(e) => {
                eprintln!("[git] 读取 sandboxMode 失败，写操作按拒绝处理: {}", e);
                Self { allowed: false }
            }
        }
    }

    /// 测试 / CLI 用：直接给开关
    pub fn new(allowed: bool) -> Self {
        Self { allowed }
    }

    pub fn ensure(&self) -> Result<(), cli::GitError> {
        if self.allowed {
            Ok(())
        } else {
            Err(cli::GitError::new(
                "当前是只读沙盒模式，已拒绝 Git 写操作（可在「设置 → 安全」里调整沙盒模式）",
            ))
        }
    }
}
