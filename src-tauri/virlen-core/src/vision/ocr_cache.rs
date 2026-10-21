//! 图片 OCR 结果的**磁盘缓存** —— 「这张图以前识别过，就直接把文本给出去」。
//!
//! 为什么按**内容指纹**（而不是路径）：同一张图会以三种身份出现 —— 工作目录里的文件路径、
//! 消息里的 `data:` URL、面板里的 `blob:` URL。按路径缓存会把同一张图当成三张，按指纹就只算一次。
//!
//! 为什么落盘：OCR 是秒级 CPU 密集操作（首次还要加载 ONNX 模型），而「点开图看一眼」一天能重复
//! 几十次 —— 只做进程内缓存，重启之后等于全部白算。
//!
//! ⚠️ **空结果不落盘**：quasivision 的 `detect_text` 把「引擎没就绪 / predict 失败」直接吞成
//! 空文本（只往 stderr 打一行，GUI 里根本看不到），与「图里真的没有字」**无法区分**。
//! 落盘就等于把一次瞬时失败永久固化成「这张图没有文字」（实测踩过：用户那次的空结果进了缓存，
//! 之后同一张图永远返回空）。宁可对真没字的图每次重算，也不要有错结果。
//!
//! ⚠️ 缓存只是加速手段，读写失败**绝不能**影响 OCR 结果本身：一律 best-effort，只往 stderr 记一行
//! （理由同 `vision/mod.rs`：stdout 是 CLI 的机器可读通道）。文件损坏 / 版本不符一律当作空缓存。

use crate::agent::host::HostEnv;
use crate::vision::OcrBox;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// 缓存文件（放在 `HostEnv::data_dir()`，与会话库 `virlen.db` 同级）
const CACHE_FILE: &str = "image-ocr-cache.json";

/// 文件格式版本：不认识就整份丢弃（旧格式的坏条目比重新 OCR 一次更贵）
const VERSION: u32 = 2;

/// 条目上限；越线时按写入时间淘汰到 [`KEEP_ENTRIES`]。一张图的文本通常几 KB，
/// 400 条 ≈ 1MB 量级 —— 再大就该换存储形态了（那时再想 sqlite，不为省几 KB 提前做）。
const MAX_ENTRIES: usize = 400;
const KEEP_ENTRIES: usize = 300;

#[derive(Clone, Serialize, Deserialize)]
struct Entry {
    /// OCR 文本（**不会为空**：空结果不入缓存，见模块头）
    text: String,
    #[serde(default)]
    boxes: Vec<OcrBox>,
    #[serde(default)]
    width: u32,
    #[serde(default)]
    height: u32,
    /// 写入时间（Unix 秒）—— 只用于淘汰
    at: u64,
}

/// One cached OCR result: text + per-box coordinates (plus the coordinate space size).
///
/// v2 新增了 `boxes` / `width` / `height`：预览的透明定位层要用文本框坐标。
/// v1 条目只有文本、没有框，命中之后就定位不了字 —— 所以 `VERSION` 抬到 2，v1 文件整份丢弃重算。
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CachedOcr {
    pub text: String,
    pub boxes: Vec<OcrBox>,
    pub width: u32,
    pub height: u32,
}

#[derive(Serialize, Deserialize)]
struct FileBody {
    version: u32,
    entries: HashMap<String, Entry>,
}

/// 进程内镜像：一个进程只服务一个数据目录，所以只需要一份
struct Mirror {
    file: PathBuf,
    entries: HashMap<String, Entry>,
}

static MIRROR: Lazy<Mutex<Option<Mirror>>> = Lazy::new(|| Mutex::new(None));

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn read_cache(path: &Path) -> HashMap<String, Entry> {
    let raw = match std::fs::read_to_string(path) {
        Ok(r) => r,
        // 第一次运行（文件还不存在）是最常见的情况，不算异常
        Err(_) => return HashMap::new(),
    };
    match serde_json::from_str::<FileBody>(&raw) {
        Ok(mut body) if body.version == VERSION => {
            // 旧版本 / 旧逻辑写进来的空条目不认（见模块头：空结果可能是瞬时失败）
            let stale = body.entries.len();
            body.entries
                .retain(|_, e| !e.text.trim().is_empty() && !e.boxes.is_empty());
            let dropped = stale - body.entries.len();
            if dropped > 0 {
                eprintln!("[Vision] Dropped {} empty OCR cache entries", dropped);
            }
            body.entries
        }
        Ok(body) => {
            // 版本不符（v1 条目没有框）：整份丢弃，让每张图重算一次（秒级、一次性）
            eprintln!(
                "[Vision] OCR cache format v{} != v{}, starting empty: {}",
                body.version,
                VERSION,
                path.display()
            );
            HashMap::new()
        }
        Err(_) => {
            eprintln!("[Vision] OCR cache unreadable, starting empty: {}", path.display());
            HashMap::new()
        }
    }
}

