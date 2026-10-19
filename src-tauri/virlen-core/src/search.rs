use grep_regex::RegexMatcher;
use grep_searcher::{Searcher, SearcherBuilder, Sink, SinkMatch};
use ignore::Walk;
use ignore::WalkBuilder;
use serde::Serialize;
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Serialize)]
pub struct FileSearchResult {
    pub path: String,
}

#[derive(Serialize)]
pub struct TextSearchResult {
    pub path: String,
    pub line_number: usize,
    pub line: String,
}

/// 按文件名搜索（纯文本模糊匹配或正则）。
///
/// 三个参数控制遍历范围（侧边栏靠它们避免把 `node_modules` 扫一遍）：`include_hidden=false` 跳过点项
/// （与 `list_directory` 一致）；`skip_dir_names` 整棵剪掉这些目录；`keep_dirs` 是剪枝例外（用户已展开过
/// 的目录，不该再剪）。
///
/// ⚠️ 模型工具（`native_tools::search`）传 `true` + 两个空数组保持原行为：它可用显式路径 / glob 表达
/// 「就要搜 node_modules」，UI 搜索框没有这种手段。
///
/// `#[allow(too_many_arguments)]`：查询条件（root / query / regex / 上限）+ 剪枝策略
/// （include_hidden / skip / keep）+ 取消位各自独立，收结构体只是换写法。
#[allow(clippy::too_many_arguments)]
pub fn search_files_by_name(
    root: &str,
    query: &str,
    use_regex: bool,
    max_results: usize,
    cancel_flag: &AtomicBool,
    include_hidden: bool,
    skip_dir_names: &[String],
    keep_dirs: &[String],
) -> Vec<FileSearchResult> {
    let re = if use_regex {
        regex::Regex::new(query).ok()
    } else {
        None
    };
    let lower_query = query.to_lowercase();

    // filter_entry 要求闭包 'static，所以这里拿所有权
    let skip_names: HashSet<String> = skip_dir_names.iter().cloned().collect();
    let keep: HashSet<String> = keep_dirs.iter().map(|p| normalize_sep(p)).collect();

    let mut builder = WalkBuilder::new(root);
    builder.hidden(!include_hidden);
    if !skip_names.is_empty() {
        builder.filter_entry(move |entry| {
            // 根目录本身不参与剪枝：工作目录恰好叫 node_modules 也得能搜
            if entry.depth() == 0 {
                return true;
            }
            if !skip_names.contains(&*entry.file_name().to_string_lossy()) {
                return true;
            }
            keep.contains(&normalize_sep(&entry.path().to_string_lossy()))
        });
    }

    let mut results = Vec::new();
    for entry in builder.build().filter_map(|e| e.ok()) {
        if cancel_flag.load(Ordering::SeqCst) {
            break;
        }
        if results.len() >= max_results {
            break;
        }
        if entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            let path_str = match entry.path().to_str() {
                Some(p) => p,
                None => continue,
            };
            let matched = match &re {
                Some(r) => r.is_match(path_str),
                None => path_str.to_lowercase().contains(&lower_query),
            };
            if matched {
                results.push(FileSearchResult {
                    path: path_str.to_string(),
                });
            }
        }
    }
    results
}

/// 路径分隔符统一成 `/`。
/// Windows 下 `ignore` 遍历出的子路径是 `C:/root\sub\file`（根保留 /，子级用 \），
/// 而前端 `expanded` 的 key 全经 `normalizeTreePath` 归一化 → 比较前必须对齐。
fn normalize_sep(path: &str) -> String {
    path.replace('\\', "/")
}

/// 在文件中搜索文本内容（正则匹配），自动跳过二进制文件
pub fn search_text_in_files(
    root: &str,
    query: &str,
    max_results: usize,
    cancel_flag: &AtomicBool,
) -> Vec<TextSearchResult> {
    let matcher = match RegexMatcher::new(query) {
        Ok(m) => m,
        Err(_) => return vec![],
    };

    let mut searcher = SearcherBuilder::default()
        .binary_detection(grep_searcher::BinaryDetection::quit(b'\x00'))
        .build();

    let mut results = Vec::new();

    for entry in Walk::new(root).filter_map(|e| e.ok()) {
        if cancel_flag.load(Ordering::SeqCst) {
            break;
        }
        if results.len() >= max_results {
            break;
        }
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let path_str = match entry.path().to_str() {
            Some(p) => p.to_string(),
            None => continue,
        };

        let mut sink = TextSearchSink {
            path: path_str,
            results: &mut results,
            max: max_results,
            cancel_flag,
        };

        let _ = searcher.search_path(&matcher, entry.path(), &mut sink);
    }

    results
}

