//! 文档解析的**进程内缓存**（60 秒 + 文件指纹失效；2026-10 用户定的）—— 见 `docs/doc-parse-plan.md` §22。
//!
//! 为什么需要：`offset` 续读、换个 `sheet` 再看一眼、同一次会话里反复打开同一份文档，走的都是
//! **整份重新解析**（PDF 重排版面、Office 重建 IR、内嵌图片把端侧 OCR 再跑一遍 —— 后者是秒级 / 张）。
//! 这类连续操作通常发生在几秒之内，一次缓存就能把重复的那几秒全省掉。
//!
//! 三条规矩（改这里之前先把它们读完）：
//! 1. **失效靠文件指纹**：存的时候记下 SHA-256 前 16 位 hex；`lookup` 的调用方**必须先算一遍**
//!    （[`fingerprint`]）—— 指纹不一致 = 文件变了 = 重新抽取，并把新结果覆盖进去。
//! 2. **过期是懒的**：没有定时器、没有后台线程 —— 每次 `lookup` / `store` 顺手把过期项扔掉
//!    （用户要求：「不必须一分钟就立即丢失，下次调用解析工具时检查即可」）。
//! 3. **只缓存成功的正文**：解析失败（`ParseError`）/ 没抽到文字都**不进**缓存 —— 上不了台面的
//!    东西不该被复用，何况它们的代价本来就低。
//!
//! 缓存的是**切片之前的一切**（[`ExtractedDoc`]：正文 + 工作表名 + `note` + OCR 摘要），所以
//! `offset` / `max_chars` / `full_text` 怎么变都能命中同一条；反过来，**会影响抽取结果**的参数
//! （`sheet` / OCR 模式）必须进 [`Key`]。
//!
//! ⚠️ 已知取舍（都是有意的，别当成 bug 改掉）：
//! - 指纹要**读一遍文件**（流式，不占内存）：命中省下整份解析，未命中多付一遍磁盘 IO
//!   （刚解析过的文件通常还在页缓存里，代价是毫秒级）；
//! - 不处理「算完指纹到真正解析之间文件又变了」这种 TOCTOU：1 分钟的缓存不值得加文件锁 / 持句柄；
//! - **不做 in-flight 合并**：同一份文档被并发解析两次就是解析两次（结果一致，各自覆盖缓存）；
//! - OCR 模型「在不在」不进键：模型恰好在这 60 秒里装好的话，`note` 里那句「OCR 不可用」要到过期才更新；
//! - 指纹不一致的旧条目**不当场删**（它永远不会被当成命中），等新结果覆盖或过期时清掉。

use super::OcrSummary;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::time::{Duration, Instant};

/// 缓存有效期：**60 秒**（从存入那一刻算起，不是滑动窗口）。
pub const CACHE_TTL: Duration = Duration::from_secs(60);

/// 最多留几条 —— 满了淘汰**最旧**的那条（防止一路解析不同文档把内存攒起来）
const MAX_ENTRIES: usize = 8;

/// 单份正文超过这个字符数就不进缓存。
///
/// 一份接近 50 MB 上限的文档正文可能几千万字，按住 1 分钟的收益（省一次续读）远小于代价（几十 MB 内存）。
const MAX_CACHED_CHARS: usize = 1_000_000;

/// 算指纹时的读块大小
const HASH_CHUNK: usize = 64 * 1024;

/// 指纹长度（SHA-256 前多少位 hex）：64 bit 足够区分「1 分钟内同一路径下的两份文件」
const FINGERPRINT_LEN: usize = 16;

// ═══════════════════════════════════════════════════════════════════════════
// 键与内容
// ═══════════════════════════════════════════════════════════════════════════

/// OCR 模式（进缓存键：同一份文档「不读图」与「读图」抽出来的正文不是一回事）
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum OcrMode {
    /// 完全不跑（`ocrImages: false`，或调用方没给 `ocr`）
    Off,
    /// 只有「除图片外没有文字」才跑（`ocrImages` 没传）
    Auto,
    /// 有正文也跑（`ocrImages: true`）
    Always,
}

