//! `doc_parse::cache` 的单元测试 —— 指纹 / 键 / 懒过期 / 上限与淘汰。
//!
//! 两条纪律（缓存是**进程级静态**，测试并行跑）：
//! 1. 键与临时文件都用 `Uuid` 造，绝不与别的用例撞；
//! 2. 「过期」「淘汰」这类要看时刻的用例一律用**本地表 + 显式时钟**（`store_in` / `lookup_in`），
//!    只在验证「公开入口接的是同一张表」时才用 `store` / `lookup`。

use super::*;
use crate::doc_parse::ocr::OcrOptions;
use uuid::Uuid;

/// 一个只属于本次用例的键（路径带 uuid）
fn unique_key(tag: &str) -> Key {
    Key::new(&format!("C:/ws/{tag}-{}", Uuid::new_v4()), None, OcrMode::Off)
}

fn doc(raw: &str) -> ExtractedDoc {
    ExtractedDoc {
        raw: raw.to_string(),
        sheets: Vec::new(),
        sheet: None,
        note: None,
        ocr: None,
    }
}

/// 临时文件目录 + 文件（跑完删目录）
fn tmp_file(tag: &str, content: &[u8]) -> (std::path::PathBuf, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("virlen_doc_cache_{}_{}", tag, Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("a.txt");
    std::fs::write(&file, content).unwrap();
    (dir, file)
}

/// `ocrImages` 的三态 → 缓存键里的模式（两侧各解一次就会分叉：`None` 不等于 `always`）
#[test]
fn the_ocr_mode_comes_from_the_three_state_option() {
    assert_eq!(OcrMode::of(None), OcrMode::Off);
    let opts = |always| OcrOptions {
        models_dir: Err("no models".to_string()),
        always,
        cancel: None,
    };
    assert_eq!(OcrMode::of(Some(&opts(false))), OcrMode::Auto);
    assert_eq!(OcrMode::of(Some(&opts(true))), OcrMode::Always);
}

/// 换个 `sheet` / 换个 OCR 模式 = 另一份正文 = 另一个键；同一个键要能相等（`HashMap` 的前提）
#[test]
fn the_key_splits_by_everything_that_changes_the_text() {
    let path = "C:/ws/报表.xlsx";
    assert_eq!(
        Key::new(path, None, OcrMode::Off),
        Key::new(path, None, OcrMode::Off)
    );
    assert_ne!(
        Key::new(path, None, OcrMode::Off),
        Key::new(path, Some("销售"), OcrMode::Off),
        "换一张工作表就是另一份正文"
    );
    assert_ne!(
        Key::new(path, None, OcrMode::Off),
        Key::new(path, None, OcrMode::Always),
        "读图与不读图抽出来的正文不同"
    );
}

/// 同一份文件：存了就能命中；**指纹变了（文件改了）必须未命中** ——
/// 这是「改动过的文档要重新识别」的全部依据
#[test]
fn a_hit_requires_the_same_fingerprint() {
    let mut cache: HashMap<Key, Entry> = HashMap::new();
    let now = Instant::now();
    let key = unique_key("same-fp");
    store_in(&mut cache, key.clone(), "aaaa".to_string(), &doc("正文"), now);

    let hit = lookup_in(&mut cache, &key, "aaaa", now, CACHE_TTL).expect("指纹一致就该命中");
    assert_eq!(hit.raw, "正文");
    assert!(
        lookup_in(&mut cache, &key, "bbbb", now, CACHE_TTL).is_none(),
        "文件变了 → 必须重新抽取"
    );
}

/// 过期：正好 60 秒就算过期（「超过时间就丢失」），且**下次访问时**被清掉（懒清理，没有定时器）
#[test]
fn entries_expire_lazily_after_the_ttl() {
    let now = Instant::now();
    let entry = Entry {
        fingerprint: "fp".to_string(),
        stored: now,
        doc: doc("x"),
    };
    assert!(is_usable(&entry, "fp", now, CACHE_TTL));
    assert!(is_usable(&entry, "fp", now + Duration::from_secs(59), CACHE_TTL));
    assert!(
        !is_usable(&entry, "fp", now + CACHE_TTL, CACHE_TTL),
        "正好 60 秒算过期"
    );
    assert!(!is_usable(&entry, "fp", now + Duration::from_secs(61), CACHE_TTL));
    assert!(!is_expired(&entry, now + Duration::from_secs(1), CACHE_TTL));

    // 走一遍真正的存取（本地表 + 注入时钟）：过期的必须未命中，**并且**那条记录被清掉
    let mut cache: HashMap<Key, Entry> = HashMap::new();
    let key = unique_key("expired");
    store_in(&mut cache, key.clone(), "fp".to_string(), &doc("会过期的正文"), now);
    assert!(lookup_in(&mut cache, &key, "fp", now, CACHE_TTL).is_some());
    assert!(
        lookup_in(&mut cache, &key, "fp", now + Duration::from_secs(61), CACHE_TTL).is_none(),
        "过期后必须重新解析"
    );
    assert!(
        !cache.contains_key(&key),
        "过期的那条要在本次访问里被清掉"
    );

    // 公开入口接的是同一张表（`store` 存进去的，`holds` 看得见）
    let live = unique_key("live");
    store(live.clone(), "fp".to_string(), &doc("刚存的"));
    assert!(holds(&live));
    assert_eq!(lookup(&live, "fp").map(|d| d.raw), Some("刚存的".to_string()));
}

/// 超大正文不进缓存（几千万字按住 1 分钟不值），正好等于上限要留
#[test]
fn oversized_text_is_not_cached() {
    let big = unique_key("big");
    store(
        big.clone(),
        "fp".to_string(),
        &doc(&"字".repeat(MAX_CACHED_CHARS + 1)),
    );
    assert!(!holds(&big), "超长正文不该进缓存");

    let ok = unique_key("ok");
    store(ok.clone(), "fp".to_string(), &doc(&"字".repeat(MAX_CACHED_CHARS)));
    assert!(holds(&ok));
}

/// 满了淘汰**最旧**的那条：先看纯函数选谁，再走一遍真正的 `store_in`
///（显式时钟，免得两条记录落在同一个 `Instant` 上而淘汰谁变得不确定）
#[test]
fn the_oldest_entry_is_the_one_evicted() {
    let base = Instant::now();
    let mut cache: HashMap<Key, Entry> = HashMap::new();
    let mut keys: Vec<Key> = Vec::new();
    let mut now = base;
    for i in 0..MAX_ENTRIES {
        let key = unique_key(&format!("evict-{i}"));
        store_in(&mut cache, key.clone(), "fp".to_string(), &doc("x"), now);
        keys.push(key);
        now += Duration::from_millis(1);
    }
    assert!(cache.contains_key(&keys[0]), "还没超上限，谁都不该被淘汰");
    assert_eq!(oldest_key(&cache), Some(keys[0].clone()));

    let extra = unique_key("evict-extra");
    store_in(&mut cache, extra.clone(), "fp".to_string(), &doc("又一份"), now);
    assert_eq!(cache.len(), MAX_ENTRIES);
    assert!(!cache.contains_key(&keys[0]), "满了要淘汰最旧的那条");
    assert!(cache.contains_key(&extra), "新来的必须在");

    // 覆盖同一个键不占新位置（不触发淘汰）
    let mut now = now + Duration::from_millis(1);
    for key in &keys[1..] {
        store_in(&mut cache, key.clone(), "fp".to_string(), &doc("更新"), now);
        now += Duration::from_millis(1);
    }
    assert_eq!(cache.len(), MAX_ENTRIES);
    assert!(cache.contains_key(&extra), "覆盖同一个键不该把别人挤掉");
}

/// 指纹跟着**文件内容**走：没改 → 一样；改了（哪怕长度相同）→ 不一样；文件不在 → 报错
#[test]
fn the_fingerprint_follows_the_file_content() {
    let (dir, file) = tmp_file("fp", b"first version");
    let first = fingerprint(&file).unwrap();
    assert_eq!(first.len(), FINGERPRINT_LEN);
    assert_eq!(fingerprint(&file).unwrap(), first, "没改就是同一个指纹");

    // 同长度不同内容也必须认出来（只比大小的实现会漏）
    std::fs::write(&file, b"FIRST VERSION").unwrap();
    assert_ne!(fingerprint(&file).unwrap(), first);

    assert!(fingerprint(&dir.join("nope.txt")).is_err());
    std::fs::remove_dir_all(&dir).ok();
}
