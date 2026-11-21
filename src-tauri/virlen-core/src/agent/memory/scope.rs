//! 记忆的**项目作用域**（纯字符串判定，零 I/O）
//!
//! 解决什么：带 `project_path` 的记忆只对「某个目录」有意义。没有作用域时它们会被注入到**每个**
//! 会话（你去改前端项目，却收到后端项目的构建命令记忆）—— 记忆越多，噪音越大。
//!
//! 作用域与**分类无关**：分类（`user` / `decision` / `fact`）只说「这条记忆是什么」，
//! `project_path` 说「它在哪可见」。两者可以任意组合（「项目里的一个决策」不再需要在
//! 「project」和「decision」之间二选一）。
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

use crate::session_db::MemoryRecord;

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

/// 写入时该给这条记忆定什么作用域（**唯一实现**：`memory_write` 与 `cmd_memory_write` 都走它；
/// 面板保存 `cmd_memory_upsert` **不走** —— 那是用户显式填的值，空就是「要全局」）。
///
/// `requested` 是**调用方显式指定**的路径（模型 / 面板传上来的 `project_path`）：
/// - `None`（没传）→ **当前工作目录**。这是为「AI 惰性」定的默认：写记忆时绝大多数事实就是
///   本项目的知识，默认落地比默认全局安全（错在「少看见」而不是「到处乱闪」）。
/// - `"global"` / `"none"` / 空串（不区分大小写与首尾空白）→ `None` = 不限定项目（跨项目通用）；
///   跨项目的偏好必须显式这么传，否则会被锁在当前项目里。
/// - 其余 → 该路径（原样 `trim` 后的字符串）。
///
/// 工作目录为空且没显式指定 → `None`（没有项目标签，就不能编一个）。
///
/// ⚠️ **不按分类 / 级别开例外**（曾短暂让 `kind = user` / `level = permanent` 默认全局，
/// 用户否决）：可见范围只由 `project_path` 一个字段表达，「默认值又看分类」会让同一句
/// 写在不同 kind 下落到不同作用域，无法从代码 / 日志 / 面板上看出这条记忆为何是全局的。
/// 代价已知：带路径的 `permanent` 不再是「全量注入」——那是**显式**的取舍
///（想要全量就传 `global`），且 `memory_write` 的返回会把定下的作用域告诉模型。
///
/// ⚠️ 「没传」（`None`）与「传了空串」是两种意思：前者落到工作目录，后者是**显式**的全局
/// （模型只是没词可说时传了空串；把它当成「默认」就等于让它惰性默认又被默默忽略）。
pub fn scope_for_write(requested: Option<&str>, workspace: &str) -> Option<String> {
    match requested {
        Some(v) => {
            let v = v.trim();
            if v.is_empty() || is_global_token(v) {
                None
            } else {
                Some(v.to_string())
            }
        }
        None => clean(Some(workspace)).map(|w| w.to_string()),
    }
}

/// 「不限定项目」的显式写法（模型记不住一个 flag 但能记住一个词：三种都收，且不区分大小写）
pub fn is_global_token(v: &str) -> bool {
    matches!(
        v.trim().to_ascii_lowercase().as_str(),
        "global" | "none" | ""
    )
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
            kind: "fact".into(),
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
    fn write_scope_defaults_to_the_workspace_and_honors_explicit_global() {
        // 没传 → 当前工作目录（AI 惰性的兼容：默认落在本会话项目里）
        assert_eq!(
            scope_for_write(None, " C:/work/app "),
            Some("C:/work/app".to_string())
        );
        // 显式全局：三种写法都认，且不区分大小写 / 首尾空白
        for token in ["global", "GLOBAL", " global ", "none", "", "   "] {
            assert_eq!(
                scope_for_write(Some(token), "C:/work/app"),
                None,
                "{token:?} 应当表示全局"
            );
        }
        // 显式别的目录：原样（trim 后）落库
        assert_eq!(
            scope_for_write(Some(" D:/code/other "), "C:/work/app"),
            Some("D:/code/other".to_string())
        );
        // 没有工作目录且没显式指定 → 全局（不编一个路径出来）
        assert_eq!(scope_for_write(None, "   "), None);
        assert_eq!(scope_for_write(None, ""), None);
    }

    /// 作用域**只看** `project_path`，不按分类 / 级别开例外。
    ///
    /// 曾经短暂让 `kind = user` / `level = permanent` 默认全局，用户否决：可见范围只能由
    /// `project_path` 一个字段表达（同一句话不该因为分类不同而落到不同作用域）；
    /// 带路径的 `permanent` 不是「全量注入」是**显式**的取舍，想要就传 `global`。
    /// 这条守的就是「不存在的例外不会偷偷长回来」。
    #[test]
    fn scope_ignores_kind_and_level() {
        assert_eq!(
            scope_for_write(None, "C:/work/app"),
            Some("C:/work/app".to_string()),
            "签名里根本没有 kind / level：作用域只由 project_path 决定"
        );
        assert_eq!(
            scope_for_write(Some("global"), "C:/work/app"),
            None,
            "跨项目只能显式要求"
        );
    }

    #[test]
    fn global_token_accepts_only_the_three_spellings() {
        assert!(is_global_token("global"));
        assert!(is_global_token(" None "));
        assert!(is_global_token(""));
        assert!(!is_global_token("global-ish"));
        assert!(!is_global_token("C:/work/app"));
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