impl OcrMode {
    /// 从 `ParseOptions::ocr` 推导 —— 三态语义（`None` / `always`）只有这一份映射
    pub fn of(ocr: Option<&super::OcrOptions>) -> Self {
        match ocr {
            None => Self::Off,
            Some(o) if o.always => Self::Always,
            Some(_) => Self::Auto,
        }
    }
}

/// 缓存键 = 路径 + 会**改变抽取结果**的参数。
///
/// ⚠️ `offset` / `max_chars` / `full_text` **不进键**：它们切的是同一份全文（这正是缓存的价值所在）。
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Key {
    /// 调用方给的路径（工具与 GUI 命令传的都是已过安全校验的绝对路径）
    path: String,
    /// `sheet`（只有 `xlsx` / `xls` 有意义，但换个表就是另一份正文）
    sheet: Option<String>,
    /// OCR 模式
    ocr: OcrMode,
}

impl Key {
    pub fn new(path: &str, sheet: Option<&str>, ocr: OcrMode) -> Self {
        Self {
            path: path.to_string(),
            sheet: sheet.map(str::to_string),
            ocr,
        }
    }
}

/// 抽取结果 = **切片之前的一切**（缓存存的就是它）
#[derive(Clone)]
pub struct ExtractedDoc {
    /// 全文（`offset` / `max_chars` 在命中之后才切）
    pub raw: String,
    /// 工作簿里全部工作表名（仅 `xlsx` / `xls`）
    pub sheets: Vec<String>,
    /// 实际生效的工作表名
    pub sheet: Option<String>,
    /// 需要模型知道的说明（行序退回原样 / OCR 摘要 / …）
    pub note: Option<String>,
    /// OCR 结果摘要（`None` = 这条解析链没碰 OCR）
    pub ocr: Option<OcrSummary>,
}

/// 一条缓存：文件指纹 + 存入时刻 + 内容
struct Entry {
    fingerprint: String,
    stored: Instant,
    doc: ExtractedDoc,
}

// ═══════════════════════════════════════════════════════════════════════════
// 缓存本体
// ═══════════════════════════════════════════════════════════════════════════

/// 缓存本体（进程级；与 `vision` 的模型引用计数同一种约定：静态 + `Mutex`，与会话无关）。
///
/// ⚠️ 测试下**每个线程一份**：测试是并行跑在同一个进程里的，共用一张表会让「刚存进去就该命中」
/// 与别人的淘汰互相打架（一个用例断言失败，原因却在另一个用例身上）。被测的**逻辑**
/// （[`lookup_in`] / [`store_in`]）与线上**完全同一份**，这里换的只是「这张表住在哪儿」。
#[cfg(not(test))]
static CACHE: once_cell::sync::Lazy<std::sync::Mutex<HashMap<Key, Entry>>> =
    once_cell::sync::Lazy::new(|| std::sync::Mutex::new(HashMap::new()));

#[cfg(test)]
thread_local! {
    static CACHE: std::cell::RefCell<HashMap<Key, Entry>> =
        std::cell::RefCell::new(HashMap::new());
}

/// 命中计数 —— **只给测试**（证明「第二次调用确实没重新抽取」）
#[cfg(test)]
static HITS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// 拿到那张表跑一段逻辑；拿不到（锁中毒）→ `None`（缓存坏了只该让缓存失效，绝不能让解析失败）
#[cfg(not(test))]
fn with_cache<R>(f: impl FnOnce(&mut HashMap<Key, Entry>) -> R) -> Option<R> {
    let mut cache = CACHE.lock().ok()?;
    Some(f(&mut cache))
}

#[cfg(test)]
fn with_cache<R>(f: impl FnOnce(&mut HashMap<Key, Entry>) -> R) -> Option<R> {
    Some(CACHE.with(|cache| f(&mut cache.borrow_mut())))
}

/// 文件内容指纹：SHA-256 前 [`FINGERPRINT_LEN`] 位 hex。
///
/// 只用来判「这份文件还是不是上次那份」（进程内、1 分钟窗口），**不是安全指纹**，
/// 也不该拿它对用户宣称「文件没被改过」。
///
/// 流式读：不把文件整个装进内存（文档可以是几十 MB）。
pub fn fingerprint(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; HASH_CHUNK];
    loop {
        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let full = hex::encode(hasher.finalize());
    Ok(full[..FINGERPRINT_LEN].to_string())
}

