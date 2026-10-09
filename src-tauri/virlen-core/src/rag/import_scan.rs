//! 知识库导入的「扫描 / 过滤」—— 文件夹扫描与压缩包条目过滤**共用同一套 .gitignore 规则**
//!
//! 为什么单独一个模块：这两条导入路径（选文件夹 / 导入压缩包）是两种数据源（真实目录 / 包内条目），
//! 但「哪些文件该进来」必须只有一套答案 —— 否则同一棵目录树，打成包导入和按文件夹导入会得到
//! 两份不同的结果。
//!
//! 规则求值用 `ignore::gitignore::Gitignore`（与 ripgrep 同源），这里只补两件事：
//! 1. **多层 .gitignore 的优先级**（越深的文件越先说话，同一层内最后一条命中规则说了算 —— 后者由 crate 负责）；
//! 2. 目录遍历本身（为什么不用 `ignore::Walk`：它只把**通过过滤的**条目交出来，而导入弹窗还要报
//!    「有几份被 .gitignore 排除了」，拿不到这个数）。
//!
//! ## 哪些文件算「能导入的」（2026-10 起：**不按扩展名筛**）
//!
//! 从前是「扩展名在白名单里才收」（md / markdown / txt），于是 `笔记.json`、`README`（无扩展名）、
//! `main.py` 这些明明能读的纯文本一份都进不来。现在的口径按**内容**判断：
//! - **PDF**（按扩展名识别，二进制）→ 收，交给后端 `document::parse_document` 抽文字；
//! - **其余一切文件** → 读前 [`SNIFF_BYTES`] 字节看「像不像纯文本」（无 NUL、控制字符少、UTF-8 或
//!   GBK / Big5 / Shift_JIS 能干净解码）→ 像就收，不像（图片 / 压缩包 / 可执行文件）就跳过并计数；
//! - **大小上限**：纯文本 2 MB（[`MAX_TEXT_FILE_BYTES`]），PDF 50 MB（[`MAX_PARSE_DOC_BYTES`]，
//!   与后端 `rag_service::MAX_DOC_SIZE_BYTES` 同源）。超限的计入 `*_too_large`，在导入弹窗里说清。
//!
//! 压缩包那条路**不嗅探内容**（条目按纯文本入库，导出写的就是文本，见 `vector_store`），
//! 所以那里只有「2 MB 上限 + .gitignore」两条规则 —— 差别写在 [`crate::rag::vector_store::zip_entry_names`]。
//!
//! ## 目录级的跳过
//!
//! - 被 `.gitignore` 排除的目录整棵不进去（与 git 一致：目录被排除时，里面的 `!` 取反救不回来）；
//! - `.git` 与**依赖 / 构建产物目录**（`node_modules` / `.venv` / `target` / `dist` / `__pycache__` 等，
//!   见 [`SKIPPED_DIR_NAMES`]）整棵不进去 —— 这些目录里没有「文档」，却是成千上万个文件；
//!   ⚠️ 只在**子目录**上判：用户自己选中的那个目录就算是 `dist/`，也照常扫（他要的就是它）；
//! - 藏在点目录里的其它文档（如 `.github/`）不主动排除。

use encoding_rs::{BIG5, GB18030, SHIFT_JIS};
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};

/// 文件夹扫描的最大层级：相对路径最多这么多段（与从前前端扫描的口径一致）。
pub const SCAN_MAX_DEPTH: usize = 5;

/// 「交给后端解析」的格式 —— 与 `document::parse_document` 的支持列表同源。
///
/// ⚠️ 后端目前只认 PDF；将来它支持了新格式（docx 之类），这里与前端 `isPdfFile` 要一起改。
pub const PARSEABLE_EXTENSIONS: [&str; 1] = ["pdf"];

/// 纯文本文件的大小上限（2 MB）—— 超过就不收（分块与嵌入都吃不消）。
pub const MAX_TEXT_FILE_BYTES: u64 = 2 * 1024 * 1024;

