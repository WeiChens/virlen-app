//! DeepSeek V3 字节级 BPE tokenizer — 快速 token 计数
//!
//! 参考 HuggingFace `tokenizers` / DeepSeek V3 `tokenizer.json`（LlamaTokenizerFast，
//! byte-level BPE，vocab 128000 + 127741 merges）。用于在 API 不返回 usage 时，
//! 由前端 compressContext 调用本命令估算 prompt/completion tokens，
//! 替换原来「字符数 / 4」的粗略估算。
//!
//! 实现范围（与 DeepSeek tokenizer.json 对齐）：
//! - GPT-2 字节表（bytes_to_unicode）：UTF-8 字节 → 映射字符（空格→Ġ, 换行→Ċ）
//! - pretokenizer：3 个 Split（1-3 位数字 / CJK+假名 / GPT-2 风格）+ ByteLevel
//! - BPE merges（127741 条，`"Ġ t"` → pair("Ġ","t") rank=index）
//!
//! 已知限制（估算用途可接受）：
//! - 未模拟 chat template（`<｜begin▁of▁sentence｜>` / `<｜User｜>` 等特殊 token）
//! - 未处理 added_tokens（普通文本几乎不出现）
//! - GPT-2 风格正则中的 `\s+(?!\S)` 负向前瞻 Rust regex 不支持，已用等价 `\s+` 替代
//!   （`\s+(?!\S)` ∪ `\s+` = `\s+`）

use once_cell::sync::OnceCell;
use regex::Regex;
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, LazyLock};
use tauri::Manager;

// ==================== pretokenizer 正则 ====================

/// 1-3 位连续数字（Split Isolated）
static RE_NUM: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\p{N}{1,3}").expect("regex: num"));

/// CJK 统一表意文字 + 平假名 + 片假名（Split Isolated）
static RE_CJK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new("[一-龥぀-ゟ゠-ヿ]+").expect("regex: cjk")
});

/// GPT-2 风格（Split Isolated）。注意：
/// - 原正则末尾为 `\s+(?!\S)|\s+`，Rust regex 不支持 lookahead，等价替换为 `\s+`
static RE_GPT2: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r##"[!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~][A-Za-z]+|[^\r\n\p{L}\p{P}\p{S}]?[\p{L}\p{M}]+| ?[\p{P}\p{S}]+[\r\n]*|\s*[\r\n]+|\s+"##)
        .expect("regex: gpt2")
});

// ==================== GPT-2 字节表 ====================

/// 构建 GPT-2 风格 bytes_to_unicode 映射（byte → char）
///
/// 与 HuggingFace tokenizers 的 `ByteLevel` 完全一致：
/// 可打印 ASCII（0x21-0x7E）、¡-¬（0xA1-0xAC）、®-ÿ（0xAE-0xFF）映射到自身；
/// 其余字节依次映射到 U+0100 起的字符（空格 0x20 → Ġ U+0120，换行 0x0A → Ċ U+010A）。
fn bytes_to_unicode() -> [char; 256] {
    let mut map = ['\0'; 256];
    // 初始「保留」集合：映射到自身的字节
    let mut bs: Vec<u8> = (0x21..=0x7E).chain(0xA1..=0xAC).chain(0xAE..=0xFF).collect();
    let mut cs: Vec<u32> = bs.iter().map(|&b| b as u32).collect();
    let mut n: u32 = 0;
    for b in 0..=255u8 {
        if !bs.contains(&b) {
            bs.push(b);
            cs.push(0x100 + n);
            n += 1;
        }
    }
    for (b, c) in bs.into_iter().zip(cs) {
        map[b as usize] = char::from_u32(c).expect("valid unicode scalar");
    }
    map
}

// ==================== tokenizer ====================

pub struct DeepSeekTokenizer {
    /// BPE 合并规则：pair(left,right) 拼接字符串 → rank（merges 数组下标）
    merges_rank: HashMap<String, u32>,
    /// 字节 → GPT-2 映射字符
    byte_map: [char; 256],
}

impl DeepSeekTokenizer {
    /// 从 HuggingFace tokenizer.json 文本构建（只需 model.merges）
    pub fn load_from_json(json: &str) -> Result<Self, String> {
        let v: Value = serde_json::from_str(json)
            .map_err(|e| format!("解析 tokenizer.json 失败: {}", e))?;
        let model = v
            .get("model")
            .ok_or_else(|| "tokenizer.json 缺少 model 字段".to_string())?;
        let merges = model
            .get("merges")
            .and_then(|m| m.as_array())
            .ok_or_else(|| "tokenizer.json 缺少 model.merges".to_string())?;

        let mut merges_rank = HashMap::with_capacity(merges.len());
        for (i, m) in merges.iter().enumerate() {
            let s = m
                .as_str()
                .ok_or_else(|| "merges 项不是字符串".to_string())?;
            // "Ġ t" → "Ġt"（left+right 拼接，去掉中间空格）
            let key = s.replace(' ', "");
            merges_rank.insert(key, i as u32);
        }

        Ok(Self {
            merges_rank,
            byte_map: bytes_to_unicode(),
        })
    }