fn write_cache(path: &Path, entries: &HashMap<String, Entry>) {
    // 整份重写而不是增量追加：条目少（见 MAX_ENTRIES），换来「坏了也只是丢缓存」
    let body = FileBody {
        version: VERSION,
        entries: entries.clone(),
    };
    let json = match serde_json::to_string(&body) {
        Ok(j) => j,
        Err(e) => {
            eprintln!("[Vision] Failed to serialize OCR cache: {}", e);
            return;
        }
    };
    if let Some(dir) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(dir) {
            eprintln!("[Vision] Failed to create OCR cache dir: {}", e);
            return;
        }
    }
    if let Err(e) = std::fs::write(path, json) {
        eprintln!("[Vision] Failed to write OCR cache: {}", e);
    }
}

/// 超出上限时淘汰最旧的（缓存只求「别重复算」，没有保留价值梯度）
fn prune(entries: &mut HashMap<String, Entry>) {
    if entries.len() <= MAX_ENTRIES {
        return;
    }
    let mut keys: Vec<(u64, String)> = entries.iter().map(|(k, v)| (v.at, k.clone())).collect();
    keys.sort_by_key(|(at, _)| *at);
    for (_, key) in keys.into_iter().take(entries.len() - KEEP_ENTRIES) {
        entries.remove(&key);
    }
}

/// 内容指纹：`sha256(字节)` 的十六进制串。
///
/// 用密码学哈希而不是长度 + 采样：路径 / data URL / blob URL 三种来源都要落到同一个键上，
/// 而「采样」在截图上撞车的概率不低（同一套 UI 的截图头部往往一样）。
pub fn fingerprint(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

/// 取得「这个数据目录对应的镜像」；目录变了（多数据目录 / 测试）就重新读盘
fn mirror_for<'a>(slot: &'a mut Option<Mirror>, host: &dyn HostEnv) -> &'a mut Mirror {
    let file = host.data_dir().join(CACHE_FILE);
    let stale = slot.as_ref().map(|m| m.file != file).unwrap_or(true);
    if stale {
        let entries = read_cache(&file);
        *slot = Some(Mirror { file, entries });
    }
    slot.as_mut().expect("刚刚填充过")
}

/// 读缓存：`Some(text)` 即命中（**空串同样算命中**），`None` = 这张图没识别过
pub fn get(host: &dyn HostEnv, key: &str) -> Option<CachedOcr> {
    let mut guard = MIRROR.lock().ok()?;
    let mirror = mirror_for(&mut guard, host);
    mirror.entries.get(key).map(|e| CachedOcr {
        text: e.text.clone(),
        boxes: e.boxes.clone(),
        width: e.width,
        height: e.height,
    })
}