#[derive(Serialize)]
pub struct DirEntry {
    /// 文件名
    pub name: String,
    /// 是否目录
    pub r#type: DirEntryType,
    /// 文件大小（字节），仅文件类型有值，目录为 None
    pub size: Option<u64>,
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DirEntryType {
    File,
    Dir,
    EnterDir,
    LeaveDir,
}

/// 是否为**操作系统标记的隐藏项**（只看属性位，不看 `.` 前缀）。
///
/// 三个平台的隐藏机制不同，各取属性语义：
/// - Windows：`FILE_ATTRIBUTE_HIDDEN` —— `git init` 会给 `.git` 打上隐藏位，`.env` / `.gitignore` 不会；
/// - macOS：`UF_HIDDEN`（Finder 的「隐藏」勾选）；
/// - 其他（Linux…）：没有隐藏属性位 → `false`，`. 开头` 只是命名约定，由 `include_hidden` 决定。
///
/// ⚠️ 唯一判定依据：`search::walk_dir` 与前端「工作目录」树的可见性都靠它区分
/// 「点文件（要能编辑）」与「系统隐藏项（如 `.git`）」；不要在别处另写一份判断。
fn is_hidden_by_attr(meta: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        /// `FILE_ATTRIBUTE_HIDDEN`
        const HIDDEN: u32 = 0x2;
        meta.file_attributes() & HIDDEN != 0
    }
    #[cfg(target_os = "macos")]
    {
        use std::os::macos::fs::MetadataExt;
        /// `UF_HIDDEN`
        const HIDDEN: u32 = 0x8000;
        meta.st_flags() & HIDDEN != 0
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = meta;
        false
    }
}

/// 列出目录内容（递归/非递归），由 Rust 端完成遍历和 skipDir 过滤。
///
/// `include_hidden` 只放开「`. 开头」这条命名约定（`.env` / `.github`）；系统隐藏属性项
/// （`.git`）始终不列。
pub fn list_directory(
    root: &str,
    recursive: bool,
    include_hidden: bool,
    max_depth: usize,
    skip_each_dirs: &[String],
    cancel_flag: &AtomicBool,
) -> Vec<DirEntry> {
    let mut results = Vec::new();
    let root_path = std::path::Path::new(root);

    walk_dir(
        root_path,
        0,
        recursive,
        include_hidden,
        max_depth,
        skip_each_dirs,
        &mut results,
        cancel_flag,
    );
    results
}

