use grep_regex::RegexMatcher;
use grep_searcher::{Searcher, SearcherBuilder, Sink, SinkMatch};
use ignore::Walk;
use ignore::WalkBuilder;
use serde::Serialize;
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

/// 按文件名搜索（支持纯文本模糊匹配或正则匹配）
pub fn search_files_by_name(
    root: &str,
    query: &str,
    use_regex: bool,
    max_results: usize,
    cancel_flag: &AtomicBool,
) -> Vec<FileSearchResult> {
    let re = if use_regex {
        regex::Regex::new(query).ok()
    } else {
        None
    };
    let lower_query = query.to_lowercase();

    let mut results = Vec::new();
    for entry in WalkBuilder::new(root)
        .hidden(false)
        .build()
        .filter_map(|e| e.ok())
    {
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

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DirEntryType {
    File,
    Dir,
    EnterDir,
    LeaveDir,
}

/// 列出目录内容（递归/非递归），由 Rust 端完成遍历和 skipDir 过滤
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
        root_path,
        0,
        recursive,
        include_hidden,
        max_depth,
        &skip_each_dirs,
        &mut results,
        cancel_flag,
    );
    results
}

fn walk_dir(
    base: &std::path::Path,
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

            if !include_hidden && name.starts_with('.') {
                continue;
            }

            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);

            // 获取文件大小（仅文件类型需要）
            let file_size = if is_dir {
                None
            } else {
                entry.metadata().ok().map(|m| m.len())
            };

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
                    base,
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
