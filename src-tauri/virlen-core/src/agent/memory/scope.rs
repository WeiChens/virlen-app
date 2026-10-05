//! 记忆的**项目作用域**（纯字符串判定，零 I/O）
//!
//! 解决什么：`kind = project` 的记忆只对「某个项目」有意义。没有作用域时它们会被注入到**每个**
//! 会话（你去改前端项目，却收到后端项目的构建命令记忆）—— 记忆越多，噪音越大。
//!
//! 匹配规则（**单向包含**，已与产品确认）：
//! - 工作目录 == 项目路径 → 命中；
//! - 工作目录在项目路径**之下**（子目录）→ 命中（会话工作目录经常是项目里的子目录）；
//! - 其余 → 不命中（**父目录不算**：打开 `C:/code` 时不会把 `C:/code/app` 的项目记忆拉进来）。
//!
//! 另一条硬约定：**不限定项目的记忆永远适用**（`project_path` 为空 = 用户偏好 / 通用事实 /
//! 升级前的老数据）—— 作用域只筛「声明了自己属于某个项目」的那些。
//!
//! ⚠️ 这里**只做字符串归一化，不碰文件系统**（不 `canonicalize`）：
//! 1. 记忆里的路径是「当时那个会话的工作目录」这个**标签**，可能早就不存在了；
//! 2. 相对路径若按进程当前目录解析，会随启动位置变化 —— 同一条记忆两处判定结果不同。
//!
//!    因此归一化只统一分隔符 / 大小写 / 尾部斜杠，语义就是「用户看到的那两个字符串是否指同一处」。
//!
//! 大小写口径与 `sandbox::paths::canonical_path_key` 一致：Windows / macOS 不敏感（统一小写），
//! Linux 保留原样（**大小写敏感**，`/Foo` 与 `/foo` 是两个目录）。
//!
//! 完整取舍（路径从哪来 / 连带影响哪几处）见 `docs/memory-plan.md` §3.1.1。

use crate::session_db::{MemoryRecord, MEMORY_KIND_PROJECT};

/// 项目路径的长度上限（字符）：路径是用户 / 模型输入，不能无界落库。
///
/// 500 足够任何真实工作目录（Windows 长路径上限 32767，但那种目录名不会出现在记忆里）；
/// 命令层超限直接拒绝（**不截断**：截断出来的路径指不到任何地方，比拒绝更糟）。
pub const MEMORY_PROJECT_PATH_MAX_CHARS: usize = 500;