/// `#[allow(too_many_arguments)]`：遍历状态（目录 / 深度 / 递归 / 隐藏项 / 上限 / 剪枝表 /
/// 结果 / 取消位）逐项独立，收结构体无收益。
#[allow(clippy::too_many_arguments)]
fn walk_dir(
    dir: &std::path::Path,
    depth: usize,
    recursive: bool,
    include_hidden: bool,
    max_depth: usize,
    skip_each_dirs: &[String],
    results: &mut Vec<DirEntry>,
    cancel_flag: &AtomicBool,
) {
    if cancel_flag.load(Ordering::SeqCst) {
        return;
    }
    if depth > max_depth {
        return;
    }

    let mut entries: Vec<DirEntry> = Vec::new();

    if let Ok(read_dir) = std::fs::read_dir(dir) {
        for entry in read_dir.filter_map(|e| e.ok()) {
            if cancel_flag.load(Ordering::SeqCst) {
                return;
            }

            let name = match entry.file_name().to_str() {
                Some(n) => n.to_string(),
                None => continue,
            };

            let meta = entry.metadata().ok();

            // 系统隐藏项（如 `.git`）一律不列：它由 git 自己打隐藏位，不是用户要编辑的正文。
            if meta.as_ref().is_some_and(is_hidden_by_attr) {
                continue;
            }

            if !include_hidden && name.starts_with('.') {
                continue;
            }

            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);

            // 获取文件大小（仅文件类型需要）
            let file_size = if is_dir { None } else { meta.map(|m| m.len()) };

            if is_dir && skip_each_dirs.iter().any(|s| s == &name) {
                entries.push(DirEntry {
                    name: name.clone(),
                    r#type: DirEntryType::Dir,
                    size: None,
                });
                continue; // 不进入子目录
            }

            // 对于需要递归遍历的目录，使用 EnterDir/LeaveDir 协议，
            // 不再往 entries 中添加单独的 Dir 条目，避免重复显示
            if is_dir && recursive && depth < max_depth {
                results.push(DirEntry {
                    name: name.clone(),
                    r#type: DirEntryType::EnterDir,
                    size: None,
                });
                walk_dir(
                    &entry.path(),
                    depth + 1,
                    recursive,
                    include_hidden,
                    max_depth,
                    skip_each_dirs,
                    results,
                    cancel_flag,
                );
                if cancel_flag.load(Ordering::SeqCst) {
                    return;
                }
                results.push(DirEntry {
                    name: String::new(),
                    r#type: DirEntryType::LeaveDir,
                    size: None,
                });
            } else {
                entries.push(DirEntry {
                    name: name.clone(),
                    r#type: if is_dir {
                        DirEntryType::Dir
                    } else {
                        DirEntryType::File
                    },
                    size: file_size,
                });
            }
        }
    }

    // 排序：目录优先，按名称排序
    entries.sort_by(|a, b| {
        let a_is_dir = matches!(a.r#type, DirEntryType::Dir | DirEntryType::EnterDir);
        let b_is_dir = matches!(b.r#type, DirEntryType::Dir | DirEntryType::EnterDir);
        if a_is_dir && !b_is_dir {
            std::cmp::Ordering::Less
        } else if !a_is_dir && b_is_dir {
            std::cmp::Ordering::Greater
        } else {
            a.name.to_lowercase().cmp(&b.name.to_lowercase())
        }
    });

    results.extend(entries);
}

struct TextSearchSink<'a> {
    path: String,
    results: &'a mut Vec<TextSearchResult>,
    max: usize,
    cancel_flag: &'a AtomicBool,
}

impl<'a> Sink for TextSearchSink<'a> {
    type Error = Box<dyn std::error::Error>;

