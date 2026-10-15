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
pub mod repo;
pub mod stage;
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

/// 一次提交的结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitResult {
    pub oid: String,
    pub summary: String,
    /// git 的原始输出（含 hooks 的 stdout）—— 界面要能看见它，见方案 §7 第 6 条
    pub output: String,
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