/// 规范化路径键：去首尾空白 → 去 Windows 长路径前缀 → 统一 `/` → 压缩重复分隔符 → 去尾部斜杠
/// → Windows / macOS 统一小写（Linux 保留原样）。
pub fn path_key(path: &str) -> String {
    let raw = path.trim();
    // `\\?\C:\x` / `//?/C:/x`（长路径前缀）不该让同一处被认成两个路径
    let raw = raw.strip_prefix(r"\\?\").unwrap_or(raw);
    let raw = raw.strip_prefix("//?/").unwrap_or(raw);

    let mut s = raw.replace('\\', "/");
    while s.contains("//") {
        s = s.replace("//", "/");
    }
    // 尾部斜杠去掉（根 `/` 除外）：`C:/code/app/` 与 `C:/code/app` 是同一处
    while s.len() > 1 && s.ends_with('/') {
        s.pop();
    }
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    {
        s = s.to_ascii_lowercase();
    }
    s
}

/// 同一个项目？（两侧都为空视为「都不限定项目」= 同一作用域）
pub fn same_project(a: Option<&str>, b: Option<&str>) -> bool {
    match (clean(a), clean(b)) {
        (None, None) => true,
        (Some(x), Some(y)) => path_key(&x) == path_key(&y),
        _ => false,
    }
}

/// 这条记忆是否适用于这个工作目录。
///
/// `workspace` 为空（会话没设工作目录）→ 只有**不限定项目**的记忆适用：
/// 不知道该在哪个项目里，就不该把别的项目的记忆端上来（宁可少记，也不要错记）。
pub fn applies(project_path: &str, workspace: &str) -> bool {
    let (Some(p), Some(w)) = (clean(Some(project_path)), clean(Some(workspace))) else {
        return false;
    };
    let (p, w) = (path_key(&p), path_key(&w));
    if p.is_empty() || w.is_empty() {
        return false;
    }
    // 根目录作为项目路径时，一切都在它之下（否则前缀比较要写一堆特例）
    p == "/" || w == p || w.starts_with(&format!("{}/", p))
}

/// 一条记忆是否适用于这个工作目录（不限定项目的记忆一律适用）
pub fn memory_applies(m: &MemoryRecord, workspace: &str) -> bool {
    match declared_project(m) {
        None => true,
        Some(p) => applies(p, workspace),
    }
}

/// 按工作目录**筛出**这次会话能看到的记忆（顺序原样保留 —— 排序仍归 `select_for_inject`）
pub fn filter_for_workspace(all: &[MemoryRecord], workspace: &str) -> Vec<MemoryRecord> {
    all.iter()
        .filter(|m| memory_applies(m, workspace))
        .cloned()
        .collect()
}

/// 记忆**声明**的项目路径（空串 / 纯空白 / 无 → `None`）
pub fn declared_project(m: &MemoryRecord) -> Option<&str> {
    m.project_path.as_deref().and_then(|s| {
        let t = s.trim();
        if t.is_empty() {
            None
        } else {
            Some(t)
        }
    })
}

/// 写入时该给这条记忆定什么作用域：只有 `project` 才带路径，工作目录为空则不带（= 通用）。
///
/// 唯一实现：命令层（面板保存）、工具层（`memory_write`）、蒸馏落库都调它 ——
/// 否则「非 project 也带路径」这类脏数据会在某一条写入路径上偷偷溜进库。
pub fn scope_for_write(kind: &str, workspace: &str) -> Option<String> {
    if kind.trim() != MEMORY_KIND_PROJECT {
        return None;
    }
    clean(Some(workspace)).map(|w| w.to_string())
}

/// 内部：把 `Option<&str>` 里的空串折叠成 `None`
fn clean(v: Option<&str>) -> Option<String> {
    v.map(str::trim).filter(|s| !s.is_empty()).map(String::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_db::MEMORY_LEVEL_NORMAL;

    fn mem(id: &str, project: Option<&str>) -> MemoryRecord {
        MemoryRecord {
            id: id.into(),
            level: MEMORY_LEVEL_NORMAL.into(),
            kind: MEMORY_KIND_PROJECT.into(),
            summary: format!("记忆 {}", id),
            project_path: project.map(String::from),
            created_at: 1,
            ..Default::default()
        }
    }

    // ── 归一化 ──

    #[test]
    fn path_key_normalizes_separators_and_trailing_slash() {
        assert_eq!(path_key("  C:/work/app/  "), path_key(r"C:\work\app"));
        assert_eq!(path_key("C:/work//app"), path_key("C:/work/app"));
        assert_eq!(path_key(r"\\?\C:\work\app"), path_key("C:/work/app"));
        // 根目录不会被削成空串
        assert_eq!(path_key("/"), "/");
    }

    #[cfg(any(target_os = "windows", target_os = "macos"))]
    #[test]
    fn path_key_is_case_insensitive_on_windows_and_macos() {
        assert_eq!(path_key(r"C:\Work\App"), path_key("c:/work/app/"));
    }

    // ── 匹配（单向包含） ──

    #[test]
    fn matches_equality_and_subdirectories() {
        let p = "C:/work/app";
        assert!(applies(p, "C:/work/app"), "相等");
        assert!(applies(p, r"C:\work\app\"), "相等（分隔符 / 尾斜杠不同）");
        assert!(applies(p, "C:/work/app/src/deep"), "子目录");
    }

    #[test]
    fn does_not_match_parent_sibling_or_prefix_lookalike() {
        assert!(!applies("C:/work/app", "C:/work"), "父目录不算命中");
        assert!(!applies("C:/work/app", "C:/work/other"), "兄弟目录");
        // 前缀相近但不是子目录：必须有分隔符边界，否则 app2 会被 app 认领
        assert!(!applies("C:/work/app", "C:/work/app2"));
        assert!(!applies("C:/work/app/src", "C:/work/app"), "方向反了：工作目录在上层");
    }

    #[test]
    fn root_project_path_contains_everything() {
        assert!(applies("/", "/home/dev/app"));
    }

    #[test]
    fn empty_workspace_or_empty_project_never_matches() {
        assert!(!applies("C:/work/app", ""));
        assert!(!applies("   ", "C:/work/app"));
        assert!(!applies("C:/work/app", "  "));
    }

    // ── 记忆级筛选 ──

    #[test]
    fn global_memories_always_apply_even_without_workspace() {
        let global = mem("g", None);
        assert!(memory_applies(&global, "C:/anywhere"));
        assert!(memory_applies(&global, ""), "老数据 / 用户偏好不该因为没有工作目录就消失");
        // 空串按「不限定」处理（库里理论上不该有，但脏数据不该被当成项目路径比较）
        let blank = mem("b", Some("   "));
        assert!(memory_applies(&blank, ""));
    }

    #[test]
    fn filter_keeps_scope_order_and_drops_other_projects() {
        let all = vec![
            mem("global", None),
            mem("mine", Some("C:/work/app")),
            mem("other", Some("C:/work/other")),
            mem("deeper", Some("C:/work/app/packages/core")),
        ];
        let ids: Vec<String> = filter_for_workspace(&all, "C:/work/app/src")
            .into_iter()
            .map(|m| m.id)
            .collect();
        assert_eq!(ids, vec!["global", "mine"], "顺序不变；别的项目与「更深的子目录」都不算");
        // 工作目录在嵌套的子项目里 → 该子项目的记忆命中，**父项目的也照旧命中**
        // （工作目录在项目路径之下就算命中 —— 这正是单向包含的语义），只有别的项目被筛掉
        let ids: Vec<String> = filter_for_workspace(&all, "C:/work/app/packages/core")
            .into_iter()
            .map(|m| m.id)
            .collect();
        assert_eq!(ids, vec!["global", "mine", "deeper"]);
    }

    // ── 写入作用域 ──

    #[test]
    fn only_project_kind_gets_a_scope() {
        assert_eq!(
            scope_for_write("project", " C:/work/app "),
            Some("C:/work/app".to_string())
        );
        assert_eq!(scope_for_write("user", "C:/work/app"), None);
        assert_eq!(scope_for_write("decision", "C:/work/app"), None);
        assert_eq!(scope_for_write("fact", "C:/work/app"), None);
        assert_eq!(scope_for_write("project", "   "), None, "没有工作目录 → 通用记忆");
        assert_eq!(scope_for_write("project", ""), None);
    }

    #[test]
    fn same_project_folds_blank_and_separators() {
        assert!(same_project(None, None));
        assert!(same_project(Some(""), Some("   ")));
        assert!(same_project(Some("C:/work/app"), Some(r"C:\work\app\")));
        assert!(!same_project(None, Some("C:/work/app")));
        assert!(!same_project(Some("C:/work/app"), Some("C:/work/other")));
    }
}