/// 写缓存（best-effort：失败只记日志，调用方照常拿到 OCR 结果）
///
/// 空结果**一律不写**：它可能是「真的没字」，也可能是引擎/推理的瞬时失败（模块头）。
pub fn put(host: &dyn HostEnv, key: &str, ocr: &CachedOcr) {
    if ocr.text.trim().is_empty() {
        return;
    }
    let mut guard = match MIRROR.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    let mirror = mirror_for(&mut guard, host);
    mirror.entries.insert(
        key.to_string(),
        Entry {
            text: ocr.text.clone(),
            boxes: ocr.boxes.clone(),
            width: ocr.width,
            height: ocr.height,
            at: now(),
        },
    );
    prune(&mut mirror.entries);
    write_cache(&mirror.file, &mirror.entries);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct FixedHost {
        data: PathBuf,
    }
    impl HostEnv for FixedHost {
        fn resource_candidates(&self) -> Vec<PathBuf> {
            vec![self.data.clone()]
        }
        fn data_dir(&self) -> PathBuf {
            self.data.clone()
        }
    }

    fn tmp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "virlen_ocr_cache_{}_{}",
            tag,
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 丢掉进程内镜像，模拟「应用重启」
    fn restart() {
        *MIRROR.lock().unwrap() = None;
    }

    /// 造一条缓存（带一个框：没有框的条目会被当成「摆不出位置」丢掉）
    fn cached(x: i32, y: i32, w: i32, h: i32, text: &str) -> CachedOcr {
        CachedOcr {
            text: text.to_string(),
            boxes: vec![OcrBox {
                text: text.to_string(),
                x,
                y,
                w,
                h,
            }],
            width: 800,
            height: 600,
        }
    }

    #[test]
    fn fingerprint_is_content_based() {
        assert_eq!(fingerprint(b"abc"), fingerprint(b"abc"));
        assert_ne!(fingerprint(b"abc"), fingerprint(b"abd"));
        // 长度一样、只有一个字节不同也必须区分
        assert_ne!(fingerprint(b"12345678"), fingerprint(b"12345679"));
    }

    #[test]
    fn put_survives_restart() {
        let dir = tmp_dir("roundtrip");
        let host = FixedHost { data: dir.clone() };
        let key = fingerprint(b"pic");

        assert!(get(&host, &key).is_none(), "没写过就是没命中");
        put(&host, &key, &cached(10, 20, 100, 30, "识别出的文字"));
        let hit = get(&host, &key).expect("刚写完应当命中");
        assert_eq!(hit.text, "识别出的文字");
        assert_eq!(hit.boxes.len(), 1, "文本框坐标也要活下来（定位层靠它）");
        assert_eq!((hit.width, hit.height), (800, 600));

        restart();
        let hit = get(&host, &key).expect("重启后仍命中（落盘生效）");
        assert_eq!(hit.text, "识别出的文字");
        assert_eq!((hit.boxes[0].x, hit.boxes[0].y), (10, 20));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 空结果不写盘（可能是引擎瞬时失败，不能固化成「这张图没有文字」）
    #[test]
    fn empty_text_is_never_cached() {
        let dir = tmp_dir("empty");
        let host = FixedHost { data: dir.clone() };
        let key = fingerprint(b"blank");

        put(&host, &key, &cached(0, 0, 1, 1, ""));
        put(&host, &key, &cached(0, 0, 1, 1, "   \n "));
        assert!(get(&host, &key).is_none());
        restart();
        assert!(get(&host, &key).is_none(), "落盘文件里也不该出现空条目");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// v1 文件（条目没有框）整份丢弃：命中之后定位层摆不出位置，不如重算
    #[test]
    fn legacy_version_file_is_discarded() {
        let dir = tmp_dir("legacy-v1");
        let raw = r#"{"version":1,"entries":{"keep":{"text":"有字","at":2}}}"#;
        std::fs::write(dir.join(CACHE_FILE), raw).unwrap();
        let host = FixedHost { data: dir.clone() };

        assert!(get(&host, "keep").is_none(), "v1 条目没有框，不能当命中");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 同版本但「有文本没框」的条目也丢（手改 / 写半截的文件）
    #[test]
    fn entries_without_boxes_are_dropped_on_load() {
        let dir = tmp_dir("no-boxes");
        let raw = r#"{"version":2,"entries":{"nobox":{"text":"有字","at":1}}}"#;
        std::fs::write(dir.join(CACHE_FILE), raw).unwrap();
        let host = FixedHost { data: dir.clone() };

        assert!(get(&host, "nobox").is_none(), "没框就定位不了，不如重算");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn separate_data_dirs_do_not_share_entries() {
        let a = tmp_dir("dir-a");
        let b = tmp_dir("dir-b");
        let host_a = FixedHost { data: a.clone() };
        let host_b = FixedHost { data: b.clone() };
        let key = fingerprint(b"pic");

        put(&host_a, &key, &cached(1, 2, 3, 4, "hello"));
        assert_eq!(get(&host_a, &key).map(|h| h.text), Some("hello".to_string()));
        assert!(get(&host_b, &key).is_none(), "另一个数据目录不该看到这条缓存");

        std::fs::remove_dir_all(&a).ok();
        std::fs::remove_dir_all(&b).ok();
    }

    #[test]
    fn broken_cache_file_falls_back_to_empty() {
        let dir = tmp_dir("broken");
        std::fs::write(dir.join(CACHE_FILE), "{not json").unwrap();
        let host = FixedHost { data: dir.clone() };
        assert!(get(&host, &fingerprint(b"pic")).is_none());
        // 坏文件不该让写入也失效
        put(&host, &fingerprint(b"pic"), &cached(0, 0, 5, 5, "ok"));
        assert_eq!(
            get(&host, &fingerprint(b"pic")).map(|h| h.text),
            Some("ok".to_string())
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn prune_keeps_the_newest_entries() {
        let mut entries: HashMap<String, Entry> = HashMap::new();
        for i in 0..(MAX_ENTRIES + 10) {
            entries.insert(
                format!("k{i}"),
                Entry {
                    text: "t".to_string(),
                    boxes: Vec::new(),
                    width: 0,
                    height: 0,
                    at: i as u64,
                },
            );
        }
        prune(&mut entries);
        assert_eq!(entries.len(), KEEP_ENTRIES);
        assert!(entries.contains_key(&format!("k{}", MAX_ENTRIES + 9)), "最新的那条要在");
        assert!(!entries.contains_key("k0"), "最旧的应当被淘汰");
    }
}