/// 可解析文档（PDF）的大小上限：与后端 [`crate::rag::rag_service::MAX_DOC_SIZE_BYTES`] 同一个值
/// （50 MB）。这里提前挡一道，是为了在导入弹窗里**说清是哪一份超了**，而不是等后端逐个报错。
pub const MAX_PARSE_DOC_BYTES: u64 = crate::rag::rag_service::MAX_DOC_SIZE_BYTES;

/// 嗅探「是不是纯文本」时最多读多少字节：前 8 KB 足以给一个文件定性。
pub const SNIFF_BYTES: usize = 8 * 1024;

/// 整棵跳过的目录名（小写比较）—— 依赖与构建产物，里面没有「文档」。
///
/// 只列「几乎不可能装文档」的名字。`bin` / `lib` / `docs` 这类可能是真内容的目录**不列**
/// （宁可不跳，也不要悄悄丢掉用户的文件）。
pub const SKIPPED_DIR_NAMES: [&str; 24] = [
    // JS / TS 生态
    "node_modules",
    "bower_components",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".angular",
    ".parcel-cache",
    ".turbo",
    // 构建产物
    "dist",
    "build",
    "out",
    "obj",
    "target",
    "coverage",
    // 缓存 / 虚拟环境
    ".cache",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".tox",
    ".venv",
    "venv",
    ".gradle",
    "vendor",
];

/// 这个目录名是不是「依赖 / 构建产物」目录
pub fn is_skipped_dir(name: &str) -> bool {
    SKIPPED_DIR_NAMES
        .iter()
        .any(|d| name.eq_ignore_ascii_case(d))
}

/// 这个文件名是不是「交给后端解析」的格式（PDF）
pub fn is_parseable_doc(name: &str) -> bool {
    match name.rsplit_once('.') {
        Some((stem, ext)) => {
            !stem.is_empty() && PARSEABLE_EXTENSIONS.iter().any(|e| e.eq_ignore_ascii_case(ext))
        }
        None => false,
    }
}

/// 采样字节看着像纯文本吗。
///
/// 与前端 `looksLikeText` 同一套口径（那边是权威判定，这边只是**先筛一遍**，好让弹窗里的
/// 份数、总数与真实结果一致）：
/// 1. 空 / 含 `NUL` → 不是（图片、压缩包、可执行文件、UTF-16 都带 NUL）；
/// 2. 控制字符占比 ≥ 5% → 不是（二进制里常见，正常文本里几乎没有）；
/// 3. UTF-8 能解（只在末尾被采样截断也算）→ 是；
/// 4. 否则用 GBK / Big5 / Shift_JIS 试干净解码（中文、日文的常见编码）→ 能解就是文本；
/// 5. 都不行 → 不是。
pub fn sniff_is_text(sample: &[u8]) -> bool {
    if sample.is_empty() {
        return false;
    }
    if sample.contains(&0) {
        return false;
    }
    let bad = sample
        .iter()
        .filter(|b| **b < 0x20 && !matches!(**b, 0x09 | 0x0a | 0x0c | 0x0d))
        .count();
    if bad * 20 >= sample.len() {
        return false;
    }
    if is_valid_utf8_prefix(sample) {
        return true;
    }
    [GB18030, BIG5, SHIFT_JIS]
        .iter()
        .any(|enc| decodes_cleanly(enc, sample))
}

/// 这段字节是不是「（可能被截断的）合法 UTF-8」
fn is_valid_utf8_prefix(bytes: &[u8]) -> bool {
    match std::str::from_utf8(bytes) {
        Ok(_) => true,
        // 只有在**末尾**被截断（采样切在多字节字符中间）才算合法
        Err(e) => e.error_len().is_none() && e.valid_up_to() > 0,
    }
}

/// 用某个编码解这段字节，且**没有出现替换字符**。
///
/// 末尾最多放宽 2 个字节：采样常常正好切在一个多字节字符中间，那不算「解不出来」。
fn decodes_cleanly(enc: &'static encoding_rs::Encoding, bytes: &[u8]) -> bool {
    for trim in 0..=2usize {
        let Some(end) = bytes.len().checked_sub(trim) else {
            continue;
        };
        if end == 0 {
            continue;
        }
        if !enc.decode(&bytes[..end]).2 {
            return true;
        }
    }
    false
}