    /// 计算文本的 token 数
    pub fn count_tokens(&self, text: &str) -> usize {
        let mut total = 0;
        for piece in self.pretokenize(text) {
            total += self.bpe_count(&piece);
        }
        total
    }

    /// 按 pre_tokenizer 顺序切分 → ByteLevel 字节映射
    fn pretokenize(&self, text: &str) -> Vec<String> {
        let mut parts: Vec<String> = vec![text.to_string()];
        for re in [&*RE_NUM, &*RE_CJK, &*RE_GPT2] {
            let mut next: Vec<String> = Vec::new();
            for p in parts {
                split_isolated(&p, re, &mut next);
            }
            parts = next;
        }
        parts
            .iter()
            .map(|p| byte_level_encode(p, &self.byte_map))
            .collect()
    }

    /// 对单个 pretoken 做 BPE 合并，返回合并后的片段数（= token 数）
    fn bpe_count(&self, word: &str) -> usize {
        let mut pieces: Vec<String> = word.chars().map(|c| c.to_string()).collect();
        loop {
            // 找 rank 最小、且最靠左的可合并 pair
            let mut best: Option<(usize, u32)> = None;
            for i in 0..pieces.len().saturating_sub(1) {
                let key = format!("{}{}", pieces[i], pieces[i + 1]);
                if let Some(&rank) = self.merges_rank.get(&key) {
                    match best {
                        Some((_, br)) if br <= rank => {}
                        _ => best = Some((i, rank)),
                    }
                }
            }
            let Some((pos, _)) = best else { break };
            let merged = format!("{}{}", pieces[pos], pieces[pos + 1]);
            pieces[pos] = merged;
            pieces.remove(pos + 1);
        }
        pieces.len()
    }
}

/// Split(Isolated)：正则匹配的片段隔离为独立 token，其余片段保留继续处理
fn split_isolated(text: &str, re: &Regex, out: &mut Vec<String>) {
    let mut last = 0;
    for m in re.find_iter(text) {
        if m.start() > last {
            out.push(text[last..m.start()].to_string());
        }
        out.push(m.as_str().to_string());
        last = m.end();
    }
    if last < text.len() {
        out.push(text[last..].to_string());
    }
}

/// ByteLevel 编码：UTF-8 字节 → GPT-2 映射字符
fn byte_level_encode(text: &str, byte_map: &[char; 256]) -> String {
    let mut out = String::with_capacity(text.len());
    for &b in text.as_bytes() {
        out.push(byte_map[b as usize]);
    }
    out
}

// ==================== 全局单例 + Tauri 命令 ====================

/// 全局 tokenizer 单例（懒加载；加载失败缓存错误信息）
static TOKENIZER: OnceCell<Result<Arc<DeepSeekTokenizer>, String>> = OnceCell::new();

/// 定位 tokenizer.json（开发模式走 CARGO_MANIFEST_DIR/resources，打包后走 resource_dir）
fn resolve_tokenizer_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("deepseek_tokenizer")
        .join("tokenizer.json");
    if dev_path.exists() {
        return Ok(dev_path);
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        for p in [
            resource_dir
                .join("deepseek_tokenizer")
                .join("tokenizer.json"),
            resource_dir
                .join("resources")
                .join("deepseek_tokenizer")
                .join("tokenizer.json"),
        ] {
            if p.exists() {
                return Ok(p);
            }
        }
    }
    Err(format!(
        "deepseek tokenizer.json not found. Searched: {:?}",
        dev_path
    ))
}

/// 获取（并缓存）tokenizer；首次调用会解析 7.5MB tokenizer.json
fn get_tokenizer(app: &tauri::AppHandle) -> Result<Arc<DeepSeekTokenizer>, String> {
    let result = TOKENIZER.get_or_init(|| {
        let path = resolve_tokenizer_path(app)?;
        let json = std::fs::read_to_string(&path)
            .map_err(|e| format!("读取 {} 失败: {}", path.display(), e))?;
        DeepSeekTokenizer::load_from_json(&json).map(Arc::new)
    });
    match result {
        Ok(tk) => Ok(tk.clone()),
        Err(e) => Err(e.clone()),
    }
}