/// 查缓存：指纹一致且没过期 → 命中（返回抽取结果的副本）；否则 `None`。
///
/// ⚠️ 调用方必须**先算好指纹**（[`fingerprint`]）再进来 —— 键里没有指纹，就是逼调用方先看文件。
pub fn lookup(key: &Key, fingerprint: &str) -> Option<ExtractedDoc> {
    let hit = with_cache(|cache| lookup_in(cache, key, fingerprint, Instant::now(), CACHE_TTL))?;
    #[cfg(test)]
    {
        if hit.is_some() {
            HITS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
    }
    hit
}

/// 查缓存的真正实现：表 + 时刻 + 有效期都从外面传
///（过期是时间的函数，注入时钟才能确定性地测它）
fn lookup_in(
    cache: &mut HashMap<Key, Entry>,
    key: &Key,
    fingerprint: &str,
    now: Instant,
    ttl: Duration,
) -> Option<ExtractedDoc> {
    // 懒清理：没有定时器，就在每次访问时把过期项扔掉
    cache.retain(|_, entry| !is_expired(entry, now, ttl));
    cache
        .get(key)
        .filter(|entry| is_usable(entry, fingerprint, now, ttl))
        .map(|entry| entry.doc.clone())
}

/// 存一条（指纹 + 抽取结果）。超过 [`MAX_CACHED_CHARS`] 的正文直接不存。
pub fn store(key: Key, fingerprint: String, doc: &ExtractedDoc) {
    // 先看长度：几千万字的正文按住 1 分钟不值
    if doc.raw.chars().count() > MAX_CACHED_CHARS {
        return;
    }
    let now = Instant::now();
    with_cache(|cache| store_in(cache, key, fingerprint, doc, now));
}

/// 存缓存的真正实现（时刻从外面传，便于测试）
fn store_in(
    cache: &mut HashMap<Key, Entry>,
    key: Key,
    fingerprint: String,
    doc: &ExtractedDoc,
    now: Instant,
) {
    cache.retain(|_, entry| !is_expired(entry, now, CACHE_TTL));
    // 满了先腾位（覆盖同一个键不增加条数，不必腾）
    if !cache.contains_key(&key) && cache.len() >= MAX_ENTRIES {
        if let Some(oldest) = oldest_key(cache) {
            cache.remove(&oldest);
        }
    }
    cache.insert(
        key,
        Entry {
            fingerprint,
            stored: now,
            doc: doc.clone(),
        },
    );
}

/// 这条记录能不能用：文件还是那份（指纹一致）**且**还没过期
fn is_usable(entry: &Entry, fingerprint: &str, now: Instant, ttl: Duration) -> bool {
    entry.fingerprint == fingerprint && !is_expired(entry, now, ttl)
}

/// 过期了吗（正好 [`CACHE_TTL`] = 过期：「超过时间就丢失」）
fn is_expired(entry: &Entry, now: Instant, ttl: Duration) -> bool {
    now.duration_since(entry.stored) >= ttl
}

/// 满了该淘汰谁：最旧的那条（纯函数，便于确定性测试）
fn oldest_key(cache: &HashMap<Key, Entry>) -> Option<Key> {
    cache
        .iter()
        .min_by_key(|(_, entry)| entry.stored)
        .map(|(key, _)| key.clone())
}

/// 测试用：这条键还在缓存里吗（验证懒清理真的把过期项扔了）
#[cfg(test)]
pub(crate) fn holds(key: &Key) -> bool {
    with_cache(|cache| cache.contains_key(key)).unwrap_or(false)
}

/// 测试用：命中计数（**单调递增**，跨用例共享，故断言一律用「增量」）
#[cfg(test)]
pub(crate) fn hits() -> usize {
    HITS.load(std::sync::atomic::Ordering::Relaxed)
}

#[cfg(test)]
mod tests;