/// 不能被导入的三种原因（`None` = 可以导入）
enum SkipReason {
    /// 不是文本、也不是能解析的格式（图片 / 压缩包 / 可执行文件…）
    NotText,
    /// 纯文本但超过 [`MAX_TEXT_FILE_BYTES`]
    TextTooLarge,
    /// PDF 但超过 [`MAX_PARSE_DOC_BYTES`]
    PdfTooLarge,
}

/// 这个文件能不能导？不能的话，为什么。
///
/// PDF 只看大小（内容是二进制，由后端抽文字）；其余文件**先看内容像不像文本，再卡大小** ——
/// 顺序反过来的话，一个 5 MB 的图片会被报成「超过 2 MB」，而它其实压根不是文本。
fn classify_file(path: &Path, name: &str) -> Option<SkipReason> {
    let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    if is_parseable_doc(name) {
        return (size > MAX_PARSE_DOC_BYTES).then_some(SkipReason::PdfTooLarge);
    }
    let Some(sample) = read_head(path) else {
        return Some(SkipReason::NotText); // 读不了（权限 / 刚被删）：当不能导入
    };
    if !sniff_is_text(&sample) {
        return Some(SkipReason::NotText);
    }
    (size > MAX_TEXT_FILE_BYTES).then_some(SkipReason::TextTooLarge)
}

/// 读一个文件的前 [`SNIFF_BYTES`] 字节（读不出来 → `None`）
fn read_head(path: &Path) -> Option<Vec<u8>> {
    let file = std::fs::File::open(path).ok()?;
    let mut buf = Vec::new();
    file.take(SNIFF_BYTES as u64).read_to_end(&mut buf).ok()?;
    Some(buf)
}

/// 文件夹扫描结果
#[derive(Debug, Clone, Default, Serialize)]
pub struct FolderScan {
    /// 可以导入的文件（绝对路径）
    pub files: Vec<String>,
    /// 被 .gitignore 排除掉的**文件**数（给用户一个交代：不是「什么都没找到」）
    ///
    /// 现在没有扩展名白名单了，所以「文件」就是字面意思（含本来也读不出文字的二进制文件）。
    /// 不含被排除目录里的文件 —— 那些目录整棵没进去，里面有多少份无从得知。
    pub ignored: usize,
    /// 整棵跳过的「依赖 / 构建产物」目录个数（见 [`SKIPPED_DIR_NAMES`]）
    pub skipped_dirs: usize,
    /// 看着不是文本、也不是 PDF 的份数（图片 / 压缩包 / 可执行文件…）
    pub not_text: usize,
    /// 纯文本但超过 [`MAX_TEXT_FILE_BYTES`] 的份数
    pub text_too_large: usize,
    /// PDF 但超过 [`MAX_PARSE_DOC_BYTES`] 的份数
    pub pdf_too_large: usize,
}

/// 一层 `.gitignore`（所在目录的相对路径 + 已编译的匹配器）
struct Layer {
    /// 相对扫描根目录（根自己的 .gitignore 用空串）
    dir: String,
    matcher: Gitignore,
}

/// 一叠按深浅排好的 `.gitignore` 规则栈
///
/// 两种用法共用同一份求值逻辑：
/// - 压缩包：一次给全（[`Self::from_sources`]）；
/// - 文件夹：边走边压弹（[`Self::push_source`] / [`Self::pop`]），与 git「就近的规则说了算」同一套语义。
pub struct IgnoreLayers {
    layers: Vec<Layer>,
}

impl IgnoreLayers {
    /// 没有任何 `.gitignore`
    pub fn new() -> Self {
        Self { layers: Vec::new() }
    }