/// 计算文本 token 数（供前端 compressContext 估算 usage）
#[tauri::command]
pub async fn cmd_count_tokens(app: tauri::AppHandle, text: String) -> Result<u32, String> {
    tokio::task::spawn_blocking(move || {
        let tk = get_tokenizer(&app)?;
        Ok::<u32, String>(tk.count_tokens(&text) as u32)
    })
    .await
    .map_err(|e| format!("count_tokens task join error: {}", e))?
}

/// 预热：后台线程解析 tokenizer.json（不阻塞启动），失败静默（命令侧会再试）
pub fn prewarm(app: &tauri::AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let _ = get_tokenizer(&app);
    });
}

// ==================== 测试 ====================

#[cfg(test)]
mod tests {
    use super::*;

    /// 从资源文件加载真实 tokenizer（测试基准来自 transformers 4.57.6 AutoTokenizer）
    fn tokenizer() -> Arc<DeepSeekTokenizer> {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources/deepseek_tokenizer/tokenizer.json");
        let json = std::fs::read_to_string(&path).expect("tokenizer.json 不存在");
        Arc::new(
            DeepSeekTokenizer::load_from_json(&json)
                .expect("tokenizer.json 解析失败"),
        )
    }

    #[test]
    fn bytes_to_unicode_mapping() {
        let map = bytes_to_unicode();
        // 空格 → Ġ (U+0120)
        assert_eq!(map[0x20], 'Ġ');
        // 换行 → Ċ (U+010A)
        assert_eq!(map[0x0A], 'Ċ');
        // 可打印 ASCII 映射到自身
        assert_eq!(map[b'a' as usize], 'a');
        assert_eq!(map[b'!' as usize], '!');
        // 0xE4 在保留集合（0xAE-0xFF）内 → 映射到自身 'ä'
        assert_eq!(map[0xE4], 'ä');
        // 0x80 不在保留集合 → 映射到 U+0100 起的扩展字符（0x80 → U+0122）
        assert_eq!(map[0x80], '\u{0122}');
        assert!(map[0x80] > '\u{0100}');
    }

    /// 与官方 transformers AutoTokenizer 输出对齐（基准见 bench_deepseek.py）
    #[test]
    fn matches_official_tokenizer() {
        let tk = tokenizer();
        let cases: &[(&str, usize)] = &[
            ("Hello!", 2),
            ("你好，世界！", 4),
            ("帮我优化 Rust 代码性能，当前在 Windows 上运行。", 14),
            ("The quick brown fox jumps over the lazy dog. 12345", 13),
            (
                "def hello(name):\n    print(f\"Hello, {name}!\")\n",
                14,
            ),
            (
                "这是一段非常非常非常非常非常非常非常非常非常非常非常长的标题内容",
                16,
            ),
            ("你好世界", 2),
            ("", 0),
        ];
        for (text, expected) in cases {
            assert_eq!(
                tk.count_tokens(text),
                *expected,
                "text: {:?}",
                text
            );
        }
    }

    #[test]
    fn pretokenize_splits_isolated() {
        let tk = tokenizer();
        let _ = &tk;
        let mut out: Vec<String> = Vec::new();
        split_isolated("abc123def", &RE_NUM, &mut out);
        assert_eq!(out, vec!["abc", "123", "def"]);

        out.clear();
        split_isolated("你好world", &RE_CJK, &mut out);
        assert_eq!(out, vec!["你好", "world"]);
    }

    #[test]
    fn load_error_on_invalid_json() {
        assert!(DeepSeekTokenizer::load_from_json("{not json").is_err());
    }

    /// 性能探针（手动运行：cargo test -- --ignored）
    /// 打印 7.5MB tokenizer.json 加载耗时 + 单次 count 耗时
    #[test]
    #[ignore]
    fn perf_probe() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources/deepseek_tokenizer/tokenizer.json");
        let json = std::fs::read_to_string(&path).expect("tokenizer.json 不存在");

        let t0 = std::time::Instant::now();
        let tk = Arc::new(
            DeepSeekTokenizer::load_from_json(&json).expect("解析失败"),
        );
        let load_ms = t0.elapsed().as_millis();

        let sample = "帮我优化 Rust 代码性能，当前在 Windows 上运行。这是一段非常非常非常非常非常非常非常非常非常非常非常长的标题内容，用于性能测试。The quick brown fox jumps over the lazy dog. 12345";
        let t1 = std::time::Instant::now();
        let mut sum = 0usize;
        for _ in 0..1000 {
            sum += tk.count_tokens(sample);
        }
        let per_ms = t1.elapsed().as_micros() as f64 / 1000.0;

        println!(
            "load={}ms  count_1000={:?}us  per_count={:.2}us  tokens={}",
            load_ms,
            t1.elapsed().as_micros(),
            per_ms,
            tk.count_tokens(sample)
        );
        assert!(sum > 0);
    }
}