    fn matched(&mut self, _searcher: &Searcher, mat: &SinkMatch<'_>) -> Result<bool, Self::Error> {
        if self.cancel_flag.load(Ordering::SeqCst) {
            return Ok(false);
        }
        if self.results.len() >= self.max {
            return Ok(false);
        }
        self.results.push(TextSearchResult {
            path: self.path.clone(),
            line_number: mat.line_number().unwrap_or(0) as usize,
            line: String::from_utf8_lossy(mat.bytes()).to_string(),
        });
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// 造一棵临时工作目录：
    /// ```text
    /// <root>/src/needle.ts          ← 正常文件
    /// <root>/node_modules/pkg/needle.js  ← 被剪掉的依赖目录
    /// <root>/.git/needle.txt         ← 点目录（include_hidden=false 时跳过）
    /// ```
    fn fixture(tag: &str) -> std::path::PathBuf {
        let mut root = std::env::temp_dir();
        root.push(format!("virlen_search_{}_{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("src")).unwrap();
        fs::create_dir_all(root.join("node_modules").join("pkg")).unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join("src").join("needle.ts"), "").unwrap();
        fs::write(root.join("node_modules").join("pkg").join("needle.js"), "").unwrap();
        fs::write(root.join(".git").join("needle.txt"), "").unwrap();
        root
    }

    fn run(
        root: &std::path::Path,
        include_hidden: bool,
        skip: &[String],
        keep: &[String],
    ) -> Vec<String> {
        let flag = AtomicBool::new(false);
        search_files_by_name(
            root.to_str().unwrap(),
            "needle",
            false,
            100,
            &flag,
            include_hidden,
            skip,
            keep,
        )
        .into_iter()
        .map(|r| normalize_sep(&r.path))
        .collect()
    }

    #[test]
    fn skip_dir_names_prunes_the_whole_subtree() {
        let root = fixture("skip");
        let skip = ["node_modules".to_string()];

        // 不剪：src + node_modules（.git 被 include_hidden=false 挡掉）
        assert_eq!(run(&root, false, &[], &[]).len(), 2);
        // 剪 node_modules：只剩 src
        let hits = run(&root, false, &skip, &[]);
        assert_eq!(hits.len(), 1);
        assert!(hits[0].ends_with("src/needle.ts"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn keep_dirs_exempts_the_expanded_copy_only() {
        let root = fixture("keep");
        let skip = ["node_modules".to_string()];
        let root_norm = normalize_sep(&root.to_string_lossy());

        // 默认剪掉
        assert_eq!(run(&root, false, &skip, &[]).len(), 1);

        // 用户展开了 <root>/node_modules → 这一份不再剪（src + node_modules/pkg）
        let hits = run(
            &root,
            false,
            &skip,
            &[format!("{}/node_modules", root_norm)],
        );
        assert_eq!(hits.len(), 2);
        assert!(hits.iter().any(|p| p.ends_with("src/needle.ts")));
        assert!(hits.iter().any(|p| p.ends_with("node_modules/pkg/needle.js")));

        // 展开的是别的路径（"" 路径不匹配）→ 仍按剪枝处理
        assert_eq!(
            run(&root, false, &skip, &[format!("{}/dist", root_norm)]).len(),
            1
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn include_hidden_false_prunes_dot_dirs() {
        let root = fixture("hidden");
        let skip = ["node_modules".to_string()];

        // 跳隐藏：只剩 src
        let hits = run(&root, false, &skip, &[]);
        assert_eq!(hits.len(), 1);
        assert!(hits[0].ends_with("src/needle.ts"));

        // 含隐藏（模型工具走的档）：多出 .git 里的同名文件
        let all = run(&root, true, &skip, &[]);
        assert_eq!(all.len(), 2);
        assert!(all.iter().any(|p| p.ends_with(".git/needle.txt")));
        let _ = fs::remove_dir_all(&root);
    }

    fn list_names(root: &std::path::Path, include_hidden: bool) -> Vec<String> {
        let flag = AtomicBool::new(false);
        list_directory(root.to_str().unwrap(), false, include_hidden, 1, &[], &flag)
            .into_iter()
            .map(|e| e.name)
            .collect()
    }

    /// 树的口径：`include_hidden=true` 时点文件（`.env`）要列出来，不能连它一起藏。
    #[test]
    fn list_directory_shows_dot_files_when_include_hidden() {
        let root = fixture("dotfiles");
        fs::write(root.join(".env"), "").unwrap();

        assert!(list_names(&root, true).contains(&".env".to_string()));
        // 老口径（模型工具 / 路径补全）不受影响：false 仍跳过点项
        assert!(!list_names(&root, false).contains(&".env".to_string()));
        let _ = fs::remove_dir_all(&root);
    }

    /// 系统隐藏属性项（Windows 上 `git init` 会给 `.git` 打隐藏位）不列 —— 即使 `include_hidden=true`。
    #[cfg(windows)]
    #[test]
    fn list_directory_skips_os_hidden_entries() {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            SetFileAttributesW, FILE_ATTRIBUTE_HIDDEN, FILE_ATTRIBUTE_NORMAL,
        };

        fn set_hidden(path: &std::path::Path, hidden: bool) {
            let wide: Vec<u16> = path
                .as_os_str()
                .encode_wide()
                .chain(std::iter::once(0))
                .collect();
            let attrs = if hidden {
                FILE_ATTRIBUTE_HIDDEN
            } else {
                FILE_ATTRIBUTE_NORMAL
            };
            unsafe { SetFileAttributesW(wide.as_ptr(), attrs) };
        }

        let root = fixture("oshidden");
        let git = root.join(".git");
        set_hidden(&git, true);

        assert!(!list_names(&root, true).contains(&".git".to_string()));

        // 复位属性后再删（隐藏位不影响删除，但别给回收站留隐形垃圾）
        set_hidden(&git, false);
        let _ = fs::remove_dir_all(&root);
    }
}