    /// 一次性构建（压缩包用：先把包内所有 .gitignore 读出来，再统一过滤条目）
    ///
    /// 位于**被排除目录里**的 .gitignore 会被丢掉 —— git 根本不会进那个目录，里面的规则也就不存在。
    /// （文件夹扫描不需要这一步：那种目录整棵不会被遍历到。）
    pub fn from_sources(mut sources: Vec<(String, String)>) -> Self {
        // 浅的在前、深的在后：匹配时从后往前问，先给答案的那层说了算
        sources.sort_by_key(|(dir, _)| dir.matches('/').count());
        let mut me = Self::new();
        for (dir, content) in sources {
            if !dir.is_empty() && me.is_ignored(&dir, true) {
                continue;
            }
            me.push_source(&dir, &content);
        }
        me
    }

    /// 压入一层（`dir` = 相对扫描根目录，根自己的 .gitignore 用空串）。返回是否真的压入了规则
    fn push_source(&mut self, dir: &str, content: &str) -> bool {
        match build_layer(dir, content) {
            Some(layer) => {
                self.layers.push(layer);
                true
            }
            None => false,
        }
    }

    /// 弹出最近压入的一层
    fn pop(&mut self) {
        self.layers.pop();
    }

    /// 这条相对路径是否被排除。
    ///
    /// 越深的 `.gitignore` 越先说话：根目录写 `!docs/x.md`、`docs/` 里又写 `*.md`，那 `docs/x.md`
    /// 仍然算被排除（和 git 一致：就近的规则说了算）。
    pub fn is_ignored(&self, rel_path: &str, is_dir: bool) -> bool {
        for layer in self.layers.iter().rev() {
            let sub = if layer.dir.is_empty() {
                rel_path
            } else {
                // 这层管不到这条路径（不深入匹配，避免 `docs/` 里的 `*.md` 误伤根目录的同名文件）
                match rel_path
                    .strip_prefix(layer.dir.as_str())
                    .and_then(|rest| rest.strip_prefix('/'))
                {
                    Some(rest) => rest,
                    None => continue,
                }
            };
            match layer.matcher.matched_path_or_any_parents(sub, is_dir) {
                ignore::Match::Ignore(_) => return true,
                ignore::Match::Whitelist(_) => return false,
                ignore::Match::None => continue,
            }
        }
        false
    }
}

impl Default for IgnoreLayers {
    fn default() -> Self {
        Self::new()
    }
}

/// 编译一层；`None` = 这一层的规则是空的（或整个文件都写坏了），不必留
fn build_layer(dir: &str, content: &str) -> Option<Layer> {
    // root 一律用 `.`（ignore 对 `.` 有「不剥路径前缀」的特例），
    // 于是「传进来的路径」就是「相对这一层所在目录的路径」—— 前缀剥离由 [`IgnoreLayers::is_ignored`]
    // 负责，免得把绝对路径 / 盘符交给 crate 去猜（它在剥不出前缀时会直接 panic）。
    let mut builder = GitignoreBuilder::new(".");
    // 打包工具带的 BOM 会让第一行规则整条失效，先摘掉
    let content = content.trim_start_matches('\u{feff}');
    for line in content.lines() {
        // 单行写坏不影响其它行（git 也是这么办的）
        let _ = builder.add_line(None, line);
    }
    let matcher = builder.build().ok()?;
    if matcher.is_empty() {
        return None;
    }
    Some(Layer {
        dir: dir.trim_matches('/').to_string(),
        matcher,
    })
}

/// 扫描文件夹：按内容挑出能导入的文件，跳过被 `.gitignore` 排除的与依赖 / 构建目录
pub fn scan_folder_for_import(dir: &str) -> Result<FolderScan, String> {
    let root = PathBuf::from(dir);
    if !root.is_dir() {
        return Err(format!("这不是一个文件夹：{}", dir));
    }
    let mut out = FolderScan::default();
    let mut layers = IgnoreLayers::new();
    walk(&root, "", 0, &mut layers, &mut out);
    Ok(out)
}

/// 递归遍历。`rel_dir` 是当前目录相对扫描根目录的路径（根目录为空串），`depth` 是它的段数。
fn walk(dir: &Path, rel_dir: &str, depth: usize, layers: &mut IgnoreLayers, out: &mut FolderScan) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return; // 读不了的目录跳过（权限 / 竞态删除），不打断整次导入
    };

    // 先收集这一层有什么：本层的 .gitignore 必须在决定子项之前生效，
    // 而 `read_dir` 迭代器是一次性的
    let mut children: Vec<(String, bool)> = Vec::new();
    for entry in entries.filter_map(|e| e.ok()) {
        let Some(name) = entry.file_name().to_str().map(|s| s.to_string()) else {
            continue; // 非 UTF-8 文件名：文档名要入库，这种直接跳过
        };
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        children.push((name, is_dir));
    }
    children.sort();

    // 本层有 .gitignore 就压一层（离开这一层时弹掉）
    let pushed = read_gitignore(dir)
        .map(|content| layers.push_source(rel_dir, &content))
        .unwrap_or(false);

    for (name, is_dir) in children {
        let rel = if rel_dir.is_empty() {
            name.clone()
        } else {
            format!("{}/{}", rel_dir, name)
        };
        if is_dir {
            if name == ".git" {
                continue; // 版本历史不是文档
            }
            if layers.is_ignored(&rel, true) {
                continue; // 被排除的目录整棵不进去（这一条不报数：与 git 一致地「最安静」）
            }
            // 依赖 / 构建产物整棵跳过。⚠️ 判断只发生在**子目录**上：用户自己选中的那个目录
            // 就算叫 dist/，也是他明确要导的，照常扫。
            if is_skipped_dir(&name) {
                out.skipped_dirs += 1;
                continue;
            }
            if depth + 1 >= SCAN_MAX_DEPTH {
                continue; // 再深就不看了（相对路径最多 SCAN_MAX_DEPTH 段）
            }
            walk(&dir.join(&name), &rel, depth + 1, layers, out);
        } else if layers.is_ignored(&rel, false) {
            out.ignored += 1;
        } else {
            match classify_file(&dir.join(&name), &name) {
                None => out.files.push(dir.join(&name).to_string_lossy().to_string()),
                Some(SkipReason::NotText) => out.not_text += 1,
                Some(SkipReason::TextTooLarge) => out.text_too_large += 1,
                Some(SkipReason::PdfTooLarge) => out.pdf_too_large += 1,
            }
        }
    }

    if pushed {
        layers.pop();
    }
}

/// 读这一层的 `.gitignore`（没有 / 读不出来 → `None`）
fn read_gitignore(dir: &Path) -> Option<String> {
    let path = dir.join(".gitignore");
    if !path.is_file() {
        return None;
    }
    std::fs::read(&path)
        .ok()
        .map(|bytes| String::from_utf8_lossy(&bytes).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// 造一棵目录树，返回根目录：
    /// ```text
    /// .gitignore        → ignored.md / secret/ / !secret/keep.md / notes.log
    /// .gitignore 自己   纯文本 → 也当文档收（不再按名字挑，隐藏文件也不例外）
    /// kept.md           文本，留下
    /// data.json         文本（新口径：不再看扩展名）
    /// script.py         文本
    /// 无扩展名脚本       文本（没有扩展名也算）
    /// 扫描件.pdf        PDF → 交给后端解析
    /// 大文档.txt        3 MB 文本 → 超过 2 MB
    /// 大图.png         3 MB 二进制 → 「不是文本」（先嗅探内容，再卡大小）
    /// 图.png            二进制（带 NUL）
    /// notes.log         被根目录的规则排除
    /// ignored.md        被根目录的规则排除
    /// gbk.txt           GBK 编码的中文（UTF-8 解不出来，但要算文本）
    /// node_modules/x.js 依赖目录整棵跳过
    /// proj/dist/y.js    子目录里的构建目录，同样跳过
    /// secret/drop.md    父目录被排除
    /// secret/keep.md    父目录被排除时 ! 取反也救不回来（与 git 一致）
    /// .git/objects/config.md  版本历史里的东西
    /// sub/.gitignore    → *.txt / !keep.txt
    /// sub/dropped.txt   被 sub 层的 *.txt 排除
    /// sub/keep.txt      被 sub 层的 ! 取反救回来
    /// sub/note.md       上一层没写 *.md，应照常导入
    /// a/b/c/d/e.md      第 5 段（要收）
    /// a/b/c/d/e/f.md    第 6 段（超层级，不要）
    /// ```
    fn fixture(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "virlen_import_scan_{}_{}",
            tag,
            uuid::Uuid::new_v4()
        ));
        let _ = fs::remove_dir_all(&root);
        let write = |rel: &str, content: &str| {
            let path = root.join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, content).unwrap();
        };
        let write_bytes = |rel: &str, bytes: &[u8]| {
            let path = root.join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, bytes).unwrap();
        };
        write(".gitignore", "ignored.md\nsecret/\n!secret/keep.md\nnotes.log\n");
        write("kept.md", "留下");
        write("data.json", "{\"a\": 1}");
        write("script.py", "print(1)");
        write("无扩展名脚本", "echo hi");
        write("扫描件.pdf", "%PDF-1.4 假 PDF，只看大小");
        write("大文档.txt", &"文".repeat(1_100_000)); // 每字 3 字节 → 3.3 MB
        let mut big_bin = vec![0x89u8, 0x50, 0x4e, 0x47];
        big_bin.resize(3 * 1024 * 1024, 0x00); // 3 MB 的二进制（满是 NUL）
        write_bytes("大图.png", &big_bin);
        write_bytes("图.png", &[0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x01]);
        write("notes.log", "被根目录的规则排除");
        write("ignored.md", "被根目录的规则排除");
        write_bytes("gbk.txt", &[0xd6, 0xd0, 0xce, 0xc4]); // “中文” 的 GBK 编码
        write("node_modules/x.js", "依赖目录里的东西");
        write("proj/dist/y.js", "子目录里的构建产物");
        write("secret/drop.md", "父目录被排除");
        write(
            "secret/keep.md",
            "父目录被排除时，! 取反也救不回来（与 git 一致）",
        );
        write(".git/objects/config.md", "版本历史里的东西");
        write("sub/.gitignore", "*.txt\n!keep.txt\n");
        write("sub/dropped.txt", "被 sub 层的 *.txt 排除");
        write("sub/keep.txt", "被 sub 层的 ! 取反救回来");
        write("sub/note.md", "上一层没写 *.md，应照常导入");
        write("a/b/c/d/e.md", "第 5 段");
        write("a/b/c/d/e/f.md", "第 6 段，超出上限");
        root
    }

    /// 把「绝对路径」收成「相对扫描根目录的路径」，方便断言
    fn rel_files(root: &Path, outcome: &FolderScan) -> Vec<String> {
        let root_norm = root.to_string_lossy().replace('\\', "/");
        let mut files: Vec<String> = outcome
            .files
            .iter()
            .map(|p| p.replace('\\', "/"))
            .map(|p| p.replace(&format!("{}/", root_norm), ""))
            .collect();
        files.sort();
        files
    }

    #[test]
    fn scan_is_extension_agnostic_and_sniffs_content() {
        let root = fixture("basic");
        let outcome = scan_folder_for_import(root.to_str().unwrap()).unwrap();

        assert_eq!(
            rel_files(&root, &outcome),
            vec![
                ".gitignore",
                "a/b/c/d/e.md",
                "data.json",
                "gbk.txt",
                "kept.md",
                "script.py",
                "sub/.gitignore",
                "sub/keep.txt",
                "sub/note.md",
                "扫描件.pdf",
                "无扩展名脚本",
            ],
            "任意扩展名的纯文本 + PDF 都要收；二进制、超 2 MB 的文本、被排除的、超出层级的都不收"
        );

        // 只数被 .gitignore 排除的**文件**：ignored.md + notes.log + sub/dropped.txt
        //（secret/ 里的不算：被排除的目录整棵没进去，里面有多少份无从得知）
        assert_eq!(outcome.ignored, 3);
        // node_modules/ 与 proj/dist/：两个依赖 / 构建目录
        assert_eq!(outcome.skipped_dirs, 2);
        // 图.png（带 NUL）、大图.png（5 MB 但先被嗅探判为二进制）
        assert_eq!(outcome.not_text, 2);
        assert_eq!(outcome.text_too_large, 1, "3.3 MB 的文本要按「超过 2 MB」报");
        assert_eq!(outcome.pdf_too_large, 0);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_folder_the_user_picked_directly_is_never_skipped_for_its_name() {
        let root = fixture("root_name");
        // 直接选 proj/dist 进来：它自己叫 dist，但那是用户明确要的目录
        let outcome = scan_folder_for_import(root.join("proj/dist").to_str().unwrap()).unwrap();
        assert_eq!(rel_files(&root.join("proj/dist"), &outcome), vec!["y.js"]);
        assert_eq!(outcome.skipped_dirs, 0, "根目录本身不参与「依赖目录」判断");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn pdf_over_the_parse_limit_is_reported_separately() {
        let root = std::env::temp_dir().join(format!(
            "virlen_import_scan_pdf_{}",
            uuid::Uuid::new_v4()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        // 不下真写 51 MB：写个稀疏文件（set_len 不落盘）
        let big = root.join("巨档.pdf");
        fs::File::create(&big)
            .unwrap()
            .set_len(MAX_PARSE_DOC_BYTES + 1)
            .unwrap();
        fs::write(root.join("小档.pdf"), "%PDF-1.4").unwrap();

        let outcome = scan_folder_for_import(root.to_str().unwrap()).unwrap();
        assert_eq!(rel_files(&root, &outcome), vec!["小档.pdf"]);
        assert_eq!(outcome.pdf_too_large, 1);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn sniff_is_text_matches_the_frontend_rules() {
        assert!(sniff_is_text(b"hello world\n"));
        assert!(sniff_is_text("中文，逗号。".as_bytes()));
        // 采样正好切在多字节字符中间：仍算文本
        assert!(sniff_is_text(&"中".as_bytes()[..2]));
        // GBK 中文（UTF-8 解不出来）
        assert!(sniff_is_text(&[0xd6, 0xd0, 0xce, 0xc4]));
        // NUL / 控制字符 / 空
        assert!(!sniff_is_text(b"abc\0def"));
        assert!(!sniff_is_text(&[0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]));
        assert!(!sniff_is_text(b""));
        // 一段真的二进制（PNG 头 + 随机字节）
        assert!(!sniff_is_text(&[
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48,
            0x44, 0x52,
        ]));
    }

    #[test]
    fn nested_gitignore_only_applies_inside_its_own_directory() {
        let root = fixture("nested");
        let outcome = scan_folder_for_import(root.to_str().unwrap()).unwrap();
        let files = rel_files(&root, &outcome);

        assert!(files.contains(&"sub/keep.txt".to_string()), "! 取反应当救回它");
        assert!(!files.contains(&"sub/dropped.txt".to_string()));
        assert!(files.contains(&"kept.md".to_string()), "根目录不受 sub 层规则影响");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn deeper_gitignore_wins_over_the_root_one() {
        // 根层：*.md 排除，但 !docs/readme.md 取反救回来
        let layers = IgnoreLayers::from_sources(vec![(
            String::new(),
            "*.md\n!docs/readme.md\n".to_string(),
        )]);
        assert!(layers.is_ignored("notes.md", false));
        assert!(!layers.is_ignored("docs/readme.md", false), "根层的取反先救回来");
        assert!(layers.is_ignored("other.md", false));

        // docs 层再把它排除：就近的规则说了算
        let layers = IgnoreLayers::from_sources(vec![
            (String::new(), "*.md\n".to_string()),
            ("docs".to_string(), "readme.md\n".to_string()),
        ]);
        assert!(layers.is_ignored("docs/readme.md", false));
        assert!(layers.is_ignored("root.md", false));
    }

    #[test]
    fn rule_in_a_subdirectory_never_matches_outside_it() {
        // `docs/.gitignore` 里写着 `*.md`，根目录的 a.md 不该受影响
        let layers = IgnoreLayers::from_sources(vec![("docs".to_string(), "*.md\n".to_string())]);
        assert!(layers.is_ignored("docs/a.md", false));
        assert!(!layers.is_ignored("a.md", false));
    }

    #[test]
    fn directory_rules_match_the_directory_itself() {
        let layers = IgnoreLayers::from_sources(vec![(String::new(), "build/\n".to_string())]);
        assert!(layers.is_ignored("build", true), "目录规则要能把目录本身挡在门外");
        assert!(layers.is_ignored("build/x.md", false));
        assert!(!layers.is_ignored("build.md", false), "普通文件的同名不该被目录规则连坐");
    }

    #[test]
    fn gitignore_inside_an_ignored_directory_is_dropped() {
        // secret/ 被排除 → secret/.gitignore 也不存在（git 不进那个目录）
        let layers = IgnoreLayers::from_sources(vec![
            (String::new(), "secret/\n".to_string()),
            ("secret".to_string(), "*.md\n".to_string()),
        ]);
        assert_eq!(layers.layers.len(), 1, "只应留下根层那份");
        assert!(layers.is_ignored("secret/notes.md", false));
    }

    #[test]
    fn empty_gitignore_leaves_no_layer() {
        let layers = IgnoreLayers::from_sources(vec![
            (String::new(), "\n# 只有注释\n".to_string()),
            ("docs".to_string(), "   \n".to_string()),
        ]);
        assert!(layers.layers.is_empty(), "空规则不该留层");
        assert!(!layers.is_ignored("a.md", false));
        assert!(!IgnoreLayers::new().is_ignored("a.md", false));
    }

    #[test]
    fn a_broken_line_does_not_disable_the_rest_of_the_file() {
        // 写坏的行只会被忽略（git 也是这么办的），同一份文件里其它规则照旧生效
        let layers = IgnoreLayers::from_sources(vec![(String::new(), "*.md\n[\n".to_string())]);
        assert!(layers.is_ignored("a.md", false));
        assert!(!layers.is_ignored("a.txt", false));
    }

    #[test]
    fn push_source_and_pop_restore_the_previous_rules() {
        let mut layers = IgnoreLayers::new();
        assert!(layers.push_source("", "*.tmp\n"));
        assert!(layers.is_ignored("a.tmp", false));
        assert!(!layers.is_ignored("docs/readme.md", false));
        assert!(layers.push_source("docs", "readme.md\n"));
        assert!(layers.is_ignored("docs/readme.md", false));
        layers.pop();
        assert!(!layers.is_ignored("docs/readme.md", false), "弹出后只剩根层规则");
        assert!(layers.is_ignored("a.tmp", false));
        layers.pop();
        assert!(!layers.is_ignored("a.tmp", false));
        // 空规则压不进去（免得留一层永远不命中的规则）
        assert!(!layers.push_source("", "# 注释\n"));
    }

    #[test]
    fn scan_rejects_a_path_that_is_not_a_directory() {
        let err = scan_folder_for_import("C:/definitely/not/here_12345").unwrap_err();
        assert!(err.contains("不是一个文件夹"), "实际：{}", err);
    }

    #[test]
    fn parseable_doc_is_decided_by_name_only() {
        assert!(is_parseable_doc("a.pdf"));
        assert!(is_parseable_doc("A.PDF"));
        assert!(!is_parseable_doc("a.md"), "md 是纯文本，不走后端解析这条路");
        assert!(!is_parseable_doc(".pdf"), "没有主名的不算");
        assert!(!is_parseable_doc("pdf"), "没有扩展名的不算");
    }

    #[test]
    fn skipped_dir_names_cover_dependencies_and_builds_but_not_real_content() {
        assert!(is_skipped_dir("node_modules"));
        assert!(is_skipped_dir("Node_Modules"), "大小写不敏感");
        assert!(is_skipped_dir(".venv"));
        assert!(is_skipped_dir("target"));
        assert!(is_skipped_dir("dist"));
        assert!(is_skipped_dir("__pycache__"));
        // 可能是真内容的目录不跳
        for name in ["docs", "notes", "src", "lib", "bin", "assets"] {
            assert!(!is_skipped_dir(name), "{} 不该被跳过", name);
        }
    }
}
